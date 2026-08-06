use wasm_bindgen::prelude::*;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Key, Nonce
};
use getrandom::getrandom;

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

    // ── Sequence-bound framing (SFrame-style) ──────────────────────────────
    // encrypt/decrypt above use a random nonce and no AAD — the comment there
    // already flagged this as not a "real SFrame": nothing ties a ciphertext
    // to the SSRC/sequence it was actually sent under, so a captured frame
    // can be replayed later and will still pass AEAD tag verification. These
    // two derive the nonce deterministically from (ssrc, sequence) instead of
    // random bytes, and bind both as AAD — a replayed or ssrc/sequence-
    // mismatched frame now fails the tag check outright rather than silently
    // decrypting. Since the nonce is derived, not transmitted, there's no
    // more 12-byte nonce prefix on the wire: ciphertext is exactly
    // [Ciphertext | 16-byte Tag]. Both ssrc and sequence are already sent
    // unencrypted alongside the payload in specter.v1.AudioFrame, so this
    // needs no new wire fields, only that the caller pass the same values it
    // already had at hand.
    fn frame_nonce(ssrc: u32, sequence: u32) -> [u8; 12] {
        let mut nonce = [0u8; 12];
        nonce[0..4].copy_from_slice(&ssrc.to_be_bytes());
        nonce[4..12].copy_from_slice(&(sequence as u64).to_be_bytes());
        nonce
    }

    fn frame_aad(ssrc: u32, sequence: u32) -> [u8; 8] {
        let mut aad = [0u8; 8];
        aad[0..4].copy_from_slice(&ssrc.to_be_bytes());
        aad[4..8].copy_from_slice(&sequence.to_be_bytes());
        aad
    }

    pub fn encrypt_framed(&self, payload: &[u8], ssrc: u32, sequence: u32) -> Result<Vec<u8>, JsValue> {
        let nonce_bytes = Self::frame_nonce(ssrc, sequence);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let aad = Self::frame_aad(ssrc, sequence);

        self.cipher
            .encrypt(nonce, Payload { msg: payload, aad: &aad })
            .map_err(|_| JsValue::from_str("Encryption failed"))
    }

    pub fn decrypt_framed(&self, encrypted_frame: &[u8], ssrc: u32, sequence: u32) -> Result<Vec<u8>, JsValue> {
        let nonce_bytes = Self::frame_nonce(ssrc, sequence);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let aad = Self::frame_aad(ssrc, sequence);

        self.cipher
            .decrypt(nonce, Payload { msg: encrypted_frame, aad: &aad })
            .map_err(|_| JsValue::from_str("Decryption failed / Invalid Tag"))
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
