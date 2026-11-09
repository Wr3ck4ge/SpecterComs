//! Native half of the Repair panel's connection test (engine/netDiagnostics.js).
//! The webview can only say "WebTransport failed"; this can look underneath.
//!
//! `netdiag_local_checks`: reads the registry for a `QuicAllowed = 0` policy
//! (Edge and WebView2, machine and user) and the system proxy.
//!
//! `netdiag_probe`: three tests, in parallel:
//! - UDP probes (`SPNP` datagrams, wire format in services/media-rust/src/
//!   netdiag.rs) at several sizes to the relay's diagnostic port(s), with the
//!   IP don't-fragment bit set. Valid replies carry an HMAC under the per-probe
//!   key from POST /diag/netprobe, so a reply proves the round trip with the
//!   relay and not some middlebox. Needs a token; skipped without one.
//! - A QUIC version-negotiation check on the main port: a padded long-header
//!   packet with a reserved version. RFC 9000 servers answer those without
//!   any handshake state, so an answer proves UDP on that port both ways even
//!   when a real handshake gets blocked. No token needed.
//! - A real QUIC handshake (ALPN h3) to each port, outside WebView2. Sends no
//!   credentials; closes as soon as it completes. The relay logs a harmless
//!   "Handshake failed" for each, since no HTTP/3 session follows.

use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::Arc;
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const MAGIC: &[u8; 4] = b"SPNP";
const VERSION: u8 = 1;
const KIND_PROBE: u8 = 1;
const KIND_REPLY: u8 = 2;
const REPLY_LEN: usize = 42;
const PROBE_SIZES: [usize; 4] = [200, 1200, 1350, 1450];
const VN_SIZES: [usize; 2] = [1200, 1350];
/// A reserved "greasing" version (RFC 9000 §15): never a real QUIC version.
const GREASE_VERSION: [u8; 4] = [0x1a, 0x2a, 0x3a, 0x4a];
const RECV_WINDOW: Duration = Duration::from_millis(2500);
const QUIC_TIMEOUT: Duration = Duration::from_secs(6);

// ── Pure: packets ───────────────────────────────────────────────────────────

fn build_probe(token: &[u8; 16], seq: u16, len: usize) -> Vec<u8> {
    let mut v = vec![0u8; len];
    v[0..4].copy_from_slice(MAGIC);
    v[4] = VERSION;
    v[5] = KIND_PROBE;
    v[6..22].copy_from_slice(token);
    v[22..24].copy_from_slice(&seq.to_be_bytes());
    v[24..26].copy_from_slice(&(len as u16).to_be_bytes());
    v
}

fn reply_mac(key: &[u8], token: &[u8; 16], seq: u16, recv_len: u16) -> [u8; 16] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(b"SPNP-reply");
    mac.update(token);
    mac.update(&seq.to_be_bytes());
    mac.update(&recv_len.to_be_bytes());
    let full = mac.finalize().into_bytes();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

/// `(seq, size the relay received)` of an authentic reply, else None.
fn verify_reply(buf: &[u8], key: &[u8], token: &[u8; 16]) -> Option<(u16, u16)> {
    if buf.len() != REPLY_LEN || &buf[0..4] != MAGIC || buf[4] != VERSION || buf[5] != KIND_REPLY || &buf[6..22] != token {
        return None;
    }
    let seq = u16::from_be_bytes([buf[22], buf[23]]);
    let recv_len = u16::from_be_bytes([buf[24], buf[25]]);
    (buf[26..42] == reply_mac(key, token, seq, recv_len)).then_some((seq, recv_len))
}

fn build_version_probe(cid: &[u8; 8], len: usize) -> Vec<u8> {
    let mut v = vec![0u8; len];
    v[0] = 0xc0;
    v[1..5].copy_from_slice(&GREASE_VERSION);
    v[5] = 8;
    v[6..14].copy_from_slice(cid);
    v[14] = 8;
    v[15..23].copy_from_slice(cid);
    v
}

