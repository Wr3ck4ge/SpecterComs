//! `specter.cmd.>` subject parsing, and the node-scoped publish subjects.

use media_sfu::nats::{
    parse_command, session_end_subject, heartbeat_subject, inbox_prefix, Command,
};

#[test]
fn parses_every_verb() {
    assert_eq!(parse_command("specter.cmd.kick.u1"), Some(Command::Kick { user_id: "u1" }));
    assert_eq!(parse_command("specter.cmd.drain_org.org-9"), Some(Command::DrainOrg { org_id: "org-9" }));
    assert_eq!(parse_command("specter.cmd.mute.u1"), Some(Command::Mute { user_id: "u1" }));
    assert_eq!(parse_command("specter.cmd.unmute.u1"), Some(Command::Unmute { user_id: "u1" }));
    assert_eq!(
        parse_command("specter.cmd.move.u1.chan-2"),
        Some(Command::Move { user_id: "u1", channel_id: "chan-2" })
    );
}

#[test]
fn unhandled_and_incomplete_commands() {
    // Relays publish duck themselves and also receive it on specter.cmd.>.
    assert_eq!(parse_command("specter.cmd.duck.c1"), Some(Command::Unhandled { verb: "duck" }));
    assert_eq!(parse_command("specter.cmd.move.u1"), Some(Command::Unhandled { verb: "move" }));
    assert_eq!(parse_command("specter.cmd.whatever.x"), Some(Command::Unhandled { verb: "whatever" }));
    // Extra tokens are ignored, as before.
    assert_eq!(parse_command("specter.cmd.kick.u1.extra.more"), Some(Command::Kick { user_id: "u1" }));
}

#[test]
fn malformed_subjects_are_rejected() {
    for s in [
        "", ".", "specter", "specter.cmd", "specter.cmd.", "specter.cmd.kick", "specter.cmd.kick.",
        "specter.cmd..u1", "specter.cmd.move.u1.", "other.cmd.kick.u1", "specter.usage.kick.u1",
        "SPECTER.cmd.kick.u1", "specter.cmd.drain_org.",
    ] {
        let parsed = parse_command(s);
        assert!(
            parsed.is_none() || matches!(parsed, Some(Command::Unhandled { .. })),
            "{s:?} parsed as {parsed:?}"
        );
    }
    assert_eq!(parse_command("specter.cmd.kick."), None);
    assert_eq!(parse_command("specter.cmd..u1"), None);
}

#[test]
fn arbitrary_input_never_panics() {
    // Deterministic pseudo-random subjects over an alphabet heavy in '.',
    // multi-byte UTF-8 and NATS wildcards.
    let alphabet: Vec<char> = "specter.cmd.kick.drain_org.move..*>\u{0}é漢🦀 \t".chars().collect();
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    for _ in 0..20_000 {
        x ^= x << 13; x ^= x >> 7; x ^= x << 17;
        let len = (x % 40) as usize;
        let mut s = String::from(if x & 1 == 0 { "specter.cmd." } else { "" });
        let mut y = x;
        for _ in 0..len {
            y = y.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            s.push(alphabet[(y >> 33) as usize % alphabet.len()]);
        }
        let _ = parse_command(&s);
    }
}

#[test]
fn publish_subjects_are_node_scoped() {
    assert_eq!(heartbeat_subject("node-b"), "media.heartbeat.node-b");
    assert_eq!(session_end_subject("node-b"), "specter.usage.session_end.node-b");
    assert_eq!(inbox_prefix("node-b"), "_INBOX.node-b");
}
