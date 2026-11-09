// session.rs — the single owner of the login session in the desktop app.
//
// Why this exists: access tokens live ~30 minutes and refresh tokens rotate on
// every use (identity-node's authController.ts `refresh`). Redeeming a refresh
// token that has already been rotated is treated by the server as theft and
// revokes EVERY refresh token the user has, on every device. Before this
// module, three independent callers redeemed the same token with no shared
// coordination: App.jsx's launch restore, App.jsx's `specter:auth-expired`
// handler, and background_sync.rs (which had its own in-process lock but could
// not see the JS callers). Adding the tray strip window (a second webview with
// its own JS) would have made a fourth. Now every caller — any window, plus
// background_sync — asks this module for a token, and only this module ever
// talks to /auth/refresh.
//
// Model:
// - The session (access token, refresh token, user) is held in memory and
//   persisted through the existing encrypted credential file
//   (lib.rs save_credentials / load_credentials / delete_credentials).
// - Refresh is single-flight: `REFRESH` is an async mutex; every caller that
//   needs a refresh takes it, then re-checks whether someone else already
//   refreshed while it waited, so N concurrent callers produce one HTTP call.
// - `epoch` changes on every login/logout, so a refresh that was in flight
//   across a logout or a re-login can't write a stale session back.
// - `auth-changed` is emitted to every window with `{ user, reason }` (never
//   the tokens themselves): reason is login | restore | refresh | user |
//   logout | expired.
//
// The API base URL: the frontend's base is the build-time VITE_API_URL, which
// Rust can't see (cargo doesn't read web-portal/.env). The main window passes
// it in once at startup via `auth_configure`; the first value wins for the
// life of the process so a later caller can't redirect where the refresh
// token gets sent. Before that call (or if it never comes) it falls back to
// SPECTER_API_URL, then the production URL — the same fallback
// background_sync.rs always used.

use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

use crate::{delete_credentials, load_credentials, save_credentials, write_setup_error};

/// Refresh when the access token has less than this many seconds left, so a
/// token handed out is good for at least a request or two.
const REFRESH_LEEWAY_SECS: i64 = 120;

const FALLBACK_API_BASE: &str = "https://spectercoms.net/api";

#[derive(Clone)]
struct Session {
    token: String,
    refresh_token: Option<String>,
    user: serde_json::Value,
}

#[derive(Default)]
struct Inner {
    session: Option<Session>,
    /// Whether the on-disk session has been loaded into memory this process.
    loaded: bool,
    /// Bumped on every login / logout / restore so in-flight refreshes can
    /// tell their result no longer applies.
    epoch: u64,
}

pub struct SessionState {
    inner: Mutex<Inner>,
    refresh: tokio::sync::Mutex<()>,
    api_base: Mutex<Option<String>>,
    client: reqwest::Client,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            refresh: tokio::sync::Mutex::const_new(()),
            api_base: Mutex::new(None),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct AuthChanged {
    user: Option<serde_json::Value>,
    reason: &'static str,
}

fn state(app: &tauri::AppHandle) -> tauri::State<'_, SessionState> {
    app.state::<SessionState>()
}

fn lock_inner(s: &SessionState) -> std::sync::MutexGuard<'_, Inner> {
    s.inner.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn api_base(app: &tauri::AppHandle) -> String {
    if let Some(b) = state(app).api_base.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return b;
    }
    std::env::var("SPECTER_API_URL").unwrap_or_else(|_| FALLBACK_API_BASE.to_string())
}

fn emit(app: &tauri::AppHandle, user: Option<serde_json::Value>, reason: &'static str) {
    let _ = app.emit("auth-changed", AuthChanged { user, reason });
}

fn persist(app: &tauri::AppHandle, s: &Session) {
    if let Err(e) = save_credentials(app.clone(), s.token.clone(), s.refresh_token.clone(), s.user.clone()) {
        write_setup_error(&format!("[session] saving session failed: {e}"));
    }
}

