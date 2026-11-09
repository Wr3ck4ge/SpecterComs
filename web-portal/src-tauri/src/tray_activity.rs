//! tray_activity.rs — the tray icon shows whether you're in a voice channel.
//!
//! idle    the normal icon, tooltip "SpecterComs"
//! active  the icon with a green status dot (bottom-right), tooltip
//!         "SpecterComs — in <channel> (<server>)"
//! muted   the same with a red dot, tooltip "… — muted"
//!
//! The engine (WarRoom in the hidden main window — the only place that knows
//! for sure whether voice is up) calls `set_tray_activity` whenever that
//! changes (web-portal/src/engine/trayActivity.js). Rust owns the tray, so this
//! works whether the strip window is open, hidden or destroyed. Reverts to
//! idle: the engine leaving voice / unmounting (logout), the engine window
//! being destroyed, and any auth-changed without a user (lib.rs). On exit the
//! tray icon itself is removed (AppHandle::cleanup_before_exit drops it), so
//! nothing can stay behind.
//!
//! Debounced (DEBOUNCE): a change is applied only if no newer one arrived in
//! the meantime, so a voice reconnect (active → idle → active within a second)
//! never makes the icon flicker. Resets (logout, engine gone) apply at once.
//!
//! The dotted variants are drawn at runtime from the app's own icon (the same
//! image the tray is built with), at whatever size that is, so there are no
//! extra assets to keep in sync with the logo and the dot scales with the
//! icon Windows downsamples for the tray.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::{AppHandle, Manager};

use crate::lock_ignore_poison;

pub const TRAY_ID: &str = "specter-tray";
pub const BASE_TOOLTIP: &str = "SpecterComs";
const DEBOUNCE: Duration = Duration::from_millis(600);
/// Windows tray tooltips are capped at 128 UTF-16 units; keep the label short.
const MAX_LABEL_CHARS: usize = 90;

const DOT_ACTIVE: [u8; 3] = [0x22, 0xc5, 0x5e]; // green-500
const DOT_MUTED: [u8; 3] = [0xef, 0x44, 0x44]; // red-500
const DOT_RING: [u8; 3] = [0x0b, 0x1d, 0x2e]; // the strip's panel colour

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Idle,
    Active,
    Muted,
}

#[derive(Default)]
pub struct TrayActivityState {
    generation: AtomicU64,
    /// What the tray currently shows (None = never changed = idle).
    applied: Mutex<Option<(Activity, String)>>,
    /// The tray's base icon, RGBA + size (captured when the tray is built).
    base: Mutex<Option<(Vec<u8>, u32, u32)>>,
}

/// lib.rs setup: remember the icon the tray was built with.
pub fn init(app: &AppHandle, icon: &Image<'_>) {
    let st = app.state::<TrayActivityState>();
    *lock_ignore_poison(&st.base) = Some((icon.rgba().to_vec(), icon.width(), icon.height()));
}

/// The tooltip for a state. Pure.
pub fn tooltip_for(activity: Activity, label: &str) -> String {
    let label = clean_label(label);
    match (activity, label.is_empty()) {
        (Activity::Idle, _) => BASE_TOOLTIP.to_string(),
        (Activity::Active, true) => format!("{BASE_TOOLTIP} — in voice"),
        (Activity::Active, false) => format!("{BASE_TOOLTIP} — in {label}"),
        (Activity::Muted, true) => format!("{BASE_TOOLTIP} — in voice, muted"),
        (Activity::Muted, false) => format!("{BASE_TOOLTIP} — in {label}, muted"),
    }
}

