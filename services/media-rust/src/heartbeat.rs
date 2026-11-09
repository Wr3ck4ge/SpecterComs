//! The capacity heartbeat identity-node's discovery.ts consumes to populate
//! `media_nodes`. Built with serde, so a quote or backslash in PUBLIC_URL /
//! NODE_ID / REGION can no longer produce invalid JSON (eval M5).
//!
//! Wire schema (field order kept from the old `format!` version):
//! `status, public_url, node_id, region, voice_sessions, video_viewers,
//! video_sharers, cpu_pct (1 dp), mem_pct (1 dp), net_rx_mbps (2 dp),
//! net_tx_mbps (2 dp), draining`. `draining` is new and optional for the
//! consumer (absent = false on older relays). `tests/fixtures/heartbeat.sample.json`
//! is the canonical rendered sample; a Rust test pins the serializer to it,
//! so the TS contract test can read the fixture instead of parsing Rust.
//! `alt_port` (optional, last) is the alternate WebTransport UDP port
//! (WEBTRANSPORT_ALT_PORT) — omitted entirely when unset, so a relay without
//! one sends exactly the old 12 fields (`heartbeat.alt_port.sample.json` is
//! the sample with it).

use serde::Serialize;

/// Who this node is. Fixed for the process lifetime.
#[derive(Debug, Clone)]
pub struct NodeIdentity {
    pub public_url: String,
    pub node_id: String,
    pub region: String,
    /// WEBTRANSPORT_ALT_PORT, when this relay also listens there.
    pub alt_port: Option<u16>,
}

/// Live load, sampled every heartbeat tick.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Capacity {
    pub voice_sessions: usize,
    pub video_viewers: usize,
    pub video_sharers: usize,
    pub cpu_pct: f64,
    pub mem_pct: f64,
    pub net_rx_mbps: f64,
    pub net_tx_mbps: f64,
    /// An org drain is in progress on this node (see drain::DrainTracker).
    pub draining: bool,
}

#[derive(Serialize)]
struct HeartbeatWire<'a> {
    status: &'static str,
    public_url: &'a str,
    node_id: &'a str,
    region: &'a str,
    voice_sessions: usize,
    video_viewers: usize,
    video_sharers: usize,
    cpu_pct: f64,
    mem_pct: f64,
    net_rx_mbps: f64,
    net_tx_mbps: f64,
    draining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    alt_port: Option<u16>,
}

/// Round to `places` decimals, the way the old `{:.N}` formatting presented
/// it. Non-finite values (a NaN from a zero elapsed time, say) become 0 —
/// serde_json would otherwise emit `null` where discovery.ts expects a number.
fn round_to(x: f64, places: i32) -> f64 {
    if !x.is_finite() {
        return 0.0;
    }
    let m = 10f64.powi(places);
    (x * m).round() / m
}

/// The heartbeat JSON body.
pub fn heartbeat_payload(id: &NodeIdentity, cap: &Capacity) -> Vec<u8> {
    let wire = HeartbeatWire {
        status: "ok",
        public_url: &id.public_url,
        node_id: &id.node_id,
        region: &id.region,
        voice_sessions: cap.voice_sessions,
        video_viewers: cap.video_viewers,
        video_sharers: cap.video_sharers,
        cpu_pct: round_to(cap.cpu_pct, 1),
        mem_pct: round_to(cap.mem_pct, 1),
        net_rx_mbps: round_to(cap.net_rx_mbps, 2),
        net_tx_mbps: round_to(cap.net_tx_mbps, 2),
        draining: cap.draining,
        alt_port: id.alt_port,
    };
    // Serializing a struct of strings, integers, finite floats and a bool
    // cannot fail.
    serde_json::to_vec(&wire).expect("heartbeat serialization")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_and_non_finite() {
        assert_eq!(round_to(12.345, 1), 12.3);
        assert_eq!(round_to(5.678, 2), 5.68);
        assert_eq!(round_to(f64::NAN, 2), 0.0);
        assert_eq!(round_to(f64::INFINITY, 1), 0.0);
    }
}