/// Seconds-since-epoch `exp` claim of a JWT, or None if it can't be read.
/// Signature isn't checked — the server does that; this only decides when to
/// refresh proactively. A token we can't read is used as-is and the 401 path
/// (`auth_refresh`) recovers if it turns out to be dead.
fn jwt_exp(token: &str) -> Option<i64> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("exp").and_then(|v| v.as_i64())
}

fn needs_refresh(token: &str) -> bool {
    match jwt_exp(token) {
        Some(exp) => exp - chrono::Utc::now().timestamp() < REFRESH_LEEWAY_SECS,
        None => false,
    }
}

#[derive(Deserialize)]
struct RefreshResponse {
    token: String,
    refresh_token: String,
}

enum RefreshError {
    /// The server rejected the refresh token (401/403) — the session is over.
    Dead(String),
    /// Network trouble, 5xx, 429 — keep the session and let the caller retry.
    Transient(String),
}

async fn post_refresh(app: &tauri::AppHandle, refresh_token: &str) -> Result<RefreshResponse, RefreshError> {
    let base = api_base(app);
    let resp = state(app)
        .client
        .post(format!("{base}/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| RefreshError::Transient(e.to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(RefreshError::Dead(format!("refresh rejected: HTTP {status}")));
    }
    if !status.is_success() {
        return Err(RefreshError::Transient(format!("refresh failed: HTTP {status}")));
    }
    resp.json::<RefreshResponse>().await.map_err(|e| RefreshError::Transient(e.to_string()))
}

/// Best-effort server-side revoke of a refresh token (fire and forget).
fn revoke_in_background(app: &tauri::AppHandle, refresh_token: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let base = api_base(&app);
        let _ = state(&app)
            .client
            .post(format!("{base}/auth/logout"))
            .json(&serde_json::json!({ "refresh_token": refresh_token }))
            .send()
            .await;
    });
}

/// Ends the session locally: memory, disk, and every window via auth-changed.
fn end_session(app: &tauri::AppHandle, reason: &'static str) -> Option<Session> {
    let st = state(app);
    let old = {
        let mut inner = lock_inner(&st);
        inner.epoch += 1;
        inner.loaded = true;
        inner.session.take()
    };
    let _ = delete_credentials(app.clone());
    emit(app, None, reason);
    old
}

/// Refreshes the session unless someone already did. `stale` is the access
/// token the caller has decided is no good (expired, or just got a 401): if
/// the current token differs, another caller already refreshed and that
/// token is returned without a second HTTP call. Ok(None) = logged out.
async fn refresh_single_flight(app: &tauri::AppHandle, stale: Option<&str>) -> Result<Option<String>, String> {
    let st = state(app);
    let _guard = st.refresh.lock().await;

    let (session, epoch) = {
        let inner = lock_inner(&st);
        match &inner.session {
            None => return Ok(None),
            Some(s) => (s.clone(), inner.epoch),
        }
    };

    // Someone refreshed (or logged in again) while we waited for the lock.
    let already_fresh = match stale {
        Some(stale) => session.token != stale,
        None => !needs_refresh(&session.token),
    };
    if already_fresh {
        return Ok(Some(session.token));
    }

    let Some(refresh_token) = session.refresh_token.clone() else {
        // Legacy session with no refresh token: nothing to redeem.
        end_session(app, "expired");
        return Ok(None);
    };

    match post_refresh(app, &refresh_token).await {
        Ok(fresh) => {
            let updated = {
                let mut inner = lock_inner(&st);
                if inner.epoch != epoch || inner.session.is_none() {
                    None
                } else {
                    let s = Session {
                        token: fresh.token.clone(),
                        refresh_token: Some(fresh.refresh_token.clone()),
                        user: session.user.clone(),
                    };
                    inner.session = Some(s.clone());
                    Some(s)
                }
            };
            match updated {
                Some(s) => {
                    persist(app, &s);
                    emit(app, Some(s.user.clone()), "refresh");
                    Ok(Some(s.token))
                }
                None => {
                    // Logged out (or a new login) while this was in flight:
                    // don't resurrect it, and don't leave the freshly issued
                    // refresh token alive on the server either.
                    revoke_in_background(app, fresh.refresh_token);
                    let inner = lock_inner(&st);
                    Ok(inner.session.as_ref().map(|s| s.token.clone()))
                }
            }
        }
        Err(RefreshError::Dead(e)) => {
            write_setup_error(&format!("[session] {e} — ending session"));
            let still_same = lock_inner(&st).epoch == epoch;
            if still_same {
                end_session(app, "expired");
                Ok(None)
            } else {
                Ok(lock_inner(&st).session.as_ref().map(|s| s.token.clone()))
            }
        }
        Err(RefreshError::Transient(e)) => Err(e),
    }
}

