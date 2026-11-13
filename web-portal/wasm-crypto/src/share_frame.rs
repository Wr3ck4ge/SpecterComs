//! Screen-share frame protection, wire format v2 (Wave 3 B4; design in
//! docs/WAVE3_FORMAT_V2_FRANKING_DESIGN.md §3).
//!
//! v1 (`SFrameCrypto`) used the channel's MLS 'video' export directly as the
//! ChaCha20-Poly1305 key with a random nonce and **no AAD**, so the relay could
//! replay frames for the whole epoch, reorder them, or move them between
//! sharers. v2 gives share frames what relay voice (wire v3) has:
//!
//! ```text
//! payload = 0x02 || kind(1) || session_id(16) || seq_be64(8) || ts_ms_be64(8) || ct || tag(16)
//!           └──────────────────── header, 34 bytes ────────────────────┘
//! PRK         = HKDF-Extract(salt "specter/share/v2", IKM = 'video' export)
//! session_key = HKDF-Expand(PRK, "specter/share/v2/session-key" || kind || session_id, 32)
//! nonce       = 0x00000000 || seq_be64
//! AAD         = header(34) || outer_flags(1) || outer_ts_be32(4) || sharer_user_id(16)
//! ```
//!
//! * `outer_flags` / `outer_ts` are the `[1B flags][4B ts]` of the share wire
//!   unit (or of a share-audio datagram) — media-rust relays them byte for
//!   byte, so binding them stops keyframe/delta/audio bit flips.
//! * `sharer_user_id`: the sender's own user id; the receiver passes the
//!   sharer it subscribed to, so a frame moved to another sharer's stream
//!   fails authentication.
//! * Receivers keep a 128-frame replay window per (sharer, kind, session) via
//!   the shared [`crate::replay`] table, and reject authentic frames more than
//!   [`MAX_SKEW_MS`] from their clock. media-rust's cached keyframe is the same
//!   authentic frame: it opens while younger than the skew bound, after that it
//!   is dropped as `stale-timestamp` and the viewer waits for a fresh one.
//! * Windows are per subscription: callers `reset()` the receiver when a new
//!   subscription starts, so the (legitimately re-sent) cached keyframe of a
//!   sharer watched before is not refused as a replay.
//!
//! Kinds `0x10` (program) / `0x11` (tile) are reserved for director mode and
//! refused (`unsupported-kind`) until that ships.

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Key, Nonce,
};
use getrandom::getrandom;
use hkdf::Hkdf;
use sha2::Sha256;

use crate::replay::{self, OpenError, SessionTable};

pub const VERSION: u8 = 0x02;
pub const KIND_VIDEO: u8 = 0x01;
pub const KIND_AUDIO: u8 = 0x02;
/// Reserved (director mode, D4) — not accepted yet.
pub const KIND_PROGRAM: u8 = 0x10;
pub const KIND_TILE: u8 = 0x11;

pub const SESSION_ID_LEN: usize = 16;
const KIND_OFFSET: usize = 1;
const SID_OFFSET: usize = 2;
const SEQ_OFFSET: usize = SID_OFFSET + SESSION_ID_LEN;
const TS_OFFSET: usize = SEQ_OFFSET + 8;
pub const HEADER_LEN: usize = TS_OFFSET + 8;
pub const TAG_LEN: usize = 16;
pub const SECRET_LEN: usize = 32;
pub const USER_ID_LEN: usize = 16;
const AAD_LEN: usize = HEADER_LEN + 1 + 4 + USER_ID_LEN;

/// Max |sender timestamp − receiver clock| (same bound as relay voice).
pub const MAX_SKEW_MS: u64 = 30_000;

const KDF_SALT: &[u8] = b"specter/share/v2";
const KDF_INFO_PREFIX: &[u8] = b"specter/share/v2/session-key";
const KDF_FINGERPRINT_INFO: &[u8] = b"specter/share/v2/secret-fingerprint";

/// Sessions per (sharer, kind): restarts of one share within one key epoch.
pub const MAX_SESSIONS_PER_STREAM: usize = 8;
pub const MAX_SESSIONS_TOTAL: usize = 64;
pub const MAX_RETIRED: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareError {
    BadSecret,
    BadUserId,
    Rng,
    SequenceExhausted,
    Malformed,
    UnsupportedVersion,
    UnsupportedKind,
    Replay,
    AuthFailed,
    StaleTimestamp,
}

