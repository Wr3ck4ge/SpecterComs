use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Emitter, Manager, Runtime,
};
use base64::Engine;
use log::warn;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use parking_lot::Mutex;

mod capture;
mod loopback;
mod opus_encode;
mod playback;
mod resample;
mod share_audio;
mod tap;
mod vad;

use capture::CaptureHandle;
use vad::{Sensitivity, VadMode, VadShared};
use playback::{MixSources, PlaybackHandle};
use share_audio::{ShareAudioSender, SharePcmBuffer, ShareRxStream};

pub use loopback::qpc_now_ms;
pub use tap::{PcmChunk, PcmTap};

/// PCM tap of the screen-share audio being *sent*: 48 kHz stereo f32 in
/// 20 ms chunks, QPC-ms timestamps, exactly the frames that are Opus-encoded.
/// For the future Go Live / Twitch mixer (STREAMING_PLAN S4); no consumer
/// yet. `None` before the plugin is set up.
///
/// ```ignore
/// let rx = tauri_plugin_specter_audio::share_audio_pcm_tap(&app).unwrap().subscribe(50);
/// ```
pub fn share_audio_pcm_tap<R: Runtime, M: Manager<R>>(manager: &M) -> Option<Arc<PcmTap>> {
    manager.try_state::<AudioState>().map(|s| s.share_pcm_tap.clone())
}

/// PCM tap of the decoded voice-channel mix as it's played (48 kHz mono f32,
/// 20 ms chunks, every voice lane summed; share audio not included), for an
/// opt-in "voice channel on stream". Only produces data while playback is
/// running. Note this is the *mixed* signal: a per-member opt-out (plan's
/// Privacy section) would need a per-lane tap in `play_frame` instead.
pub fn voice_mix_pcm_tap<R: Runtime, M: Manager<R>>(manager: &M) -> Option<Arc<PcmTap>> {
    manager.try_state::<AudioState>().map(|s| s.voice_pcm_tap.clone())
}