/// A usable access token, refreshing first if it's expired or about to be.
/// Ok(None) = not logged in. Used by both the JS commands and background_sync.
pub async fn valid_token(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let current = {
        let st = state(app);
        let inner = lock_inner(&st);
        inner.session.as_ref().map(|s| s.token.clone())
    };
    match current {
        None => Ok(None),
        Some(t) if !needs_refresh(&t) => Ok(Some(t)),
        Some(t) => match refresh_single_flight(app, None).await {
            // Couldn't reach the server, but the old token hasn't actually
            // expired yet (we refresh a little early) — still worth using.
            Err(e) => match jwt_exp(&t) {
                Some(exp) if exp > chrono::Utc::now().timestamp() => Ok(Some(t)),
                _ => Err(e),
            },
            other => other,
        },
    }
}

/// The current user (from memory), for background_sync.
pub fn current_user(app: &tauri::AppHandle) -> Option<serde_json::Value> {
    let st = state(app);
    let inner = lock_inner(&st);
    inner.session.as_ref().map(|s| s.user.clone())
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Sets the API base URL (the frontend's VITE_API_URL). First call wins.
#[tauri::command]
pub fn auth_configure(app: tauri::AppHandle, api_base: String) -> Result<(), String> {
    let trimmed = api_base.trim().trim_end_matches('/').to_string();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("api_base must be an http(s) URL".into());
    }
    let st = state(&app);
    let mut slot = st.api_base.lock().unwrap_or_else(|e| e.into_inner());
    match slot.as_deref() {
        None => *slot = Some(trimmed),
        Some(existing) if existing != trimmed => {
            write_setup_error(&format!("[session] ignoring api_base change {existing} -> {trimmed}"));
        }
        _ => {}
    }
    Ok(())
}

/// Result of `auth_restore`.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum RestoreResult {
    /// A session is active (already in memory, or loaded from disk and
    /// refreshed if needed).
    Ok { user: serde_json::Value },
    /// Nothing saved, or the saved session is dead.
    #[serde(rename = "none")]
    NoSession,
    /// Couldn't reach the server to refresh; the saved session is left on
    /// disk for the next attempt, but this launch starts logged out.
    Offline { error: String },
    /// Pre-token-era saved email/password. JS logs in with them once and
    /// calls auth_set_session, which overwrites the file without them.
    Legacy { email: String, password: String },
}

