//! Relay-mode voice frame protection, wire version 3.
//!
//! ## v3 (E2EV): sender timestamp — replay after a receiver restart
//! v2's replay window lives in receiver memory. A receiver that restarts (app
//! restart, reconnect, monitor re-mount) while the MLS epoch is unchanged
//! starts with empty windows, so the relay (media-rust, or anyone on its
//! path) could replay frames it recorded earlier in the epoch and they would
//! authenticate and play.
//!
//! v3 adds the sender's wall-clock time (ms since the Unix epoch, big-endian
//! u64) to the header, so it is covered by the AEAD via the AAD. Receivers
//! reject an authentic frame whose timestamp is more than [`MAX_SKEW_MS`]
//! away from their own clock (`stale-timestamp`), *in addition to* the replay
//! window. After a restart the relay can therefore replay at most the last
//! `MAX_SKEW_MS` of recorded traffic (audio it was just delivering live
//! anyway), instead of anything from the whole epoch; with the window intact
//! (no restart) nothing replays at all. The sender clamps its timestamps to
//! be non-decreasing within a session, so a backwards wall-clock step (NTP)
//! never makes the header go backwards. The nonce is still the per-session
//! counter — the timestamp is authenticated metadata, not nonce material.
//! The KDF labels moved to `.../v3`, so v2 and v3 keys never coincide, and
//! every non-0x03 first byte (v1 bare ciphertext, v2) is rejected as
//! `unsupported-version`: relay mode was never enabled on any production
//! channel, so there is no v2 traffic to stay compatible with, and the server
//! refuses relay rooms to pre-2.0.0 clients (see identity-node
//! MIN_RELAY_CLIENT_VERSION).
//!
//! v3 payload: `0x03 || session_id(16) || seq_be64(8) || ts_ms_be64(8) || ct || tag(16)`,
//! AAD = `header(33) || ssrc_be32 || lane(1)`.
//!
//! (Notes below describe the v2 design that v3 extends unchanged.)
//!
//! ## Why v1 was replaced
//! v1 (`SFrameCrypto::encrypt_framed`) used the MLS group export directly as
//! the ChaCha20-Poly1305 key and derived the nonce from `(ssrc, sequence)`.
//! ssrc is fixed per user and the JS sequence counter restarted at 0 on every
//! CommLink mount, while the key only changes on an MLS epoch change — so a
//! reconnect, app restart, second device of the same user, or (for the
//! event-wide cascade key) a frequency switch re-used (key, nonce) pairs.
//! For ChaCha20-Poly1305 that leaks the XOR of plaintexts and the one-time
//! Poly1305 key, enabling forgeries.
//!
//! ## v2 construction
//! * Every sending session (one [`SenderCore`]) draws a fresh random 128-bit
//!   `session_id` and derives its own key:
//!   `PRK = HKDF-Extract(salt = "specter/relay-audio/v2", IKM = group_secret)`
//!   `session_key = HKDF-Expand(PRK, "specter/relay-audio/v2/session-key" || lane || session_id, 32)`
//!   where `lane` is 0x00 for the channel ('audio' export) and 0x01 for the
//!   event cascade ('audio-cascade' export, `is_global_broadcast`).
//! * The nonce is `0x00000000 || seq_be64`, with `seq` a 64-bit counter owned
//!   by the sender object itself (callers cannot supply or reset it). It never
//!   wraps: sealing refuses once the counter is exhausted.
//! * A (key, nonce) pair therefore repeats only if two sessions draw the same
//!   128-bit id under the same group secret and lane (birthday bound
//!   ~n²/2¹²⁹) — independent of reconnects, restarts, devices or persisted
//!   state.
//! * Wire payload (the AudioFrame's `encrypted_payload`):
//!   `version(1)=0x02 || session_id(16) || seq_be64(8) || ciphertext || tag(16)`.
//!   The header lives inside the payload (not new proto fields) because
//!   media-rust decodes and re-encodes relay frames with prost, which drops
//!   unknown fields — an in-payload header passes through byte-for-byte with
//!   no server change.
//! * AAD = `header(25) || ssrc_be32 || lane(1)`. ssrc is the value the
//!   receiver sees, i.e. media-rust's `canonical_ssrc(authenticated user_id)`,
//!   which equals the client's own `hashUserId` — so frames can't be moved to
//!   another sender's lane, between channel/cascade lanes, or between sessions.
//! * Receivers keep a 128-frame sliding replay window per (ssrc, session_id),
//!   updated only after the AEAD tag verified. Per-receiver state is bounded
//!   (sessions per ssrc and in total, LRU-evicted); an evicted session's
//!   high-water mark is remembered (bounded) so its old frames stay rejected
//!   if it is later re-admitted.

use std::collections::{HashMap, VecDeque};

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Key, Nonce,
};
use getrandom::getrandom;
use hkdf::Hkdf;
use sha2::Sha256;

pub const VERSION: u8 = 0x03;
pub const SESSION_ID_LEN: usize = 16;
const SEQ_OFFSET: usize = 1 + SESSION_ID_LEN;
const TS_OFFSET: usize = SEQ_OFFSET + 8;
pub const HEADER_LEN: usize = TS_OFFSET + 8;
pub const TAG_LEN: usize = 16;
pub const GROUP_SECRET_LEN: usize = 32;

