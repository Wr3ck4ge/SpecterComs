// mls_store.rs — encrypted, crash-safe persistence of this device's MLS state.
//
// The MLS device state (signature private key, plus every group's ratchet
// tree/epoch secrets this device holds) is one opaque blob produced by the
// mls-crypto WASM module (web-portal/src/mlsSession.js owns it in memory).
// Here it is AES-256-GCM encrypted with its own OS-keyring-held key — a
// distinct keyring entry from lib.rs's creds_key(), so compromising one
// doesn't expose the other — and written to `.specter_mls_state` in the
// signed-in account's directory, `<app data>/accounts/<userId>/` (see "Per-
// account layout + legacy migration" below). One keyring key covers every
// account on the PC; the state, not the key, is what's per account.
//
// Losing or rolling back this blob is not a cosmetic problem: a device whose
// state goes backwards past one of its OWN commits can never rejoin that
// epoch (MLS can't process its own commit), and a device whose state can't be
// decrypted at all used to silently mint a fresh identity under the same
// device id — a permanent lockout from every group. Hence:
//
// FAIL-CLOSED KEY HANDLING (resolve_key)
//   A new key is generated only when the keyring reports the entry genuinely
//   does not exist (keyring::Error::NoEntry) AND no committed state file
//   (main or .bak) exists. Any other keyring error, a wrong-length key, or
//   "no key but a state file exists" is an error, and nothing — neither the
//   keyring entry nor any state file — is overwritten in that case.
//
// LOAD SEMANTICS (load_state)
//   * no state file at all            -> Fresh (JS may generate an identity)
//   * state exists and decrypts       -> State(bytes)
//   * state exists but can't be read  -> Err("MLS_STATE_UNREADABLE: …" /
//     "MLS_KEY_MISSING: …" / "MLS_KEYRING_UNAVAILABLE: …" / …). JS must
//     never treat this as "fresh" — see ensureIdentity in mlsSession.js.
//
// ATOMIC WRITE (write_atomic)
//   1. write `<name>.tmp`, flush + fsync
//   2. copy current main -> `<name>.bak` (+ fsync) — the previous good state
//   3. rename tmp -> main (MoveFileExW REPLACE_EXISTING on Windows; atomic
//      rename(2) on unix, followed by a directory fsync)
//   The main file is therefore never missing or half-written once it has
//   existed. A tmp that survives a crash is always the most recent write
//   attempt (every completed write renames it away), so load prefers a tmp
//   that authenticates (AES-GCM's tag proves it's complete), then main, then
//   .bak.
//
// DURABILITY / COALESCING (mls_save_state)
//   JS sends every state change, raw bytes, with an `x-mls-durable` header.
//   * durable=1 (group ops: create/add/remove/welcome/commit/own-commit merge,
//     identity creation, encrypt): written + fsynced before the command
//     returns; any older pending buffer is discarded.
//   * durable=0 (decrypt-only changes): kept in memory (PENDING) and flushed
//     to disk at most FLUSH_DELAY later, and always on app exit / tray_light
//     hand-off / the next load. Losing one of these on a hard crash only
//     rolls a receive ratchet back (messages become re-decryptable), never an
//     epoch.
//   All file I/O and PENDING access happen under
//   background_sync::MLS_STATE_CRITICAL_SECTION, shared with the tray_light
//   background decrypt task and show_main_window.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Key, Nonce};
use rand::RngCore;

use crate::background_sync::{FOREGROUND_ACTIVE, MLS_STATE_CRITICAL_SECTION};
fn log(msg: &str) {
    #[cfg(not(test))]
    crate::write_setup_error(msg);
    #[cfg(test)]
    eprintln!("{msg}");
}

const MLS_KEYRING_SERVICE: &str = "specter-coms-mls";
const MLS_KEYRING_USER: &str = "identity-key";
pub const STATE_FILE_NAME: &str = ".specter_mls_state";
const FLUSH_DELAY: Duration = Duration::from_millis(200);

// ── Keyring abstraction (trait so the decision logic is unit-testable) ──────

pub trait SecretStore {
    /// Ok(None) ONLY when the store positively reports "no such entry".
    fn get(&self) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, secret: &[u8]) -> Result<(), String>;
}

pub struct KeyringSecretStore;

impl SecretStore for KeyringSecretStore {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        let entry = keyring::Entry::new(MLS_KEYRING_SERVICE, MLS_KEYRING_USER)
            .map_err(|e| format!("keyring entry error: {e}"))?;
        match entry.get_secret() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring read error: {e}")),
        }
    }

    fn set(&self, secret: &[u8]) -> Result<(), String> {
        let entry = keyring::Entry::new(MLS_KEYRING_SERVICE, MLS_KEYRING_USER)
            .map_err(|e| format!("keyring entry error: {e}"))?;
        entry.set_secret(secret).map_err(|e| format!("keyring set error: {e}"))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeyError {
    /// Keyring unreachable/locked/denied, or any error other than NoEntry.
    Unavailable(String),
    /// Keyring has no entry, but creating one isn't allowed (state exists, or
    /// the caller is only loading).
    Missing,
    /// Entry exists but isn't a 32-byte key.
    Corrupt(usize),
}

impl KeyError {
    fn to_js(&self) -> String {
        match self {
            KeyError::Unavailable(e) => format!("MLS_KEYRING_UNAVAILABLE: {e}"),
            KeyError::Missing => "MLS_KEY_MISSING: encrypted MLS state exists but its keyring key is gone — refusing to create a new key over it".to_string(),
            KeyError::Corrupt(n) => format!("MLS_KEY_CORRUPT: keyring entry is {n} bytes, expected 32"),
        }
    }
}

/// See the module doc comment ("FAIL-CLOSED KEY HANDLING").
pub fn resolve_key(store: &dyn SecretStore, committed_state_exists: bool, allow_create: bool) -> Result<[u8; 32], KeyError> {
    match store.get().map_err(KeyError::Unavailable)? {
        Some(v) if v.len() == 32 => {
            let mut key = [0u8; 32];
            key.copy_from_slice(&v);
            Ok(key)
        }
        Some(v) => Err(KeyError::Corrupt(v.len())),
        None => {
            if committed_state_exists || !allow_create {
                return Err(KeyError::Missing);
            }
            let mut key = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            store.set(&key).map_err(KeyError::Unavailable)?;
            // Read back: a store that "accepted" the write but can't return it
            // would otherwise strand the state we're about to encrypt.
            match store.get().map_err(KeyError::Unavailable)? {
                Some(v) if v.as_slice() == key.as_slice() => Ok(key),
                _ => Err(KeyError::Unavailable("keyring did not retain the newly created key".to_string())),
            }
        }
    }
}

// ── Files ───────────────────────────────────────────────────────────────────

pub struct StatePaths {
    pub main: PathBuf,
    pub tmp: PathBuf,
    pub bak: PathBuf,
}

impl StatePaths {
    pub fn in_dir(dir: &Path) -> Self {
        StatePaths {
            main: dir.join(STATE_FILE_NAME),
            tmp: dir.join(format!("{STATE_FILE_NAME}.tmp")),
            bak: dir.join(format!("{STATE_FILE_NAME}.bak")),
        }
    }

    fn exists(p: &Path) -> Result<bool, String> {
        p.try_exists().map_err(|e| format!("MLS_STATE_IO: can't stat {}: {e}", p.display()))
    }

    /// main or .bak — i.e. a state that a write has fully committed at some
    /// point. A lone .tmp doesn't count (an interrupted first-ever write).
    pub fn committed_state_exists(&self) -> Result<bool, String> {
        Ok(Self::exists(&self.main)? || Self::exists(&self.bak)?)
    }
}

fn encrypt_blob(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|e| format!("MLS_STATE_IO: encrypt error: {e}"))?;
    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ct);
    Ok(blob)
}