/// Persistent log for the audio pipeline's device-selection/sample-rate
/// decisions — device name, negotiated sample rate, and whether the
/// resampler engaged for it. Nothing about mic/speaker device selection was
/// previously captured in any diagnostic report (the main app's
/// setup_errors.log / capture_breadcrumbs are the *screen*-capture module's,
/// a different crate entirely), so a report submitted while reproducing a
/// pitch/speed audio bug had literally nothing in it to confirm or rule out
/// a sample-rate mismatch. Written to %APPDATA%\specter-coms\audio_pipeline.log,
/// read back by get_audio_pipeline_log for DiagnosticsButton to bundle.
pub(crate) fn write_audio_log(msg: &str) {
    eprintln!("[audio] {msg}");
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = std::path::Path::new(&appdata).join("specter-coms");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("audio_pipeline.log");
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

/// Read back the audio pipeline log for diagnostics submission.
#[tauri::command]
fn get_audio_pipeline_log() -> Result<String, String> {
    let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
    let path = std::path::Path::new(&appdata).join("specter-coms").join("audio_pipeline.log");
    Ok(std::fs::read_to_string(&path).unwrap_or_default())
}

/// Per-stream jitter buffer: decoded PCM queue plus whether it currently has
/// enough buffered audio to be drained by the output callback. Without this,
/// playback starts consuming a stream's queue the instant its first frame
/// arrives, with no cushion for network/scheduling jitter — any timing
/// variance between arriving frames is an audible gap. `primed` gates
/// consumption: a stream must accumulate JITTER_PRIME_SAMPLES before it's
/// drained, and any underrun (queue runs dry while primed) re-triggers that
/// same buffering period rather than resuming on whatever partial audio
/// happens to be there. See playback.rs's output callback for the consumer
/// side of this.
pub struct StreamBuffer {
    queue: VecDeque<i16>,
    primed: bool,
    /// Per-stream listener gain (set_stream_volume), applied by the mixer on
    /// top of play_frame's per-call `volume` (the channel volume / ducking).
    /// 1.0 = unity; always within 0.0..=MAX_STREAM_GAIN.
    gain: f32,
}

impl StreamBuffer {
    fn new() -> Self {
        Self::with_gain(1.0)
    }

    fn with_gain(gain: f32) -> Self {
        Self { queue: VecDeque::new(), primed: false, gain: clamp_stream_gain(gain) }
    }
}

/// Upper bound of a per-stream gain: 200 %.
/// +18 dB: the per-user slider's 200 % (web-portal engine/userVolume.js
/// laneGainForVolume). Boosted lanes are soft-limited in the mixer.
pub const MAX_STREAM_GAIN: f32 = 8.0;

/// Sanitize a requested per-stream gain: 0.0..=MAX_STREAM_GAIN, non-finite → unity.
pub fn clamp_stream_gain(gain: f32) -> f32 {
    if gain.is_finite() { gain.clamp(0.0, MAX_STREAM_GAIN) } else { 1.0 }
}

/// 60 ms at 48 kHz mono — matches the browser (non-Tauri) playback path's
/// proven 3-frame pre-buffer (see CommLink.jsx's drainJitterQueue), which
/// this native path never had despite being the one real desktop users
/// actually exercise.
const JITTER_PRIME_SAMPLES: usize = 2_880;

pub struct AudioState {
    capture: Mutex<Option<CaptureHandle>>,
    playback: Mutex<Option<PlaybackHandle>>,
    /// Per-stream PCM jitter buffers: stream_id → queue + primed state.
    /// The cpal output callback mixes all active (primed) streams by summing samples.
    stream_queues: Arc<Mutex<HashMap<String, StreamBuffer>>>,
    /// Per-stream listener gains (set_stream_volume), stream_id → gain, kept
    /// apart from the buffers so a gain set before the first frame, or one
    /// that outlives clear_stream (a lane that comes back), still applies to
    /// the buffer created next. Only entries != 1.0 are kept. Lock order:
    /// stream_gains, then stream_queues (the output callback takes only the
    /// latter).
    stream_gains: Mutex<HashMap<String, f32>>,
    /// Per-stream Opus decoders: stream_id → Decoder.
    /// Each stream needs its own stateful decoder for correct PLC and continuity.
    stream_decoders: Mutex<HashMap<String, audiopus::coder::Decoder>>,
    /// Selected output device name. None = use system default.
    output_device_name: Mutex<Option<String>>,
    /// Live-updatable send-gate RMS threshold (f32 bit-packed), read every 20 ms
    /// capture window by whichever capture stream is currently running — see
    /// capture::should_send. Survives across start_capture/stop_capture calls so
    /// a threshold change made while the mic is on doesn't require restarting it.
    send_threshold: Arc<AtomicU32>,
    /// Live voice-activation mode (Auto adaptive / Manual threshold), noise
    /// suppression and Auto sensitivity — see vad.rs and set_vad_config. Same
    /// lifetime rules as send_threshold.
    vad: Arc<VadShared>,
    /// Running screen-share audio capture + encoder (share_audio_start).
    share_sender: Mutex<Option<ShareAudioSender>>,
    /// Per-sharer decoded share audio, drained by the playback mixer.
    share_queues: Arc<Mutex<HashMap<String, SharePcmBuffer>>>,
    /// Per-sharer packet ordering + Opus decoder (never touched by the
    /// output callback).
    share_streams: Mutex<HashMap<String, ShareRxStream>>,
    share_pcm_tap: Arc<PcmTap>,
    voice_pcm_tap: Arc<PcmTap>,
}

impl AudioState {
    fn mix_sources(&self) -> MixSources {
        MixSources {
            voice: self.stream_queues.clone(),
            share: self.share_queues.clone(),
            voice_tap: self.voice_pcm_tap.clone(),
        }
    }

    /// Start the cpal output stream if it isn't running yet (play_frame and
    /// share_audio_play_frame both start it lazily).
    fn ensure_playback(&self) -> Result<(), String> {
        let mut playback_lock = self.playback.lock();
        if playback_lock.is_none() {
            let dev_name = self.output_device_name.lock().clone();
            let handle = match playback::start(self.mix_sources(), dev_name.as_deref()) {
                Ok(h) => h,
                Err(e) => {
                    // Saved output devices can become stale across updates/reboots.
                    // Fall back to the system default device so audio still works.
                    warn!(
                        "[Audio] playback init failed on selected device {:?}: {}. Falling back to default output.",
                        dev_name,
                        e
                    );
                    *self.output_device_name.lock() = None;
                    playback::start(self.mix_sources(), None)
                        .map_err(|e2| format!("Failed to start playback (default fallback): {}", e2))?
                }
            };
            *playback_lock = Some(handle);
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Event payload emitted to the webview on each encoded Opus frame.
#[derive(Clone, Serialize)]
pub struct AudioFrameEvent {
    /// Base64-encoded Opus frame bytes.
    pub data: String,
    /// Unix timestamp in milliseconds.
    pub timestamp: u64,
}

/// Event payload emitted on every 20 ms capture window with the raw PCM RMS,
/// independent of whether that window cleared the noise gate — drives a live
/// mic-level meter in the UI. `rms` keeps its old meaning; the rest is the
/// voice-activation view of the same window (see vad.rs).
#[derive(Clone, Serialize)]
pub struct AudioLevelEvent {
    pub rms: f32,
    /// Learned background level, same i16-RMS scale as `rms`.
    pub floor: f32,
    /// RNNoise voice probability 0..1 (Auto mode only).
    pub vad: Option<f32>,
    /// Whether this window was transmitted.
    pub gate: bool,
    /// What local speaking indicators should show (Manual: rms >= threshold,
    /// exactly the old client-side rule; Auto: gate).
    pub speaking: bool,
    /// "auto" | "manual"
    pub mode: &'static str,
}

/// List available audio input devices.
#[tauri::command]
fn list_audio_devices() -> Vec<AudioDevice> {
    capture::list_input_devices()
}

/// List available audio output devices.
#[tauri::command]
fn list_output_devices() -> Vec<AudioDevice> {
    playback::list_output_devices()
}

/// Start capturing from the specified device (or the system default if `device_id` is `None`).
/// Encodes 20 ms PCM frames to Opus and emits `specter://audio-frame` events to the webview.
/// If a capture is already running it is stopped first so this is always safe to call.
#[tauri::command]
fn start_capture<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AudioState>,
    device_id: Option<String>,
) -> Result<(), String> {
    let mut capture_lock = state.capture.lock();
    // Stop any existing capture before starting a new one so repeated calls always succeed.
    if let Some(old_handle) = capture_lock.take() {
        old_handle.stop();
    }

    let level_app = app.clone();
    let handle = capture::start(
        device_id,
        state.send_threshold.clone(),
        state.vad.clone(),
        move |opus_frame, timestamp| {
            let event = AudioFrameEvent {
                data: base64::engine::general_purpose::STANDARD.encode(&opus_frame),
                timestamp,
            };
            let _ = app.emit("specter://audio-frame", &event);
        },
        move |l: capture::LevelInfo| {
            let _ = level_app.emit("specter://audio-level", &AudioLevelEvent {
                rms: l.rms,
                floor: l.floor_rms,
                vad: l.vad,
                gate: l.gate,
                speaking: l.speaking,
                mode: if l.auto { "auto" } else { "manual" },
            });
        },
    )
    .map_err(|e| format!("Failed to start capture: {}", e))?;

    *capture_lock = Some(handle);
    Ok(())
}

/// Stop the active capture stream.
#[tauri::command]
fn stop_capture(state: tauri::State<'_, AudioState>) -> Result<(), String> {
    let mut capture_lock = state.capture.lock();
    if let Some(handle) = capture_lock.take() {
        handle.stop();
    }
    Ok(())
}

/// Decode an Opus frame (base64-encoded) and queue the PCM for playback via cpal.
/// The playback output stream is started lazily on the first call.
///
/// - `volume`    — linear gain scalar (1.0 = 100%, 0.3 = 30%). Defaults to 1.0.
/// - `stream_id` — unique identifier for this audio source (e.g. channel UUID).
///                 Each stream gets its own Opus decoder and PCM queue so that
///                 the output callback can mix them simultaneously.
///                 Defaults to "default" (backward-compatible single-stream mode).
#[tauri::command]
fn play_frame(
    state: tauri::State<'_, AudioState>,
    data: String,
    volume: Option<f32>,
    stream_id: Option<String>,
) -> Result<(), String> {
    let sid = stream_id.unwrap_or_else(|| "default".to_string());

    let opus_bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    // Lazy-init the cpal output stream.
    state.ensure_playback()?;

    // Decode using this stream's dedicated Opus decoder.
    let pcm = {
        let mut decoders = state.stream_decoders.lock();
        if !decoders.contains_key(&sid) {
            let dec = audiopus::coder::Decoder::new(
                audiopus::SampleRate::Hz48000,
                audiopus::Channels::Mono,
            )
            .map_err(|e| format!("Failed to create Opus decoder for stream '{}': {:?}", sid, e))?;
            decoders.insert(sid.clone(), dec);
        }
        let decoder = decoders.get_mut(&sid).unwrap();

        let mut output = vec![0i16; 960]; // 20 ms at 48 kHz mono
        let n = {
            let packet = audiopus::packet::Packet::try_from(opus_bytes.as_slice())
                .map_err(|e| format!("Invalid Opus packet: {:?}", e))?;
            let signals = audiopus::MutSignals::try_from(output.as_mut_slice())
                .map_err(|e| format!("MutSignals error: {:?}", e))?;
            decoder
                .decode(Some(packet), signals, false)
                .map_err(|e| format!("Opus decode failed: {:?}", e))?
        };
        output[..n].to_vec()
    };

    // Apply volume scaling before queuing.
    let vol = volume.unwrap_or(1.0).clamp(0.0, 4.0);
    let scaled: Vec<i16> = if (vol - 1.0).abs() < 0.001 {
        pcm
    } else {
        // A boost ("Everyone's volume" above 100 %) is soft-limited like a
        // per-user boost (playback::soft_limit) instead of hard-clipping.
        let boost = vol > 1.0;
        pcm.iter().map(|&s| {
            if boost {
                playback::soft_limit(s as f32 * vol).clamp(i16::MIN as i32, i16::MAX as i32) as i16
            } else {
                (s as f32 * vol).clamp(i16::MIN as f32, i16::MAX as f32) as i16
            }
        }).collect()
    };

    // Push into this stream's dedicated jitter buffer. The output callback mixes
    // every primed stream. Cap each stream at ~80 ms (3 840 samples = 4 frames) to
    // prevent lag accumulation. Clock drift between the server and the local cpal
    // clock (~0.1–0.3%) causes the queue to grow by a few ms per second. A tight
    // cap trims stale audio before the latency becomes perceptible, at the cost of
    // a brief click on overflow — which only happens when the queue is already
    // hundreds of ms behind real time.
    // A new lane starts with whatever gain set_stream_volume stored for it
    // (gains before queues: see AudioState::stream_gains).
    let gains = state.stream_gains.lock();
    let mut queues = state.stream_queues.lock();
    let stream_buf = queues
        .entry(sid)
        .or_insert_with_key(|k| StreamBuffer::with_gain(gains.get(k).copied().unwrap_or(1.0)));
    drop(gains);
    stream_buf.queue.extend(scaled.iter().copied());
    while stream_buf.queue.len() > 3_840 {
        stream_buf.queue.pop_front();
    }
    if !stream_buf.primed && stream_buf.queue.len() >= JITTER_PRIME_SAMPLES {
        stream_buf.primed = true;
    }

    Ok(())
}

/// Drop a stream's Opus decoder and PCM queue when its connection actually ends
/// (leaving a channel, or a monitor channel closing). Without this, the decoder
/// for a given stream_id (channel UUID) lives forever in `stream_decoders` — a
/// long gap between the last packet and a much-later reconnect (e.g. leaving
/// voice, waiting several minutes, then rejoining) resumes decoding on a stale
/// decoder instance instead of a fresh one, which can produce persistent
/// distortion that survives a full disconnect/reconnect cycle. Safe to call for
/// a stream_id that was never used (no-op).
#[tauri::command]
fn clear_stream(state: tauri::State<'_, AudioState>, stream_id: String) -> Result<(), String> {
    state.stream_decoders.lock().remove(&stream_id);
    state.stream_queues.lock().remove(&stream_id);
    // The lane's gain (stream_gains) is kept on purpose: the JS side keys it
    // by user and re-sends it whenever a lane's speaker changes, so a lane
    // that comes back for the same speaker keeps its volume.
    Ok(())
}

/// Store `volume` as `gains[stream_id]` (unity removes the entry) and apply it
/// to the live buffer if there is one. Returns the clamped gain.
fn apply_stream_gain(
    gains: &mut HashMap<String, f32>,
    queues: &mut HashMap<String, StreamBuffer>,
    stream_id: &str,
    volume: f32,
) -> f32 {
    let g = clamp_stream_gain(volume);
    if (g - 1.0).abs() < f32::EPSILON {
        gains.remove(stream_id);
    } else {
        gains.insert(stream_id.to_string(), g);
    }
    if let Some(buf) = queues.get_mut(stream_id) {
        buf.gain = g;
    }
    g
}

/// Per-voice-stream listener volume, 0.0..=MAX_STREAM_GAIN (1.0 = unity), for this device
/// only ("this user's voice, for me"). Applied in the output mixer on top of
/// play_frame's per-call `volume` (channel volume, ducking). May be called
/// before the stream's first frame and survives clear_stream; see
/// AudioState::stream_gains.
#[tauri::command]
fn set_stream_volume(state: tauri::State<'_, AudioState>, stream_id: String, volume: f32) -> Result<(), String> {
    let mut gains = state.stream_gains.lock();
    let mut queues = state.stream_queues.lock();
    apply_stream_gain(&mut gains, &mut queues, &stream_id, volume);
    Ok(())
}

/// Update the live send-gate RMS threshold (see `AudioState::send_threshold`).
/// Safe to call whether or not a capture stream is currently running — a
/// running stream picks up the new value on its very next 20 ms window; a
/// future start_capture picks it up immediately since it reads the same cell.
#[tauri::command]
fn set_send_threshold(state: tauri::State<'_, AudioState>, value: f32) -> Result<(), String> {
    state.send_threshold.store(value.to_bits(), Ordering::Relaxed);
    Ok(())
}

/// Update the live voice-activation config (see `AudioState::vad`).
/// `mode`: "auto" (adaptive noise floor + RNNoise voice detection) or
/// "manual" (the plain RMS threshold gate, unchanged). The client sends
/// "manual" for push-to-talk so PTT keeps its old behaviour. Like
/// set_send_threshold, a running capture picks it up on its next window.
#[tauri::command]
fn set_vad_config(
    state: tauri::State<'_, AudioState>,
    mode: String,
    noise_suppression: Option<bool>,
    sensitivity: Option<String>,
) -> Result<(), String> {
    let mode = if mode == "auto" { VadMode::Auto } else { VadMode::Manual };
    let sens = Sensitivity::parse(sensitivity.as_deref().unwrap_or("normal"));
    state.vad.set(mode, noise_suppression.unwrap_or(true), sens);
    Ok(())
}

/// Set the audio output device by name. Pass `None` to revert to the system default.
/// If playback is currently active, it is restarted on the new device immediately.
#[tauri::command]
fn set_output_device(
    state: tauri::State<'_, AudioState>,
    device_id: Option<String>,
) -> Result<(), String> {
    // Normalize: empty string treated as None (use default)
    let mut new_name = device_id.filter(|s| !s.is_empty() && s != "default");
    if let Some(name) = new_name.as_deref() {
        if !playback::has_output_device(name) {
            warn!(
                "[Audio] requested output device '{}' not found; using system default.",
                name
            );
            new_name = None;
        }
    }
    *state.output_device_name.lock() = new_name.clone();

    // If playback is already running, restart it on the new device.
    let mut playback_lock = state.playback.lock();
    if playback_lock.is_some() {
        // Drop the old stream (PlaybackHandle::stop is called via drop)
        *playback_lock = None;
        let handle = playback::start(state.mix_sources(), new_name.as_deref())
            .map_err(|e| format!("Failed to restart playback on new device: {}", e))?;
        *playback_lock = Some(handle);
    }
    Ok(())
}

// ── Screen-share audio ───────────────────────────────────────────────────────
// docs/STREAMING_PLAN_2026_10_29.md S1–S3. Sending: share_audio_start/stop
// plus the specter://share-audio-frame event. Receiving: share_audio_play_frame
// and friends, one independent stream per sharer (not a voice lane: no VAD,
// no voice-lane cap, own volume and target delay).

/// Event payload for `specter://share-audio-frame`: one Opus packet,
/// 20 ms of 48 kHz stereo. Same base64-over-IPC shape as capture-nal.
#[derive(Clone, Serialize)]
pub struct ShareAudioFrameEvent {
    pub data_b64: String,
    /// QPC milliseconds of the frame's first sample (video NAL timebase).
    pub timestamp_ms: u64,
    pub duration_ms: u32,
    /// Increments by one per 20 ms frame from 0 at each share_audio_start,
    /// including frames dropped locally, so receivers conceal gaps.
    pub seq: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareAudioStartResult {
    /// "process_include" | "process_exclude" | "device_loopback"
    pub mode: &'static str,
    /// True in device_loopback mode: SpecterComs' own output (voice, share
    /// playback) is captured too, so the UI should warn.
    pub echo_risk: bool,
}

/// Start capturing + encoding share audio for the capture source being
/// shared (`window:<hwnd>` → that app's process tree only; `monitor:N` →
/// everything except SpecterComs). Restarts cleanly if already running.
/// Async + spawn_blocking: activation waits on the audio service (and a
/// restart joins the old capture thread), which must not block the main thread.
#[tauri::command]
async fn share_audio_start<R: Runtime>(
    app: AppHandle<R>,
    source_id: String,
    bitrate_kbps: Option<u32>,
) -> Result<ShareAudioStartResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        let mut sender_lock = state.share_sender.lock();
        if let Some(old) = sender_lock.take() {
            old.stop();
        }
        let kbps = share_audio::clamp_bitrate_kbps(bitrate_kbps);
        let emit_app = app.clone();
        let sender = share_audio::start_sender(&source_id, kbps, state.share_pcm_tap.clone(), move |f| {
            let _ = emit_app.emit(
                "specter://share-audio-frame",
                &ShareAudioFrameEvent {
                    data_b64: base64::engine::general_purpose::STANDARD.encode(&f.data),
                    timestamp_ms: f.timestamp_ms,
                    duration_ms: share_audio::FRAME_MS,
                    seq: f.seq,
                },
            );
        })?;
        let mode = sender.mode();
        write_audio_log(&format!(
            "share-audio: started source='{}' mode={} bitrate={}kbps",
            source_id,
            mode.as_str(),
            kbps
        ));
        *sender_lock = Some(sender);
        Ok(ShareAudioStartResult { mode: mode.as_str(), echo_risk: mode.echo_risk() })
    })
    .await
    .map_err(|e| format!("share_audio_start task failed: {e}"))?
}

/// Stop share-audio capture. Safe to call when nothing is running.
#[tauri::command]
async fn share_audio_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AudioState>();
        let old = state.share_sender.lock().take();
        if let Some(s) = old {
            s.stop();
        }
    })
    .await
    .map_err(|e| format!("share_audio_stop task failed: {e}"))
}

