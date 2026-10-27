use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, StreamConfig};
use log::{error, info, warn};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::AudioDevice;
use super::opus_encode::OpusEncoder;
use super::resample::LinearResampler;
use super::vad::{VadShared, VoiceProcessor, FRAME};

/// Per-window meter/indicator data emitted as `specter://audio-level`.
pub struct LevelInfo {
    pub rms: f32,
    pub floor_rms: f32,
    pub vad: Option<f32>,
    pub gate: bool,
    pub speaking: bool,
    pub auto: bool,
}

/// Turns the resampled 48 kHz mono PCM stream into 20 ms windows, runs each
/// through voice activation (vad.rs), and encodes + hands off what it lets
/// through. Shared by every sample-format branch of the input callback.
struct Pipeline<F, L> {
    encoder: OpusEncoder,
    voice: VoiceProcessor,
    threshold: Arc<AtomicU32>,
    vad: Arc<VadShared>,
    on_frame: F,
    on_level: L,
}

impl<F, L> Pipeline<F, L>
where
    F: Fn(Vec<u8>, u64),
    L: Fn(LevelInfo),
{
    fn drain(&mut self, pcm_buf: &mut Vec<i16>) {
        while pcm_buf.len() >= FRAME {
            let f: Vec<i16> = pcm_buf.drain(..FRAME).collect();
            let thresh = f32::from_bits(self.threshold.load(Ordering::Relaxed));
            let out = self.voice.process(
                f,
                self.vad.mode(),
                thresh,
                self.vad.suppression(),
                self.vad.sensitivity(),
                Instant::now(),
            );
            (self.on_level)(LevelInfo {
                rms: out.rms,
                floor_rms: out.floor_rms,
                vad: out.vad,
                gate: out.gate,
                speaking: out.speaking,
                auto: out.mode == super::vad::VadMode::Auto,
            });
            // Oldest first: the pre-roll (if the gate just opened), then this window.
            for pcm in out.send {
                match self.encoder.encode(pcm) {
                    Ok(enc) => {
                        let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
                        (self.on_frame)(enc, ts);
                    }
                    Err(e) => warn!("Opus encode error: {}", e),
                }
            }
        }
    }
}

pub struct CaptureHandle {
    running: Arc<AtomicBool>,
    /// Held to keep the stream alive; dropped (stopping the stream) when `stop()` is called.
    _stream: cpal::Stream,
}

// cpal::Stream contains raw COM pointers on Windows and is therefore !Send.
// Safety: CaptureHandle is always accessed through a parking_lot::Mutex, so
// it is never actually moved between threads concurrently.
unsafe impl Send for CaptureHandle {}

impl CaptureHandle {
    pub fn stop(self) {
        self.running.store(false, Ordering::SeqCst);
        // _stream is dropped here, which stops the cpal stream.
    }
}

