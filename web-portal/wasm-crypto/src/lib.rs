use wasm_bindgen::prelude::*;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce
};
use getrandom::getrandom;

pub mod relay_audio;
pub mod replay;
pub mod share_frame;

#[wasm_bindgen]
pub struct SFrameCrypto {
    cipher: ChaCha20Poly1305,
}

#[wasm_bindgen]
impl SFrameCrypto {
    /// Initialize a new cipher with a 32-byte key
    #[wasm_bindgen(constructor)]
    pub fn new(key: &[u8]) -> Result<SFrameCrypto, JsValue> {
        if key.len() != 32 {
            return Err(JsValue::from_str("Key must be exactly 32 bytes"));
        }
        let key = Key::from_slice(key);
        let cipher = ChaCha20Poly1305::new(key);
        Ok(SFrameCrypto { cipher })
    }

    /// Encrypt a frame: Returns [12-byte Nonce | Ciphertext | 16-byte Tag]
    pub fn encrypt(&self, payload: &[u8]) -> Result<Vec<u8>, JsValue> {
        let mut nonce_bytes = [0u8; 12];
        if let Err(_) = getrandom(&mut nonce_bytes) {
            return Err(JsValue::from_str("Failed to generate random nonce"));
        }
        
        let nonce = Nonce::from_slice(&nonce_bytes);
        
        // In a real SFrame, we'd add metadata to 'associated_data' (AAD)
        // like SSRC or frame counters to prevent replay attacks.
        let ciphertext = self.cipher.encrypt(nonce, payload)
            .map_err(|_| JsValue::from_str("Encryption failed"))?;

        // Format: Nonce + Ciphertext (which includes the Poly1305 tag at the end)
        let mut result = Vec::with_capacity(nonce_bytes.len() + ciphertext.len());
        result.extend_from_slice(&nonce_bytes);
        result.extend_from_slice(&ciphertext);
        
        Ok(result)
    }

    /// Decrypt a frame: Expects [12-byte Nonce | Ciphertext | 16-byte Tag]
    pub fn decrypt(&self, encrypted_frame: &[u8]) -> Result<Vec<u8>, JsValue> {
        if encrypted_frame.len() < 12 + 16 {
            return Err(JsValue::from_str("Encrypted frame is too short"));
        }

        let (nonce_bytes, ciphertext) = encrypted_frame.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);

        let plaintext = self.cipher.decrypt(nonce, ciphertext)
            .map_err(|_| JsValue::from_str("Decryption failed / Invalid Tag"))?;

        Ok(plaintext)
    }
}

// ── Relay-mode voice (wire v3) ─────────────────────────────────────────────
// The v1 audio framing (SFrameCrypto::encrypt_framed / decrypt_framed: group
// export used directly as the key, nonce = (ssrc, sequence)) re-used nonces
// across reconnects, devices and cascade frequency switches and has been
// removed outright — see relay_audio.rs for the analysis and the v2 design.
// Audio now uses a per-sending-session derived key with an internal 64-bit
// counter (RelayAudioSender) and an authenticated replay window per
// (ssrc, session) on receive (RelayAudioReceiver).

fn relay_err(e: relay_audio::RelayError) -> JsValue {
    JsValue::from_str(e.code())
}

/// One sending session for one lane (channel 'audio' export, or the event
/// 'audio-cascade' export when `is_global_broadcast`). Draws a fresh random
/// 128-bit session id at construction; owns its sequence counter.
#[wasm_bindgen]
pub struct RelayAudioSender {
    inner: relay_audio::SenderCore,
}

#[wasm_bindgen]
impl RelayAudioSender {
    #[wasm_bindgen(constructor)]
    pub fn new(group_secret: &[u8], is_global_broadcast: bool) -> Result<RelayAudioSender, JsValue> {
        relay_audio::SenderCore::new(group_secret, relay_audio::Lane::from_global_broadcast(is_global_broadcast))
            .map(|inner| RelayAudioSender { inner })
            .map_err(relay_err)
    }

    /// Returns the v3 wire payload:
    /// [0x03 | session_id(16) | seq(8) | ts_ms(8) | ct | tag(16)], stamped
    /// with the current wall clock (Date.now()).
    /// `ssrc` must be the sender's canonical ssrc (what media-rust stamps).
    pub fn seal(&mut self, payload: &[u8], ssrc: u32) -> Result<Vec<u8>, JsValue> {
        self.inner.seal(payload, ssrc, relay_audio::ms_from_f64(js_sys::Date::now())).map_err(relay_err)
    }

