//! Boot-time configuration: node identity, NATS credentials and the heartbeat
//! interval. Everything here is pure (takes the raw env values as arguments)
//! so it can be unit-tested; `from_env` helpers do the actual `env::var`
//! reads. Every env var the relay reads should be read with a literal
//! `env::var("NAME")` somewhere under `src/` — identity-node's cloud-init
//! test greps for that pattern to check each one is set or knowingly optional.

use std::env;
use std::fmt;
use std::time::Duration;

/// What an unset NODE_ID falls back to. This is prod node-1's id, so the
/// fallback exists ONLY so node-1 keeps booting until its compose sets
/// NODE_ID explicitly — any other relay left on it collides with prod in
/// identity-node's media_nodes registry (see the multi-node eval, H5).
pub const LEGACY_DEFAULT_NODE_ID: &str = "node-1";

/// Heartbeat cadence when HEARTBEAT_INTERVAL_MS is unset (today's value).
pub const DEFAULT_HEARTBEAT_INTERVAL_MS: u64 = 5_000;
/// Bounds for HEARTBEAT_INTERVAL_MS. identity-node treats a node as gone
/// after ~15 s without a heartbeat, so much above that the node flaps.
pub const MIN_HEARTBEAT_INTERVAL_MS: u64 = 500;
pub const MAX_HEARTBEAT_INTERVAL_MS: u64 = 60_000;

/// `^[a-z0-9-]{1,32}$` — the same rule identity-node applies when it
/// provisions a node. The id goes into NATS subjects (`media.heartbeat.<id>`)
/// and per-node NATS permissions, so `.`, `*`, `>` and whitespace must never
/// reach it.
/// WEBTRANSPORT_ALT_PORT: an optional second UDP port the relay also accepts
/// WebTransport on (same cert, same handlers), for networks that block UDP
/// 443 / QUIC on 443 only. Unset, empty, unparsable, 0 or equal to the main
/// port = off (today's behaviour).
pub fn parse_alt_port(raw: Option<&str>, main_port: u16) -> Option<u16> {
    let p: u16 = raw?.trim().parse().ok()?;
    if p == 0 || p == main_port { None } else { Some(p) }
}

pub fn is_valid_node_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedNodeId {
    pub id: String,
    /// True when NODE_ID was unset and the legacy default was used.
    pub legacy_default: bool,
}

/// `raw`: NODE_ID as read from the environment (None = unset).
/// `multi_node`: true when this relay runs with a per-node NATS identity
/// (NATS_USER or NATS_CREDS) — those deployments must name themselves.
///
/// The single compatibility exception: unset NODE_ID outside multi-node mode
/// keeps today's `node-1` default (the caller logs a loud warning). A value
/// that is set but empty or malformed is always an error.
pub fn resolve_node_id(raw: Option<&str>, multi_node: bool) -> Result<ResolvedNodeId, String> {
    match raw {
        None if multi_node => Err(
            "NODE_ID is not set, but a per-node NATS identity (NATS_USER / NATS_CREDS) is configured. \
             Every node in a multi-node deployment needs its own NODE_ID (^[a-z0-9-]{1,32}$)."
                .to_string(),
        ),
        None => Ok(ResolvedNodeId { id: LEGACY_DEFAULT_NODE_ID.to_string(), legacy_default: true }),
        Some(id) if is_valid_node_id(id) => Ok(ResolvedNodeId { id: id.to_string(), legacy_default: false }),
        Some(id) => Err(format!(
            "NODE_ID {:?} is invalid: it must match ^[a-z0-9-]{{1,32}}$ (lowercase letters, digits and '-').",
            id
        )),
    }
}

/// Parse HEARTBEAT_INTERVAL_MS. Unset or empty = the default; anything else
/// must be an integer in [MIN, MAX] — a typo is a startup error rather than
/// a silently different cadence.
pub fn parse_heartbeat_interval(raw: Option<&str>) -> Result<Duration, String> {
    let raw = match raw.map(str::trim) {
        None | Some("") => return Ok(Duration::from_millis(DEFAULT_HEARTBEAT_INTERVAL_MS)),
        Some(s) => s,
    };
    match raw.parse::<u64>() {
        Ok(ms) if (MIN_HEARTBEAT_INTERVAL_MS..=MAX_HEARTBEAT_INTERVAL_MS).contains(&ms) => {
            Ok(Duration::from_millis(ms))
        }
        _ => Err(format!(
            "HEARTBEAT_INTERVAL_MS {:?} is invalid: expected an integer number of milliseconds between {} and {}.",
            raw, MIN_HEARTBEAT_INTERVAL_MS, MAX_HEARTBEAT_INTERVAL_MS
        )),
    }
}

