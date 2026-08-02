use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use log::{error, info, warn};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use parking_lot::Mutex;

use super::{AudioDevice, StreamBuffer};

/// Pop one sample from a stream's jitter buffer for this callback tick, if
/// it's currently primed. An underrun while primed (queue ran dry) drops the
/// stream back to unprimed so it re-buffers JITTER_PRIME_SAMPLES before
/// contributing audio again, instead of resuming on whatever trickles in —
/// resuming too eagerly is exactly what produces audible stutter under jitter.
fn pop_primed(buf: &mut StreamBuffer) -> Option<i16> {
    if !buf.primed {
        return None;
    }
    match buf.queue.pop_front() {
        Some(s) => Some(s),
        None => {
            buf.primed = false;
            None
        }
    }
}

#[allow(dead_code)]
pub struct PlaybackHandle {
    running: Arc<AtomicBool>,
    /// Held to keep the stream alive; dropped (stopping the stream) when `stop()` is called.
    _stream: cpal::Stream,
}

// cpal::Stream contains raw COM pointers on Windows and is therefore !Send.
// Safety: PlaybackHandle is always accessed through a parking_lot::Mutex, so
// it is never actually moved between threads concurrently.
unsafe impl Send for PlaybackHandle {}

#[allow(dead_code)]
impl PlaybackHandle {
    pub fn stop(self) {
        self.running.store(false, Ordering::SeqCst);
    }
}

/// Start a cpal output stream that mixes all active per-stream jitter buffers.
///
/// Each entry in `stream_queues` holds a per-stream jitter buffer (mono i16
/// samples at 48 kHz plus a "primed" flag) for one audio source (CommLink,
/// monitor channel, etc.). The output callback pops one sample from every
/// currently-primed stream per frame and sums them, allowing multiple streams
/// to play simultaneously at their independently-scaled volumes. Silence
/// (0.0) is contributed by any stream that isn't primed yet (still
/// buffering) or whose queue is empty. If the device uses multi-channel
/// output, the mixed mono sample is duplicated to every channel.
///
/// If `device_name` is `Some(name)`, the named device is used; otherwise the
/// system default output device is used.
pub fn start(stream_queues: Arc<Mutex<HashMap<String, StreamBuffer>>>, device_name: Option<&str>) -> Result<PlaybackHandle, String> {
    let host = cpal::default_host();
    let device = if let Some(name) = device_name {
        host.output_devices()
            .map_err(|e| format!("Failed to enumerate output devices: {}", e))?
            .find(|d| d.name().map(|n| n == name).unwrap_or(false))
            .ok_or_else(|| format!("Output device '{}' not found — falling back to default would be wrong, check device name", name))?
    } else {
        host.default_output_device()
            .ok_or("No default output device")?
    };

    let device_name = device.name().unwrap_or_else(|_| "Unknown".into());
    info!("Starting playback on device: {}", device_name);

    // Use the device's preferred sample rate and channel count so we don't
    // need to negotiate; mono PCM is duplicated to fill extra channels.
    let supported = device
        .default_output_config()
        .map_err(|e| format!("Failed to get output config: {}", e))?;

    let channels = supported.channels() as usize;

    // Force 48 kHz to match the Opus decoder output rate. Using the device
    // native rate (e.g. 44100 or 96000 Hz) causes the queue to drain at the
    // wrong speed: 96 kHz drains 2× faster than frames arrive → constant
    // underrun → crackling/static. 48 kHz is universally supported on
    // Windows WASAPI, macOS CoreAudio, and Linux ALSA/PulseAudio.
    let target_rate = cpal::SampleRate(48_000);
    let supports_48k = device
        .supported_output_configs()
        .map(|mut configs| configs.any(|c| {
            c.channels() == supported.channels()
                && c.min_sample_rate() <= target_rate
                && target_rate <= c.max_sample_rate()
        }))
        .unwrap_or(false);

    let sample_rate = if supports_48k {
        target_rate
    } else {
        warn!(
            "Device does not support 48 kHz output — falling back to device default {} Hz. \
             Audio may be choppy if rate != 48000.",
            supported.sample_rate().0
        );
        supported.sample_rate()
    };

    let config = StreamConfig {
        channels: supported.channels(),
        sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();
    let running_clone_2 = running.clone();
    let stream_queues_i16 = stream_queues.clone();

    let sample_format = supported.sample_format();

    let err_fn = move |err| {
        error!("Audio playback error: {}", err);
    };

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            device.build_output_stream(
                &config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    if !running_clone.load(Ordering::Relaxed) {
                        for s in data.iter_mut() { *s = 0.0; }
                        return;
                    }
                    let mut queues = stream_queues.lock();
                    let frame_count = data.len() / channels;
                    for frame in 0..frame_count {
                        // Sum one sample from every active stream for this time position.
                        let mut mixed = 0.0f32;
                        for q in queues.values_mut() {
                            if let Some(s) = pop_primed(q) {
                                mixed += s as f32 / 32_767.0;
                            }
                        }
                        let clipped = mixed.clamp(-1.0, 1.0);
                        for ch in 0..channels {
                            data[frame * channels + ch] = clipped;
                        }
                    }
                },
                err_fn,
                None,
            )
        },
        cpal::SampleFormat::I16 => {
            device.build_output_stream(
                &config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    if !running_clone_2.load(Ordering::Relaxed) {
                        for s in data.iter_mut() { *s = 0; }
                        return;
                    }
                    let mut queues = stream_queues_i16.lock();
                    let frame_count = data.len() / channels;
                    for frame in 0..frame_count {
                        let mut mixed = 0i32;
                        for q in queues.values_mut() {
                            if let Some(s) = pop_primed(q) {
                                mixed += s as i32;
                            }
                        }
                        let clipped = mixed.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                        for ch in 0..channels {
                            data[frame * channels + ch] = clipped;
                        }
                    }
                },
                err_fn,
                None,
            )
        },
        cpal::SampleFormat::I32 => {
            device.build_output_stream(
                &config,
                move |data: &mut [i32], _: &cpal::OutputCallbackInfo| {
                    if !running_clone_2.load(Ordering::Relaxed) {
                        for s in data.iter_mut() { *s = 0; }
                        return;
                    }
                    let mut queues = stream_queues_i16.lock();
                    let frame_count = data.len() / channels;
                    for frame in 0..frame_count {
                        let mut mixed = 0i32;
                        for q in queues.values_mut() {
                            if let Some(s) = pop_primed(q) {
                                mixed += s as i32;
                            }
                        }
                        let clipped = mixed.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
                        // Scale i16 range to i32 range for the device.
                        let expanded = (clipped as i32) << 16;
                        for ch in 0..channels {
                            data[frame * channels + ch] = expanded;
                        }
                    }
                },
                err_fn,
                None,
            )
        },
        _ => return Err(format!("Unsupported device sample format: {:?}", sample_format)),
    }.map_err(|e| format!("Failed to build output stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start playback stream: {}", e))?;

    Ok(PlaybackHandle {
        running,
        _stream: stream,
    })
}

/// Returns true when an output device with this exact name is currently available.
pub fn has_output_device(name: &str) -> bool {
    let host = cpal::default_host();
    host
        .output_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.name().ok())
                .any(|n| n == name)
        })
        .unwrap_or(false)
}

/// Return all available audio output devices.
pub fn list_output_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    host.output_devices()
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
