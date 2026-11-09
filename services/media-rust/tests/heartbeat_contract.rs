//! The heartbeat wire contract with identity-node's discovery.ts.
//!
//! `tests/fixtures/heartbeat.sample.json` is the canonical rendered sample
//! (the same sample values identity-node's tiers-heartbeat-contract.test.ts
//! uses). This test pins the serializer to it byte for byte, so the TS side
//! can check the fixture against the fields discovery.ts reads instead of
//! parsing Rust source.

use media_sfu::heartbeat::{heartbeat_payload, Capacity, NodeIdentity};
use media_sfu::nats::heartbeat_subject;
use serde_json::Value;

fn sample() -> (NodeIdentity, Capacity) {
    (
        NodeIdentity {
            public_url: "https://node-a.spectercoms.net".into(),
            node_id: "node-a".into(),
            region: "nyc3".into(),
            alt_port: None,
        },
        Capacity {
            voice_sessions: 3,
            video_viewers: 2,
            video_sharers: 1,
            cpu_pct: 12.345,
            mem_pct: 40.1,
            net_rx_mbps: 1.234,
            net_tx_mbps: 5.678,
            draining: false,
        },
    )
}

#[test]
fn serializer_matches_the_fixture_exactly() {
    let (id, cap) = sample();
    let got = String::from_utf8(heartbeat_payload(&id, &cap)).unwrap();
    let fixture = include_str!("fixtures/heartbeat.sample.json").trim();
    assert_eq!(got, fixture);
}

#[test]
fn carries_every_field_discovery_reads_with_the_right_types() {
    let (id, cap) = sample();
    let v: Value = serde_json::from_slice(&heartbeat_payload(&id, &cap)).unwrap();
    assert_eq!(v["status"], "ok");
    for k in ["public_url", "node_id", "region"] {
        assert!(v[k].is_string(), "{k}");
    }
    for k in ["voice_sessions", "video_viewers", "video_sharers"] {
        assert!(v[k].is_u64(), "{k}");
    }
    for k in ["cpu_pct", "mem_pct", "net_rx_mbps", "net_tx_mbps"] {
        assert!(v[k].is_number(), "{k}");
    }
    assert_eq!(v["draining"], false);
    assert_eq!(v.as_object().unwrap().len(), 12, "a new field? update the fixture and the TS contract test");
}

#[test]
fn alt_port_is_optional_and_matches_its_fixture() {
    let (mut id, cap) = sample();
    id.alt_port = Some(3478);
    let got = String::from_utf8(heartbeat_payload(&id, &cap)).unwrap();
    assert_eq!(got, include_str!("fixtures/heartbeat.alt_port.sample.json").trim());
    let v: Value = serde_json::from_str(&got).unwrap();
    assert_eq!(v["alt_port"], 3478);
    assert_eq!(v.as_object().unwrap().len(), 13);
}

#[test]
fn draining_flag_is_serialized() {
    let (id, mut cap) = sample();
    cap.draining = true;
    let v: Value = serde_json::from_slice(&heartbeat_payload(&id, &cap)).unwrap();
    assert_eq!(v["draining"], true);
}

#[test]
fn quotes_and_backslashes_in_identity_stay_valid_json() {
    // The old format!-built payload turned any of these into invalid JSON,
    // and identity-node silently dropped every heartbeat (eval M5).
    let id = NodeIdentity {
        public_url: "https://x/\"a\\b".into(),
        node_id: "n\"1".into(),
        region: "nyc\"3\n".into(),
        alt_port: None,
    };
    let v: Value = serde_json::from_slice(&heartbeat_payload(&id, &sample().1)).unwrap();
    assert_eq!(v["region"], "nyc\"3\n");
    assert_eq!(v["public_url"], "https://x/\"a\\b");
}

#[test]
fn non_finite_load_values_become_zero_not_null() {
    // First tick: elapsed ~0 makes the Mbps division inf/NaN.
    let (id, mut cap) = sample();
    cap.net_rx_mbps = f64::NAN;
    cap.net_tx_mbps = f64::INFINITY;
    let v: Value = serde_json::from_slice(&heartbeat_payload(&id, &cap)).unwrap();
    assert_eq!(v["net_rx_mbps"], 0.0);
    assert_eq!(v["net_tx_mbps"], 0.0);
}

#[test]
fn heartbeat_subject_is_scoped_to_the_payload_node_id() {
    let (id, cap) = sample();
    let v: Value = serde_json::from_slice(&heartbeat_payload(&id, &cap)).unwrap();
    let subject = heartbeat_subject(&id.node_id);
    assert_eq!(subject, "media.heartbeat.node-a");
    // identity-node rejects a scoped heartbeat whose payload node_id differs
    // from the subject suffix.
    assert_eq!(subject.strip_prefix("media.heartbeat.").unwrap(), v["node_id"].as_str().unwrap());
}
