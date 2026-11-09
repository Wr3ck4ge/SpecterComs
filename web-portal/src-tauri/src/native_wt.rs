//! Native WebTransport client: the automatic fallback for networks/PCs where
//! WebView2's own QUIC never reaches the relay while a QUIC handshake from
//! this process does (see engine/nativeWebTransport.js and
//! engine/transportFactory.js on the JS side).
//!
//! It uses the SAME crate and version as the relay (wtransport 0.1.14, in
//! services/media-rust), so the HTTP/3 + WebTransport draft it speaks is the
//! one the relay accepts. This module only moves bytes: everything sent or
//! received here is already end-to-end encrypted in JS/WASM. No keys ever
//! reach it.
//!
//! TLS: certificates are validated normally against the webpki (Mozilla) root
//! set. The key exchange is restricted to classical X25519 so the ClientHello
//! stays small and fits one QUIC Initial packet (some middleboxes drop the
//! two-packet ClientHello that browsers' post-quantum key shares produce;
//! see `client_hello_fits_one_initial`).
//!
//! JS ⇄ Rust:
//!   nwt_connect(url, events: Channel) → { id, maxDatagramSize }
//!   nwt_send_datagram   raw body, headers x-nwt-session
//!   nwt_open_uni(session) → stream id
//!   nwt_stream_write    raw body, headers x-nwt-session, x-nwt-stream
//!   nwt_stream_finish / nwt_stream_reset / nwt_stream_stop
//!   nwt_close(session, code, reason)
//!   nwt_info() → { available, forced }
//! Everything from the relay comes back on the session's Channel as raw
//! ArrayBuffers holding one or more frames:
//!   [kind u8][id u32 LE][len u32 LE][payload]
//! Frames queued while one message is in flight are coalesced into the next,
//! so a burst costs one IPC message, not one per QUIC packet.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::mpsc;
use wtransport::endpoint::endpoint_side::Client;
use wtransport::error::ConnectionError;
use wtransport::{ClientConfig, Connection, Endpoint, RecvStream, SendStream, VarInt};

pub const FRAME_DATAGRAM: u8 = 1;
pub const FRAME_STREAM_OPEN: u8 = 2;
pub const FRAME_STREAM_DATA: u8 = 3;
pub const FRAME_STREAM_FIN: u8 = 4;
pub const FRAME_STREAM_RESET: u8 = 5;
pub const FRAME_CLOSED: u8 = 6;
pub const FRAME_MAX_DATAGRAM: u8 = 7;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
const KEEP_ALIVE: Duration = Duration::from_secs(2);
const IDLE_TIMEOUT: Duration = Duration::from_secs(10);
/// Frames waiting for the IPC pump. Datagrams beyond this are dropped (stale
/// audio is worse than missing audio); stream data waits (QUIC backpressure).
const QUEUE_FRAMES: usize = 512;
/// Upper bound of one coalesced IPC message.
const MAX_BATCH_BYTES: usize = 512 * 1024;
const READ_CHUNK: usize = 64 * 1024;

pub enum Frame {
    Datagram(Vec<u8>),
    StreamOpen(u32),
    StreamData(u32, Vec<u8>),
    StreamFin(u32),
    StreamReset(u32, String),
    Closed { clean: bool, reason: String },
    MaxDatagram(u32),
}

/// Appends one frame in the wire format described in the module doc.
pub fn encode_frame(out: &mut Vec<u8>, f: &Frame) {
    let (kind, id, payload): (u8, u32, &[u8]) = match f {
        Frame::Datagram(b) => (FRAME_DATAGRAM, 0, b),
        Frame::StreamOpen(id) => (FRAME_STREAM_OPEN, *id, &[]),
        Frame::StreamData(id, b) => (FRAME_STREAM_DATA, *id, b),
        Frame::StreamFin(id) => (FRAME_STREAM_FIN, *id, &[]),
        Frame::StreamReset(id, r) => (FRAME_STREAM_RESET, *id, r.as_bytes()),
        Frame::Closed { clean, reason } => {
            let mut v = vec![u8::from(*clean)];
            v.extend_from_slice(reason.as_bytes());
            out.push(FRAME_CLOSED);
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&(v.len() as u32).to_le_bytes());
            out.extend_from_slice(&v);
            return;
        }
        Frame::MaxDatagram(n) => (FRAME_MAX_DATAGRAM, *n, &[]),
    };
    out.push(kind);
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

