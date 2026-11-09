//! Background auto-updater, owned entirely by Rust.
//!
//! This used to live in the main window's JavaScript (App.jsx), which meant
//! it never ran while that window was closed (tray_light destroys it), and
//! its in-progress flag was only ever reset on failure — so after one
//! successful "no update" check the client never checked again until it was
//! restarted. Now:
//!
//! - `start` kicks off a check at launch (before login, independent of any
//!   window existing) and then every CHECK_INTERVAL, on Tauri's async runtime
//!   — nothing here ever runs on, or blocks, the main thread.
//! - A found update is downloaded and signature-verified in the background
//!   (`Update::download`, not `download_and_install`) and the bytes are held in
//!   `UpdaterState` until the app exits. `update-ready` is emitted to every
//!   window; a window opened later asks via `updater_pending`.
//! - `install_update_and_restart` flags the restart and exits the app;
//!   `install_pending_on_exit` (wired to RunEvent::Exit in lib.rs) installs
//!   only when that flag is set. A plain Quit never installs: the Windows
//!   installer always relaunches the app, and Quit must mean quit. The pending
//!   update is simply dropped and re-downloaded on the next launch's check.
//!
//! Endpoint, pubkey and artifact format all still come from tauri.conf.json's
//! `plugins.updater` section via the plugin's own config.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{capture, lock_ignore_poison, write_setup_error};

const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Clone, serde::Serialize)]
pub struct UpdateReadyPayload {
    version: String,
    notes: Option<String>,
}

struct PendingUpdate {
    update: Update,
    bytes: Vec<u8>,
}

impl PendingUpdate {
    fn payload(&self) -> UpdateReadyPayload {
        UpdateReadyPayload {
            version: self.update.version.clone(),
            notes: self.update.body.clone(),
        }
    }
}

#[derive(Default)]
pub struct UpdaterState {
    /// Downloaded + signature-verified update waiting to be installed.
    pending: Mutex<Option<PendingUpdate>>,
    /// Set while a check/download is running so the scheduled check and a
    /// login-triggered one can't overlap. Only ever cleared by CheckGuard's
    /// Drop, so every return path (success, no update, error) resets it.
    checking: AtomicBool,
    /// Set by install_update_and_restart; the only thing that lets
    /// install_pending_on_exit install (see there).
    restart_after_install: AtomicBool,
}

struct CheckGuard<'a>(&'a AtomicBool);

impl Drop for CheckGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// One check-and-download pass. Never installs anything.
async fn check_and_download(app: &AppHandle, reason: &str) {
    let state = app.state::<UpdaterState>();
    if state.checking.swap(true, Ordering::SeqCst) {
        write_setup_error(&format!("[updater] {reason} check skipped; one is already running"));
        return;
    }
    let _guard = CheckGuard(&state.checking);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            write_setup_error(&format!("[updater] {reason} check: building updater failed: {e}"));
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            write_setup_error(&format!("[updater] {reason} check: up to date"));
            return;
        }
        Err(e) => {
            write_setup_error(&format!("[updater] {reason} check failed: {e}"));
            return;
        }
    };

    // Already holding this exact version — nothing to re-download. A newer
    // version than the one pending falls through and replaces it.
    if let Some(pending) = lock_ignore_poison(&state.pending).as_ref() {
        if pending.update.version == update.version {
            return;
        }
    }

    write_setup_error(&format!(
        "[updater] {reason} check: v{} available (current v{}); downloading",
        update.version, update.current_version
    ));
    // download() also verifies the signature against the configured pubkey
    // before returning the bytes.
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => {
            write_setup_error(&format!("[updater] download of v{} failed: {e}", update.version));
            return;
        }
    };

    let pending = PendingUpdate { update, bytes };
    let payload = pending.payload();
    write_setup_error(&format!(
        "[updater] v{} downloaded ({} bytes); ready to install",
        payload.version,
        pending.bytes.len()
    ));
    *lock_ignore_poison(&state.pending) = Some(pending);
    let _ = app.emit("update-ready", payload);
}

