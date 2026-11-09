#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Dxgi;

use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIOutput1, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    Common::DXGI_SAMPLE_DESC,
};
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::core::Interface;

pub mod clock;
pub mod encoder;
#[cfg(feature = "dev_perf")]
pub mod perf;

pub use clock::media_clock_ms;

// ── Public data types ─────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct CaptureConfig {
    pub source_id: String, // "monitor:0"  |  "window:<hwnd-decimal>"
    pub fps: u32,
    pub bitrate: u32,
    /// Encode height cap: downscale source to this height (aspect-preserving) before encoding.
    /// 0 = no cap (encode at native source resolution).
    pub max_height: u32,
    /// Encode width cap (aspect-preserving). 0 / absent = no width cap, which
    /// is what callers from before this field existed get.
    #[serde(default)]
    pub max_width: u32,
    /// Encode pixel budget (width × height, aspect-preserving) — roughly the
    /// profile's pixel count, e.g. 1920×1080. Lets an ultrawide source keep
    /// its shape at a similar encode cost (5120×1440 → 2714×762) instead of
    /// being squeezed into a 16:9 box. 0 / absent = no budget (old callers).
    #[serde(default)]
    pub max_pixels: u32,
    /// Encoder rate control: `None` / `"vbr"` (default — today's latency-tuned
    /// VBR) or `"cbr"` (constant bitrate, e.g. what Twitch ingest wants).
    /// Unknown values fall back to the default. See `encoder::new_d3d11va`.
    #[serde(default)]
    pub rate_control: Option<String>,
}

impl CaptureConfig {
    /// True when the caller explicitly asked for constant-bitrate encoding.
    pub fn wants_cbr(&self) -> bool {
        self.rate_control
            .as_deref()
            .map(|s| s.trim().eq_ignore_ascii_case("cbr"))
            .unwrap_or(false)
    }

    /// The encode-size limits for `enc_dims`.
    pub(crate) fn enc_limits(&self) -> EncLimits {
        EncLimits { max_w: self.max_width, max_h: self.max_height, max_px: self.max_pixels }
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct NalUnit {
    pub data: Vec<u8>,
    pub is_keyframe: bool,
    /// Capture time in **QPC milliseconds** (QueryPerformanceCounter * 1000 /
    /// QueryPerformanceFrequency — see `capture::clock`). Monotonic, but NOT
    /// zero-based: it counts from boot. The audio pipeline uses the same
    /// convention, so audio and video timestamps can be compared directly.
    pub timestamp_ms: u64,
    /// Codec used to produce this unit (e.g. "h264_nvenc").
    /// Always set.
    pub codec_name: &'static str,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct CaptureSourceInfo {
    pub id: String,         // "monitor:0"  |  "window:12345"
    pub name: String,
    pub kind: String,       // "monitor"  |  "window"
    pub thumb_b64: String,  // base64-encoded BGRA bytes (thumb_width x thumb_height)
    pub thumb_width: u32,
    pub thumb_height: u32,
    pub source_width: u32,
    pub source_height: u32,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct CapturePreviewFrame {
    pub thumb_b64: String,
    pub width: u32,
    pub height: u32,
}

// ── Global capture flag + thread handle ─────────────────────────────────────

#[cfg(target_os = "windows")]
static CAPTURE_RUNNING: AtomicBool = AtomicBool::new(false);

/// True from start_capture until stop_capture. A capture thread that exits while
/// this is still true ended on its own.
pub(crate) fn capture_is_running() -> bool { CAPTURE_RUNNING.load(Ordering::SeqCst) }

/// Set by request_keyframe(); consumed (swapped back to false) by the next
/// StatefulEncoder::submit_frame, which marks that frame as a forced IDR.
/// Every capture path funnels through submit_frame, so one flag covers them
/// all. Throttling is the caller's job (CommLink + media-rust rate-limit
/// requests); a stale flag left over from a stopped capture only makes a new
/// capture's first frame an IDR, which it is anyway.
#[cfg(target_os = "windows")]
pub(crate) static FORCE_KEYFRAME: AtomicBool = AtomicBool::new(false);

/// Ask the running encoder to make its next frame an IDR keyframe (a viewer
/// lost sync and asked for one — see keyframeRequest.js). No-op when nothing
/// is capturing.
pub fn request_keyframe() {
    #[cfg(target_os = "windows")]
    FORCE_KEYFRAME.store(true, Ordering::Release);
}

// ── NAL tap (fan-out for a future RTMP/Twitch muxer) ─────────────────────────

/// Optional secondary consumer of every encoded NalUnit (single encoder,
/// fan-out). Set with `set_nal_tap`. Fed with `try_send`, so a slow or stalled
/// consumer only loses its own copies — it can never block the capture thread.
static NAL_TAP: std::sync::Mutex<Option<std::sync::mpsc::SyncSender<NalUnit>>> =
    std::sync::Mutex::new(None);

/// Install (`Some`) or remove (`None`) the NAL tap. Takes effect on the next
/// emitted NAL, including mid-capture. A tap whose receiver has been dropped is
/// removed automatically. Size the channel's bound to tolerate consumer jitter
/// (e.g. ~1 s of frames); frames beyond it are dropped for the tap only, so the
/// consumer should resync on the next keyframe after a gap.
#[allow(dead_code)] // No consumer yet — reserved for the RTMP/Twitch output.
pub fn set_nal_tap(tap: Option<std::sync::mpsc::SyncSender<NalUnit>>) {
    *NAL_TAP.lock().unwrap_or_else(|e| e.into_inner()) = tap;
}

/// Output pacing: the wall-clock gap between encoded frames leaving the
/// capture thread. Under a GPU-saturating game a stall shows up here as a
/// long interval. Logged to the capture breadcrumbs every 10 s.
#[derive(Default)]
struct Pacing {
    last_ms: u64,
    window_start_ms: u64,
    frames: u32,
    sum_ms: u64,
    max_ms: u64,
    over_50: u32,
    over_100: u32,
}

static PACING: std::sync::Mutex<Option<Pacing>> = std::sync::Mutex::new(None);

fn record_pacing() {
    let now = clock::media_clock_ms();
    let Ok(mut guard) = PACING.lock() else { return };
    let p = guard.get_or_insert_with(Pacing::default);
    if p.last_ms == 0 || now.saturating_sub(p.last_ms) > 2_000 {
        // First frame, or a new capture session after a gap.
        *p = Pacing { last_ms: now, window_start_ms: now, ..Pacing::default() };
        return;
    }
    let dt = now - p.last_ms;
    p.last_ms = now;
    p.frames += 1;
    p.sum_ms += dt;
    p.max_ms = p.max_ms.max(dt);
    if dt > 50 { p.over_50 += 1; }
    if dt > 100 { p.over_100 += 1; }
    if now - p.window_start_ms >= 10_000 && p.frames > 0 {
        let msg = format!(
            "[capture/pacing] 10s: frames={} avg={:.1}ms max={}ms >50ms={} >100ms={}",
            p.frames, p.sum_ms as f64 / p.frames as f64, p.max_ms, p.over_50, p.over_100
        );
        *p = Pacing { last_ms: now, window_start_ms: now, ..Pacing::default() };
        drop(guard);
        write_capture_breadcrumb(&msg);
    }
}

/// Deliver one encoded NAL to every consumer: the main channel, the optional
/// overlay channel and the optional tap. Every capture loop routes through
/// here so the fan-out lives in one place.
fn emit_nal(
    tx: &std::sync::mpsc::Sender<NalUnit>,
    overlay_tx: &Option<std::sync::mpsc::Sender<NalUnit>>,
    nal: NalUnit,
) {
    record_pacing();
    if let Ok(mut guard) = NAL_TAP.lock() {
        if let Some(tap) = guard.as_ref() {
            if let Err(std::sync::mpsc::TrySendError::Disconnected(_)) = tap.try_send(nal.clone()) {
                *guard = None;
            }
        }
    }
    match overlay_tx {
        Some(otx) => {
            let _ = tx.send(nal.clone());
            let _ = otx.send(nal);
        }
        None => {
            let _ = tx.send(nal);
        }
    }
}

/// Keeps per-loop timestamps monotonic. DXGI frames carry their present time,
/// but pointer-only updates report 0 and are stamped with "now", which can be a
/// few ms ahead of the next real frame's present time.
#[derive(Default)]
struct MonotonicTs(u64);

impl MonotonicTs {
    fn next(&mut self, ts: u64) -> u64 {
        self.0 = self.0.max(ts);
        self.0
    }
}

/// QPC-ms timestamp for a DXGI Desktop Duplication frame: LastPresentTime is a
/// raw QPC tick count (0 when only the mouse pointer changed → use now).
#[cfg(target_os = "windows")]
fn dxgi_frame_ts_ms(frame_info: &DXGI_OUTDUPL_FRAME_INFO) -> u64 {
    let ticks = frame_info.LastPresentTime;
    if ticks > 0 {
        clock::qpc_ticks_to_ms(ticks as u64)
    } else {
        media_clock_ms()
    }
}

#[cfg(target_os = "windows")]
static CAPTURE_THREAD: std::sync::OnceLock<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn capture_thread_store() -> &'static std::sync::Mutex<Option<std::thread::JoinHandle<()>>> {
    CAPTURE_THREAD.get_or_init(|| std::sync::Mutex::new(None))
}

// Serializes concurrent stop_capture() calls.  When disconnect() fires
// capture_stop as fire-and-forget and a new start_capture() arrives before
// the first join finishes, the second stop_capture() call blocks here until
// the first join completes — preventing two NVENC sessions from overlapping,
// which causes a structured exception crash in the NVIDIA driver.
#[cfg(target_os = "windows")]
static CAPTURE_STOP_GUARD: std::sync::OnceLock<std::sync::Mutex<()>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn capture_stop_guard() -> &'static std::sync::Mutex<()> {
    CAPTURE_STOP_GUARD.get_or_init(|| std::sync::Mutex::new(()))
}

// Cached D3D11 device + detected GPU vendor, created once and reused for every
// capture session for the app's lifetime instead of being recreated on every
// share start/stop. Recreating the device on every restart was the source of a
// driver-level race ("two NVENC sessions... structured exception", see
// capture_stop_guard above) — see get_or_create_capture_device().
#[cfg(target_os = "windows")]
static CAPTURE_DEVICE: std::sync::OnceLock<
    std::sync::Mutex<Option<(ID3D11Device, ID3D11DeviceContext, GpuVendor, String)>>,
> = std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn capture_device_store(
) -> &'static std::sync::Mutex<Option<(ID3D11Device, ID3D11DeviceContext, GpuVendor, String)>> {
    CAPTURE_DEVICE.get_or_init(|| std::sync::Mutex::new(None))
}

// Separate cache for monitor capture. Deliberately NOT shared with
// CAPTURE_DEVICE above: window capture prefers the NVIDIA adapter (best NVENC
// availability), but monitor capture must use whichever adapter actually
// drives the specific display being captured — DXGI Desktop Duplication's
// DuplicateOutput() requires the device to be on the same adapter as the
// output, so reusing a device from a different adapter would break capture on
// multi-GPU systems where a monitor isn't on the "preferred" adapter.
// Keyed by the owning adapter's LUID (first tuple field): a different monitor
// may live on a different adapter, which needs a different device.
#[cfg(target_os = "windows")]
type MonitorDeviceEntry = (i64, ID3D11Device, ID3D11DeviceContext, GpuVendor, String);

#[cfg(target_os = "windows")]
static CAPTURE_MONITOR_DEVICE: std::sync::OnceLock<std::sync::Mutex<Option<MonitorDeviceEntry>>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn capture_monitor_device_store() -> &'static std::sync::Mutex<Option<MonitorDeviceEntry>> {
    CAPTURE_MONITOR_DEVICE.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(target_os = "windows")]
fn reset_capture_device_cache() {
    *capture_device_store().lock().unwrap() = None;
}

#[cfg(target_os = "windows")]
fn reset_monitor_device_cache() {
    *capture_monitor_device_store().lock().unwrap() = None;
}

#[cfg(target_os = "windows")]
static CAPTURE_COMPATIBILITY_REPORT: std::sync::OnceLock<
    std::sync::Mutex<Option<CaptureCompatibilityReport>>,
> = std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn compatibility_report_store() -> &'static std::sync::Mutex<Option<CaptureCompatibilityReport>> {
    CAPTURE_COMPATIBILITY_REPORT.get_or_init(|| std::sync::Mutex::new(None))
}

// ── Thumbnail constants ───────────────────────────────────────────────────────

const THUMB_W: u32 = 384; // matches overlay canvas width (384×216)
const THUMB_H: u32 = 216;
// Encode budget is computed per-session from config.fps (see capture loops below).

// ── Pure helpers ──────────────────────────────────────────────────────────────

pub(crate) fn to_base64(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity((data.len() * 4 + 2) / 3);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let v = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((v >> 18) & 63) as usize]);
        out.push(CHARS[((v >> 12) & 63) as usize]);
        out.push(if chunk.len() > 1 { CHARS[((v >> 6) & 63) as usize] } else { b'=' });
        out.push(if chunk.len() > 2 { CHARS[(v & 63) as usize] } else { b'=' });
    }
    String::from_utf8(out).unwrap()
}

fn downscale_bgra(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return vec![0u8; (dw * dh * 4) as usize];
    }
    let mut out = vec![0u8; (dw * dh * 4) as usize];
    for y in 0..dh {
        for x in 0..dw {
            let sx = (x * sw / dw) as usize;
            let sy = (y * sh / dh) as usize;
            let si = (sy * sw as usize + sx) * 4;
            let di = (y as usize * dw as usize + x as usize) * 4;
            out[di..di + 4].copy_from_slice(&src[si..si + 4]);
        }
    }
    out
}

/// Encode-size limits from a CaptureConfig (0 = that limit is off).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct EncLimits {
    pub max_w: u32,
    pub max_h: u32,
    pub max_px: u32,
}

/// Encode dimensions for a `src_w`×`src_h` source: one uniform scale (so the
/// aspect ratio is kept and nothing is letterboxed — the encoded frame IS the
/// source, just smaller), the smallest of the height cap, the width cap and
/// the pixel budget, never upscaling. Both sides are rounded down to even
/// numbers (NV12 / H.264 4:2:0 need even sizes; FFmpeg's AMF and NVENC
/// wrappers pass any even size through and crop in the SPS, no 16-alignment
/// needed). With only `max_h` set this is exactly the old height-only cap.
///
///   5120×1440 (32:9), 1080p budget → 2714×762
///   3440×1440 (21:9), 1080p budget → 2224×930
///   2560×1600 (16:10), max_h 1080  → 1728×1080 (height cap wins, as before)
fn enc_dims(src_w: u32, src_h: u32, lim: EncLimits) -> (u32, u32) {
    if src_w == 0 || src_h == 0 { return (src_w.max(2) & !1, src_h.max(2) & !1); }
    let mut scale = 1.0f64;
    if lim.max_h > 0 && src_h > lim.max_h { scale = scale.min(lim.max_h as f64 / src_h as f64); }
    if lim.max_w > 0 && src_w > lim.max_w { scale = scale.min(lim.max_w as f64 / src_w as f64); }
    let px = src_w as f64 * src_h as f64;
    if lim.max_px > 0 && px > lim.max_px as f64 { scale = scale.min((lim.max_px as f64 / px).sqrt()); }
    // +1e-6: 1440 × (1080/1440) must land on 1080, not 1079.999.
    let w = ((src_w as f64 * scale) + 1e-6).floor() as u32;
    let h = ((src_h as f64 * scale) + 1e-6).floor() as u32;
    ((w & !1).max(2), (h & !1).max(2))
}

