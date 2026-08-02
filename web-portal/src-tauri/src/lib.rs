mod capture;

use tauri::{Emitter, Manager, WebviewWindowBuilder};
use tauri::WebviewWindow;
use aes_gcm::{Aes256Gcm, Key, Nonce, aead::{Aead, KeyInit}};
use rand::RngCore;

/// Tauri-IPC wrapper for NAL units — uses base64 so Vec<u8> travels as a
/// compact string instead of a verbose JSON integer array (~3× smaller).
#[derive(Clone, serde::Serialize)]
struct IpcNalUnit {
    data_b64:    String,
    is_keyframe: bool,
    timestamp_ms: u64,
}

#[derive(Clone, serde::Serialize)]
struct OverlayShowResult {
    ok: bool,
    reason: String,
}

/// Persistent diagnostic log for app-startup/window-setup issues (e.g. overlay
/// window creation failures), separate from capture::write_capture_error's
/// capture_errors.log — that file's presence is treated by the frontend as a
/// "screen share failed" signal, so anything unrelated to capture must not
/// share it. Writes to %APPDATA%\specter-coms\setup_errors.log. eprintln!
/// alone is not reliable here since this is a Windows-subsystem (no console) exe.
/// pub(crate) so capture::stop_capture can log its own teardown checkpoints
/// here too, rather than only via eprintln! (invisible on this no-console
/// build) — otherwise there'd be no way to tell whether a stuck join() in
/// stop_capture (rather than something overlay-specific) was behind a given hang.
pub(crate) fn write_setup_error(msg: &str) {
    eprintln!("{msg}");
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::Path::new(&appdata).join("specter-coms");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("setup_errors.log");
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
}

/// Build and return an overlay WebviewWindow.
/// Uses a always-on-top, frameless window that fills the primary monitor.
fn build_overlay(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    // Breadcrumb every step: setup_errors.log has repeatedly ended right after
    // "show_overlay task start" with no error — both primary_monitor() and
    // WebviewWindowBuilder::build() are suspects for blocking the main-thread
    // pump (Windows Application Hang 1002), and these lines tell them apart.
    write_setup_error("[overlay] build_overlay: querying primary monitor");
    let monitor = app.primary_monitor()
        .map_err(|e| format!("Failed to get primary monitor: {}", e))?
        .ok_or("No monitor available")?;
    write_setup_error("[overlay] build_overlay: primary monitor ok; building webview window");

    // The overlay MUST run in its own WebView2 environment (separate user-data
    // folder => separate browser process). Sharing the main window's browser
    // process is what breaks it: the overlay's CoreWebView2 controller creation
    // never completes there (window enum on a hung instance showed the HUD
    // window with a bare WRY_WEBVIEW child and no Chrome_WidgetWin), leaving
    // the main thread pumping forever inside WebViewBuilder::build() and every
    // subsequent window IPC (currentMonitor/is_visible) dead behind it.
    let overlay_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("overlay-webview");
    let _ = std::fs::create_dir_all(&overlay_data_dir);

    let win = WebviewWindowBuilder::new(app, "specter-overlay", tauri::WebviewUrl::App(
        "overlay.html".into()
    ))
    .title("SpecterComs HUD")
    .visible(false)
    .resizable(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .transparent(true)
    .decorations(false)
    .data_directory(overlay_data_dir)
    .additional_browser_args("--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows")
    .inner_size(monitor.size().width.into(), monitor.size().height.into())
    .center()
    .build()
    .map_err(|e| format!("Failed to build overlay: {}", e))?;
    write_setup_error("[overlay] build_overlay: webview window built");
    Ok(win)
}

/// Re-apply overlay window priority flags before showing.
/// This is intentionally tolerant of per-platform API failures so a partial
/// capability loss does not block overlay construction entirely.
fn apply_overlay_window_priority(window: &WebviewWindow) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_visible_on_all_workspaces(true);
}

