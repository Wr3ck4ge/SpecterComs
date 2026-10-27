//! strip.rs — the tray "strip" window (the app's front door since the S9
//! redesign) and the hidden "engine" main window's lifecycle.
//!
//! The strip
//! ---------
//! A frameless, transparent, always-on-top window docked just above the
//! taskbar's notification area. It's pre-created hidden on a background
//! thread at startup (never on the main thread — see the deadlock note on
//! the overlay pre-create in lib.rs's setup), shown on its own once its page
//! has mounted (`strip_ready`), toggled by a left click on the tray icon and
//! hidden when it loses focus.
//!
//! Pinned / collapsed (SV): while the page has a panel the user is watching
//! (the stream viewer) it pins the strip (`strip_set_pinned`). Focus loss then
//! collapses the strip instead of hiding it: the window stays shown and the
//! page drops everything but the pinned panel from its region
//! (`strip-collapsed`), so the rest of the screen clicks through. The tray
//! icon expands a collapsed strip again (`strip-shown`) and collapses an
//! expanded pinned one; it never hides the pinned panel. Closing the panel
//! unpins (and hides a collapsed strip).
//!
//! Cabinets (the panels that slide up from the bar) work WITHOUT resizing the
//! window. The window is created once at its full size (bar + tallest
//! cabinet, clamped to the monitor's work area) and is clipped to what's
//! actually on screen with a Win32 window region (SetWindowRgn). The page
//! reports the rectangles of its visible panels (`strip_set_region`) and
//! everything outside them is neither drawn nor hit-tested, so clicks there
//! fall through to whatever is underneath. Why not grow the window per
//! cabinet: WebView2 re-lays-out a resized window asynchronously, so for a
//! frame or two the old frame is drawn at the window's new top-left — when
//! the window grows upward the bar visibly jumps. A region change is atomic
//! and nothing is re-laid-out, so the bar never moves. It also means the
//! strip looks right even if WebView2's transparency misbehaves on some
//! machine: the region alone hides everything outside the panels (only the
//! rounded panel corners would show the window background). Ambient-mode
//! cards (later) are just more rectangles in the same region.
//!
//! The strip runs in its own WebView2 environment (its own user-data folder,
//! `strip-webview`), like the overlay: a second window in the main window's
//! browser process is exactly the setup that left the overlay's controller
//! creation hanging forever. Side effect: the strip's localStorage is its
//! own, not the main window's.
//!
//! The engine
//! ----------
//! The main window ("main") is NOT UI any more (user decision 2026-10-23):
//! the strip is the whole UI and the main window is only the hidden engine —
//! WarRoom/CommLink running voice, streams, MLS and the SSE connection, driven
//! by the strip over the engine bridge (web-portal/src/engine/bridge.js). It
//! starts hidden (tauri.conf.json `visible: false`) and nothing shows it: no
//! tray item, no strip button, no command. The one exception is a dev escape
//! hatch: launched with SPECTER_DEV_ENGINE_UI=1, the tray menu gets "Show
//! engine (dev)" (`show_engine_dev`). If the engine was destroyed while
//! logged out (tray_light close mode), a login from the strip rebuilds it
//! hidden (`ensure_engine`, wired to the `auth-changed` event in lib.rs).
//!
//! Window = the whole work area (P2A)
//! ---------------------------------
//! The window covers the docked monitor's entire work area (the screen minus
//! the taskbar). Nothing about it is visible except the panels in the window
//! region, so the size costs nothing, and any panel — a cabinet widening
//! sideways, the wide mission planner, ambient cards — can be laid out
//! anywhere on that monitor without ever resizing or moving the window (and
//! so without WebView2's re-layout jump). Per-feature width/height logic
//! (the old MAIN_WIDTH + SIDE_WIDTH by STRIP_HEIGHT window) is gone.
//!
//! LAYOUT CONTRACT (what the page gets in `strip_layout` / `strip-shown`,
//! all CSS px, relative to the page's viewport, which IS the work area):
//!   edge      'bottom' | 'top' | 'left' | 'right' — the taskbar's edge
//!   grow      'up' | 'down' — cabinets stack away from the taskbar: up,
//!             or down when the taskbar is at the top
//!   expand    'left' | 'right' — the free side: the side of the bar column
//!             with more screen room (normally left, the strip sits by the tray)
//!   barRect   { x, y, w, h } — the bar column ("bar anchor rect"): MAIN_WIDTH
//!             wide, docked where the strip always was (centred on the tray
//!             icon for a bottom/top taskbar, against the taskbar for a
//!             left/right one), spanning the work area's height minus
//!             STRIP_MARGIN at both ends. The bar sits at its `grow` origin end
//!             (bottom for 'up', top for 'down'); cabinets stack from there.
//!             The bar never moves while the strip is shown.
//!   freeRect  { x, y, w, h } — everything beside barRect on the `expand`
//!             side, up to STRIP_MARGIN from the screen edge. Wide panels
//!             (the planner) may use barRect ∪ freeRect; a panel that spans
//!             both should keep its column-side edge aligned with barRect.
//!   workArea  { w, h } — the viewport size (= window size), for clamping.
//!   scale     the monitor's scale factor (CSS px → physical px).
//! Every visible panel must carry `data-strip-region`; the page reports their
//! rects (`strip_set_region`) and everything else is clipped away.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder};