/// Called once per window on startup. Loads the saved session into memory the
/// first time in this process (later windows, or a tray_light rebuild of the
/// main window, just get the in-memory session), refreshing if needed.
#[tauri::command]
pub async fn auth_restore(app: tauri::AppHandle) -> Result<RestoreResult, String> {
    let needs_load = {
        let st = state(&app);
        let inner = lock_inner(&st);
        !inner.loaded && inner.session.is_none()
    };

    let mut loaded_now = false;
    if needs_load {
        let saved = load_credentials(app.clone());
        let st = state(&app);
        let mut inner = lock_inner(&st);
        if !inner.loaded && inner.session.is_none() {
            inner.loaded = true;
            loaded_now = true;
            match saved {
                Some(s) if s.token.is_some() && s.user.is_some() => {
                    inner.epoch += 1;
                    inner.session = Some(Session {
                        token: s.token.unwrap_or_default(),
                        refresh_token: s.refresh_token,
                        user: s.user.unwrap_or_default(),
                    });
                }
                Some(s) if s.email.is_some() && s.password.is_some() => {
                    return Ok(RestoreResult::Legacy {
                        email: s.email.unwrap_or_default(),
                        password: s.password.unwrap_or_default(),
                    });
                }
                _ => return Ok(RestoreResult::NoSession),
            }
        }
    }

    match valid_token(&app).await {
        Ok(Some(_)) => match current_user(&app) {
            Some(user) => {
                emit(&app, Some(user.clone()), "restore");
                Ok(RestoreResult::Ok { user })
            }
            None => Ok(RestoreResult::NoSession),
        },
        Ok(None) => Ok(RestoreResult::NoSession),
        Err(error) if loaded_now => {
            // A fresh launch that couldn't refresh the saved session. Same
            // outcome as before this module existed: the login screen shows,
            // the saved file stays. Drop the in-memory copy so no other
            // window acts logged in, and let a later restore retry from disk.
            let st = state(&app);
            let mut inner = lock_inner(&st);
            inner.session = None;
            inner.loaded = false;
            inner.epoch += 1;
            Ok(RestoreResult::Offline { error })
        }
        Err(error) => {
            // The session was already live in this process (another window
            // has been using it) and only this refresh attempt failed
            // transiently — don't log everyone out over a network blip.
            match current_user(&app) {
                Some(user) => Ok(RestoreResult::Ok { user }),
                None => Ok(RestoreResult::Offline { error }),
            }
        }
    }
}

/// A valid access token, or null when logged out.
#[tauri::command]
pub async fn auth_get_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
    valid_token(&app).await
}

/// Called after a request was rejected with 401 using `stale_token`.
/// Refreshes once (shared with any concurrent caller) and returns the new
/// token, or null if the session is over (auth-changed "expired" is emitted).
#[tauri::command]
pub async fn auth_refresh(app: tauri::AppHandle, stale_token: Option<String>) -> Result<Option<String>, String> {
    match stale_token {
        Some(t) => refresh_single_flight(&app, Some(&t)).await,
        None => valid_token(&app).await,
    }
}

/// Stores a session after a JS login (or legacy migration).
#[tauri::command]
pub fn auth_set_session(
    app: tauri::AppHandle,
    token: String,
    refresh_token: Option<String>,
    user: serde_json::Value,
) -> Result<(), String> {
    let s = Session { token, refresh_token, user: user.clone() };
    let replaced = {
        let st = state(&app);
        let mut inner = lock_inner(&st);
        inner.epoch += 1;
        inner.loaded = true;
        inner.session.replace(s.clone())
    };
    // A login on top of an existing session (shouldn't normally happen): the
    // old refresh token would otherwise stay valid server-side for 30 days.
    if let Some(old) = replaced.and_then(|o| o.refresh_token) {
        if Some(&old) != s.refresh_token.as_ref() {
            revoke_in_background(&app, old);
        }
    }
    persist(&app, &s);
    emit(&app, Some(user), "login");
    Ok(())
}

/// Updates the stored user snapshot (e.g. after a fresh /users/me).
#[tauri::command]
pub fn auth_set_user(app: tauri::AppHandle, user: serde_json::Value) -> Result<(), String> {
    let updated = {
        let st = state(&app);
        let mut inner = lock_inner(&st);
        match inner.session.as_mut() {
            None => None,
            Some(s) => {
                s.user = user.clone();
                Some(s.clone())
            }
        }
    };
    let Some(s) = updated else { return Err("not logged in".into()) };
    persist(&app, &s);
    emit(&app, Some(user), "user");
    Ok(())
}

/// The logged-in user, or null. Memory only — call auth_restore first.
#[tauri::command]
pub fn auth_current(app: tauri::AppHandle) -> Option<serde_json::Value> {
    current_user(&app)
}

/// Logs out everywhere in this app: clears memory and the saved file, revokes
/// the refresh token server-side (best effort), emits auth-changed "logout".
#[tauri::command]
pub fn auth_logout(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(rt) = end_session(&app, "logout").and_then(|s| s.refresh_token) {
        revoke_in_background(&app, rt);
    }
    Ok(())
}
