// background_sync.rs — keeps chat messages syncing into the local encrypted
// cache (msgcache.rs) and fires upcoming-event notifications while the main
// window is torn down (CloseBehaviorState::tray_light). A bare Rust process
// has no webview, so it can't run the foreground JS/WASM MLS path or use
// fetch/EventSource — this replicates the same HTTP requests
// useEventStream.js/api.js make, using reqwest, and decrypts with
// mls-crypto's native decrypt_impl (see that crate's own doc comment on why
// it's safe to call directly, with no wasm-bindgen/JS boundary involved).
//
// Refresh-token dependent by design: an access token is only ~30 minutes
// (see identity-node's authController.ts ACCESS_TOKEN_TTL) and this task can
// run for hours while the window stays closed, so every reconnect/poll cycle
// redeems the refresh token first rather than assuming the saved access token
// is still valid.
//
// FOREGROUND_ACTIVE alone only closed most of the race window: the
// foreground and this task are two independent code paths touching the same
// .specter_mls_state file within a single process, so checking a flag before
// starting a decrypt cycle doesn't stop one already in flight when the flag
// flips. MLS_STATE_CRITICAL_SECTION closes the rest of it — this task holds
// it for its entire load→decrypt→save sequence, and show_main_window (below)
// blocks on acquiring it before letting the foreground touch state at all,
// so by the time the window is actually shown, no background decrypt can
// still be running. A cross-process file lock (as opposed to an in-process
// Mutex) isn't needed here: both sides run in this same Tauri process, not
// separate executables — see the earlier decision to keep this feature
// in-process rather than a standalone service.

use base64::Engine;
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, Once};
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::{load_credentials, mls_load_state, mls_save_state, msgcache, save_credentials, write_setup_error};

static STARTED: Once = Once::new();

/// True whenever the main window is open (foreground JS/WASM owns message
/// decrypt + MLS state in that case). Set by the CloseRequested handler
/// (tray_light) and show_main_window.
pub static FOREGROUND_ACTIVE: AtomicBool = AtomicBool::new(true);

/// Guards the load→decrypt→save sequence against .specter_mls_state — see
/// module doc comment above.
pub static MLS_STATE_CRITICAL_SECTION: Mutex<()> = Mutex::new(());

const NOTIFY_POLL_SECS: u64 = 300;
const NOTIFY_LEAD_SECS: i64 = 15 * 60;
const RECONNECT_BACKOFF_SECS: u64 = 5;

fn api_base() -> String {
    // Rust has no access to the frontend's build-time VITE_API_URL — mirror
    // its fallback default (web-portal/src/api.js) with the same production
    // URL the shipped app actually talks to; SPECTER_API_URL overrides for
    // local dev/testing against a non-production identity-node.
    std::env::var("SPECTER_API_URL").unwrap_or_else(|_| "https://spectercoms.net/api".to_string())
}

/// Starts the background sync + notification loops exactly once per process
/// — safe to call every time tray_light is entered; only the first call does
/// anything. Loops keep running even after the window reopens (harmless: the
/// FOREGROUND_ACTIVE guard just makes message decrypt a no-op while it's
/// open), so there is nothing to explicitly stop.
pub fn ensure_started(app: tauri::AppHandle) {
    STARTED.call_once(|| {
        tauri::async_runtime::spawn(sse_loop(app.clone()));
        tauri::async_runtime::spawn(notify_loop(app));
    });
}

#[derive(Deserialize)]
struct RefreshResponse {
    token: String,
    refresh_token: String,
}

async fn refresh_tokens(client: &reqwest::Client, base: &str, refresh_token: &str) -> Result<RefreshResponse, String> {
    let resp = client
        .post(format!("{base}/auth/refresh"))
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("refresh failed: HTTP {}", resp.status()));
    }
    resp.json::<RefreshResponse>().await.map_err(|e| e.to_string())
}

