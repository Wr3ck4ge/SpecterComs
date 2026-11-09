use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::StreamConfig;
use log::{error, info, warn};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use parking_lot::Mutex;

use super::{AudioDevice, StreamBuffer};
use super::resample::StereoLinearResampler;
use super::share_audio::SharePcmBuffer;
use super::tap::{PcmChunk, PcmTap};

/// Shared handles to every PCM source the output callback mixes.
#[derive(Clone)]
pub struct MixSources {
    /// Voice lanes: mono i16 48 kHz (see StreamBuffer).
    pub voice: Arc<Mutex<HashMap<String, StreamBuffer>>>,
    /// Screen-share audio, one stereo f32 48 kHz buffer per sharer
    /// (share_audio.rs). Separate from the voice lanes on purpose: different
    /// format, different buffering policy, own volume.
    pub share: Arc<Mutex<HashMap<String, SharePcmBuffer>>>,
    /// Copy of the decoded voice mix (before share audio is added), for a
    /// future opt-in "voice channel on stream" (tap.rs). Idle unless
    /// someone subscribes.
    pub voice_tap: Arc<PcmTap>,
}

/// Everything one output callback needs, owned by the callback closure.
///
/// Per 48 kHz tick the mixer takes the voice sum (exactly as before: every
/// primed voice lane's next sample, summed and clamped in i16) and adds each
/// primed share stream's next stereo frame, giving one stereo frame. The
/// device then gets L/R on its first two channels and (L+R)/2 on any other
/// channel, which for voice-only audio is the same duplicated mono signal
/// every channel used to get. Resampling (device not at 48 kHz) happens on
/// that stereo pair.
struct Mixer {
    src: MixSources,
    channels: usize,
    resampler: Option<StereoLinearResampler>,
    /// Resampled-but-not-yet-written interleaved stereo frames; see the old
    /// mono `residual` rationale — resampler output batches rarely line up
    /// with a callback's frame count.
    residual: Vec<f32>,
    tick: Vec<f32>,
    tap_buf: Vec<f32>,
}

/// Voice tap chunk size: 20 ms, same as share audio.
const TAP_FRAMES: usize = 960;

impl Mixer {
    fn new(src: MixSources, channels: usize, device_rate: u32) -> Self {
        Self {
            src,
            channels,
            resampler: (device_rate != 48_000).then(|| StereoLinearResampler::new(48_000, device_rate)),
            residual: Vec::new(),
            tick: Vec::with_capacity(2),
            tap_buf: Vec::new(),
        }
    }

    /// One 48 kHz stereo frame from all sources.
    fn next_48k(
        voice: &mut HashMap<String, StreamBuffer>,
        share: &mut HashMap<String, SharePcmBuffer>,
        tap: Option<&mut Vec<f32>>,
    ) -> (f32, f32) {
        let v = pop_mixed_i16(voice) as f32 / 32_767.0;
        if let Some(t) = tap {
            t.push(v);
        }
        let (mut l, mut r) = (v, v);
        for s in share.values_mut() {
            if let Some((sl, sr)) = s.pop_frame() {
                l += sl;
                r += sr;
            }
        }
        (l, r)
    }

    /// Fill `frames` device frames, handing each (frame, channel, sample in
    /// -1..=1) to `write`.
    fn render(&mut self, frames: usize, mut write: impl FnMut(usize, usize, f32)) {
        let tapping = self.src.voice_tap.is_active();
        {
            let mut voice = self.src.voice.lock();
            let mut share = self.src.share.lock();
            match self.resampler.as_mut() {
                Some(r) => {
                    while self.residual.len() < frames * 2 {
                        let (l, rr) = Self::next_48k(&mut voice, &mut share, tapping.then_some(&mut self.tap_buf));
                        self.tick.clear();
                        self.tick.push(l);
                        self.tick.push(rr);
                        r.process(&self.tick, &mut self.residual);
                    }
                }
                None => {
                    self.residual.clear();
                    for _ in 0..frames {
                        let (l, r) = Self::next_48k(&mut voice, &mut share, tapping.then_some(&mut self.tap_buf));
                        self.residual.push(l);
                        self.residual.push(r);
                    }
                }
            }
        }
        for f in 0..frames {
            let l = self.residual[f * 2].clamp(-1.0, 1.0);
            let r = self.residual[f * 2 + 1].clamp(-1.0, 1.0);
            match self.channels {
                1 => write(f, 0, ((l + r) * 0.5).clamp(-1.0, 1.0)),
                n => {
                    write(f, 0, l);
                    write(f, 1, r);
                    let m = (l + r) * 0.5;
                    for ch in 2..n {
                        write(f, ch, m);
                    }
                }
            }
        }
        self.residual.drain(..frames * 2);

        if tapping {
            self.flush_tap();
        } else if !self.tap_buf.is_empty() {
            self.tap_buf.clear();
        }
    }