use crate::{background_sync, build_main_window, lock_ignore_poison, write_setup_error};

pub const STRIP_LABEL: &str = "specter-strip";

/// Logical (CSS px) width of the bar/cabinet column (`barRect`). Keep in sync
/// with MAIN_WIDTH in StripSidePanel.jsx. The window itself is the work area
/// (see "Window = the whole work area" above).
const MAIN_WIDTH: f64 = 420.0;
/// Gap between the strip and the taskbar / screen edge, logical px.
const STRIP_MARGIN: f64 = 8.0;
/// Region used before the page has reported its own (the logged-out card is
/// about this tall). Bottom-anchored.
const DEFAULT_REGION_HEIGHT: f64 = 120.0;
/// A tray click that arrives this soon after the strip hid itself on blur is
/// the same click that caused the blur (clicking the tray icon takes focus
/// first), so it must not re-show the strip — that's what makes the icon a
/// toggle.
const BLUR_TOGGLE_WINDOW: Duration = Duration::from_millis(400);
/// If the page never calls strip_ready (a JS crash), show it anyway.
const READY_FALLBACK: Duration = Duration::from_secs(8);

/// A rectangle of the strip page in CSS pixels, relative to the viewport.
#[derive(Clone, Copy, serde::Deserialize, Debug)]
pub struct RegionRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// A rectangle in CSS px relative to the strip page's viewport.
#[derive(Clone, Copy, serde::Serialize, Debug, Default, PartialEq)]
pub struct CssRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, Copy, serde::Serialize, Debug, Default, PartialEq)]
pub struct CssSize {
    w: f64,
    h: f64,
}

/// Where the strip is docked — the page's layout contract, see the module
/// doc's "LAYOUT CONTRACT" for every field.
#[derive(Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StripLayout {
    edge: &'static str,
    grow: &'static str,
    expand: &'static str,
    bar_rect: CssRect,
    free_rect: CssRect,
    work_area: CssSize,
    scale: f64,
}

impl Default for StripLayout {
    fn default() -> Self {
        Self {
            edge: "bottom",
            grow: "up",
            expand: "left",
            bar_rect: CssRect::default(),
            free_rect: CssRect::default(),
            work_area: CssSize::default(),
            scale: 1.0,
        }
    }
}

/// Pure layout maths (unit-tested below). Inputs in CSS px: the work area's
/// size, the taskbar edge, and the tray icon's x relative to the work area
/// (if known). Returns (expand, barRect, freeRect).
fn compute_columns(work_w: f64, work_h: f64, edge: &str, anchor_x: Option<f64>) -> (&'static str, CssRect, CssRect) {
    let m = STRIP_MARGIN;
    let col_w = MAIN_WIDTH.min(work_w - 2.0 * m).max(1.0);
    let min_x = m;
    let max_x = (work_w - m - col_w).max(min_x);
    let col_x = match (edge, anchor_x) {
        ("left", _) => min_x,
        ("right", _) => max_x,
        // Centre on the tray icon, kept on-screen.
        (_, Some(ax)) => (ax - col_w / 2.0).clamp(min_x, max_x),
        _ => max_x,
    };
    let col_h = (work_h - 2.0 * m).max(1.0);
    let bar = CssRect { x: col_x, y: m, w: col_w, h: col_h };
    let room_left = col_x - m;
    let room_right = work_w - m - (col_x + col_w);
    // Ties go left: the strip normally sits by the tray, at the right.
    if room_left >= room_right {
        ("left", bar, CssRect { x: m, y: m, w: room_left.max(0.0), h: col_h })
    } else {
        ("right", bar, CssRect { x: col_x + col_w, y: m, w: room_right.max(0.0), h: col_h })
    }
}