impl ShareError {
    /// Stable, machine-matchable code (CommLink keys drop handling off these).
    pub fn code(self) -> &'static str {
        match self {
            ShareError::BadSecret => "bad-secret",
            ShareError::BadUserId => "bad-user-id",
            ShareError::Rng => "rng-failed",
            ShareError::SequenceExhausted => "sequence-exhausted",
            ShareError::Malformed => "malformed",
            ShareError::UnsupportedVersion => "unsupported-version",
            ShareError::UnsupportedKind => "unsupported-kind",
            ShareError::Replay => "replay",
            ShareError::AuthFailed => "auth-failed",
            ShareError::StaleTimestamp => "stale-timestamp",
        }
    }
}

/// Kinds accepted today. Reserved and unknown kinds are refused.
pub fn check_kind(kind: u8) -> Result<(), ShareError> {
    match kind {
        KIND_VIDEO | KIND_AUDIO => Ok(()),
        _ => Err(ShareError::UnsupportedKind),
    }
}

/// Parses a canonical UUID string (`8-4-4-4-12` hex, any case) to 16 bytes.
pub fn parse_user_id(s: &str) -> Result<[u8; USER_ID_LEN], ShareError> {
    let b = s.as_bytes();
    if b.len() != 36 || b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
        return Err(ShareError::BadUserId);
    }
    let mut out = [0u8; USER_ID_LEN];
    let mut n = 0;
    let mut hi: Option<u8> = None;
    for (i, &c) in b.iter().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            continue;
        }
        let v = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => return Err(ShareError::BadUserId),
        };
        match hi.take() {
            None => hi = Some(v),
            Some(h) => {
                out[n] = (h << 4) | v;
                n += 1;
            }
        }
    }
    Ok(out)
}

/// HKDF-Extract of the 'video' export plus a fingerprint for same-secret
/// detection (a same-epoch re-export keeps the running objects).
#[derive(Clone)]
pub struct ShareKdf {
    hk: Hkdf<Sha256>,
    fingerprint: [u8; 32],
}

impl ShareKdf {
    pub fn new(secret: &[u8]) -> Result<Self, ShareError> {
        if secret.len() != SECRET_LEN {
            return Err(ShareError::BadSecret);
        }
        let hk = Hkdf::<Sha256>::new(Some(KDF_SALT), secret);
        let mut fingerprint = [0u8; 32];
        hk.expand(KDF_FINGERPRINT_INFO, &mut fingerprint).map_err(|_| ShareError::BadSecret)?;
        Ok(ShareKdf { hk, fingerprint })
    }

    fn session_cipher(&self, kind: u8, session_id: &[u8; SESSION_ID_LEN]) -> ChaCha20Poly1305 {
        let mut info = Vec::with_capacity(KDF_INFO_PREFIX.len() + 1 + SESSION_ID_LEN);
        info.extend_from_slice(KDF_INFO_PREFIX);
        info.push(kind);
        info.extend_from_slice(session_id);
        let mut okm = [0u8; 32];
        self.hk.expand(&info, &mut okm).expect("HKDF expand of 32 bytes");
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&okm));
        okm.fill(0);
        cipher
    }

    pub fn matches(&self, secret: &[u8]) -> bool {
        match ShareKdf::new(secret) {
            Ok(other) => {
                let mut diff = 0u8;
                for i in 0..32 {
                    diff |= self.fingerprint[i] ^ other.fingerprint[i];
                }
                diff == 0
            }
            Err(_) => false,
        }
    }
}

fn nonce_for(seq: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..12].copy_from_slice(&seq.to_be_bytes());
    n
}

fn header_for(kind: u8, session_id: &[u8; SESSION_ID_LEN], seq: u64, ts_ms: u64) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[0] = VERSION;
    h[KIND_OFFSET] = kind;
    h[SID_OFFSET..SEQ_OFFSET].copy_from_slice(session_id);
    h[SEQ_OFFSET..TS_OFFSET].copy_from_slice(&seq.to_be_bytes());
    h[TS_OFFSET..HEADER_LEN].copy_from_slice(&ts_ms.to_be_bytes());
    h
}