    /// Publish whole 20 ms chunks of the voice mix. The timestamp is when
    /// the mixer produced the chunk; the device plays it one output latency
    /// later (not compensated: it's a mix tap, not a sync source).
    fn flush_tap(&mut self) {
        while self.tap_buf.len() >= TAP_FRAMES {
            let now = super::loopback::qpc_now_ms();
            let pending_ms = self.tap_buf.len() as f64 / 48.0;
            let chunk: Vec<f32> = self.tap_buf.drain(..TAP_FRAMES).collect();
            self.src.voice_tap.publish(PcmChunk {
                timestamp_ms: now - pending_ms,
                sample_rate: 48_000,
                channels: 1,
                samples: Arc::from(chunk),
            });
        }
    }
}

/// Pop one sample from every currently-primed stream in `queues` and sum
/// them — the same per-tick mixing every format branch below needs, whether
/// or not the result then goes through the resampler. Factored out so the
/// resampling path (which needs to pull mixed samples on demand, not just
/// once per output frame) and the direct/no-resample path share one
/// definition of "what does a mixed sample mean" instead of drifting apart.
///
/// Each lane's listener gain (set_stream_volume) is applied here, per
/// sample, before summing; unity lanes (the common case) skip the multiply.
/// A boosted lane (gain > 1, up to +18 dB) goes through `soft_limit`, so a
/// loud peak rounds off instead of hard-clipping into crackle.
fn pop_mixed_i16(queues: &mut HashMap<String, StreamBuffer>) -> i16 {
    let mut mixed = 0i32;
    for q in queues.values_mut() {
        if let Some(s) = pop_primed(q) {
            mixed += if q.gain == 1.0 {
                s as i32
            } else if q.gain > 1.0 {
                soft_limit(s as f32 * q.gain)
            } else {
                (s as f32 * q.gain).round() as i32
            };
        }
    }
    mixed.clamp(i16::MIN as i32, i16::MAX as i32) as i16
}

/// Below LIMIT_KNEE of full scale: unchanged. Above: tanh-compressed so the
/// output approaches but never passes full scale.
const LIMIT_KNEE: f32 = 0.7;