#[derive(Default)]
pub struct StripState {
    /// Set by the page while a form is mid-submit, so focus loss doesn't
    /// hide the strip under the user (e.g. a slow login).
    busy: AtomicBool,
    /// When the strip last hid itself on focus loss (see BLUR_TOGGLE_WINDOW).
    last_blur_hide: Mutex<Option<Instant>>,
    /// Centre of the tray icon from the last tray click, physical px.
    anchor: Mutex<Option<(f64, f64)>>,
    /// Last region the page reported, CSS px.
    region: Mutex<Option<Vec<RegionRect>>>,
    layout: Mutex<StripLayout>,
    /// Launch: show the strip as soon as its page is ready.
    show_when_ready: AtomicBool,
    /// SV: the page has a panel that must outlive focus loss (the stream
    /// viewer). Focus loss then COLLAPSES the strip instead of hiding it.
    pinned: AtomicBool,
    /// SV: shown but collapsed — the page shows only its pinned panel(s)
    /// (bar and cabinets are out of the region) until the next show_strip.
    collapsed: AtomicBool,
}

fn state(app: &AppHandle) -> tauri::State<'_, StripState> {
    app.state::<StripState>()
}

fn build_strip(app: &AppHandle) -> Result<WebviewWindow, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("strip-webview");
    let _ = std::fs::create_dir_all(&data_dir);

    let win = WebviewWindowBuilder::new(app, STRIP_LABEL, tauri::WebviewUrl::App("strip.html".into()))
        .title("SpecterComs Strip")
        .visible(false)
        .focused(false)
        // Frameless windows must not be sizable/maximizable, or Windows Snap
        // grabs them when dragged near an edge (the overlay lesson). The
        // strip isn't draggable at all, but keep the rule.
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .disable_drag_drop_handler()
        .data_directory(data_dir)
        // Own environment, so these needn't match the main window's. The
        // strip is hidden most of the time and doing nothing then, so it's
        // deliberately NOT exempted from background throttling (unlike the
        // engine and the overlay).
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI")
        // Placeholder: position_strip sizes it to the work area right after.
        .inner_size(MAIN_WIDTH, 600.0)
        .build()
        .map_err(|e| format!("Failed to build strip: {e}"))?;

    let handle = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            let st = state(&handle);
            if st.busy.load(Ordering::SeqCst) {
                return;
            }
            *lock_ignore_poison(&st.last_blur_hide) = Some(Instant::now());
            // SV: a pinned strip (stream viewer open) collapses to its pinned
            // panel instead of hiding — the user is watching it while they
            // work/play in another window.
            if st.pinned.load(Ordering::SeqCst) {
                collapse_strip(&handle);
                return;
            }
            // Don't manipulate a window synchronously from inside its own
            // event callback (see show_overlay's doc comment in lib.rs).
            let h = handle.clone();
            std::thread::spawn(move || {
                // Focus taken by one of our own hidden windows (the engine
                // rebuilt after login, the overlay being pre-created at
                // launch) isn't the user leaving: take it back instead of
                // hiding, or the strip vanishes right after launch/login.
                std::thread::sleep(Duration::from_millis(60));
                if foreground_is_own_hidden_window(&h) {
                    if let Some(win) = h.get_webview_window(STRIP_LABEL) {
                        let _ = win.set_focus();
                    }
                    return;
                }
                hide_strip(&h);
            });
        }
    });
    Ok(win)
}