#[cfg(target_os = "windows")]
fn try_exclude_overlay_from_capture() {
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    let title: Vec<u16> = "SpecterComs HUD\0".encode_utf16().collect();
    match unsafe {
        FindWindowW(
            windows::core::PCWSTR::null(),
            windows::core::PCWSTR(title.as_ptr()),
        )
    } {
        Ok(hwnd) if !hwnd.is_invalid() => {
            if let Err(e) = unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) } {
                eprintln!("[overlay] SetWindowDisplayAffinity failed: {e}");
            } else {
                eprintln!("[overlay] excluded from screen capture (WDA_EXCLUDEFROMCAPTURE)");
            }
        }
        Ok(_) => eprintln!("[overlay] FindWindowW returned invalid HWND; capture exclusion not applied"),
        Err(e) => eprintln!("[overlay] FindWindowW failed ({e}); capture exclusion not applied"),
    }
}

/// Force-show the overlay window via SetWindowPos(SWP_SHOWWINDOW), bypassing
/// WebviewWindow::show(). show_overlay() reuses the same cached window across
/// toggles (ensure_overlay_window) rather than rebuilding it every time — and
/// WebviewWindow::show() wraps ShowWindow(SW_SHOW) on Windows, which can
/// silently no-op on a window that was hidden via hide_overlay: it returns
/// success, but the OS-level visible flag never actually flips, leaving the
/// overlay invisible with no error anywhere. SetWindowPos with SWP_SHOWWINDOW
/// reliably restores visibility on the same window where ShowWindow does not.
///
/// Uses FindWindowW by title rather than WebviewWindow::hwnd() because tauri
/// 2.10's HWND comes from its own `windows 0.61` dependency, a different Rust
/// type than the `windows 0.58` HWND this crate uses directly (Cargo resolves
/// both into the tree) — passing one where the other is expected won't compile.
/// Re-finding the window by title stays entirely within this crate's own
/// windows-0.58 types, avoiding the cross-version mismatch.
#[cfg(target_os = "windows")]
fn force_show_overlay_window() {
    use windows::Win32::UI::WindowsAndMessaging::{
        FindWindowW, SetWindowPos, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
    };
    let title: Vec<u16> = "SpecterComs HUD\0".encode_utf16().collect();
    match unsafe {
        FindWindowW(
            windows::core::PCWSTR::null(),
            windows::core::PCWSTR(title.as_ptr()),
        )
    } {
        Ok(hwnd) if !hwnd.is_invalid() => {
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW;
            if let Err(e) = unsafe { SetWindowPos(hwnd, None, 0, 0, 0, 0, flags) } {
                write_setup_error(&format!("[overlay] SetWindowPos force-show failed: {e}"));
            } else {
                write_setup_error("[overlay] SetWindowPos force-show ok");
            }
        }
        Ok(_) => write_setup_error("[overlay] force_show: FindWindowW returned invalid HWND"),
        Err(e) => write_setup_error(&format!("[overlay] force_show: FindWindowW failed ({e})")),
    }
}
use sysinfo::System;
use sha2::{Sha256, Digest};
use std::sync::Mutex;
use std::collections::VecDeque;

/// Recover a mutex's guard even if a previous holder panicked while holding
/// it. Without this, one panic anywhere inside an overlay/report-buffer
/// operation poisons the lock and permanently breaks that feature for the
/// rest of the process's lifetime.
fn lock_ignore_poison<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Rolling audio buffer used exclusively for misconduct reporting.
/// Frames are submitted continuously during a session; when a user or admin
/// files a misconduct report, `snip_report_clip` extracts the relevant window
/// and the frontend packages it into a signed report payload for submission
/// to the server or platform admins. No data leaves the client automatically.
struct MisconductReportBuffer {
    frames: Mutex<VecDeque<(u64, u32, String)>>,
}

/// A single encoded (Opus, base64) audio frame is a few KB at most; this is a
/// generous ceiling that only exists to stop a buggy or compromised renderer
/// from growing the buffer unboundedly via oversized "frames" (the count cap
/// below only bounds the number of entries, not their size).
const MAX_REPORT_FRAME_LEN: usize = 256 * 1024;

