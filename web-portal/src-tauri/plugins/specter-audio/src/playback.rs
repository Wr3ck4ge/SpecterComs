use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use log::{error, info, warn};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use parking_lot::Mutex;

use super::{AudioDevice, StreamBuffer};
use super::resample::LinearResampler;

/// Pop one sample from every currently-primed stream in `queues` and sum
/// them — the same per-tick mixing every format branch below needs, whether
/// or not the result then goes through the resampler. Factored out so the
/// resampling path (which needs to pull mixed samples on demand, not just
/// once per output frame) and the direct/no-resample path share one
/// definition of "what does a mixed sample mean" instead of drifting apart.
fn pop_mixed_i16(queues: &mut HashMap<String, StreamBuffer>) -> i16 {
    let mut mixed = 0i32;
    for q in queues.values_mut() {
        if let Some(s) = pop_primed(q) {
            mixed += s as i32;
        }
    }
    mixed.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

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

    // Prefer 48 kHz to match the Opus decoder output rate — the jitter
    // buffers are always 48 kHz mono PCM (see StreamBuffer's doc comment).
    // Using the device's native rate directly without correcting for it
    // used to just desync playback speed from real time (e.g. draining a
    // 48 kHz-paced queue at 96 kHz plays it 2x fast — the same "chipmunk"
    // pitch/speed bug capture.rs's LinearResampler fixes on the sending
    // side, mirrored here for whichever device is actually rendering it).
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
            "Device does not support 48 kHz output — resampling from 48 kHz to device rate {} Hz.",
            supported.sample_rate().0
        );
        supported.sample_rate()
    };
    super::write_audio_log(&format!(
        "playback: device='{}' rate={}Hz (48kHz supported={})",
        device_name, sample_rate.0, supports_48k
    ));

    let config = StreamConfig {
        channels: supported.channels(),
        sample_rate,
        buffer_size: cpal::BufferSize::Default,
    };

    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();
    let running_clone_2 = running.clone();
    let stream_queues_i16 = stream_queues.clone();

    // Shared across whichever format branch actually builds below (see
    // capture.rs's identical `resampler` pattern for why moving the same
    // Option into every match arm is fine — only one arm's closure is ever
    // actually constructed at runtime). `residual` holds resampled-but-not-
    // yet-written-to-a-callback output samples: the resampler produces
    // output in whatever-sized batches correspond to however many 48kHz
    // input ticks were just pulled, which rarely lines up exactly with
    // `frame_count` for a given callback.
    let mut resampler = (sample_rate.0 != 48_000)
        .then(|| LinearResampler::new(48_000, sample_rate.0));
    let mut residual: Vec<i16> = Vec::new();

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
                    if let Some(r) = resampler.as_mut() {
                        while residual.len() < frame_count {
                            let s = pop_mixed_i16(&mut queues);
                            r.process(&[s], &mut residual);
                        }
                        for (frame, &s) in residual[..frame_count].iter().enumerate() {
                            let clipped = (s as f32 / 32_767.0).clamp(-1.0, 1.0);
                            for ch in 0..channels {
                                data[frame * channels + ch] = clipped;
                            }
                        }
                        residual.drain(..frame_count);
                    } else {
                        for frame in 0..frame_count {
                            let s = pop_mixed_i16(&mut queues);
                            let clipped = (s as f32 / 32_767.0).clamp(-1.0, 1.0);
                            for ch in 0..channels {
                                data[frame * channels + ch] = clipped;
                            }
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
                    if let Some(r) = resampler.as_mut() {
                        while residual.len() < frame_count {
                            let s = pop_mixed_i16(&mut queues);
                            r.process(&[s], &mut residual);
                        }
                        for (frame, &clipped) in residual[..frame_count].iter().enumerate() {
                            for ch in 0..channels {
                                data[frame * channels + ch] = clipped;
                            }
                        }
                        residual.drain(..frame_count);
                    } else {
                        for frame in 0..frame_count {
                            let clipped = pop_mixed_i16(&mut queues);
                            for ch in 0..channels {
                                data[frame * channels + ch] = clipped;
                            }
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
                    if let Some(r) = resampler.as_mut() {
                        while residual.len() < frame_count {
                            let s = pop_mixed_i16(&mut queues);
                            r.process(&[s], &mut residual);
                        }
                        for (frame, &clipped) in residual[..frame_count].iter().enumerate() {
                            // Scale i16 range to i32 range for the device.
                            let expanded = (clipped as i32) << 16;
                            for ch in 0..channels {
                                data[frame * channels + ch] = expanded;
                            }
                        }
                        residual.drain(..frame_count);
                    } else {
                        for frame in 0..frame_count {
                            let clipped = pop_mixed_i16(&mut queues);
                            // Scale i16 range to i32 range for the device.
                            let expanded = (clipped as i32) << 16;
                            for ch in 0..channels {
                                data[frame * channels + ch] = expanded;
                            }
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