/// Paces a capture loop at `period` against a deadline schedule instead of
/// "time since the last encode". The old gate dropped any frame that arrived
/// even slightly before a full period had passed and then waited for the
/// NEXT source frame — with a 60 fps game and a 30 fps target, frame 2 lands
/// at 33.3 ms, often a hair "early", so it was dropped and frame 3 (50 ms)
/// encoded: ~20 fps with many >50 ms gaps (a tester's [capture/pacing] lines).
/// Now an early frame is held, the loop sleeps until it is due, and the
/// newest frame at that moment is encoded.
#[derive(Debug, Clone, Copy)]
pub(crate) struct FrameGate {
    period: std::time::Duration,
    next_due: Option<std::time::Instant>,
}

impl FrameGate {
    pub(crate) fn new(period: std::time::Duration) -> Self { Self { period, next_due: None } }

    /// How long to wait before encoding a frame available at `now`.
    pub(crate) fn wait(&self, now: std::time::Instant) -> std::time::Duration {
        match self.next_due {
            Some(due) if due > now => due - now,
            _ => std::time::Duration::ZERO,
        }
    }

    /// Record an encode at `now`. Keeps the cadence (next = previous due +
    /// period) unless the loop fell more than a period behind, in which case
    /// the schedule restarts from now rather than bursting to catch up.
    pub(crate) fn mark(&mut self, now: std::time::Instant) {
        let base = match self.next_due {
            Some(due) if now.saturating_duration_since(due) < self.period => due,
            _ => now,
        };
        self.next_due = Some(base + self.period);
    }
}

/// Append a timestamped error entry to the capture diagnostics log.
/// Used by capture threads to record D3D11VA/NVENC initialization failures.
pub fn write_capture_error(msg: &str) {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::Path::new(&appdata).join("specter-coms");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("capture_errors.log");
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let line = format!("[{ts}] {msg}\n");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// Append a timestamped breadcrumb entry to a dedicated capture trace log.
/// This is designed for hard-crash forensics where normal error paths may not run.
pub fn write_capture_breadcrumb(msg: &str) {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::Path::new(&appdata).join("specter-coms");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("capture_breadcrumbs.log");
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let line = format!("[{ts}] {msg}\n");
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// Reset capture breadcrumb log for a new capture session.
pub fn clear_capture_breadcrumbs() {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let path = std::path::Path::new(&appdata)
            .join("specter-coms")
            .join("capture_breadcrumbs.log");
        let _ = std::fs::remove_file(path);
    }
}

/// Return capture breadcrumb log contents.
pub fn get_capture_breadcrumbs() -> String {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let path = std::path::Path::new(&appdata)
            .join("specter-coms")
            .join("capture_breadcrumbs.log");
        if let Ok(content) = std::fs::read_to_string(&path) {
            return content;
        }
    }
    String::new()
}

fn panic_payload_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "non-string panic payload".to_string()
}

/// GPU vendor detected from the DXGI adapter's PCI vendor ID. Drives which
/// hardware encoder backend `StatefulEncoder::new_d3d11va` selects.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuVendor {
    Nvidia,
    Amd,
    /// Intel iGPU/Arc. Detected so diagnostics name it, but there is no Intel
    /// encoder path yet (h264_qsv needs an AV_HWDEVICE_TYPE_QSV context, not
    /// the plain D3D11VA device used here) — see codec_candidates_for_vendor.
    Intel,
    Other,
}

#[cfg(target_os = "windows")]
impl GpuVendor {
    fn from_pci_vendor_id(id: u32) -> Self {
        match id {
            PCI_VENDOR_NVIDIA => GpuVendor::Nvidia,
            PCI_VENDOR_AMD => GpuVendor::Amd,
            PCI_VENDOR_INTEL => GpuVendor::Intel,
            _ => GpuVendor::Other,
        }
    }

    /// True if this vendor has at least one hardware encoder we can drive.
    fn has_encoder(self) -> bool {
        !codec_candidates_for_vendor(self).is_empty()
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize)]
pub enum CaptureDeviceRole {
    WindowPreferred,
    MonitorOutput,
}

#[cfg(target_os = "windows")]
impl CaptureDeviceRole {
    fn as_str(self) -> &'static str {
        match self {
            CaptureDeviceRole::WindowPreferred => "window-preferred",
            CaptureDeviceRole::MonitorOutput => "monitor-output",
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, serde::Serialize)]
struct CompatibilityProbeProfile {
    name: &'static str,
    width: u32,
    height: u32,
    fps: u32,
    bitrate: u32,
    max_height: u32,
    required: bool,
}

#[cfg(target_os = "windows")]
const COMPATIBILITY_PROFILES: [CompatibilityProbeProfile; 2] = [
    CompatibilityProbeProfile {
        name: "gaming_1080p60",
        width: 1920,
        height: 1080,
        fps: 60,
        bitrate: 8_000_000,
        max_height: 1080,
        required: true,
    },
    CompatibilityProbeProfile {
        name: "gaming_1440p60",
        width: 2560,
        height: 1440,
        fps: 60,
        bitrate: 12_000_000,
        max_height: 1440,
        required: false,
    },
];

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, serde::Serialize)]
struct CompatibilityProfileResult {
    name: String,
    resolution: String,
    fps: u32,
    bitrate: u32,
    required: bool,
    ok: bool,
    error: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, serde::Serialize)]
struct CompatibilityCodecResult {
    codec: String,
    supported: bool,
    profile_results: Vec<CompatibilityProfileResult>,
    last_error: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, serde::Serialize)]
struct CompatibilityDeviceResult {
    role: String,
    vendor: String,
    adapter_name: String,
    gamer_tier_hint: String,
    preferred_codec: Option<String>,
    selected_codec: Option<String>,
    candidates: Vec<CompatibilityCodecResult>,
    device_error: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, serde::Serialize)]
pub struct CaptureCompatibilityReport {
    generated_at_epoch_secs: u64,
    devices: Vec<CompatibilityDeviceResult>,
}

#[cfg(target_os = "windows")]
const PCI_VENDOR_NVIDIA: u32 = 0x10DE;
#[cfg(target_os = "windows")]
const PCI_VENDOR_AMD: u32 = 0x1002;
#[cfg(target_os = "windows")]
const PCI_VENDOR_INTEL: u32 = 0x8086;

/// Map a detected GPU vendor to the ffmpeg hardware encoder name to use.
/// Returns Err for vendors with no supported hardware encoder path (e.g. Intel-only
/// systems) so callers can fail cleanly before touching any encoder API.
#[cfg(target_os = "windows")]
fn codec_name_for_vendor(vendor: GpuVendor) -> Result<&'static str, String> {
    match vendor {
        GpuVendor::Nvidia => Ok("h264_nvenc"),
        GpuVendor::Amd => Ok("h264_amf"),
        GpuVendor::Intel => Err(
            "Intel GPU encoding is not supported yet (NVIDIA or AMD required)".to_string(),
        ),
        GpuVendor::Other => Err("No supported GPU encoder found (NVIDIA or AMD required)".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn codec_candidates_for_vendor(vendor: GpuVendor) -> &'static [&'static str] {
    match vendor {
        // Keep preferred-first ordering, then bounded fallback.
        GpuVendor::Nvidia => &["h264_nvenc", "h264_amf"],
        GpuVendor::Amd => &["h264_amf", "h264_nvenc"],
        // No QSV path yet — see GpuVendor::Intel.
        GpuVendor::Intel => &[],
        GpuVendor::Other => &[],
    }
}

#[cfg(target_os = "windows")]
fn vendor_name(vendor: GpuVendor) -> &'static str {
    match vendor {
        GpuVendor::Nvidia => "nvidia",
        GpuVendor::Amd => "amd",
        GpuVendor::Intel => "intel",
        GpuVendor::Other => "other",
    }
}

/// User-facing error for "this machine has no GPU encoder we can use".
#[cfg(target_os = "windows")]
const NO_HW_ENCODER_MSG: &str = "Screen sharing needs an NVIDIA (NVENC) or AMD (AMF) graphics card \
    with hardware video encoding, and none was found on this PC. Intel-only graphics are not supported yet.";

#[cfg(target_os = "windows")]
fn infer_gamer_tier_hint(adapter_name: &str, vendor: GpuVendor) -> &'static str {
    let n = adapter_name.to_ascii_lowercase();
    match vendor {
        GpuVendor::Nvidia => {
            if n.contains("rtx 50") || n.contains("rtx 40") {
                "high-tier-geforce-rtx-40-50"
            } else if n.contains("rtx 30") {
                "mid-high-tier-geforce-rtx-30"
            } else if n.contains("rtx 20") || n.contains("gtx 16") || n.contains("gtx 10") {
                "mainstream-legacy-geforce"
            } else {
                "unclassified-nvidia"
            }
        }
        GpuVendor::Amd => {
            if n.contains("rx 9") || n.contains("rx 8") || n.contains("rx 7") {
                "high-tier-radeon-rx-7000-plus"
            } else if n.contains("rx 6") {
                "mid-high-tier-radeon-rx-6000"
            } else if n.contains("rx 5") {
                "mainstream-legacy-radeon-rx-5000"
            } else {
                "unclassified-amd"
            }
        }
        GpuVendor::Intel => "intel-no-hw-encoder-path-yet",
        GpuVendor::Other => "unsupported-for-current-hw-path",
    }
}

#[cfg(target_os = "windows")]
fn probe_codec_compatibility(
    codec_name: &'static str,
    d3d_device: &ID3D11Device,
    d3d_context: &ID3D11DeviceContext,
) -> CompatibilityCodecResult {
    let mut profile_results = Vec::with_capacity(COMPATIBILITY_PROFILES.len());
    let mut supported = true;
    let mut last_error = None;

    for profile in COMPATIBILITY_PROFILES {
        let probe_cfg = CaptureConfig {
            source_id: "compat-probe".to_string(),
            fps: profile.fps,
            bitrate: profile.bitrate,
            max_height: profile.max_height,
            max_width: 0,
            max_pixels: 0,
            rate_control: None,
        };
        let result = encoder::StatefulEncoder::new_d3d11va(
            profile.width,
            profile.height,
            profile.width,
            profile.height,
            &probe_cfg,
            d3d_device,
            d3d_context,
            codec_name,
        );

        match result {
            Ok(enc) => {
                drop(enc);
                profile_results.push(CompatibilityProfileResult {
                    name: profile.name.to_string(),
                    resolution: format!("{}x{}", profile.width, profile.height),
                    fps: profile.fps,
                    bitrate: profile.bitrate,
                    required: profile.required,
                    ok: true,
                    error: None,
                });
            }
            Err(e) => {
                if profile.required {
                    supported = false;
                }
                last_error = Some(e.clone());
                profile_results.push(CompatibilityProfileResult {
                    name: profile.name.to_string(),
                    resolution: format!("{}x{}", profile.width, profile.height),
                    fps: profile.fps,
                    bitrate: profile.bitrate,
                    required: profile.required,
                    ok: false,
                    error: Some(e),
                });
            }
        }
    }

    CompatibilityCodecResult {
        codec: codec_name.to_string(),
        supported,
        profile_results,
        last_error,
    }
}

#[cfg(target_os = "windows")]
fn build_device_compatibility(
    role: CaptureDeviceRole,
    vendor: GpuVendor,
    adapter_name: &str,
    d3d_device: &ID3D11Device,
    d3d_context: &ID3D11DeviceContext,
) -> CompatibilityDeviceResult {
    let mut candidates = Vec::new();
    for codec in codec_candidates_for_vendor(vendor) {
        candidates.push(probe_codec_compatibility(codec, d3d_device, d3d_context));
    }

    let preferred_codec = codec_name_for_vendor(vendor).ok().map(|s| s.to_string());
    let selected_codec = candidates
        .iter()
        .find(|c| c.supported)
        .map(|c| c.codec.clone());

    CompatibilityDeviceResult {
        role: role.as_str().to_string(),
        vendor: vendor_name(vendor).to_string(),
        adapter_name: adapter_name.to_string(),
        gamer_tier_hint: infer_gamer_tier_hint(adapter_name, vendor).to_string(),
        preferred_codec,
        selected_codec,
        candidates,
        device_error: None,
    }
}

#[cfg(target_os = "windows")]
fn build_capture_compatibility_report() -> CaptureCompatibilityReport {
    let mut devices = Vec::new();

    if let Some((dev, ctx, vendor, adapter_name)) = get_or_create_capture_device() {
        devices.push(build_device_compatibility(
            CaptureDeviceRole::WindowPreferred,
            vendor,
            &adapter_name,
            &dev,
            &ctx,
        ));
    } else {
        devices.push(CompatibilityDeviceResult {
            role: CaptureDeviceRole::WindowPreferred.as_str().to_string(),
            vendor: "unknown".to_string(),
            adapter_name: "unknown".to_string(),
            gamer_tier_hint: "unknown".to_string(),
            preferred_codec: None,
            selected_codec: None,
            candidates: Vec::new(),
            device_error: Some("Failed to create preferred window-capture D3D11 device".to_string()),
        });
    }

    if let Some((dev, ctx, vendor, adapter_name)) = get_or_create_monitor_capture_device() {
        devices.push(build_device_compatibility(
            CaptureDeviceRole::MonitorOutput,
            vendor,
            &adapter_name,
            &dev,
            &ctx,
        ));
    } else {
        devices.push(CompatibilityDeviceResult {
            role: CaptureDeviceRole::MonitorOutput.as_str().to_string(),
            vendor: "unknown".to_string(),
            adapter_name: "unknown".to_string(),
            gamer_tier_hint: "unknown".to_string(),
            preferred_codec: None,
            selected_codec: None,
            candidates: Vec::new(),
            device_error: Some("Failed to create monitor-capture D3D11 device".to_string()),
        });
    }

    let generated_at_epoch_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    CaptureCompatibilityReport {
        generated_at_epoch_secs,
        devices,
    }
}

#[cfg(target_os = "windows")]
fn ensure_capture_compatibility_report() -> CaptureCompatibilityReport {
    let mut guard = compatibility_report_store().lock().unwrap();
    if let Some(report) = guard.as_ref() {
        return report.clone();
    }
    let report = build_capture_compatibility_report();
    *guard = Some(report.clone());
    report
}

#[cfg(target_os = "windows")]
fn codec_order_for_runtime(role: CaptureDeviceRole, vendor: GpuVendor) -> Vec<&'static str> {
    let mut ordered = codec_candidates_for_vendor(vendor).to_vec();
    if ordered.is_empty() {
        return ordered;
    }
    let report = ensure_capture_compatibility_report();
    if let Some(selected) = report
        .devices
        .iter()
        .find(|d| d.role == role.as_str())
        .and_then(|d| d.selected_codec.as_deref())
    {
        if let Some(idx) = ordered.iter().position(|c| *c == selected) {
            let preferred = ordered.remove(idx);
            ordered.insert(0, preferred);
        }
    }
    ordered
}

#[cfg(target_os = "windows")]
fn init_encoder_with_fallback(
    role: CaptureDeviceRole,
    vendor: GpuVendor,
    src_w: u32,
    src_h: u32,
    enc_w: u32,
    enc_h: u32,
    config: &CaptureConfig,
    d3d_device: &ID3D11Device,
    d3d_context: &ID3D11DeviceContext,
) -> Result<encoder::StatefulEncoder, String> {
    let mut failures = Vec::new();
    let candidates = codec_order_for_runtime(role, vendor);
    if candidates.is_empty() {
        return Err(format!(
            "{NO_HW_ENCODER_MSG} (encode device vendor: {})",
            vendor_name(vendor)
        ));
    }

    for codec_name in candidates {
        match encoder::StatefulEncoder::new_d3d11va(
            src_w,
            src_h,
            enc_w,
            enc_h,
            config,
            d3d_device,
            d3d_context,
            codec_name,
        ) {
            Ok(enc) => {
                eprintln!(
                    "[capture] role={} selected codec={} (vendor={})",
                    role.as_str(),
                    codec_name,
                    vendor_name(vendor)
                );
                // Every capture path, so the diagnostic report always shows
                // the real encoded size (what viewers' SPS will say).
                write_capture_breadcrumb(&format!(
                    "[capture/encoder] role={} codec={codec_name} vendor={} src {src_w}x{src_h} -> enc {enc_w}x{enc_h} @ {} fps, {} bps (limits {:?})",
                    role.as_str(), vendor_name(vendor), config.fps, config.bitrate, config.enc_limits()
                ));
                return Ok(enc);
            }
            Err(e) => {
                failures.push(format!("{codec_name}: {e}"));
            }
        }
    }

    Err(format!(
        "All encoder candidates failed for role={} vendor={}: {}",
        role.as_str(),
        vendor_name(vendor),
        failures.join(" | ")
    ))
}