/// Push a single encoded audio frame into the misconduct report buffer.
/// Maintains a rolling ~15-minute window; oldest frames are dropped automatically.
#[tauri::command]
fn submit_report_frame(state: tauri::State<MisconductReportBuffer>, timestamp: u64, ssrc: u32, frame: String) {
    if frame.len() > MAX_REPORT_FRAME_LEN {
        return;
    }
    let mut frames = lock_ignore_poison(&state.frames);
    frames.push_back((timestamp, ssrc, frame));
    // ~15-minute rolling window at typical frame rates
    if frames.len() > 100000 {
        frames.pop_front();
    }
}

/// Extract the last `duration_ms` milliseconds of audio frames to attach to
/// a misconduct report. Only called when the user explicitly submits a report.
#[tauri::command]
fn snip_report_clip(state: tauri::State<MisconductReportBuffer>, duration_ms: u64, current_time: u64) -> Vec<(u64, u32, String)> {
    let frames = lock_ignore_poison(&state.frames);
    let threshold = current_time.saturating_sub(duration_ms);
    frames.iter()
        .filter(|(t, _, _)| *t >= threshold)
        .cloned()
        .collect()
}

// Windows assigns a random GUID to HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
// at OS install time; it persists across reboots and renames (unlike hostname,
// which any user can trivially change in Settings) and is regenerated only on a
// clean OS reinstall — the same "different install = different machine" tradeoff
// every mainstream anti-cheat/licensing system built on it accepts. Used here as
// the primary fingerprint component specifically because os_name+host_name+cpu_brand
// alone was both easy to collide (identical OS/CPU strings are shared by millions
// of machines; only hostname differed, and cloned/imaged systems can share even
// that) and trivial to evade (renaming the PC generates a "new" HWID for the exact
// bad actor a ban is meant to stop).
#[cfg(target_os = "windows")]
fn read_machine_guid() -> Option<String> {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    use windows::core::w;

    let mut buf = [0u16; 64];
    let mut buf_len: u32 = (buf.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("SOFTWARE\\Microsoft\\Cryptography"),
            w!("MachineGuid"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut buf_len),
        )
    };
    if status.0 != 0 { return None; }
    // buf_len is bytes including the null terminator; convert to a UTF-16 char count.
    let len_chars = (buf_len as usize / 2).saturating_sub(1);
    let guid = String::from_utf16_lossy(&buf[..len_chars.min(buf.len())]);
    if guid.is_empty() { None } else { Some(guid) }
}

#[cfg(not(target_os = "windows"))]
fn read_machine_guid() -> Option<String> { None }

// Mixed into the fingerprint before hashing. Not a real secret — anyone can
// extract it by decompiling the shipped binary — but it does mean a leaked/
// stolen hardware_bans table can't be checked against an off-the-shelf SHA-256
// rainbow table; an attacker has to specifically target this app's algorithm.
const HWID_SALT: &str = "specter-coms-hwid-v2";

#[tauri::command]
fn get_hwid() -> String {
    let mut sys = System::new_all();
    sys.refresh_all();

    let os_name = System::name().unwrap_or_else(|| "unknown".to_string());
    let host_name = System::host_name().unwrap_or_else(|| "unknown".to_string());
    let cpu_brand = sys.cpus().first().map(|cpu| cpu.brand()).unwrap_or("unknown");
    let cpu_count = sys.cpus().len();

    // MachineGuid is the primary differentiator when available (see rationale
    // above); the older fields are kept in the mix as extra entropy and as a
    // graceful fallback (e.g. registry key inaccessible) rather than being
    // dropped outright — belt and suspenders, not a replacement.
    let machine_component = read_machine_guid().unwrap_or_else(|| "no-machine-guid".to_string());

    let fingerprint = format!(
        "{}-{}-{}-{}-{}-{}",
        HWID_SALT, machine_component, os_name, host_name, cpu_brand, cpu_count
    );

    let mut hasher = Sha256::new();
    hasher.update(fingerprint.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result)
}

#[tauri::command]
fn capture_list_sources() -> Result<Vec<capture::CaptureSourceInfo>, String> {
    capture::list_sources()
}