/// Loads the saved refresh token and redeems it, persisting the rotated pair
/// back to disk. Shared by both loops (SSE reconnect and notification poll).
///
/// Refresh tokens rotate on every use (identity-node's authController.ts) and
/// a reused/already-rotated token is treated as theft — the whole chain gets
/// revoked. sse_loop and notify_loop are two independent callers with no
/// coordination, so without REFRESH_LOCK both could redeem the SAME saved
/// token at once: one wins, the other's now-stale attempt looks like reuse,
/// and the server revokes even the winner's brand-new token. That's exactly
/// what was happening in production — bursts of one 200 followed by 401s in
/// the server logs, every ~5 minutes (notify_loop's poll interval), which
/// eventually left the on-disk refresh token permanently dead server-side and
/// forced a real re-login on the next launch. The lock serializes both
/// loops; re-reading load_credentials AFTER acquiring it (not before) means a
/// caller that had to wait picks up whatever the other one just saved instead
/// of racing a second call with the token that's already spent.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn refresh_and_save(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<String, String> {
    let _lock = REFRESH_LOCK.lock().await;

    let saved = load_credentials(app.clone()).ok_or("no saved session")?;

    // The foreground JS session owns its own token lifecycle while the
    // window is open (App.jsx's launch-restore + specter:auth-expired silent
    // refresh) — piling an independent background refresh on top of that
    // would reintroduce the exact same single-use-token race against a third
    // caller. Just reuse whatever access token the foreground currently has
    // saved instead.
    if FOREGROUND_ACTIVE.load(Ordering::SeqCst) {
        return saved.token.ok_or_else(|| "no access token saved".to_string());
    }

    let refresh_token = saved.refresh_token.ok_or("no refresh token saved")?;
    let refreshed = refresh_tokens(client, &api_base(), &refresh_token).await?;
    let user = saved.user.unwrap_or_else(|| serde_json::json!({}));
    let _ = save_credentials(app.clone(), refreshed.token.clone(), Some(refreshed.refresh_token), user);
    Ok(refreshed.token)
}

// ── Message sync (SSE) ──────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TicketResponse {
    ticket: String,
}

async fn mint_sse_ticket(client: &reqwest::Client, base: &str, access_token: &str) -> Result<String, String> {
    let resp = client
        .post(format!("{base}/events/ticket"))
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("ticket mint failed: HTTP {}", resp.status()));
    }
    resp.json::<TicketResponse>().await.map(|t| t.ticket).map_err(|e| e.to_string())
}

async fn sse_loop(app: tauri::AppHandle) {
    let client = reqwest::Client::new();
    loop {
        if let Err(e) = sse_session(&app, &client).await {
            write_setup_error(&format!("[bgsync] SSE session ended: {e}"));
        }
        tokio::time::sleep(Duration::from_secs(RECONNECT_BACKOFF_SECS)).await;
    }
}

