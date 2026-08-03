use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, StreamConfig};
use log::{error, info, warn};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::AudioDevice;
use super::opus_encode::OpusEncoder;

/// How long a stream keeps transmitting after last clearing `threshold`, so a
/// brief mid-word RMS dip (soft consonant, breath pause) doesn't chop real
/// speech at the source — mirrors the server mixer's old VAD_HANGOVER_FRAMES
/// (10 frames @ 20 ms = 200 ms).
const SEND_GATE_HANGOVER: Duration = Duration::from_millis(200);

/// Whether this 20 ms window should be encoded and transmitted: true if its RMS
/// clears `threshold`, or if it's within `SEND_GATE_HANGOVER` of the last window
/// that did. Updates `last_above` as a side effect.
fn should_send(last_above: &mut Option<Instant>, threshold: f32, rms: f32) -> bool {
    if rms >= threshold {
        *last_above = Some(Instant::now());
        true
    } else {
        matches!(last_above, Some(t) if t.elapsed() < SEND_GATE_HANGOVER)
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
/// `on_level` is invoked with the raw PCM RMS of every 20 ms window, whether or not it clears
/// the send gate — this feeds a live mic-level meter independent of transmit/encode outcome.
/// `threshold` is a live-updatable (f32 bit-packed) RMS gate — frames below it (outside the
/// hangover window, see `should_send`) are never encoded or handed to `on_frame` at all, so a
/// quiet mic transmits nothing rather than relying on a downstream mixer to drop it.
pub fn start<F, L>(device_id: Option<String>, threshold: Arc<AtomicU32>, on_frame: F, on_level: L) -> Result<CaptureHandle, String>
where
    F: Fn(Vec<u8>, u64) + Send + 'static,
    L: Fn(f32) + Send + 'static,
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

    info!("Selected input config: {:?}", config);

    // Opus encoder: 48 kHz, mono, 20 ms = 960 samples per frame.
    let mut encoder = OpusEncoder::new(48_000, 1, 960)
        .map_err(|e| format!("Opus encoder init failed: {}", e))?;

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    // Rolling accumulation buffer for assembling 20 ms PCM frames.
    let mut pcm_buf: Vec<i16> = Vec::with_capacity(960);

    let err_fn = move |err| {
        error!("Audio capture error: {}", err);
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let threshold = threshold.clone();
            let mut last_above: Option<Instant> = None;
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    for frame in data.chunks(channels) {
                        let sum: f32 = frame.iter().sum();
                        let mixed = sum / (channels as f32);
                        let s = (mixed * 32_767.0).clamp(-32_768.0, 32_767.0) as i16;
                        pcm_buf.push(s);

                        if pcm_buf.len() >= 960 {
                            let f: Vec<i16> = pcm_buf.drain(..960).collect();
                            let rms = (f.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / 960.0).sqrt();
                            on_level(rms as f32);
                            let thresh = f32::from_bits(threshold.load(Ordering::Relaxed));
                            if !should_send(&mut last_above, thresh, rms as f32) { continue; }
                            match encoder.encode(&f) {
                                Ok(enc) => {
                                    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
                                    on_frame(enc, ts);
                                }
                                Err(e) => warn!("Opus encode error: {}", e),
                            }
                        }
                    }
                },
                err_fn,
                None,
            )
        },
        cpal::SampleFormat::I16 => {
            let threshold = threshold.clone();
            let mut last_above: Option<Instant> = None;
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    for frame in data.chunks(channels) {
                        let sum: i32 = frame.iter().map(|&x| x as i32).sum();
                        let mixed = (sum / (channels as i32)) as i16;
                        pcm_buf.push(mixed);

                        if pcm_buf.len() >= 960 {
                            let f: Vec<i16> = pcm_buf.drain(..960).collect();
                            let rms = (f.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / 960.0).sqrt();
                            on_level(rms as f32);
                            let thresh = f32::from_bits(threshold.load(Ordering::Relaxed));
                            if !should_send(&mut last_above, thresh, rms as f32) { continue; }
                            match encoder.encode(&f) {
                                Ok(enc) => {
                                    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
                                    on_frame(enc, ts);
                                }
                                Err(e) => warn!("Opus encode error: {}", e),
                            }
                        }
                    }
                },
                err_fn,
                None,
            )
        },
        cpal::SampleFormat::I32 => {
            let threshold = threshold.clone();
            let mut last_above: Option<Instant> = None;
            device.build_input_stream(
                &config,
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    for frame in data.chunks(channels) {
                        // Average channels then scale i32 → i16 by dropping the low 16 bits.
                        let sum: i64 = frame.iter().map(|&x| x as i64).sum();
                        let mixed = (sum / (channels as i64)) as i32;
                        let s = (mixed >> 16) as i16;
                        pcm_buf.push(s);

                        if pcm_buf.len() >= 960 {
                            let f: Vec<i16> = pcm_buf.drain(..960).collect();
                            let rms = (f.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / 960.0).sqrt();
                            on_level(rms as f32);
                            let thresh = f32::from_bits(threshold.load(Ordering::Relaxed));
                            if !should_send(&mut last_above, thresh, rms as f32) { continue; }
                            match encoder.encode(&f) {
                                Ok(enc) => {
                                    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
                                    on_frame(enc, ts);
                                }
                                Err(e) => warn!("Opus encode error: {}", e),
                            }
                        }
                    }
                },
                err_fn,
                None,
            )
        },
        cpal::SampleFormat::U8 => {
            let threshold = threshold.clone();
            let mut last_above: Option<Instant> = None;
            device.build_input_stream(
                &config,
                move |data: &[u8], _: &cpal::InputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    for frame in data.chunks(channels) {
                        let sum: f32 = frame.iter().map(|&x| (x as f32 - 128.0) / 128.0).sum();
                        let mixed = sum / (channels as f32);
                        let s = (mixed * 32_767.0).clamp(-32_768.0, 32_767.0) as i16;
                        pcm_buf.push(s);

                        if pcm_buf.len() >= 960 {
                            let f: Vec<i16> = pcm_buf.drain(..960).collect();
                            let rms = (f.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / 960.0).sqrt();
                            on_level(rms as f32);
                            let thresh = f32::from_bits(threshold.load(Ordering::Relaxed));
                            if !should_send(&mut last_above, thresh, rms as f32) { continue; }
                            match encoder.encode(&f) {
                                Ok(enc) => {
                                    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
                                    on_frame(enc, ts);
                                }
                                Err(e) => warn!("Opus encode error: {}", e),
                            }
                        }
                    }
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