pub fn warmup_compatibility_cache_async() {
    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(|| {
            let report = ensure_capture_compatibility_report();
            for dev in &report.devices {
                eprintln!(
                    "[capture/compat] role={} vendor={} adapter='{}' selected={}",
                    dev.role,
                    dev.vendor,
                    dev.adapter_name,
                    dev.selected_codec.as_deref().unwrap_or("none")
                );
            }
        });
    }
}

pub fn get_compatibility_report_json() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        let report = ensure_capture_compatibility_report();
        return serde_json::to_value(report).unwrap_or_else(|_| {
            serde_json::json!({ "error": "failed to serialize compatibility report" })
        });
    }

    #[cfg(not(target_os = "windows"))]
    {
        serde_json::json!({ "error": "capture compatibility report is only supported on windows" })
    }
}

/// Create a D3D11 device with VIDEO_SUPPORT, preferring the NVIDIA adapter on
/// hybrid-GPU (Optimus) systems where the default adapter may be the AMD iGPU,
/// and report which vendor was actually selected so the caller can pick a
/// matching hardware encoder (NVENC for NVIDIA, AMF for AMD).
/// Vendor is identified via the adapter's PCI VendorId rather than substring
/// matching on the description string, which is fragile across driver/OEM
/// naming variations.
#[cfg(target_os = "windows")]
fn create_d3d11_device_and_detect_vendor() -> Option<(ID3D11Device, ID3D11DeviceContext, GpuVendor, String)> {
    use windows::Win32::Graphics::{
        Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
        Direct3D11::{D3D11CreateDevice, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION},
        Dxgi::{CreateDXGIFactory1, IDXGIFactory1},
    };
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        // Preference: first NVIDIA adapter (NVENC) > first AMD adapter (AMF) >
        // first other hardware adapter. AMD-over-Intel matters on Intel-iGPU +
        // AMD-dGPU laptops, where adapter 0 is the Intel (no encoder path) —
        // previously the first non-NVIDIA adapter won and capture failed there.
        let mut preferred = None::<(windows::Win32::Graphics::Dxgi::IDXGIAdapter, GpuVendor)>;
        let mut amd       = None::<(windows::Win32::Graphics::Dxgi::IDXGIAdapter, GpuVendor)>;
        let mut fallback  = None::<(windows::Win32::Graphics::Dxgi::IDXGIAdapter, GpuVendor)>;
        let mut i = 0u32;
        loop {
            let adapter = match factory.EnumAdapters(i) { Ok(a) => a, Err(_) => break };
            if let Ok(desc) = adapter.GetDesc() {
                let name = String::from_utf16_lossy(&desc.Description);
                let vendor = GpuVendor::from_pci_vendor_id(desc.VendorId);
                if vendor == GpuVendor::Nvidia {
                    preferred = Some((adapter, GpuVendor::Nvidia));
                    break;
                }
                // Skip software/virtual adapters ("Microsoft Basic Render", "Meta Virtual", etc.)
                if !name.contains("Microsoft Basic") && !name.contains("Virtual") {
                    if vendor == GpuVendor::Amd && amd.is_none() {
                        amd = Some((adapter.clone(), vendor));
                    }
                    if fallback.is_none() {
                        fallback = Some((adapter, vendor));
                    }
                }
            }
            i += 1;
        }
        let (adapter, vendor) = preferred.or(amd).or(fallback)?;
        let adapter_name = adapter
            .GetDesc()
            .ok()
            .map(|desc| String::from_utf16_lossy(&desc.Description).trim_matches('\0').trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown-adapter".to_string());
        eprintln!("[capture] GPU vendor detected: {:?}", vendor);
        let mut dev = None; let mut ctx = None;
        D3D11CreateDevice(
            &adapter, D3D_DRIVER_TYPE_UNKNOWN, None,
            D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None, D3D11_SDK_VERSION,
            Some(&mut dev), None, Some(&mut ctx),
        ).ok()?;
        Some((dev?, ctx?, vendor, adapter_name))
    }
}

/// Checks whether a cached D3D11 device is still usable via GetDeviceRemovedReason
/// — the purpose-built D3D11 API for exactly this. A cached device can go bad at
/// any point during the app's lifetime (GPU driver reset/TDR, sleep/wake, driver
/// recovery) independent of our own COM refcounting: our Rust-side reference stays
/// non-zero, but the underlying driver object is already torn down. Cloning (even
/// just AddRef) or using such a device crashes with an access violation — this is
/// what get_or_create_capture_device/get_or_create_monitor_capture_device exist to
/// prevent by checking liveness before ever handing out a cached clone.
#[cfg(target_os = "windows")]
fn device_is_healthy(dev: &ID3D11Device) -> bool {
    unsafe { dev.GetDeviceRemovedReason() }.is_ok()
}

#[cfg(target_os = "windows")]
#[link(name = "gdi32")]
extern "system" {
    // NTSTATUS D3DKMTSetProcessSchedulingPriorityClass(HANDLE, D3DKMT_SCHEDULINGPRIORITYCLASS)
    fn D3DKMTSetProcessSchedulingPriorityClass(process: *mut core::ffi::c_void, class: i32) -> i32;
}

/// D3DKMT_SCHEDULINGPRIORITYCLASS values (d3dkmthk.h).
#[cfg(target_os = "windows")]
const D3DKMT_PRIORITY_ABOVE_NORMAL: i32 = 3;
#[cfg(target_os = "windows")]
const D3DKMT_PRIORITY_HIGH: i32 = 4;

/// What `boost_gpu_priority` applies for a vendor: the per-device
/// SetGPUThreadPriority value and the process-wide D3DKMT class (None = leave
/// the default). Pure, so the policy is unit-tested.
///
/// * NVIDIA: unchanged since 2.0.10 — thread priority 7 + class HIGH. It
///   fixed game-load jitter there and NVENC runs on its own engine.
/// * AMD: no device thread priority, class ABOVE_NORMAL only. OBS — the
///   reference this was modelled on — compiles its GPU-priority code out by
///   default (libobs-d3d11 only defines USE_GPU_PRIORITY when built with a
///   non-zero GPU_PRIORITY_VAL, and even then skips Intel), so "same as OBS"
///   was really "same as an opt-in OBS build". On AMD the AMF encoder submits
///   through the same D3D11 device/context, and the debug-account stream got
///   visibly worse after 2.0.10 — a max-priority device starving the DWM
///   composition that WGC capture depends on is the plausible mechanism.
///   ABOVE_NORMAL keeps some edge over a game without pre-empting the
///   compositor.
/// * Intel / other: nothing (no encoder path; OBS skips Intel too).
///
/// `SPECTER_GPU_PRIORITY=off` disables all of it, `=full` forces the NVIDIA
/// policy on any vendor — for A/B testing on a user's machine.
#[cfg(target_os = "windows")]
fn gpu_priority_plan(vendor: GpuVendor, env: Option<&str>) -> (Option<i32>, Option<i32>) {
    match env.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("off") | Some("0") | Some("none") => return (None, None),
        Some("full") => return (Some(7), Some(D3DKMT_PRIORITY_HIGH)),
        _ => {}
    }
    match vendor {
        GpuVendor::Nvidia => (Some(7), Some(D3DKMT_PRIORITY_HIGH)),
        GpuVendor::Amd => (None, Some(D3DKMT_PRIORITY_ABOVE_NORMAL)),
        GpuVendor::Intel | GpuVendor::Other => (None, None),
    }
}

/// Raise this device's GPU scheduling priority so the capture copy, the
/// BGRA→NV12 blit and encoder submission aren't queued behind a game that
/// saturates the GPU (Star Citizen over a city: mostly fine frames, then
/// late ones — inconsistent jitter). Per-vendor policy: gpu_priority_plan.
/// The process class is set once (by the first device's vendor). WebView2
/// runs in its own processes, so only our capture/encode work is affected.
/// Best effort: every result goes to the breadcrumbs, never fatal.
#[cfg(target_os = "windows")]
fn boost_gpu_priority(dev: &ID3D11Device, role: &str, vendor: GpuVendor) {
    let env = std::env::var("SPECTER_GPU_PRIORITY").ok();
    let (thread_prio, class) = gpu_priority_plan(vendor, env.as_deref());
    static PROCESS_CLASS: std::sync::Once = std::sync::Once::new();
    PROCESS_CLASS.call_once(|| {
        let Some(class) = class else {
            write_capture_breadcrumb(&format!("[capture/gpu-priority] process scheduling class left default (vendor={}, env={env:?})", vendor_name(vendor)));
            return;
        };
        use windows::Win32::System::Threading::GetCurrentProcess;
        let status = unsafe { D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess().0, class) };
        let name = if class == D3DKMT_PRIORITY_HIGH { "HIGH" } else { "ABOVE_NORMAL" };
        write_capture_breadcrumb(&format!("[capture/gpu-priority] process scheduling class {name} status={status:#x} (vendor={}, env={env:?})", vendor_name(vendor)));
    });
    match thread_prio {
        Some(p) => {
            let res = dev
                .cast::<windows::Win32::Graphics::Dxgi::IDXGIDevice>()
                .and_then(|d| unsafe { d.SetGPUThreadPriority(p) });
            write_capture_breadcrumb(&format!(
                "[capture/gpu-priority] {role} device thread priority {p} (vendor={}): {}",
                vendor_name(vendor),
                if res.is_ok() { "ok".to_string() } else { format!("{res:?}") }
            ));
        }
        None => write_capture_breadcrumb(&format!(
            "[capture/gpu-priority] {role} device thread priority left default (vendor={})", vendor_name(vendor)
        )),
    }
}

/// Returns the cached capture D3D11 device + detected vendor, creating it once
/// (via `create_d3d11_device_and_detect_vendor`) on first use and reusing the
/// same device for every subsequent capture session — as long as it's still
/// healthy (see `device_is_healthy`); a dead cached device is replaced with a
/// fresh one rather than handed out. `ID3D11Device`/Context are cheap to clone
/// (COM AddRef) and are already proven safe to move across threads by the
/// existing capture-thread-spawn call sites.
#[cfg(target_os = "windows")]
fn get_or_create_capture_device() -> Option<(ID3D11Device, ID3D11DeviceContext, GpuVendor, String)> {
    let mut guard = capture_device_store().lock().unwrap();
    if let Some((dev, ctx, vendor, adapter_name)) = guard.as_ref() {
        if device_is_healthy(dev) {
            return Some((dev.clone(), ctx.clone(), *vendor, adapter_name.clone()));
        }
        // Informational, not an error: this is a successful self-heal, not a
        // capture failure. NOT written to capture_errors.log — the frontend
        // treats any content there as a hard failure and aborts the share
        // (see capture_get_errors() callers in CommLink.jsx).
        eprintln!("[capture] cached device is no longer healthy — recreating");
        *guard = None;
    }
    let created = create_d3d11_device_and_detect_vendor()?;
    boost_gpu_priority(&created.0, "capture/encode", created.2);
    *guard = Some((created.0.clone(), created.1.clone(), created.2, created.3.clone()));
    Some(created)
}

// ── Monitor (DXGI output) enumeration ────────────────────────────────────────

/// One desktop output, with the adapter that owns (scans out) it.
#[cfg(target_os = "windows")]
struct MonitorOutput {
    /// Global index — the N in "monitor:N".
    index: u32,
    adapter: windows::Win32::Graphics::Dxgi::IDXGIAdapter1,
    adapter_luid: i64,
    adapter_vendor: GpuVendor,
    adapter_name: String,
    output: IDXGIOutput1,
    hmonitor: windows::Win32::Graphics::Gdi::HMONITOR,
    width: u32,
    height: u32,
    device_name: String,
}

#[cfg(target_os = "windows")]
fn luid_to_i64(luid: windows::Win32::Foundation::LUID) -> i64 {
    ((luid.HighPart as i64) << 32) | (luid.LowPart as i64)
}

#[cfg(target_os = "windows")]
fn adapter_desc_name(desc: &[u16]) -> String {
    let s = String::from_utf16_lossy(desc).trim_matches('\0').trim().to_string();
    if s.is_empty() { "unknown-adapter".to_string() } else { s }
}

/// Enumerate every desktop output across ALL adapters, in one stable global
/// order: `IDXGIFactory1::EnumAdapters1` order, then `EnumOutputs` order within
/// each adapter. This is the single source of truth for "monitor:N" numbering
/// — `list_sources` (the picker) and `start_capture` (the capture thread) both
/// use it, so the index the user picked is the monitor that gets captured.
///
/// Backward compatible with the old numbering: that enumerated only the
/// default adapter's outputs, and the default adapter is EnumAdapters1(0), so
/// its outputs keep indices 0..k. Outputs on other adapters (previously
/// invisible) are appended after. An output index whose GetDesc fails still
/// consumes its index (matching the old loop), and a monitor reported by more
/// than one adapter is listed once, under the first.
///
/// This must NOT depend on the encode device's adapter: on hybrid laptops the
/// panel is owned by the Intel iGPU while the encoder lives on the NVIDIA dGPU.
#[cfg(target_os = "windows")]
fn enumerate_monitor_outputs() -> Vec<MonitorOutput> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
    let mut result = Vec::new();
    let factory: IDXGIFactory1 = match unsafe { CreateDXGIFactory1() } {
        Ok(f) => f,
        Err(e) => {
            let msg = format!("[capture/monitors] CreateDXGIFactory1 failed: {e}");
            eprintln!("{msg}");
            write_capture_breadcrumb(&msg);
            return result;
        }
    };
    let mut global_idx = 0u32;
    let mut adapter_idx = 0u32;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(adapter_idx) } {
        adapter_idx += 1;
        let (luid, vendor, adapter_name) = match unsafe { adapter.GetDesc1() } {
            Ok(d) => (luid_to_i64(d.AdapterLuid), GpuVendor::from_pci_vendor_id(d.VendorId), adapter_desc_name(&d.Description)),
            Err(_) => (0, GpuVendor::Other, "unknown-adapter".to_string()),
        };
        let mut out_idx = 0u32;
        while let Ok(output) = unsafe { adapter.EnumOutputs(out_idx) } {
            out_idx += 1;
            let index = global_idx;
            global_idx += 1;
            let Ok(desc) = (unsafe { output.GetDesc() }) else { continue };
            let Ok(output1) = output.cast::<IDXGIOutput1>() else { continue };
            if result.iter().any(|m: &MonitorOutput| m.hmonitor == desc.Monitor) {
                continue;
            }
            let c = desc.DesktopCoordinates;
            let device_name: String = desc
                .DeviceName
                .iter()
                .take_while(|&&ch| ch != 0)
                .map(|&ch| char::from_u32(ch as u32).unwrap_or('?'))
                .collect();
            result.push(MonitorOutput {
                index,
                adapter: adapter.clone(),
                adapter_luid: luid,
                adapter_vendor: vendor,
                adapter_name: adapter_name.clone(),
                output: output1,
                hmonitor: desc.Monitor,
                width: (c.right - c.left).unsigned_abs(),
                height: (c.bottom - c.top).unsigned_abs(),
                device_name: device_name.trim().to_string(),
            });
        }
    }
    result
}