fn ensure_share_stream<'a>(
    streams: &'a mut HashMap<String, ShareRxStream>,
    sharer_id: &str,
) -> Result<&'a mut ShareRxStream, String> {
    if !streams.contains_key(sharer_id) {
        streams.insert(sharer_id.to_string(), ShareRxStream::new()?);
    }
    Ok(streams.get_mut(sharer_id).unwrap())
}

/// Queue one received share-audio packet from `sharer_id` for playback.
/// Packets are ordered by `seq`; late/duplicate ones are dropped, missing
/// ones concealed (Opus PLC). Playback starts lazily, like play_frame.
/// `timestamp_ms` (the sender's frame time) is used to measure arrival
/// jitter, which sets the jitter buffer's floor; A/V alignment on top is done
/// by the JS side via share_audio_set_delay.
#[tauri::command]
fn share_audio_play_frame(
    state: tauri::State<'_, AudioState>,
    sharer_id: String,
    data_b64: String,
    timestamp_ms: f64,
    seq: u64,
) -> Result<(), String> {
    let arrival_ms = loopback::qpc_now_ms();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;
    state.ensure_playback()?;

    // Decode under share_streams only; the output callback never takes that
    // lock, so it isn't held up by decoding. Lock order: share_streams, then
    // share_queues (same in share_audio_playback_stop).
    let mut streams = state.share_streams.lock();
    let rx = ensure_share_stream(&mut streams, &sharer_id)?;
    let mut pcm = Vec::new();
    let reset = rx.receive(seq, bytes, &mut pcm)?;
    if reset {
        rx.jitter.clear();
    }
    if timestamp_ms.is_finite() && timestamp_ms > 0.0 {
        rx.jitter_ms = rx.jitter.observe(arrival_ms, timestamp_ms);
    }
    let mut queues = state.share_queues.lock();
    let log_now = rx.packets % 500 == 1; // first packet, then every ~10 s
    let rx_summary = log_now.then(|| rx.summary());
    let buf = queues.entry(sharer_id.clone()).or_insert_with(SharePcmBuffer::new);
    if reset {
        buf.clear();
    }
    buf.set_jitter_ms(rx.jitter_ms);
    if !pcm.is_empty() {
        buf.push(&pcm);
    }
    if let Some(rx_summary) = rx_summary {
        write_audio_log(&format!("share-audio rx '{sharer_id}': {rx_summary} {}", buf.summary()));
    }
    Ok(())
}