/// Where a session's coalesced frames go (a Tauri Channel in the app, a Vec
/// in tests). Returns false once nobody is listening any more.
pub type Sink = Arc<dyn Fn(Vec<u8>) -> bool + Send + Sync>;

// ── TLS ─────────────────────────────────────────────────────────────────

fn webpki_root_store() -> rustls021::RootCertStore {
    let mut roots = rustls021::RootCertStore::empty();
    roots.add_trust_anchors(webpki_roots::TLS_SERVER_ROOTS.iter().map(|ta| {
        rustls021::OwnedTrustAnchor::from_subject_spki_name_constraints(
            ta.subject.as_ref(),
            ta.subject_public_key_info.as_ref(),
            ta.name_constraints.as_ref().map(|n| n.as_ref()),
        )
    }));
    roots
}

/// TLS 1.3, X25519 only (one small key share), h3 ALPN, normal validation.
pub fn tls_config(roots: rustls021::RootCertStore) -> rustls021::ClientConfig {
    let mut cfg = rustls021::ClientConfig::builder()
        .with_safe_default_cipher_suites()
        .with_kx_groups(&[&rustls021::kx_group::X25519])
        .with_protocol_versions(&[&rustls021::version::TLS13])
        .expect("TLS 1.3 with X25519 is a valid combination")
        .with_root_certificates(roots)
        .with_no_client_auth();
    cfg.alpn_protocols = vec![b"h3".to_vec()];
    cfg
}

fn client_config(tls: rustls021::ClientConfig) -> ClientConfig {
    ClientConfig::builder()
        .with_bind_default()
        .with_custom_tls(tls)
        .keep_alive_interval(Some(KEEP_ALIVE))
        .max_idle_timeout(Some(IDLE_TIMEOUT))
        .expect("valid idle timeout")
        .build()
}

// ── Sessions ────────────────────────────────────────────────────────────

pub struct Session {
    conn: Connection,
    // Kept alive for the session's lifetime (it owns the UDP socket).
    _endpoint: Endpoint<Client>,
    next_stream: AtomicU32,
    send_streams: Mutex<HashMap<u32, Arc<tokio::sync::Mutex<SendStream>>>>,
    recv_tasks: Mutex<HashMap<u32, tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Default)]
pub struct NativeWtState {
    sessions: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
    next_id: AtomicU32,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn close_info(err: &ConnectionError) -> (bool, String) {
    match err {
        ConnectionError::ApplicationClosed(c) => (true, c.to_string()),
        ConnectionError::LocallyClosed => (true, String::new()),
        other => (false, other.to_string()),
    }
}

fn varint(n: u32) -> VarInt {
    VarInt::from_u32(n)
}

/// The IPC pump: drains the frame queue into coalesced messages.
async fn pump(mut rx: mpsc::Receiver<Frame>, sink: Sink, conn_closer: Arc<dyn Fn() + Send + Sync>) {
    let mut buf = Vec::with_capacity(64 * 1024);
    while let Some(f) = rx.recv().await {
        buf.clear();
        encode_frame(&mut buf, &f);
        while buf.len() < MAX_BATCH_BYTES {
            match rx.try_recv() {
                Ok(f) => encode_frame(&mut buf, &f),
                Err(_) => break,
            }
        }
        if !sink(std::mem::take(&mut buf)) {
            // The page that opened the session is gone (reload/close).
            conn_closer();
            break;
        }
    }
}

async fn read_stream(id: u32, mut s: RecvStream, tx: mpsc::Sender<Frame>) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        match s.read(&mut buf).await {
            Ok(Some(n)) => {
                if tx.send(Frame::StreamData(id, buf[..n].to_vec())).await.is_err() { return; }
            }
            Ok(None) => { let _ = tx.send(Frame::StreamFin(id)).await; return; }
            Err(e) => { let _ = tx.send(Frame::StreamReset(id, e.to_string())).await; return; }
        }
    }
}