/// Create a D3D11 device on a specific adapter.
#[cfg(target_os = "windows")]
fn create_d3d11_device_on_adapter(
    adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter1,
    flags: windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_FLAG,
) -> Option<(ID3D11Device, ID3D11DeviceContext)> {
    use windows::Win32::Graphics::{
        Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
        Direct3D11::{D3D11CreateDevice, D3D11_SDK_VERSION},
        Dxgi::IDXGIAdapter,
    };
    let adapter: IDXGIAdapter = adapter.cast().ok()?;
    let mut dev = None;
    let mut ctx = None;
    unsafe {
        D3D11CreateDevice(
            &adapter, D3D_DRIVER_TYPE_UNKNOWN, None, flags, None,
            D3D11_SDK_VERSION, Some(&mut dev), None, Some(&mut ctx),
        )
    }.ok()?;
    Some((dev?, ctx?))
}

/// Create a D3D11 device on whichever adapter Windows picks as default (no
/// NVIDIA-preference enumeration). Only used when no output could be
/// enumerated at all (see get_or_create_monitor_capture_device).
#[cfg(target_os = "windows")]
fn create_monitor_d3d11_device_and_detect_vendor() -> Option<MonitorDeviceEntry> {
    use windows::Win32::Graphics::{
        Direct3D::D3D_DRIVER_TYPE_HARDWARE,
        Direct3D11::{D3D11CreateDevice, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION},
    };
    let mut dev = None;
    let mut ctx = None;
    unsafe {
        D3D11CreateDevice(
            None, D3D_DRIVER_TYPE_HARDWARE, None, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None,
            D3D11_SDK_VERSION, Some(&mut dev), None, Some(&mut ctx),
        )
    }.ok()?;
    let dev = dev?;
    let ctx = ctx?;
    let dxgi_device: windows::Win32::Graphics::Dxgi::IDXGIDevice = dev.cast().ok()?;
    let dxgi_adapter = unsafe { dxgi_device.GetAdapter() }.ok()?;
    let (luid, vendor, adapter_name) = match unsafe { dxgi_adapter.GetDesc() } {
        Ok(desc) => (
            luid_to_i64(desc.AdapterLuid),
            GpuVendor::from_pci_vendor_id(desc.VendorId),
            adapter_desc_name(&desc.Description),
        ),
        _ => (0, GpuVendor::Other, "unknown-adapter".to_string()),
    };
    eprintln!("[capture/monitor] GPU vendor detected: {:?}", vendor);
    Some((luid, dev, ctx, vendor, adapter_name))
}

/// Cached counterpart to `get_or_create_capture_device`, for the monitor path:
/// a device on the adapter that OWNS the given output (what DXGI Desktop
/// Duplication requires). See `CAPTURE_MONITOR_DEVICE` for why this is a
/// separate cache, and `device_is_healthy` for why liveness is checked before
/// reuse. The cache holds one device; asking for a different adapter replaces it.
#[cfg(target_os = "windows")]
fn get_or_create_monitor_capture_device_for(
    out: &MonitorOutput,
) -> Option<(ID3D11Device, ID3D11DeviceContext, GpuVendor, String)> {
    use windows::Win32::Graphics::Direct3D11::D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
    let mut guard = capture_monitor_device_store().lock().unwrap();
    if let Some((luid, dev, ctx, vendor, adapter_name)) = guard.as_ref() {
        if *luid == out.adapter_luid {
            if device_is_healthy(dev) {
                return Some((dev.clone(), ctx.clone(), *vendor, adapter_name.clone()));
            }
            // Informational, not an error — see get_or_create_capture_device's comment.
            eprintln!("[capture/monitor] cached device is no longer healthy — recreating");
        }
        *guard = None;
    }
    let (dev, ctx) = create_d3d11_device_on_adapter(&out.adapter, D3D11_CREATE_DEVICE_VIDEO_SUPPORT)?;
    boost_gpu_priority(&dev, "monitor", out.adapter_vendor);
    eprintln!("[capture/monitor] GPU vendor detected: {:?} ({})", out.adapter_vendor, out.adapter_name);
    *guard = Some((out.adapter_luid, dev.clone(), ctx.clone(), out.adapter_vendor, out.adapter_name.clone()));
    Some((dev, ctx, out.adapter_vendor, out.adapter_name.clone()))
}

/// Monitor-role device for the compatibility report: the device on the
/// adapter that owns monitor:0 (the old default-adapter device whenever the
/// default adapter drives the primary display, i.e. the common case).
#[cfg(target_os = "windows")]
fn get_or_create_monitor_capture_device() -> Option<(ID3D11Device, ID3D11DeviceContext, GpuVendor, String)> {
    if let Some(first) = enumerate_monitor_outputs().first() {
        return get_or_create_monitor_capture_device_for(first);
    }
    let mut guard = capture_monitor_device_store().lock().unwrap();
    if let Some((_, dev, ctx, vendor, adapter_name)) = guard.as_ref() {
        if device_is_healthy(dev) {
            return Some((dev.clone(), ctx.clone(), *vendor, adapter_name.clone()));
        }
        *guard = None;
    }
    let created = create_monitor_d3d11_device_and_detect_vendor()?;
    boost_gpu_priority(&created.1, "monitor", created.3);
    *guard = Some(created.clone());
    Some((created.1, created.2, created.3, created.4))
}

fn aspect_thumb(sw: u32, sh: u32) -> (u32, u32) {
    if sh == 0 { return (THUMB_W, THUMB_H); }
    let aspect = sw as f32 / sh as f32;
    if aspect >= THUMB_W as f32 / THUMB_H as f32 {
        (THUMB_W, ((THUMB_W as f32 / aspect) as u32).max(1))
    } else {
        (((THUMB_H as f32 * aspect) as u32).max(1), THUMB_H)
    }
}

// ── Windows: Windows.Graphics.Capture helpers ─────────────────────────────────

#[cfg(target_os = "windows")]
enum WgcCaptureTarget {
    Monitor(windows::Win32::Graphics::Gdi::HMONITOR),
    Window(windows::Win32::Foundation::HWND),
}

/// Try to create a Windows.Graphics.Capture session for a monitor or window.
/// Returns `(session, frame_pool, frame_receiver, session_active)` on success, or
/// `None` if WGC is unavailable (old Windows, or exclusive-fullscreen games on
/// Windows 10).
///
/// `session_active` must be set to `false` by the caller immediately after its
/// capture loop exits, for ANY reason — not just an external stop_capture() call.
/// The free-threaded FrameArrived callback below checks it before touching the
/// device; without this, a loop that exits via an internal error break (e.g. a
/// failed AcquireNextFrame/recv) tears down the session/pool/device while
/// CAPTURE_RUNNING is still true, so the global-flag-only guard doesn't help —
/// the callback can still race the teardown and crash.
///
/// Frames arrive as BGRA8 `Direct3D11CaptureFrame`s via the returned receiver.
/// Close the session and frame_pool when done to release resources.
#[cfg(target_os = "windows")]
fn try_create_wgc_session(
    d3d_device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
    width: i32,
    height: i32,
    target: WgcCaptureTarget,
) -> Option<(
    windows::Graphics::Capture::GraphicsCaptureSession,
    windows::Graphics::Capture::Direct3D11CaptureFramePool,
    std::sync::mpsc::Receiver<()>,
    std::sync::Arc<AtomicBool>,
)> {
    use windows::{
        core::Interface,
        Foundation::TypedEventHandler,
        Graphics::{
            Capture::{
                Direct3D11CaptureFramePool, GraphicsCaptureItem,
            },
            DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
            SizeInt32,
        },
        Win32::System::WinRT::{
            Direct3D11::CreateDirect3D11DeviceFromDXGIDevice,
            Graphics::Capture::IGraphicsCaptureItemInterop,
        },
    };

    // Wrap D3D11 device as WinRT IDirect3DDevice
    let dxgi_device: windows::Win32::Graphics::Dxgi::IDXGIDevice =
        d3d_device.cast().ok()?;
    let rt_unk = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device).ok()? };
    let rt_device: IDirect3DDevice = rt_unk.cast().ok()?;

    // Obtain the GraphicsCaptureItem via Win32 interop factory
    let interop: IGraphicsCaptureItemInterop =
        windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().ok()?;
    let capture_item: GraphicsCaptureItem = match target {
        WgcCaptureTarget::Monitor(hmon) =>
            unsafe { interop.CreateForMonitor(hmon).ok()? },
        WgcCaptureTarget::Window(hwnd) =>
            unsafe { interop.CreateForWindow(hwnd).ok()? },
    };

    let size = SizeInt32 { Width: width.max(1), Height: height.max(1) };

    // Free-threaded pool: FrameArrived callback fires from the WGC thread pool,
    // not the UI thread, so no dispatcher queue is needed.
    // Pool capacity 4: when the capture source runs faster than our encode rate
    // (e.g. a 200 fps game), a larger pool prevents the callback from
    // busy-dropping every frame and gives the capture thread a wider window to
    // drain at its own pace.
    let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &rt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        4,
        size,
    ).ok()?;

    let (frame_tx, frame_rx) = std::sync::mpsc::sync_channel(16);
    let session_active = std::sync::Arc::new(AtomicBool::new(true));
    let session_active_cb = session_active.clone();
    // FrameArrived token is dropped here; the handler stays alive inside the
    // frame_pool COM object until Close() is called.
    let _ = frame_pool.FrameArrived(&TypedEventHandler::new(
        move |pool: &Option<Direct3D11CaptureFramePool>, _| {
            let cb_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                // Guard against the free-threaded callback racing capture-thread
                // teardown: the caller flips session_active to false immediately after
                // its capture loop exits (for any reason — external stop, or an
                // internal error break), before closing the session/pool and dropping
                // the D3D11 device. This callback fires on its own OS thread-pool
                // thread and isn't otherwise synchronized with that, so skip
                // TryGetNextFrame() once the session is no longer active rather than
                // touching a device that may already be torn down.
                if session_active_cb.load(Ordering::Acquire) {
                    if pool.is_some() {
                        let _ = frame_tx.try_send(());
                    }
                }
            }));

            if let Err(payload) = cb_result {
                let msg = format!(
                    "[capture/wgc] FrameArrived panic: {}",
                    panic_payload_to_string(payload)
                );
                eprintln!("{msg}");
                write_capture_error(&msg);
                write_capture_breadcrumb(&msg);
            }
            Ok(())
        }
    )).ok()?;

    let session = frame_pool.CreateCaptureSession(&capture_item).ok()?;
    // Hide mouse cursor from the capture stream
    let _ = session.SetIsCursorCaptureEnabled(false);
    // Remove the yellow capture-notification border (Windows 11+)
    let _ = session.SetIsBorderRequired(false);
    session.StartCapture().ok()?;
    eprintln!("[capture/wgc] session started ({width}x{height})");
    Some((session, frame_pool, frame_rx, session_active))
}

// ── Windows: window enumeration callback ─────────────────────────────────────

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::BOOL {
    use windows::Win32::Foundation::*;
    use windows::Win32::UI::WindowsAndMessaging::*;

    let list = &mut *(lparam.0 as *mut Vec<(HWND, String, u32, u32)>);

    if !IsWindowVisible(hwnd).as_bool() { return BOOL(1); }

    // Never expose this app's own windows as capture sources. Capturing the
    // same-process transparent WebView window can trigger compositor/driver
    // instability on some systems.
    let mut pid = 0u32;
    let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == std::process::id() {
        return BOOL(1);
    }

    let text_len = GetWindowTextLengthW(hwnd);
    if text_len == 0 { return BOOL(1); }

    // Skip floating toolbar/notification windows (WS_EX_TOOLWINDOW = 0x80)
    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    if ex_style & 0x80 != 0 { return BOOL(1); }

    let mut title_buf = vec![0u16; text_len as usize + 1];
    let actual = GetWindowTextW(hwnd, &mut title_buf) as usize;
    if actual == 0 { return BOOL(1); }
    let title = String::from_utf16_lossy(&title_buf[..actual]);

    let (w, h) = if IsIconic(hwnd).as_bool() {
        let mut wp = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        if GetWindowPlacement(hwnd, &mut wp).is_ok() {
            let r = wp.rcNormalPosition;
            ((r.right - r.left) as u32, (r.bottom - r.top) as u32)
        } else {
            return BOOL(1);
        }
    } else {
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);
        ((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32)
    };
    if w < 200 || h < 150 { return BOOL(1); }

    list.push((hwnd, title, w, h));
    BOOL(1)
}

// ── Windows: capture a single window frame via PrintWindow ────────────────────

#[cfg(target_os = "windows")]
fn capture_window_raw(
    hwnd: windows::Win32::Foundation::HWND,
    w: u32,
    h: u32,
) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::*;
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};

    if w == 0 || h == 0 { return None; }

    let screen_dc = unsafe { GetDC(HWND::default()) };
    if screen_dc.is_invalid() { return None; }

    let mem_dc = unsafe { CreateCompatibleDC(screen_dc) };
    let bitmap = unsafe { CreateCompatibleBitmap(screen_dc, w as i32, h as i32) };
    let old_obj = unsafe { SelectObject(mem_dc, HGDIOBJ(bitmap.0)) };

    // PW_RENDERFULLCONTENT = 2 — captures DWM-composited / GPU-accelerated content
    unsafe { let _ = PrintWindow(hwnd, mem_dc, PRINT_WINDOW_FLAGS(2)); };

    let mut bgra = vec![0u8; (w * h * 4) as usize];
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32), // top-down DIB
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            ..Default::default()
        },
        bmiColors: [RGBQUAD::default()],
    };
    unsafe {
        GetDIBits(
            mem_dc,
            bitmap,
            0,
            h,
            Some(bgra.as_mut_ptr() as *mut _),
            &bmi as *const BITMAPINFO as *mut BITMAPINFO,
            DIB_RGB_COLORS,
        );
        SelectObject(mem_dc, old_obj);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem_dc);
        ReleaseDC(HWND::default(), screen_dc);
    }

    // GDI returns BGR+0; force A=255
    for chunk in bgra.chunks_mut(4) { chunk[3] = 255; }
    Some(bgra)
}

// ── Windows: capture single DXGI frame for monitor thumbnail ──────────────────