/// Per-sharer share-audio volume, 0.0..=2.0 (1.0 = unity). Applies on the
/// next output callback; may be called before the first frame arrives.
#[tauri::command]
fn share_audio_set_volume(state: tauri::State<'_, AudioState>, sharer_id: String, volume: f32) -> Result<(), String> {
    let v = if volume.is_finite() { volume.clamp(0.0, 2.0) } else { 1.0 };
    state.share_queues.lock().entry(sharer_id).or_insert_with(SharePcmBuffer::new).volume = v;
    Ok(())
}

/// Per-sharer jitter-buffer target delay in ms (clamped 20..=1000, default
/// 80). Set it to roughly the video decode/render latency so audio lines up
/// with the picture. Raising it re-buffers once; lowering it drops the
/// excess immediately.
#[tauri::command]
fn share_audio_set_delay(state: tauri::State<'_, AudioState>, sharer_id: String, delay_ms: f64) -> Result<(), String> {
    // f64: JS will often pass a measured, fractional latency.
    let delay_ms = if delay_ms.is_finite() { delay_ms.round().clamp(0.0, u32::MAX as f64) as u32 } else { share_audio::DEFAULT_DELAY_MS };
    state
        .share_queues
        .lock()
        .entry(sharer_id)
        .or_insert_with(SharePcmBuffer::new)
        .set_delay_ms(delay_ms);
    Ok(())
}