/// Startup: pre-create the strip hidden from a background thread, docked to
/// the primary monitor's notification area. It's shown when the page calls
/// strip_ready (or after READY_FALLBACK).
pub fn start(app: AppHandle) {
    state(&app).show_when_ready.store(true, Ordering::SeqCst);
    std::thread::spawn(move || {
        // Let the event loop start first (same reason as the overlay's).
        std::thread::sleep(Duration::from_millis(300));
        // The strip is the only UI, so a failed build is retried once; after
        // that a tray click tries again (rebuild_strip).
        let built = build_strip(&app).or_else(|e| {
            write_setup_error(&format!("[strip] background pre-create failed: {e}; retrying"));
            std::thread::sleep(Duration::from_secs(2));
            build_strip(&app)
        });
        match built {
            Ok(win) => {
                write_setup_error("[strip] pre-created hidden strip window (background)");
                position_strip(&app, &win);
                apply_region(&app, &win);
            }
            Err(e) => {
                write_setup_error(&format!("[strip] pre-create failed twice: {e}; a tray click will retry"));
                state(&app).show_when_ready.store(false, Ordering::SeqCst);
                return;
            }
        }
        std::thread::sleep(READY_FALLBACK);
        if state(&app).show_when_ready.swap(false, Ordering::SeqCst) {
            write_setup_error("[strip] page never reported ready; showing anyway");
            show_strip(&app, None);
        }
    });
}

/// Picks the monitor (the one under the tray icon if we know where that is,
/// else the primary), works out which edge the taskbar is on from the
/// difference between the monitor and its work area, sizes the window to that
/// work area and works out the layout contract (bar column, free side). The
/// window maths is in physical pixels; the layout handed to the page is in
/// CSS px using the monitor's own scale factor, so it's right on mixed-DPI
/// setups (the window takes that monitor's scale once it's moved there).
fn position_strip(app: &AppHandle, win: &WebviewWindow) {
    let anchor = *lock_ignore_poison(&state(app).anchor);
    let monitor = anchor
        .and_then(|(x, y)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        write_setup_error("[strip] no monitor found; leaving strip where it is");
        return;
    };

    let scale = monitor.scale_factor();
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let work = monitor.work_area();
    let (wx, wy) = (work.position.x, work.position.y);
    let (ww, wh) = (work.size.width as i32, work.size.height as i32);

    // Auto-hide taskbars leave work area == monitor; treat that as bottom.
    let edge = if wy > mon_pos.y {
        "top"
    } else if wx > mon_pos.x {
        "left"
    } else if ww < mon_size.width as i32 {
        "right"
    } else {
        "bottom"
    };

    // The window is the work area. With an auto-hide taskbar the work area IS
    // the monitor, and a topmost window exactly covering a monitor is what
    // Windows' full-screen detection looks for (it would switch Focus Assist /
    // keep the taskbar from popping up over it), so stay 2px short of the
    // bottom then.
    let w = ww.max(1);
    let mut h = wh.max(1);
    if w == mon_size.width as i32 && h == mon_size.height as i32 {
        h = (h - 2).max(1);
    }
    let (x, y) = (wx, wy);

    // Position first so a move onto a monitor with another DPI (which makes
    // Windows rescale the window) happens before the size is applied, then
    // position again in case that rescale moved it. If the rescale still left
    // the wrong size (WM_DPICHANGED's suggested rect), apply it once more.
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    if let Ok(sz) = win.inner_size() {
        if sz.width != w as u32 || sz.height != h as u32 {
            let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
        }
    }

    let css_w = w as f64 / scale;
    let css_h = h as f64 / scale;
    let anchor_x = anchor.map(|(ax, _)| (ax - wx as f64) / scale);
    let (expand, bar_rect, free_rect) = compute_columns(css_w, css_h, edge, anchor_x);
    let layout = StripLayout {
        edge,
        grow: if edge == "top" { "down" } else { "up" },
        expand,
        bar_rect,
        free_rect,
        work_area: CssSize { w: css_w, h: css_h },
        scale,
    };
    let st = state(app);
    let changed = {
        let mut cur = lock_ignore_poison(&st.layout);
        let changed = *cur != layout;
        *cur = layout;
        changed
    };
    if changed {
        // The page's last region was laid out for the old geometry (other
        // monitor, taskbar moved); drop it so the default bar-sized region
        // shows until the page reports again for the new layout. (Never hold
        // the layout lock while taking the region lock: apply_region takes
        // them in the other order.)
        *lock_ignore_poison(&st.region) = None;
    }
}

