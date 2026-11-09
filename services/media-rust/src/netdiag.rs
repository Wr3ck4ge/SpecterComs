//! Server-assisted network diagnosis ("netprobe").
//!
//! A client whose voice never connects (QUIC/UDP 443 blocked somewhere) runs
//! a coordinated test with identity-node and this relay so the Repair panel
//! can say WHERE the path breaks:
//!
//! 1. identity-node (`POST /diag/netprobe`, authenticated + rate-limited)
//!    mints a random 16-byte token and a 32-byte per-probe HMAC key and
//!    publishes `specter.cmd.netprobe.arm` `{ token, key, ttl_secs, client_ip }`.
//!    Every relay arms it (the client probes the one its media_url names) and
//!    answers `specter.diag.netprobe.<node_id>` `{ type: "armed", ports, … }`.
//! 2. The client sends probe datagrams (format below) at several sizes to the
//!    alternate UDP port(s) in `NETPROBE_UDP_PORTS` (comma list, OFF when
//!    unset). Each valid one is recorded and answered with a small reply
//!    carrying an HMAC so the client can trust it came from here (inbound UDP).
//! 3. The client's WebView2 opens a WebTransport session to
//!    `/specter/netprobe?token=<hex>` on the normal relay port. That path is
//!    never a real session: it is recorded (proving the QUIC + HTTP/3
//!    handshake reached us) and refused with 404.
//! 4. Every change is published as `{ type: "report", … }` on the same
//!    subject; identity-node keeps the latest per token for the client's
//!    `GET /diag/netprobe/:token`.
//!
//! ## Wire format (big endian)
//! Request (client → relay), 64..=1500 bytes:
//! `"SPNP" | ver=1 | kind=1 | token[16] | seq u16 | total_len u16 | zero padding`
//! (`total_len` must equal the datagram length: a truncated datagram is not counted).
//! Reply (relay → client), always [`REPLY_LEN`] = 42 bytes:
//! `"SPNP" | ver=1 | kind=2 | token[16] | seq u16 | recv_len u16 | mac[16]`
//! `mac` = HMAC-SHA256(key, "SPNP-reply" | token | seq | recv_len), first 16 bytes.
//!
//! ## Safety
//! - Only packets with a currently armed, unexpired token are answered;
//!   anything else is dropped silently (no reply, no per-packet log).
//! - A reply (42 B) is always smaller than the smallest accepted request
//!   (64 B): no amplification, and reflection gains an attacker nothing.
//! - Per token: at most [`MAX_PACKETS_PER_PROBE`] packets are counted /
//!   answered. Per source IP: a token bucket ([`IP_RATE_PER_SEC`]). At most
//!   [`MAX_ACTIVE_PROBES`] armed at once; a token can be armed only once.
//! - Payload content is never logged; the relay logs one summary line per probe.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use log::{info, warn};
use serde::Serialize;
use sha2::Sha256;

pub const MAGIC: &[u8; 4] = b"SPNP";
pub const VERSION: u8 = 1;
pub const KIND_PROBE: u8 = 1;
pub const KIND_REPLY: u8 = 2;
pub const TOKEN_LEN: usize = 16;
pub const HEADER_LEN: usize = 26;
pub const MIN_REQUEST_LEN: usize = 64;
pub const MAX_REQUEST_LEN: usize = 1500;
pub const REPLY_LEN: usize = 42;
pub const MAX_PACKETS_PER_PROBE: usize = 64;
pub const MAX_ACTIVE_PROBES: usize = 256;
pub const MAX_TTL_SECS: u64 = 120;
pub const IP_RATE_PER_SEC: f64 = 20.0;
pub const IP_BURST: f64 = 40.0;
pub const ARM_SUBJECT: &str = "specter.cmd.netprobe.arm";
pub const PROBE_PATH: &str = "/specter/netprobe";

pub fn result_subject(node_id: &str) -> String {
    format!("specter.diag.netprobe.{}", node_id)
}

type HmacSha256 = Hmac<Sha256>;

// ── Packet parsing / reply building (pure) ──────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeHeader {
    pub token: [u8; TOKEN_LEN],
    pub seq: u16,
    pub len: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    TooShort,
    TooLong,
    BadMagic,
    BadVersion,
    BadKind,
    LengthMismatch,
}