async fn sse_session(app: &tauri::AppHandle, client: &reqwest::Client) -> Result<(), String> {
    let base = api_base();
    let access_token = refresh_and_save(app, client).await?;
    let ticket = mint_sse_ticket(client, &base, &access_token).await?;

    let resp = client
        .get(format!("{base}/events/stream?token={ticket}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("SSE connect failed: HTTP {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE frames are separated by a blank line ("\n\n") — same framing
        // sseController.ts writes and the browser's EventSource parses.
        while let Some(pos) = buf.find("\n\n") {
            let frame: String = buf.drain(..pos + 2).collect();
            handle_sse_frame(app, client, &frame).await;
        }
    }
    Err("stream ended".to_string())
}

async fn handle_sse_frame(app: &tauri::AppHandle, client: &reqwest::Client, frame: &str) {
    for line in frame.lines() {
        let Some(json_str) = line.strip_prefix("data: ") else { continue };
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(json_str) else { continue };
        let subject = payload.get("subject").and_then(|v| v.as_str()).unwrap_or("");
        if !subject.starts_with("specter.msg.channel.") { continue; }
        let Some(inner) = payload.get("payload") else { continue };
        match payload.get("type").and_then(|v| v.as_str()) {
            Some("message_relay") => decrypt_and_cache(app, inner).await,
            Some("sync_request") => answer_sync_request(app, client, inner).await,
            _ => {}
        }
    }
}

async fn decrypt_and_cache(app: &tauri::AppHandle, msg: &serde_json::Value) {
    // The main window is open — its own JS/WASM path already owns decrypt +
    // MLS state for this message. Stepping in here too would race it.
    if FOREGROUND_ACTIVE.load(Ordering::SeqCst) { return; }

    let (Some(channel_id), Some(encrypted_b64)) = (
        msg.get("channel_id").and_then(|v| v.as_str()),
        msg.get("encrypted_content").and_then(|v| v.as_str()),
    ) else { return };

    // Held across the whole load→decrypt→save sequence below (all synchronous,
    // no .await inside) — see module doc comment and show_main_window's
    // matching acquire, which is what actually closes the race.
    let _state_guard = MLS_STATE_CRITICAL_SECTION.lock().unwrap_or_else(|e| e.into_inner());
    // Re-check now that we hold the lock: the foreground may have reopened
    // and started its own state I/O while we were waiting to acquire it.
    if FOREGROUND_ACTIVE.load(Ordering::SeqCst) { return; }

    let device_state = mls_load_state(app.clone());
    if device_state.is_empty() { return; } // no local identity yet — nothing to decrypt with

    let Ok(ciphertext) = base64::engine::general_purpose::STANDARD.decode(encrypted_b64) else { return };

    match mls_crypto::decrypt_impl(&device_state, channel_id.as_bytes(), &ciphertext) {
        Ok(result) => {
            let _ = mls_save_state(app.clone(), result.device_state);
            let plaintext = String::from_utf8_lossy(&result.plaintext).to_string();
            let record = serde_json::json!({
                "id": msg.get("id"),
                "channel_id": channel_id,
                // Needed if this device later answers another peer's
                // sync-request from this cached record — see
                // answer_sync_request and messageController.ts's relayPayload.
                "org_id": msg.get("org_id"),
                "sender_id": msg.get("sender_id"),
                "callsign": msg.get("callsign"),
                "global_tag": msg.get("global_tag"),
                "encrypted_content": encrypted_b64,
                "plaintext": plaintext,
                "image_url": msg.get("image_url"),
                "timestamp": msg.get("timestamp"),
            });
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = msgcache::append(&dir, channel_id, &record);
            }
        }
        Err(_) => {
            // Either this device's own just-sent message (MLS can't decrypt
            // an application message against the sender's own leaf — see
            // mls-crypto's sender_cannot_decrypt_own_message test) or a
            // message that predates this device's identity. Not actionable
            // here; the foreground path's notePendingSent/recall handles the
            // "own echoed message" case when the window is actually open.
        }
    }
}

/// Answers another peer's channel backfill request (see messageController.ts's
/// "Peer backfill sync" comment — there's no server-side history, so a client
/// missing messages asks whichever other members are currently online).
/// While the window is open, WarRoom.jsx's own _textChatSyncRequestRef handler
/// already does this from messageStore.js's IndexedDB (this device's *full*
/// history); this only fires while backgrounded, and can only answer from
/// msgcache.rs's own store — messages this device has personally seen flow by
/// since the window last closed, not full history. Deliberately a smaller,
/// best-effort contribution: the sync protocol already fans a request out to
/// every online member and merges whatever comes back, so a partial answer
/// from here is additive, not required to be complete.
async fn answer_sync_request(app: &tauri::AppHandle, client: &reqwest::Client, req: &serde_json::Value) {
    if FOREGROUND_ACTIVE.load(Ordering::SeqCst) { return; } // foreground already owns this

    let (Some(channel_id), Some(org_id), Some(requester_id)) = (
        req.get("channel_id").and_then(|v| v.as_str()),
        req.get("org_id").and_then(|v| v.as_str()),
        req.get("requester_id").and_then(|v| v.as_str()),
    ) else { return };

    let my_id = load_credentials(app.clone())
        .and_then(|s| s.user)
        .and_then(|u| u.get("id").and_then(|v| v.as_str()).map(str::to_string));
    if my_id.as_deref() == Some(requester_id) { return; } // don't answer our own request

    let since = req.get("since").and_then(|v| v.as_str());

    let Ok(dir) = app.path().app_data_dir() else { return };
    let Ok(cached) = msgcache::read(&dir, channel_id, usize::MAX) else { return };
    let messages: Vec<serde_json::Value> = cached
        .into_iter()
        .filter(|m| match (since, m.get("timestamp").and_then(|v| v.as_str())) {
            (Some(s), Some(t)) => t > s,
            (None, _) => true,
            _ => false,
        })
        .take(200) // matches messageController.ts's SYNC_MESSAGES_MAX
        .map(|m| serde_json::json!({
            "id": m.get("id"),
            "sender_id": m.get("sender_id"),
            "callsign": m.get("callsign"),
            "global_tag": m.get("global_tag"),
            "encrypted_content": m.get("encrypted_content"),
            "image_url": m.get("image_url"),
            "timestamp": m.get("timestamp"),
        }))
        .collect();
    if messages.is_empty() { return; }

    let Ok(access_token) = refresh_and_save(app, client).await else { return };
    let base = api_base();
    let _ = client
        .post(format!("{base}/orgs/{org_id}/channels/{channel_id}/messages/sync-response"))
        .bearer_auth(&access_token)
        .json(&serde_json::json!({ "to_user_id": requester_id, "messages": messages }))
        .send()
        .await;
}

// ── Upcoming-event notifications ────────────────────────────────────────────

async fn notify_loop(app: tauri::AppHandle) {
    let client = reqwest::Client::new();
    let mut notified: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        if let Err(e) = notify_once(&app, &client, &mut notified).await {
            write_setup_error(&format!("[bgsync] notify poll failed: {e}"));
        }
        tokio::time::sleep(Duration::from_secs(NOTIFY_POLL_SECS)).await;
    }
}

