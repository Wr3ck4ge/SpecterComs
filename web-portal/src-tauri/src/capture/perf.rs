/// Development-only performance instrumentation for the capture pipeline.
///
/// Compiled only when the `dev_perf` Cargo feature is enabled.
/// To disable: remove `--features dev_perf` from the build command (no code changes needed).
///
/// Tracks per-frame timing across all capture paths (D3D11VA, CPU-BGRA, CPU-YUV, PrintWindow)
/// and exposes a `capture_get_perf_report` Tauri command that returns the accumulated
/// statistics as a JSON-serialisable struct ready for submission to the server.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

// ── Maximum rolling sample window ────────────────────────────────────────────
// 2 000 frames ≈ 66 s at 30 fps  /  33 s at 60 fps.
const MAX_SAMPLES: usize = 2_000;

// ── Per-frame timing sample ───────────────────────────────────────────────────

#[derive(Clone)]
pub struct FrameSample {
    /// Wall-clock ms elapsed since session start when this frame was acquired.
    #[allow(dead_code)]
    pub session_ms: u64,
    /// Gap between this frame and the previous one (ms). Reciprocal → actual FPS.
    pub acquire_interval_ms: f64,
    /// Time spent inside DXGI `AcquireNextFrame` for this frame (ms).
    pub acquire_frame_ms: f64,
    /// Time from successful acquire to `ReleaseFrame` (ms). DXGI path only.
    pub dxgi_lock_window_ms: f64,
    /// GPU staging copy duration (`stage_frame`) for this frame (ms).
    pub stage_frame_ms: f64,
    /// Combined VideoProcessor + NVENC duration after release (ms).
    pub vp_nvenc_ms: f64,
    /// D3D11 Map + row-copy time (ms). 0 on the D3D11VA zero-copy path.
    pub copy_ms: f64,
    /// Encoder `send_frame` + `receive_packet` round-trip (ms).
    /// Measured on the encode thread; 0 until the first encoded frame arrives.
    pub encode_ms: f64,
    /// Total wall-clock from "texture acquired" to "NAL unit ready" (ms).
    pub e2e_ms: f64,
    /// Duration of any main-thread stall detected during this frame's interval (ms).
    pub stall_ms: f64,
    /// True if the frame was dropped because the encode queue was full.
    pub dropped: bool,
}

// ── Accumulator ───────────────────────────────────────────────────────────────

pub struct PerfAccumulator {
    pub samples: VecDeque<FrameSample>,
    pub ipc_emit_samples_ms: VecDeque<f64>,
    pub total_frames: u64,
    pub dropped_frames: u64,
    pub session_start: Instant,
    /// Last time the capture loop ticked; used to detect stalls.
    pub last_tick: Instant,
    pub encoder_name: String,
    pub source_id: String,
    pub width: u32,
    pub height: u32,
    pub target_fps: u32,
    pub target_bitrate: u32,
}

impl PerfAccumulator {
    pub fn new(
        encoder_name: &str,
        source_id: &str,
        width: u32,
        height: u32,
        target_fps: u32,
        target_bitrate: u32,
    ) -> Self {
        Self {
            samples: VecDeque::with_capacity(MAX_SAMPLES),
            ipc_emit_samples_ms: VecDeque::with_capacity(MAX_SAMPLES),
            total_frames: 0,
            dropped_frames: 0,
            session_start: Instant::now(),
            last_tick: Instant::now(),
            encoder_name: encoder_name.to_string(),
            source_id: source_id.to_string(),
            width,
            height,
            target_fps,
            target_bitrate,
        }
    }

    pub fn push(&mut self, sample: FrameSample) {
        self.total_frames += 1;
        if sample.dropped {
            self.dropped_frames += 1;
        }
        if self.samples.len() >= MAX_SAMPLES {
            self.samples.pop_front();
        }
        self.samples.push_back(sample);
    }

    pub fn push_ipc_emit_ms(&mut self, ms: f64) {
        if self.ipc_emit_samples_ms.len() >= MAX_SAMPLES {
            self.ipc_emit_samples_ms.pop_front();
        }
        self.ipc_emit_samples_ms.push_back(ms);
    }
}

// ── Global state ──────────────────────────────────────────────────────────────
// A single `Option<PerfAccumulator>` behind a Mutex.
// Initialised by `start_perf_session` when capture starts, cleared on stop.

pub static PERF: Mutex<Option<PerfAccumulator>> = Mutex::new(None);

/// Wall-clock time of the last UI-thread `tock()`. Used to measure main-thread stalls.
static LAST_TOCK: Mutex<Option<Instant>> = Mutex::new(None);

