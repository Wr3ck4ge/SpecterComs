//! NODE_ID validation and NATS credential selection at boot.

use media_sfu::config::{
    is_valid_node_id, parse_heartbeat_interval, resolve_nats_auth, resolve_node_id, NatsAuth,
    LEGACY_DEFAULT_NODE_ID,
};
use std::time::Duration;

#[test]
fn prod_node_1_keeps_booting_with_no_node_id() {
    // Legacy shared token or no NATS creds + no NODE_ID = today's prod node-1.
    let r = resolve_node_id(None, false).unwrap();
    assert_eq!(r.id, LEGACY_DEFAULT_NODE_ID);
    assert!(r.legacy_default);
}

#[test]
fn multi_node_mode_requires_node_id() {
    let auth = resolve_nats_auth(None, Some("node-a".into()), Some("pw".into()), None).unwrap();
    assert!(auth.is_per_node());
    assert!(resolve_node_id(None, auth.is_per_node()).is_err());
    assert_eq!(resolve_node_id(Some("node-a"), true).unwrap().id, "node-a");
}

#[test]
fn node_id_pattern() {
    assert!(is_valid_node_id("node-1-green"));
    assert!(is_valid_node_id("abcdefghijklmnopqrstuvwxyz012345")); // 32
    assert!(!is_valid_node_id("abcdefghijklmnopqrstuvwxyz0123456")); // 33
    for bad in ["", "node.a", "node*", "node>", "Node", "node_a", " node", "node a"] {
        assert!(!is_valid_node_id(bad), "{bad:?}");
        assert!(resolve_node_id(Some(bad), false).is_err(), "{bad:?}");
    }
}

#[test]
fn nats_credential_fallback_order() {
    assert_eq!(resolve_nats_auth(None, None, None, Some("t".into())).unwrap(), NatsAuth::Token("t".into()));
    assert!(matches!(
        resolve_nats_auth(None, Some("u".into()), Some("p".into()), Some("t".into())).unwrap(),
        NatsAuth::UserPassword { .. }
    ));
    assert!(matches!(
        resolve_nats_auth(Some("/run/secrets/node.creds".into()), None, None, Some("t".into())).unwrap(),
        NatsAuth::CredsFile(_)
    ));
}

#[test]
fn heartbeat_interval_default_is_unchanged() {
    assert_eq!(parse_heartbeat_interval(None).unwrap(), Duration::from_secs(5));
    assert!(parse_heartbeat_interval(Some("fast")).is_err());
}

#[test]
fn alt_webtransport_port_is_off_unless_a_distinct_valid_port() {
    use media_sfu::config::parse_alt_port;
    assert_eq!(parse_alt_port(None, 443), None);
    assert_eq!(parse_alt_port(Some(""), 443), None);
    assert_eq!(parse_alt_port(Some("abc"), 443), None);
    assert_eq!(parse_alt_port(Some("0"), 443), None);
    assert_eq!(parse_alt_port(Some("443"), 443), None);
    assert_eq!(parse_alt_port(Some("70000"), 443), None);
    assert_eq!(parse_alt_port(Some(" 3478 "), 443), Some(3478));
}
