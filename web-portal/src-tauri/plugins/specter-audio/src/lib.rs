use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Emitter, Manager, Runtime,
};
use base64::Engine;
use log::warn;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use parking_lot::Mutex;

mod capture;
mod opus_encode;
mod playback;

use capture::CaptureHandle;
use playback::PlaybackHandle;

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
}

impl StreamBuffer {
    fn new() -> Self {
        Self { queue: VecDeque::new(), primed: false }
    }
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
    /// Per-stream Opus decoders: stream_id → Decoder.
    /// Each stream needs its own stateful decoder for correct PLC and continuity.
    stream_decoders: Mutex<HashMap<String, audiopus::coder::Decoder>>,
    /// Selected output device name. None = use system default.
    output_device_name: Mutex<Option<String>>,
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
/// mic-level meter in the UI.
#[derive(Clone, Serialize)]
pub struct AudioLevelEvent {
    pub rms: f32,
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
        move |opus_frame, timestamp| {
            let event = AudioFrameEvent {
                data: base64::engine::general_purpose::STANDARD.encode(&opus_frame),
                timestamp,
            };
            let _ = app.emit("specter://audio-frame", &event);
        },
        move |rms| {
            let _ = level_app.emit("specter://audio-level", &AudioLevelEvent { rms });
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
    {
        let mut playback_lock = state.playback.lock();
        if playback_lock.is_none() {
            let dev_name = state.output_device_name.lock().clone();
            let handle = match playback::start(state.stream_queues.clone(), dev_name.as_deref()) {
                Ok(h) => h,
                Err(e) => {
                    // Saved output devices can become stale across updates/reboots.
                    // Fall back to the system default device so audio still works.
                    warn!(
                        "[Audio] playback init failed on selected device {:?}: {}. Falling back to default output.",
                        dev_name,
                        e
                    );
                    *state.output_device_name.lock() = None;
                    playback::start(state.stream_queues.clone(), None)
                        .map_err(|e2| format!("Failed to start playback (default fallback): {}", e2))?
                }
            };
            *playback_lock = Some(handle);
        }
    }

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
        pcm.iter().map(|&s| {
            (s as f32 * vol).clamp(i16::MIN as f32, i16::MAX as f32) as i16
        }).collect()
    };

    // Push into this stream's dedicated jitter buffer. The output callback mixes
    // every primed stream. Cap each stream at ~80 ms (3 840 samples = 4 frames) to
    // prevent lag accumulation. Clock drift between the server and the local cpal
    // clock (~0.1–0.3%) causes the queue to grow by a few ms per second. A tight
    // cap trims stale audio before the latency becomes perceptible, at the cost of
    // a brief click on overflow — which only happens when the queue is already
    // hundreds of ms behind real time.
    let mut queues = state.stream_queues.lock();
    let stream_buf = queues.entry(sid).or_insert_with(StreamBuffer::new);
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
        let handle = playback::start(state.stream_queues.clone(), new_name.as_deref())
            .map_err(|e| format!("Failed to restart playback on new device: {}", e))?;
        *playback_lock = Some(handle);
    }
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
            set_output_device,
        ])
        .setup(|app, _api| {
            app.manage(AudioState {
                capture: Mutex::new(None),
                playback: Mutex::new(None),
                stream_queues: Arc::new(Mutex::new(HashMap::new())),
                stream_decoders: Mutex::new(HashMap::new()),
                output_device_name: Mutex::new(None),
            });
            Ok(())
        })
        .build()
}