/// How this relay authenticates to NATS.
#[derive(Clone, PartialEq, Eq)]
pub enum NatsAuth {
    /// NATS_CREDS: path to a `.creds` file (user JWT + nkey seed).
    CredsFile(String),
    /// NATS_USER + NATS_PASSWORD.
    UserPassword { user: String, password: String },
    /// Legacy shared NATS_AUTH_TOKEN (one token for every node).
    Token(String),
    /// No credentials (loopback-only NATS).
    None,
}

impl NatsAuth {
    /// True for the per-node identities (anything but the shared token / none).
    pub fn is_per_node(&self) -> bool {
        matches!(self, NatsAuth::CredsFile(_) | NatsAuth::UserPassword { .. })
    }

    pub fn describe(&self) -> String {
        match self {
            NatsAuth::CredsFile(p) => format!("creds file {}", p),
            NatsAuth::UserPassword { user, .. } => format!("user '{}'", user),
            NatsAuth::Token(_) => "shared NATS_AUTH_TOKEN (legacy)".to_string(),
            NatsAuth::None => "no credentials".to_string(),
        }
    }
}

/// Never prints a secret.
impl fmt::Debug for NatsAuth {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NatsAuth::CredsFile(p) => write!(f, "CredsFile({:?})", p),
            NatsAuth::UserPassword { user, .. } => write!(f, "UserPassword {{ user: {:?}, password: <redacted> }}", user),
            NatsAuth::Token(_) => write!(f, "Token(<redacted>)"),
            NatsAuth::None => write!(f, "None"),
        }
    }
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.is_empty())
}

/// Pick the NATS credential. Empty values count as unset (compose writes
/// `${VAR:-}` as an empty string). Precedence: NATS_CREDS, then
/// NATS_USER + NATS_PASSWORD, then the legacy NATS_AUTH_TOKEN. A half-set
/// user/password pair, or a creds file together with a user, is an error —
/// guessing which one was meant would hide the misconfiguration.
pub fn resolve_nats_auth(
    creds: Option<String>,
    user: Option<String>,
    password: Option<String>,
    token: Option<String>,
) -> Result<NatsAuth, String> {
    let (creds, user, password, token) = (non_empty(creds), non_empty(user), non_empty(password), non_empty(token));
    match (creds, user, password) {
        (Some(_), Some(_), _) | (Some(_), _, Some(_)) => Err(
            "Both NATS_CREDS and NATS_USER/NATS_PASSWORD are set — configure exactly one per-node NATS identity.".to_string(),
        ),
        (Some(path), None, None) => Ok(NatsAuth::CredsFile(path)),
        (None, Some(user), Some(password)) => Ok(NatsAuth::UserPassword { user, password }),
        (None, Some(_), None) => Err("NATS_USER is set but NATS_PASSWORD is not.".to_string()),
        (None, None, Some(_)) => Err("NATS_PASSWORD is set but NATS_USER is not.".to_string()),
        (None, None, None) => Ok(token.map(NatsAuth::Token).unwrap_or(NatsAuth::None)),
    }
}

/// Read an env var: `None` when unset, `Some("")`-like garbage kept as-is so
/// validation can reject it. A non-UTF-8 value becomes an empty string, which
/// every validator here rejects.
pub fn read_env(value: Result<String, env::VarError>) -> Option<String> {
    match value {
        Ok(s) => Some(s),
        Err(env::VarError::NotPresent) => None,
        Err(env::VarError::NotUnicode(_)) => Some(String::new()),
    }
}

/// Everything about this node's identity that boot needs, read from the env.
pub struct NodeConfig {
    pub node_id: ResolvedNodeId,
    pub region: String,
    pub nats_url: String,
    pub nats_auth: NatsAuth,
    pub heartbeat_interval: Duration,
}

pub const DEFAULT_NATS_URL: &str = "nats://localhost:4222";