fn aad_for(header: &[u8], outer_flags: u8, outer_ts: u32, sharer: &[u8; USER_ID_LEN]) -> [u8; AAD_LEN] {
    let mut aad = [0u8; AAD_LEN];
    aad[..HEADER_LEN].copy_from_slice(header);
    aad[HEADER_LEN] = outer_flags;
    aad[HEADER_LEN + 1..HEADER_LEN + 5].copy_from_slice(&outer_ts.to_be_bytes());
    aad[HEADER_LEN + 5..].copy_from_slice(sharer);
    aad
}

/// Parsed (not yet authenticated) v2 header.
pub struct ParsedHeader<'a> {
    pub kind: u8,
    pub session_id: [u8; SESSION_ID_LEN],
    pub seq: u64,
    pub ts_ms: u64,
    pub header: &'a [u8],
    pub body: &'a [u8],
}

pub fn parse(frame: &[u8]) -> Result<ParsedHeader<'_>, ShareError> {
    if frame.is_empty() {
        return Err(ShareError::Malformed);
    }
    if frame[0] != VERSION {
        return Err(ShareError::UnsupportedVersion);
    }
    if frame.len() < HEADER_LEN + TAG_LEN {
        return Err(ShareError::Malformed);
    }
    let kind = frame[KIND_OFFSET];
    check_kind(kind)?;
    let mut session_id = [0u8; SESSION_ID_LEN];
    session_id.copy_from_slice(&frame[SID_OFFSET..SEQ_OFFSET]);
    Ok(ParsedHeader {
        kind,
        session_id,
        seq: u64::from_be_bytes(frame[SEQ_OFFSET..TS_OFFSET].try_into().unwrap()),
        ts_ms: u64::from_be_bytes(frame[TS_OFFSET..HEADER_LEN].try_into().unwrap()),
        header: &frame[..HEADER_LEN],
        body: &frame[HEADER_LEN..],
    })
}

// ── Sender ───────────────────────────────────────────────────────────────────

/// One sending session for one kind (one per publish start).
pub struct SenderCore {
    kdf: ShareKdf,
    kind: u8,
    sharer: [u8; USER_ID_LEN],
    session_id: [u8; SESSION_ID_LEN],
    cipher: ChaCha20Poly1305,
    next_seq: u64,
    last_ts_ms: u64,
}

impl SenderCore {
    pub fn new(secret: &[u8], kind: u8, sharer: [u8; USER_ID_LEN]) -> Result<Self, ShareError> {
        let mut session_id = [0u8; SESSION_ID_LEN];
        getrandom(&mut session_id).map_err(|_| ShareError::Rng)?;
        Self::from_kdf(ShareKdf::new(secret)?, kind, sharer, session_id)
    }

    pub fn from_kdf(
        kdf: ShareKdf,
        kind: u8,
        sharer: [u8; USER_ID_LEN],
        session_id: [u8; SESSION_ID_LEN],
    ) -> Result<Self, ShareError> {
        check_kind(kind)?;
        let cipher = kdf.session_cipher(kind, &session_id);
        Ok(SenderCore { kdf, kind, sharer, session_id, cipher, next_seq: 0, last_ts_ms: 0 })
    }

    /// Seals one payload for the wire unit `[size][outer_flags][outer_ts][payload]`
    /// (or the share-audio datagram `[outer_flags][outer_ts][payload]`).
    /// `now_ms` is clamped non-decreasing within the session.
    pub fn seal(&mut self, payload: &[u8], outer_flags: u8, outer_ts: u32, now_ms: u64) -> Result<Vec<u8>, ShareError> {
        let seq = self.next_seq;
        if seq == u64::MAX {
            return Err(ShareError::SequenceExhausted);
        }
        self.next_seq = seq + 1;
        let ts_ms = now_ms.max(self.last_ts_ms);
        self.last_ts_ms = ts_ms;
        let header = header_for(self.kind, &self.session_id, seq, ts_ms);
        let aad = aad_for(&header, outer_flags, outer_ts, &self.sharer);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce_for(seq)), Payload { msg: payload, aad: &aad })
            .map_err(|_| ShareError::AuthFailed)?;
        let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
        out.extend_from_slice(&header);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn session_id(&self) -> [u8; SESSION_ID_LEN] {
        self.session_id
    }

    pub fn kind(&self) -> u8 {
        self.kind
    }

    pub fn matches_secret(&self, secret: &[u8]) -> bool {
        self.kdf.matches(secret)
    }

    #[cfg(test)]
    pub(crate) fn force_next_seq(&mut self, seq: u64) {
        self.next_seq = seq;
    }
}

