// msgcache.rs — local, per-channel, encrypted-at-rest message history cache.
//
// The server deliberately never persists chat messages (relay-only — see
// identity-node's messageController.ts and the 000026_relay_only_messaging
// migration), so there is no server-side backfill to lean on. This module is
// the client-side substitute: as messages are decrypted (today: only while
// the foreground webview is open, via the existing JS/WASM MLS path; later:
// also by a background Rust task while the window is torn down — see the
// native mls-crypto path dependency and decrypt_impl), they get appended
// here so channel history survives an app restart.
//
// Own dedicated keyring entry (separate from CREDS_KEYRING_SERVICE and
// MLS_KEYRING_SERVICE in lib.rs) — same "compromising one store shouldn't
// expose the others" principle already used for those two.
//
// Format: one channel per file, append-only. Each line is
// base64(12-byte nonce || AES-256-GCM ciphertext) of one JSON message record,
// newline-terminated. Base64 avoids needing a length-prefixed binary framing
// just to keep ciphertext bytes (which may contain raw newlines) line-safe.

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use rand::RngCore;
use std::path::{Path, PathBuf};

const MSGCACHE_KEYRING_SERVICE: &str = "specter-coms-msgcache";
const MSGCACHE_KEYRING_USER: &str = "cache-key";

fn msgcache_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(MSGCACHE_KEYRING_SERVICE, MSGCACHE_KEYRING_USER)
        .map_err(|e| format!("keyring entry error: {e}"))?;

    if let Ok(existing) = entry.get_secret() {
        if existing.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&existing);
            return Ok(key);
        }
    }

    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    entry.set_secret(&key).map_err(|e| format!("keyring set error: {e}"))?;
    Ok(key)
}

fn channel_path(app_data_dir: &Path, channel_id: &str) -> Result<PathBuf, String> {
    // channel_id is always a server-issued UUID in every call site, but guard
    // against path traversal regardless of caller trust — this only ever
    // needs to be a bare filename component.
    if channel_id.is_empty() || channel_id.contains(['/', '\\', '.']) {
        return Err("invalid channel id".to_string());
    }
    let dir = app_data_dir.join("msgcache");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{channel_id}.log")))
}

/// Encrypts and appends one message record to a channel's local cache.
/// Shared by the foreground `msgcache_append` Tauri command and (later) the
/// background sync task, so there is exactly one writer implementation.
pub fn append(app_data_dir: &Path, channel_id: &str, message: &serde_json::Value) -> Result<(), String> {
    let path = channel_path(app_data_dir, channel_id)?;

    let key_bytes = msgcache_key()?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    let ciphertext = cipher.encrypt(nonce, plaintext.as_slice())
        .map_err(|e| format!("encrypt error: {e}"))?;

    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ciphertext);

    use std::io::Write;
    use base64::Engine;
    let line = base64::engine::general_purpose::STANDARD.encode(&blob);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())?;
    Ok(())
}

/// Reads and decrypts up to `limit` most-recent messages for a channel, in
/// original (oldest-first) order.
pub fn read(app_data_dir: &Path, channel_id: &str, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let path = channel_path(app_data_dir, channel_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let key_bytes = msgcache_key()?;
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let lines: Vec<&str> = contents.lines().filter(|l| !l.is_empty()).collect();
    let start = lines.len().saturating_sub(limit);

    use base64::Engine;
    let mut out = Vec::new();
    for line in &lines[start..] {
        let blob = match base64::engine::general_purpose::STANDARD.decode(line) {
            Ok(b) => b,
            Err(_) => continue, // corrupt/partial line (e.g. a crash mid-write) — skip, not fatal
        };
        if blob.len() < 13 { continue; }
        let nonce = Nonce::from_slice(&blob[..12]);
        let plaintext = match cipher.decrypt(nonce, &blob[12..]) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&plaintext) {
            out.push(json);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn msgcache_append(app: tauri::AppHandle, channel_id: String, message: serde_json::Value) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    append(&dir, &channel_id, &message)
}

#[tauri::command]
pub fn msgcache_read(app: tauri::AppHandle, channel_id: String, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    read(&dir, &channel_id, limit)
}

/// Reads and decrypts every channel's cache in one call — used once on app
/// launch (or when a tray_light-destroyed window is reopened) to drain
/// whatever the background sync task collected while the window was closed
/// into messageStore.js's IndexedDB, so the existing chat UI just picks it up
/// with no separate history system to maintain. Non-destructive; pair with
/// msgcache_clear_all once the caller has confirmed the drain succeeded.
#[tauri::command]
pub fn msgcache_read_all(app: tauri::AppHandle) -> Result<std::collections::HashMap<String, Vec<serde_json::Value>>, String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data_dir.join("msgcache");
    let mut out = std::collections::HashMap::new();
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(out) };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if path.extension().and_then(|e| e.to_str()) != Some("log") { continue; }
        let messages = read(&app_data_dir, stem, usize::MAX)?;
        if !messages.is_empty() {
            out.insert(stem.to_string(), messages);
        }
    }
    Ok(out)
}

/// Deletes every channel's local cache file. Called after msgcache_read_all's
/// contents have been confirmed saved into IndexedDB — two-step (read then
/// clear) rather than read-and-delete-together so a failure on the JS side
/// (e.g. IndexedDB write error) can't silently lose messages that were never
/// actually persisted anywhere else.
#[tauri::command]
pub fn msgcache_clear_all(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("msgcache");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(()) };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("log") {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}