impl NodeConfig {
    pub fn from_env() -> Result<Self, String> {
        let nats_auth = resolve_nats_auth(
            read_env(env::var("NATS_CREDS")),
            read_env(env::var("NATS_USER")),
            read_env(env::var("NATS_PASSWORD")),
            read_env(env::var("NATS_AUTH_TOKEN")),
        )?;
        let node_id = resolve_node_id(read_env(env::var("NODE_ID")).as_deref(), nats_auth.is_per_node())?;
        let heartbeat_interval = parse_heartbeat_interval(read_env(env::var("HEARTBEAT_INTERVAL_MS")).as_deref())?;
        Ok(NodeConfig {
            node_id,
            region: env::var("REGION").unwrap_or_else(|_| "default".to_string()),
            nats_url: env::var("NATS_URL").unwrap_or_else(|_| DEFAULT_NATS_URL.to_string()),
            nats_auth,
            heartbeat_interval,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_id_rules() {
        let (max, too_long) = ("x".repeat(32), "x".repeat(33));
        for ok in ["node-1", "node-1-green", "a", "0", "n-a-b-c", max.as_str()] {
            assert!(is_valid_node_id(ok), "{ok:?} should be valid");
        }
        for bad in ["", "Node-1", "node_1", "node.1", "node 1", "node-*", "node->", too_long.as_str(), "nöde", "node-1\n"] {
            assert!(!is_valid_node_id(bad), "{bad:?} should be invalid");
        }
    }

    #[test]
    fn unset_node_id_keeps_the_legacy_default_only_outside_multi_node_mode() {
        assert_eq!(
            resolve_node_id(None, false).unwrap(),
            ResolvedNodeId { id: "node-1".into(), legacy_default: true }
        );
        assert!(resolve_node_id(None, true).is_err());
    }

    #[test]
    fn set_node_id_must_be_valid_in_every_mode() {
        for multi in [false, true] {
            assert_eq!(
                resolve_node_id(Some("node-a"), multi).unwrap(),
                ResolvedNodeId { id: "node-a".into(), legacy_default: false }
            );
            // Empty is "set", not "unset": an empty compose value must not
            // silently become node-1 and collide with prod (eval M3).
            assert!(resolve_node_id(Some(""), multi).is_err());
            assert!(resolve_node_id(Some("NODE-A"), multi).is_err());
            assert!(resolve_node_id(Some("node.a"), multi).is_err());
        }
    }

    #[test]
    fn heartbeat_interval() {
        assert_eq!(parse_heartbeat_interval(None).unwrap(), Duration::from_millis(5000));
        assert_eq!(parse_heartbeat_interval(Some("")).unwrap(), Duration::from_millis(5000));
        assert_eq!(parse_heartbeat_interval(Some("2000")).unwrap(), Duration::from_millis(2000));
        assert_eq!(parse_heartbeat_interval(Some(" 500 ")).unwrap(), Duration::from_millis(500));
        assert_eq!(parse_heartbeat_interval(Some("60000")).unwrap(), Duration::from_millis(60000));
        for bad in ["499", "60001", "0", "-1", "5s", "5000ms", "abc", "1e3"] {
            assert!(parse_heartbeat_interval(Some(bad)).is_err(), "{bad:?}");
        }
    }

    fn s(v: &str) -> Option<String> { Some(v.to_string()) }

    #[test]
    fn nats_auth_precedence_and_errors() {
        assert_eq!(resolve_nats_auth(None, None, None, None).unwrap(), NatsAuth::None);
        assert_eq!(resolve_nats_auth(s(""), s(""), s(""), s("")).unwrap(), NatsAuth::None);
        assert_eq!(resolve_nats_auth(None, None, None, s("tok")).unwrap(), NatsAuth::Token("tok".into()));
        assert_eq!(
            resolve_nats_auth(None, s("node-a"), s("pw"), s("tok")).unwrap(),
            NatsAuth::UserPassword { user: "node-a".into(), password: "pw".into() }
        );
        assert_eq!(resolve_nats_auth(s("/c.creds"), None, None, s("tok")).unwrap(), NatsAuth::CredsFile("/c.creds".into()));
        assert!(resolve_nats_auth(None, s("node-a"), None, None).is_err());
        assert!(resolve_nats_auth(None, None, s("pw"), None).is_err());
        assert!(resolve_nats_auth(s("/c.creds"), s("node-a"), s("pw"), None).is_err());
        assert!(NatsAuth::CredsFile("x".into()).is_per_node());
        assert!(NatsAuth::UserPassword { user: "u".into(), password: "p".into() }.is_per_node());
        assert!(!NatsAuth::Token("t".into()).is_per_node());
        assert!(!NatsAuth::None.is_per_node());
    }

    #[test]
    fn nats_auth_debug_never_prints_secrets() {
        let up = format!("{:?}", NatsAuth::UserPassword { user: "node-a".into(), password: "hunter2".into() });
        let tok = format!("{:?}", NatsAuth::Token("s3cret-token".into()));
        assert!(!up.contains("hunter2") && up.contains("node-a"));
        assert!(!tok.contains("s3cret-token"));
        assert!(!NatsAuth::UserPassword { user: "u".into(), password: "hunter2".into() }.describe().contains("hunter2"));
    }
}