pub fn parse_probe(buf: &[u8]) -> Result<ProbeHeader, Reject> {
    if buf.len() < MIN_REQUEST_LEN { return Err(Reject::TooShort); }
    if buf.len() > MAX_REQUEST_LEN { return Err(Reject::TooLong); }
    if &buf[0..4] != MAGIC { return Err(Reject::BadMagic); }
    if buf[4] != VERSION { return Err(Reject::BadVersion); }
    if buf[5] != KIND_PROBE { return Err(Reject::BadKind); }
    let mut token = [0u8; TOKEN_LEN];
    token.copy_from_slice(&buf[6..22]);
    let seq = u16::from_be_bytes([buf[22], buf[23]]);
    let declared = u16::from_be_bytes([buf[24], buf[25]]) as usize;
    if declared != buf.len() { return Err(Reject::LengthMismatch); }
    Ok(ProbeHeader { token, seq, len: buf.len() })
}

pub fn reply_mac(key: &[u8], token: &[u8; TOKEN_LEN], seq: u16, recv_len: u16) -> [u8; 16] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(b"SPNP-reply");
    mac.update(token);
    mac.update(&seq.to_be_bytes());
    mac.update(&recv_len.to_be_bytes());
    let full = mac.finalize().into_bytes();
    let mut out = [0u8; 16];
    out.copy_from_slice(&full[..16]);
    out
}

/// The reply to an accepted probe. Never longer than the request (asserted).
pub fn build_reply(h: &ProbeHeader, key: &[u8]) -> Vec<u8> {
    let recv_len = h.len as u16;
    let mut out = Vec::with_capacity(REPLY_LEN);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.push(KIND_REPLY);
    out.extend_from_slice(&h.token);
    out.extend_from_slice(&h.seq.to_be_bytes());
    out.extend_from_slice(&recv_len.to_be_bytes());
    out.extend_from_slice(&reply_mac(key, &h.token, h.seq, recv_len));
    debug_assert_eq!(out.len(), REPLY_LEN);
    debug_assert!(out.len() <= h.len, "a reply must never be larger than its request");
    out
}

pub fn parse_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    let v = hex::decode(s.trim()).ok()?;
    if v.len() != N { return None; }
    let mut out = [0u8; N];
    out.copy_from_slice(&v);
    Some(out)
}

/// `NETPROBE_UDP_PORTS`: comma list of 1..=65535, at most 4; junk entries are
/// skipped. Unset / empty = the UDP listener is off.
pub fn parse_ports(raw: Option<&str>) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for p in raw.unwrap_or("").split(',') {
        if let Ok(n) = p.trim().parse::<u16>() {
            if n > 0 && !out.contains(&n) && out.len() < 4 { out.push(n); }
        }
    }
    out
}

// ── Rate limiting (pure, clock passed in) ───────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct Bucket { tokens: f64, at: Instant }

#[derive(Debug, Default)]
pub struct IpLimiter { buckets: HashMap<IpAddr, Bucket> }

impl IpLimiter {
    /// One packet from `ip` at `now`: true = allowed.
    pub fn allow(&mut self, ip: IpAddr, now: Instant) -> bool {
        if self.buckets.len() > 4096 {
            self.buckets.retain(|_, b| now.duration_since(b.at) < Duration::from_secs(10));
        }
        let b = self.buckets.entry(ip).or_insert(Bucket { tokens: IP_BURST, at: now });
        let refill = now.saturating_duration_since(b.at).as_secs_f64() * IP_RATE_PER_SEC;
        b.tokens = (b.tokens + refill).min(IP_BURST);
        b.at = now;
        if b.tokens >= 1.0 { b.tokens -= 1.0; true } else { false }
    }
}

// ── Probe registry ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PacketRecord {
    pub port: u16,
    pub size: usize,
    pub seq: u16,
    pub at_ms: u64,
    pub src: String,
    pub replied: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HandshakeRecord { pub at_ms: u64, pub src: String }