/// Clips the strip window to the panels the page reported (or a default
/// bar-sized strip along the docked edge before it has reported any).
fn apply_region(app: &AppHandle, win: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::{BOOL, HWND};
        use windows::Win32::Graphics::Gdi::{
            CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ, RGN_OR,
        };

        let Ok(scale) = win.scale_factor() else { return };
        let Ok(size) = win.inner_size() else { return };
        let rects: Vec<RegionRect> = match lock_ignore_poison(&state(app).region).clone() {
            Some(r) => r,
            None => {
                let css_w = size.width as f64 / scale;
                let css_h = size.height as f64 / scale;
                let layout = lock_ignore_poison(&state(app).layout).clone();
                let top = layout.grow == "down";
                // The docked end of the bar column (barRect), or the
                // bottom-right corner before any layout exists.
                let bar = if layout.bar_rect.w > 0.0 {
                    layout.bar_rect
                } else {
                    let w = MAIN_WIDTH.min(css_w);
                    CssRect { x: css_w - w, y: 0.0, w, h: css_h }
                };
                let rh = DEFAULT_REGION_HEIGHT.min(bar.h);
                vec![RegionRect {
                    x: bar.x,
                    y: if top { bar.y } else { (bar.y + bar.h - rh).max(0.0) },
                    w: bar.w,
                    h: rh,
                }]
            }
        };
        // tauri's HWND is from its own `windows` version; go through the raw
        // pointer (see force_show_overlay_window's note in lib.rs).
        let Ok(raw) = win.hwnd() else { return };
        let hwnd = HWND(raw.0 as _);
        unsafe {
            let region = CreateRectRgn(0, 0, 0, 0);
            for r in &rects {
                let part = CreateRectRgn(
                    (r.x * scale).floor() as i32,
                    (r.y * scale).floor() as i32,
                    ((r.x + r.w) * scale).ceil() as i32,
                    ((r.y + r.h) * scale).ceil() as i32,
                );
                CombineRgn(region, region, part, RGN_OR);
                let _ = DeleteObject(HGDIOBJ(part.0));
            }
            // On success the system owns the region; free it only on failure.
            if SetWindowRgn(hwnd, region, BOOL(1)) == 0 {
                let _ = DeleteObject(HGDIOBJ(region.0));
                write_setup_error("[strip] SetWindowRgn failed");
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, win);
    }
}

/// Docks and shows the strip and gives it focus (so focus loss can hide it).
/// `anchor` is the tray icon's centre when this came from a tray click.
/// Callable from any thread, but never builds a window.
pub fn show_strip(app: &AppHandle, anchor: Option<(f64, f64)>) {
    let Some(win) = app.get_webview_window(STRIP_LABEL) else {
        write_setup_error("[strip] show requested but the strip window doesn't exist");
        return;
    };
    state(app).show_when_ready.store(false, Ordering::SeqCst);
    state(app).collapsed.store(false, Ordering::SeqCst); // SV: strip-shown expands the page again
    if anchor.is_some() {
        *lock_ignore_poison(&state(app).anchor) = anchor;
    }
    position_strip(app, &win);
    apply_region(app, &win);
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    let _ = win.set_focus();
    let layout = lock_ignore_poison(&state(app).layout).clone();
    let _ = app.emit_to(STRIP_LABEL, "strip-shown", layout);
}

/// Is the foreground window one of this process's own windows that the user
/// can't see (the hidden engine, a window still being built)? Those take focus
/// as a side effect, never because the user went there. The strip itself
/// counts too: focus already came back. A *visible* own window (the overlay
/// the user just clicked) does not.
#[cfg(target_os = "windows")]
fn foreground_is_own_hidden_window(app: &AppHandle) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible};
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_invalid() {
        return false;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(fg, Some(&mut pid)) };
    if pid != std::process::id() {
        return false;
    }
    let strip_has_it = app
        .get_webview_window(STRIP_LABEL)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    strip_has_it || !unsafe { IsWindowVisible(fg) }.as_bool()
}

#[cfg(not(target_os = "windows"))]
fn foreground_is_own_hidden_window(_app: &AppHandle) -> bool {
    false
}

pub fn hide_strip(app: &AppHandle) {
    state(app).collapsed.store(false, Ordering::SeqCst); // SV
    if let Some(win) = app.get_webview_window(STRIP_LABEL) {
        let _ = win.hide();
        let _ = app.emit_to(STRIP_LABEL, "strip-hidden", ());
    }
}