/// A Version Negotiation packet answering `cid`: long header, version 0, and
/// our source connection id echoed as its destination.
fn is_version_negotiation(buf: &[u8], cid: &[u8; 8]) -> bool {
    buf.len() >= 15 && buf[0] & 0x80 != 0 && buf[1..5] == [0, 0, 0, 0] && buf[5] == 8 && &buf[6..14] == cid
}

fn parse_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 { return None; }
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

// ── Pure: registry interpretation ───────────────────────────────────────────

/// Policy locations that can carry QuicAllowed. WebView2 follows the Edge
/// policy; the WebView2 key is checked too in case it's set there.
const POLICY_KEYS: [(bool, &str); 4] = [
    (true, r"SOFTWARE\Policies\Microsoft\Edge"),
    (false, r"SOFTWARE\Policies\Microsoft\Edge"),
    (true, r"SOFTWARE\Policies\Microsoft\Edge\WebView2"),
    (false, r"SOFTWARE\Policies\Microsoft\Edge\WebView2"),
];

fn policy_label(machine: bool, key: &str) -> String {
    format!(r"{}\{}\QuicAllowed", if machine { "HKLM" } else { "HKCU" }, key)
}

/// Which of the read QuicAllowed values disable QUIC (0 = off; unset or
/// nonzero = allowed).
fn quic_disabled_by(values: &[(String, Option<u32>)]) -> Vec<String> {
    values.iter().filter(|(_, v)| *v == Some(0)).map(|(label, _)| label.clone()).collect()
}

// ── Registry ────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod reg {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ};

    fn root(machine: bool) -> HKEY { if machine { HKEY_LOCAL_MACHINE } else { HKEY_CURRENT_USER } }

    pub fn dword(machine: bool, key: &str, name: &str) -> Option<u32> {
        let mut value = 0u32;
        let mut size = 4u32;
        let status = unsafe {
            RegGetValueW(root(machine), &HSTRING::from(key), &HSTRING::from(name), RRF_RT_REG_DWORD, None,
                Some(&mut value as *mut u32 as *mut _), Some(&mut size))
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    pub fn string(machine: bool, key: &str, name: &str) -> Option<String> {
        let mut buf = vec![0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(root(machine), &HSTRING::from(key), &HSTRING::from(name), RRF_RT_REG_SZ, None,
                Some(buf.as_mut_ptr() as *mut _), Some(&mut size))
        };
        if status != ERROR_SUCCESS { return None; }
        let chars = (size as usize / 2).saturating_sub(1);
        let s = String::from_utf16_lossy(&buf[..chars]);
        (!s.is_empty()).then_some(s)
    }
}

#[cfg(not(windows))]
mod reg {
    pub fn dword(_: bool, _: &str, _: &str) -> Option<u32> { None }
    pub fn string(_: bool, _: &str, _: &str) -> Option<String> { None }
}

#[derive(Serialize)]
pub struct LocalChecks {
    quic_disabled_by: Vec<String>,
    proxy_enabled: bool,
    proxy_server: Option<String>,
    proxy_auto_config_url: Option<String>,
}

#[tauri::command]
pub fn netdiag_local_checks() -> LocalChecks {
    let values: Vec<(String, Option<u32>)> = POLICY_KEYS.iter()
        .map(|(machine, key)| (policy_label(*machine, key), reg::dword(*machine, key, "QuicAllowed")))
        .collect();
    const INET: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    LocalChecks {
        quic_disabled_by: quic_disabled_by(&values),
        proxy_enabled: reg::dword(false, INET, "ProxyEnable").unwrap_or(0) != 0,
        proxy_server: reg::string(false, INET, "ProxyServer"),
        proxy_auto_config_url: reg::string(false, INET, "AutoConfigURL"),
    }
}

// ── Probes ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ProbeArgs {
    host: String,
    /// The relay's main UDP port (version-negotiation check + handshake).
    main_port: u16,
    /// Further ports for a QUIC handshake (the alternate WebTransport port).
    #[serde(default)]
    quic_ports: Vec<u16>,
    /// Diagnostic UDP ports; needs token and key.
    #[serde(default)]
    udp_ports: Vec<u16>,
    token: Option<String>,
    key: Option<String>,
}