impl NativeWtState {
    pub async fn connect(&self, url: &str, sink: Sink) -> Result<(u32, Option<usize>), String> {
        self.connect_with(url, sink, tls_config(webpki_root_store())).await
    }

    pub async fn connect_with(&self, url: &str, sink: Sink, tls: rustls021::ClientConfig) -> Result<(u32, Option<usize>), String> {
        let endpoint = Endpoint::client(client_config(tls)).map_err(|e| format!("socket: {e}"))?;
        let conn = match tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(url)).await {
            Err(_) => return Err("native WebTransport handshake timed out".into()),
            Ok(Err(e)) => return Err(format!("native WebTransport failed: {e}")),
            Ok(Ok(c)) => c,
        };
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel(QUEUE_FRAMES);
        let max_dg = conn.max_datagram_size();
        let session = Arc::new(Session {
            conn,
            _endpoint: endpoint,
            next_stream: AtomicU32::new(0),
            send_streams: Mutex::new(HashMap::new()),
            recv_tasks: Mutex::new(HashMap::new()),
        });
        lock(&self.sessions).insert(id, session.clone());

        let closer_s = session.clone();
        tauri::async_runtime::spawn(pump(rx, sink, Arc::new(move || closer_s.conn.close(varint(0), b"page gone"))));

        // Datagrams: never wait — a full queue drops the newest late packet.
        let s = session.clone();
        let dtx = tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Ok(d) = s.conn.receive_datagram().await {
                let _ = dtx.try_send(Frame::Datagram(d.payload().to_vec()));
            }
        });

        // Incoming unidirectional streams.
        let s = session.clone();
        let utx = tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Ok(stream) = s.conn.accept_uni().await {
                let sid = s.next_stream.fetch_add(1, Ordering::Relaxed) + 1;
                if utx.send(Frame::StreamOpen(sid)).await.is_err() { break; }
                let h = tauri::async_runtime::spawn(read_stream(sid, stream, utx.clone()));
                lock(&s.recv_tasks).insert(sid, h);
            }
        });

        // Close watcher + max-datagram-size updates (the path MTU can grow).
        let s = session.clone();
        let registry = self.sessions.clone();
        let ctx = tx;
        tauri::async_runtime::spawn(async move {
            let mut last = max_dg;
            let closed = s.conn.closed();
            tokio::pin!(closed);
            loop {
                tokio::select! {
                    err = &mut closed => {
                        let (clean, reason) = close_info(&err);
                        lock(&registry).remove(&id);
                        let _ = ctx.send(Frame::Closed { clean, reason }).await;
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {
                        let now = s.conn.max_datagram_size();
                        if now != last {
                            last = now;
                            let _ = ctx.send(Frame::MaxDatagram(now.unwrap_or(0) as u32)).await;
                        }
                    }
                }
            }
        });
        Ok((id, max_dg))
    }

    fn get(&self, id: u32) -> Result<Arc<Session>, String> {
        lock(&self.sessions).get(&id).cloned().ok_or_else(|| "session closed".to_string())
    }

    pub fn send_datagram(&self, id: u32, data: &[u8]) -> Result<(), String> {
        self.get(id)?.conn.send_datagram(data).map_err(|e| e.to_string())
    }

    pub async fn open_uni(&self, id: u32) -> Result<u32, String> {
        let s = self.get(id)?;
        let stream = s.conn.open_uni().await.map_err(|e| e.to_string())?.await.map_err(|e| e.to_string())?;
        let sid = s.next_stream.fetch_add(1, Ordering::Relaxed) + 1;
        lock(&s.send_streams).insert(sid, Arc::new(tokio::sync::Mutex::new(stream)));
        Ok(sid)
    }

    fn send_stream(&self, id: u32, sid: u32) -> Result<Arc<tokio::sync::Mutex<SendStream>>, String> {
        lock(&self.get(id)?.send_streams).get(&sid).cloned().ok_or_else(|| "stream closed".to_string())
    }

    pub async fn stream_write(&self, id: u32, sid: u32, data: &[u8]) -> Result<(), String> {
        let st = self.send_stream(id, sid)?;
        let mut g = st.lock().await;
        g.write_all(data).await.map_err(|e| e.to_string())
    }

    pub async fn stream_finish(&self, id: u32, sid: u32) -> Result<(), String> {
        let st = self.send_stream(id, sid)?;
        if let Ok(s) = self.get(id) { lock(&s.send_streams).remove(&sid); }
        let mut g = st.lock().await;
        g.finish().await.map_err(|e| e.to_string())
    }

    pub fn stream_reset(&self, id: u32, sid: u32, code: u32) -> Result<(), String> {
        let s = self.get(id)?;
        let st = lock(&s.send_streams).remove(&sid);
        if let Some(st) = st {
            if let Ok(m) = Arc::try_unwrap(st) { m.into_inner().reset(varint(code)); }
            // A write still holds it: dropping our handle is enough (the
            // writer gets an error once the session ends).
        }
        Ok(())
    }

    /// JS cancelled an incoming stream's reader: stop reading it.
    pub fn stream_stop(&self, id: u32, sid: u32) -> Result<(), String> {
        let s = self.get(id)?;
        if let Some(h) = lock(&s.recv_tasks).remove(&sid) { h.abort(); }
        Ok(())
    }

    pub fn close(&self, id: u32, code: u32, reason: &str) {
        if let Some(s) = lock(&self.sessions).remove(&id) {
            s.conn.close(varint(code), reason.as_bytes());
            for (_, h) in lock(&s.recv_tasks).drain() { h.abort(); }
        }
    }

    pub fn session_count(&self) -> usize { lock(&self.sessions).len() }
}

