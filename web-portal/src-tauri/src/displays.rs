//! displays.rs — the displays attached to this PC, with names people
//! recognise, plus the "Show Specter on" preference (C1).
//!
//! Shared on purpose (plan C1 ⚖): the strip uses it to pick its monitor, and
//! capture's source picker or a later output picker can use the same listing
//! and naming instead of growing their own.
//!
//! Naming: Tauri's monitors only carry the GDI name ("\\.\DISPLAY2"). Windows'
//! display-config API maps that GDI name to the monitor's EDID friendly name
//! ("DELL U2720Q") and its device path, which stays the same for that physical
//! monitor across reboots and replugs (DISPLAYn numbers can reshuffle), so the
//! saved choice is keyed by the device path when there is one.
//!
//! The preference is saved on the Rust side (app data `display.json`) so it
//! applies to the very first dock at launch, before the page loads.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Monitor, WebviewWindowBuilder};

use crate::write_setup_error;

/// One display as the UI shows it.
#[derive(Clone, serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    /// Stable key: the monitor's device path, else its GDI name.
    pub id: String,
    /// "\\.\DISPLAY2" — how Tauri's Monitor names it.
    pub gdi_name: String,
    /// 1-based, left to right then top to bottom; what Identify flashes.
    pub number: usize,
    /// EDID friendly name ("DELL U2720Q"), or "Display 2" without one.
    pub friendly: String,
    /// "DELL U2720Q · 2560×1440 · main"
    pub label: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub primary: bool,
    pub scale: f64,
}

/// The saved "Show Specter on" choice. None / no file = Auto (the monitor
/// under the tray icon, else the primary — the behaviour before C1).
#[derive(Clone, serde::Serialize, serde::Deserialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StripDisplayPref {
    pub id: String,
    #[serde(default)]
    pub gdi_name: String,
    /// The label when it was chosen, so Settings can still name it while it's
    /// unplugged ("DELL U2720Q — not connected, using Auto").
    #[serde(default)]
    pub label: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DisplayFile {
    #[serde(default)]
    strip_display: Option<StripDisplayPref>,
}

/// Cached file contents; None until first read.
static PREF: Mutex<Option<Option<StripDisplayPref>>> = Mutex::new(None);

fn pref_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("display.json"))
}

pub fn strip_pref(app: &AppHandle) -> Option<StripDisplayPref> {
    let mut cache = PREF.lock().unwrap_or_else(|e| e.into_inner());
    if cache.is_none() {
        let loaded = pref_path(app)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<DisplayFile>(&b).ok())
            .and_then(|f| f.strip_display);
        *cache = Some(loaded);
    }
    cache.clone().flatten()
}

fn save_strip_pref(app: &AppHandle, pref: Option<StripDisplayPref>) -> Result<(), String> {
    let path = pref_path(app).ok_or("no app data directory")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::to_vec_pretty(&DisplayFile { strip_display: pref.clone() }).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("saving display.json: {e}"))?;
    *PREF.lock().unwrap_or_else(|e| e.into_inner()) = Some(pref);
    Ok(())
}

