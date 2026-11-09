//! Unified media clock for capture timestamps.
//!
//! Every `NalUnit.timestamp_ms` producer uses this timebase: **QPC
//! milliseconds** — `QueryPerformanceCounter * 1000 / QueryPerformanceFrequency`
//! — i.e. milliseconds since boot on the system's high-resolution monotonic
//! clock. The audio side (specter-audio) stamps with the same formula, so
//! video and audio timestamps are directly comparable for A/V sync (e.g. a
//! future RTMP/FLV muxer that interleaves both).
//!
//! The values are monotonic but do NOT start near zero; consumers that need a
//! zero-based timeline must subtract their own first timestamp.
//!
//! `QueryPerformanceCounter` / `QueryPerformanceFrequency` are declared here
//! directly against kernel32 rather than via the `windows` crate so no new
//! crate feature (`Win32_System_Performance`) is needed. Both are documented to
//! never fail on Windows XP and later.

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" {
    fn QueryPerformanceCounter(lp_performance_count: *mut i64) -> i32;
    fn QueryPerformanceFrequency(lp_frequency: *mut i64) -> i32;
}

/// QPC ticks per second. Fixed at boot, so it is read once and cached.
#[cfg(target_os = "windows")]
pub fn qpc_frequency() -> u64 {
    static FREQ: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *FREQ.get_or_init(|| {
        let mut f: i64 = 0;
        let ok = unsafe { QueryPerformanceFrequency(&mut f) };
        if ok == 0 || f <= 0 {
            // Cannot happen on XP+; 10 MHz is the common modern value.
            10_000_000
        } else {
            f as u64
        }
    })
}

/// Current raw QPC tick count.
#[cfg(target_os = "windows")]
pub fn qpc_now() -> u64 {
    let mut c: i64 = 0;
    unsafe { QueryPerformanceCounter(&mut c) };
    c.max(0) as u64
}

/// Convert raw QPC ticks (e.g. `DXGI_OUTDUPL_FRAME_INFO::LastPresentTime`) to
/// QPC milliseconds using the real counter frequency — not an assumed 10 MHz.
#[cfg(target_os = "windows")]
pub fn qpc_ticks_to_ms(ticks: u64) -> u64 {
    ticks_to_ms(ticks, qpc_frequency())
}

/// Pure conversion helper (u128 intermediate: no overflow for any u64 tick count).
pub fn ticks_to_ms(ticks: u64, freq: u64) -> u64 {
    if freq == 0 {
        return 0;
    }
    ((ticks as u128 * 1000) / freq as u128) as u64
}

/// Current media-clock time in QPC milliseconds. See the module docs.
#[cfg(target_os = "windows")]
pub fn media_clock_ms() -> u64 {
    qpc_ticks_to_ms(qpc_now())
}

/// Non-Windows stand-in (capture is Windows-only): monotonic ms since first call.
#[cfg(not(target_os = "windows"))]
pub fn media_clock_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_to_ms_uses_given_frequency() {
        assert_eq!(ticks_to_ms(10_000_000, 10_000_000), 1000);
        assert_eq!(ticks_to_ms(3_000_000, 3_000_000), 1000);
        assert_eq!(ticks_to_ms(24_000_000 * 5, 24_000_000), 5000);
        // ~30 days of uptime at 10 MHz must not overflow.
        assert_eq!(ticks_to_ms(30 * 86_400 * 10_000_000, 10_000_000), 30 * 86_400 * 1000);
        assert_eq!(ticks_to_ms(123, 0), 0);
    }

    #[test]
    fn media_clock_is_monotonic() {
        let a = media_clock_ms();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let b = media_clock_ms();
        assert!(b >= a + 4, "a={a} b={b}");
    }
}