async fn notify_once(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    notified: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    let base = api_base();
    let access_token = refresh_and_save(app, client).await?;

    let resp = client
        .get(format!("{base}/users/me/upcoming-events"))
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let events = body.get("events").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let now = Utc::now();
    for ev in &events {
        let (Some(id), Some(start_str)) = (
            ev.get("id").and_then(|v| v.as_str()),
            ev.get("start_time").and_then(|v| v.as_str()),
        ) else { continue };
        if notified.contains(id) { continue; }
        let Ok(start) = DateTime::parse_from_rfc3339(start_str) else { continue };
        let secs_until = (start.with_timezone(&Utc) - now).num_seconds();
        // Within the lead window and not already started more than a minute
        // ago (a poll cycle landing just after start shouldn't stay silent,
        // but this shouldn't fire for something well underway either).
        if secs_until <= NOTIFY_LEAD_SECS && secs_until > -60 {
            notified.insert(id.to_string());
            let name = ev.get("name").and_then(|v| v.as_str()).unwrap_or("Operation");
            let org = ev.get("org_callsign").and_then(|v| v.as_str()).unwrap_or("");
            let _ = app
                .notification()
                .builder()
                .title(format!("{name} starting soon"))
                .body(format!("{org} — starting within 15 minutes"))
                .show();
        }
    }

    // Bound memory: drop anything no longer in the upcoming list (started,
    // ended, or the user lost signup/access) instead of growing forever.
    let live_ids: std::collections::HashSet<String> = events
        .iter()
        .filter_map(|e| e.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    notified.retain(|id| live_ids.contains(id));

    Ok(())
}