fn decrypt_blob(key: &[u8; 32], blob: &[u8]) -> Option<Vec<u8>> {
    if blob.len() < 13 {
        return None;
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher.decrypt(Nonce::from_slice(&blob[..12]), &blob[12..]).ok()
}

/// Windows: a freshly written file can be briefly locked by AV/indexers, which
/// makes MoveFileEx fail with ACCESS_DENIED — retry a few times.
fn rename_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..5 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(20 * (attempt + 1)));
            }
        }
    }
    Err(last.unwrap())
}

fn sync_dir(_dir: &Path) {
    #[cfg(unix)]
    {
        if let Ok(d) = File::open(_dir) {
            let _ = d.sync_all();
        }
    }
}

/// See the module doc comment ("ATOMIC WRITE").
pub fn write_atomic(paths: &StatePaths, blob: &[u8]) -> Result<(), String> {
    let io = |what: &str, e: std::io::Error| format!("MLS_STATE_IO: {what}: {e}");
    if let Some(parent) = paths.main.parent() {
        fs::create_dir_all(parent).map_err(|e| io("create dir", e))?;
    }
    {
        let mut f = File::create(&paths.tmp).map_err(|e| io("create tmp", e))?;
        f.write_all(blob).map_err(|e| io("write tmp", e))?;
        f.sync_all().map_err(|e| io("fsync tmp", e))?;
    }
    if StatePaths::exists(&paths.main)? {
        // Keep the previous good state. Copy rather than rename so the main
        // file is never absent; a torn .bak only matters if main is ALSO bad.
        fs::copy(&paths.main, &paths.bak).map_err(|e| io("copy main -> bak", e))?;
        if let Ok(f) = OpenOptions::new().write(true).open(&paths.bak) {
            let _ = f.sync_all();
        }
    }
    rename_retry(&paths.tmp, &paths.main).map_err(|e| io("rename tmp -> main", e))?;
    if let Some(parent) = paths.main.parent() {
        sync_dir(parent);
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Loaded {
    /// No state has ever been committed on this device.
    Fresh,
    State(Vec<u8>),
}

fn get_key(
    store: &dyn SecretStore,
    cache: &mut Option<[u8; 32]>,
    committed_state_exists: bool,
    allow_create: bool,
) -> Result<[u8; 32], KeyError> {
    if let Some(k) = cache {
        return Ok(*k);
    }
    let k = resolve_key(store, committed_state_exists, allow_create)?;
    *cache = Some(k);
    Ok(k)
}

/// See the module doc comment ("LOAD SEMANTICS"). Never touches the keyring
/// when no state file exists, and never creates a key.
pub fn load_state(paths: &StatePaths, store: &dyn SecretStore, cache: &mut Option<[u8; 32]>) -> Result<Loaded, String> {
    let main = StatePaths::exists(&paths.main)?;
    let bak = StatePaths::exists(&paths.bak)?;
    let tmp = StatePaths::exists(&paths.tmp)?;
    let committed = main || bak;
    if !committed && !tmp {
        return Ok(Loaded::Fresh);
    }

    let key = match get_key(store, cache, committed, false) {
        Ok(k) => k,
        // Only an interrupted first-ever write exists, and there's no key for
        // it either — nothing was ever committed, so this really is fresh.
        Err(KeyError::Missing) if !committed => return Ok(Loaded::Fresh),
        Err(e) => return Err(e.to_js()),
    };

    let mut failures = Vec::new();
    for (label, path, present) in [("tmp", &paths.tmp, tmp), ("main", &paths.main, main), ("bak", &paths.bak, bak)] {
        if !present {
            continue;
        }
        match fs::read(path) {
            Ok(blob) => match decrypt_blob(&key, &blob) {
                Some(plain) => {
                    if label != "main" || !failures.is_empty() {
                        log(&format!(
                            "[mls_store] loaded MLS state from {label} (earlier candidates failed: {failures:?})"
                        ));
                    }
                    return Ok(Loaded::State(plain));
                }
                None => failures.push(format!("{label}: authentication failed")),
            },
            Err(e) => failures.push(format!("{label}: read error {e}")),
        }
    }

    if !committed {
        // Lone, unauthenticatable tmp: an interrupted first-ever write.
        return Ok(Loaded::Fresh);
    }
    Err(format!("MLS_STATE_UNREADABLE: no MLS state file could be decrypted ({})", failures.join("; ")))
}

/// `state_elsewhere`: another account's (or the legacy) state exists under the
/// same keyring key. All accounts share one key, so "no key but some state
/// exists" must fail closed here too, not just for this account's own files.
pub fn save_state(
    paths: &StatePaths,
    store: &dyn SecretStore,
    cache: &mut Option<[u8; 32]>,
    plaintext: &[u8],
    state_elsewhere: bool,
) -> Result<(), String> {
    let committed = state_elsewhere || paths.committed_state_exists()?;
    let key = get_key(store, cache, committed, true).map_err(|e| e.to_js())?;
    let blob = encrypt_blob(&key, plaintext)?;
    write_atomic(paths, &blob)
}

// ── Per-account layout + legacy migration ───────────────────────────────────
//
// <app_data>/accounts/<userId>/.specter_mls_state (+ .tmp/.bak) and
// <app_data>/accounts/<userId>/msgcache/. The user is the Rust session's
// (session.rs), so JS never names the account it's saving for.
//
// Before per-account storage, one state lived at <app_data>/.specter_mls_state
// and a second account on the PC silently reused it. migrate_legacy moves it
// (and the legacy msgcache) into the account its own credential names, once,
// and records that account in <app_data>/legacy_owner — JS uses
// mls_legacy_owner() to decide who may adopt the other legacy per-PC data
// (localStorage device id, the un-suffixed IndexedDB).

pub const ACCOUNTS_DIR: &str = "accounts";
pub const LEGACY_OWNER_FILE: &str = "legacy_owner";
const MSGCACHE_DIR: &str = "msgcache";

/// User ids become a path component: server-issued UUIDs, but accept only a
/// conservative charset so nothing can traverse out of accounts/.
pub fn valid_user_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn account_dir(app_data: &Path, user_id: &str) -> Result<PathBuf, String> {
    if !valid_user_id(user_id) {
        return Err(format!("MLS_STATE_IO: unusable user id {user_id:?}"));
    }
    Ok(app_data.join(ACCOUNTS_DIR).join(user_id))
}

/// Any committed state on this PC: legacy root or any account.
pub fn any_committed_state(app_data: &Path) -> Result<bool, String> {
    if StatePaths::in_dir(app_data).committed_state_exists()? {
        return Ok(true);
    }
    let Ok(entries) = fs::read_dir(app_data.join(ACCOUNTS_DIR)) else { return Ok(false) };
    for entry in entries.flatten() {
        if StatePaths::in_dir(&entry.path()).committed_state_exists()? {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn read_legacy_owner(app_data: &Path) -> Option<String> {
    let s = fs::read_to_string(app_data.join(LEGACY_OWNER_FILE)).ok()?;
    let s = s.trim();
    valid_user_id(s).then(|| s.to_string())
}

/// tmp → fsync → rename, for small marker files.
fn write_small_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let io = |what: &str, e: std::io::Error| format!("MLS_STATE_IO: {what} {}: {e}", path.display());
    let tmp = path.with_extension("tmp");
    {
        let mut f = File::create(&tmp).map_err(|e| io("create", e))?;
        f.write_all(contents).map_err(|e| io("write", e))?;
        f.sync_all().map_err(|e| io("fsync", e))?;
    }
    rename_retry(&tmp, path).map_err(|e| io("rename", e))?;
    if let Some(parent) = path.parent() {
        sync_dir(parent);
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum Migration {
    /// No legacy state files.
    NothingToDo,
    /// Moved into this user's account directory.
    Migrated(String),
    /// Legacy files left exactly where they are; the reason is logged.
    Skipped(String),
    /// Failed part-way through moving files into this user's directory
    /// (owner, reason). The next run finishes it; until then that account's
    /// directory must not be used, or the resume would roll it back.
    Incomplete(String, String),
}

/// See "Per-account layout + legacy migration" above. Crash-safe: the
/// legacy_owner marker is written BEFORE any file moves, so if a run dies
/// half-way the next run sees marker == owner and knows the owner's
/// directory holds only migration leftovers (nothing writes there until the
/// legacy files are gone) and simply finishes the moves.
pub fn migrate_legacy(
    app_data: &Path,
    store: &dyn SecretStore,
    cache: &mut Option<[u8; 32]>,
    owner_of: &dyn Fn(&[u8]) -> Result<String, String>,
) -> Migration {
    let legacy = StatePaths::in_dir(app_data);
    let present: Vec<&PathBuf> = [&legacy.tmp, &legacy.bak, &legacy.main]
        .into_iter()
        .filter(|p| p.exists())
        .collect();
    if present.is_empty() {
        return Migration::NothingToDo;
    }

    let bytes = match load_state(&legacy, store, cache) {
        Ok(Loaded::State(b)) => b,
        // Only a torn, never-committed tmp: there's no identity to move.
        Ok(Loaded::Fresh) => return Migration::Skipped("legacy MLS state is an interrupted first write".into()),
        Err(e) => return Migration::Skipped(format!("legacy MLS state unreadable, left in place: {e}")),
    };
    let owner = match owner_of(&bytes) {
        Ok(o) if valid_user_id(&o) => o,
        Ok(o) => return Migration::Skipped(format!("legacy MLS state owner {o:?} is not a usable user id")),
        Err(e) => return Migration::Skipped(format!("legacy MLS state has no readable owner: {e}")),
    };
    let dest_dir = match account_dir(app_data, &owner) {
        Ok(d) => d,
        Err(e) => return Migration::Skipped(e),
    };
    let dest = StatePaths::in_dir(&dest_dir);

    let resuming = match read_legacy_owner(app_data) {
        Some(m) if m == owner => true,
        Some(m) => {
            return Migration::Skipped(format!(
                "legacy_owner says {m} but the legacy MLS state belongs to {owner}; left in place"
            ))
        }
        None => false,
    };
    match dest.committed_state_exists() {
        Ok(true) if !resuming => {
            return Migration::Skipped(format!(
                "account {owner} already has its own MLS state; legacy state left in place"
            ))
        }
        Ok(_) => {}
        Err(e) => return Migration::Skipped(e),
    }

    if let Err(e) = fs::create_dir_all(&dest_dir) {
        return Migration::Skipped(format!("MLS_STATE_IO: create {}: {e}", dest_dir.display()));
    }
    if let Err(e) = write_small_atomic(&app_data.join(LEGACY_OWNER_FILE), owner.as_bytes()) {
        return Migration::Skipped(e);
    }
    for (from, to) in [(&legacy.tmp, &dest.tmp), (&legacy.bak, &dest.bak), (&legacy.main, &dest.main)] {
        if !from.exists() {
            continue;
        }
        if let Err(e) = rename_retry(from, to) {
            // The marker is down, so the next launch resumes from here.
            return Migration::Incomplete(
                owner,
                format!("MLS_STATE_IO: move {} -> {}: {e}", from.display(), to.display()),
            );
        }
    }
    sync_dir(&dest_dir);
    sync_dir(app_data);

    // The legacy message cache is this owner's history too. Best effort: a
    // failure here only delays its drain, it never touches MLS state.
    let legacy_cache = app_data.join(MSGCACHE_DIR);
    let dest_cache = dest_dir.join(MSGCACHE_DIR);
    if legacy_cache.is_dir() && !dest_cache.exists() {
        if let Err(e) = rename_retry(&legacy_cache, &dest_cache) {
            log(&format!("[mls_store] moving legacy msgcache to account {owner} failed: {e}"));
        }
    }
    Migration::Migrated(owner)
}

// ── Process-wide state (all accessed under MLS_STATE_CRITICAL_SECTION) ──────

static KEY_CACHE: Mutex<Option<[u8; 32]>> = Mutex::new(None);
/// Latest decrypt-only state handed over by JS, not yet on disk, with the
/// account directory it belongs to (captured when JS sent it, so an account
/// switch before the flush can't land it in the wrong account).
static PENDING: Mutex<Option<(PathBuf, Vec<u8>)>> = Mutex::new(None);
static FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);
/// The account whose state the current webview loaded, or None until it has
/// loaded one, and again after a tray_light hand-off: a JS context that
/// hasn't loaded the latest on-disk state (or one that outlived its
/// hand-off) must never write, and it only ever writes to that account.
static JS_OWNER: Mutex<Option<String>> = Mutex::new(None);
/// Legacy migration runs at most once per process (it logs when it can't
/// proceed; a locked keyring gets another chance next launch).
static MIGRATION_ATTEMPTED: AtomicBool = AtomicBool::new(false);
/// Set when that migration stopped part-way (Migration::Incomplete): this
/// account's directory is refused for the rest of the process.
static MIGRATION_BLOCKED: Mutex<Option<String>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map_err(|e| format!("MLS_STATE_IO: {e}"))
}

/// The signed-in user's id from session.rs, if any.
pub fn session_user_id(app: &tauri::AppHandle) -> Option<String> {
    crate::session::current_user(app)?
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Caller must hold MLS_STATE_CRITICAL_SECTION.
fn ensure_migrated_locked(app_data: &Path) {
    if MIGRATION_ATTEMPTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut cache = lock(&KEY_CACHE);
    match migrate_legacy(app_data, &KeyringSecretStore, &mut cache, &mls_crypto::device_state_owner) {
        Migration::NothingToDo => {}
        Migration::Migrated(owner) => log(&format!("[mls_store] migrated legacy MLS state to account {owner}")),
        Migration::Skipped(why) => log(&format!("[mls_store] legacy MLS state not migrated: {why}")),
        Migration::Incomplete(owner, why) => {
            log(&format!("[mls_store] legacy MLS state migration to account {owner} incomplete (retried next launch): {why}"));
            *lock(&MIGRATION_BLOCKED) = Some(owner);
        }
    }
}

/// The signed-in user and their account directory (after the one-time legacy
/// migration). Err("MLS_NO_SESSION: …") when nobody is signed in.
fn signed_in_account(app: &tauri::AppHandle, app_data: &Path) -> Result<(String, PathBuf), String> {
    let user = session_user_id(app).ok_or("MLS_NO_SESSION: not signed in — no account to hold MLS state")?;
    if lock(&MIGRATION_BLOCKED).as_deref() == Some(user.as_str()) {
        return Err("MLS_STATE_IO: this account's legacy MLS state migration is incomplete — restart the app".to_string());
    }
    let dir = account_dir(app_data, &user)?;
    Ok((user, dir))
}

/// Caller must hold MLS_STATE_CRITICAL_SECTION.
fn current_account_locked(app: &tauri::AppHandle) -> Result<(String, PathBuf), String> {
    let app_data = app_data_dir(app)?;
    ensure_migrated_locked(&app_data);
    signed_in_account(app, &app_data)
}

/// The signed-in account's directory, for msgcache and background_sync.
/// Takes MLS_STATE_CRITICAL_SECTION only for the one-time legacy migration,
/// so callers must NOT already hold it.
pub fn current_account_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app_data_dir(app)?;
    if !MIGRATION_ATTEMPTED.load(Ordering::SeqCst) {
        let _g = lock(&MLS_STATE_CRITICAL_SECTION);
        ensure_migrated_locked(&app_data);
    }
    signed_in_account(app, &app_data).map(|(_, dir)| dir)
}

/// Caller must hold MLS_STATE_CRITICAL_SECTION.
fn save_locked(dir: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut cache = lock(&KEY_CACHE);
    // Only matters before the key is cached, i.e. when it may be created.
    let elsewhere = match (cache.is_none(), dir.parent().and_then(Path::parent)) {
        (true, Some(app_data)) => any_committed_state(app_data)?,
        _ => false,
    };
    save_state(&StatePaths::in_dir(dir), &KeyringSecretStore, &mut cache, bytes, elsewhere)
}

/// Caller must hold MLS_STATE_CRITICAL_SECTION.
fn flush_pending_locked() {
    let pending = lock(&PENDING).take();
    if let Some((dir, bytes)) = pending {
        if let Err(e) = save_locked(&dir, &bytes) {
            log(&format!("[mls_store] deferred MLS state flush failed: {e}"));
            // Keep it for the next flush attempt unless something newer landed.
            let mut p = lock(&PENDING);
            if p.is_none() {
                *p = Some((dir, bytes));
            }
        }
    }
}

/// Caller must hold MLS_STATE_CRITICAL_SECTION.
fn load_locked(dir: &Path) -> Result<Loaded, String> {
    flush_pending_locked();
    let mut cache = lock(&KEY_CACHE);
    load_state(&StatePaths::in_dir(dir), &KeyringSecretStore, &mut cache)
}

/// Writes any deferred decrypt-only state to disk now. Called on app exit.
pub fn flush_pending(_app: &tauri::AppHandle) {
    let _g = lock(&MLS_STATE_CRITICAL_SECTION);
    flush_pending_locked();
}

/// tray_light close: flush JS's deferred state, then hand state ownership to
/// the background task atomically — any later write from the (dying) webview
/// is refused rather than racing the background decrypts.
pub fn handoff_to_background(_app: &tauri::AppHandle) {
    let _g = lock(&MLS_STATE_CRITICAL_SECTION);
    flush_pending_locked();
    *lock(&JS_OWNER) = None;
    FOREGROUND_ACTIVE.store(false, Ordering::SeqCst);
}

/// background_sync's load: the signed-in account's state and its directory
/// (pass the same directory to save_for_background_locked, so a sign-in
/// change mid-cycle can't redirect the save). Caller must already hold
/// MLS_STATE_CRITICAL_SECTION. None for "no session", "no state" and
/// "unreadable" alike — the background task never creates identities, it
/// just skips.
pub fn load_for_background_locked(app: &tauri::AppHandle) -> Option<(PathBuf, Vec<u8>)> {
    let (_, dir) = current_account_locked(app).ok()?;
    match load_locked(&dir) {
        Ok(Loaded::State(b)) => Some((dir, b)),
        Ok(Loaded::Fresh) => None,
        Err(e) => {
            log(&format!("[bgsync] MLS state load failed: {e}"));
            None
        }
    }
}

/// background_sync's save (durable). Caller must already hold MLS_STATE_CRITICAL_SECTION.
pub fn save_for_background_locked(dir: &Path, bytes: &[u8]) -> Result<(), String> {
    {
        let mut p = lock(&PENDING);
        if p.as_ref().is_some_and(|(d, _)| d == dir) {
            p.take();
        }
    }
    save_locked(dir, bytes)
}

fn schedule_flush() {
    if FLUSH_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FLUSH_DELAY).await;
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _g = lock(&MLS_STATE_CRITICAL_SECTION);
            // Cleared under the lock BEFORE taking PENDING: a save landing
            // after this point sees the flag clear and schedules its own flush.
            FLUSH_SCHEDULED.store(false, Ordering::SeqCst);
            flush_pending_locked();
        })
        .await;
    });
}