/// SV: keep the strip shown but collapsed to its pinned panel(s). The window
/// stays visible and always-on-top; the page drops the bar and cabinets out
/// of its region (`strip-collapsed`), so only the pinned panel is drawn and
/// hit-tested and everything else clicks through. Only an emit, so it's safe
/// from the window's own event callback.
pub fn collapse_strip(app: &AppHandle) {
    state(app).collapsed.store(true, Ordering::SeqCst);
    let _ = app.emit_to(STRIP_LABEL, "strip-collapsed", ());
}

/// Left click on the tray icon: toggle the strip.
pub fn on_tray_left_click(app: &AppHandle, anchor: (f64, f64)) {
    let Some(win) = app.get_webview_window(STRIP_LABEL) else {
        // No strip (pre-create failed or still running): build it and show it.
        rebuild_strip(app, anchor);
        return;
    };
    let recently_blurred = lock_ignore_poison(&state(app).last_blur_hide)
        .map(|t| t.elapsed() < BLUR_TOGGLE_WINDOW)
        .unwrap_or(false);
    if win.is_visible().unwrap_or(false) {
        let st = state(app);
        // SV: collapsed (pinned panel only) → expand again, unless this is
        // the click whose focus change just collapsed it (the toggle-off).
        if st.collapsed.load(Ordering::SeqCst) {
            if !recently_blurred {
                show_strip(app, Some(anchor));
            }
            return;
        }
        // SV: pinned → the icon toggles the bar, never the pinned panel.
        if st.pinned.load(Ordering::SeqCst) {
            collapse_strip(app);
            return;
        }
        hide_strip(app);
        return;
    }
    if recently_blurred {
        return;
    }
    show_strip(app, Some(anchor));
}

/// Makes sure the engine (main window) exists, rebuilding it hidden if a
/// tray_light close destroyed it while logged out. Builds from a fresh
/// thread, never the caller's (which may be the main thread).
pub fn ensure_engine(app: &AppHandle) {
    static BUILDING: AtomicBool = AtomicBool::new(false);
    if app.get_webview_window("main").is_some() || BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if app.get_webview_window("main").is_none() {
            match build_main_window(&app, false) {
                Ok(_) => write_setup_error("[engine] rebuilt hidden main window after login"),
                Err(e) => write_setup_error(&format!("[engine] rebuilding main window failed: {e}")),
            }
        }
        BUILDING.store(false, Ordering::SeqCst);
    });
}

/// The strip doesn't exist (its pre-create failed): build it on a fresh
/// thread and show it once its page reports ready.
fn rebuild_strip(app: &AppHandle, anchor: (f64, f64)) {
    static BUILDING: AtomicBool = AtomicBool::new(false);
    if BUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        if app.get_webview_window(STRIP_LABEL).is_none() {
            *lock_ignore_poison(&state(&app).anchor) = Some(anchor);
            // Set before building so the page's strip_ready can't beat it.
            state(&app).show_when_ready.store(true, Ordering::SeqCst);
            match build_strip(&app) {
                Ok(win) => {
                    write_setup_error("[strip] rebuilt strip window after a tray click");
                    position_strip(&app, &win);
                    apply_region(&app, &win);
                }
                Err(e) => {
                    state(&app).show_when_ready.store(false, Ordering::SeqCst);
                    write_setup_error(&format!("[strip] rebuild failed: {e}"));
                }
            }
        }
        BUILDING.store(false, Ordering::SeqCst);
    });
}

/// Is the dev-only engine UI escape hatch on? (SPECTER_DEV_ENGINE_UI=1 in
/// the environment at launch.)
pub fn dev_engine_ui_enabled() -> bool {
    std::env::var("SPECTER_DEV_ENGINE_UI").map(|v| v == "1").unwrap_or(false)
}

/// DEV ONLY — tray menu "Show engine (dev)", which exists only when
/// dev_engine_ui_enabled(). Shows the hidden engine (main window), rebuilding
/// it first if it was destroyed. This is the ONLY code path that makes the
/// main window visible. On a fresh thread: building a webview window from a
/// handler running on the main thread is the deadlock the overlay hit (see
/// lib.rs).
pub fn show_engine_dev(app: &AppHandle) {
    if !dev_engine_ui_enabled() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let win = match app.get_webview_window("main") {
            Some(w) => w,
            None => match build_main_window(&app, true) {
                Ok(w) => w,
                Err(e) => {
                    write_setup_error(&format!("[engine] show_engine_dev: build failed: {e}"));
                    return;
                }
            },
        };
        write_setup_error("[engine] showing the engine window (SPECTER_DEV_ENGINE_UI)");
        hide_strip(&app);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        // Block until any background decrypt already in flight finishes and
        // releases MLS_STATE_CRITICAL_SECTION before letting the foreground
        // touch .specter_mls_state itself — see background_sync's module doc.
        { let _guard = background_sync::MLS_STATE_CRITICAL_SECTION.lock().unwrap_or_else(|e| e.into_inner()); }
        background_sync::FOREGROUND_ACTIVE.store(true, Ordering::SeqCst);
    });
}