// ── Tauri commands ──────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo { id: u32, max_datagram_size: Option<usize> }

#[derive(Serialize)]
pub struct NwtInfo { available: bool, forced: Option<String> }

fn header_u32(req: &tauri::ipc::Request<'_>, name: &str) -> Result<u32, String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("missing header {name}"))
}

fn raw_body<'a>(req: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match req.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b),
        _ => Err("expected a raw body".into()),
    }
}

#[tauri::command]
pub async fn nwt_info() -> Result<NwtInfo, String> {
    // SPECTER_TRANSPORT=native|webview forces the mode (dev / repro switch).
    let forced = std::env::var("SPECTER_TRANSPORT").ok().filter(|v| v == "native" || v == "webview");
    Ok(NwtInfo { available: true, forced })
}

#[tauri::command]
pub async fn nwt_connect(state: tauri::State<'_, NativeWtState>, url: String, events: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) -> Result<ConnectInfo, String> {
    let sink: Sink = Arc::new(move |bytes| events.send(tauri::ipc::InvokeResponseBody::Raw(bytes)).is_ok());
    let (id, max_datagram_size) = state.connect(&url, sink).await?;
    Ok(ConnectInfo { id, max_datagram_size })
}

#[tauri::command]
pub async fn nwt_send_datagram(state: tauri::State<'_, NativeWtState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id = header_u32(&request, "x-nwt-session")?;
    state.send_datagram(id, raw_body(&request)?)
}

#[tauri::command]
pub async fn nwt_open_uni(state: tauri::State<'_, NativeWtState>, session: u32) -> Result<u32, String> {
    state.open_uni(session).await
}