// ── Tauri commands (raw-bytes IPC, run off the main thread) ─────────────────

/// Body: raw state bytes (`invoke('mls_save_state', uint8array, { headers })`).
/// Header `x-mls-durable: 1` = fsynced before returning; otherwise deferred
/// (see module doc comment, "DURABILITY / COALESCING"). Written to the account
/// whose state this webview loaded, and only if the bytes' own credential
/// names that account — a late save from before an account switch is
/// refused instead of overwriting the other account's identity.
#[tauri::command]
pub async fn mls_save_state(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("MLS_STATE_IO: mls_save_state expects a raw byte body".to_string());
    };
    if bytes.is_empty() {
        return Err("MLS_STATE_IO: refusing to persist an empty MLS state".to_string());
    }
    let bytes = bytes.clone();
    let durable = request
        .headers()
        .get("x-mls-durable")
        .map(|v| v.as_bytes() == b"1")
        .unwrap_or(false);

    let deferred = tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let bytes_owner = mls_crypto::device_state_owner(&bytes)
            .map_err(|e| format!("MLS_STATE_IO: refusing to persist a state with no readable owner: {e}"))?;
        let app_data = app_data_dir(&app)?;
        let _g = lock(&MLS_STATE_CRITICAL_SECTION);
        let owner = lock(&JS_OWNER).clone();
        let owner = match owner {
            Some(o) if FOREGROUND_ACTIVE.load(Ordering::SeqCst) => o,
            _ => return Err("MLS_STATE_HANDED_OFF: this window no longer owns MLS state (reload required)".to_string()),
        };
        if bytes_owner != owner {
            return Err(format!(
                "MLS_ACCOUNT_MISMATCH: state belongs to {bytes_owner}, but this window loaded {owner}'s (reload required)"
            ));
        }
        let dir = account_dir(&app_data, &owner)?;
        if durable {
            match save_locked(&dir, &bytes) {
                Ok(()) => {
                    // Anything pending is older than what was just written.
                    lock(&PENDING).take();
                    Ok(false)
                }
                Err(e) => {
                    // Keep the newest state around so exit/next flush retries it.
                    *lock(&PENDING) = Some((dir, bytes));
                    Err(e)
                }
            }
        } else {
            *lock(&PENDING) = Some((dir, bytes));
            Ok(true)
        }
    })
    .await
    .map_err(|e| format!("MLS_STATE_IO: save task failed: {e}"))??;

    if deferred {
        schedule_flush();
    }
    Ok(())
}

