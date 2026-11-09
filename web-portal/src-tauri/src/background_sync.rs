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
// asks session.rs for a token, which refreshes it first when it's near expiry
// (see access_token below).
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
use tauri_plugin_notification::NotificationExt;

use crate::{mls_store, msgcache, write_setup_error};

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

fn api_base(app: &tauri::AppHandle) -> String {
    // Same base the frontend uses (passed to session.rs by the main window at
    // startup via auth_configure), with the old SPECTER_API_URL/production
    // fallback if that never happened.
    crate::session::api_base(app)
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

/// A usable access token from session.rs, the single owner of the session.
///
/// This used to redeem the refresh token itself on every cycle (with its own
/// REFRESH_LOCK between sse_loop and notify_loop) and skip refreshing while
/// the window was open, because the foreground JS refreshed independently and
/// a reused rotating refresh token makes the server revoke every session the
/// user has. session.rs now serialises ALL refreshes — every window's JS and
/// this task — and only refreshes when the access token is near expiry, so
/// none of that coordination is needed here any more.
async fn access_token(app: &tauri::AppHandle) -> Result<String, String> {
    crate::session::valid_token(app).await?.ok_or_else(|| "no saved session".to_string())
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
    let base = api_base(app);
    let access_token = access_token(app).await?;
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

    // None for "no identity yet" and for "state exists but unreadable" alike —
    // this task never creates identities (see mls_store.rs), it just skips.
    // account_dir: the signed-in account's directory (state + msgcache),
    // captured once so the save and the cache write land in the same account.
    let Some((account_dir, device_state)) = mls_store::load_for_background_locked(app) else { return };

    let Ok(ciphertext) = base64::engine::general_purpose::STANDARD.decode(encrypted_b64) else { return };

    match mls_crypto::decrypt_impl(&device_state, channel_id.as_bytes(), &ciphertext) {
        Ok(result) => {
            if let Err(e) = mls_store::save_for_background_locked(&account_dir, &result.device_state) {
                write_setup_error(&format!("[bgsync] MLS state save failed: {e}"));
            }
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
            let _ = msgcache::append(&account_dir, channel_id, &record);
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

    let my_id = crate::session::current_user(app)
        .and_then(|u| u.get("id").and_then(|v| v.as_str()).map(str::to_string));
    if my_id.as_deref() == Some(requester_id) { return; } // don't answer our own request

    let since = req.get("since").and_then(|v| v.as_str());

    let Ok(dir) = mls_store::current_account_dir(app) else { return };
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

    let Ok(access_token) = access_token(app).await else { return };
    let base = api_base(app);
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
    let base = api_base(app);
    let access_token = access_token(app).await?;

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