/// Max |sender timestamp − receiver clock| for an authentic frame to be
/// accepted. Bounds replay after a receiver restart (see module docs); must
/// comfortably exceed real clock skew between members' machines (Windows
/// syncs to time.windows.com; minutes-off clocks will hear nothing and see
/// `stale-timestamp` drops).
pub const MAX_SKEW_MS: u64 = 30_000;

const KDF_SALT: &[u8] = b"specter/relay-audio/v3";
const KDF_INFO_PREFIX: &[u8] = b"specter/relay-audio/v3/session-key";
const KDF_FINGERPRINT_INFO: &[u8] = b"specter/relay-audio/v3/secret-fingerprint";

/// Replay window width in frames (bitmap in a u128). At 50 frames/s this
/// tolerates ~2.5s of reordering, far beyond what the jitter path keeps.
pub const REPLAY_WINDOW: u64 = 128;
/// Max concurrently tracked sessions for one ssrc (devices + reconnects of one
/// user within one key epoch).
pub const MAX_SESSIONS_PER_SSRC: usize = 8;
/// Max tracked sessions per receiver overall.
pub const MAX_SESSIONS_TOTAL: usize = 256;
/// Max remembered high-water marks of evicted sessions.
pub const MAX_RETIRED: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayError {
    BadSecret,
    Rng,
    SequenceExhausted,
    Malformed,
    UnsupportedVersion,
    Replay,
    AuthFailed,
    /// Authentic frame whose sender timestamp is outside ±MAX_SKEW_MS.
    StaleTimestamp,
}

impl RelayError {
    /// Stable, machine-matchable code — voiceRelayAudio.js keys drop reasons
    /// off these strings.
    pub fn code(self) -> &'static str {
        match self {
            RelayError::BadSecret => "bad-secret",
            RelayError::Rng => "rng-failed",
            RelayError::SequenceExhausted => "sequence-exhausted",
            RelayError::Malformed => "malformed",
            RelayError::UnsupportedVersion => "unsupported-version",
            RelayError::Replay => "replay",
            RelayError::AuthFailed => "auth-failed",
            RelayError::StaleTimestamp => "stale-timestamp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Channel = 0,
    Cascade = 1,
}

impl Lane {
    pub fn from_global_broadcast(is_global_broadcast: bool) -> Lane {
        if is_global_broadcast { Lane::Cascade } else { Lane::Channel }
    }
}

/// HKDF-Extract of the group secret, plus a fingerprint used to tell whether a
/// re-exported secret is the one this object already holds (so a same-epoch
/// key refresh can keep the existing sender session / replay windows).
struct GroupKdf {
    hk: Hkdf<Sha256>,
    fingerprint: [u8; 32],
}

impl GroupKdf {
    fn new(group_secret: &[u8]) -> Result<Self, RelayError> {
        if group_secret.len() != GROUP_SECRET_LEN {
            return Err(RelayError::BadSecret);
        }
        let hk = Hkdf::<Sha256>::new(Some(KDF_SALT), group_secret);
        let mut fingerprint = [0u8; 32];
        hk.expand(KDF_FINGERPRINT_INFO, &mut fingerprint)
            .map_err(|_| RelayError::BadSecret)?;
        Ok(GroupKdf { hk, fingerprint })
    }

    fn session_cipher(&self, lane: Lane, session_id: &[u8; SESSION_ID_LEN]) -> ChaCha20Poly1305 {
        let mut info = Vec::with_capacity(KDF_INFO_PREFIX.len() + 1 + SESSION_ID_LEN);
        info.extend_from_slice(KDF_INFO_PREFIX);
        info.push(lane as u8);
        info.extend_from_slice(session_id);
        let mut okm = [0u8; 32];
        // 32 bytes is far below HKDF-SHA256's 255*32 limit; cannot fail.
        self.hk.expand(&info, &mut okm).expect("HKDF expand of 32 bytes");
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&okm));
        okm.fill(0);
        cipher
    }

    fn matches(&self, group_secret: &[u8]) -> bool {
        match GroupKdf::new(group_secret) {
            Ok(other) => ct_eq(&self.fingerprint, &other.fingerprint),
            Err(_) => false,
        }
    }
}

fn ct_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn nonce_for(seq: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..12].copy_from_slice(&seq.to_be_bytes());
    n
}

fn header_for(session_id: &[u8; SESSION_ID_LEN], seq: u64, ts_ms: u64) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[0] = VERSION;
    h[1..SEQ_OFFSET].copy_from_slice(session_id);
    h[SEQ_OFFSET..TS_OFFSET].copy_from_slice(&seq.to_be_bytes());
    h[TS_OFFSET..HEADER_LEN].copy_from_slice(&ts_ms.to_be_bytes());
    h
}

/// Converts a JS `Date.now()`-style f64 to whole ms (NaN/negative → 0).
pub fn ms_from_f64(now_ms: f64) -> u64 {
    if now_ms.is_finite() && now_ms > 0.0 { now_ms as u64 } else { 0 }
}

fn within_skew(ts_ms: u64, now_ms: u64) -> bool {
    ts_ms.abs_diff(now_ms) <= MAX_SKEW_MS
}

fn aad_for(header: &[u8], ssrc: u32, lane: Lane) -> Vec<u8> {
    let mut aad = Vec::with_capacity(HEADER_LEN + 5);
    aad.extend_from_slice(header);
    aad.extend_from_slice(&ssrc.to_be_bytes());
    aad.push(lane as u8);
    aad
}