/// Returns raw bytes for the signed-in account: empty = no state yet (fresh
/// account on this device). Any failure to read an EXISTING state is an
/// Err("MLS_…") — never an empty result. Not signed in = Err("MLS_NO_SESSION: …").
#[tauri::command]
pub async fn mls_load_state(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<tauri::ipc::Response, String> {
        let _g = lock(&MLS_STATE_CRITICAL_SECTION);
        let (user, dir) = current_account_locked(&app)?;
        let loaded = load_locked(&dir)?;
        // This webview now holds the latest state of this account — it may
        // write (to this account only) from here on, and it owns MLS state
        // from this point: claim foreground under the same lock so a
        // background decrypt can't slip in between this load and
        // show_main_window flipping the flag (it would fork the state).
        *lock(&JS_OWNER) = Some(user);
        FOREGROUND_ACTIVE.store(true, Ordering::SeqCst);
        Ok(tauri::ipc::Response::new(match loaded {
            Loaded::Fresh => Vec::new(),
            Loaded::State(b) => b,
        }))
    })
    .await
    .map_err(|e| format!("MLS_STATE_IO: load task failed: {e}"))?
}

/// The account the pre-per-account (per-PC) MLS state belonged to, or null if
/// there was none or it couldn't be read. Runs the one-time migration first.
/// JS uses this to decide which account may adopt the other legacy per-PC
/// data (device id in localStorage, the un-suffixed message IndexedDB).
#[tauri::command]
pub async fn mls_legacy_owner(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        let app_data = app_data_dir(&app)?;
        let _g = lock(&MLS_STATE_CRITICAL_SECTION);
        ensure_migrated_locked(&app_data);
        Ok(read_legacy_owner(&app_data))
    })
    .await
    .map_err(|e| format!("MLS_STATE_IO: legacy owner task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeStore {
        value: RefCell<Option<Vec<u8>>>,
        get_err: Option<String>,
        set_err: Option<String>,
        drop_writes: bool,
        sets: RefCell<usize>,
    }

    impl SecretStore for FakeStore {
        fn get(&self) -> Result<Option<Vec<u8>>, String> {
            if let Some(e) = &self.get_err {
                return Err(e.clone());
            }
            Ok(self.value.borrow().clone())
        }
        fn set(&self, s: &[u8]) -> Result<(), String> {
            *self.sets.borrow_mut() += 1;
            if let Some(e) = &self.set_err {
                return Err(e.clone());
            }
            if !self.drop_writes {
                *self.value.borrow_mut() = Some(s.to_vec());
            }
            Ok(())
        }
    }

    fn with_key(k: [u8; 32]) -> FakeStore {
        FakeStore { value: RefCell::new(Some(k.to_vec())), ..Default::default() }
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut n = [0u8; 8];
            rand::rngs::OsRng.fill_bytes(&mut n);
            let p = std::env::temp_dir().join(format!("mls_store_test_{tag}_{}", n.iter().map(|b| format!("{b:02x}")).collect::<String>()));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn paths(&self) -> StatePaths {
            StatePaths::in_dir(&self.0)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // ── resolve_key ──

    #[test]
    fn key_existing_is_returned_without_writing() {
        let s = with_key([7; 32]);
        assert_eq!(resolve_key(&s, true, true), Ok([7; 32]));
        assert_eq!(*s.sets.borrow(), 0);
    }

    #[test]
    fn key_created_only_when_no_entry_and_no_state() {
        let s = FakeStore::default();
        let k = resolve_key(&s, false, true).unwrap();
        assert_eq!(s.value.borrow().as_deref(), Some(&k[..]));
        assert_eq!(*s.sets.borrow(), 1);
    }

    #[test]
    fn key_missing_with_existing_state_fails_closed() {
        let s = FakeStore::default();
        assert_eq!(resolve_key(&s, true, true), Err(KeyError::Missing));
        assert_eq!(*s.sets.borrow(), 0);
    }

    #[test]
    fn key_missing_on_load_never_creates() {
        let s = FakeStore::default();
        assert_eq!(resolve_key(&s, false, false), Err(KeyError::Missing));
        assert_eq!(*s.sets.borrow(), 0);
    }

    #[test]
    fn keyring_error_never_overwrites() {
        let s = FakeStore { get_err: Some("locked".into()), ..Default::default() };
        assert!(matches!(resolve_key(&s, false, true), Err(KeyError::Unavailable(_))));
        assert_eq!(*s.sets.borrow(), 0);
    }

    #[test]
    fn wrong_length_key_is_corrupt_not_replaced() {
        let s = FakeStore { value: RefCell::new(Some(vec![1; 16])), ..Default::default() };
        assert_eq!(resolve_key(&s, false, true), Err(KeyError::Corrupt(16)));
        assert_eq!(*s.sets.borrow(), 0);
    }

    #[test]
    fn keyring_that_drops_writes_is_an_error() {
        let s = FakeStore { drop_writes: true, ..Default::default() };
        assert!(matches!(resolve_key(&s, false, true), Err(KeyError::Unavailable(_))));
    }

    // ── load/save ──

    #[test]
    fn fresh_dir_loads_fresh_without_touching_keyring() {
        let d = TempDir::new("fresh");
        let s = FakeStore { get_err: Some("keyring would fail".into()), ..Default::default() };
        assert_eq!(load_state(&d.paths(), &s, &mut None), Ok(Loaded::Fresh));
    }

    #[test]
    fn save_then_load_roundtrip_and_bak_kept() {
        let d = TempDir::new("roundtrip");
        let s = FakeStore::default();
        let mut c = None;
        save_state(&d.paths(), &s, &mut c, b"v1", false).unwrap();
        assert!(!d.paths().bak.exists());
        save_state(&d.paths(), &s, &mut c, b"v2", false).unwrap();
        assert!(d.paths().bak.exists());
        assert!(!d.paths().tmp.exists());
        assert_eq!(load_state(&d.paths(), &s, &mut None), Ok(Loaded::State(b"v2".to_vec())));
        // .bak holds the previous good state.
        let key = resolve_key(&s, true, false).unwrap();
        assert_eq!(decrypt_blob(&key, &fs::read(d.paths().bak).unwrap()), Some(b"v1".to_vec()));
    }

    #[test]
    fn corrupt_main_falls_back_to_bak() {
        let d = TempDir::new("bak");
        let s = FakeStore::default();
        let mut c = None;
        save_state(&d.paths(), &s, &mut c, b"v1", false).unwrap();
        save_state(&d.paths(), &s, &mut c, b"v2", false).unwrap();
        // Torn / corrupted main file.
        fs::write(d.paths().main, b"garbage garbage garbage").unwrap();
        assert_eq!(load_state(&d.paths(), &s, &mut None), Ok(Loaded::State(b"v1".to_vec())));
    }

    #[test]
    fn crash_after_tmp_written_prefers_complete_tmp() {
        let d = TempDir::new("tmpnewer");
        let s = FakeStore::default();
        let mut c = None;
        save_state(&d.paths(), &s, &mut c, b"v1", false).unwrap();
        // Simulate: step 1 of the next write completed, then crash.
        let key = c.unwrap();
        fs::write(d.paths().tmp, encrypt_blob(&key, b"v2").unwrap()).unwrap();
        assert_eq!(load_state(&d.paths(), &s, &mut None), Ok(Loaded::State(b"v2".to_vec())));
    }

    #[test]
    fn torn_tmp_is_ignored() {
        let d = TempDir::new("torntmp");
        let s = FakeStore::default();
        let mut c = None;
        save_state(&d.paths(), &s, &mut c, b"v1", false).unwrap();
        let blob = encrypt_blob(&c.unwrap(), b"v2-longer-state").unwrap();
        fs::write(d.paths().tmp, &blob[..blob.len() / 2]).unwrap();
        assert_eq!(load_state(&d.paths(), &s, &mut None), Ok(Loaded::State(b"v1".to_vec())));
    }

    #[test]
    fn lone_torn_tmp_on_first_write_is_fresh() {
        let d = TempDir::new("lonetmp");
        fs::write(d.paths().tmp, b"partial").unwrap();
        // Key was never stored either.
        assert_eq!(load_state(&d.paths(), &FakeStore::default(), &mut None), Ok(Loaded::Fresh));
        // Key exists but tmp is torn.
        assert_eq!(load_state(&d.paths(), &with_key([3; 32]), &mut None), Ok(Loaded::Fresh));
    }

    #[test]
    fn wrong_key_is_unreadable_error_not_fresh() {
        let d = TempDir::new("wrongkey");
        let s = FakeStore::default();
        save_state(&d.paths(), &s, &mut None, b"v1", false).unwrap();
        save_state(&d.paths(), &s, &mut None, b"v2", false).unwrap();
        let other = with_key([9; 32]);
        let err = load_state(&d.paths(), &other, &mut None).unwrap_err();
        assert!(err.starts_with("MLS_STATE_UNREADABLE"), "{err}");
    }

    #[test]
    fn missing_key_with_state_is_error_and_save_refuses() {
        let d = TempDir::new("nokey");
        let s = FakeStore::default();
        save_state(&d.paths(), &s, &mut None, b"v1", false).unwrap();
        let before = fs::read(d.paths().main).unwrap();
        let empty = FakeStore::default();
        let err = load_state(&d.paths(), &empty, &mut None).unwrap_err();
        assert!(err.starts_with("MLS_KEY_MISSING"), "{err}");
        let err = save_state(&d.paths(), &empty, &mut None, b"evil", false).unwrap_err();
        assert!(err.starts_with("MLS_KEY_MISSING"), "{err}");
        assert_eq!(*empty.sets.borrow(), 0);
        assert_eq!(fs::read(d.paths().main).unwrap(), before);
    }

    #[test]
    fn keyring_unavailable_with_state_is_error_and_save_refuses() {
        let d = TempDir::new("locked");
        let s = FakeStore::default();
        save_state(&d.paths(), &s, &mut None, b"v1", false).unwrap();
        let before = fs::read(d.paths().main).unwrap();
        let locked = FakeStore { get_err: Some("access denied".into()), ..Default::default() };
        let err = load_state(&d.paths(), &locked, &mut None).unwrap_err();
        assert!(err.starts_with("MLS_KEYRING_UNAVAILABLE"), "{err}");
        assert!(save_state(&d.paths(), &locked, &mut None, b"x", false).is_err());
        assert_eq!(*locked.sets.borrow(), 0);
        assert_eq!(fs::read(d.paths().main).unwrap(), before);
    }

    #[test]
    fn only_bak_left_still_counts_as_committed_state() {
        let d = TempDir::new("onlybak");
        let s = FakeStore::default();
        let mut c = None;
        save_state(&d.paths(), &s, &mut c, b"v1", false).unwrap();
        save_state(&d.paths(), &s, &mut c, b"v2", false).unwrap();
        fs::remove_file(d.paths().main).unwrap();
        assert_eq!(load_state(&d.paths(), &s, &mut None), Ok(Loaded::State(b"v1".to_vec())));
        // And a missing key with only .bak present must not mint a new key.
        assert_eq!(resolve_key(&FakeStore::default(), d.paths().committed_state_exists().unwrap(), true), Err(KeyError::Missing));
    }

    // ── per-account paths ──

    /// Test states are just their credential string, so the owner is the part
    /// before ':' (the real accessor is mls_crypto::device_state_owner).
    fn fake_owner(b: &[u8]) -> Result<String, String> {
        let s = std::str::from_utf8(b).map_err(|e| e.to_string())?;
        s.split_once(':').map(|(u, _)| u.to_string()).ok_or_else(|| "no ':'".to_string())
    }

    fn acct(d: &TempDir, user: &str) -> StatePaths {
        StatePaths::in_dir(&account_dir(&d.0, user).unwrap())
    }

    #[test]
    fn account_dir_is_per_user_and_rejects_unsafe_ids() {
        let base = Path::new("appdata");
        assert_eq!(account_dir(base, "6f1c-AB_9").unwrap(), base.join("accounts").join("6f1c-AB_9"));
        for bad in ["", "..", "../x", "a/b", "a\\b", "a.b", "a:b", "a b"] {
            assert!(account_dir(base, bad).is_err(), "{bad:?} should be rejected");
        }
        assert!(account_dir(base, &"x".repeat(129)).is_err());
    }

    #[test]
    fn accounts_do_not_share_state() {
        let d = TempDir::new("isolated");
        let s = FakeStore::default();
        save_state(&acct(&d, "user-a"), &s, &mut None, b"user-a:dev1", false).unwrap();
        assert_eq!(load_state(&acct(&d, "user-b"), &s, &mut None), Ok(Loaded::Fresh));
        assert_eq!(load_state(&acct(&d, "user-a"), &s, &mut None), Ok(Loaded::State(b"user-a:dev1".to_vec())));
        assert!(any_committed_state(&d.0).unwrap());
    }

    #[test]
    fn missing_key_with_another_accounts_state_never_mints_a_key() {
        let d = TempDir::new("elsewhere");
        save_state(&acct(&d, "user-a"), &FakeStore::default(), &mut None, b"user-a:dev1", false).unwrap();
        // Keyring entry gone; user-b has no state of its own.
        let empty = FakeStore::default();
        let elsewhere = any_committed_state(&d.0).unwrap();
        let err = save_state(&acct(&d, "user-b"), &empty, &mut None, b"user-b:dev2", elsewhere).unwrap_err();
        assert!(err.starts_with("MLS_KEY_MISSING"), "{err}");
        assert_eq!(*empty.sets.borrow(), 0);
        assert!(!acct(&d, "user-b").main.exists());
    }

    // ── legacy migration ──

    #[test]
    fn migration_with_no_legacy_state_does_nothing() {
        let d = TempDir::new("nolegacy");
        assert_eq!(migrate_legacy(&d.0, &FakeStore::default(), &mut None, &fake_owner), Migration::NothingToDo);
        assert_eq!(read_legacy_owner(&d.0), None);
        assert!(!d.0.join(ACCOUNTS_DIR).exists());
    }

    #[test]
    fn migration_moves_state_and_msgcache_to_owner_and_records_owner() {
        let d = TempDir::new("migrate");
        let s = FakeStore::default();
        let mut c = None;
        save_state(&d.paths(), &s, &mut c, b"user-a:dev1 v1", false).unwrap();
        save_state(&d.paths(), &s, &mut c, b"user-a:dev1 v2", false).unwrap();
        fs::create_dir_all(d.0.join("msgcache")).unwrap();
        fs::write(d.0.join("msgcache").join("chan.log"), b"line\n").unwrap();

        assert_eq!(migrate_legacy(&d.0, &s, &mut None, &fake_owner), Migration::Migrated("user-a".into()));

        let legacy = d.paths();
        assert!(!legacy.main.exists() && !legacy.bak.exists() && !legacy.tmp.exists());
        let a = acct(&d, "user-a");
        assert_eq!(load_state(&a, &s, &mut None), Ok(Loaded::State(b"user-a:dev1 v2".to_vec())));
        let key = resolve_key(&s, true, false).unwrap();
        assert_eq!(decrypt_blob(&key, &fs::read(&a.bak).unwrap()), Some(b"user-a:dev1 v1".to_vec()));
        assert_eq!(read_legacy_owner(&d.0).as_deref(), Some("user-a"));
        assert!(account_dir(&d.0, "user-a").unwrap().join("msgcache").join("chan.log").exists());
        assert!(!d.0.join("msgcache").exists());
        // Idempotent afterwards.
        assert_eq!(migrate_legacy(&d.0, &s, &mut None, &fake_owner), Migration::NothingToDo);
    }

    #[test]
    fn unreadable_legacy_state_is_left_untouched() {
        let d = TempDir::new("unreadable");
        save_state(&d.paths(), &with_key([1; 32]), &mut None, b"user-a:dev1", false).unwrap();
        let before = fs::read(d.paths().main).unwrap();
        for store in [with_key([2; 32]), FakeStore::default(), FakeStore { get_err: Some("locked".into()), ..Default::default() }] {
            assert!(matches!(migrate_legacy(&d.0, &store, &mut None, &fake_owner), Migration::Skipped(_)));
        }
        assert_eq!(fs::read(d.paths().main).unwrap(), before);
        assert_eq!(read_legacy_owner(&d.0), None);
        assert!(!d.0.join(ACCOUNTS_DIR).exists());
    }

    #[test]
    fn legacy_state_without_a_usable_owner_is_left_untouched() {
        let d = TempDir::new("noowner");
        let s = FakeStore::default();
        for plain in [&b"no separator"[..], b"../evil:dev1"] {
            save_state(&d.paths(), &s, &mut None, plain, false).unwrap();
            assert!(matches!(migrate_legacy(&d.0, &s, &mut None, &fake_owner), Migration::Skipped(_)));
            assert!(d.paths().main.exists());
            assert_eq!(read_legacy_owner(&d.0), None);
        }
    }

    #[test]
    fn migration_never_overwrites_an_accounts_own_state() {
        let d = TempDir::new("conflict");
        let s = FakeStore::default();
        save_state(&d.paths(), &s, &mut None, b"user-a:old", false).unwrap();
        save_state(&acct(&d, "user-a"), &s, &mut None, b"user-a:new", false).unwrap();
        assert!(matches!(migrate_legacy(&d.0, &s, &mut None, &fake_owner), Migration::Skipped(_)));
        assert_eq!(load_state(&acct(&d, "user-a"), &s, &mut None), Ok(Loaded::State(b"user-a:new".to_vec())));
        assert!(d.paths().main.exists());
        assert_eq!(read_legacy_owner(&d.0), None);
    }

    #[test]
    fn interrupted_migration_resumes() {
        let d = TempDir::new("resume");
        let s = FakeStore::default();
        let mut c = None;
        save_state(&d.paths(), &s, &mut c, b"user-a:dev1 v1", false).unwrap();
        save_state(&d.paths(), &s, &mut c, b"user-a:dev1 v2", false).unwrap();
        // Crash after the marker and the first move (bak), before main.
        let a = acct(&d, "user-a");
        fs::create_dir_all(a.main.parent().unwrap()).unwrap();
        fs::write(d.0.join(LEGACY_OWNER_FILE), b"user-a").unwrap();
        fs::rename(&d.paths().bak, &a.bak).unwrap();

        assert_eq!(migrate_legacy(&d.0, &s, &mut None, &fake_owner), Migration::Migrated("user-a".into()));
        assert!(!d.paths().main.exists());
        assert_eq!(load_state(&a, &s, &mut None), Ok(Loaded::State(b"user-a:dev1 v2".to_vec())));
        assert!(a.bak.exists());
    }

    #[test]
    fn marker_naming_someone_else_blocks_migration() {
        let d = TempDir::new("othermarker");
        let s = FakeStore::default();
        save_state(&d.paths(), &s, &mut None, b"user-a:dev1", false).unwrap();
        fs::write(d.0.join(LEGACY_OWNER_FILE), b"user-b").unwrap();
        assert!(matches!(migrate_legacy(&d.0, &s, &mut None, &fake_owner), Migration::Skipped(_)));
        assert!(d.paths().main.exists());
        assert!(!acct(&d, "user-a").main.exists());
    }

    #[test]
    fn legacy_owner_file_is_validated() {
        let d = TempDir::new("marker");
        fs::write(d.0.join(LEGACY_OWNER_FILE), b"  user-a\n").unwrap();
        assert_eq!(read_legacy_owner(&d.0).as_deref(), Some("user-a"));
        fs::write(d.0.join(LEGACY_OWNER_FILE), b"../../x").unwrap();
        assert_eq!(read_legacy_owner(&d.0), None);
    }
}