#[derive(Debug)]
pub struct Probe {
    key: [u8; 32],
    armed_at: Instant,
    expires: Instant,
    client_ip: Option<IpAddr>,
    packets: Vec<PacketRecord>,
    replies_sent: usize,
    dropped_over_cap: usize,
    webtransport: Vec<HandshakeRecord>,
    dirty: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeReport {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub node_id: String,
    pub token: String,
    pub ports: Vec<u16>,
    pub public_url: String,
    pub packets: Vec<PacketRecord>,
    pub replies_sent: usize,
    pub dropped_over_cap: usize,
    pub webtransport: Vec<HandshakeRecord>,
    /// Whether the IP identity-node saw over HTTPS matches a UDP source.
    pub client_ip_matched: Option<bool>,
    pub final_report: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArmError { BadToken, BadKey, AlreadyArmed, Full }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketOutcome { UnknownToken, Expired, OverCap, Accepted }

#[derive(Debug, Default)]
pub struct Registry { probes: HashMap<[u8; TOKEN_LEN], Probe>, used: HashMap<[u8; TOKEN_LEN], Instant> }

impl Registry {
    pub fn arm(&mut self, token: [u8; TOKEN_LEN], key: [u8; 32], ttl: Duration, client_ip: Option<IpAddr>, now: Instant) -> Result<(), ArmError> {
        self.sweep(now);
        // Single use: a token that was ever armed (still remembered) can't be re-armed.
        if self.probes.contains_key(&token) || self.used.contains_key(&token) { return Err(ArmError::AlreadyArmed); }
        if self.probes.len() >= MAX_ACTIVE_PROBES { return Err(ArmError::Full); }
        let ttl = ttl.min(Duration::from_secs(MAX_TTL_SECS)).max(Duration::from_secs(5));
        self.used.insert(token, now + Duration::from_secs(MAX_TTL_SECS * 2));
        self.probes.insert(token, Probe {
            key, armed_at: now, expires: now + ttl, client_ip,
            packets: Vec::new(), replies_sent: 0, dropped_over_cap: 0, webtransport: Vec::new(), dirty: true,
        });
        Ok(())
    }

    /// A parsed probe datagram from `src` on `port`. Returns the reply to
    /// send (if any) and what happened.
    pub fn on_packet(&mut self, h: &ProbeHeader, port: u16, src: SocketAddr, now: Instant) -> (PacketOutcome, Option<Vec<u8>>) {
        let Some(p) = self.probes.get_mut(&h.token) else { return (PacketOutcome::UnknownToken, None) };
        if now >= p.expires { return (PacketOutcome::Expired, None); }
        if p.packets.len() >= MAX_PACKETS_PER_PROBE {
            p.dropped_over_cap += 1;
            return (PacketOutcome::OverCap, None);
        }
        let reply = build_reply(h, &p.key);
        p.packets.push(PacketRecord {
            port, size: h.len, seq: h.seq, at_ms: now.duration_since(p.armed_at).as_millis() as u64,
            src: src.to_string(), replied: true,
        });
        p.replies_sent += 1;
        p.dirty = true;
        (PacketOutcome::Accepted, Some(reply))
    }

    /// The WebTransport probe path reached us (QUIC + HTTP/3 handshake done).
    pub fn on_webtransport(&mut self, token: &[u8; TOKEN_LEN], src: SocketAddr, now: Instant) -> bool {
        let Some(p) = self.probes.get_mut(token) else { return false };
        if now >= p.expires || p.webtransport.len() >= 8 { return false; }
        p.webtransport.push(HandshakeRecord { at_ms: now.duration_since(p.armed_at).as_millis() as u64, src: src.to_string() });
        p.dirty = true;
        true
    }

    fn report(token: &[u8; TOKEN_LEN], p: &Probe, node: &NodeInfo, final_report: bool) -> ProbeReport {
        let client_ip_matched = p.client_ip.map(|ip| {
            p.packets.iter().any(|r| r.src.parse::<SocketAddr>().map(|s| s.ip() == ip).unwrap_or(false))
                || p.webtransport.iter().any(|r| r.src.parse::<SocketAddr>().map(|s| s.ip() == ip).unwrap_or(false))
        });
        ProbeReport {
            kind: "report", node_id: node.node_id.clone(), token: hex::encode(token), ports: node.ports.clone(),
            public_url: node.public_url.clone(), packets: p.packets.clone(), replies_sent: p.replies_sent,
            dropped_over_cap: p.dropped_over_cap, webtransport: p.webtransport.clone(), client_ip_matched, final_report,
        }
    }

    /// Reports for every probe changed since the last call.
    pub fn take_dirty(&mut self, node: &NodeInfo) -> Vec<ProbeReport> {
        let mut out = Vec::new();
        for (t, p) in self.probes.iter_mut() {
            if p.dirty { p.dirty = false; out.push(Self::report(t, p, node, false)); }
        }
        out
    }

    /// Drops expired probes, returning their final reports.
    pub fn expire(&mut self, node: &NodeInfo, now: Instant) -> Vec<ProbeReport> {
        let done: Vec<[u8; TOKEN_LEN]> = self.probes.iter().filter(|(_, p)| now >= p.expires).map(|(t, _)| *t).collect();
        let mut out = Vec::new();
        for t in done {
            if let Some(p) = self.probes.remove(&t) {
                info!("netprobe {}…: {} packets, {} replies, {} over cap, {} webtransport handshakes",
                    &hex::encode(t)[..8], p.packets.len(), p.replies_sent, p.dropped_over_cap, p.webtransport.len());
                out.push(Self::report(&t, &p, node, true));
            }
        }
        self.sweep(now);
        out
    }

    fn sweep(&mut self, now: Instant) { self.used.retain(|_, until| now < *until); }

    pub fn active(&self) -> usize { self.probes.len() }
}

#[derive(Debug, Clone)]
pub struct NodeInfo { pub node_id: String, pub ports: Vec<u16>, pub public_url: String }

// ── Runtime ─────────────────────────────────────────────────────────────────

struct Shared { registry: Mutex<Registry>, limiter: Mutex<IpLimiter>, node: NodeInfo }

static SHARED: OnceLock<Arc<Shared>> = OnceLock::new();

pub fn is_probe_path(path: &str) -> bool {
    path == PROBE_PATH || path.starts_with("/specter/netprobe?")
}

/// The token in `/specter/netprobe?token=<hex>`, if well-formed.
pub fn token_from_path(path: &str) -> Option<[u8; TOKEN_LEN]> {
    let q = path.split_once('?')?.1;
    q.split('&').find_map(|kv| kv.strip_prefix("token=")).and_then(parse_hex::<TOKEN_LEN>)
}

/// Called by handle_connection for the probe path (after the handshake).
/// Returns whether a live probe recorded it. Works (returns false) when
/// netprobe never started.
pub fn note_webtransport_probe(path: &str, src: SocketAddr) -> bool {
    let Some(shared) = SHARED.get() else { return false };
    let Some(token) = token_from_path(path) else { return false };
    let ok = shared.registry.lock().map(|mut r| r.on_webtransport(&token, src, Instant::now())).unwrap_or(false);
    if ok { info!("netprobe {}…: WebTransport handshake reached the relay", &hex::encode(token)[..8]); }
    ok
}

#[derive(serde::Deserialize)]
struct ArmCmd { token: String, key: String, ttl_secs: Option<u64>, client_ip: Option<String> }

#[derive(Serialize)]
struct Armed<'a> { #[serde(rename = "type")] kind: &'static str, node_id: &'a str, token: &'a str, ports: &'a [u16], public_url: &'a str }

/// Starts netprobe: the arm-command subscription, the UDP listener(s) on
/// `NETPROBE_UDP_PORTS` and the report publisher. Needs NATS (without it
/// nothing could arm a token). The WebTransport probe path works with or
/// without UDP ports configured.
pub async fn start(nats: Option<async_nats::Client>, node_id: String, public_url: String) {
    let Some(nats) = nats else { return };
    let ports = parse_ports(std::env::var("NETPROBE_UDP_PORTS").ok().as_deref());
    let shared = Arc::new(Shared {
        registry: Mutex::new(Registry::default()),
        limiter: Mutex::new(IpLimiter::default()),
        node: NodeInfo { node_id: node_id.clone(), ports: ports.clone(), public_url },
    });
    if SHARED.set(shared.clone()).is_err() { return; }
    let subject = result_subject(&node_id);

    for port in ports.iter().copied() {
        let shared = shared.clone();
        match tokio::net::UdpSocket::bind(("0.0.0.0", port)).await {
            Ok(sock) => {
                info!("netprobe: UDP diagnostic listener on :{}", port);
                tokio::spawn(async move { udp_loop(sock, port, shared).await });
            }
            Err(e) => warn!("netprobe: cannot bind UDP :{} ({}); that port is not probed", port, e),
        }
    }

    // Arm commands.
    let sub = match nats.subscribe(ARM_SUBJECT.to_string()).await {
        Ok(s) => s,
        Err(e) => { warn!("netprobe: cannot subscribe to {} ({}); netprobe off", ARM_SUBJECT, e); return; }
    };
    {
        let shared = shared.clone();
        let nats = nats.clone();
        let subject = subject.clone();
        tokio::spawn(async move {
            use futures::StreamExt;
            let mut sub = sub;
            while let Some(msg) = sub.next().await {
                let Ok(cmd) = serde_json::from_slice::<ArmCmd>(&msg.payload) else { continue };
                let (Some(token), Some(key)) = (parse_hex::<TOKEN_LEN>(&cmd.token), parse_hex::<32>(&cmd.key)) else { continue };
                let client_ip = cmd.client_ip.as_deref().and_then(|s| s.parse::<IpAddr>().ok());
                let ttl = Duration::from_secs(cmd.ttl_secs.unwrap_or(60));
                let armed_ok = match shared.registry.lock() {
                    Ok(mut r) => r.arm(token, key, ttl, client_ip, Instant::now()).is_ok(),
                    Err(_) => false,
                };
                if armed_ok {
                    let token_hex = hex::encode(token);
                    let armed = Armed { kind: "armed", node_id: &shared.node.node_id, token: &token_hex, ports: &shared.node.ports, public_url: &shared.node.public_url };
                    if let Ok(body) = serde_json::to_vec(&armed) {
                        let _ = nats.publish(subject.clone(), bytes::Bytes::from(body)).await;
                    }
                }
            }
        });
    }

    // Report publisher: changed probes every 300 ms, finals on expiry.
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(300));
        loop {
            tick.tick().await;
            let reports = match shared.registry.lock() {
                Ok(mut r) => {
                    let mut v = r.take_dirty(&shared.node);
                    v.extend(r.expire(&shared.node, Instant::now()));
                    v
                }
                Err(_) => continue,
            };
            for rep in reports {
                if let Ok(body) = serde_json::to_vec(&rep) {
                    let _ = nats.publish(subject.clone(), bytes::Bytes::from(body)).await;
                }
            }
        }
    });
}