/// Start the launch-time check and the periodic re-check. Called once from
/// setup(); runs entirely on Tauri's async runtime. Skipped in debug builds
/// (`tauri dev`) so a dev build doesn't quietly download a release and then
/// install it over the real installed app on quit — updater_check_now still
/// works there for testing.
pub fn start(app: AppHandle) {
    if cfg!(debug_assertions) {
        write_setup_error("[updater] debug build; automatic update checks disabled");
        return;
    }
    tauri::async_runtime::spawn(async move {
        check_and_download(&app, "startup").await;
        loop {
            tokio::time::sleep(CHECK_INTERVAL).await;
            check_and_download(&app, "scheduled").await;
        }
    });
}

/// Run a check right now — used when the login response's `latest_version`
/// hint says the server has something newer. Returns immediately; the result
/// arrives as `update-ready` like any other check.
#[tauri::command]
pub fn updater_check_now(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        check_and_download(&app, "on-demand").await;
    });
}

/// Lets a window that opened after `update-ready` was emitted find out
/// whether an update is already downloaded and waiting.
#[tauri::command]
pub fn updater_pending(state: tauri::State<UpdaterState>) -> Option<UpdateReadyPayload> {
    lock_ignore_poison(&state.pending).as_ref().map(PendingUpdate::payload)
}

/// Install the downloaded update and relaunch. The actual install happens in
/// install_pending_on_exit — this just takes the normal exit path, after the
/// same bounded capture drain the close-button quit path does (see
/// attach_main_window_events in lib.rs), so NVENC isn't torn down mid-frame.
/// Done on a spawned thread so the command returns without blocking the main
/// thread on the drain.
#[tauri::command]
pub fn install_update_and_restart(app: AppHandle, state: tauri::State<UpdaterState>) -> Result<(), String> {
    if lock_ignore_poison(&state.pending).is_none() {
        return Err("no update has been downloaded".to_string());
    }
    state.restart_after_install.store(true, Ordering::SeqCst);
    write_setup_error("[updater] install_update_and_restart requested; exiting to install");
    std::thread::spawn(move || {
        let (drain_tx, drain_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = capture::stop_capture();
            let _ = drain_tx.send(());
        });
        if drain_rx.recv_timeout(Duration::from_secs(5)).is_err() {
            write_setup_error("[updater] stop_capture did not complete within 5s; installing anyway");
        }
        app.exit(0);
    });
    Ok(())
}

/// Called from RunEvent::Exit (main thread, event loop already shutting
/// down). Installs the downloaded update only when the exit came from
/// install_update_and_restart — any other exit path leaves it uninstalled.
///
/// On Windows, Update::install writes the installer to a temp file, launches
/// it via ShellExecuteW (MSI: `msiexec /i ... /passive /promptrestart
/// AUTOLAUNCHAPP=True`; NSIS: `/P /R /UPDATE`) and then calls
/// std::process::exit(0) itself — it does not return on success, so Tauri's
/// own cleanup_before_exit is run here first (clears the tray icon so it
/// doesn't linger as a ghost). The installer then replaces the files once this
/// process is gone and relaunches the app.
pub fn install_pending_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<UpdaterState>() else { return };
    if !state.restart_after_install.load(Ordering::SeqCst) {
        return;
    }
    let Some(pending) = lock_ignore_poison(&state.pending).take() else { return };
    write_setup_error(&format!("[updater] installing v{} and restarting", pending.update.version));
    app.cleanup_before_exit();
    match pending.update.install(&pending.bytes) {
        Ok(()) => {
            // Only reached off Windows — there install() never returns.
            tauri::process::restart(&app.env());
        }
        Err(e) => write_setup_error(&format!("[updater] install on exit failed: {e}")),
    }
}