#[tauri::command]
pub async fn nwt_stream_write(state: tauri::State<'_, NativeWtState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id = header_u32(&request, "x-nwt-session")?;
    let sid = header_u32(&request, "x-nwt-stream")?;
    let data = raw_body(&request)?.to_vec();
    state.stream_write(id, sid, &data).await
}

#[tauri::command]
pub async fn nwt_stream_finish(state: tauri::State<'_, NativeWtState>, session: u32, stream: u32) -> Result<(), String> {
    state.stream_finish(session, stream).await
}

#[tauri::command]
pub async fn nwt_stream_reset(state: tauri::State<'_, NativeWtState>, session: u32, stream: u32, code: Option<u32>) -> Result<(), String> {
    state.stream_reset(session, stream, code.unwrap_or(0))
}

#[tauri::command]
pub async fn nwt_stream_stop(state: tauri::State<'_, NativeWtState>, session: u32, stream: u32) -> Result<(), String> {
    state.stream_stop(session, stream)
}

#[tauri::command]
pub async fn nwt_close(state: tauri::State<'_, NativeWtState>, session: u32, code: Option<u32>, reason: Option<String>) -> Result<(), String> {
    state.close(session, code.unwrap_or(0), reason.as_deref().unwrap_or(""));
    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc as std_mpsc;

    #[test]
    fn frames_encode_kind_id_len_payload() {
        let mut out = Vec::new();
        encode_frame(&mut out, &Frame::StreamData(7, vec![1, 2, 3]));
        encode_frame(&mut out, &Frame::Closed { clean: true, reason: "bye".into() });
        assert_eq!(&out[..12], &[FRAME_STREAM_DATA, 7, 0, 0, 0, 3, 0, 0, 0, 1, 2, 3]);
        assert_eq!(&out[12..], &[FRAME_CLOSED, 0, 0, 0, 0, 4, 0, 0, 0, 1, b'b', b'y', b'e']);
    }

    /// The ClientHello this client sends must fit one QUIC Initial packet
    /// (1200-byte datagram minus long header, CRYPTO frame header and AEAD
    /// tag ≈ 1150 bytes), with room for quinn's transport parameters.
    #[test]
    fn client_hello_fits_one_initial() {
        let cfg = Arc::new(tls_config(webpki_root_store()));
        let name = rustls021::ServerName::try_from("media.spectercoms.net").unwrap();
        // quinn's client transport parameters are ~100 bytes; be generous.
        let params = vec![0u8; 160];
        let mut conn = rustls021::quic::ClientConnection::new(cfg, rustls021::quic::Version::V1, name, params).unwrap();
        let mut hello = Vec::new();
        conn.write_hs(&mut hello);
        eprintln!("ClientHello: {} bytes", hello.len());
        assert!(!hello.is_empty());
        assert!(hello.len() <= 1100, "ClientHello is {} bytes", hello.len());
        // One key share: X25519 only (no hybrid post-quantum share).
        assert!(hello.len() < 600, "ClientHello unexpectedly large: {}", hello.len());
    }

    fn collect_sink() -> (Sink, std_mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = std_mpsc::channel();
        let tx = Mutex::new(tx);
        (Arc::new(move |b| lock(&tx).send(b).is_ok()), rx)
    }

    fn parse(buf: &[u8]) -> Vec<(u8, u32, Vec<u8>)> {
        let mut out = Vec::new();
        let mut i = 0;
        while i + 9 <= buf.len() {
            let kind = buf[i];
            let id = u32::from_le_bytes(buf[i + 1..i + 5].try_into().unwrap());
            let len = u32::from_le_bytes(buf[i + 5..i + 9].try_into().unwrap()) as usize;
            out.push((kind, id, buf[i + 9..i + 9 + len].to_vec()));
            i += 9 + len;
        }
        out
    }

    /// End to end against a real wtransport 0.1.14 server (the relay's crate):
    /// datagram echo, server→client uni stream, client→server uni stream,
    /// clean close.
    #[test]
    fn interop_with_relay_crate() {
        tauri::async_runtime::block_on(async {
            let identity = wtransport::Identity::self_signed(["localhost"]).unwrap();
            let cert_der = identity.certificate_chain().as_slice()[0].der().to_vec();
            let server_cfg = wtransport::ServerConfig::builder()
                .with_bind_default(0)
                .with_identity(&identity)
                .build();
            let server = Endpoint::server(server_cfg).unwrap();
            let port = server.local_addr().unwrap().port();
            let (got_tx, got_rx) = std_mpsc::channel::<Vec<u8>>();
            tauri::async_runtime::spawn(async move {
                let req = server.accept().await.await.unwrap();
                assert!(req.path().starts_with("/specter?token="));
                let conn = req.accept().await.unwrap();
                // server → client stream
                let mut s = conn.open_uni().await.unwrap().await.unwrap();
                s.write_all(&[0x01, b'h', b'i']).await.unwrap();
                s.finish().await.unwrap();
                // echo one datagram
                let d = conn.receive_datagram().await.unwrap();
                conn.send_datagram(d.payload()).unwrap();
                // client → server stream
                let mut r = conn.accept_uni().await.unwrap();
                let mut all = Vec::new();
                let mut buf = [0u8; 1024];
                while let Ok(Some(n)) = r.read(&mut buf).await { all.extend_from_slice(&buf[..n]); }
                got_tx.send(all).unwrap();
                conn.closed().await;
            });

            let mut roots = rustls021::RootCertStore::empty();
            roots.add(&rustls021::Certificate(cert_der)).unwrap();
            let state = NativeWtState::default();
            let (sink, rx) = collect_sink();
            let (id, max_dg) = state
                .connect_with(&format!("https://localhost:{port}/specter?token=t&channel_id=c"), sink, tls_config(roots))
                .await
                .expect("connect");
            assert!(max_dg.unwrap_or(0) >= 1000, "max datagram {max_dg:?}");
            state.send_datagram(id, b"ping").unwrap();
            let sid = state.open_uni(id).await.unwrap();
            state.stream_write(id, sid, &[0x02, 9, 9]).await.unwrap();
            state.stream_finish(id, sid).await.unwrap();

            let (mut opened, mut data, mut fin, mut dgram) = (false, Vec::new(), false, None);
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !(opened && fin && dgram.is_some()) && std::time::Instant::now() < deadline {
                if let Ok(buf) = rx.recv_timeout(Duration::from_millis(100)) {
                    for (k, _, p) in parse(&buf) {
                        match k {
                            FRAME_STREAM_OPEN => opened = true,
                            FRAME_STREAM_DATA => data.extend(p),
                            FRAME_STREAM_FIN => fin = true,
                            FRAME_DATAGRAM => dgram = Some(p),
                            _ => {}
                        }
                    }
                } else {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
            assert!(opened && fin);
            assert_eq!(data, vec![0x01, b'h', b'i']);
            assert_eq!(dgram.as_deref(), Some(&b"ping"[..]));
            assert_eq!(got_rx.recv_timeout(Duration::from_secs(5)).unwrap(), vec![0x02, 9, 9]);

            state.close(id, 0, "done");
            assert_eq!(state.session_count(), 0);
        });
    }

    #[test]
    fn untrusted_certificate_is_refused() {
        tauri::async_runtime::block_on(async {
            let identity = wtransport::Identity::self_signed(["localhost"]).unwrap();
            let server_cfg = wtransport::ServerConfig::builder()
                .with_bind_default(0)
                .with_identity(&identity)
                .build();
            let server = Endpoint::server(server_cfg).unwrap();
            let port = server.local_addr().unwrap().port();
            tauri::async_runtime::spawn(async move { let _ = server.accept().await.await; });
            let state = NativeWtState::default();
            let (sink, _rx) = collect_sink();
            // Real webpki roots: a self-signed cert must not be accepted.
            let r = state.connect(&format!("https://localhost:{port}/specter"), sink).await;
            assert!(r.is_err());
        });
    }
}