    /// seal() with an explicit sender clock (ms since the Unix epoch) — for
    /// the Node harness's skew tests. Still clamped non-decreasing.
    pub fn seal_at(&mut self, payload: &[u8], ssrc: u32, now_ms: f64) -> Result<Vec<u8>, JsValue> {
        self.inner.seal(payload, ssrc, relay_audio::ms_from_f64(now_ms)).map_err(relay_err)
    }

    /// True when `group_secret` is the secret this session was derived from —
    /// lets a same-epoch key refresh keep the running session.
    pub fn matches_secret(&self, group_secret: &[u8]) -> bool {
        self.inner.matches_secret(group_secret)
    }

    #[wasm_bindgen(getter)]
    pub fn session_id(&self) -> Vec<u8> {
        self.inner.session_id().to_vec()
    }

    #[wasm_bindgen(getter)]
    pub fn is_global_broadcast(&self) -> bool {
        self.inner.lane() == relay_audio::Lane::Cascade
    }
}

/// Receive side for one lane under one group secret. Keeps a bounded set of
/// per-(ssrc, session) keys and replay windows — reuse the same instance for
/// as long as the secret is unchanged (see matches_secret), or replay state
/// is lost.
#[wasm_bindgen]
pub struct RelayAudioReceiver {
    inner: relay_audio::ReceiverCore,
}

#[wasm_bindgen]
impl RelayAudioReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new(group_secret: &[u8], is_global_broadcast: bool) -> Result<RelayAudioReceiver, JsValue> {
        relay_audio::ReceiverCore::new(group_secret, relay_audio::Lane::from_global_broadcast(is_global_broadcast))
            .map(|inner| RelayAudioReceiver { inner })
            .map_err(relay_err)
    }

    /// Authenticate + replay-check + skew-check (vs Date.now()) + decrypt.
    /// Errors are one of the stable codes "unsupported-version", "malformed",
    /// "replay", "auth-failed", "stale-timestamp".
    pub fn open(&mut self, frame: &[u8], ssrc: u32) -> Result<Vec<u8>, JsValue> {
        self.inner.open(frame, ssrc, relay_audio::ms_from_f64(js_sys::Date::now())).map_err(relay_err)
    }

    /// open() with an explicit receiver clock — for the harness's skew tests.
    pub fn open_at(&mut self, frame: &[u8], ssrc: u32, now_ms: f64) -> Result<Vec<u8>, JsValue> {
        self.inner.open(frame, ssrc, relay_audio::ms_from_f64(now_ms)).map_err(relay_err)
    }

    /// Max accepted |sender timestamp − receiver clock| in ms.
    #[wasm_bindgen(getter)]
    pub fn max_skew_ms(&self) -> f64 {
        relay_audio::MAX_SKEW_MS as f64
    }

    pub fn matches_secret(&self, group_secret: &[u8]) -> bool {
        self.inner.matches_secret(group_secret)
    }

    #[wasm_bindgen(getter)]
    pub fn is_global_broadcast(&self) -> bool {
        self.inner.lane() == relay_audio::Lane::Cascade
    }

    #[wasm_bindgen(getter)]
    pub fn session_count(&self) -> usize {
        self.inner.session_count()
    }
}

// ── Screen-share frames (wire v2, share_frame.rs) ──────────────────────────
// v1 share frames stay on SFrameCrypto above (random nonce, no AAD); a stream
// declares v2 with `"fv": 2` in its header JSON and the receiver picks the
// opener from that (docs/WAVE3_FORMAT_V2_FRANKING_DESIGN.md §3.4).

fn share_err(e: share_frame::ShareError) -> JsValue {
    JsValue::from_str(e.code())
}

/// One sending session for one kind (0x01 video, 0x02 share audio) of one
/// share: fresh random session id, own derived key and 64-bit counter.
#[wasm_bindgen]
pub struct ShareFrameSender {
    inner: share_frame::SenderCore,
}

#[wasm_bindgen]
impl ShareFrameSender {
    /// `video_secret`: the 32-byte MLS 'video' export (or the op key);
    /// `sharer_user_id`: this user's id (UUID string).
    #[wasm_bindgen(constructor)]
    pub fn new(video_secret: &[u8], kind: u8, sharer_user_id: &str) -> Result<ShareFrameSender, JsValue> {
        let sharer = share_frame::parse_user_id(sharer_user_id).map_err(share_err)?;
        share_frame::SenderCore::new(video_secret, kind, sharer)
            .map(|inner| ShareFrameSender { inner })
            .map_err(share_err)
    }

    /// Seals `payload` for the wire unit `[size][outer_flags][outer_ts][payload]`
    /// (or the share-audio datagram), stamped with Date.now().
    pub fn seal(&mut self, payload: &[u8], outer_flags: u8, outer_ts: u32) -> Result<Vec<u8>, JsValue> {
        self.inner
            .seal(payload, outer_flags, outer_ts, relay_audio::ms_from_f64(js_sys::Date::now()))
            .map_err(share_err)
    }