#[tauri::command]
fn capture_start(app: tauri::AppHandle, config: capture::CaptureConfig) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<capture::NalUnit>();
    let (ptx, prx) = std::sync::mpsc::channel::<capture::CapturePreviewFrame>();
    let (otx, orx) = std::sync::mpsc::channel::<capture::NalUnit>();
    capture::start_capture(config, tx, Some(ptx), Some(otx))?;
    // Relay NAL units
    let app2 = app.clone();
    std::thread::spawn(move || {
        while let Ok(unit) = rx.recv() {
            let ipc = IpcNalUnit {
                data_b64:     capture::to_base64(&unit.data),
                is_keyframe:  unit.is_keyframe,
                timestamp_ms: unit.timestamp_ms,
            };
            let emit_t = std::time::Instant::now();
            let _ = app2.emit("specter://capture-nal", ipc);
            #[cfg(feature = "dev_perf")]
            capture::perf::record_ipc_emit_ms(emit_t.elapsed().as_secs_f64() * 1000.0);
        }
    });
    // Relay overlay NAL units; emit codec on first unit so CommLink uses the real codec string
    let app3 = app.clone();
    std::thread::spawn(move || {
        let mut codec_announced = false;
        while let Ok(unit) = orx.recv() {
            if !codec_announced {
                let _ = app3.emit("specter://overlay-codec", unit.codec_name);
                codec_announced = true;
            }
            let ipc = IpcNalUnit {
                data_b64:     capture::to_base64(&unit.data),
                is_keyframe:  unit.is_keyframe,
                timestamp_ms: unit.timestamp_ms,
            };
            let emit_t = std::time::Instant::now();
            let _ = app3.emit("specter://capture-nal-overlay", ipc);
            #[cfg(feature = "dev_perf")]
            capture::perf::record_ipc_emit_ms(emit_t.elapsed().as_secs_f64() * 1000.0);
        }
    });
    // Relay preview frames
    std::thread::spawn(move || {
        while let Ok(frame) = prx.recv() {
            let _ = app.emit("specter://capture-preview", frame);
        }
    });
    Ok(())
}

#[tauri::command]
fn capture_stop() -> Result<(), String> {
    capture::stop_capture()
}

/// Returns a JSON performance report.
/// Returns an error string if the feature is not compiled in or the session is not running.
#[tauri::command]
fn capture_get_perf_report() -> Result<serde_json::Value, String> {
    #[cfg(feature = "dev_perf")]
    {
        let report = capture::perf::build_report()
            .ok_or_else(|| "perf session not running".to_string())?;
        serde_json::to_value(report).map_err(|e| e.to_string())
    }
    #[cfg(not(feature = "dev_perf"))]
    Err("dev_perf feature not compiled".to_string())
}

#[tauri::command]
fn capture_list_monitors() -> Result<Vec<String>, String> {
    capture::list_monitors()
}

#[tauri::command]
fn capture_get_compatibility_report() -> serde_json::Value {
    capture::get_compatibility_report_json()
}

// ─── Encrypted Credentials Storage ────────────────────────────────────────────
// Credentials are AES-256-GCM encrypted with a key held in the OS credential
// store (Windows Credential Manager / macOS Keychain / Linux Secret Service).
// The file is stored in the app data directory and is unreadable without that
// OS-protected key, which — unlike a machine-fingerprint-derived key — can't
// be recomputed by anyone who merely has local file read access.

#[derive(serde::Serialize)]
struct SavedCredentials {
    email: String,
    password: String,
}

const CREDS_KEYRING_SERVICE: &str = "specter-coms";
const CREDS_KEYRING_USER: &str = "creds-key";

/// Get (or lazily create) the 32-byte key protecting saved login credentials,
/// stored via the OS credential store rather than derived from anything an
/// attacker with local file access could recompute.
fn creds_key() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(CREDS_KEYRING_SERVICE, CREDS_KEYRING_USER)
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

fn creds_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(".specter_creds"))
}

/// Encrypt and persist the user's login credentials to the app data directory.
/// The file is AES-256-GCM encrypted with a machine-specific key so it cannot
/// be used on another device.
#[tauri::command]
fn save_credentials(app: tauri::AppHandle, email: String, password: String) -> Result<(), String> {
    let key_bytes = creds_key()?;
    let key       = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher    = Aes256Gcm::new(key);

    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let payload    = serde_json::json!({ "e": email, "p": password }).to_string();
    let ciphertext = cipher.encrypt(nonce, payload.as_bytes())
        .map_err(|e| format!("encrypt error: {e}"))?;

    let path = creds_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ciphertext);
    std::fs::write(&path, blob).map_err(|e| e.to_string())?;
    Ok(())
}