#[cfg(target_os = "windows")]
fn capture_monitor_thumb(
    d3d_device: &windows::Win32::Graphics::Direct3D11::ID3D11Device,
    d3d_context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
    output1: &IDXGIOutput1,
    src_w: u32,
    src_h: u32,
) -> (String, u32, u32) {
    let fallback = (String::new(), 0, 0);

    // `d3d_device` must be on the adapter that owns `output1` (see list_sources).
    let dupl = match unsafe { output1.DuplicateOutput(d3d_device) } { Ok(d) => d, Err(_) => return fallback };

    let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
    let mut desktop_res = None;
    let acquired = 'outer: {
        for _ in 0..8 {
            match unsafe { dupl.AcquireNextFrame(150, &mut frame_info, &mut desktop_res) } {
                Ok(()) => break 'outer true,
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                Err(_) => break 'outer false,
            }
        }
        false
    };
    if !acquired { return fallback; }

    let texture: ID3D11Texture2D = match desktop_res
        .and_then(|r| r.cast::<ID3D11Texture2D>().ok())
    { Some(t) => t, None => { let _ = unsafe { dupl.ReleaseFrame() }; return fallback; } };

    let mut tex_desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut tex_desc) };

    let staging_desc = D3D11_TEXTURE2D_DESC {
        Width: tex_desc.Width,
        Height: tex_desc.Height,
        MipLevels: 1,
        ArraySize: 1,
        Format: tex_desc.Format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE(3),                      // D3D11_USAGE_STAGING
        BindFlags: 0,
        CPUAccessFlags: 0x20000, // D3D11_CPU_ACCESS_READ
        MiscFlags: 0,
    };
    let mut staging: Option<ID3D11Texture2D> = None;
    if unsafe { d3d_device.CreateTexture2D(&staging_desc, None, Some(&mut staging)) }.is_err() {
        let _ = unsafe { dupl.ReleaseFrame() };
        return fallback;
    }
    let staging = match staging {
        Some(s) => s,
        None => { let _ = unsafe { dupl.ReleaseFrame() }; return fallback; }
    };

    unsafe { d3d_context.CopyResource(&staging, &texture) };

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    let result = if unsafe {
        d3d_context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
    }
    .is_ok()
    {
        let w = tex_desc.Width as usize;
        let h = tex_desc.Height as usize;
        let row_bytes = w * 4;
        let mut bgra = vec![0u8; row_bytes * h];
        let src_ptr = mapped.pData as *const u8;
        for row in 0..h {
            let src_row = unsafe {
                std::slice::from_raw_parts(src_ptr.add(row * mapped.RowPitch as usize), row_bytes)
            };
            bgra[row * row_bytes..(row + 1) * row_bytes].copy_from_slice(src_row);
        }
        unsafe { d3d_context.Unmap(&staging, 0) };
        let (tw, th) = aspect_thumb(src_w, src_h);
        let thumb = downscale_bgra(&bgra, tex_desc.Width, tex_desc.Height, tw, th);
        (to_base64(&thumb), tw, th)
    } else {
        fallback
    };

    let _ = unsafe { dupl.ReleaseFrame() };
    result
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn list_monitors() -> Result<Vec<String>, String> {
    let sources = list_sources()?;
    Ok(sources.into_iter().filter(|s| s.kind == "monitor").map(|s| s.name).collect())
}

pub fn list_sources() -> Result<Vec<CaptureSourceInfo>, String> {
    #[cfg(not(target_os = "windows"))]
    return Ok(vec![]);

    #[cfg(target_os = "windows")]
    {
        write_capture_breadcrumb("[list_sources] begin");
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::EnumWindows,
        };

        let mut sources: Vec<CaptureSourceInfo> = Vec::new();

        // ── Monitors ──────────────────────────────────────────────────────
        // Enumerated across ALL adapters (see enumerate_monitor_outputs — the
        // same function start_capture uses, so "monitor:N" means the same
        // display in both places). Each thumbnail is grabbed with a throwaway
        // device on the output's OWNING adapter, since Desktop Duplication
        // requires that; on a hybrid laptop that's the Intel iGPU, which is
        // fine here — thumbnails need no encoder.
        let outputs = enumerate_monitor_outputs();
        let mut thumb_devices: Vec<(i64, Option<(ID3D11Device, ID3D11DeviceContext)>)> = Vec::new();
        for out in &outputs {
            write_capture_breadcrumb(&format!(
                "[list_sources] monitor:{} '{}' {}x{} owner adapter='{}' vendor={}",
                out.index, out.device_name, out.width, out.height,
                out.adapter_name, vendor_name(out.adapter_vendor)
            ));
            let pos = match thumb_devices.iter().position(|(l, _)| *l == out.adapter_luid) {
                Some(p) => p,
                None => {
                    thumb_devices.push((
                        out.adapter_luid,
                        create_d3d11_device_on_adapter(&out.adapter, Default::default()),
                    ));
                    thumb_devices.len() - 1
                }
            };
            let (thumb_b64, tw, th) = match &thumb_devices[pos].1 {
                Some((dev, ctx)) => capture_monitor_thumb(dev, ctx, &out.output, out.width, out.height),
                None => (String::new(), 0, 0),
            };
            let idx = out.index;
            let name = if out.device_name.is_empty() {
                format!("Display {idx}")
            } else {
                format!("Display {idx} ({})", out.device_name)
            };
            sources.push(CaptureSourceInfo {
                id: format!("monitor:{idx}"),
                name,
                kind: "monitor".into(),
                thumb_b64,
                thumb_width: tw,
                thumb_height: th,
                source_width: out.width,
                source_height: out.height,
            });
        }
        drop(thumb_devices);

        if sources.is_empty() {
            sources.push(CaptureSourceInfo {
                id: "monitor:0".into(),
                name: "Display 0".into(),
                kind: "monitor".into(),
                thumb_b64: String::new(),
                thumb_width: 0,
                thumb_height: 0,
                source_width: 1920,
                source_height: 1080,
            });
        }

        // ── Windows ───────────────────────────────────────────────────────
        let mut win_list: Vec<(HWND, String, u32, u32)> = Vec::new();
        let ptr = &mut win_list as *mut Vec<(HWND, String, u32, u32)> as isize;
        unsafe {
            let _ = EnumWindows(
                Some(enum_wnd_proc),
                windows::Win32::Foundation::LPARAM(ptr),
            );
        }

        for (hwnd, title, src_w, src_h) in win_list {
            let hwnd_val = hwnd.0 as usize;
            let (thumb_b64, tw, th) =
                if let Some(bgra) = capture_window_raw(hwnd, src_w, src_h) {
                    let (tw, th) = aspect_thumb(src_w, src_h);
                    let thumb = downscale_bgra(&bgra, src_w, src_h, tw, th);
                    (to_base64(&thumb), tw, th)
                } else {
                    (String::new(), 0, 0)
                };
            sources.push(CaptureSourceInfo {
                id: format!("window:{hwnd_val}"),
                name: title,
                kind: "window".into(),
                thumb_b64,
                thumb_width: tw,
                thumb_height: th,
                source_width: src_w,
                source_height: src_h,
            });
        }

        let monitor_count = sources.iter().filter(|s| s.kind == "monitor").count();
        let window_count = sources.iter().filter(|s| s.kind == "window").count();
        write_capture_breadcrumb(&format!(
            "[list_sources] complete: monitors={}, windows={}, total={}",
            monitor_count,
            window_count,
            sources.len()
        ));

        Ok(sources)
    }
}

