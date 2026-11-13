//! tray_activity.rs — the tray icon shows whether you're in a voice channel.
//!
//! idle    tray-idle,            tooltip "SpecterComs"
//! active  tray-in-voice,        tooltip "SpecterComs — in <channel> (<server>)"
//! muted   tray-mic-muted,       tooltip "… — in <channel>, muted"
//! live    tray-streaming-live,  tooltip "… — in <channel>, sharing your screen"
//!         (+ ", muted" when that applies too)
//!
//! Precedence for the icon: Live > Muted > Active > Idle. The tooltip lists
//! every state that applies ("in Alpha, sharing your screen, muted").
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
//! BRAND: the icons are the brand pack's tray set (src-tauri/icons/tray/),
//! decoded at compile time by `include_image!` (the same codegen that embeds
//! the default window icon). 32px up to 150% display scaling, 64px above;
//! Windows downsamples to its tray size.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::{include_image, AppHandle, Manager};

use crate::lock_ignore_poison;

pub const TRAY_ID: &str = "specter-tray";
pub const BASE_TOOLTIP: &str = "SpecterComs";
const DEBOUNCE: Duration = Duration::from_millis(600);
/// Windows tray tooltips are capped at 128 UTF-16 units; keep the label short
/// (it now shares the tip with ", sharing your screen, muted").
const MAX_LABEL_CHARS: usize = 70;
/// Above this display scale the 64px icons are used.
const HIDPI_SCALE: f64 = 1.5;

const IDLE_32: Image<'static> = include_image!("icons/tray/tray-idle-32.png");
const IDLE_64: Image<'static> = include_image!("icons/tray/tray-idle-64.png");
const VOICE_32: Image<'static> = include_image!("icons/tray/tray-in-voice-32.png");
const VOICE_64: Image<'static> = include_image!("icons/tray/tray-in-voice-64.png");
const MUTED_32: Image<'static> = include_image!("icons/tray/tray-mic-muted-32.png");
const MUTED_64: Image<'static> = include_image!("icons/tray/tray-mic-muted-64.png");
const LIVE_32: Image<'static> = include_image!("icons/tray/tray-streaming-live-32.png");
const LIVE_64: Image<'static> = include_image!("icons/tray/tray-streaming-live-64.png");

#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Idle,
    Active,
    Muted,
    /// Sharing the screen (in voice).
    Live,
}

/// Everything the tray shows about voice. `activity()` picks the icon.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct TrayFlags {
    pub in_voice: bool,
    pub muted: bool,
    pub sharing: bool,
}

impl TrayFlags {
    /// From the engine's request: `state` is the engine's own pick; the
    /// explicit flags win over what `state` alone implies. Muted / sharing
    /// never apply outside voice.
    pub fn from_request(state: Activity, muted: Option<bool>, sharing: Option<bool>) -> Self {
        let in_voice = state != Activity::Idle;
        Self {
            in_voice,
            muted: in_voice && muted.unwrap_or(state == Activity::Muted),
            sharing: in_voice && sharing.unwrap_or(state == Activity::Live),
        }
    }

    /// Precedence: Live > Muted > Active > Idle. Pure.
    pub fn activity(self) -> Activity {
        if !self.in_voice {
            Activity::Idle
        } else if self.sharing {
            Activity::Live
        } else if self.muted {
            Activity::Muted
        } else {
            Activity::Active
        }
    }
}

#[derive(Default)]
pub struct TrayActivityState {
    generation: AtomicU64,
    /// What the tray currently shows (None = never changed = idle).
    applied: Mutex<Option<(TrayFlags, String)>>,
    /// The display scale the tray was built at (picks 32 vs 64px icons).
    scale: Mutex<Option<f64>>,
}

/// The tray icon for a state at a display scale.
pub fn icon_for(activity: Activity, scale: f64) -> Image<'static> {
    let hi = scale > HIDPI_SCALE;
    match (activity, hi) {
        (Activity::Idle, false) => IDLE_32,
        (Activity::Idle, true) => IDLE_64,
        (Activity::Active, false) => VOICE_32,
        (Activity::Active, true) => VOICE_64,
        (Activity::Muted, false) => MUTED_32,
        (Activity::Muted, true) => MUTED_64,
        (Activity::Live, false) => LIVE_32,
        (Activity::Live, true) => LIVE_64,
    }
}

/// lib.rs setup: remember the display scale; returns the idle icon to build
/// the tray with.
pub fn init(app: &AppHandle) -> Image<'static> {
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    *lock_ignore_poison(&app.state::<TrayActivityState>().scale) = Some(scale);
    icon_for(Activity::Idle, scale)
}