// ── Commands (strip page) ────────────────────────────────────────────────────

/// The strip page has mounted: on launch, that's when it's first shown.
#[tauri::command]
pub fn strip_ready(app: AppHandle) {
    if state(&app).show_when_ready.swap(false, Ordering::SeqCst) {
        let h = app.clone();
        std::thread::spawn(move || show_strip(&h, None));
    }
}

/// The page's visible panels, in CSS px relative to the viewport.
#[tauri::command]
pub fn strip_set_region(app: AppHandle, rects: Vec<RegionRect>) {
    let rects: Vec<RegionRect> = rects
        .into_iter()
        .filter(|r| r.w.is_finite() && r.h.is_finite() && r.w > 0.0 && r.h > 0.0)
        .take(16)
        .collect();
    if rects.is_empty() {
        return;
    }
    *lock_ignore_poison(&state(&app).region) = Some(rects);
    if let Some(win) = app.get_webview_window(STRIP_LABEL) {
        apply_region(&app, &win);
    }
}

#[tauri::command]
pub fn strip_set_busy(app: AppHandle, busy: bool) {
    state(&app).busy.store(busy, Ordering::SeqCst);
}

/// SV: the page has (or no longer has) a panel that must survive focus loss —
/// the stream viewer. While pinned, focus loss and the tray icon collapse the
/// strip to that panel instead of hiding it (see collapse_strip). Unpinning
/// while collapsed hides the strip: nothing pinned is left to show.
#[tauri::command]
pub fn strip_set_pinned(app: AppHandle, pinned: bool) {
    let st = state(&app);
    st.pinned.store(pinned, Ordering::SeqCst);
    if !pinned && st.collapsed.load(Ordering::SeqCst) {
        let h = app.clone();
        std::thread::spawn(move || hide_strip(&h));
    }
}

#[tauri::command]
pub fn strip_hide(app: AppHandle) {
    hide_strip(&app);
}

#[tauri::command]
pub fn strip_layout(app: AppHandle) -> StripLayout {
    lock_ignore_poison(&state(&app).layout).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bottom_taskbar_tray_at_right_expands_left() {
        // 1920x1040 work area, tray icon near the right edge.
        let (expand, bar, free) = compute_columns(1920.0, 1040.0, "bottom", Some(1800.0));
        assert_eq!(expand, "left");
        // Clamped so the column stays MARGIN from the right edge.
        assert_eq!(bar, CssRect { x: 1920.0 - 8.0 - 420.0, y: 8.0, w: 420.0, h: 1024.0 });
        assert_eq!(free, CssRect { x: 8.0, y: 8.0, w: bar.x - 8.0, h: 1024.0 });
    }

    #[test]
    fn left_and_right_taskbars_dock_against_the_taskbar() {
        let (expand, bar, free) = compute_columns(1800.0, 1080.0, "left", None);
        assert_eq!((expand, bar.x), ("right", 8.0));
        assert_eq!(free.x, 428.0);
        assert_eq!(free.w, 1800.0 - 8.0 - 428.0);
        let (expand, bar, _) = compute_columns(1800.0, 1080.0, "right", None);
        assert_eq!((expand, bar.x), ("left", 1800.0 - 8.0 - 420.0));
    }

    #[test]
    fn tray_in_the_middle_ties_go_left_and_tiny_screens_clamp() {
        let (expand, bar, _) = compute_columns(1000.0, 700.0, "top", Some(500.0));
        assert_eq!((expand, bar.x), ("left", 290.0));
        let (_, bar, free) = compute_columns(300.0, 400.0, "bottom", Some(250.0));
        assert_eq!((bar.x, bar.w), (8.0, 284.0));
        assert_eq!(free.w, 0.0);
    }
}

