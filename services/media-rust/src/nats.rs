//! NATS: subjects, command parsing, usage payloads and connecting.
//!
//! Every subject this relay touches is defined here, so NATS permissions for
//! a per-node user can be derived from this one file:
//!
//! | dir | subject | notes |
//! |-----|---------|-------|
//! | pub | `media.heartbeat.<node_id>` | capacity heartbeat ([`heartbeat_subject`]) |
//! | pub | `specter.usage.session_start` | voice join (unscoped, unchanged) |
//! | pub | `specter.usage.session_end.<node_id>` | voice + video-subscribe end ([`session_end_subject`]) |
//! | pub | `specter.cmd.duck.<channel_id>` | priority-speaker duck ([`duck_subject`]) |
//! | pub | `specter.event.tree.request` | startup backfill request (request/reply) |
//! | pub | `specter.diag.netprobe.<node_id>` | netprobe armed / report (src/netdiag.rs) |
//! | sub | `specter.cmd.>` | kick / mute / unmute / move / drain_org (+ duck, ignored) |
//! | sub | `specter.cmd.netprobe.arm` | netprobe arm (own subscription in src/netdiag.rs) |
//! | sub | `specter.event.tree.>` | live event-tree updates |
//! | sub | `<inbox_prefix(node_id)>.>` | replies to the backfill request |

use serde::Serialize;

use crate::config::NatsAuth;

pub const CMD_SUBSCRIPTION: &str = "specter.cmd.>";
pub const EVENT_TREE_SUBSCRIPTION: &str = "specter.event.tree.>";
pub const EVENT_TREE_REQUEST_SUBJECT: &str = "specter.event.tree.request";
pub const SESSION_START_SUBJECT: &str = "specter.usage.session_start";

/// `media.heartbeat.<node_id>`. identity-node takes the node id from the
/// subject suffix and rejects a payload whose `node_id` disagrees, so a
/// node's NATS user can be limited to publishing its own heartbeats.
pub fn heartbeat_subject(node_id: &str) -> String {
    format!("media.heartbeat.{}", node_id)
}

/// `specter.usage.session_end.<node_id>` — same scoping as the heartbeat.
pub fn session_end_subject(node_id: &str) -> String {
    format!("specter.usage.session_end.{}", node_id)
}

pub fn duck_subject(channel_id: &str) -> String {
    format!("specter.cmd.duck.{}", channel_id)
}

/// Request/reply inbox prefix. Per node (instead of the shared `_INBOX`) so
/// a node's NATS user can be allowed to subscribe to only its own replies.
pub fn inbox_prefix(node_id: &str) -> String {
    format!("_INBOX.{}", node_id)
}

/// A command received on `specter.cmd.>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command<'a> {
    Kick { user_id: &'a str },
    DrainOrg { org_id: &'a str },
    Mute { user_id: &'a str },
    Unmute { user_id: &'a str },
    Move { user_id: &'a str, channel_id: &'a str },
    /// A well-formed `specter.cmd.<verb>.<target>…` this relay doesn't act on
    /// (e.g. `duck`, which relays publish themselves, or `move` without a
    /// destination channel).
    Unhandled { verb: &'a str },
}

/// Parse a `specter.cmd.<verb>.<target>[.<arg>]` subject. Returns None for
/// anything that isn't one (wrong prefix, too few tokens, empty tokens).
/// Never panics, whatever the input. Tokens past those a verb uses are
/// ignored, as before.
pub fn parse_command(subject: &str) -> Option<Command<'_>> {
    let mut parts = subject.split('.');
    if parts.next() != Some("specter") || parts.next() != Some("cmd") {
        return None;
    }
    let verb = parts.next().filter(|s| !s.is_empty())?;
    let target = parts.next().filter(|s| !s.is_empty())?;
    let arg = parts.next().filter(|s| !s.is_empty());
    Some(match verb {
        "kick" => Command::Kick { user_id: target },
        "drain_org" => Command::DrainOrg { org_id: target },
        "mute" => Command::Mute { user_id: target },
        "unmute" => Command::Unmute { user_id: target },
        "move" => match arg {
            Some(channel_id) => Command::Move { user_id: target, channel_id },
            None => Command::Unhandled { verb },
        },
        other => Command::Unhandled { verb: other },
    })
}

#[derive(Serialize)]
pub struct SessionStart<'a> {
    pub org_id: &'a str,
    pub user_id: &'a str,
    pub channel_id: &'a str,
    pub node_id: &'a str,
}

#[derive(Serialize)]
pub struct SessionEnd<'a> {
    pub org_id: &'a str,
    pub user_id: &'a str,
    pub channel_id: &'a str,
    pub duration_secs: u64,
    pub bytes_out: u64,
    /// Voice only: replaced by a newer session for the same user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded: Option<bool>,
    /// Must equal the subject suffix of `session_end_subject`.
    pub node_id: &'a str,
}

pub fn to_payload<T: Serialize>(v: &T) -> bytes::Bytes {
    bytes::Bytes::from(serde_json::to_vec(v).expect("usage payload serialization"))
}

/// Connect with the configured credential. The custom inbox prefix applies
/// to every auth mode (harmless with the shared token, needed for per-node
/// permissions).
pub async fn connect(url: &str, auth: &NatsAuth, node_id: &str) -> anyhow::Result<async_nats::Client> {
    let opts = match auth {
        NatsAuth::CredsFile(path) => async_nats::ConnectOptions::with_credentials_file(path)
            .await
            .map_err(|e| anyhow::anyhow!("cannot read NATS_CREDS file {}: {}", path, e))?,
        NatsAuth::UserPassword { user, password } => {
            async_nats::ConnectOptions::with_user_and_password(user.clone(), password.clone())
        }
        NatsAuth::Token(token) => async_nats::ConnectOptions::with_token(token.clone()),
        NatsAuth::None => async_nats::ConnectOptions::new(),
    };
    let client = opts
        .name(format!("media-sfu/{}", node_id))
        .custom_inbox_prefix(inbox_prefix(node_id))
        .connect(url)
        .await?;
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subjects_are_scoped_to_the_node() {
        assert_eq!(heartbeat_subject("node-a"), "media.heartbeat.node-a");
        assert_eq!(session_end_subject("node-a"), "specter.usage.session_end.node-a");
        assert_eq!(inbox_prefix("node-a"), "_INBOX.node-a");
        assert_eq!(duck_subject("c1"), "specter.cmd.duck.c1");
    }

    #[test]
    fn session_end_payloads() {
        let voice = SessionEnd { org_id: "o", user_id: "u", channel_id: "c", duration_secs: 3, bytes_out: 9, superseded: Some(false), node_id: "node-a" };
        let v: serde_json::Value = serde_json::from_slice(&to_payload(&voice)).unwrap();
        assert_eq!(v, serde_json::json!({"org_id":"o","user_id":"u","channel_id":"c","duration_secs":3,"bytes_out":9,"superseded":false,"node_id":"node-a"}));
        let video = SessionEnd { superseded: None, ..voice };
        let v: serde_json::Value = serde_json::from_slice(&to_payload(&video)).unwrap();
        assert!(v.get("superseded").is_none());
        let odd = SessionStart { org_id: "o\"}", user_id: "u\\", channel_id: "c", node_id: "n" };
        let v: serde_json::Value = serde_json::from_slice(&to_payload(&odd)).unwrap();
        assert_eq!(v["org_id"], "o\"}");
    }
}