/// Initialise (or reset) the accumulator for a new capture session.
pub fn start_perf_session(
    encoder_name: &str,
    source_id: &str,
    width: u32,
    height: u32,
    target_fps: u32,
    target_bitrate: u32,
) {
    if let Ok(mut guard) = PERF.lock() {
        *guard = Some(PerfAccumulator::new(
            encoder_name,
            source_id,
            width,
            height,
            target_fps,
            target_bitrate,
        ));
    }
    if let Ok(mut tock_guard) = LAST_TOCK.lock() {
        *tock_guard = Some(Instant::now());
    }
}

/// Record a single frame timing sample.  Called from the capture / encode thread.
pub fn record_frame(sample: FrameSample) {
    if let Ok(mut guard) = PERF.lock() {
        if let Some(acc) = guard.as_mut() {
            acc.push(sample);
        }
    }
}

/// Record Tauri emit enqueue time measured on the relay thread.
pub fn record_ipc_emit_ms(ms: f64) {
    if let Ok(mut guard) = PERF.lock() {
        if let Some(acc) = guard.as_mut() {
            acc.push_ipc_emit_ms(ms);
        }
    }
}

/// Update the encoder name once the first frame reveals which HW path was selected.
pub fn set_encoder_name(name: &str) {
    if let Ok(mut guard) = PERF.lock() {
        if let Some(acc) = guard.as_mut() {
            acc.encoder_name = name.to_string();
        }
    }
}

/// Update the capture resolution once the first frame's texture dimensions are known.
pub fn set_resolution(w: u32, h: u32) {
    if let Ok(mut guard) = PERF.lock() {
        if let Some(acc) = guard.as_mut() {
            if acc.width == 0 { acc.width = w; }
            if acc.height == 0 { acc.height = h; }
        }
    }
}

/// Clear accumulator when capture stops.
/// Called from `stop_capture()` under `#[cfg(feature = "dev_perf")]`.
pub fn stop_perf_session() {
    if let Ok(mut guard) = PERF.lock() {
        *guard = None;
    }
    if let Ok(mut tock_guard) = LAST_TOCK.lock() {
        *tock_guard = None;
    }
}

// ── Report structures ─────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct TimingStat {
    pub mean_ms: f64,
    pub min_ms: f64,
    pub max_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
}

impl TimingStat {
    pub fn from_values(values: &mut Vec<f64>) -> Self {
        if values.is_empty() {
            return Self { mean_ms: 0.0, min_ms: 0.0, max_ms: 0.0, p50_ms: 0.0, p95_ms: 0.0, p99_ms: 0.0 };
        }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let sum: f64 = values.iter().sum();
        let pct = |p: f64| {
            let idx = ((values.len() - 1) as f64 * p / 100.0).round() as usize;
            values.get(idx).copied().unwrap_or(values[values.len() - 1])
        };
        Self {
            mean_ms: sum / values.len() as f64,
            min_ms: values[0],
            max_ms: values[values.len() - 1],
            p50_ms: pct(50.0),
            p95_ms: pct(95.0),
            p99_ms: pct(99.0),
        }
    }
}

#[derive(serde::Serialize)]
pub struct PerfReport {
    /// Schema version — bump if the shape changes.
    pub schema_version: u8,
    pub session_duration_s: f64,
    pub encoder: String,
    pub source_id: String,
    pub resolution: String,
    pub target_fps: u32,
    pub target_bitrate_bps: u32,
    /// Total frames that entered the capture loop (including drops).
    pub total_frames: u64,
    /// Frames dropped because the encode queue was full.
    pub dropped_frames: u64,
    pub drop_rate_pct: f64,
    /// How many frames are included in the timing stats below.
    pub sample_count: usize,
    /// Inter-frame interval.  1 000 / mean_ms ≈ actual FPS.
    pub acquire_interval_ms: TimingStat,
    /// DXGI acquire call duration.
    pub acquire_frame_ms: TimingStat,
    /// Time frame stays locked between acquire and release in DXGI path.
    pub dxgi_lock_window_ms: TimingStat,
    /// GPU staging time (`stage_frame`).
    pub stage_frame_ms: TimingStat,
    /// VideoProcessor + NVENC timing after frame release.
    pub vp_nvenc_ms: TimingStat,
    /// D3D11 Map + row-copy time (0 on D3D11VA path).
    pub copy_ms: TimingStat,
    /// Encoder round-trip.
    pub encode_ms: TimingStat,
    /// End-to-end pipeline latency.
    pub e2e_ms: TimingStat,
    /// Main-thread stall time.
    pub stall_ms: TimingStat,
    /// Tauri event enqueue duration measured on IPC relay thread.
    pub ipc_emit_ms: TimingStat,
    pub actual_fps: f64,
    pub app_version: String,
}

