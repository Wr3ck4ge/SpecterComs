use wasm_bindgen::prelude::*;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce
};
use getrandom::getrandom;

pub mod relay_audio;

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

/// Generates a secure random 32-byte key for group rotation
#[wasm_bindgen]
pub fn generate_group_key() -> Result<Vec<u8>, JsValue> {
    let mut key = vec![0u8; 32];
    if let Err(_) = getrandom(&mut key) {
        return Err(JsValue::from_str("Failed to generate key"));
    }
    Ok(key)
}