/// Return all available audio input devices.
pub fn list_input_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    host.input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| {
                    let name = d.name().ok()?;
                    Some(AudioDevice {
                        id: name.clone(),
                        name: name.clone(),
                        is_default: name == default_name,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Start capturing audio from `device_id` (or the system default), encode each 20 ms window to
/// Opus, and invoke `on_frame` with the encoded bytes and a Unix-millisecond timestamp.
/// `on_level` is invoked for every 20 ms window, whether or not it clears the send gate, with
/// the raw PCM RMS, the learned noise floor and the gate state — this feeds the live mic meter
/// and the local speaking indicators independent of transmit/encode outcome.
/// `threshold` (Manual mode) is a live-updatable (f32 bit-packed) RMS gate; `vad` holds the
/// live voice-activation mode/settings (see vad.rs). Windows the gate rejects are never encoded
/// or handed to `on_frame` at all, so a quiet mic transmits nothing rather than relying on a
/// downstream mixer to drop it.
pub fn start<F, L>(
    device_id: Option<String>,
    threshold: Arc<AtomicU32>,
    vad: Arc<VadShared>,
    on_frame: F,
    on_level: L,
) -> Result<CaptureHandle, String>
where
    F: Fn(Vec<u8>, u64) + Send + 'static,
    L: Fn(LevelInfo) + Send + 'static,
{
    let host = cpal::default_host();

    let device: Device = if let Some(ref id) = device_id {
        host.input_devices()
            .map_err(|e| format!("Failed to enumerate devices: {}", e))?
            .find(|d| d.name().map(|n| n == *id).unwrap_or(false))
            .ok_or_else(|| format!("Device '{}' not found", id))?
    } else {
        host.default_input_device()
            .ok_or("No default input device")?
    };

    let device_name = device.name().unwrap_or_else(|_| "Unknown".into());
    info!("Starting capture on device: {}", device_name);

    // Collect all configs that support 48 kHz, then pick the best format.
    // Format priority: F32 > I16 > I32 > other.
    // This avoids the I32 >> 16 truncation bug on virtual audio devices
    // (VoiceMeeter, VAC, etc.) that deliver 16-bit samples in an I32 container —
    // shifting those samples right by 16 produces all-zeros → RMS = 0 → noise gate
    // silences everything.  F32 handles any bit depth correctly.
    let supported_configs: Vec<_> = device.supported_input_configs()
        .map_err(|e| format!("Failed to query configs: {}", e))?
        .filter(|c| c.min_sample_rate().0 <= 48_000 && c.max_sample_rate().0 >= 48_000)
        .collect();

    fn format_priority(f: cpal::SampleFormat) -> u8 {
        match f {
            cpal::SampleFormat::F32 => 0,
            cpal::SampleFormat::I16 => 1,
            cpal::SampleFormat::I32 => 2,
            _ => 3,
        }
    }

    let best_config_range = supported_configs
        .into_iter()
        .min_by_key(|c| format_priority(c.sample_format()));

    let supported_config = match best_config_range {
        Some(range) => range.with_sample_rate(cpal::SampleRate(48_000)),
        None => device
            .default_input_config()
            .map_err(|e| format!("No usable input config found: {}", e))?,
    };

    let sample_format = supported_config.sample_format();
    let config: StreamConfig = supported_config.into();
    let channels = config.channels as usize;
    let actual_rate = config.sample_rate.0;

    info!("Selected input config: {:?}", config);
    super::write_audio_log(&format!(
        "capture: device='{}' format={:?} rate={}Hz channels={}",
        device_name, sample_format, actual_rate, channels
    ));

    // Devices that don't offer any config spanning 48 kHz (the `filter` above)
    // fall back to `default_input_config()`, which can hand back a different
    // native rate (seen on some USB/virtual-mixer devices whose mic side is
    // fixed at 16 kHz or 44.1 kHz even though playback goes up to 48 kHz).
    // Everything downstream — the Opus encoder and the 960-samples-is-20ms
    // framing below — assumes 48 kHz. Without correcting for a different
    // actual rate here, that mismatch encodes/timestamps audio as if it were
    // faster than it really is, so every listener hears this one sender
    // pitched up and sped up (a real report: 16 kHz -> 48 kHz is a 3x
    // "chipmunk" speedup). Resampling to 48 kHz here keeps that assumption
    // true regardless of what the device actually delivers.
    if actual_rate != 48_000 {
        warn!(
            "Input device '{}' captured at {} Hz, not 48000 Hz — resampling to 48 kHz before encoding.",
            device_name, actual_rate
        );
        super::write_audio_log(&format!(
            "capture: RESAMPLING ENGAGED {}Hz -> 48000Hz for device '{}'",
            actual_rate, device_name
        ));
    } else {
        super::write_audio_log("capture: device native rate is already 48000Hz, no resampling needed");
    }
    let mut resampler = (actual_rate != 48_000).then(|| LinearResampler::new(actual_rate, 48_000));

    // Opus encoder: 48 kHz, mono, 20 ms = 960 samples per frame.
    let encoder = OpusEncoder::new(48_000, 1, 960)
        .map_err(|e| format!("Opus encoder init failed: {}", e))?;
    // Only one sample-format arm below runs; each moves the pipeline in.
    let mut pipeline = Pipeline { encoder, voice: VoiceProcessor::new(), threshold, vad, on_frame, on_level };

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    // Rolling accumulation buffer for assembling 20 ms PCM frames.
    let mut pcm_buf: Vec<i16> = Vec::with_capacity(960);

    let err_fn = move |err| {
        error!("Audio capture error: {}", err);
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let mut mixed_buf: Vec<i16> = Vec::new();
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    mixed_buf.clear();
                    for frame in data.chunks(channels) {
                        let sum: f32 = frame.iter().sum();
                        let mixed = sum / (channels as f32);
                        let s = (mixed * 32_767.0).clamp(-32_768.0, 32_767.0) as i16;
                        mixed_buf.push(s);
                    }
                    match resampler.as_mut() {
                        Some(r) => r.process(&mixed_buf, &mut pcm_buf),
                        None => pcm_buf.extend_from_slice(&mixed_buf),
                    }

                    pipeline.drain(&mut pcm_buf);
                },
                err_fn,
                None,
            )
        },
        cpal::SampleFormat::I16 => {
            let mut mixed_buf: Vec<i16> = Vec::new();
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    mixed_buf.clear();
                    for frame in data.chunks(channels) {
                        let sum: i32 = frame.iter().map(|&x| x as i32).sum();
                        let mixed = (sum / (channels as i32)) as i16;
                        mixed_buf.push(mixed);
                    }
                    match resampler.as_mut() {
                        Some(r) => r.process(&mixed_buf, &mut pcm_buf),
                        None => pcm_buf.extend_from_slice(&mixed_buf),
                    }

                    pipeline.drain(&mut pcm_buf);
                },
                err_fn,
                None,
            )
        },
        cpal::SampleFormat::I32 => {
            let mut mixed_buf: Vec<i16> = Vec::new();
            device.build_input_stream(
                &config,
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    mixed_buf.clear();
                    for frame in data.chunks(channels) {
                        // Average channels then scale i32 → i16 by dropping the low 16 bits.
                        let sum: i64 = frame.iter().map(|&x| x as i64).sum();
                        let mixed = (sum / (channels as i64)) as i32;
                        let s = (mixed >> 16) as i16;
                        mixed_buf.push(s);
                    }
                    match resampler.as_mut() {
                        Some(r) => r.process(&mixed_buf, &mut pcm_buf),
                        None => pcm_buf.extend_from_slice(&mixed_buf),
                    }

                    pipeline.drain(&mut pcm_buf);
                },
                err_fn,
                None,
            )
        },
        cpal::SampleFormat::U8 => {
            let mut mixed_buf: Vec<i16> = Vec::new();
            device.build_input_stream(
                &config,
                move |data: &[u8], _: &cpal::InputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    mixed_buf.clear();
                    for frame in data.chunks(channels) {
                        let sum: f32 = frame.iter().map(|&x| (x as f32 - 128.0) / 128.0).sum();
                        let mixed = sum / (channels as f32);
                        let s = (mixed * 32_767.0).clamp(-32_768.0, 32_767.0) as i16;
                        mixed_buf.push(s);
                    }
                    match resampler.as_mut() {
                        Some(r) => r.process(&mixed_buf, &mut pcm_buf),
                        None => pcm_buf.extend_from_slice(&mixed_buf),
                    }

                    pipeline.drain(&mut pcm_buf);
                },
                err_fn,
                None,
            )
        },
        _ => return Err(format!("Unsupported device sample format: {:?}", sample_format)),
    }.map_err(|e| format!("Failed to build input stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start stream: {}", e))?;

    Ok(CaptureHandle {
        running,
        _stream: stream,
    })
}