/// Load and decrypt saved credentials. Returns None if no credentials are saved,
/// the file is corrupted, or the machine fingerprint has changed.
#[tauri::command]
fn load_credentials(app: tauri::AppHandle) -> Option<SavedCredentials> {
    let path = creds_path(&app).ok()?;
    let blob = std::fs::read(&path).ok()?;
    if blob.len() < 13 { return None; }

    let key_bytes = creds_key().ok()?;
    let key       = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher    = Aes256Gcm::new(key);
    let nonce     = Nonce::from_slice(&blob[..12]);

    let plaintext = cipher.decrypt(nonce, &blob[12..]).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&plaintext).ok()?;

    Some(SavedCredentials {
        email:    json.get("e")?.as_str()?.to_string(),
        password: json.get("p")?.as_str()?.to_string(),
    })
}

/// Delete saved credentials. Called on explicit logout so auto-login is disabled
/// until the user logs in manually again.
#[tauri::command]
fn delete_credentials(app: tauri::AppHandle) -> Result<(), String> {
    let path = creds_path(&app).unwrap_or_default();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Managed state holding the overlay WebviewWindow so commands can access it
/// without needing to look it up by label (which can fail if Tauri internals
/// haven't fully initialised the window registry yet).
struct OverlayHandle(Mutex<Option<WebviewWindow>>);

/// Return an overlay window, rebuilding it when the cached handle is stale or
/// the window is missing from Tauri's registry.
fn ensure_overlay_window(state: &tauri::State<OverlayHandle>, app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    {
        let mut guard = lock_ignore_poison(&state.0);
        write_setup_error("[overlay] ensure: state lock acquired");
        if let Some(cached) = guard.clone() {
            if app.get_webview_window("specter-overlay").is_some() {
                return Ok(cached);
            }
            write_setup_error("[overlay] ensure: cached handle stale; window missing from registry");
            *guard = None;
        }

        if let Some(existing) = app.get_webview_window("specter-overlay") {
            write_setup_error("[overlay] ensure: adopting existing window from registry");
            *guard = Some(existing.clone());
            return Ok(existing);
        }
    }

    write_setup_error("[overlay] ensure: no overlay window exists; building on demand");
    let overlay = build_overlay(app)?;
    let _ = overlay.hide();
    let mut guard = lock_ignore_poison(&state.0);
    *guard = Some(overlay.clone());
    Ok(overlay)
}

/// Does the actual ensure/build/position/show/verify work. Runs ONLY on the
/// main thread — callers must dispatch to it via `run_on_main_thread` from a
/// freshly spawned thread (see `show_overlay` below), never call this
/// directly from a Tauri command's own execution context.
fn do_show_overlay_on_main_thread(app: &tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    write_setup_error("[overlay] show_overlay task start (main thread)");
    let state = app.state::<OverlayHandle>();
    let mut last_err: Option<String> = None;

    for attempt in 0..2 {
        if attempt == 1 {
            write_setup_error("[overlay] first show failed; rebuilding overlay window and retrying");
            if let Some(existing) = app.get_webview_window("specter-overlay") {
                let _ = existing.close();
            }
            let mut guard = lock_ignore_poison(&state.0);
            *guard = None;
        }

        let win = match ensure_overlay_window(&state, app) {
            Ok(w) => w,
            Err(e) => {
                let known: Vec<String> = app.webview_windows().keys().cloned().collect();
                let reason = format!("show_overlay ensure failed: {e}; known windows: {:?}", known);
                write_setup_error(&format!("[overlay] {reason}"));
                last_err = Some(reason);
                continue;
            }
        };

        write_setup_error(&format!("[overlay] ensure_overlay_window ok (attempt {})", attempt + 1));
        apply_overlay_window_priority(&win);

        if let Err(e) = win.set_position(tauri::LogicalPosition::new(x, y)) {
            let reason = format!("set_position failed: {e}");
            write_setup_error(&format!("[overlay] {reason}"));
            last_err = Some(reason);
            continue;
        }
        write_setup_error("[overlay] set_position ok");

        if let Err(e) = win.show() {
            let reason = format!("show failed: {e}");
            write_setup_error(&format!("[overlay] {reason}"));
            last_err = Some(reason);
            continue;
        }

        write_setup_error("[overlay] show ok");

        // win.show() reports success unconditionally on Windows even when
        // ShowWindow silently failed to restore visibility for a previously-
        // hidden window (see force_show_overlay_window's doc comment).
        // Verify and correct that before treating this as a real success.
        #[cfg(target_os = "windows")]
        match win.is_visible() {
            Ok(false) => {
                write_setup_error("[overlay] win.show() reported ok but window is not visible; forcing via SetWindowPos");
                force_show_overlay_window();
            }
            Ok(true) => {}
            Err(e) => write_setup_error(&format!("[overlay] is_visible check failed: {e}")),
        }

        #[cfg(target_os = "windows")]
        try_exclude_overlay_from_capture();

        let payload = OverlayShowResult {
            ok: true,
            reason: String::new(),
        };
        let _ = app.emit("specter://overlay-show-result", payload);
        write_setup_error("[overlay] emitted overlay-show-result ok=true");
        return Ok(());
    }

    let reason = last_err.unwrap_or_else(|| "overlay show failed for unknown reason".to_string());
    let _ = app.emit(
        "specter://overlay-show-result",
        OverlayShowResult {
            ok: false,
            reason: reason.clone(),
        },
    );
    write_setup_error(&format!("[overlay] emitted overlay-show-result ok=false reason={reason}"));
    Err(reason)
}

/// Show the overlay window and move it to (x, y) in logical pixels.
///
/// Tauri's invoke() dispatch runs a command handler nested inside the
/// invoking window's WebView2 callback context (IPC is implemented via a
/// WebResourceRequested interception on that window). WebviewWindowBuilder::
/// build() — inside ensure_overlay_window, when the window doesn't already
/// exist — runs its own nested Win32 message pump while it waits for
/// CoreWebView2Controller creation to complete. Calling that synchronously
/// from within an already-active WebView2 callback is exactly the reentrancy
/// hazard Microsoft's WebView2 threading docs warn about: "If a WebView2 app
/// tries to create a nested message loop or modal UI synchronously within a
/// WebView2 event handler, this approach leads to attempted reentrancy...
/// [and] would leave the event handler in the stack indefinitely."
/// (https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/threading-model)
/// That's a precise match for a permanent whole-app freeze. Marking this
/// command `async` does NOT fix this — WebView2 creation must still happen on the UI thread's
/// message pump regardless of which thread polls the Rust future, and Tauri
/// still marshals the actual `.build()` call onto the main thread internally.
///
/// The fix: never call `do_show_overlay_on_main_thread` directly from this
/// command's own call stack. Spawn a fresh OS thread — which is guaranteed
/// not to be nested inside any WebView2 callback — and have THAT thread
/// schedule the real work via `run_on_main_thread`, so it runs on a later,
/// non-reentrant iteration of the main event loop after this command's
/// invoking callback has already returned. This mirrors the startup pre-warm
/// path, which uses the identical spawn-thread + run_on_main_thread pattern
/// and has never exhibited this hang.
#[tauri::command]
async fn show_overlay(app: tauri::AppHandle, x: f64, y: f64) -> Result<(), String> {
    write_setup_error(&format!("[overlay] show_overlay requested at ({x:.0},{y:.0})"));

    let (tx, mut rx) = tauri::async_runtime::channel::<Result<(), String>>(1);
    let spawn_handle = app.clone();
    std::thread::spawn(move || {
        let main_thread_handle = spawn_handle.clone();
        if let Err(e) = spawn_handle.run_on_main_thread(move || {
            let outcome = do_show_overlay_on_main_thread(&main_thread_handle, x, y);
            let _ = tx.blocking_send(outcome);
        }) {
            write_setup_error(&format!("[overlay] show_overlay run_on_main_thread scheduling failed: {e}"));
        }
    });

    match rx.recv().await {
        Some(result) => result,
        None => Err("overlay show worker thread dropped without a result".to_string()),
    }
}

/// Hide the overlay window from the backend.
#[tauri::command]
fn hide_overlay(state: tauri::State<OverlayHandle>, app: tauri::AppHandle) -> Result<(), String> {
    let win_opt = {
        let guard = lock_ignore_poison(&state.0);
        guard.clone()
    };
    if let Some(win) = win_opt.or_else(|| app.get_webview_window("specter-overlay")) {
        win.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return the contents of the capture diagnostics log and clear it.
/// Called by the frontend after a capture failure to surface error details to the user.
#[tauri::command]
fn capture_get_errors() -> String {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let path = std::path::Path::new(&appdata)
            .join("specter-coms")
            .join("capture_errors.log");
        if let Ok(content) = std::fs::read_to_string(&path) {
            // Clear the log after reading so stale errors are not shown again.
            let _ = std::fs::remove_file(&path);
            return content;
        }
    }
    String::new()
}

/// Return capture breadcrumb trace log without clearing it.
#[tauri::command]
fn capture_get_breadcrumbs() -> String {
    capture::get_capture_breadcrumbs()
}

/// Return the persistent app-startup/window-setup diagnostic log (see
/// write_setup_error's doc comment) without clearing it — this is cumulative
/// history across app runs, unlike capture_errors.log which is cleared per-read.
#[tauri::command]
fn get_setup_errors() -> String {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let path = std::path::Path::new(&appdata)
            .join("specter-coms")
            .join("setup_errors.log");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    String::new()
}

/// Return the per-session capture debug log written by encoder.rs's capture_log
/// (truncated fresh at the start of each capture session — see new_d3d11va).
#[tauri::command]
fn get_capture_debug_log() -> String {
    let path = std::env::temp_dir().join("specter_capture_debug.txt");
    std::fs::read_to_string(&path).unwrap_or_default()
}

/// Return the app's tauri-plugin-log output (the `log` crate's global sink —
/// captures log::info!/warn!/error! from anywhere in the process, including
/// the audio plugin's device/decode errors). See the plugin() call in run()
/// for why this is now enabled in release builds too.
#[tauri::command]
fn get_app_log(app: tauri::AppHandle) -> String {
    let Ok(dir) = app.path().app_log_dir() else { return String::new(); };
    // tauri-plugin-log names the file after the app; identifier here is the
    // binary name ("app") per Cargo.toml's [[bin]] — matches its own default.
    let path = dir.join("app.log");
    std::fs::read_to_string(&path).unwrap_or_default()
}

#[tauri::command]
fn client_log(msg: String) {
    write_setup_error(&format!("[client] {msg}"));
}

/// Close the app via the main window's close button. TitleBar.jsx invokes this
/// (its own doc comment says it wants a "direct AppHandle::exit(0)") — routed
/// through `main_win.close()` instead so it triggers the existing CloseRequested
/// handler below, which drains the capture pipeline first; calling app.exit(0)
/// directly here would skip that and risk the NvEncDestroyEncoder-while-frames-
/// queued crash the CloseRequested handler's comment describes.
#[tauri::command]
fn close_app(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main_win) = app.get_webview_window("main") {
        main_win.close().map_err(|e| e.to_string())
    } else {
        app.exit(0);
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Install a panic hook that logs to stderr AND a persistent file before the
  // default handler runs. eprintln! alone is not reliable for this Windows-
  // subsystem (no console) exe — see write_setup_error's doc comment. This is
  // the only way to see a panic that isn't a raw OS-level access violation
  // (those go through Windows Error Reporting / crash dumps instead) — e.g. a
  // main-thread panic that exits the whole process cleanly with no dump.
  let default_hook = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |info| {
      let thread = std::thread::current();
      let name = thread.name().unwrap_or("<unnamed>");
      write_setup_error(&format!("[PANIC] thread '{}': {}", name, info));
      default_hook(info);
  }));

  tauri::Builder::default()
    .manage(MisconductReportBuffer { frames: Mutex::new(VecDeque::new()) })
    .manage(OverlayHandle(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![get_hwid, submit_report_frame, snip_report_clip, capture_start, capture_stop, capture_list_monitors, capture_list_sources, capture_get_perf_report, capture_get_errors, capture_get_breadcrumbs, get_setup_errors, get_capture_debug_log, get_app_log, client_log, capture_get_compatibility_report, save_credentials, load_credentials, delete_credentials, show_overlay, hide_overlay, close_app])
    .plugin(tauri_plugin_specter_audio::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .setup(|app| {
      // CA-1a: Handle both CloseRequested and Destroyed on the main window.
      // CloseRequested: on Windows with transparent:true, WebView2 can silently swallow
      // the native X-button WM_NCLBUTTONUP — calling app.exit(0) here makes close explicit.
      // Destroyed: clean up the always-on-top overlay so it doesn't outlive the parent app.
      let handle = app.handle().clone();
      if let Some(main_win) = app.get_webview_window("main") {
        main_win.on_window_event(move |event| {
          match event {
            tauri::WindowEvent::CloseRequested { .. } => {
              // Drain the NVENC pipeline before exiting so NvEncDestroyEncoder
              // is not called while GPU frames are still queued — that raises a
              // Windows structured exception that bypasses Rust's panic handler.
              //
              // capture::stop_capture() joins the capture thread with no timeout
              // (capture/mod.rs) — if a GPU/driver-level teardown call (DXGI
              // session Close, device Release, etc.) ever hangs, that join blocks
              // forever. Since this handler runs inline on the main thread's
              // Win32 message loop, that would freeze the pump permanently:
              // handle.exit(0) below never runs (app becomes unclosable), and
              // every subsequent window operation that marshals onto the main
              // thread (e.g. show_overlay's WebviewWindowBuilder::build()/
              // set_position()/show()) hangs forever too, with no error surfaced
              // anywhere. Run the drain on a side thread and bound the wait so a
              // stuck capture teardown can no longer take the whole app down.
              write_setup_error("[main] CloseRequested — exiting via app.exit(0)");
              let (drain_tx, drain_rx) = std::sync::mpsc::channel();
              std::thread::spawn(move || {
                let _ = capture::stop_capture();
                let _ = drain_tx.send(());
              });
              if drain_rx.recv_timeout(std::time::Duration::from_secs(5)).is_err() {
                write_setup_error("[main] stop_capture did not complete within 5s; exiting anyway");
              }
              handle.exit(0);
            }
            tauri::WindowEvent::Destroyed => {
              let state = handle.state::<OverlayHandle>();
              let guard = lock_ignore_poison(&state.0);
              if let Some(overlay) = guard.as_ref() {
                let _ = overlay.close();
              }
            }
            _ => {}
          }
        });
      }
      // Pre-create the hidden overlay window from a background thread. NEVER
      // build it on the main thread (neither here in setup nor in a sync
      // command): WebviewWindowBuilder::build() on the main thread runs a
      // nested message pump that can dispatch an asset-protocol request whose
      // handler blocks on the creation lock — permanent deadlock, app-wide
      // freeze (cdb-confirmed on 1.9.1). From a worker thread the build is
      // queued to the healthy event loop instead. The short sleep lets the
      // event loop start first.
      let precreate_handle = app.handle().clone();
      std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        match build_overlay(&precreate_handle) {
          Ok(win) => {
            let _ = win.hide();
            let state = precreate_handle.state::<OverlayHandle>();
            *lock_ignore_poison(&state.0) = Some(win);
            write_setup_error("[overlay] pre-created hidden overlay window (background)");
          }
          Err(e) => {
            write_setup_error(&format!("[overlay] background pre-create failed: {e}; will build on demand"));
          }
        }
      });
      // Previously debug-only. Release builds have no console (Windows subsystem
      // exe) and nothing else captures the `log` crate's output — every
      // log::warn!/error! in the audio plugin (device errors, decode failures)
      // was silently discarded for real users, leaving zero trace of audio
      // issues. Enabled unconditionally now; default target is the app's log
      // dir (see get_app_log below), Info level keeps volume reasonable.
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