// ── Receiver ─────────────────────────────────────────────────────────────────

/// (sharer, kind, session_id); the per-group cap applies per (sharer, kind).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct SessionKey([u8; USER_ID_LEN], u8, [u8; SESSION_ID_LEN]);

impl replay::SessionKey for SessionKey {
    type Group = ([u8; USER_ID_LEN], u8);
    fn group(&self) -> Self::Group {
        (self.0, self.1)
    }
}

const LIMITS: replay::Limits = replay::Limits {
    per_group: MAX_SESSIONS_PER_STREAM,
    total: MAX_SESSIONS_TOTAL,
    retired: MAX_RETIRED,
};

/// Receive side under one 'video' export.
pub struct ReceiverCore {
    kdf: ShareKdf,
    sessions: SessionTable<SessionKey, ChaCha20Poly1305>,
}

impl ReceiverCore {
    pub fn new(secret: &[u8]) -> Result<Self, ShareError> {
        Ok(ReceiverCore { kdf: ShareKdf::new(secret)?, sessions: SessionTable::new(LIMITS) })
    }

    pub fn kdf(&self) -> &ShareKdf {
        &self.kdf
    }

    pub fn matches_secret(&self, secret: &[u8]) -> bool {
        self.kdf.matches(secret)
    }

    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    /// New subscription: forget all replay state (see module docs).
    pub fn reset(&mut self) {
        self.sessions.clear();
    }