/// Build a `PerfReport` snapshot from the current accumulator state.
pub fn build_report() -> Option<PerfReport> {
    let guard = PERF.lock().ok()?;
    let acc = guard.as_ref()?;

    // Filter out zero values so metrics absent from a given path (e.g. copy_ms=0
    // on the D3D11VA path) don't drag down the stats for paths that do have them.
    let mut acquire: Vec<f64> = acc.samples.iter().map(|s| s.acquire_interval_ms).filter(|&v| v > 0.0).collect();
    let mut acquire_frame: Vec<f64> = acc.samples.iter().map(|s| s.acquire_frame_ms).filter(|&v| v > 0.0).collect();
    let mut dxgi_lock_window: Vec<f64> = acc.samples.iter().map(|s| s.dxgi_lock_window_ms).filter(|&v| v > 0.0).collect();
    let mut stage_frame: Vec<f64> = acc.samples.iter().map(|s| s.stage_frame_ms).filter(|&v| v > 0.0).collect();
    let mut vp_nvenc: Vec<f64> = acc.samples.iter().map(|s| s.vp_nvenc_ms).filter(|&v| v > 0.0).collect();
    let mut copy:    Vec<f64> = acc.samples.iter().map(|s| s.copy_ms).filter(|&v| v > 0.0).collect();
    let mut encode:  Vec<f64> = acc.samples.iter().map(|s| s.encode_ms).filter(|&v| v > 0.0).collect();
    let mut e2e:     Vec<f64> = acc.samples.iter().map(|s| s.e2e_ms).filter(|&v| v > 0.0).collect();
    let mut stall:   Vec<f64> = acc.samples.iter().map(|s| s.stall_ms).filter(|&v| v > 0.0).collect();
    let mut ipc_emit: Vec<f64> = acc.ipc_emit_samples_ms.iter().copied().filter(|&v| v > 0.0).collect();

    let duration = acc.session_start.elapsed().as_secs_f64();
    let actual_fps = if duration > 0.0 { acc.total_frames as f64 / duration } else { 0.0 };
    let drop_rate_pct = if acc.total_frames > 0 {
        acc.dropped_frames as f64 / acc.total_frames as f64 * 100.0
    } else { 0.0 };

    let app_version = option_env!("CARGO_PKG_VERSION")
        .unwrap_or("unknown")
        .to_string();

    Some(PerfReport {
        schema_version: 1,
        session_duration_s: duration,
        encoder: acc.encoder_name.clone(),
        source_id: acc.source_id.clone(),
        resolution: format!("{}x{}", acc.width, acc.height),
        target_fps: acc.target_fps,
        target_bitrate_bps: acc.target_bitrate,
        total_frames: acc.total_frames,
        dropped_frames: acc.dropped_frames,
        drop_rate_pct,
        sample_count: acc.samples.len(),
        acquire_interval_ms: TimingStat::from_values(&mut acquire),
        acquire_frame_ms: TimingStat::from_values(&mut acquire_frame),
        dxgi_lock_window_ms: TimingStat::from_values(&mut dxgi_lock_window),
        stage_frame_ms: TimingStat::from_values(&mut stage_frame),
        vp_nvenc_ms: TimingStat::from_values(&mut vp_nvenc),
        copy_ms: TimingStat::from_values(&mut copy),
        encode_ms: TimingStat::from_values(&mut encode),
        e2e_ms: TimingStat::from_values(&mut e2e),
        stall_ms: TimingStat::from_values(&mut stall),
        ipc_emit_ms: TimingStat::from_values(&mut ipc_emit),
        actual_fps,
        app_version,
    })
}

/// Called from the capture thread right before acquiring a frame.
/// Returns the interval since the last frame was acquired.
pub fn tick() -> f64 {
    if let Ok(mut acc_guard) = PERF.lock() {
        if let Some(acc) = acc_guard.as_mut() {
            let now = std::time::Instant::now();
            let interval = now.duration_since(acc.last_tick).as_secs_f64() * 1000.0;
            acc.last_tick = now;
            return interval;
        }
    }
    0.0
}

/// Called from the main UI thread on a regular interval (e.g. `requestAnimationFrame`).
/// Returns the time elapsed since the last `tock()` call. A large value indicates
/// the main thread was stalled.
/// Not yet wired to a Tauri command — kept for future main-thread stall detection.
#[allow(dead_code)]
pub fn tock() -> f64 {
    if let Ok(mut last_tock_guard) = LAST_TOCK.lock() {
        if let Some(last_tock) = last_tock_guard.as_mut() {
            let now = Instant::now();
            let interval = now.duration_since(*last_tock).as_secs_f64() * 1000.0;
            *last_tock = now;
            return interval;
        }
    }
    0.0
}