/// Drop a sharer's share-audio stream (decoder, reorder state, buffered PCM
/// and volume/delay settings). Call when the share ends or the viewer stops
/// watching; a later frame starts a fresh stream. No-op for unknown ids.
#[tauri::command]
fn share_audio_playback_stop(state: tauri::State<'_, AudioState>, sharer_id: String) -> Result<(), String> {
    let mut streams = state.share_streams.lock();
    streams.remove(&sharer_id);
    state.share_queues.lock().remove(&sharer_id);
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("specter-audio")
        .invoke_handler(tauri::generate_handler![
            list_audio_devices,
            list_output_devices,
            start_capture,
            stop_capture,
            play_frame,
            clear_stream,
            set_stream_volume,
            set_output_device,
            set_send_threshold,
            set_vad_config,
            get_audio_pipeline_log,
            share_audio_start,
            share_audio_stop,
            share_audio_play_frame,
            share_audio_set_volume,
            share_audio_set_delay,
            share_audio_playback_stop,
        ])
        .setup(|app, _api| {
            app.manage(AudioState {
                capture: Mutex::new(None),
                playback: Mutex::new(None),
                stream_queues: Arc::new(Mutex::new(HashMap::new())),
                stream_gains: Mutex::new(HashMap::new()),
                stream_decoders: Mutex::new(HashMap::new()),
                output_device_name: Mutex::new(None),
                // 150.0 matches the client's default micThreshold (CommLink.jsx) and the
                // server mixer's old default user_audio_thresholds value — kept in sync
                // going forward via set_send_threshold, called whenever the user changes
                // the slider (see CommLink.jsx's handleMicThresholdChange).
                send_threshold: Arc::new(AtomicU32::new(150.0f32.to_bits())),
                vad: Arc::new(VadShared::default()),
                share_sender: Mutex::new(None),
                share_queues: Arc::new(Mutex::new(HashMap::new())),
                share_streams: Mutex::new(HashMap::new()),
                share_pcm_tap: Arc::new(PcmTap::new()),
                voice_pcm_tap: Arc::new(PcmTap::new()),
            });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod stream_gain_tests {
    use super::*;

    #[test]
    fn gain_set_before_the_first_frame_is_stored_and_clamped() {
        let mut gains = HashMap::new();
        let mut queues: HashMap<String, StreamBuffer> = HashMap::new();
        assert_eq!(apply_stream_gain(&mut gains, &mut queues, "ch:7", 3.5), 3.5);
        assert_eq!(apply_stream_gain(&mut gains, &mut queues, "ch:7", 12.0), MAX_STREAM_GAIN);
        assert_eq!(gains.get("ch:7"), Some(&MAX_STREAM_GAIN));
        assert!(queues.is_empty(), "no buffer is created by a volume change");
        assert_eq!(apply_stream_gain(&mut gains, &mut queues, "ch:7", -2.0), 0.0);
        assert_eq!(apply_stream_gain(&mut gains, &mut queues, "ch:7", f32::INFINITY), 1.0);
        assert!(gains.is_empty(), "unity is the default and isn't stored");
    }

    #[test]
    fn gain_applies_to_the_live_buffer_and_leaves_other_streams_alone() {
        let mut gains = HashMap::new();
        let mut queues = HashMap::new();
        queues.insert("a".to_string(), StreamBuffer::new());
        queues.insert("b".to_string(), StreamBuffer::new());
        apply_stream_gain(&mut gains, &mut queues, "a", 0.25);
        assert_eq!(queues["a"].gain, 0.25);
        assert_eq!(queues["b"].gain, 1.0);
        assert!(!gains.contains_key("b"));
    }
}