pub fn start_capture(
    config: CaptureConfig,
    tx: std::sync::mpsc::Sender<NalUnit>,
    preview_tx: Option<std::sync::mpsc::Sender<CapturePreviewFrame>>,
    overlay_tx: Option<std::sync::mpsc::Sender<NalUnit>>,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    return Err("Screen capture is only supported on Windows".to_string());

    // Informational, not an error — NOT written to capture_errors.log. The
    // frontend treats any content in that file as a hard capture failure and
    // aborts the share (see capture_get_errors() callers in CommLink.jsx), so
    // routine/success-path events must only go to eprintln, never write_capture_error.
    #[cfg(target_os = "windows")]
    eprintln!("[capture] start_capture() called, source={}", config.source_id);

    #[cfg(target_os = "windows")]
    {
        clear_capture_breadcrumbs();
        write_capture_breadcrumb(&format!(
            "[start_capture] request source={} fps={} bitrate={} max_h={} max_w={} max_px={}",
            config.source_id, config.fps, config.bitrate, config.max_height, config.max_width, config.max_pixels
        ));
    }

    #[cfg(target_os = "windows")]
    {
        // Stop any existing capture and wait for its thread to fully exit before
        // starting a new one. Without this join, a still-alive capture thread can
        // be in the middle of dropping StatefulEncoder (which drains the NVENC
        // pipeline) while the new thread simultaneously opens a second NVENC
        // session — this causes a structured exception crash from the NVIDIA driver.
        stop_capture()?;

        let effective_source: String = config.source_id.clone();

        #[cfg(feature = "dev_perf")]
        perf::start_perf_session("pending", &effective_source, 0, 0, config.fps, config.bitrate);
        CAPTURE_RUNNING.store(true, Ordering::SeqCst);

        // ── Window capture path ───────────────────────────────────────────
        if let Some(hwnd_str) = effective_source.strip_prefix("window:") {
            let hwnd_val: usize = hwnd_str
                .parse()
                .map_err(|_| format!("Invalid window id: {hwnd_str}"))?;

            write_capture_breadcrumb(&format!("[start_capture/window] parsed hwnd={hwnd_val}"));

            use windows::Win32::Foundation::{HWND, RECT};
            use windows::Win32::UI::WindowsAndMessaging::{
                GetClientRect, GetWindowPlacement, IsIconic, IsWindow, WINDOWPLACEMENT,
            };

            let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);
            if !unsafe { IsWindow(hwnd).as_bool() } {
                write_capture_breadcrumb("[start_capture/window] IsWindow=false");
                return Err("Selected application window is no longer available".to_string());
            }
            // GetClientRect always reports (0,0,0,0) for a minimized window — that's
            // documented Win32 behavior, not an absence of content. The window picker
            // (enum_wnd_proc above) already knows this and falls back to
            // GetWindowPlacement's rcNormalPosition (the restored size) for a minimized
            // window; this path didn't, so selecting a window that was (or became)
            // minimized before Start was pressed always hit the zero-dimension
            // rejection below and never got a frame — Windows.Graphics.Capture (used
            // for the actual frame stream a few lines down) supports capturing a
            // minimized window fine once given real dimensions to request.
            let (cap_w, cap_h) = if unsafe { IsIconic(hwnd) }.as_bool() {
                let mut wp = WINDOWPLACEMENT {
                    length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                    ..Default::default()
                };
                if unsafe { GetWindowPlacement(hwnd, &mut wp) }.is_ok() {
                    let r = wp.rcNormalPosition;
                    ((r.right - r.left) as u32, (r.bottom - r.top) as u32)
                } else {
                    (0, 0)
                }
            } else {
                let mut rect = RECT::default();
                unsafe { GetClientRect(hwnd, &mut rect) }
                    .map_err(|e| format!("GetClientRect failed: {e}"))?;
                ((rect.right - rect.left) as u32, (rect.bottom - rect.top) as u32)
            };
            write_capture_breadcrumb(&format!("[start_capture/window] client rect {}x{}", cap_w, cap_h));
            if cap_w == 0 || cap_h == 0 {
                write_capture_breadcrumb("[start_capture/window] rejected zero dimensions");
                return Err("Window has zero dimensions".to_string());
            }

            let handle = std::thread::spawn(move || {
                write_capture_breadcrumb("[capture/window-thread] spawned");
                use windows::Win32::Foundation::HWND;
                use windows::Win32::System::Threading::{
                    GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
                };
                use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
                unsafe { let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL); }

                let hwnd = HWND(hwnd_val as *mut std::ffi::c_void);

                let force_dxgi_window_fallback = false;
                if force_dxgi_window_fallback {
                    write_capture_breadcrumb("[capture/window-thread] forcing DXGI fallback (WGC window path disabled)");
                }

                let wgc_result = if force_dxgi_window_fallback {
                    None
                } else {
                    (|| -> Option<_> {
                    // Reuse the cached device (created once, prefers NVIDIA so both the
                    // WGC frame pool and the D3D11VA encoder live on the same GPU — on
                    // Optimus laptops the default adapter is the AMD iGPU, which cannot
                    // create NV12 hw frames for the NVIDIA-only NVENC path). AMD adapters
                    // use the AMF encoder instead, see codec_name_for_vendor below.
                    let (dev, ctx, vendor, _adapter_name) = get_or_create_capture_device()?;
                    let (session, pool, rx, session_active) = try_create_wgc_session(
                        &dev, cap_w as i32, cap_h as i32, WgcCaptureTarget::Window(hwnd),
                    )?;
                    Some((dev, ctx, vendor, session, pool, rx, session_active))
                    })()
                };

                if let Some((d3d_device, d3d_context, gpu_vendor, _wgc_session, wgc_pool, frame_signal_rx, session_active)) = wgc_result {
                    write_capture_breadcrumb("[capture/window-thread] WGC session created");
                    unsafe { timeBeginPeriod(1); }
                    write_capture_breadcrumb("[capture/window-thread] timer period set");

                    let frame_period = std::time::Duration::from_micros(
                        1_000_000 / config.fps.max(1) as u64,
                    );
                    let mut gate = FrameGate::new(frame_period);
                    let mut encoder_opt: Option<encoder::StatefulEncoder> = None;
                    write_capture_breadcrumb("[capture/window-thread] entering frame loop");

                    while CAPTURE_RUNNING.load(Ordering::SeqCst) {
                        // [HARVEST TOP] Collect NAL encoded during the previous iteration.
                        // GPU finished during the frame_rx.recv_timeout wait — try_harvest
                        // returns immediately without blocking.
                        if let Some(ref mut enc) = encoder_opt {
                            while let Some(nal) = enc.try_harvest() {
                                emit_nal(&tx, &overlay_tx, nal);
                            }
                        }
                        match frame_signal_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                            Ok(_)  => {},
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(e) => {
                                let msg = format!("[capture/wgc/window] frame signal ended: {e}");
                                eprintln!("{msg}");
                                write_capture_error(&msg);
                                write_capture_breadcrumb(&msg);
                                // Possible device loss — drop the cache so the next
                                // start_capture() creates a fresh device instead of
                                // retrying one that may be in a bad state.
                                *capture_device_store().lock().unwrap() = None;
                                break;
                            }
                        };

                        let mut frame = match wgc_pool.TryGetNextFrame() {
                            Ok(f) => f,
                            Err(_) => continue,
                        };
                        // The source may render faster than our encode rate. Drain the
                        // channel to the newest frame so we never encode stale content.
                        // Without this, a foreground game at 144fps fills the 4-slot
                        // channel while we sleep, and we encode frames that are already
                        // several frame-periods old — the classic "smooth in background,
                        // stutters when active" symptom.
                        while frame_signal_rx.try_recv().is_ok() {
                            if let Ok(newer) = wgc_pool.TryGetNextFrame() {
                                frame = newer;
                            }
                        }

                        // Early frame: hold it until it's due, then take the
                        // newest one (see FrameGate — dropping it here was the
                        // ~20 fps cap on window shares).
                        let wait = gate.wait(std::time::Instant::now());
                        if !wait.is_zero() {
                            std::thread::sleep(wait);
                            while frame_signal_rx.try_recv().is_ok() {
                                if let Ok(newer) = wgc_pool.TryGetNextFrame() {
                                    frame = newer;
                                }
                            }
                        }
                        gate.mark(std::time::Instant::now());

                        // Extract D3D11 texture from the WGC frame
                        let surface = match frame.Surface() { Ok(s) => s, Err(_) => continue };
                        let access: IDirect3DDxgiInterfaceAccess =
                            match surface.cast() { Ok(a) => a, Err(_) => continue };
                        let texture: ID3D11Texture2D =
                            match unsafe { access.GetInterface() } { Ok(t) => t, Err(_) => continue };
                        let mut tex_desc = D3D11_TEXTURE2D_DESC::default();
                        unsafe { texture.GetDesc(&mut tex_desc) };
                        let w = tex_desc.Width;
                        let h = tex_desc.Height;
                        let timestamp_ms = media_clock_ms();

                        // Initialize D3D11VA GPU encoder on first frame
                        if encoder_opt.is_none() {
                            let (enc_w, enc_h) = enc_dims(w, h, config.enc_limits());
                            let codec_result = init_encoder_with_fallback(
                                CaptureDeviceRole::WindowPreferred,
                                gpu_vendor,
                                w,
                                h,
                                enc_w,
                                enc_h,
                                &config,
                                &d3d_device,
                                &d3d_context,
                            );
                            match codec_result {
                                Ok(enc) => {
                                    #[cfg(feature = "dev_perf")]
                                    { perf::set_encoder_name(enc.codec_name); perf::set_resolution(enc_w, enc_h); }
                                    encoder_opt = Some(enc);
                                    eprintln!("[capture/wgc/window] D3D11VA encoder ready ({w}x{h} -> {enc_w}x{enc_h})");
                                    write_capture_breadcrumb(&format!(
                                        "[capture/window-thread] encoder ready {}x{} -> {}x{}",
                                        w, h, enc_w, enc_h
                                    ));
                                }
                                Err(e) => {
                                    let msg = format!("[capture/wgc/window] D3D11VA init failed: {e}");
                                    eprintln!("{msg}");
                                    write_capture_error(&msg);
                                    write_capture_breadcrumb(&msg);
                                    break;
                                }
                            }
                        }

                        // [SUBMIT BOTTOM] VP blit + NVENC send_frame.  GPU encodes
                        // asynchronously; NAL is collected by try_harvest next iteration.
                        if let Some(ref mut enc) = encoder_opt {
                            #[cfg(feature = "dev_perf")]
                            let _interval_ms = perf::tick();
                            match enc.stage_frame(&texture) {
                                Ok(()) => {
                                    if let Err(e) = enc.submit_frame(timestamp_ms) {
                                        eprintln!("[capture/wgc/window] submit_frame error: {e}");
                                        write_capture_breadcrumb(&format!("[capture/window-thread] submit_frame error: {e}"));
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[capture/wgc/window] stage_frame error: {e}");
                                    write_capture_breadcrumb(&format!("[capture/window-thread] stage_frame error: {e}"));
                                }
                            }
                            drop(frame);
                        }
                    }

                    // Loop has exited — for ANY reason, not just CAPTURE_RUNNING going
                    // false. Signal the FrameArrived callback before touching anything
                    // below so it can't race this teardown.
                    session_active.store(false, Ordering::Release);

                    // Final harvest: collect the NAL for the last submitted frame.
                    if let Some(ref mut enc) = encoder_opt {
                        while let Some(nal) = enc.try_harvest() {
                            emit_nal(&tx, &overlay_tx, nal);
                        }
                        eprintln!("[capture/wgc/window] draining encoder before shutdown");
                        enc.drain();
                    }

                    // Routine teardown — informational, kept on eprintln only (see
                    // start_capture's comment on why these don't go to write_capture_error).
                    eprintln!("[capture/wgc/window] closing WGC session");
                    let _ = _wgc_session.Close();
                    eprintln!("[capture/wgc/window] session closed, closing pool");
                    // Close the pool BEFORE dropping frame_signal_rx: this stops FrameArrived
                    // callbacks from firing (releasing frame_tx) before we disconnect
                    // the receiver — prevents a race where WGC thread pool fires the
                    // callback during frame_signal_rx drop, causing a COM ref-count race.
                    let _ = wgc_pool.Close();
                    eprintln!("[capture/wgc/window] pool closed, dropping frame_signal_rx and device");
                    drop(frame_signal_rx);
                    unsafe { timeEndPeriod(1); }
                    eprintln!("[capture/wgc/window] teardown complete");
                } else {
                    // WGC CreateForWindow failed — exclusive fullscreen or DRM-protected window.
                    // Fall back to DXGI Desktop Duplication cropped to the window's desktop rect
                    // so only the application is captured, not the whole monitor.
                    use windows::Win32::Foundation::RECT;
                    use windows::Win32::Graphics::Gdi::{
                        MonitorFromWindow, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST,
                    };
                    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
                    use windows::Win32::Graphics::{
                        Direct3D::D3D_DRIVER_TYPE_HARDWARE,
                        Direct3D11::{
                            D3D11CreateDevice, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
                            D3D11_USAGE_DEFAULT, D3D11_BOX,
                        },
                        Dxgi::IDXGIDevice,
                    };

                    // Window bounding rect in desktop (global) coordinates.
                    let mut wrect = RECT::default();
                    if unsafe { GetWindowRect(hwnd, &mut wrect) }.is_err() {
                        let msg = "[capture/window] WGC unavailable and GetWindowRect failed";
                        eprintln!("{msg}");
                        write_capture_error(msg);
                        return;
                    }

                    // Monitor containing this window.
                    let hmon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
                    let mut mi = MONITORINFO {
                        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    if !unsafe { GetMonitorInfoW(hmon, &mut mi) }.as_bool() {
                        let msg = "[capture/window] WGC unavailable and GetMonitorInfoW failed";
                        eprintln!("{msg}");
                        write_capture_error(msg);
                        return;
                    }

                    // Reuse the cached device — see get_or_create_capture_device().
                    let (d3d_device, d3d_context, gpu_vendor, _adapter_name) = match get_or_create_capture_device() {
                        Some(triple) => triple,
                        None => {
                            let msg = "[capture/window/dxgi-fallback] D3D11CreateDevice failed";
                            eprintln!("{msg}");
                            write_capture_error(msg);
                            return;
                        }
                    };

                    // Find the DXGI output whose HMONITOR matches the window's monitor.
                    let dxgi_output1 = {
                        let dxgi_dev: IDXGIDevice = match d3d_device.cast() {
                            Ok(d) => d,
                            Err(_) => { eprintln!("[capture/window/dxgi-fallback] IDXGIDevice cast failed"); return; }
                        };
                        let adapter = match unsafe { dxgi_dev.GetAdapter() } {
                            Ok(a) => a,
                            Err(_) => { eprintln!("[capture/window/dxgi-fallback] GetAdapter failed"); return; }
                        };
                        let mut found: Option<IDXGIOutput1> = None;
                        let mut idx = 0u32;
                        loop {
                            let out = match unsafe { adapter.EnumOutputs(idx) } { Ok(o) => o, Err(_) => break };
                            if let Ok(desc) = unsafe { out.GetDesc() } {
                                if desc.Monitor == hmon { found = out.cast().ok(); break; }
                            }
                            idx += 1;
                        }
                        match found {
                            Some(o) => o,
                            None => {
                                let msg = "[capture/window/dxgi-fallback] DXGI output for window monitor not found";
                                eprintln!("{msg}"); write_capture_error(msg); return;
                            }
                        }
                    };

                    let dupl = match unsafe { dxgi_output1.DuplicateOutput(&d3d_device) } {
                        Ok(d) => d,
                        Err(e) => {
                            let msg = format!("[capture/window/dxgi-fallback] DuplicateOutput failed: {e}");
                            eprintln!("{msg}"); write_capture_error(&msg); return;
                        }
                    };

                    // Crop box in monitor-relative coordinates (DXGI textures use monitor origin).
                    let mon_left = mi.rcMonitor.left;
                    let mon_top  = mi.rcMonitor.top;
                    let mon_w    = (mi.rcMonitor.right  - mon_left) as u32;
                    let mon_h    = (mi.rcMonitor.bottom - mon_top ) as u32;
                    let crop_left   = (wrect.left   - mon_left).max(0) as u32;
                    let crop_top    = (wrect.top    - mon_top ).max(0) as u32;
                    let crop_right  = ((wrect.right  - mon_left).max(0) as u32).min(mon_w);
                    let crop_bottom = ((wrect.bottom - mon_top ).max(0) as u32).min(mon_h);
                    let win_w = crop_right.saturating_sub(crop_left);
                    let win_h = crop_bottom.saturating_sub(crop_top);
                    if win_w == 0 || win_h == 0 {
                        eprintln!("[capture/window/dxgi-fallback] zero crop dimensions — aborting");
                        return;
                    }
                    eprintln!("[capture/window/dxgi-fallback] {win_w}x{win_h} crop at ({crop_left},{crop_top})");

                    let acquire_timeout_ms = (1000 / config.fps.max(1)).max(8);
                    // Intermediate texture at window dimensions; receives CopySubresourceRegion
                    // so only the game's pixels reach stage_frame and the encoder.
                    let mut crop_tex_opt: Option<ID3D11Texture2D> = None;
                    let mut encoder_opt: Option<encoder::StatefulEncoder> = None;
                    let mut ts_clamp = MonotonicTs::default();

                    while CAPTURE_RUNNING.load(Ordering::SeqCst) {
                        // [HARVEST TOP]
                        if let Some(ref mut enc) = encoder_opt {
                            while let Some(nal) = enc.try_harvest() {
                                emit_nal(&tx, &overlay_tx, nal);
                            }
                        }

                        let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
                        let mut desktop_resource = None;
                        match unsafe { dupl.AcquireNextFrame(acquire_timeout_ms, &mut frame_info, &mut desktop_resource) } {
                            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                            Err(e) => {
                                let msg = format!("[capture/window/dxgi-fallback] AcquireNextFrame error: {e}");
                                eprintln!("{msg}");
                                write_capture_error(&msg);
                                if let Some(ref mut enc) = encoder_opt { enc.mark_device_lost(); }
                                *capture_device_store().lock().unwrap() = None;
                                break;
                            }
                            Ok(()) => {}
                        }

                        let dxgi_tex: ID3D11Texture2D = match desktop_resource
                            .and_then(|r| r.cast::<ID3D11Texture2D>().ok())
                        {
                            Some(t) => t,
                            None => { let _ = unsafe { dupl.ReleaseFrame() }; continue; }
                        };

                        // Lazy-init hw encoder at window dimensions (not full monitor).
                        if encoder_opt.is_none() {
                            let (enc_w, enc_h) = enc_dims(win_w, win_h, config.enc_limits());
                            let codec_result = init_encoder_with_fallback(
                                CaptureDeviceRole::WindowPreferred,
                                gpu_vendor,
                                win_w,
                                win_h,
                                enc_w,
                                enc_h,
                                &config,
                                &d3d_device,
                                &d3d_context,
                            );
                            match codec_result {
                                Ok(enc) => {
                                    eprintln!("[capture/window/dxgi-fallback] D3D11VA encoder ready \
                                              ({win_w}x{win_h} -> {enc_w}x{enc_h})");
                                    encoder_opt = Some(enc);
                                }
                                Err(e) => {
                                    write_capture_error(&format!(
                                        "[capture/window/dxgi-fallback] D3D11VA init failed: {e}"));
                                    let _ = unsafe { dupl.ReleaseFrame() };
                                    break;
                                }
                            }
                        }

                        // Allocate or reuse a window-sized staging texture matching DXGI format.
                        let mut dxgi_desc = D3D11_TEXTURE2D_DESC::default();
                        unsafe { dxgi_tex.GetDesc(&mut dxgi_desc) };
                        let needs_new_crop = match crop_tex_opt.as_ref() {
                            None => true,
                            Some(t) => {
                                let mut d = D3D11_TEXTURE2D_DESC::default();
                                unsafe { t.GetDesc(&mut d) };
                                d.Width != win_w || d.Height != win_h || d.Format != dxgi_desc.Format
                            }
                        };
                        if needs_new_crop {
                            use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
                            let desc = D3D11_TEXTURE2D_DESC {
                                Width:          win_w,
                                Height:         win_h,
                                MipLevels:      1,
                                ArraySize:      1,
                                Format:         dxgi_desc.Format,
                                SampleDesc:     DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                                Usage:          D3D11_USAGE_DEFAULT,
                                BindFlags:      0x20 | 0x08, // RENDER_TARGET | SHADER_RESOURCE
                                CPUAccessFlags: 0,
                                MiscFlags:      0,
                            };
                            let mut tex = None;
                            if let Err(e) = unsafe { d3d_device.CreateTexture2D(&desc, None, Some(&mut tex)) } {
                                eprintln!("[capture/window/dxgi-fallback] CreateTexture2D(crop) failed: {e}");
                                let _ = unsafe { dupl.ReleaseFrame() };
                                continue;
                            }
                            crop_tex_opt = tex;
                        }

                        let crop_tex = match crop_tex_opt.as_ref() {
                            Some(t) => t.clone(),
                            None => { let _ = unsafe { dupl.ReleaseFrame() }; continue; }
                        };

                        // GPU blit: copy only the window's region from the desktop texture.
                        let src_box = D3D11_BOX {
                            left: crop_left, top: crop_top, front: 0,
                            right: crop_right, bottom: crop_bottom, back: 1,
                        };
                        unsafe {
                            d3d_context.CopySubresourceRegion(
                                &crop_tex, 0, 0, 0, 0,
                                &dxgi_tex, 0,
                                Some(std::ptr::addr_of!(src_box)),
                            );
                        }

                        // Release DXGI frame lock after the GPU copy (same as DXGI monitor path).
                        let _ = unsafe { dupl.ReleaseFrame() };
                        let timestamp_ms = ts_clamp.next(dxgi_frame_ts_ms(&frame_info));

                        // [SUBMIT BOTTOM] Stage crop_tex → VideoProcessor → NVENC.
                        if let Some(ref mut enc) = encoder_opt {
                            match enc.stage_frame(&crop_tex) {
                                Ok(()) => {
                                    if let Err(e) = enc.submit_frame(timestamp_ms) {
                                        eprintln!("[capture/window/dxgi-fallback] submit_frame error: {e}");
                                    }
                                }
                                Err(e) => eprintln!("[capture/window/dxgi-fallback] stage_frame error: {e}"),
                            }
                        }
                    }

                    // Final harvest + drain before encoder resources are released.
                    if let Some(ref mut enc) = encoder_opt {
                        while let Some(nal) = enc.try_harvest() {
                            emit_nal(&tx, &overlay_tx, nal);
                        }
                        eprintln!("[capture/window/dxgi-fallback] draining encoder before shutdown");
                        enc.drain();
                    }
                }
            });
            *capture_thread_store().lock().unwrap() = Some(handle);
            return Ok(());
        }

        // ── Monitor capture path ─────────────────────────────────────────
        // Two routes, chosen by which adapter OWNS (scans out) the display:
        //  * NVIDIA/AMD-owned output → DXGI Desktop Duplication on a device on
        //    that adapter (WGC fallback on the same device). Unchanged behavior.
        //  * Output owned by an adapter with no encoder path (Intel iGPU on a
        //    hybrid laptop) → see run_hybrid_monitor_capture: WGC + encoder on
        //    the NVENC/AMF-capable device; Desktop Duplication is skipped.
        let output_index: u32 = effective_source
            .strip_prefix("monitor:")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        let handle = std::thread::spawn(move || {
            use windows::Win32::{
                Graphics::{
                    Direct3D11::{ID3D11Texture2D, D3D11_TEXTURE2D_DESC},
                    Dxgi::{
                        IDXGIOutput1, DXGI_ERROR_WAIT_TIMEOUT,
                        DXGI_OUTDUPL_FRAME_INFO,
                    },
                },
                System::Threading::{
                    GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
                },
            };

            unsafe { let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL); }

            // Resolve monitor:N against ALL adapters (same numbering as
            // list_sources), independent of which device will encode.
            let out = match enumerate_monitor_outputs().into_iter().find(|o| o.index == output_index) {
                Some(o) => o,
                None => {
                    let msg = format!(
                        "[capture/monitor] Display {output_index} was not found — it may have been \
                         disconnected or renumbered. Refresh the source list and pick the display again."
                    );
                    eprintln!("{msg}");
                    write_capture_error(&msg);
                    write_capture_breadcrumb(&msg);
                    return;
                }
            };
            write_capture_breadcrumb(&format!(
                "[capture/monitor] monitor:{} '{}' {}x{} owned by adapter '{}' (vendor={})",
                out.index, out.device_name, out.width, out.height,
                out.adapter_name, vendor_name(out.adapter_vendor)
            ));
            let h_monitor = out.hmonitor;
            let src_w = (out.width as i32).max(1);
            let src_h = (out.height as i32).max(1);

            if !out.adapter_vendor.has_encoder() {
                run_hybrid_monitor_capture(&out, src_w, src_h, &config, &tx, &overlay_tx);
                return;
            }

            write_capture_breadcrumb(
                "[capture/monitor] path=dxgi-dd (output adapter has an encoder; WGC on the same device if DD fails)",
            );
            // Cached device on the output's owning adapter — see get_or_create_monitor_capture_device_for().
            let (d3d_device, d3d_context, gpu_vendor, _adapter_name) = match get_or_create_monitor_capture_device_for(&out) {
                Some(triple) => triple,
                None => {
                    let msg = format!(
                        "[capture/monitor] D3D11CreateDevice failed on adapter '{}'",
                        out.adapter_name
                    );
                    eprintln!("{msg}");
                    write_capture_error(&msg);
                    write_capture_breadcrumb(&msg);
                    return;
                }
            };
            let dxgi_output1: IDXGIOutput1 = out.output.clone();

            // ── Try DXGI Desktop Duplication first (reliable for exclusive-fullscreen games) ──
            let dxgi_result = unsafe { dxgi_output1.DuplicateOutput(&d3d_device) };
            // Staging texture for CPU readback and frame counter for throttling preview frames.
            let mut staging_for_preview: Option<ID3D11Texture2D> = None;
            if let Ok(dupl) = dxgi_result {
                eprintln!("[capture/monitor] Using DXGI Desktop Duplication");
                let acquire_timeout_ms = (1000 / config.fps.max(1)).max(8);
                let mut encoder_opt: Option<encoder::StatefulEncoder> = None;
                let mut ts_clamp = MonotonicTs::default();
                let mut dxgi_gate = FrameGate::new(std::time::Duration::from_micros(
                    1_000_000 / config.fps.max(1) as u64,
                ));
                let mut last_preview = std::time::Instant::now();

                while CAPTURE_RUNNING.load(Ordering::SeqCst) {
                    // [HARVEST TOP] Collect NAL encoded during the previous iteration.
                    // GPU finished during AcquireNextFrame's DWM vsync wait — try_harvest
                    // returns immediately without blocking the CPU.
                    if let Some(ref mut enc) = encoder_opt {
                        while let Some(nal) = enc.try_harvest() {
                            emit_nal(&tx, &overlay_tx, nal);
                        }
                    }
                    let mut frame_info = DXGI_OUTDUPL_FRAME_INFO::default();
                    let mut desktop_resource = None;
                    let mut frame_released = false;
                    #[cfg(feature = "dev_perf")]
                    let acquire_t = std::time::Instant::now();
                    #[cfg(feature = "dev_perf")]
                    let mut acquire_frame_ms: f64 = 0.0;
                    #[cfg(feature = "dev_perf")]
                    let mut dxgi_lock_window_ms: f64 = 0.0;

                    match unsafe { dupl.AcquireNextFrame(acquire_timeout_ms, &mut frame_info, &mut desktop_resource) } {
                        Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => continue,
                        Err(e) => {
                            let msg = format!("[capture/dxgi] AcquireNextFrame error: {e}");
                            eprintln!("{msg}");
                            write_capture_error(&msg);
                            // DXGI failed — the D3D11 device may be lost/invalid.
                            // Mark the encoder so drain() and Drop skip NVENC/D3D11
                            // calls that would raise a Windows SEH on a bad device.
                            if let Some(ref mut enc) = encoder_opt { enc.mark_device_lost(); }
                            *capture_monitor_device_store().lock().unwrap() = None;
                            break;
                        }
                        Ok(()) => {
                            #[cfg(feature = "dev_perf")]
                            { acquire_frame_ms = acquire_t.elapsed().as_secs_f64() * 1000.0; }
                        }
                    }
                    #[cfg(feature = "dev_perf")]
                    let dxgi_lock_t = std::time::Instant::now();

                    // LastPresentTime is raw QPC ticks — convert with the real
                    // QPC frequency (the old `/ 10_000` assumed 10 MHz).
                    let timestamp_ms = ts_clamp.next(dxgi_frame_ts_ms(&frame_info));

                    let texture: ID3D11Texture2D = match desktop_resource
                        .as_ref()
                        .and_then(|r| r.cast::<ID3D11Texture2D>().ok())
                    {
                        Some(t) => t,
                        None => { let _ = unsafe { dupl.ReleaseFrame() }; continue; }
                    };

                    // Pace to the requested FPS (same FrameGate as the WGC paths):
                    // on a 144/240 Hz panel DXGI hands us a frame per present, and
                    // encoding all of them overloads the encoder vs. the profile.
                    // Hold the (newest) acquired frame until it is due.
                    {
                        let wait = dxgi_gate.wait(std::time::Instant::now());
                        if !wait.is_zero() {
                            std::thread::sleep(wait);
                        }
                        dxgi_gate.mark(std::time::Instant::now());
                    }

                    let mut tex_desc = D3D11_TEXTURE2D_DESC::default();
                    unsafe { texture.GetDesc(&mut tex_desc) };
                    let w = tex_desc.Width;
                    let h = tex_desc.Height;

                    // Initialize D3D11VA GPU encoder on first frame
                    if encoder_opt.is_none() {
                        let (enc_w, enc_h) = enc_dims(w, h, config.enc_limits());
                        let codec_result = init_encoder_with_fallback(
                            CaptureDeviceRole::MonitorOutput,
                            gpu_vendor,
                            w,
                            h,
                            enc_w,
                            enc_h,
                            &config,
                            &d3d_device,
                            &d3d_context,
                        );
                        match codec_result {
                            Ok(enc) => {
                                #[cfg(feature = "dev_perf")]
                                { perf::set_encoder_name(enc.codec_name); perf::set_resolution(enc_w, enc_h); }
                                encoder_opt = Some(enc);
                                eprintln!("[capture/dxgi] D3D11VA encoder ready ({w}x{h} -> {enc_w}x{enc_h})");
                            }
                            Err(e) => {
                                let msg = format!("[capture/dxgi] D3D11VA init failed: {e}");
                                eprintln!("{msg}");
                                write_capture_error(&msg);
                                let _ = unsafe { dupl.ReleaseFrame() };
                                break;
                            }
                        }
                    }

                    if let Some(ref mut enc) = encoder_opt {
                        #[cfg(feature = "dev_perf")]
                        let _interval_ms = perf::tick();
                        #[cfg(feature = "dev_perf")]
                        let stage_t = std::time::Instant::now();
                        let stage_ok = match enc.stage_frame(&texture) {
                            Ok(()) => true,
                            Err(e) => {
                                eprintln!("[capture/dxgi] stage_frame error: {e}");
                                false
                            }
                        };
                        #[cfg(feature = "dev_perf")]
                        let stage_frame_ms = stage_t.elapsed().as_secs_f64() * 1000.0;

                        // Preview readback must happen while the acquired DXGI frame
                        // is still valid. Using `texture` after ReleaseFrame is UB.
                        if stage_ok {
                            // Time-based (~2/s) so it doesn't scale with source FPS.
                            if last_preview.elapsed() >= std::time::Duration::from_millis(500) {
                                last_preview = std::time::Instant::now();
                                if staging_for_preview.is_none() {
                                    let fmt = tex_desc.Format.0;
                                    if (fmt == 87 || fmt == 91) && preview_tx.is_some() {
                                        let sdesc = D3D11_TEXTURE2D_DESC {
                                            Width: tex_desc.Width,
                                            Height: tex_desc.Height,
                                            MipLevels: 1,
                                            ArraySize: 1,
                                            Format: tex_desc.Format,
                                            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                                            Usage: D3D11_USAGE(3),
                                            BindFlags: 0,
                                            CPUAccessFlags: 0x20000,
                                            MiscFlags: 0,
                                        };
                                        let mut stag: Option<ID3D11Texture2D> = None;
                                        if unsafe { d3d_device.CreateTexture2D(&sdesc, None, Some(&mut stag)) }.is_ok() {
                                            staging_for_preview = stag;
                                        }
                                    }
                                }
                                if let (Some(ref stag), Some(ref ptx)) = (&staging_for_preview, &preview_tx) {
                                    unsafe { d3d_context.CopyResource(stag, &texture) };
                                    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                                    if unsafe { d3d_context.Map(stag, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.is_ok() {
                                        // Nearest-neighbour sample straight from the mapped
                                        // memory: no full-frame CPU copy.
                                        let (sw, sh) = (tex_desc.Width, tex_desc.Height);
                                        let (tw, th) = aspect_thumb(sw, sh);
                                        let pitch = mapped.RowPitch as usize;
                                        let src_ptr = mapped.pData as *const u8;
                                        let mut thumb = vec![0u8; (tw * th * 4) as usize];
                                        if tw > 0 && th > 0 {
                                            for y in 0..th {
                                                let sy = (y * sh / th) as usize;
                                                for x in 0..tw {
                                                    let sx = (x * sw / tw) as usize;
                                                    let di = (y as usize * tw as usize + x as usize) * 4;
                                                    unsafe {
                                                        std::ptr::copy_nonoverlapping(
                                                            src_ptr.add(sy * pitch + sx * 4),
                                                            thumb.as_mut_ptr().add(di),
                                                            4,
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                        unsafe { d3d_context.Unmap(stag, 0) };
                                        let _ = ptx.send(CapturePreviewFrame {
                                            thumb_b64: to_base64(&thumb),
                                            width: tw,
                                            height: th,
                                        });
                                    }
                                }
                            }
                        }

                        let _ = unsafe { dupl.ReleaseFrame() };
                        frame_released = true;
                        #[cfg(feature = "dev_perf")]
                        { dxgi_lock_window_ms = dxgi_lock_t.elapsed().as_secs_f64() * 1000.0; }

                        if !stage_ok {
                            continue;
                        }

                        // [SUBMIT BOTTOM] VP blit + NVENC send_frame.  GPU encodes
                        // asynchronously; NAL is collected by try_harvest next iteration.
                        if let Err(e) = enc.submit_frame(timestamp_ms) {
                            eprintln!("[capture/dxgi] submit_frame error: {e}");
                        }
                        #[cfg(feature = "dev_perf")]
                        {
                            perf::record_frame(perf::FrameSample {
                                session_ms: timestamp_ms,
                                acquire_interval_ms: _interval_ms,
                                acquire_frame_ms,
                                dxgi_lock_window_ms,
                                stage_frame_ms,
                                vp_nvenc_ms: 0.0,
                                copy_ms: 0.0,
                                encode_ms: 0.0,
                                e2e_ms: 0.0,
                                stall_ms: 0.0,
                                dropped: false,
                            });
                        }
                    }

                    if !frame_released {
                        let _ = unsafe { dupl.ReleaseFrame() };
                    }
                }

                // Final harvest: collect the NAL for the last submitted frame.
                if let Some(ref mut enc) = encoder_opt {
                    while let Some(nal) = enc.try_harvest() {
                        emit_nal(&tx, &overlay_tx, nal);
                    }
                    eprintln!("[capture/dxgi] draining encoder before shutdown");
                    enc.drain();
                }
                eprintln!("[capture/dxgi] encoder drained — about to drop dupl/device/context");
            } else {
                // ── WGC fallback (same device) ──────────────────────────────────────
                let dxgi_err = dxgi_result.unwrap_err();
                eprintln!("[capture/monitor] DXGI unavailable ({dxgi_err}), trying WGC");
                write_capture_breadcrumb(&format!(
                    "[capture/monitor] DuplicateOutput failed ({dxgi_err}) — falling back to WGC on the same device"
                ));
                if !run_wgc_monitor_loop(
                    &d3d_device,
                    &d3d_context,
                    gpu_vendor,
                    CaptureDeviceRole::MonitorOutput,
                    h_monitor,
                    src_w,
                    src_h,
                    &config,
                    &tx,
                    &overlay_tx,
                    reset_monitor_device_cache,
                ) {
                    eprintln!("[capture/monitor] Both DXGI and WGC unavailable — aborting");
                    write_capture_breadcrumb("[capture/monitor] Both DXGI and WGC unavailable — aborting");
                }
            }
        });
        *capture_thread_store().lock().unwrap() = Some(handle);
        return Ok(());
    }
}

/// Monitor capture on a hybrid-GPU machine: the display is scanned out by an
/// adapter we cannot encode on (Intel iGPU, or another vendor without a
/// NVENC/AMF path), so capture AND encode both run on the cached
/// encoder-capable device (`get_or_create_capture_device`, which prefers
/// NVIDIA, then AMD) via Windows.Graphics.Capture. Desktop Duplication is
/// skipped entirely: DuplicateOutput() requires a device on the adapter that
/// owns the output, and a Desktop Duplication texture on the iGPU device can't
/// be fed to an encoder on the dGPU device — `stage_frame`'s CopyResource is
/// same-device only and fails SILENTLY across devices (black frames).
///
/// With WGC, the frame pool is created from the dGPU device
/// (CreateDirect3D11DeviceFromDXGIDevice in try_create_wgc_session), so every
/// frame texture already lives on the encoder's device; DWM composes on the
/// iGPU and Windows does the cross-adapter copy into the pool (the same thing
/// OBS relies on for display capture on Optimus laptops).
///
/// Risk note: WGC can be less dependable than Desktop Duplication for some
/// exclusive-fullscreen games. On these machines display capture was 100%
/// broken before (Intel device → no encoder), so this is strictly an
/// improvement; NVIDIA/AMD-owned outputs keep the DD-first path.
#[cfg(target_os = "windows")]
fn run_hybrid_monitor_capture(
    out: &MonitorOutput,
    src_w: i32,
    src_h: i32,
    config: &CaptureConfig,
    tx: &std::sync::mpsc::Sender<NalUnit>,
    overlay_tx: &Option<std::sync::mpsc::Sender<NalUnit>>,
) {
    write_capture_breadcrumb(&format!(
        "[capture/monitor] output adapter '{}' (vendor={}) has no supported hardware encoder — \
         hybrid path: skipping Desktop Duplication, using WGC + encoder on the encode-capable device",
        out.adapter_name,
        vendor_name(out.adapter_vendor)
    ));
    let (dev, ctx, vendor, adapter_name) = match get_or_create_capture_device() {
        Some(t) if t.2.has_encoder() => t,
        Some((_, _, vendor, adapter_name)) => {
            let msg = format!(
                "[capture/monitor] {NO_HW_ENCODER_MSG} (display adapter: '{}' [{}], best other adapter: '{}' [{}])",
                out.adapter_name,
                vendor_name(out.adapter_vendor),
                adapter_name,
                vendor_name(vendor)
            );
            eprintln!("{msg}");
            write_capture_error(&msg);
            write_capture_breadcrumb(&msg);
            return;
        }
        None => {
            let msg = "[capture/monitor] Could not create a D3D11 device on any graphics adapter";
            eprintln!("{msg}");
            write_capture_error(msg);
            write_capture_breadcrumb(msg);
            return;
        }
    };
    write_capture_breadcrumb(&format!(
        "[capture/monitor] path=wgc-hybrid capture+encode device='{}' (vendor={})",
        adapter_name,
        vendor_name(vendor)
    ));
    // Role WindowPreferred: this IS the window-preferred device, so its row of
    // the compatibility report is the one that applies to codec ordering.
    let started = run_wgc_monitor_loop(
        &dev,
        &ctx,
        vendor,
        CaptureDeviceRole::WindowPreferred,
        out.hmonitor,
        src_w,
        src_h,
        config,
        tx,
        overlay_tx,
        reset_capture_device_cache,
    );
    if !started {
        let msg = "[capture/monitor] Windows Graphics Capture could not start for this display. \
                   On laptops whose screen runs on integrated graphics it is the only way to share \
                   the full display — update Windows and the graphics drivers, or share a window instead.";
        eprintln!("{msg}");
        write_capture_error(msg);
        write_capture_breadcrumb(msg);
    }
}

/// WGC monitor capture loop: framepool and encoder on the SAME `d3d_device`
/// (required — see run_hybrid_monitor_capture). Returns false if the WGC
/// session could not be created (nothing was captured); true once a session
/// ran, however it ended. `reset_cache` drops whichever device cache
/// `d3d_device` came from when the session dies unexpectedly (possible device
/// loss), so the next start_capture() builds a fresh device.
#[cfg(target_os = "windows")]
#[allow(clippy::too_many_arguments)]
fn run_wgc_monitor_loop(
    d3d_device: &ID3D11Device,
    d3d_context: &ID3D11DeviceContext,
    gpu_vendor: GpuVendor,
    role: CaptureDeviceRole,
    h_monitor: windows::Win32::Graphics::Gdi::HMONITOR,
    src_w: i32,
    src_h: i32,
    config: &CaptureConfig,
    tx: &std::sync::mpsc::Sender<NalUnit>,
    overlay_tx: &Option<std::sync::mpsc::Sender<NalUnit>>,
    reset_cache: fn(),
) -> bool {
    let Some((_wgc_session, wgc_pool, frame_signal_rx, session_active)) =
        try_create_wgc_session(d3d_device, src_w, src_h, WgcCaptureTarget::Monitor(h_monitor))
    else {
        write_capture_breadcrumb("[capture/wgc/monitor] WGC session creation failed");
        return false;
    };
    write_capture_breadcrumb(&format!(
        "[capture/wgc/monitor] session started {src_w}x{src_h} role={}",
        role.as_str()
    ));

    let frame_period = std::time::Duration::from_micros(
        1_000_000 / config.fps.max(1) as u64,
    );
    let mut gate = FrameGate::new(frame_period);
    let mut encoder_opt: Option<encoder::StatefulEncoder> = None;

    while CAPTURE_RUNNING.load(Ordering::SeqCst) {
        // [HARVEST TOP] Collect NAL encoded during the previous iteration.
        // GPU finished during the frame_rx.recv_timeout wait — try_harvest
        // returns immediately without blocking.
        if let Some(ref mut enc) = encoder_opt {
            while let Some(nal) = enc.try_harvest() {
                emit_nal(tx, overlay_tx, nal);
            }
        }
        match frame_signal_rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(_)  => {},
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(e) => {
                let msg = format!("[capture/wgc/monitor] frame signal ended: {e}");
                eprintln!("{msg}");
                write_capture_error(&msg);
                write_capture_breadcrumb(&msg);
                reset_cache();
                break;
            }
        };

        let mut frame = match wgc_pool.TryGetNextFrame() {
            Ok(f) => f,
            Err(_) => continue,
        };
        // Drain to newest frame — same pattern as the wgc/window path.
        while frame_signal_rx.try_recv().is_ok() {
            if let Ok(newer) = wgc_pool.TryGetNextFrame() {
                frame = newer;
            }
        }

        // Early frame: hold it until due, then take the newest (see FrameGate).
        let wait = gate.wait(std::time::Instant::now());
        if !wait.is_zero() {
            std::thread::sleep(wait);
            while frame_signal_rx.try_recv().is_ok() {
                if let Ok(newer) = wgc_pool.TryGetNextFrame() {
                    frame = newer;
                }
            }
        }
        gate.mark(std::time::Instant::now());

        // Extract D3D11 texture from the WGC frame
        let surface = match frame.Surface() { Ok(s) => s, Err(_) => continue };
        let access: IDirect3DDxgiInterfaceAccess =
            match surface.cast() { Ok(a) => a, Err(_) => continue };
        let texture: ID3D11Texture2D =
            match unsafe { access.GetInterface() } { Ok(t) => t, Err(_) => continue };
        let mut tex_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut tex_desc) };
        let w = tex_desc.Width;
        let h = tex_desc.Height;
        let timestamp_ms = media_clock_ms();

        // Initialize D3D11VA GPU encoder on first frame
        if encoder_opt.is_none() {
            let (enc_w, enc_h) = enc_dims(w, h, config.enc_limits());
            let codec_result = init_encoder_with_fallback(
                role,
                gpu_vendor,
                w,
                h,
                enc_w,
                enc_h,
                config,
                d3d_device,
                d3d_context,
            );
            match codec_result {
                Ok(enc) => {
                    #[cfg(feature = "dev_perf")]
                    { perf::set_encoder_name(enc.codec_name); perf::set_resolution(enc_w, enc_h); }
                    write_capture_breadcrumb(&format!(
                        "[capture/wgc/monitor] encoder ready codec={} {w}x{h} -> {enc_w}x{enc_h}",
                        enc.codec_name
                    ));
                    encoder_opt = Some(enc);
                    eprintln!("[capture/wgc/monitor] D3D11VA encoder ready ({w}x{h} -> {enc_w}x{enc_h})");
                }
                Err(e) => {
                    let msg = format!("[capture/wgc/monitor] D3D11VA init failed: {e}");
                    eprintln!("{msg}");
                    write_capture_error(&msg);
                    write_capture_breadcrumb(&msg);
                    break;
                }
            }
        }

        // [SUBMIT BOTTOM] VP blit + NVENC send_frame.  GPU encodes
        // asynchronously; NAL is collected by try_harvest next iteration.
        if let Some(ref mut enc) = encoder_opt {
            #[cfg(feature = "dev_perf")]
            let _interval_ms = perf::tick();
            match enc.stage_frame(&texture) {
                Ok(()) => {
                    if let Err(e) = enc.submit_frame(timestamp_ms) {
                        eprintln!("[capture/wgc/monitor] submit_frame error: {e}");
                    }
                }
                Err(e) => {
                    eprintln!("[capture/wgc/monitor] stage_frame error: {e}");
                }
            }
            drop(frame);
        }
    }

    // Loop has exited — for ANY reason, not just CAPTURE_RUNNING going
    // false. Signal the FrameArrived callback before touching anything
    // below so it can't race this teardown.
    session_active.store(false, Ordering::Release);

    // Final harvest: collect the NAL for the last submitted frame.
    if let Some(ref mut enc) = encoder_opt {
        while let Some(nal) = enc.try_harvest() {
            emit_nal(tx, overlay_tx, nal);
        }
        eprintln!("[capture/wgc/monitor] draining encoder before shutdown");
        enc.drain();
    }
    // encoder_opt drops at function end, after the session/pool Close below —
    // same order as before this loop was factored out of start_capture.

    eprintln!("[capture/wgc/monitor] WGC loop exited, closing session");
    let _ = _wgc_session.Close();
    let _ = wgc_pool.Close();
    drop(frame_signal_rx);
    true
}

pub fn stop_capture() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Hold the stop guard for the duration of the join.  If another caller
        // (e.g. a new start_capture) races with a fire-and-forget stop_capture
        // IPC call that has already taken the join handle, this ensures the
        // second caller waits here rather than proceeding while the first join
        // is still in progress.  Without this, two NVENC sessions can exist
        // simultaneously on the same GPU, triggering a structured exception.
        //
        // These checkpoints also mirror to setup_errors.log (not just eprintln!,
        // which is invisible on this no-console build) so a stuck join() here —
        // rather than something overlay-specific — can be confirmed or ruled out
        // from the next hang report instead of guessed at.
        crate::write_setup_error("[capture] stop_capture() waiting for stop guard");
        let _stop_guard = capture_stop_guard().lock().unwrap();
        eprintln!("[capture] stop_capture() called");
        crate::write_setup_error("[capture] stop_capture() called");
        CAPTURE_RUNNING.store(false, Ordering::SeqCst);
        #[cfg(feature = "dev_perf")]
        perf::stop_perf_session();
        let handle = capture_thread_store().lock().unwrap().take();
        if let Some(h) = handle {
            crate::write_setup_error("[capture] stop_capture() joining capture thread");
            if let Err(_) = h.join() {
                let msg = "[capture] capture thread panicked during stop";
                eprintln!("{msg}");
                write_capture_error(msg);
                crate::write_setup_error(msg);
            } else {
                crate::write_setup_error("[capture] stop_capture() join returned");
            }
            // The join() above only guarantees our own Rust/COM-level teardown
            // (session.Close(), device Release(), etc.) has returned — it does NOT
            // guarantee the GPU driver has finished asynchronously reclaiming the
            // just-closed NVENC/AMF session. Opening a brand new hardware encoder
            // session immediately after can still race that driver-side cleanup and
            // crash with a structured exception, even though every call above
            // reported success. A short cooldown here gives the driver time to
            // actually finish before start_capture() opens a new session.
            std::thread::sleep(std::time::Duration::from_millis(300));
            eprintln!("[capture] stop_capture() cooldown complete");
            crate::write_setup_error("[capture] stop_capture() cooldown complete");
        } else {
            crate::write_setup_error("[capture] stop_capture() no thread handle to join (already stopped)");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lim(max_w: u32, max_h: u32, max_px: u32) -> EncLimits { EncLimits { max_w, max_h, max_px } }
    /// What CommLink sends for the 1080p profile.
    const P1080: EncLimits = EncLimits { max_w: 3840, max_h: 1080, max_px: 1920 * 1080 };
    const P1440: EncLimits = EncLimits { max_w: 3840, max_h: 1440, max_px: 2560 * 1440 };

    fn aspect(w: u32, h: u32) -> f64 { w as f64 / h as f64 }

    #[test]
    fn enc_dims_height_only_is_the_old_behaviour() {
        assert_eq!(enc_dims(2560, 1440, lim(0, 1080, 0)), (1920, 1080));
        assert_eq!(enc_dims(2560, 1600, lim(0, 1080, 0)), (1728, 1080));
        assert_eq!(enc_dims(3840, 2160, lim(0, 1080, 0)), (1920, 1080));
        assert_eq!(enc_dims(5120, 1440, lim(0, 1080, 0)), (3840, 1080));
        assert_eq!(enc_dims(1280, 720, lim(0, 1080, 0)), (1280, 720));
        assert_eq!(enc_dims(1920, 1080, lim(0, 0, 0)), (1920, 1080));
    }

    #[test]
    fn enc_dims_pixel_budget_keeps_ultrawide_shape() {
        // 32:9 — the ultrawide case (was 3840x1080 = 2x the 1080p pixel count).
        let (w, h) = enc_dims(5120, 1440, P1080);
        assert_eq!((w, h), (2714, 762));
        assert!(w * h <= 1920 * 1080);
        assert!((aspect(w, h) - aspect(5120, 1440)).abs() < 0.01);
        // 21:9
        assert_eq!(enc_dims(3440, 1440, P1080), (2224, 930));
        let (w, h) = enc_dims(2560, 1080, P1080);
        assert!(w * h <= 1920 * 1080 && (aspect(w, h) - aspect(2560, 1080)).abs() < 0.01);
        // 32:9 that's already 1080 tall still has twice the budget's pixels.
        assert_eq!(enc_dims(3840, 1080, P1080), (2714, 762));
    }

    #[test]
    fn enc_dims_16_9_and_16_10_unchanged() {
        assert_eq!(enc_dims(1920, 1080, P1080), (1920, 1080));
        assert_eq!(enc_dims(2560, 1440, P1080), (1920, 1080));
        assert_eq!(enc_dims(3840, 2160, P1080), (1920, 1080));
        assert_eq!(enc_dims(2560, 1600, P1080), (1728, 1080));
        assert_eq!(enc_dims(1920, 1200, P1080), (1728, 1080));
        assert_eq!(enc_dims(2560, 1440, P1440), (2560, 1440));
        assert_eq!(enc_dims(3840, 2160, P1440), (2560, 1440));
    }

    #[test]
    fn enc_dims_4_3_portrait_and_small() {
        assert_eq!(enc_dims(1600, 1200, P1080), (1440, 1080));
        assert_eq!(enc_dims(1024, 768, P1080), (1024, 768));
        // Portrait: the height cap rules.
        assert_eq!(enc_dims(1080, 1920, P1080), (606, 1080));
        assert_eq!(enc_dims(1440, 2560, P1080), (606, 1080));
        // Already small: never upscaled; odd sizes rounded down to even.
        assert_eq!(enc_dims(1280, 720, P1080), (1280, 720));
        assert_eq!(enc_dims(1365, 767, P1080), (1364, 766));
        assert_eq!(enc_dims(3, 3, P1080), (2, 2));
    }

    #[test]
    fn enc_dims_width_cap() {
        assert_eq!(enc_dims(7680, 1080, lim(3840, 1080, 0)), (3840, 540));
        let (w, _) = enc_dims(15360, 1440, P1440);
        assert!(w <= 3840);
    }

    #[test]
    fn enc_dims_always_even_within_limits_and_level_5_1() {
        let sources = [
            (5120, 1440), (3440, 1440), (2560, 1080), (3840, 2160), (2560, 1600), (1920, 1200),
            (1600, 1200), (1080, 1920), (1366, 768), (1365, 767), (7680, 2160), (5760, 1080),
        ];
        for lim in [P1080, P1440, lim(0, 1080, 0)] {
            for (sw, sh) in sources {
                let (w, h) = enc_dims(sw, sh, lim);
                assert!(w % 2 == 0 && h % 2 == 0, "{sw}x{sh} -> {w}x{h} not even");
                assert!(w <= sw && h <= sh, "{sw}x{sh} -> {w}x{h} upscaled");
                if lim.max_h > 0 { assert!(h <= lim.max_h); }
                if lim.max_w > 0 { assert!(w <= lim.max_w); }
                if lim.max_px > 0 { assert!(w * h <= lim.max_px); }
                // H.264 level 5.1 (what the stream advertises): ≤ 36864
                // macroblocks per frame and ≤ 983040 MB/s at 60 fps.
                let mbs = w.div_ceil(16) * h.div_ceil(16);
                if lim.max_px > 0 {
                    assert!(mbs <= 36_864 && mbs * 60 <= 983_040, "{sw}x{sh} -> {w}x{h} exceeds level 5.1");
                }
            }
        }
    }

    #[test]
    fn frame_gate_holds_early_frames_and_keeps_cadence() {
        use std::time::{Duration, Instant};
        let p = Duration::from_micros(33_333);
        let t0 = Instant::now();
        let mut g = FrameGate::new(p);
        assert_eq!(g.wait(t0), Duration::ZERO); // first frame: right away
        g.mark(t0);
        // A 60 fps source's next frame (16.7 ms) and the one after (33.3 ms,
        // a hair early) must both be waited for, not dropped.
        assert!(g.wait(t0 + Duration::from_micros(16_700)) > Duration::from_millis(16));
        let w = g.wait(t0 + Duration::from_micros(33_300));
        assert!(w > Duration::ZERO && w < Duration::from_millis(1));
        // Encoding 1 ms late keeps the schedule (due = 2p, not late + p).
        g.mark(t0 + p + Duration::from_millis(1));
        assert_eq!(g.wait(t0 + p + Duration::from_millis(1)), p - Duration::from_millis(1));
        // Falling far behind restarts the schedule instead of bursting.
        let late = t0 + p * 10;
        g.mark(late);
        assert_eq!(g.wait(late), p);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn gpu_priority_policy_per_vendor() {
        assert_eq!(gpu_priority_plan(GpuVendor::Nvidia, None), (Some(7), Some(D3DKMT_PRIORITY_HIGH)));
        assert_eq!(gpu_priority_plan(GpuVendor::Amd, None), (None, Some(D3DKMT_PRIORITY_ABOVE_NORMAL)));
        assert_eq!(gpu_priority_plan(GpuVendor::Intel, None), (None, None));
        assert_eq!(gpu_priority_plan(GpuVendor::Nvidia, Some("off")), (None, None));
        assert_eq!(gpu_priority_plan(GpuVendor::Amd, Some(" FULL ")), (Some(7), Some(D3DKMT_PRIORITY_HIGH)));
        assert_eq!(gpu_priority_plan(GpuVendor::Amd, Some("bogus")), (None, Some(D3DKMT_PRIORITY_ABOVE_NORMAL)));
    }

    #[test]
    fn capture_config_old_callers_get_no_new_caps() {
        let c: CaptureConfig = serde_json::from_str(
            r#"{"source_id":"monitor:0","fps":30,"bitrate":4000000,"max_height":1080}"#,
        ).unwrap();
        assert_eq!(c.enc_limits(), lim(0, 1080, 0));
        let c: CaptureConfig = serde_json::from_str(
            r#"{"source_id":"monitor:0","fps":30,"bitrate":4000000,"max_height":1080,"max_width":3840,"max_pixels":2073600}"#,
        ).unwrap();
        assert_eq!(c.enc_limits(), P1080);
    }
}