/// Parsed (not yet authenticated) v3 header.
pub struct ParsedHeader<'a> {
    pub session_id: [u8; SESSION_ID_LEN],
    pub seq: u64,
    pub ts_ms: u64,
    pub header: &'a [u8],
    pub body: &'a [u8],
}

pub fn parse(frame: &[u8]) -> Result<ParsedHeader<'_>, RelayError> {
    if frame.is_empty() {
        return Err(RelayError::Malformed);
    }
    if frame[0] != VERSION {
        return Err(RelayError::UnsupportedVersion);
    }
    if frame.len() < HEADER_LEN + TAG_LEN {
        return Err(RelayError::Malformed);
    }
    let mut session_id = [0u8; SESSION_ID_LEN];
    session_id.copy_from_slice(&frame[1..SEQ_OFFSET]);
    let mut seq_bytes = [0u8; 8];
    seq_bytes.copy_from_slice(&frame[SEQ_OFFSET..TS_OFFSET]);
    let mut ts_bytes = [0u8; 8];
    ts_bytes.copy_from_slice(&frame[TS_OFFSET..HEADER_LEN]);
    Ok(ParsedHeader {
        session_id,
        seq: u64::from_be_bytes(seq_bytes),
        ts_ms: u64::from_be_bytes(ts_bytes),
        header: &frame[..HEADER_LEN],
        body: &frame[HEADER_LEN..],
    })
}

// ── Sender ───────────────────────────────────────────────────────────────────

pub struct SenderCore {
    kdf: GroupKdf,
    lane: Lane,
    session_id: [u8; SESSION_ID_LEN],
    cipher: ChaCha20Poly1305,
    next_seq: u64,
    /// Last timestamp written — headers never go backwards within a session.
    last_ts_ms: u64,
}

impl SenderCore {
    pub fn new(group_secret: &[u8], lane: Lane) -> Result<Self, RelayError> {
        let mut session_id = [0u8; SESSION_ID_LEN];
        getrandom(&mut session_id).map_err(|_| RelayError::Rng)?;
        Self::with_session_id(group_secret, lane, session_id)
    }

    /// Deterministic session id — only for tests (a caller-chosen id defeats
    /// the uniqueness argument).
    pub(crate) fn with_session_id(
        group_secret: &[u8],
        lane: Lane,
        session_id: [u8; SESSION_ID_LEN],
    ) -> Result<Self, RelayError> {
        let kdf = GroupKdf::new(group_secret)?;
        let cipher = kdf.session_cipher(lane, &session_id);
        Ok(SenderCore { kdf, lane, session_id, cipher, next_seq: 0, last_ts_ms: 0 })
    }

    /// Seals one frame stamped with `now_ms` (sender wall clock, ms since the
    /// Unix epoch), clamped to be non-decreasing within this session.
    pub fn seal(&mut self, payload: &[u8], ssrc: u32, now_ms: u64) -> Result<Vec<u8>, RelayError> {
        let seq = self.next_seq;
        // Never wraps: u64::MAX itself is never used, the counter is dead
        // after that (≈ 1.2e10 years of 20ms frames).
        if seq == u64::MAX {
            return Err(RelayError::SequenceExhausted);
        }
        // Consume the sequence number before encrypting so that even a
        // (theoretical) failure below can never lead to its reuse.
        self.next_seq = seq + 1;
        let ts_ms = now_ms.max(self.last_ts_ms);
        self.last_ts_ms = ts_ms;
        let header = header_for(&self.session_id, seq, ts_ms);
        let aad = aad_for(&header, ssrc, self.lane);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_for(seq)), Payload { msg: payload, aad: &aad })
            .map_err(|_| RelayError::AuthFailed)?;
        let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
        out.extend_from_slice(&header);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn session_id(&self) -> [u8; SESSION_ID_LEN] {
        self.session_id
    }

    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    pub fn lane(&self) -> Lane {
        self.lane
    }

    pub fn matches_secret(&self, group_secret: &[u8]) -> bool {
        self.kdf.matches(group_secret)
    }

    #[cfg(test)]
    pub(crate) fn force_next_seq(&mut self, seq: u64) {
        self.next_seq = seq;
    }
}

// ── Receiver ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Default)]
struct ReplayWindow {
    /// Highest authenticated sequence seen.
    highest: u64,
    /// Bit i set ⇔ (highest - i) was accepted.
    bitmap: u128,
}

impl ReplayWindow {
    fn fresh(seq: u64) -> Self {
        ReplayWindow { highest: seq, bitmap: 0 }
    }

    /// Window for a session re-admitted after eviction: everything at or
    /// below its last known high-water mark counts as already seen.
    fn resumed(highest: u64) -> Self {
        ReplayWindow { highest, bitmap: u128::MAX }
    }

    fn check(&self, seq: u64) -> Result<(), RelayError> {
        if seq > self.highest {
            return Ok(());
        }
        let back = self.highest - seq;
        if back >= REPLAY_WINDOW {
            return Err(RelayError::Replay);
        }
        if self.bitmap & (1u128 << back) != 0 {
            return Err(RelayError::Replay);
        }
        Ok(())
    }

    fn accept(&mut self, seq: u64) {
        if seq > self.highest {
            let shift = seq - self.highest;
            self.bitmap = if shift >= REPLAY_WINDOW { 0 } else { self.bitmap << shift };
            self.highest = seq;
            self.bitmap |= 1;
        } else {
            self.bitmap |= 1u128 << (self.highest - seq);
        }
    }
}

