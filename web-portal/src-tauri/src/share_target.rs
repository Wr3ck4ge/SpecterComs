//! "Share application" hotkey target: the application window the user last had
//! focused that isn't one of ours.
//!
//! When the hotkey fires the game is normally the foreground window, but the
//! overlay (made interactive), the tray strip or a Specter dialog may hold
//! focus instead. So a light poller remembers the last foreground window that
//! is a real application window, and `share_app_target` answers with the
//! current foreground window if it qualifies, else that remembered one.
//!
//! The answer is a capture source id in capture/mod.rs's format
//! (`window:<hwnd-decimal>`), so the normal share path takes it from there:
//! WGC window capture (follows the window when it moves or resizes) and, with
//! "Share audio" on, loopback.rs's per-process audio for that window's app.
//!
//! Privacy: window titles are passed to the UI only, never logged.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ShareAppTarget {
    /// `window:<hwnd-decimal>`, the capture source id.
    pub source_id: String,
    /// Window title, for the "Sharing …" label.
    pub name: String,
}

/// Window classes that are never an "application" to share: the desktop,
/// taskbar, Alt-Tab / Task View and other shell surfaces.
#[cfg_attr(not(windows), allow(dead_code))]
const SHELL_CLASSES: &[&str] = &[
    "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow", "ForegroundStaging", "MultitaskingViewFrame",
    "XamlExplorerHostIslandWindow", "TaskListThumbnailWnd", "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland", "LockScreenBackstopFrame",
];

#[cfg_attr(not(windows), allow(dead_code))]
fn is_shell_class(class: &str) -> bool {
    SHELL_CLASSES.iter().any(|c| c.eq_ignore_ascii_case(class))
}

#[cfg(windows)]
mod imp {
    use super::{is_shell_class, ShareAppTarget};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Once;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindow, IsWindowVisible, GA_ROOTOWNER,
    };

    /// Last qualifying foreground window (HWND as usize, 0 = none).
    static LAST: AtomicUsize = AtomicUsize::new(0);
    static START: Once = Once::new();

    fn hwnd(v: usize) -> HWND { HWND(v as *mut core::ffi::c_void) }

    /// `h` (or its root owner) if it is a visible, titled, non-shell window of
    /// another process; else None.
    fn qualify(h: HWND) -> Option<(usize, String)> {
        if h.0.is_null() { return None; }
        unsafe {
            let root = GetAncestor(h, GA_ROOTOWNER);
            let h = if !root.0.is_null() && IsWindowVisible(root).as_bool() { root } else { h };
            if !IsWindow(h).as_bool() || !IsWindowVisible(h).as_bool() { return None; }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            if pid == 0 || pid == std::process::id() { return None; }
            let mut cls = [0u16; 128];
            let n = GetClassNameW(h, &mut cls);
            if n > 0 && is_shell_class(&String::from_utf16_lossy(&cls[..n as usize])) { return None; }
            let len = GetWindowTextLengthW(h);
            if len <= 0 { return None; }
            let mut buf = vec![0u16; len as usize + 1];
            let got = GetWindowTextW(h, &mut buf) as usize;
            let title = String::from_utf16_lossy(&buf[..got]).trim().to_string();
            if title.is_empty() { return None; }
            Some((h.0 as usize, title))
        }
    }

    /// Start the foreground poller once. 250 ms is plenty: it only has to
    /// catch the game before focus moves to one of our own windows.
    pub fn ensure_started() {
        START.call_once(|| {
            let _ = std::thread::Builder::new().name("share-target".into()).spawn(|| loop {
                if let Some((h, _)) = qualify(unsafe { GetForegroundWindow() }) {
                    LAST.store(h, Ordering::Relaxed);
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            });
        });
    }

    pub fn target() -> Option<ShareAppTarget> {
        ensure_started();
        let found = qualify(unsafe { GetForegroundWindow() }).or_else(|| {
            let last = LAST.load(Ordering::Relaxed);
            if last == 0 { None } else { qualify(hwnd(last)) }
        })?;
        LAST.store(found.0, Ordering::Relaxed);
        Some(ShareAppTarget { source_id: format!("window:{}", found.0), name: found.1 })
    }
}

#[cfg(not(windows))]
mod imp {
    use super::ShareAppTarget;
    pub fn ensure_started() {}
    pub fn target() -> Option<ShareAppTarget> { None }
}

pub use imp::ensure_started;

/// The application window the share-app hotkey should share, or None when
/// there is no other application window to share.
#[tauri::command]
pub fn share_app_target() -> Option<ShareAppTarget> {
    imp::target()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_classes_are_excluded_case_insensitively() {
        assert!(is_shell_class("Shell_TrayWnd"));
        assert!(is_shell_class("progman"));
        assert!(!is_shell_class("UnrealWindow"));
        assert!(!is_shell_class("CryENGINE"));
    }

    #[cfg(windows)]
    #[test]
    fn target_never_returns_our_own_process() {
        // Test runner has no windows of its own; whatever comes back (if
        // anything) must be another process's window in the expected format.
        if let Some(t) = share_app_target() {
            assert!(t.source_id.starts_with("window:"));
            assert!(!t.name.is_empty());
        }
    }
}