async fn udp_loop(sock: tokio::net::UdpSocket, port: u16, shared: Arc<Shared>) {
    let mut buf = vec![0u8; MAX_REQUEST_LEN + 1];
    loop {
        let (n, src) = match sock.recv_from(&mut buf).await {
            Ok(v) => v,
            Err(_) => { tokio::time::sleep(Duration::from_millis(5)).await; continue; }
        };
        let now = Instant::now();
        let allowed = shared.limiter.lock().map(|mut l| l.allow(src.ip(), now)).unwrap_or(false);
        if !allowed { continue; }
        let Ok(h) = parse_probe(&buf[..n]) else { continue };
        let reply = shared.registry.lock().ok().and_then(|mut r| r.on_packet(&h, port, src, now).1);
        if let Some(reply) = reply {
            if reply.len() <= n { let _ = sock.send_to(&reply, src).await; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(token: [u8; 16], seq: u16, len: usize) -> Vec<u8> {
        let mut v = vec![0u8; len];
        v[0..4].copy_from_slice(MAGIC);
        v[4] = VERSION;
        v[5] = KIND_PROBE;
        v[6..22].copy_from_slice(&token);
        v[22..24].copy_from_slice(&seq.to_be_bytes());
        v[24..26].copy_from_slice(&(len as u16).to_be_bytes());
        v
    }
    fn addr() -> SocketAddr { "203.0.113.7:50000".parse().unwrap() }
    fn node() -> NodeInfo { NodeInfo { node_id: "node-a".into(), ports: vec![3478], public_url: "https://x".into() } }

    #[test]
    fn parses_valid_probes_and_rejects_malformed_ones() {
        let t = [7u8; 16];
        assert_eq!(parse_probe(&probe(t, 3, 200)), Ok(ProbeHeader { token: t, seq: 3, len: 200 }));
        assert_eq!(parse_probe(&probe(t, 3, 63)[..]), Err(Reject::TooShort));
        assert_eq!(parse_probe(&vec![0u8; 1501]), Err(Reject::TooLong));
        let mut bad = probe(t, 1, 100); bad[0] = b'X';
        assert_eq!(parse_probe(&bad), Err(Reject::BadMagic));
        let mut bad = probe(t, 1, 100); bad[4] = 2;
        assert_eq!(parse_probe(&bad), Err(Reject::BadVersion));
        let mut bad = probe(t, 1, 100); bad[5] = KIND_REPLY;
        assert_eq!(parse_probe(&bad), Err(Reject::BadKind));
        // Truncated in flight: declared 1200, arrived 1000.
        let p = probe(t, 1, 1200);
        assert_eq!(parse_probe(&p[..1000]), Err(Reject::LengthMismatch));
    }

    #[test]
    fn no_amplification_reply_is_never_larger_than_the_request() {
        assert!(REPLY_LEN < MIN_REQUEST_LEN);
        let key = [9u8; 32];
        for len in [MIN_REQUEST_LEN, 200, 1200, 1350, 1450, MAX_REQUEST_LEN] {
            let h = parse_probe(&probe([1; 16], 0, len)).unwrap();
            let r = build_reply(&h, &key);
            assert_eq!(r.len(), REPLY_LEN);
            assert!(r.len() <= len);
        }
    }

    #[test]
    fn reply_mac_binds_key_token_seq_and_length() {
        let h = parse_probe(&probe([1; 16], 5, 1200)).unwrap();
        let r = build_reply(&h, &[2u8; 32]);
        assert_eq!(&r[26..42], &reply_mac(&[2u8; 32], &[1; 16], 5, 1200));
        assert_ne!(reply_mac(&[3u8; 32], &[1; 16], 5, 1200), reply_mac(&[2u8; 32], &[1; 16], 5, 1200));
        assert_ne!(reply_mac(&[2u8; 32], &[1; 16], 6, 1200), reply_mac(&[2u8; 32], &[1; 16], 5, 1200));
        assert_ne!(reply_mac(&[2u8; 32], &[1; 16], 5, 200), reply_mac(&[2u8; 32], &[1; 16], 5, 1200));
    }

    #[test]
    fn reply_mac_matches_the_clients_fixed_vector() {
        // The same vector web-portal/src-tauri/src/netdiag.rs checks.
        assert_eq!(hex::encode(reply_mac(&[2; 32], &[1; 16], 5, 1200)), "cfb2d09a633c804213285bf8b1d595d5");
    }

    #[test]
    fn only_armed_unexpired_tokens_are_answered_and_tokens_are_single_use() {
        let mut reg = Registry::default();
        let now = Instant::now();
        let t = [4u8; 16];
        let h = parse_probe(&probe(t, 0, 200)).unwrap();
        assert_eq!(reg.on_packet(&h, 3478, addr(), now).0, PacketOutcome::UnknownToken);
        reg.arm(t, [1; 32], Duration::from_secs(30), None, now).unwrap();
        let (o, reply) = reg.on_packet(&h, 3478, addr(), now);
        assert_eq!(o, PacketOutcome::Accepted);
        assert!(reply.is_some());
        assert_eq!(reg.arm(t, [1; 32], Duration::from_secs(30), None, now), Err(ArmError::AlreadyArmed));
        let later = now + Duration::from_secs(31);
        assert_eq!(reg.on_packet(&h, 3478, addr(), later).0, PacketOutcome::Expired);
        let finals = reg.expire(&node(), later);
        assert_eq!(finals.len(), 1);
        assert!(finals[0].final_report);
        assert_eq!(finals[0].packets.len(), 1);
        // Expired and removed, but still remembered: can't be re-armed.
        assert_eq!(reg.arm(t, [1; 32], Duration::from_secs(30), None, later), Err(ArmError::AlreadyArmed));
        assert_eq!(reg.on_packet(&h, 3478, addr(), later).0, PacketOutcome::UnknownToken);
    }

    #[test]
    fn ttl_is_clamped() {
        let mut reg = Registry::default();
        let now = Instant::now();
        reg.arm([5; 16], [1; 32], Duration::from_secs(10_000), None, now).unwrap();
        let h = parse_probe(&probe([5; 16], 0, 100)).unwrap();
        assert_eq!(reg.on_packet(&h, 1, addr(), now + Duration::from_secs(MAX_TTL_SECS + 1)).0, PacketOutcome::Expired);
    }

    #[test]
    fn per_probe_packet_cap() {
        let mut reg = Registry::default();
        let now = Instant::now();
        reg.arm([6; 16], [1; 32], Duration::from_secs(30), None, now).unwrap();
        for i in 0..MAX_PACKETS_PER_PROBE {
            let h = parse_probe(&probe([6; 16], i as u16, 100)).unwrap();
            assert_eq!(reg.on_packet(&h, 1, addr(), now).0, PacketOutcome::Accepted);
        }
        let h = parse_probe(&probe([6; 16], 999, 100)).unwrap();
        let (o, r) = reg.on_packet(&h, 1, addr(), now);
        assert_eq!(o, PacketOutcome::OverCap);
        assert!(r.is_none());
    }

    #[test]
    fn active_probe_cap() {
        let mut reg = Registry::default();
        let now = Instant::now();
        for i in 0..MAX_ACTIVE_PROBES {
            let mut t = [0u8; 16];
            t[..8].copy_from_slice(&(i as u64).to_be_bytes());
            reg.arm(t, [1; 32], Duration::from_secs(30), None, now).unwrap();
        }
        assert_eq!(reg.arm([0xff; 16], [1; 32], Duration::from_secs(30), None, now), Err(ArmError::Full));
    }

    #[test]
    fn ip_rate_limiter_allows_a_burst_then_refills() {
        let mut l = IpLimiter::default();
        let ip: IpAddr = "198.51.100.1".parse().unwrap();
        let other: IpAddr = "198.51.100.2".parse().unwrap();
        let now = Instant::now();
        let allowed = (0..100).filter(|_| l.allow(ip, now)).count();
        assert_eq!(allowed, IP_BURST as usize);
        assert!(l.allow(other, now), "limits are per source IP");
        assert!(!l.allow(ip, now));
        assert!(l.allow(ip, now + Duration::from_millis(100)), "refills at IP_RATE_PER_SEC");
    }

    #[test]
    fn reports_track_changes_and_client_ip() {
        let mut reg = Registry::default();
        let now = Instant::now();
        reg.arm([8; 16], [1; 32], Duration::from_secs(30), Some("203.0.113.7".parse().unwrap()), now).unwrap();
        assert_eq!(reg.take_dirty(&node()).len(), 1); // armed
        assert!(reg.take_dirty(&node()).is_empty());
        assert!(reg.on_webtransport(&[8; 16], addr(), now));
        let reps = reg.take_dirty(&node());
        assert_eq!(reps.len(), 1);
        assert_eq!(reps[0].webtransport.len(), 1);
        assert_eq!(reps[0].client_ip_matched, Some(true));
        assert!(!reg.on_webtransport(&[9; 16], addr(), now));
    }

    #[test]
    fn probe_path_and_ports() {
        assert!(is_probe_path("/specter/netprobe?token=ab"));
        assert!(!is_probe_path("/specter?token=x&channel_id=y"));
        assert!(!is_probe_path("/specter/netprobex"));
        let t = [0xabu8; 16];
        assert_eq!(token_from_path(&format!("/specter/netprobe?token={}", hex::encode(t))), Some(t));
        assert_eq!(token_from_path("/specter/netprobe?token=zz"), None);
        assert_eq!(parse_ports(None), Vec::<u16>::new());
        assert_eq!(parse_ports(Some("3478, 40443,x,0,3478,1,2,3")), vec![3478, 40443, 1, 2]);
        assert_eq!(result_subject("node-a"), "specter.diag.netprobe.node-a");
    }
}