/// Control characters out, whitespace collapsed, capped with an ellipsis.
fn clean_label(label: &str) -> String {
    let flat: String = label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.chars().count() > MAX_LABEL_CHARS {
        let cut: String = flat.chars().take(MAX_LABEL_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        flat
    }
}

/// The base icon with a status dot in its bottom-right corner: a filled
/// circle ~42% of the icon wide with a dark ring, anti-aliased, composited
/// over the source pixels. Pure (unit-tested below).
pub fn badge_rgba(rgba: &[u8], w: u32, h: u32, color: [u8; 3]) -> Vec<u8> {
    let mut out = rgba.to_vec();
    if w == 0 || h == 0 || rgba.len() < (w * h * 4) as usize {
        return out;
    }
    let size = w.min(h) as f64;
    let r = (size * 0.21).max(1.5);
    let ring = (size * 0.06).max(1.0);
    let cx = w as f64 - r - ring;
    let cy = h as f64 - r - ring;
    let reach = r + ring + 1.0;
    let x0 = (cx - reach).floor().max(0.0) as u32;
    let y0 = (cy - reach).floor().max(0.0) as u32;
    for y in y0..h {
        for x in x0..w {
            let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
            let outer = (r + ring + 0.5 - d).clamp(0.0, 1.0);
            if outer <= 0.0 {
                continue;
            }
            let inner = (r + 0.5 - d).clamp(0.0, 1.0);
            let i = ((y * w + x) * 4) as usize;
            // Ring first, then the dot over it.
            blend(&mut out[i..i + 4], DOT_RING, outer);
            blend(&mut out[i..i + 4], color, inner);
        }
    }
    out
}

fn blend(px: &mut [u8], color: [u8; 3], a: f64) {
    if a <= 0.0 {
        return;
    }
    let src_a = px[3] as f64 / 255.0;
    let out_a = a + src_a * (1.0 - a);
    for c in 0..3 {
        let v = (color[c] as f64 * a + px[c] as f64 * src_a * (1.0 - a)) / out_a.max(1e-6);
        px[c] = v.round().clamp(0.0, 255.0) as u8;
    }
    px[3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
}

fn apply(app: &AppHandle, activity: Activity, label: &str) {
    let st = app.state::<TrayActivityState>();
    let key = (activity, if activity == Activity::Idle { String::new() } else { clean_label(label) });
    {
        let applied = lock_ignore_poison(&st.applied);
        let current = applied.clone().unwrap_or((Activity::Idle, String::new()));
        if current == key {
            return;
        }
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let base = lock_ignore_poison(&st.base).clone();
    if let Some((rgba, w, h)) = base {
        let pixels = match activity {
            Activity::Idle => rgba,
            Activity::Active => badge_rgba(&rgba, w, h, DOT_ACTIVE),
            Activity::Muted => badge_rgba(&rgba, w, h, DOT_MUTED),
        };
        let _ = tray.set_icon(Some(Image::new_owned(pixels, w, h)));
    }
    let _ = tray.set_tooltip(Some(tooltip_for(activity, label)));
    *lock_ignore_poison(&st.applied) = Some(key);
}

/// Debounced change: applied after DEBOUNCE unless a newer one came in.
pub fn request(app: &AppHandle, activity: Activity, label: String) {
    let st = app.state::<TrayActivityState>();
    let generation = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DEBOUNCE);
        if app.state::<TrayActivityState>().generation.load(Ordering::SeqCst) == generation {
            apply(&app, activity, &label);
        }
    });
}

/// Back to idle right away (logout, engine window gone). Cancels a pending
/// debounced change.
pub fn reset(app: &AppHandle) {
    app.state::<TrayActivityState>().generation.fetch_add(1, Ordering::SeqCst);
    apply(app, Activity::Idle, "");
}

/// The engine's voice state for the tray. `label` is "<channel> (<server>)".
#[tauri::command]
pub fn set_tray_activity(app: AppHandle, state: Activity, label: Option<String>) {
    request(&app, state, label.unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tooltips() {
        assert_eq!(tooltip_for(Activity::Idle, "Alpha (Ghost Fleet)"), "SpecterComs");
        assert_eq!(tooltip_for(Activity::Active, "Alpha (Ghost Fleet)"), "SpecterComs — in Alpha (Ghost Fleet)");
        assert_eq!(tooltip_for(Activity::Muted, " Alpha\n(Ghost  Fleet) "), "SpecterComs — in Alpha (Ghost Fleet), muted");
        assert_eq!(tooltip_for(Activity::Active, ""), "SpecterComs — in voice");
        let long = "x".repeat(300);
        let t = tooltip_for(Activity::Active, &long);
        assert!(t.chars().count() < 128, "{}", t.chars().count());
        assert!(t.ends_with('…'));
    }

    #[test]
    fn badge_paints_the_bottom_right_corner_only() {
        let (w, h) = (32u32, 32u32);
        let src = vec![0u8; (w * h * 4) as usize]; // fully transparent
        let out = badge_rgba(&src, w, h, DOT_ACTIVE);
        let px = |x: u32, y: u32| &out[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize];
        // Top-left untouched.
        assert_eq!(px(2, 2), &[0, 0, 0, 0]);
        // The dot's centre is opaque green.
        let r = 32.0 * 0.21;
        let ring = (32.0f64 * 0.06).max(1.0);
        let c = (32.0 - r - ring) as u32;
        assert_eq!(px(c, c), &[DOT_ACTIVE[0], DOT_ACTIVE[1], DOT_ACTIVE[2], 255]);
        // Same size in, same size out.
        assert_eq!(out.len(), src.len());
    }

    #[test]
    fn badge_ignores_bad_input() {
        assert_eq!(badge_rgba(&[1, 2, 3], 4, 4, DOT_MUTED), vec![1, 2, 3]);
        assert!(badge_rgba(&[], 0, 0, DOT_MUTED).is_empty());
    }
}