type SessionKey = (u32, [u8; SESSION_ID_LEN]);

struct SessionState {
    cipher: ChaCha20Poly1305,
    window: ReplayWindow,
    last_used: u64,
}

pub struct ReceiverCore {
    kdf: GroupKdf,
    lane: Lane,
    sessions: HashMap<SessionKey, SessionState>,
    retired: HashMap<SessionKey, u64>,
    retired_order: VecDeque<SessionKey>,
    tick: u64,
}

impl ReceiverCore {
    pub fn new(group_secret: &[u8], lane: Lane) -> Result<Self, RelayError> {
        Ok(ReceiverCore {
            kdf: GroupKdf::new(group_secret)?,
            lane,
            sessions: HashMap::new(),
            retired: HashMap::new(),
            retired_order: VecDeque::new(),
            tick: 0,
        })
    }

    pub fn lane(&self) -> Lane {
        self.lane
    }

    pub fn matches_secret(&self, group_secret: &[u8]) -> bool {
        self.kdf.matches(group_secret)
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// Authenticates, replay-checks, skew-checks and decrypts one v3 payload
    /// received on lane `ssrc` (the value media-rust stamped on the frame);
    /// `now_ms` is the receiver's wall clock. The skew check runs after the
    /// tag verified (so `stale-timestamp` always means an authentic but
    /// out-of-window frame — a replay or a badly wrong clock) and before the
    /// replay window / session table is touched, so a stale frame changes no
    /// state.
    pub fn open(&mut self, frame: &[u8], ssrc: u32, now_ms: u64) -> Result<Vec<u8>, RelayError> {
        let parsed = parse(frame)?;
        let fresh = within_skew(parsed.ts_ms, now_ms);
        let key: SessionKey = (ssrc, parsed.session_id);
        let aad = aad_for(parsed.header, ssrc, self.lane);
        let nonce = nonce_for(parsed.seq);
        self.tick += 1;
        let tick = self.tick;

        if let Some(state) = self.sessions.get_mut(&key) {
            state.window.check(parsed.seq)?;
            let pt = state
                .cipher
                .decrypt(Nonce::from_slice(&nonce), Payload { msg: parsed.body, aad: &aad })
                .map_err(|_| RelayError::AuthFailed)?;
            if !fresh {
                return Err(RelayError::StaleTimestamp);
            }
            state.window.accept(parsed.seq);
            state.last_used = tick;
            return Ok(pt);
        }

        // Unknown (or evicted) session. Nothing is stored until the tag
        // verifies, so a party without the group secret can't create state,
        // burn window slots, or evict genuine sessions.
        let mut window = match self.retired.get(&key) {
            Some(&highest) => {
                let w = ReplayWindow::resumed(highest);
                w.check(parsed.seq)?;
                w
            }
            None => ReplayWindow::fresh(parsed.seq),
        };
        let cipher = self.kdf.session_cipher(self.lane, &parsed.session_id);
        let pt = cipher
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: parsed.body, aad: &aad })
            .map_err(|_| RelayError::AuthFailed)?;
        if !fresh {
            return Err(RelayError::StaleTimestamp);
        }
        window.accept(parsed.seq);
        if self.retired.remove(&key).is_some() {
            self.retired_order.retain(|k| k != &key);
        }
        self.make_room_for(ssrc);
        self.sessions.insert(key, SessionState { cipher, window, last_used: tick });
        Ok(pt)
    }

    fn make_room_for(&mut self, ssrc: u32) {
        let same_ssrc = self.sessions.keys().filter(|k| k.0 == ssrc).count();
        if same_ssrc >= MAX_SESSIONS_PER_SSRC {
            self.evict_lru(Some(ssrc));
        }
        if self.sessions.len() >= MAX_SESSIONS_TOTAL {
            self.evict_lru(None);
        }
    }

    fn evict_lru(&mut self, only_ssrc: Option<u32>) {
        let victim = self
            .sessions
            .iter()
            .filter(|(k, _)| only_ssrc.is_none_or(|s| k.0 == s))
            .min_by_key(|(_, st)| st.last_used)
            .map(|(k, _)| *k);
        if let Some((k, st)) = victim.and_then(|k| self.sessions.remove(&k).map(|st| (k, st))) {
            self.retire(k, st.window.highest);
        }
    }

    fn retire(&mut self, key: SessionKey, highest: u64) {
        if self.retired.insert(key, highest).is_none() {
            self.retired_order.push_back(key);
        }
        while self.retired_order.len() > MAX_RETIRED {
            if let Some(old) = self.retired_order.pop_front() {
                self.retired.remove(&old);
            }
        }
    }

    #[cfg(test)]
    fn retired_len(&self) -> usize {
        self.retired.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn secret(b: u8) -> [u8; 32] {
        [b; 32]
    }

    const SSRC_A: u32 = 0x1234_5678;
    const SSRC_B: u32 = 0x0abc_def0;
    /// Fixed wall clock for tests (2026-10-24T00:00:00Z).
    const NOW: u64 = 1_792_800_000_000;

    #[test]
    fn roundtrip_and_header_layout() {
        let mut tx = SenderCore::new(&secret(1), Lane::Channel).unwrap();
        let mut rx = ReceiverCore::new(&secret(1), Lane::Channel).unwrap();
        for i in 0..10u8 {
            let ct = tx.seal(&[i; 40], SSRC_A, NOW).unwrap();
            assert_eq!(ct.len(), HEADER_LEN + 40 + TAG_LEN);
            assert_eq!(ct[0], VERSION);
            assert_eq!(&ct[1..17], &tx.session_id());
            assert_eq!(u64::from_be_bytes(ct[17..25].try_into().unwrap()), i as u64);
            assert_eq!(u64::from_be_bytes(ct[25..33].try_into().unwrap()), NOW);
            assert_eq!(rx.open(&ct, SSRC_A, NOW).unwrap(), vec![i; 40]);
        }
    }

    #[test]
    fn sessions_never_share_key_nonce_pairs() {
        // Same secret, same ssrc, both counters starting at 0 (the v1 reconnect
        // case): ciphertexts of identical plaintext must differ, and the
        // keystreams must differ (XOR of the two ciphertexts ≠ 0).
        let pt = [0u8; 64];
        let mut ids = HashSet::new();
        let mut first_frames = Vec::new();
        for _ in 0..200 {
            let mut tx = SenderCore::new(&secret(7), Lane::Channel).unwrap();
            assert!(ids.insert(tx.session_id()), "session id collision");
            let ct = tx.seal(&pt, SSRC_A, NOW).unwrap();
            first_frames.push(ct[HEADER_LEN..].to_vec());
        }
        let unique: HashSet<_> = first_frames.iter().cloned().collect();
        assert_eq!(unique.len(), first_frames.len());
    }

    #[test]
    fn reconnect_sessions_decrypt_independently() {
        let mut rx = ReceiverCore::new(&secret(2), Lane::Channel).unwrap();
        let mut s1 = SenderCore::new(&secret(2), Lane::Channel).unwrap();
        let mut s2 = SenderCore::new(&secret(2), Lane::Channel).unwrap();
        // Interleave: both sessions use seq 0.. on the same ssrc.
        for i in 0..5u8 {
            let a = s1.seal(&[i; 8], SSRC_A, NOW).unwrap();
            let b = s2.seal(&[i + 100; 8], SSRC_A, NOW).unwrap();
            assert_eq!(rx.open(&a, SSRC_A, NOW).unwrap(), vec![i; 8]);
            assert_eq!(rx.open(&b, SSRC_A, NOW).unwrap(), vec![i + 100; 8]);
        }
        assert_eq!(rx.session_count(), 2);
    }

    #[test]
    fn replay_rejected() {
        let mut tx = SenderCore::new(&secret(3), Lane::Channel).unwrap();
        let mut rx = ReceiverCore::new(&secret(3), Lane::Channel).unwrap();
        let f0 = tx.seal(b"zero", SSRC_A, NOW).unwrap();
        let f1 = tx.seal(b"one", SSRC_A, NOW).unwrap();
        let f2 = tx.seal(b"two", SSRC_A, NOW).unwrap();
        assert!(rx.open(&f0, SSRC_A, NOW).is_ok());
        assert!(rx.open(&f2, SSRC_A, NOW).is_ok());
        assert_eq!(rx.open(&f2, SSRC_A, NOW), Err(RelayError::Replay));
        assert_eq!(rx.open(&f0, SSRC_A, NOW), Err(RelayError::Replay));
        // Reordered-but-new frame within the window is still accepted once.
        assert!(rx.open(&f1, SSRC_A, NOW).is_ok());
        assert_eq!(rx.open(&f1, SSRC_A, NOW), Err(RelayError::Replay));
    }

    #[test]
    fn frames_older_than_window_rejected() {
        let mut tx = SenderCore::new(&secret(3), Lane::Channel).unwrap();
        let mut rx = ReceiverCore::new(&secret(3), Lane::Channel).unwrap();
        let old = tx.seal(b"old", SSRC_A, NOW).unwrap();
        let mut last = Vec::new();
        for _ in 0..REPLAY_WINDOW {
            last = tx.seal(b"x", SSRC_A, NOW).unwrap();
        }
        assert!(rx.open(&last, SSRC_A, NOW).is_ok());
        assert_eq!(rx.open(&old, SSRC_A, NOW), Err(RelayError::Replay));
    }

    #[test]
    fn forged_frame_does_not_burn_window_slot() {
        let mut tx = SenderCore::new(&secret(4), Lane::Channel).unwrap();
        let mut rx = ReceiverCore::new(&secret(4), Lane::Channel).unwrap();
        let f0 = tx.seal(b"a", SSRC_A, NOW).unwrap();
        assert!(rx.open(&f0, SSRC_A, NOW).is_ok());
        let f1 = tx.seal(b"b", SSRC_A, NOW).unwrap();
        let mut forged = f1.clone();
        *forged.last_mut().unwrap() ^= 1;
        assert_eq!(rx.open(&forged, SSRC_A, NOW), Err(RelayError::AuthFailed));
        assert_eq!(rx.open(&f1, SSRC_A, NOW).unwrap(), b"b".to_vec());
    }

    #[test]
    fn aad_binding_rejects_tampering() {
        let mut tx = SenderCore::new(&secret(5), Lane::Channel).unwrap();
        let ct = tx.seal(b"payload", SSRC_A, NOW).unwrap();

        // ssrc (lane the server stamped) changed
        let mut rx = ReceiverCore::new(&secret(5), Lane::Channel).unwrap();
        assert_eq!(rx.open(&ct, SSRC_B, NOW), Err(RelayError::AuthFailed));

        // sequence in header changed
        let mut t = ct.clone();
        t[24] ^= 1;
        assert_eq!(rx.open(&t, SSRC_A, NOW), Err(RelayError::AuthFailed));

        // timestamp in header changed (still well inside the skew window, so
        // only the AEAD can catch it)
        let mut t = ct.clone();
        t[HEADER_LEN - 1] ^= 1;
        assert_eq!(rx.open(&t, SSRC_A, NOW), Err(RelayError::AuthFailed));

        // session id changed
        let mut t = ct.clone();
        t[3] ^= 0x80;
        assert_eq!(rx.open(&t, SSRC_A, NOW), Err(RelayError::AuthFailed));

        // is_global_broadcast flipped: a channel-lane frame opened as cascade
        // (even with the very same group secret) fails.
        let mut rx_cascade = ReceiverCore::new(&secret(5), Lane::Cascade).unwrap();
        assert_eq!(rx_cascade.open(&ct, SSRC_A, NOW), Err(RelayError::AuthFailed));

        // ciphertext body changed
        let mut t = ct.clone();
        t[HEADER_LEN] ^= 1;
        assert_eq!(rx.open(&t, SSRC_A, NOW), Err(RelayError::AuthFailed));

        // and the untouched frame still opens (no state was created above)
        assert_eq!(rx.session_count(), 0);
        assert_eq!(rx.open(&ct, SSRC_A, NOW).unwrap(), b"payload".to_vec());
    }

    #[test]
    fn wrong_key_rejected() {
        let mut tx = SenderCore::new(&secret(6), Lane::Channel).unwrap();
        let mut rx = ReceiverCore::new(&secret(9), Lane::Channel).unwrap();
        let ct = tx.seal(b"secret", SSRC_A, NOW).unwrap();
        assert_eq!(rx.open(&ct, SSRC_A, NOW), Err(RelayError::AuthFailed));
        assert_eq!(rx.session_count(), 0);
    }

    #[test]
    fn cross_session_and_lane_key_separation() {
        // Same session id, same secret, different lane → different keys.
        let sid = [0x42u8; SESSION_ID_LEN];
        let mut ch = SenderCore::with_session_id(&secret(8), Lane::Channel, sid).unwrap();
        let mut cs = SenderCore::with_session_id(&secret(8), Lane::Cascade, sid).unwrap();
        let a = ch.seal(&[0u8; 32], SSRC_A, NOW).unwrap();
        let b = cs.seal(&[0u8; 32], SSRC_A, NOW).unwrap();
        assert_eq!(a[..HEADER_LEN], b[..HEADER_LEN]);
        assert_ne!(a[HEADER_LEN..HEADER_LEN + 32], b[HEADER_LEN..HEADER_LEN + 32]);

        // Splicing session B's body under session A's header fails.
        let mut s1 = SenderCore::new(&secret(8), Lane::Channel).unwrap();
        let mut s2 = SenderCore::new(&secret(8), Lane::Channel).unwrap();
        let f1 = s1.seal(b"same", SSRC_A, NOW).unwrap();
        let f2 = s2.seal(b"same", SSRC_A, NOW).unwrap();
        let mut spliced = f1[..HEADER_LEN].to_vec();
        spliced.extend_from_slice(&f2[HEADER_LEN..]);
        let mut rx = ReceiverCore::new(&secret(8), Lane::Channel).unwrap();
        assert_eq!(rx.open(&spliced, SSRC_A, NOW), Err(RelayError::AuthFailed));

        // Channel vs cascade secrets (different MLS exports) never cross.
        let mut rx_ch = ReceiverCore::new(&secret(10), Lane::Channel).unwrap();
        let mut tx_cs = SenderCore::new(&secret(11), Lane::Cascade).unwrap();
        let f = tx_cs.seal(b"cascade", SSRC_A, NOW).unwrap();
        assert_eq!(rx_ch.open(&f, SSRC_A, NOW), Err(RelayError::AuthFailed));
        let mut rx_cs = ReceiverCore::new(&secret(11), Lane::Cascade).unwrap();
        assert_eq!(rx_cs.open(&f, SSRC_A, NOW).unwrap(), b"cascade".to_vec());
    }

    #[test]
    fn v1_and_malformed_frames_rejected() {
        let mut rx = ReceiverCore::new(&secret(12), Lane::Channel).unwrap();
        // A v1 frame was bare ChaCha20-Poly1305 ciphertext||tag; its first
        // byte is arbitrary. Any first byte other than 0x03 → unsupported.
        let v1 = vec![0x9au8; 56];
        // A v2 frame (0x02 header, no timestamp) is refused outright.
        let mut v2 = vec![0u8; 25 + 40 + TAG_LEN];
        v2[0] = 0x02;
        assert_eq!(rx.open(&v2, SSRC_A, NOW), Err(RelayError::UnsupportedVersion));
        assert_eq!(rx.open(&v1, SSRC_A, NOW), Err(RelayError::UnsupportedVersion));
        // A v1 frame whose first byte happens to be 0x02 still fails the tag.
        let mut v1b = v1.clone();
        v1b[0] = VERSION;
        assert_eq!(rx.open(&v1b, SSRC_A, NOW), Err(RelayError::AuthFailed));
        assert_eq!(rx.open(&[], SSRC_A, NOW), Err(RelayError::Malformed));
        assert_eq!(rx.open(&[VERSION; HEADER_LEN + TAG_LEN - 1], SSRC_A, NOW), Err(RelayError::Malformed));
    }

    #[test]
    fn sequence_exhaustion_refuses_to_encrypt() {
        let mut tx = SenderCore::new(&secret(13), Lane::Channel).unwrap();
        tx.force_next_seq(u64::MAX - 1);
        assert!(tx.seal(b"last", SSRC_A, NOW).is_ok());
        assert_eq!(tx.seal(b"over", SSRC_A, NOW), Err(RelayError::SequenceExhausted));
        assert_eq!(tx.seal(b"over", SSRC_A, NOW), Err(RelayError::SequenceExhausted));
    }

    #[test]
    fn bad_secret_length_rejected() {
        assert!(SenderCore::new(&[0u8; 16], Lane::Channel).is_err());
        assert!(ReceiverCore::new(&[0u8; 33], Lane::Channel).is_err());
    }

    #[test]
    fn matches_secret() {
        let tx = SenderCore::new(&secret(14), Lane::Channel).unwrap();
        let rx = ReceiverCore::new(&secret(14), Lane::Cascade).unwrap();
        assert!(tx.matches_secret(&secret(14)));
        assert!(!tx.matches_secret(&secret(15)));
        assert!(rx.matches_secret(&secret(14)));
        assert!(!rx.matches_secret(&[0u8; 5]));
    }

    #[test]
    fn per_ssrc_session_cap_and_evicted_replay_still_rejected() {
        let mut rx = ReceiverCore::new(&secret(16), Lane::Channel).unwrap();
        let mut first = SenderCore::new(&secret(16), Lane::Channel).unwrap();
        let old0 = first.seal(b"f0", SSRC_A, NOW).unwrap();
        let old1 = first.seal(b"f1", SSRC_A, NOW).unwrap();
        assert!(rx.open(&old0, SSRC_A, NOW).is_ok());
        assert!(rx.open(&old1, SSRC_A, NOW).is_ok());
        // MAX_SESSIONS_PER_SSRC more sessions on the same ssrc evict `first`.
        for _ in 0..MAX_SESSIONS_PER_SSRC {
            let mut s = SenderCore::new(&secret(16), Lane::Channel).unwrap();
            assert!(rx.open(&s.seal(b"n", SSRC_A, NOW).unwrap(), SSRC_A, NOW).is_ok());
        }
        assert_eq!(rx.session_count(), MAX_SESSIONS_PER_SSRC);
        assert_eq!(rx.retired_len(), 1);
        // Replays of the evicted session are still refused…
        assert_eq!(rx.open(&old0, SSRC_A, NOW), Err(RelayError::Replay));
        assert_eq!(rx.open(&old1, SSRC_A, NOW), Err(RelayError::Replay));
        // …but if it is genuinely still live, new frames are re-admitted.
        let next = first.seal(b"f2", SSRC_A, NOW).unwrap();
        assert_eq!(rx.open(&next, SSRC_A, NOW).unwrap(), b"f2".to_vec());
        assert_eq!(rx.open(&next, SSRC_A, NOW), Err(RelayError::Replay));
        // A different ssrc is unaffected by SSRC_A's cap.
        let mut b = SenderCore::new(&secret(16), Lane::Channel).unwrap();
        assert!(rx.open(&b.seal(b"b", SSRC_B, NOW).unwrap(), SSRC_B, NOW).is_ok());
    }

    #[test]
    fn total_session_cap_bounded() {
        let mut rx = ReceiverCore::new(&secret(17), Lane::Channel).unwrap();
        for i in 0..(MAX_SESSIONS_TOTAL as u32 + 50) {
            let mut s = SenderCore::new(&secret(17), Lane::Channel).unwrap();
            assert!(rx.open(&s.seal(b"x", i + 1, NOW).unwrap(), i + 1, NOW).is_ok());
            assert!(rx.session_count() <= MAX_SESSIONS_TOTAL);
        }
        assert_eq!(rx.session_count(), MAX_SESSIONS_TOTAL);
    }

    #[test]
    fn window_shift_math() {
        let mut w = ReplayWindow::fresh(10);
        w.accept(10);
        assert_eq!(w.check(10), Err(RelayError::Replay));
        assert!(w.check(9).is_ok());
        w.accept(10 + REPLAY_WINDOW + 5);
        assert_eq!(w.check(10), Err(RelayError::Replay)); // fell out of window
        assert!(w.check(10 + REPLAY_WINDOW + 4).is_ok());
        w.accept(u64::MAX - 1);
        assert_eq!(w.check(u64::MAX - 1), Err(RelayError::Replay));
        assert!(w.check(u64::MAX).is_ok());
    }

    // ── v3 sender timestamp ─────────────────────────────────────────────────

    #[test]
    fn skew_window_accepts_edges_and_rejects_beyond() {
        let mut tx = SenderCore::new(&secret(20), Lane::Channel).unwrap();
        let mut rx = ReceiverCore::new(&secret(20), Lane::Channel).unwrap();
        // Sender clock exactly MAX_SKEW_MS behind / ahead of the receiver: OK.
        let behind = tx.seal(b"behind", SSRC_A, NOW - MAX_SKEW_MS).unwrap();
        assert_eq!(rx.open(&behind, SSRC_A, NOW).unwrap(), b"behind".to_vec());
        let mut tx2 = SenderCore::new(&secret(20), Lane::Channel).unwrap();
        let ahead = tx2.seal(b"ahead", SSRC_A, NOW + MAX_SKEW_MS).unwrap();
        assert_eq!(rx.open(&ahead, SSRC_A, NOW).unwrap(), b"ahead".to_vec());
        // 1 ms further either way: authentic but stale.
        let mut tx3 = SenderCore::new(&secret(20), Lane::Channel).unwrap();
        let old = tx3.seal(b"old", SSRC_A, NOW - MAX_SKEW_MS - 1).unwrap();
        assert_eq!(rx.open(&old, SSRC_A, NOW), Err(RelayError::StaleTimestamp));
        let mut tx4 = SenderCore::new(&secret(20), Lane::Channel).unwrap();
        let future = tx4.seal(b"future", SSRC_A, NOW + MAX_SKEW_MS + 1).unwrap();
        assert_eq!(rx.open(&future, SSRC_A, NOW), Err(RelayError::StaleTimestamp));
        // Stale frames of unknown sessions create no state.
        assert_eq!(rx.session_count(), 2);
    }

    #[test]
    fn replay_after_receiver_restart_is_bounded_by_skew() {
        // The v2 residual: a receiver restarts mid-epoch (fresh windows) and
        // the relay replays frames it recorded earlier.
        let mut tx = SenderCore::new(&secret(21), Lane::Channel).unwrap();
        let recorded: Vec<Vec<u8>> =
            (0..5u8).map(|i| tx.seal(&[i; 10], SSRC_A, NOW + i as u64 * 20).unwrap()).collect();
        let mut rx = ReceiverCore::new(&secret(21), Lane::Channel).unwrap();
        for (i, f) in recorded.iter().enumerate() {
            assert_eq!(rx.open(f, SSRC_A, NOW + 100).unwrap(), vec![i as u8; 10]);
        }
        // Receiver restarts 2 minutes later (same epoch secret): every
        // recorded frame is refused even though the window is empty.
        let later = NOW + 120_000;
        let mut restarted = ReceiverCore::new(&secret(21), Lane::Channel).unwrap();
        for f in &recorded {
            assert_eq!(restarted.open(f, SSRC_A, later), Err(RelayError::StaleTimestamp));
        }
        assert_eq!(restarted.session_count(), 0);
        // The same live session keeps working once it sends fresh frames.
        let fresh = tx.seal(b"live", SSRC_A, later).unwrap();
        assert_eq!(restarted.open(&fresh, SSRC_A, later).unwrap(), b"live".to_vec());
        // And the replay window still applies inside the skew window.
        assert_eq!(restarted.open(&fresh, SSRC_A, later), Err(RelayError::Replay));
    }

    #[test]
    fn stale_frame_on_known_session_does_not_touch_window() {
        let mut tx = SenderCore::new(&secret(22), Lane::Channel).unwrap();
        let mut rx = ReceiverCore::new(&secret(22), Lane::Channel).unwrap();
        let f0 = tx.seal(b"a", SSRC_A, NOW).unwrap();
        let f1 = tx.seal(b"b", SSRC_A, NOW + 20).unwrap();
        assert!(rx.open(&f0, SSRC_A, NOW).is_ok());
        // Receiver clock momentarily far ahead (e.g. manual clock change):
        // f1 is refused but its slot is not consumed…
        assert_eq!(rx.open(&f1, SSRC_A, NOW + 10 * MAX_SKEW_MS), Err(RelayError::StaleTimestamp));
        // …so once clocks agree again it plays exactly once.
        assert_eq!(rx.open(&f1, SSRC_A, NOW + 40).unwrap(), b"b".to_vec());
        assert_eq!(rx.open(&f1, SSRC_A, NOW + 40), Err(RelayError::Replay));
    }

    #[test]
    fn sender_timestamps_never_go_backwards() {
        let mut tx = SenderCore::new(&secret(23), Lane::Channel).unwrap();
        let a = tx.seal(b"a", SSRC_A, NOW).unwrap();
        // Wall clock steps back 5 s (NTP correction).
        let b = tx.seal(b"b", SSRC_A, NOW - 5_000).unwrap();
        let ts = |f: &[u8]| u64::from_be_bytes(f[TS_OFFSET..HEADER_LEN].try_into().unwrap());
        assert_eq!(ts(&a), NOW);
        assert_eq!(ts(&b), NOW);
        let c = tx.seal(b"c", SSRC_A, NOW + 20).unwrap();
        assert_eq!(ts(&c), NOW + 20);
    }

    #[test]
    fn rewriting_timestamp_to_look_fresh_fails_auth() {
        // A relay that rewrites an old frame's timestamp to "now" to pass the
        // skew check breaks the tag.
        let mut tx = SenderCore::new(&secret(24), Lane::Channel).unwrap();
        let old = tx.seal(b"old", SSRC_A, NOW - 600_000).unwrap();
        let mut rewritten = old.clone();
        rewritten[TS_OFFSET..HEADER_LEN].copy_from_slice(&NOW.to_be_bytes());
        let mut rx = ReceiverCore::new(&secret(24), Lane::Channel).unwrap();
        assert_eq!(rx.open(&rewritten, SSRC_A, NOW), Err(RelayError::AuthFailed));
        assert_eq!(rx.open(&old, SSRC_A, NOW), Err(RelayError::StaleTimestamp));
    }

    #[test]
    fn ms_from_f64_clamps() {
        assert_eq!(ms_from_f64(f64::NAN), 0);
        assert_eq!(ms_from_f64(-5.0), 0);
        assert_eq!(ms_from_f64(1234.9), 1234);
    }
}