    /// seal() with an explicit sender clock (tests).
    pub fn seal_at(&mut self, payload: &[u8], outer_flags: u8, outer_ts: u32, now_ms: f64) -> Result<Vec<u8>, JsValue> {
        self.inner.seal(payload, outer_flags, outer_ts, relay_audio::ms_from_f64(now_ms)).map_err(share_err)
    }

    pub fn matches_secret(&self, video_secret: &[u8]) -> bool {
        self.inner.matches_secret(video_secret)
    }

    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> u8 {
        self.inner.kind()
    }

    #[wasm_bindgen(getter)]
    pub fn session_id(&self) -> Vec<u8> {
        self.inner.session_id().to_vec()
    }
}

/// Receive side for v2 share frames under one 'video' export. Replay windows
/// are per (sharer, kind, session); call reset() when a new subscription
/// starts (media-rust re-sends its cached keyframe to every new viewer).
#[wasm_bindgen]
pub struct ShareFrameReceiver {
    inner: share_frame::ReceiverCore,
}

#[wasm_bindgen]
impl ShareFrameReceiver {
    #[wasm_bindgen(constructor)]
    pub fn new(video_secret: &[u8]) -> Result<ShareFrameReceiver, JsValue> {
        share_frame::ReceiverCore::new(video_secret)
            .map(|inner| ShareFrameReceiver { inner })
            .map_err(share_err)
    }

    /// Authenticate + replay-check + skew-check (vs Date.now()) + decrypt one
    /// v2 payload. `outer_flags` / `outer_ts` are the wire unit's (or
    /// datagram's) flags byte and u32 timestamp; `sharer_user_id` is the
    /// sharer this subscription targets (UUID string). `expected_kind` 0 =
    /// any accepted kind, else the frame's kind must equal it. Errors are
    /// stable codes: "unsupported-version", "unsupported-kind", "malformed",
    /// "bad-user-id", "replay", "auth-failed", "stale-timestamp".
    pub fn open(&mut self, frame: &[u8], outer_flags: u8, outer_ts: u32, sharer_user_id: &str, expected_kind: u8) -> Result<Vec<u8>, JsValue> {
        self.open_at(frame, outer_flags, outer_ts, sharer_user_id, expected_kind, js_sys::Date::now())
    }

    /// open() with an explicit receiver clock (tests).
    pub fn open_at(&mut self, frame: &[u8], outer_flags: u8, outer_ts: u32, sharer_user_id: &str, expected_kind: u8, now_ms: f64) -> Result<Vec<u8>, JsValue> {
        let sharer = share_frame::parse_user_id(sharer_user_id).map_err(share_err)?;
        // Kind is checked before opening so a wrong-kind frame touches no state.
        if expected_kind != 0 {
            if let Ok(p) = share_frame::parse(frame) {
                if p.kind != expected_kind {
                    return Err(share_err(share_frame::ShareError::UnsupportedKind));
                }
            }
        }
        self.inner
            .open(frame, outer_flags, outer_ts, &sharer, relay_audio::ms_from_f64(now_ms))
            .map(|(_, pt)| pt)
            .map_err(share_err)
    }

    /// A sender for this user's own share under the same secret (S8), so the
    /// JS side never needs to hold the raw export.
    pub fn sender(&self, kind: u8, sharer_user_id: &str) -> Result<ShareFrameSender, JsValue> {
        let sharer = share_frame::parse_user_id(sharer_user_id).map_err(share_err)?;
        let mut sid = [0u8; share_frame::SESSION_ID_LEN];
        getrandom(&mut sid).map_err(|_| share_err(share_frame::ShareError::Rng))?;
        share_frame::SenderCore::from_kdf(self.inner.kdf().clone(), kind, sharer, sid)
            .map(|inner| ShareFrameSender { inner })
            .map_err(share_err)
    }

    pub fn reset(&mut self) {
        self.inner.reset();
    }

    pub fn matches_secret(&self, video_secret: &[u8]) -> bool {
        self.inner.matches_secret(video_secret)
    }

    #[wasm_bindgen(getter)]
    pub fn max_skew_ms(&self) -> f64 {
        share_frame::MAX_SKEW_MS as f64
    }

    #[wasm_bindgen(getter)]
    pub fn session_count(&self) -> usize {
        self.inner.session_count()
    }
}

/// Generates a secure random 32-byte key for group rotation
#[wasm_bindgen]
pub fn generate_group_key() -> Result<Vec<u8>, JsValue> {
    let mut key = vec![0u8; 32];
    if let Err(_) = getrandom(&mut key) {
        return Err(JsValue::from_str("Failed to generate key"));
    }
    Ok(key)
}