    /// Authenticates (AAD incl. the outer flags/ts and the subscribed
    /// sharer), replay-checks, skew-checks and decrypts one v2 payload.
    /// Returns the frame's kind with the plaintext.
    pub fn open(
        &mut self,
        frame: &[u8],
        outer_flags: u8,
        outer_ts: u32,
        sharer: &[u8; USER_ID_LEN],
        now_ms: u64,
    ) -> Result<(u8, Vec<u8>), ShareError> {
        let parsed = parse(frame)?;
        let fresh = parsed.ts_ms.abs_diff(now_ms) <= MAX_SKEW_MS;
        let aad = aad_for(parsed.header, outer_flags, outer_ts, sharer);
        let nonce = nonce_for(parsed.seq);
        let kdf = &self.kdf;
        let (kind, session_id) = (parsed.kind, parsed.session_id);
        let pt = self
            .sessions
            .open(
                SessionKey(*sharer, kind, session_id),
                parsed.seq,
                fresh,
                || kdf.session_cipher(kind, &session_id),
                |cipher| {
                    cipher
                        .decrypt(Nonce::from_slice(&nonce), Payload { msg: parsed.body, aad: &aad })
                        .map_err(|_| ShareError::AuthFailed)
                },
            )
            .map_err(|e| match e {
                OpenError::Replay => ShareError::Replay,
                OpenError::Stale => ShareError::StaleTimestamp,
                OpenError::Decrypt(e) => e,
            })?;
        Ok((kind, pt))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_792_800_000_000;
    const ALICE: &str = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const BOB: &str = "0a0b0c0d-0e0f-4a1b-9c2d-3e4f5a6b7c8d";
    const KEY: u8 = 0x00;
    const DELTA: u8 = 0x01;
    const AUDIO_FLAGS: u8 = 0x05;

    fn secret(b: u8) -> [u8; 32] {
        [b; 32]
    }
    fn uid(s: &str) -> [u8; 16] {
        parse_user_id(s).unwrap()
    }
    fn tx(sec: u8, kind: u8, who: &str) -> SenderCore {
        SenderCore::new(&secret(sec), kind, uid(who)).unwrap()
    }
    fn rx(sec: u8) -> ReceiverCore {
        ReceiverCore::new(&secret(sec)).unwrap()
    }

    #[test]
    fn roundtrip_and_header_layout() {
        let mut t = tx(1, KIND_VIDEO, ALICE);
        let mut r = rx(1);
        for i in 0..5u8 {
            let f = t.seal(&[i; 50], DELTA, 1000 + i as u32, NOW).unwrap();
            assert_eq!(HEADER_LEN, 34);
            assert_eq!(f.len(), HEADER_LEN + 50 + TAG_LEN);
            assert_eq!(f[0], VERSION);
            assert_eq!(f[1], KIND_VIDEO);
            assert_eq!(&f[2..18], &t.session_id());
            assert_eq!(u64::from_be_bytes(f[18..26].try_into().unwrap()), i as u64);
            assert_eq!(u64::from_be_bytes(f[26..34].try_into().unwrap()), NOW);
            let (kind, pt) = r.open(&f, DELTA, 1000 + i as u32, &uid(ALICE), NOW).unwrap();
            assert_eq!((kind, pt), (KIND_VIDEO, vec![i; 50]));
        }
    }

    #[test]
    fn tamper_rejected() {
        let mut t = tx(2, KIND_VIDEO, ALICE);
        let f = t.seal(b"frame", DELTA, 77, NOW).unwrap();
        let mut r = rx(2);
        let a = uid(ALICE);
        // outer flags flipped (delta → key), outer ts changed
        assert_eq!(r.open(&f, KEY, 77, &a, NOW), Err(ShareError::AuthFailed));
        assert_eq!(r.open(&f, DELTA, 78, &a, NOW), Err(ShareError::AuthFailed));
        // header fields: seq, ts, session id
        for idx in [5usize, 25, 33] {
            let mut m = f.clone();
            m[idx] ^= 1;
            assert_eq!(r.open(&m, DELTA, 77, &a, NOW), Err(ShareError::AuthFailed), "byte {idx}");
        }
        // body and tag
        let mut m = f.clone();
        m[HEADER_LEN] ^= 1;
        assert_eq!(r.open(&m, DELTA, 77, &a, NOW), Err(ShareError::AuthFailed));
        let mut m = f.clone();
        *m.last_mut().unwrap() ^= 1;
        assert_eq!(r.open(&m, DELTA, 77, &a, NOW), Err(ShareError::AuthFailed));
        // wrong key
        assert_eq!(rx(3).open(&f, DELTA, 77, &a, NOW), Err(ShareError::AuthFailed));
        // nothing above created state; the genuine frame still opens
        assert_eq!(r.session_count(), 0);
        assert_eq!(r.open(&f, DELTA, 77, &a, NOW).unwrap().1, b"frame".to_vec());
    }

    #[test]
    fn replay_rejected_and_reorder_tolerated() {
        let mut t = tx(4, KIND_VIDEO, ALICE);
        let a = uid(ALICE);
        let fs: Vec<_> = (0..3).map(|i| t.seal(&[i], DELTA, i as u32, NOW).unwrap()).collect();
        let mut r = rx(4);
        assert!(r.open(&fs[0], DELTA, 0, &a, NOW).is_ok());
        assert!(r.open(&fs[2], DELTA, 2, &a, NOW).is_ok());
        assert_eq!(r.open(&fs[2], DELTA, 2, &a, NOW), Err(ShareError::Replay));
        assert_eq!(r.open(&fs[0], DELTA, 0, &a, NOW), Err(ShareError::Replay));
        assert!(r.open(&fs[1], DELTA, 1, &a, NOW).is_ok());
        assert_eq!(r.open(&fs[1], DELTA, 1, &a, NOW), Err(ShareError::Replay));
    }

    #[test]
    fn stale_timestamp_bounds() {
        let a = uid(ALICE);
        let mut r = rx(5);
        let mut t = tx(5, KIND_VIDEO, ALICE);
        let edge = t.seal(b"edge", DELTA, 0, NOW - MAX_SKEW_MS).unwrap();
        assert!(r.open(&edge, DELTA, 0, &a, NOW).is_ok());
        let mut t = tx(5, KIND_VIDEO, ALICE);
        let ahead = t.seal(b"ahead", DELTA, 0, NOW + MAX_SKEW_MS).unwrap();
        assert!(r.open(&ahead, DELTA, 0, &a, NOW).is_ok());
        let mut t = tx(5, KIND_VIDEO, ALICE);
        let old = t.seal(b"old", DELTA, 0, NOW - MAX_SKEW_MS - 1).unwrap();
        assert_eq!(r.open(&old, DELTA, 0, &a, NOW), Err(ShareError::StaleTimestamp));
        let mut t = tx(5, KIND_VIDEO, ALICE);
        let fut = t.seal(b"fut", DELTA, 0, NOW + MAX_SKEW_MS + 1).unwrap();
        assert_eq!(r.open(&fut, DELTA, 0, &a, NOW), Err(ShareError::StaleTimestamp));
        // stale frames of unknown sessions create no state
        assert_eq!(r.session_count(), 2);
        // rewriting the timestamp to look fresh breaks the tag
        let mut m = old.clone();
        m[TS_OFFSET..HEADER_LEN].copy_from_slice(&NOW.to_be_bytes());
        assert_eq!(r.open(&m, DELTA, 0, &a, NOW), Err(ShareError::AuthFailed));
    }

    #[test]
    fn cross_sharer_rejected() {
        // A frame of Alice's stream delivered on the subscription to Bob.
        let mut t = tx(6, KIND_VIDEO, ALICE);
        let f = t.seal(b"alice", KEY, 9, NOW).unwrap();
        let mut r = rx(6);
        assert_eq!(r.open(&f, KEY, 9, &uid(BOB), NOW), Err(ShareError::AuthFailed));
        assert_eq!(r.open(&f, KEY, 9, &uid(ALICE), NOW).unwrap().1, b"alice".to_vec());
    }

    #[test]
    fn cross_kind_rejected() {
        // Same session id under both kinds: different keys, and relabelling
        // the kind byte (audio ↔ video) fails.
        let sid = [0x42u8; SESSION_ID_LEN];
        let kdf = ShareKdf::new(&secret(7)).unwrap();
        let mut v = SenderCore::from_kdf(kdf.clone(), KIND_VIDEO, uid(ALICE), sid).unwrap();
        let mut au = SenderCore::from_kdf(kdf, KIND_AUDIO, uid(ALICE), sid).unwrap();
        let fv = v.seal(&[0u8; 32], AUDIO_FLAGS, 1, NOW).unwrap();
        let fa = au.seal(&[0u8; 32], AUDIO_FLAGS, 1, NOW).unwrap();
        assert_ne!(fv[HEADER_LEN..HEADER_LEN + 32], fa[HEADER_LEN..HEADER_LEN + 32]);
        let mut relabelled = fv.clone();
        relabelled[KIND_OFFSET] = KIND_AUDIO;
        let mut r = rx(7);
        assert_eq!(r.open(&relabelled, AUDIO_FLAGS, 1, &uid(ALICE), NOW), Err(ShareError::AuthFailed));
        assert_eq!(r.open(&fa, AUDIO_FLAGS, 1, &uid(ALICE), NOW).unwrap().0, KIND_AUDIO);
        assert_eq!(r.open(&fv, AUDIO_FLAGS, 1, &uid(ALICE), NOW).unwrap().0, KIND_VIDEO);
    }

    #[test]
    fn reserved_and_unknown_kinds_rejected() {
        for k in [KIND_PROGRAM, KIND_TILE, 0x00, 0x03, 0xff] {
            assert!(matches!(SenderCore::new(&secret(8), k, uid(ALICE)), Err(ShareError::UnsupportedKind)));
            let mut t = tx(8, KIND_VIDEO, ALICE);
            let mut f = t.seal(b"x", KEY, 0, NOW).unwrap();
            f[KIND_OFFSET] = k;
            assert_eq!(rx(8).open(&f, KEY, 0, &uid(ALICE), NOW), Err(ShareError::UnsupportedKind));
        }
    }

    #[test]
    fn cached_keyframe_age() {
        // media-rust re-sends the sharer's last keyframe to each new viewer.
        let mut t = tx(9, KIND_VIDEO, ALICE);
        let key = t.seal(b"keyframe", KEY, 500, NOW).unwrap();
        let a = uid(ALICE);
        // Viewer 1 sees it live.
        let mut r = rx(9);
        assert!(r.open(&key, KEY, 500, &a, NOW).is_ok());
        // Viewer 2 subscribes 20 s later: the cached copy still opens.
        assert!(rx(9).open(&key, KEY, 500, &a, NOW + 20_000).is_ok());
        // A subscriber 31 s later drops it (and waits for a fresh keyframe).
        assert_eq!(rx(9).open(&key, KEY, 500, &a, NOW + 31_000), Err(ShareError::StaleTimestamp));
        // Viewer 1 re-subscribes to the same sharer: reset() starts a fresh
        // window, so the re-sent cached keyframe plays again (once).
        assert_eq!(r.open(&key, KEY, 500, &a, NOW + 1_000), Err(ShareError::Replay));
        r.reset();
        assert!(r.open(&key, KEY, 500, &a, NOW + 1_000).is_ok());
        assert_eq!(r.open(&key, KEY, 500, &a, NOW + 1_000), Err(ShareError::Replay));
    }

    #[test]
    fn v1_and_malformed_rejected() {
        let mut r = rx(10);
        let a = uid(ALICE);
        let v1 = vec![0x9au8; 60];
        assert_eq!(r.open(&v1, KEY, 0, &a, NOW), Err(ShareError::UnsupportedVersion));
        let mut v1b = v1.clone();
        v1b[0] = VERSION;
        v1b[1] = KIND_VIDEO;
        assert_eq!(r.open(&v1b, KEY, 0, &a, NOW), Err(ShareError::AuthFailed));
        assert_eq!(r.open(&[], KEY, 0, &a, NOW), Err(ShareError::Malformed));
        assert_eq!(r.open(&[VERSION; HEADER_LEN + TAG_LEN - 1], KEY, 0, &a, NOW), Err(ShareError::Malformed));
    }

    #[test]
    fn sequence_exhaustion_and_monotonic_ts() {
        let mut t = tx(11, KIND_AUDIO, ALICE);
        let a = t.seal(b"a", AUDIO_FLAGS, 0, NOW).unwrap();
        let b = t.seal(b"b", AUDIO_FLAGS, 0, NOW - 5_000).unwrap();
        assert_eq!(a[TS_OFFSET..HEADER_LEN], b[TS_OFFSET..HEADER_LEN]);
        t.force_next_seq(u64::MAX - 1);
        assert!(t.seal(b"last", AUDIO_FLAGS, 0, NOW).is_ok());
        assert_eq!(t.seal(b"over", AUDIO_FLAGS, 0, NOW), Err(ShareError::SequenceExhausted));
    }

    #[test]
    fn user_id_parsing_and_secret_checks() {
        assert_eq!(uid(ALICE)[0], 0x6f);
        assert_eq!(uid(&ALICE.to_uppercase()), uid(ALICE));
        for bad in ["", "not-a-uuid", "6f1c2a3b4d5e4f608a7b9c0d1e2f3a4b", "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4g"] {
            assert_eq!(parse_user_id(bad), Err(ShareError::BadUserId));
        }
        assert!(ReceiverCore::new(&[0u8; 16]).is_err());
        let r = rx(12);
        assert!(r.matches_secret(&secret(12)));
        assert!(!r.matches_secret(&secret(13)));
    }

    #[test]
    fn per_stream_session_cap_keeps_evicted_replays_out() {
        let a = uid(ALICE);
        let mut r = rx(14);
        let mut first = tx(14, KIND_VIDEO, ALICE);
        let old = first.seal(b"f0", DELTA, 0, NOW).unwrap();
        assert!(r.open(&old, DELTA, 0, &a, NOW).is_ok());
        for _ in 0..MAX_SESSIONS_PER_STREAM {
            let mut s = tx(14, KIND_VIDEO, ALICE);
            assert!(r.open(&s.seal(b"n", DELTA, 0, NOW).unwrap(), DELTA, 0, &a, NOW).is_ok());
        }
        assert_eq!(r.session_count(), MAX_SESSIONS_PER_STREAM);
        assert_eq!(r.open(&old, DELTA, 0, &a, NOW), Err(ShareError::Replay));
        // Another kind of the same sharer is a separate stream.
        let mut au = tx(14, KIND_AUDIO, ALICE);
        assert!(r.open(&au.seal(b"a", AUDIO_FLAGS, 0, NOW).unwrap(), AUDIO_FLAGS, 0, &a, NOW).is_ok());
    }
}
