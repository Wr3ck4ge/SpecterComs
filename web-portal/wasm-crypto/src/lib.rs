use wasm_bindgen::prelude::*;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
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