/// The tooltip for a state. Pure.
pub fn tooltip_for(flags: TrayFlags, label: &str) -> String {
    if !flags.in_voice {
        return BASE_TOOLTIP.to_string();
    }
    let label = clean_label(label);
    let mut t = if label.is_empty() {
        format!("{BASE_TOOLTIP} — in voice")
    } else {
        format!("{BASE_TOOLTIP} — in {label}")
    };
    if flags.sharing {
        t.push_str(", sharing your screen");
    }
    if flags.muted {
        t.push_str(", muted");
    }
    t
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

fn apply(app: &AppHandle, flags: TrayFlags, label: &str) {
    let st = app.state::<TrayActivityState>();
    let key = (flags, if flags.in_voice { clean_label(label) } else { String::new() });
    {
        let applied = lock_ignore_poison(&st.applied);
        let current = applied.clone().unwrap_or((TrayFlags::default(), String::new()));
        if current == key {
            return;
        }
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let scale = lock_ignore_poison(&st.scale).unwrap_or(1.0);
    let _ = tray.set_icon(Some(icon_for(flags.activity(), scale)));
    let _ = tray.set_tooltip(Some(tooltip_for(flags, label)));
    *lock_ignore_poison(&st.applied) = Some(key);
}

/// Debounced change: applied after DEBOUNCE unless a newer one came in.
pub fn request(app: &AppHandle, flags: TrayFlags, label: String) {
    let st = app.state::<TrayActivityState>();
    let generation = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DEBOUNCE);
        if app.state::<TrayActivityState>().generation.load(Ordering::SeqCst) == generation {
            apply(&app, flags, &label);
        }
    });
}

/// Back to idle right away (logout, engine window gone). Cancels a pending
/// debounced change.
pub fn reset(app: &AppHandle) {
    app.state::<TrayActivityState>().generation.fetch_add(1, Ordering::SeqCst);
    apply(app, TrayFlags::default(), "");
}

/// The engine's voice state for the tray. `label` is "<channel> (<server>)";
/// `muted` / `sharing` are the separate flags (the tooltip lists them all).
#[tauri::command]
pub fn set_tray_activity(app: AppHandle, state: Activity, label: Option<String>, muted: Option<bool>, sharing: Option<bool>) {
    request(&app, TrayFlags::from_request(state, muted, sharing), label.unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn f(in_voice: bool, muted: bool, sharing: bool) -> TrayFlags {
        TrayFlags { in_voice, muted, sharing }
    }

    #[test]
    fn tooltips() {
        assert_eq!(tooltip_for(f(false, true, true), "Alpha (Ghost Fleet)"), "SpecterComs");
        assert_eq!(tooltip_for(f(true, false, false), "Alpha (Ghost Fleet)"), "SpecterComs — in Alpha (Ghost Fleet)");
        assert_eq!(tooltip_for(f(true, true, false), " Alpha\n(Ghost  Fleet) "), "SpecterComs — in Alpha (Ghost Fleet), muted");
        assert_eq!(tooltip_for(f(true, false, false), ""), "SpecterComs — in voice");
        assert_eq!(tooltip_for(f(true, false, true), "Alpha"), "SpecterComs — in Alpha, sharing your screen");
        assert_eq!(tooltip_for(f(true, true, true), "Alpha"), "SpecterComs — in Alpha, sharing your screen, muted");
        let long = "x".repeat(300);
        let t = tooltip_for(f(true, true, true), &long);
        assert!(t.encode_utf16().count() < 128, "{}", t.encode_utf16().count());
        assert!(t.contains('…'));
    }

    #[test]
    fn precedence_live_muted_active_idle() {
        assert_eq!(f(false, false, false).activity(), Activity::Idle);
        assert_eq!(f(false, true, true).activity(), Activity::Idle);
        assert_eq!(f(true, false, false).activity(), Activity::Active);
        assert_eq!(f(true, true, false).activity(), Activity::Muted);
        assert_eq!(f(true, false, true).activity(), Activity::Live);
        assert_eq!(f(true, true, true).activity(), Activity::Live);
    }

    #[test]
    fn request_flags() {
        // Explicit flags win; the state alone implies its own flag.
        assert_eq!(TrayFlags::from_request(Activity::Live, Some(true), Some(true)), f(true, true, true));
        assert_eq!(TrayFlags::from_request(Activity::Muted, None, None), f(true, true, false));
        assert_eq!(TrayFlags::from_request(Activity::Live, None, None), f(true, false, true));
        assert_eq!(TrayFlags::from_request(Activity::Active, Some(false), Some(false)), f(true, false, false));
        // Nothing applies outside voice.
        assert_eq!(TrayFlags::from_request(Activity::Idle, Some(true), Some(true)), TrayFlags::default());
    }

    #[test]
    fn icons_per_state_and_scale() {
        for a in [Activity::Idle, Activity::Active, Activity::Muted, Activity::Live] {
            let lo = icon_for(a, 1.0);
            let hi = icon_for(a, 2.0);
            assert_eq!((lo.width(), lo.height()), (32, 32));
            assert_eq!((hi.width(), hi.height()), (64, 64));
            assert_eq!(lo.rgba().len(), 32 * 32 * 4);
        }
        assert_ne!(icon_for(Activity::Idle, 1.0).rgba(), icon_for(Activity::Live, 1.0).rgba());
    }
}