#[derive(Serialize, Default)]
pub struct UdpPortResult {
    port: u16,
    /// Sizes the OS accepted, and those it refused (a DF-set send over the
    /// local MTU fails here, without leaving the PC).
    sent: Vec<usize>,
    send_errors: Vec<String>,
    /// Sizes the relay confirmed receiving, with a valid HMAC.
    replied: Vec<usize>,
    /// The OS reported ICMP port-unreachable: something answered "no".
    refused: bool,
}

#[derive(Serialize, Default)]
pub struct VersionCheck { port: u16, sent: Vec<usize>, replied: bool, refused: bool }

#[derive(Serialize)]
pub struct QuicResult { port: u16, result: &'static str, ms: u64, detail: Option<String> }

#[derive(Serialize)]
pub struct ProbeResults {
    resolved: Option<String>,
    dont_fragment: bool,
    udp: Vec<UdpPortResult>,
    version: Option<VersionCheck>,
    quic: Vec<QuicResult>,
}

/// Sets IP_DONTFRAGMENT. Windows only; elsewhere the size test may be
/// satisfied by fragmentation, which the report notes via `dont_fragment`.
#[cfg(windows)]
fn set_dont_fragment(sock: &UdpSocket) -> bool {
    use std::os::windows::io::AsRawSocket;
    #[link(name = "ws2_32")]
    extern "system" {
        fn setsockopt(s: usize, level: i32, name: i32, value: *const u8, len: i32) -> i32;
    }
    const IPPROTO_IP: i32 = 0;
    const IP_DONTFRAGMENT: i32 = 14;
    let on: u32 = 1;
    unsafe { setsockopt(sock.as_raw_socket() as usize, IPPROTO_IP, IP_DONTFRAGMENT, &on as *const u32 as *const u8, 4) == 0 }
}
#[cfg(not(windows))]
fn set_dont_fragment(_: &UdpSocket) -> bool { false }

fn open_socket(addr: SocketAddr) -> std::io::Result<(UdpSocket, bool)> {
    let bind = if addr.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
    let sock = UdpSocket::bind(bind)?;
    let df = set_dont_fragment(&sock);
    sock.connect(addr)?;
    sock.set_read_timeout(Some(Duration::from_millis(150)))?;
    Ok((sock, df))
}

fn is_refused(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::ConnectionReset || e.kind() == std::io::ErrorKind::ConnectionRefused
}

fn probe_udp_port(addr: SocketAddr, token: [u8; 16], key: [u8; 32]) -> (UdpPortResult, bool) {
    let mut out = UdpPortResult { port: addr.port(), ..Default::default() };
    let (sock, df) = match open_socket(addr) {
        Ok(v) => v,
        Err(e) => { out.send_errors.push(e.to_string()); return (out, false); }
    };
    let mut seq = 0u16;
    for round in 0..2 {
        for size in PROBE_SIZES {
            match sock.send(&build_probe(&token, seq, size)) {
                Ok(_) => { if round == 0 { out.sent.push(size); } }
                Err(e) if is_refused(&e) => out.refused = true,
                Err(e) => { if round == 0 { out.send_errors.push(format!("{size}: {e}")); } }
            }
            seq += 1;
            std::thread::sleep(Duration::from_millis(30));
        }
    }
    let deadline = Instant::now() + RECV_WINDOW;
    let mut buf = [0u8; 256];
    while Instant::now() < deadline && out.replied.len() < PROBE_SIZES.len() {
        match sock.recv(&mut buf) {
            Ok(n) => {
                if let Some((_, size)) = verify_reply(&buf[..n], &key, &token) {
                    if !out.replied.contains(&(size as usize)) { out.replied.push(size as usize); }
                }
            }
            Err(e) if is_refused(&e) => out.refused = true,
            Err(_) => {}
        }
    }
    (out, df)
}

fn probe_version(addr: SocketAddr) -> VersionCheck {
    let mut out = VersionCheck { port: addr.port(), ..Default::default() };
    let Ok((sock, _)) = open_socket(addr) else { return out };
    let cid: [u8; 8] = rand::random();
    for _ in 0..3 {
        for size in VN_SIZES {
            match sock.send(&build_version_probe(&cid, size)) {
                Ok(_) => { if !out.sent.contains(&size) { out.sent.push(size); } }
                Err(e) if is_refused(&e) => out.refused = true,
                Err(_) => {}
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let deadline = Instant::now() + RECV_WINDOW;
    let mut buf = [0u8; 256];
    while Instant::now() < deadline && !out.replied {
        match sock.recv(&mut buf) {
            Ok(n) => out.replied = is_version_negotiation(&buf[..n], &cid),
            Err(e) if is_refused(&e) => out.refused = true,
            Err(_) => {}
        }
    }
    out
}

async fn quic_handshake(host: String, addr: SocketAddr) -> QuicResult {
    let start = Instant::now();
    let done = |result: &'static str, detail: Option<String>| QuicResult {
        port: addr.port(), result, ms: start.elapsed().as_millis() as u64, detail,
    };
    let connecting = (|| -> Result<(quinn::Endpoint, quinn::Connecting), String> {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions().map_err(|e| e.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"h3".to_vec()];
        let crypto = quinn::crypto::rustls::QuicClientConfig::try_from(tls).map_err(|e| e.to_string())?;
        let bind: SocketAddr = if addr.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" }.parse().map_err(|_| "bind".to_string())?;
        let endpoint = quinn::Endpoint::client(bind).map_err(|e| e.to_string())?;
        let conn = endpoint.connect_with(quinn::ClientConfig::new(Arc::new(crypto)), addr, &host).map_err(|e| e.to_string())?;
        Ok((endpoint, conn))
    })();
    let (endpoint, connecting) = match connecting {
        Ok(v) => v,
        Err(e) => return done("error", Some(e)),
    };
    let result = match tokio::time::timeout(QUIC_TIMEOUT, connecting).await {
        Ok(Ok(conn)) => { conn.close(0u32.into(), b"netdiag"); done("ok", None) }
        Ok(Err(quinn::ConnectionError::TimedOut)) | Err(_) => done("timeout", None),
        // Something answered: a TLS failure or a close is not silence.
        Ok(Err(e)) => done("failed", Some(e.to_string())),
    };
    endpoint.close(0u32.into(), b"netdiag");
    result
}

#[tauri::command]
pub async fn netdiag_probe(args: ProbeArgs) -> Result<ProbeResults, String> {
    let host = args.host.clone();
    let resolve = |port: u16| (host.as_str(), port).to_socket_addrs().ok().and_then(|mut a| a.next());
    let Some(main) = resolve(args.main_port) else {
        return Ok(ProbeResults { resolved: None, dont_fragment: false, udp: vec![], version: None, quic: vec![] });
    };
    let creds = args.token.as_deref().and_then(parse_hex::<16>).zip(args.key.as_deref().and_then(parse_hex::<32>));
    let mut udp_jobs = Vec::new();
    if let Some((token, key)) = creds {
        for port in args.udp_ports.iter().copied().take(4) {
            let addr = SocketAddr::new(main.ip(), port);
            udp_jobs.push(tauri::async_runtime::spawn_blocking(move || probe_udp_port(addr, token, key)));
        }
    }
    let version_job = tauri::async_runtime::spawn_blocking(move || probe_version(main));
    let mut quic_ports = vec![args.main_port];
    quic_ports.extend(args.quic_ports.iter().copied().filter(|p| *p != args.main_port).take(3));
    let quic_jobs: Vec<_> = quic_ports.into_iter()
        .map(|p| tauri::async_runtime::spawn(quic_handshake(args.host.clone(), SocketAddr::new(main.ip(), p))))
        .collect();

    let mut out = ProbeResults { resolved: Some(main.ip().to_string()), dont_fragment: false, udp: vec![], version: None, quic: vec![] };
    for job in udp_jobs {
        if let Ok((r, df)) = job.await { out.dont_fragment |= df; out.udp.push(r); }
    }
    out.version = version_job.await.ok();
    for job in quic_jobs {
        if let Ok(r) = job.await { out.quic.push(r); }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_layout_matches_the_relay() {
        let p = build_probe(&[7; 16], 3, 200);
        assert_eq!(p.len(), 200);
        assert_eq!(&p[0..6], b"SPNP\x01\x01");
        assert_eq!(&p[6..22], &[7; 16]);
        assert_eq!(&p[22..26], &[0, 3, 0, 200]);
    }

    #[test]
    fn reply_mac_matches_a_fixed_vector() {
        // Computed independently: HMAC-SHA256([2;32], "SPNP-reply"|[1;16]|5|1200)[..16].
        assert_eq!(parse_hex::<16>("cfb2d09a633c804213285bf8b1d595d5").unwrap(), reply_mac(&[2; 32], &[1; 16], 5, 1200));
    }

    #[test]
    fn replies_are_only_trusted_with_the_right_key() {
        let (token, key) = ([1u8; 16], [2u8; 32]);
        let mut r = Vec::new();
        r.extend_from_slice(b"SPNP\x01\x02");
        r.extend_from_slice(&token);
        r.extend_from_slice(&5u16.to_be_bytes());
        r.extend_from_slice(&1200u16.to_be_bytes());
        r.extend_from_slice(&reply_mac(&key, &token, 5, 1200));
        assert_eq!(verify_reply(&r, &key, &token), Some((5, 1200)));
        assert_eq!(verify_reply(&r, &[3; 32], &token), None);
        assert_eq!(verify_reply(&r, &key, &[9; 16]), None);
        assert_eq!(verify_reply(&r[..41], &key, &token), None);
        let mut tampered = r.clone();
        tampered[24] ^= 1; // a middlebox lying about the size
        assert_eq!(verify_reply(&tampered, &key, &token), None);
    }

    #[test]
    fn version_probe_and_its_answer() {
        let cid = [5u8; 8];
        let p = build_version_probe(&cid, 1200);
        assert_eq!(p.len(), 1200);
        assert_eq!(p[0] & 0xc0, 0xc0);
        assert_eq!(&p[1..5], &GREASE_VERSION);
        let mut vn = vec![0x80u8, 0, 0, 0, 0, 8];
        vn.extend_from_slice(&cid);
        vn.extend_from_slice(&[8, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 1]);
        assert!(is_version_negotiation(&vn, &cid));
        assert!(!is_version_negotiation(&vn, &[6; 8]));
        vn[1] = 1;
        assert!(!is_version_negotiation(&vn, &cid));
    }

    #[test]
    fn only_a_zero_quic_allowed_counts_as_disabled() {
        let vals = vec![
            (policy_label(true, POLICY_KEYS[0].1), Some(0)),
            (policy_label(false, POLICY_KEYS[1].1), Some(1)),
            (policy_label(false, POLICY_KEYS[3].1), None),
        ];
        assert_eq!(quic_disabled_by(&vals), vec![r"HKLM\SOFTWARE\Policies\Microsoft\Edge\QuicAllowed".to_string()]);
        assert!(quic_disabled_by(&[]).is_empty());
    }

    /// Against the live relay: `cargo test --lib netdiag_live -- --ignored --nocapture`.
    /// One version-check burst and one QUIC handshake, the same as a client's.
    #[test]
    #[ignore]
    fn netdiag_live() {
        let args = ProbeArgs { host: "spectercoms.net".into(), main_port: 443, quic_ports: vec![], udp_ports: vec![], token: None, key: None };
        let r = tauri::async_runtime::block_on(netdiag_probe(args)).unwrap();
        println!("{}", serde_json::to_string_pretty(&r).unwrap());
        assert!(r.version.unwrap().replied, "the relay should answer a reserved QUIC version");
        assert_eq!(r.quic[0].result, "ok");
    }

    #[test]
    fn hex_parsing() {
        assert_eq!(parse_hex::<2>("00ff"), Some([0, 255]));
        assert_eq!(parse_hex::<2>("00f"), None);
        assert_eq!(parse_hex::<2>("zzzz"), None);
    }
}