pub(crate) fn soft_limit(x: f32) -> i32 {
    const FULL: f32 = 32767.0;
    let n = (x / FULL).abs();
    let y = if n <= LIMIT_KNEE {
        n
    } else {
        let head = 1.0 - LIMIT_KNEE;
        LIMIT_KNEE + head * ((n - LIMIT_KNEE) / head).tanh()
    };
    (y.copysign(x) * FULL).round() as i32
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
/// buffering) or whose queue is empty. Screen-share audio streams
/// (`sources.share`, stereo) are added on top; see `Mixer` for how the
/// result maps onto the device's channels.
///
/// If `device_name` is `Some(name)`, the named device is used; otherwise the
/// system default output device is used.
pub fn start(sources: MixSources, device_name: Option<&str>) -> Result<PlaybackHandle, String> {
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
    let sample_format = supported.sample_format();

    let err_fn = move |err| {
        error!("Audio playback error: {}", err);
    };

    // Only one sample-format arm below is ever constructed at runtime, so
    // moving the one Mixer into whichever arm runs is fine (the same
    // pattern capture.rs uses for its resampler).
    let mut mixer = Mixer::new(sources, channels, sample_rate.0);
    let running_cb = running.clone();

    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_output_stream(
            &config,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                if !running_cb.load(Ordering::Relaxed) {
                    data.fill(0.0);
                    return;
                }
                mixer.render(data.len() / channels, |f, ch, s| data[f * channels + ch] = s);
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_output_stream(
            &config,
            move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                if !running_cb.load(Ordering::Relaxed) {
                    data.fill(0);
                    return;
                }
                mixer.render(data.len() / channels, |f, ch, s| {
                    data[f * channels + ch] = (s * 32_767.0).round() as i16;
                });
            },
            err_fn,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_output_stream(
            &config,
            move |data: &mut [i32], _: &cpal::OutputCallbackInfo| {
                if !running_cb.load(Ordering::Relaxed) {
                    data.fill(0);
                    return;
                }
                // i16-scaled then widened, exactly as the old path did.
                mixer.render(data.len() / channels, |f, ch, s| {
                    data[f * channels + ch] = ((s * 32_767.0).round() as i32) << 16;
                });
            },
            err_fn,
            None,
        ),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> MixSources {
        MixSources {
            voice: Arc::new(Mutex::new(HashMap::new())),
            share: Arc::new(Mutex::new(HashMap::new())),
            voice_tap: Arc::new(PcmTap::new()),
        }
    }

    fn render(m: &mut Mixer, frames: usize) -> Vec<f32> {
        let ch = m.channels;
        let mut out = vec![0.0f32; frames * ch];
        m.render(frames, |f, c, s| out[f * ch + c] = s);
        out
    }

    #[test]
    fn voice_only_is_duplicated_to_every_channel_as_before() {
        let src = sources();
        let mut sb = StreamBuffer::new();
        sb.queue.extend([16_384i16; 4]);
        sb.primed = true;
        src.voice.lock().insert("v".into(), sb);
        let mut m = Mixer::new(src, 4, 48_000);
        let out = render(&mut m, 2);
        let v = 16_384.0 / 32_767.0;
        assert!(out.iter().all(|&s| (s - v).abs() < 1e-6), "{:?}", out);
    }

    #[test]
    fn soft_limit_passes_quiet_samples_and_never_exceeds_full_scale() {
        // Quiet speech boosted ×8 stays linear below the knee.
        assert_eq!(soft_limit(1000.0 * 8.0), 8000);
        assert_eq!(soft_limit(-1000.0 * 8.0), -8000);
        // A loud peak ×8 is rounded off, not hard-clipped past i16.
        let hot = soft_limit(20000.0 * 8.0);
        assert!(hot <= i16::MAX as i32 && hot > 30000, "{hot}");
        assert_eq!(soft_limit(-20000.0 * 8.0), -hot);
        // Monotonic through the knee.
        assert!(soft_limit(24000.0) < soft_limit(26000.0));
    }

    #[test]
    fn share_audio_is_stereo_with_volume_and_voice_tap_excludes_it() {
        let src = sources();
        let mut b = SharePcmBuffer::new();
        b.set_delay_ms(20);
        b.volume = 0.5;
        let frames: Vec<f32> = (0..960).flat_map(|_| [0.4f32, -0.4]).collect();
        b.push(&frames);
        src.share.lock().insert("s".into(), b);
        let tap_rx = src.voice_tap.subscribe(4);
        let mut m = Mixer::new(src, 2, 48_000);
        let out = render(&mut m, 960);
        assert!((out[0] - 0.2).abs() < 1e-6 && (out[1] + 0.2).abs() < 1e-6);
        let chunk = tap_rx.try_recv().expect("voice tap chunk");
        assert_eq!(chunk.channels, 1);
        assert_eq!(chunk.frames(), 960);
        assert!(chunk.samples.iter().all(|&s| s == 0.0), "share audio must not leak into the voice tap");
    }

    fn primed(samples: &[i16], gain: f32) -> StreamBuffer {
        let mut sb = StreamBuffer::with_gain(gain);
        sb.queue.extend(samples.iter().copied());
        sb.primed = true;
        sb
    }

    #[test]
    fn per_stream_gain_scales_only_its_own_lane() {
        let mut q = HashMap::new();
        q.insert("ch:1".to_string(), primed(&[1_000, 1_000], 0.5));
        assert_eq!(pop_mixed_i16(&mut q), 500);
        // A second, unity lane is untouched by the first lane's gain.
        q.insert("ch:2".to_string(), primed(&[2_000], 1.0));
        assert_eq!(pop_mixed_i16(&mut q), 500 + 2_000);
    }

    #[test]
    fn per_stream_gain_boosts_and_the_mix_still_clamps() {
        let mut q = HashMap::new();
        q.insert("a".to_string(), primed(&[10_000], 2.0));
        assert_eq!(pop_mixed_i16(&mut q), 20_000);
        q.insert("a".to_string(), primed(&[30_000], 2.0));
        let hot = pop_mixed_i16(&mut q);
        assert!(hot > 32_000, "a boosted peak is soft-limited, not dropped: {hot}");
        q.insert("a".to_string(), primed(&[30_000], 8.0));
        assert!(pop_mixed_i16(&mut q) <= i16::MAX, "a +18 dB lane can't overflow the i16 mix");
        q.insert("a".to_string(), primed(&[1_234], 0.0));
        assert_eq!(pop_mixed_i16(&mut q), 0, "0% silences the lane");
    }

    #[test]
    fn per_stream_gain_is_clamped_on_creation() {
        assert_eq!(StreamBuffer::with_gain(5.0).gain, 5.0);
        assert_eq!(StreamBuffer::with_gain(20.0).gain, crate::MAX_STREAM_GAIN);
        assert_eq!(StreamBuffer::with_gain(-1.0).gain, 0.0);
        assert_eq!(StreamBuffer::with_gain(f32::NAN).gain, 1.0);
    }

    #[test]
    fn mixer_applies_gain_through_render() {
        let src = sources();
        src.voice.lock().insert("half".into(), primed(&[16_384; 4], 0.5));
        let mut m = Mixer::new(src, 2, 48_000);
        let out = render(&mut m, 2);
        let v = 8_192.0 / 32_767.0;
        assert!(out.iter().all(|&s| (s - v).abs() < 1e-6), "{:?}", out);
    }

    #[test]
    fn resampled_output_keeps_frame_count() {
        let src = sources();
        let mut m = Mixer::new(src, 2, 44_100);
        for n in [441usize, 512, 1, 1024] {
            assert_eq!(render(&mut m, n).len(), n * 2);
        }
    }
}