/// GDI name → (friendly name, device path) for every active display.
#[cfg(target_os = "windows")]
fn friendly_names() -> std::collections::HashMap<String, (String, String)> {
    use windows::Win32::Devices::Display::{
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
        DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
        DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
        DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
    };
    use windows::Win32::Foundation::ERROR_SUCCESS;

    fn wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    let mut out = std::collections::HashMap::new();
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) != ERROR_SUCCESS {
            return out;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        if QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut np, paths.as_mut_ptr(), &mut nm, modes.as_mut_ptr(), None)
            != ERROR_SUCCESS
        {
            return out;
        }
        paths.truncate(np as usize);
        for p in &paths {
            let mut src = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            src.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
            src.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
            src.header.adapterId = p.sourceInfo.adapterId;
            src.header.id = p.sourceInfo.id;
            if DisplayConfigGetDeviceInfo(&mut src.header) != 0 {
                continue;
            }
            let mut tgt = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            tgt.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            tgt.header.size = std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            tgt.header.adapterId = p.targetInfo.adapterId;
            tgt.header.id = p.targetInfo.id;
            if DisplayConfigGetDeviceInfo(&mut tgt.header) != 0 {
                continue;
            }
            let gdi = wide(&src.viewGdiDeviceName);
            // A cloned/duplicated display has several targets on one source;
            // the first one names it.
            out.entry(gdi).or_insert((wide(&tgt.monitorFriendlyDeviceName), wide(&tgt.monitorDevicePath)));
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn friendly_names() -> std::collections::HashMap<String, (String, String)> {
    Default::default()
}

/// Every connected display, numbered left to right, with Tauri's Monitor.
fn list_with_monitors(app: &AppHandle) -> Vec<(DisplayInfo, Monitor)> {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let names = friendly_names();
    let mut v: Vec<Monitor> = monitors;
    v.sort_by_key(|m| (m.position().x, m.position().y));
    let mut out: Vec<(DisplayInfo, Monitor)> = Vec::new();
    for (i, m) in v.into_iter().enumerate() {
        let gdi = m.name().cloned().unwrap_or_default();
        let (friendly, path) = names.get(&gdi).cloned().unwrap_or_default();
        // Built-in laptop panels often have no EDID name.
        let friendly = if friendly.is_empty() { format!("Display {}", i + 1) } else { friendly };
        let is_primary = primary.as_ref().is_some_and(|p| *p == gdi);
        let info = DisplayInfo {
            id: if path.is_empty() { gdi.clone() } else { path },
            gdi_name: gdi,
            number: i + 1,
            friendly,
            label: String::new(),
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            primary: is_primary,
            scale: m.scale_factor(),
        };
        out.push((info, m));
    }
    // Two identical monitors get their number added so they can be told apart.
    let dupes: Vec<String> = out
        .iter()
        .filter(|(a, _)| out.iter().filter(|(b, _)| b.friendly == a.friendly).count() > 1)
        .map(|(a, _)| a.friendly.clone())
        .collect();
    for (d, _) in out.iter_mut() {
        let name = if dupes.contains(&d.friendly) { format!("{} ({})", d.friendly, d.number) } else { d.friendly.clone() };
        d.label = format!("{name} · {}×{}{}", d.width, d.height, if d.primary { " · main" } else { "" });
    }
    out
}

pub fn list(app: &AppHandle) -> Vec<DisplayInfo> {
    list_with_monitors(app).into_iter().map(|(d, _)| d).collect()
}

/// The monitor the user chose for the strip, if it's set and connected.
/// The device path is matched first; the GDI name only when that's all the
/// choice has (DISPLAYn numbers move around, so a path miss means unplugged).
pub fn chosen_strip_monitor(app: &AppHandle) -> Option<Monitor> {
    let pref = strip_pref(app)?;
    let all = list_with_monitors(app);
    let hit = all
        .iter()
        .find(|(d, _)| d.id == pref.id)
        .or_else(|| {
            let id_is_gdi = pref.id.starts_with(r"\\.\");
            if id_is_gdi { all.iter().find(|(d, _)| d.gdi_name == pref.gdi_name) } else { None }
        })
        .map(|(_, m)| m.clone());
    if hit.is_none() {
        static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
            write_setup_error("[displays] chosen strip monitor not connected; using Auto");
        }
    }
    hit
}

// ── Identify ───────────────────────────────────────────────────────────────

const IDENTIFY_FOR: Duration = Duration::from_secs(3);
const IDENTIFY_SIZE: u32 = 220; // physical px, before scale

fn identify_html(n: usize) -> String {
    format!(
        "<!doctype html><meta charset=utf-8><style>html,body{{margin:0;height:100%;background:transparent;overflow:hidden}}\
         div{{box-sizing:border-box;height:100%;display:flex;align-items:center;justify-content:center;\
         border-radius:24px;background:rgba(6,14,22,.88);border:3px solid #22d3ee;color:#e6fbff;\
         font:700 120px/1 system-ui,'Segoe UI',sans-serif;user-select:none}}</style><div>{n}</div>"
    )
}

/// Flashes each display's number on it for ~3 s. Builds from a fresh thread
/// (building webview windows from a handler on the main thread is the
/// overlay's old deadlock).
pub fn identify(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut labels = Vec::new();
        for (d, m) in list_with_monitors(&app) {
            let label = format!("identify-{}", d.number);
            if let Some(old) = app.get_webview_window(&label) {
                let _ = old.close();
            }
            let html = identify_html(d.number);
            let url = format!("data:text/html;charset=utf-8,{}", urlencode(&html));
            let Ok(url) = url.parse() else { continue };
            let built = WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
                .title("Identify")
                .visible(false)
                // Never activated: taking focus would blur-hide the strip the
                // user just pressed Identify in.
                .focusable(false)
                .focused(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .build();
            match built {
                Ok(w) => {
                    let side = (IDENTIFY_SIZE as f64 * m.scale_factor()) as u32;
                    let pos = m.position();
                    let x = pos.x + 48;
                    let y = pos.y + 48;
                    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                    let _ = w.set_size(tauri::PhysicalSize::new(side, side));
                    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                    let _ = w.set_ignore_cursor_events(true);
                    let _ = w.show();
                    labels.push(label);
                }
                Err(e) => write_setup_error(&format!("[displays] identify window {} failed: {e}", d.number)),
            }
        }
        std::thread::sleep(IDENTIFY_FOR);
        for l in labels {
            if let Some(w) = app.get_webview_window(&l) {
                let _ = w.close();
            }
        }
    });
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── Commands ───────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StripDisplayState {
    displays: Vec<DisplayInfo>,
    /// The saved choice (None = Auto).
    chosen: Option<StripDisplayPref>,
    /// The choice is set but that display isn't connected (Auto is in use).
    chosen_missing: bool,
}

#[tauri::command]
pub fn displays_list(app: AppHandle) -> Vec<DisplayInfo> {
    list(&app)
}

#[tauri::command]
pub fn strip_display_get(app: AppHandle) -> StripDisplayState {
    let displays = list(&app);
    let chosen = strip_pref(&app);
    let chosen_missing = chosen.as_ref().is_some_and(|c| {
        !displays.iter().any(|d| d.id == c.id || (c.id.starts_with(r"\\.\") && d.gdi_name == c.gdi_name))
    });
    StripDisplayState { displays, chosen, chosen_missing }
}

/// `id` None = Auto. Re-docks the strip right away if it's showing.
#[tauri::command]
pub fn strip_display_set(app: AppHandle, id: Option<String>) -> Result<StripDisplayState, String> {
    let pref = match id {
        None => None,
        Some(id) => {
            let d = list(&app).into_iter().find(|d| d.id == id).ok_or("That display isn't connected")?;
            Some(StripDisplayPref { id: d.id, gdi_name: d.gdi_name, label: d.label })
        }
    };
    save_strip_pref(&app, pref)?;
    crate::strip::redock_if_visible(&app);
    Ok(strip_display_get(app))
}

#[tauri::command]
pub fn displays_identify(app: AppHandle) {
    identify(&app);
}
