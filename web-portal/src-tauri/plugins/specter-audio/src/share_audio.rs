//! Screen-share audio: the sending side (STREAMING_PLAN S2, native part) and
//! the receiving side's decode + jitter buffer (S3, native part).
//!
//! Sending: loopback.rs's continuous 48 kHz stereo stream is cut into 20 ms
//! frames, copied to the PCM tap (Twitch prep), encoded with a dedicated
//! stereo OPUS_APPLICATION_AUDIO encoder and handed to an emitter thread
//! that ships each packet to JS (`specter://share-audio-frame`). Capture
//! thread → emitter thread is a bounded `try_send`, so a stalled webview
//! drops share-audio frames instead of stalling the capture.
//!
//! Receiving: each sharer gets its own stream, entirely separate from the
//! voice lanes: its own Opus decoder, its own `Reorder` stage (orders
//! packets by `seq`, drops late ones, conceals real losses with Opus PLC),
//! and its own `SharePcmBuffer` that playback.rs's output mixer drains. No
//! VAD, no voice-lane cap: game audio is continuous and is meant to be
//! buffered to a target delay (set from JS to match video decode latency),
//! not trimmed to voice's 80 ms.

use std::collections::{BTreeMap, VecDeque};
use std::sync::mpsc::{sync_channel, TrySendError};
use std::sync::Arc;

use super::loopback::{self, LoopbackHandle, LoopbackMode};
use super::opus_encode::OpusEncoder;
use super::tap::{PcmChunk, PcmTap};

/// 20 ms at 48 kHz, per channel.
pub const FRAME: usize = 960;
pub const FRAME_MS: u32 = 20;
pub const DEFAULT_BITRATE_KBPS: u32 = 128;
const MIN_BITRATE_KBPS: u32 = 32;
const MAX_BITRATE_KBPS: u32 = 256;
/// Encoded frames buffered between the capture thread and the emitter
/// thread (1 s).
const EMIT_QUEUE: usize = 50;

// ── Sending ──────────────────────────────────────────────────────────────────

/// One encoded share-audio packet.
pub struct EncodedFrame {
    pub data: Vec<u8>,
    /// QPC milliseconds of the frame's first sample, rounded.
    pub timestamp_ms: u64,
    pub seq: u64,
}

/// Cuts contiguous stereo chunks into exact 20 ms frames and keeps each
/// frame's start time. Chunks from loopback.rs are contiguous by contract,
/// so a frame's timestamp is the buffer's start time plus 20 ms per frame
/// already taken; the arrival time of a chunk is never used.
pub struct FrameAssembler {
    buf: Vec<f32>,
    buf_start_ms: f64,
}

impl FrameAssembler {
    pub fn new() -> Self {
        Self { buf: Vec::with_capacity(FRAME * 4), buf_start_ms: 0.0 }
    }

    pub fn push(&mut self, samples: &[f32], ts_ms: f64, mut on_frame: impl FnMut(&[f32], f64)) {
        if self.buf.is_empty() {
            self.buf_start_ms = ts_ms;
        }
        self.buf.extend_from_slice(samples);
        let mut taken = 0;
        while self.buf.len() - taken >= FRAME * 2 {
            on_frame(&self.buf[taken..taken + FRAME * 2], self.buf_start_ms);
            taken += FRAME * 2;
            self.buf_start_ms += FRAME_MS as f64;
        }
        if taken > 0 {
            self.buf.drain(..taken);
        }
    }
}

pub struct ShareAudioSender {
    loopback: LoopbackHandle,
}

impl ShareAudioSender {
    pub fn mode(&self) -> LoopbackMode {
        self.loopback.mode
    }

    /// Stop and join the capture thread. The emitter thread ends on its own
    /// once the capture side's sender is dropped.
    pub fn stop(self) {
        self.loopback.stop();
    }
}

pub fn clamp_bitrate_kbps(kbps: Option<u32>) -> u32 {
    kbps.unwrap_or(DEFAULT_BITRATE_KBPS).clamp(MIN_BITRATE_KBPS, MAX_BITRATE_KBPS)
}

/// Start capturing `source_id` and encoding it. `on_frame` runs on a
/// dedicated emitter thread, never on the capture thread.
pub fn start_sender<F>(source_id: &str, bitrate_kbps: u32, tap: Arc<PcmTap>, on_frame: F) -> Result<ShareAudioSender, String>
where
    F: Fn(EncodedFrame) + Send + 'static,
{
    let mut encoder = OpusEncoder::new_music(FRAME, bitrate_kbps as i32 * 1000)?;
    let (tx, rx) = sync_channel::<EncodedFrame>(EMIT_QUEUE);
    std::thread::Builder::new()
        .name("specter-share-audio-emit".into())
        .spawn(move || {
            while let Ok(f) = rx.recv() {
                on_frame(f);
            }
        })
        .map_err(|e| format!("spawn share-audio emitter: {e}"))?;

    let mut assembler = FrameAssembler::new();
    let mut seq: u64 = 0;
    let mut dropped: u64 = 0;
    let mut encode_errors: u64 = 0;
    let loopback = loopback::start(source_id, move |samples, ts| {
        assembler.push(samples, ts, |frame, frame_ts| {
            if tap.is_active() {
                tap.publish(PcmChunk {
                    timestamp_ms: frame_ts,
                    sample_rate: loopback::OUT_RATE,
                    channels: 2,
                    samples: Arc::from(frame),
                });
            }
            match encoder.encode_f32(frame) {
                Ok(data) => {
                    let f = EncodedFrame { data, timestamp_ms: frame_ts.round().max(0.0) as u64, seq };
                    match tx.try_send(f) {
                        Ok(()) => {}
                        Err(TrySendError::Full(_)) => {
                            dropped += 1;
                            if dropped == 1 || dropped % 500 == 0 {
                                super::write_audio_log(&format!("share-audio: emitter behind, dropped {dropped} frames"));
                            }
                        }
                        Err(TrySendError::Disconnected(_)) => {}
                    }
                }
                Err(e) => {
                    encode_errors += 1;
                    if encode_errors == 1 || encode_errors % 500 == 0 {
                        super::write_audio_log(&format!("share-audio: opus encode error #{encode_errors}: {e}"));
                    }
                }
            }
            // seq advances even when a frame is lost locally, so the
            // receiver conceals it rather than splicing across the hole.
            seq += 1;
        });
    })?;
    Ok(ShareAudioSender { loopback })
}

// ── Receiving: packet reorder / loss handling (pure) ─────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Decode this packet.
    Decode(Vec<u8>),
    /// A packet is lost: run Opus PLC for one frame.
    Conceal,
    /// The sender restarted or we lost sync: reset the decoder and drop
    /// buffered PCM before what follows.
    Reset,
}

/// How long a missing packet is waited for (in frames) once later packets
/// have arrived, before it's declared lost. 2 frames = 40 ms; the PCM
/// buffer's target delay (≥ 60 ms by default) absorbs the wait.
const REORDER_WINDOW: u64 = 2;
/// A seq jump this big (either direction) is a restart / resync, not loss
/// to conceal frame by frame (1 s).
const RESYNC_FRAMES: u64 = 50;

pub struct Reorder {
    expected: Option<u64>,
    pending: BTreeMap<u64, Vec<u8>>,
}

impl Reorder {
    pub fn new() -> Self {
        Self { expected: None, pending: BTreeMap::new() }
    }

    pub fn push(&mut self, seq: u64, data: Vec<u8>) -> Vec<Step> {
        let mut out = Vec::new();
        let expected = match self.expected {
            None => {
                self.expected = Some(seq);
                seq
            }
            Some(e) => e,
        };
        if seq < expected {
            if expected - seq <= RESYNC_FRAMES {
                return out; // late or duplicate: already played or concealed
            }
            // Far behind: the sharer restarted capture (seq from 0 again).
            self.resync(seq, &mut out);
        } else if seq - expected > RESYNC_FRAMES {
            self.resync(seq, &mut out);
        }
        self.pending.entry(seq).or_insert(data);
        self.drain(&mut out);
        out
    }

    fn resync(&mut self, seq: u64, out: &mut Vec<Step>) {
        self.pending.clear();
        self.expected = Some(seq);
        out.push(Step::Reset);
    }

    fn drain(&mut self, out: &mut Vec<Step>) {
        let Some(mut expected) = self.expected else { return };
        loop {
            if let Some(d) = self.pending.remove(&expected) {
                out.push(Step::Decode(d));
                expected += 1;
                continue;
            }
            match self.pending.keys().next_back() {
                Some(&newest) if newest - expected >= REORDER_WINDOW => {
                    out.push(Step::Conceal);
                    expected += 1;
                }
                _ => break,
            }
        }
        self.expected = Some(expected);
    }
}

// ── Receiving: decoded PCM buffer drained by the output mixer ────────────────

pub const DEFAULT_DELAY_MS: u32 = 120;
const MIN_DELAY_MS: u32 = 20;
const MAX_DELAY_MS: u32 = 1_000;
/// Only a burst this far above the target is cut in one go. Share audio
/// rides the same reliable stream as the video, so a big keyframe holds it
/// back and then delivers it in a burst; that burst is real audio to play,
/// not excess to drop (the old 80 ms limit cut it, audibly).
const BURST_LIMIT_EXTRA_MS: u32 = 400;
/// Within this much of the target, nothing is corrected.
const DEADBAND_MS: u32 = 10;
/// Off-target buffers converge by dropping or repeating one frame in this
/// many (a 1% rate change: ~10 ms per second, inaudible), instead of the
/// gap or skip an abrupt change makes. A/V-delay updates and clock drift
/// both go through this.
const ADJUST_EVERY_FRAMES: u32 = 100;

pub fn clamp_delay_ms(ms: u32) -> u32 {
    ms.clamp(MIN_DELAY_MS, MAX_DELAY_MS)
}

/// Measured arrival jitter, the buffer floor's margin above it, and its cap.
const JITTER_WINDOW_MS: f64 = 4_000.0;
const JITTER_MARGIN_MS: f64 = 30.0;
const JITTER_FLOOR_MAX_MS: f64 = 700.0;
/// A transit jump this big is a clock reset / sender restart, not jitter.
const JITTER_RESET_MS: f64 = 5_000.0;

/// Arrival jitter of one sharer's packets: the spread of (arrival − sender
/// timestamp) over the last few seconds. Both clocks are QPC ms on their own
/// machines, so the difference carries a constant offset that the spread
/// cancels. Today share audio rides the reliable video stream, where a big
/// video frame holds it back and releases it in a clump: this is how big
/// those clumps are, i.e. how deep the buffer must be not to run dry.
pub struct JitterTracker {
    samples: VecDeque<(f64, f64)>, // (arrival_ms, transit_ms)
}

impl JitterTracker {
    pub fn new() -> Self {
        Self { samples: VecDeque::new() }
    }

    pub fn clear(&mut self) {
        self.samples.clear();
    }

    /// Record one packet; returns the current jitter estimate in ms.
    pub fn observe(&mut self, arrival_ms: f64, sender_ts_ms: f64) -> f64 {
        let transit = arrival_ms - sender_ts_ms;
        if let Some(&(_, last)) = self.samples.back() {
            if (transit - last).abs() > JITTER_RESET_MS {
                self.samples.clear();
            }
        }
        self.samples.push_back((arrival_ms, transit));
        while let Some(&(a, _)) = self.samples.front() {
            if arrival_ms - a > JITTER_WINDOW_MS {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        let (lo, hi) = self.samples.iter().fold((f64::MAX, f64::MIN), |(lo, hi), &(_, t)| (lo.min(t), hi.max(t)));
        (hi - lo).max(0.0)
    }
}

/// Per-sharer stereo jitter buffer, interleaved 48 kHz f32. Nothing is
/// played until `target` worth of audio is buffered; after an underrun it
/// re-buffers only half the target (the gap is what's audible, and the
/// gentle convergence in `pop_frame` grows it back). Changing the target
/// never gaps or skips: the buffer level drifts toward it at 1%. Volume
/// lives here so a volume change applies on the very next output callback.
pub struct SharePcmBuffer {
    queue: VecDeque<f32>,
    primed: bool,
    ever_primed: bool,
    /// The A/V-sync delay JS asked for (share_audio_set_delay).
    target_frames: usize,
    /// Measured jitter + margin: the buffer never targets less than this.
    jitter_floor_frames: usize,
    since_adjust: u32,
    last: (f32, f32),
    pub volume: f32,
    pub stats: PcmBufferStats,
}

/// Playback-side health counters (logged with the receive counters).
#[derive(Clone, Debug, Default)]
pub struct PcmBufferStats {
    /// The buffer ran dry while playing: an audible gap.
    pub underruns: u64,
    /// Frames cut by the runaway-backlog limit: audio skipped.
    pub burst_cut_frames: u64,
    pub repeated_frames: u64,
    pub skipped_frames: u64,
}

impl SharePcmBuffer {
    pub fn new() -> Self {
        Self {
            queue: VecDeque::new(),
            primed: false,
            ever_primed: false,
            target_frames: ms_to_frames(DEFAULT_DELAY_MS),
            jitter_floor_frames: 0,
            since_adjust: 0,
            last: (0.0, 0.0),
            volume: 1.0,
            stats: PcmBufferStats::default(),
        }
    }

    /// One-line health summary (frames shown as ms).
    pub fn summary(&self) -> String {
        let ms = |f: u64| f as f64 / 48.0;
        format!(
            "buffered={:.0}ms target={:.0}ms (av={:.0} jitter_floor={:.0}) underruns={} burst_cut={:.0}ms repeated={:.0}ms skipped={:.0}ms",
            ms(self.buffered_frames() as u64),
            ms(self.effective_target() as u64),
            ms(self.target_frames as u64),
            ms(self.jitter_floor_frames as u64),
            self.stats.underruns,
            ms(self.stats.burst_cut_frames),
            ms(self.stats.repeated_frames),
            ms(self.stats.skipped_frames),
        )
    }

    fn burst_limit_frames(&self) -> usize {
        self.effective_target() + ms_to_frames(BURST_LIMIT_EXTRA_MS)
    }

    /// What the buffer actually aims for: the A/V delay, or deeper when the
    /// measured arrival jitter needs it.
    fn effective_target(&self) -> usize {
        self.target_frames.max(self.jitter_floor_frames)
    }

    fn prime_frames(&self) -> usize {
        let target = self.effective_target();
        // After an underrun, re-buffer half the target (a shorter gap) —
        // unless jitter is what set the target: then it ran dry because the
        // arrival clumps are that big, and half would just run dry again.
        if self.ever_primed && self.jitter_floor_frames <= self.target_frames {
            (target / 2).max(ms_to_frames(MIN_DELAY_MS))
        } else {
            target
        }
    }

    pub fn set_delay_ms(&mut self, ms: u32) {
        self.target_frames = ms_to_frames(clamp_delay_ms(ms));
    }

    /// Measured arrival jitter (JitterTracker); the buffer floor follows it.
    pub fn set_jitter_ms(&mut self, jitter_ms: f64) {
        let floor = (jitter_ms + JITTER_MARGIN_MS).clamp(0.0, JITTER_FLOOR_MAX_MS);
        self.jitter_floor_frames = (floor * 48.0) as usize;
    }

    pub fn buffered_frames(&self) -> usize {
        self.queue.len() / 2
    }

    /// Drop buffered audio (sender restart / reset). The next audio primes
    /// at the full target again.
    pub fn clear(&mut self) {
        self.queue.clear();
        self.primed = false;
        self.ever_primed = false;
    }

    /// Append decoded interleaved stereo samples.
    pub fn push(&mut self, samples: &[f32]) {
        self.queue.extend(samples.iter().copied());
        if self.buffered_frames() > self.burst_limit_frames() {
            let drop = (self.buffered_frames() - self.effective_target()) * 2;
            self.queue.drain(..drop);
            self.stats.burst_cut_frames += (drop / 2) as u64;
        }
        if !self.primed && self.buffered_frames() >= self.prime_frames() {
            self.primed = true;
            self.ever_primed = true;
        }
    }

    /// One output frame (L, R) with volume applied, or None while buffering.
    pub fn pop_frame(&mut self) -> Option<(f32, f32)> {
        if !self.primed {
            return None;
        }
        self.since_adjust += 1;
        if self.since_adjust >= ADJUST_EVERY_FRAMES {
            self.since_adjust = 0;
            let deadband = ms_to_frames(DEADBAND_MS);
            let level = self.buffered_frames();
            let target = self.effective_target();
            if level > target + deadband {
                // Too much buffered: skip one frame.
                self.queue.pop_front();
                self.queue.pop_front();
                self.stats.skipped_frames += 1;
            } else if level + deadband < target {
                // Too little: play the previous frame again.
                self.stats.repeated_frames += 1;
                let (l, r) = self.last;
                return Some((l * self.volume, r * self.volume));
            }
        }
        match (self.queue.pop_front(), self.queue.pop_front()) {
            (Some(l), Some(r)) => {
                self.last = (l, r);
                Some((l * self.volume, r * self.volume))
            }
            _ => {
                self.primed = false;
                self.stats.underruns += 1;
                None
            }
        }
    }
}

fn ms_to_frames(ms: u32) -> usize {
    ms as usize * 48
}

/// Receiver-side state for one sharer that the output callback never
/// touches: packet ordering and the Opus decoder.
pub struct ShareRxStream {
    reorder: Reorder,
    decoder: audiopus::coder::Decoder,
    pcm: Vec<f32>,
    pub packets: u64,
    pub decoded: u64,
    /// Lost (or corrupt) packets filled by Opus PLC: each is 20 ms of guesswork.
    pub concealed: u64,
    pub resets: u64,
    pub jitter: JitterTracker,
    /// Latest jitter estimate, ms.
    pub jitter_ms: f64,
}

impl ShareRxStream {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            reorder: Reorder::new(),
            decoder: new_decoder()?,
            pcm: vec![0.0; FRAME * 2 * 6],
            packets: 0,
            decoded: 0,
            concealed: 0,
            resets: 0,
            jitter: JitterTracker::new(),
            jitter_ms: 0.0,
        })
    }

    pub fn summary(&self) -> String {
        format!(
            "packets={} decoded={} concealed={} resets={} jitter={:.0}ms",
            self.packets, self.decoded, self.concealed, self.resets, self.jitter_ms
        )
    }

    /// Feed one received packet. Decoded/concealed audio is appended to
    /// `out`; returns true when the stream was reset, in which case the
    /// caller must clear its buffered PCM before appending `out` (anything
    /// decoded before the reset has already been discarded from `out`).
    /// Decoding happens here, outside the lock the output callback takes.
    pub fn receive(&mut self, seq: u64, data: Vec<u8>, out: &mut Vec<f32>) -> Result<bool, String> {
        let mut reset = false;
        self.packets += 1;
        for step in self.reorder.push(seq, data) {
            let n = match step {
                Step::Reset => {
                    self.decoder = new_decoder()?;
                    out.clear();
                    reset = true;
                    self.resets += 1;
                    continue;
                }
                Step::Conceal => {
                    self.concealed += 1;
                    self.decode(None)?
                }
                // A corrupt packet is just another lost frame.
                Step::Decode(bytes) => match self.decode(Some(&bytes)) {
                    Ok(n) => {
                        self.decoded += 1;
                        n
                    }
                    Err(_) => {
                        self.concealed += 1;
                        self.decode(None)?
                    }
                },
            };
            out.extend_from_slice(&self.pcm[..n * 2]);
        }
        Ok(reset)
    }

    fn decode(&mut self, bytes: Option<&[u8]>) -> Result<usize, String> {
        let packet = match bytes {
            Some(b) => Some(audiopus::packet::Packet::try_from(b).map_err(|e| format!("Invalid Opus packet: {:?}", e))?),
            None => None,
        };
        // PLC: ask for exactly one 20 ms frame. Real packets may carry up to
        // 120 ms, hence the larger buffer.
        let len = if packet.is_none() { FRAME * 2 } else { self.pcm.len() };
        let signals = audiopus::MutSignals::try_from(&mut self.pcm[..len]).map_err(|e| format!("MutSignals error: {:?}", e))?;
        self.decoder
            .decode_float(packet, signals, false)
            .map_err(|e| format!("Opus decode failed: {:?}", e))
    }
}

fn new_decoder() -> Result<audiopus::coder::Decoder, String> {
    audiopus::coder::Decoder::new(audiopus::SampleRate::Hz48000, audiopus::Channels::Stereo)
        .map_err(|e| format!("Failed to create share-audio Opus decoder: {:?}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(n: u8) -> Vec<u8> {
        vec![n]
    }

    #[test]
    fn assembler_cuts_exact_frames_with_contiguous_timestamps() {
        let mut a = FrameAssembler::new();
        let mut got = Vec::new();
        let mut ts = 1000.0;
        // 7 ms chunks (336 frames), 30 of them = 210 ms → 10 full frames.
        for _ in 0..30 {
            let chunk = vec![0.25f32; 336 * 2];
            a.push(&chunk, ts, |f, t| got.push((f.len(), t)));
            ts += 7.0;
        }
        assert_eq!(got.len(), 10);
        for (i, (len, t)) in got.iter().enumerate() {
            assert_eq!(*len, FRAME * 2);
            assert!((t - (1000.0 + i as f64 * 20.0)).abs() < 1e-9);
        }
    }

    #[test]
    fn in_order_packets_decode_straight_through() {
        let mut r = Reorder::new();
        assert_eq!(r.push(10, p(10)), vec![Step::Decode(p(10))]);
        assert_eq!(r.push(11, p(11)), vec![Step::Decode(p(11))]);
    }

    #[test]
    fn reordered_packet_within_window_is_used() {
        let mut r = Reorder::new();
        r.push(0, p(0));
        assert_eq!(r.push(2, p(2)), vec![]); // waiting for 1
        assert_eq!(r.push(1, p(1)), vec![Step::Decode(p(1)), Step::Decode(p(2))]);
    }

    #[test]
    fn lost_packet_is_concealed_once_window_passes() {
        let mut r = Reorder::new();
        r.push(0, p(0));
        assert_eq!(r.push(2, p(2)), vec![]);
        assert_eq!(r.push(3, p(3)), vec![Step::Conceal, Step::Decode(p(2)), Step::Decode(p(3))]);
        // The lost packet arriving now is late: dropped.
        assert_eq!(r.push(1, p(1)), vec![]);
        // Duplicates too.
        assert_eq!(r.push(3, p(3)), vec![]);
        assert_eq!(r.push(4, p(4)), vec![Step::Decode(p(4))]);
    }

    #[test]
    fn burst_loss_conceals_each_frame() {
        let mut r = Reorder::new();
        r.push(0, p(0));
        // 1, 2, 3 are concealed; 4 is still inside the reorder window.
        let steps = r.push(5, p(5));
        assert_eq!(steps, vec![Step::Conceal, Step::Conceal, Step::Conceal]);
        let steps = r.push(6, p(6));
        assert_eq!(steps, vec![Step::Conceal, Step::Decode(p(5)), Step::Decode(p(6))]);
    }

    #[test]
    fn sender_restart_resets() {
        let mut r = Reorder::new();
        for s in 1000..1003 {
            r.push(s, p(0));
        }
        assert_eq!(r.push(0, p(9)), vec![Step::Reset, Step::Decode(p(9))]);
        assert_eq!(r.push(1, p(8)), vec![Step::Decode(p(8))]);
        // Big forward jump (we were away): resync instead of 500 PLC frames.
        assert_eq!(r.push(500, p(7)), vec![Step::Reset, Step::Decode(p(7))]);
    }

    #[test]
    fn pcm_buffer_primes_at_target_and_reprimes_after_underrun() {
        let mut b = SharePcmBuffer::new();
        b.set_delay_ms(40);
        b.push(&vec![0.5; FRAME * 2]); // 20 ms
        assert_eq!(b.pop_frame(), None);
        b.push(&vec![0.5; FRAME * 2]); // 40 ms → primed
        b.volume = 2.0;
        assert_eq!(b.pop_frame(), Some((1.0, 1.0)));
        // Drains (plus a few repeated frames from the below-target top-up),
        // then underruns.
        let mut played = 1;
        while b.pop_frame().is_some() {
            played += 1;
            assert!(played < FRAME * 3, "must underrun once the input stops");
        }
        assert!(played >= FRAME * 2, "every buffered frame is played");
        b.set_delay_ms(80);
        b.push(&vec![0.5; FRAME * 2]); // 20 ms < 40 ms (half of 80)
        assert_eq!(b.pop_frame(), None, "re-buffers after an underrun");
        b.push(&vec![0.5; FRAME * 2]); // 40 ms = half the target → plays
        assert!(b.pop_frame().is_some(), "re-primes at half the target, not the full target");
    }

    /// Feed `ms` of steady 20 ms packets while the output drains in step,
    /// counting frames the output got nothing for.
    fn run_steady(b: &mut SharePcmBuffer, ms: usize) -> usize {
        let mut gaps = 0;
        for _ in 0..ms / 20 {
            b.push(&vec![0.1; FRAME * 2]);
            for _ in 0..FRAME {
                if b.pop_frame().is_none() {
                    gaps += 1;
                }
            }
        }
        gaps
    }

    /// The 2026-10-30 live pattern: frames made every 20 ms but delivered in
    /// clumps (held behind big video frames on the same reliable stream).
    /// Simulated in 1 ms steps; returns (underruns after warm-up, burst-cut ms).
    fn simulate_clumps(clump_ms: usize, adaptive: bool) -> (u64, f64) {
        let mut b = SharePcmBuffer::new();
        b.set_delay_ms(80); // what the A/V estimator was asking for
        let mut jt = JitterTracker::new();
        let mut pending: Vec<f64> = Vec::new(); // sender timestamps not yet delivered
        let warmup_ms = 6_000;
        let mut under_at_warmup = 0;
        for now in 0..30_000usize {
            if now % 20 == 0 {
                pending.push(now as f64);
            }
            if now % clump_ms == clump_ms - 1 {
                for ts in pending.drain(..) {
                    if adaptive {
                        b.set_jitter_ms(jt.observe(now as f64, ts));
                    }
                    b.push(&vec![0.1; FRAME * 2]);
                }
            }
            for _ in 0..48 {
                b.pop_frame();
            }
            if now == warmup_ms {
                under_at_warmup = b.stats.underruns;
            }
        }
        (b.stats.underruns - under_at_warmup, b.stats.burst_cut_frames as f64 / 48.0)
    }

    #[test]
    fn jitter_floor_rides_out_clumped_arrival() {
        let (fixed_under, _) = simulate_clumps(400, false);
        assert!(fixed_under > 10, "a fixed 80 ms target keeps running dry ({fixed_under})");
        let (under, cut_ms) = simulate_clumps(400, true);
        assert_eq!(under, 0, "jitter-sized buffer must not run dry once settled");
        assert!(cut_ms < 1.0, "and must not cut the clumps ({cut_ms} ms cut)");
    }

    #[test]
    fn jitter_tracker_measures_spread_and_forgets() {
        let mut jt = JitterTracker::new();
        // Steady: ±0 spread, whatever the clock offset.
        for i in 0..100 {
            assert!(jt.observe(1e6 + i as f64 * 20.0, i as f64 * 20.0) < 1e-9);
        }
        // One packet 300 ms late → spread 300.
        assert!((jt.observe(1e6 + 100.0 * 20.0 + 300.0, 100.0 * 20.0) - 300.0).abs() < 1e-9);
        // After the window passes with steady packets, it is forgotten.
        let mut j = 0.0;
        for i in 101..400 {
            j = jt.observe(1e6 + i as f64 * 20.0 + 1_000.0, i as f64 * 20.0 + 1_000.0);
        }
        assert!(j < 1e-9, "old jitter must age out ({j})");
        // A clock jump (sender restart) resets instead of reading as jitter.
        assert!(jt.observe(5e6, 0.0) < 1e-9);
    }

    #[test]
    fn pcm_buffer_keeps_a_burst_instead_of_cutting_it() {
        let mut b = SharePcmBuffer::new();
        b.set_delay_ms(100);
        // 300 ms arrives at once (held behind a big video keyframe).
        for _ in 0..15 {
            b.push(&vec![0.0; FRAME * 2]);
        }
        assert_eq!(b.buffered_frames(), ms_to_frames(300), "a burst within the limit is all kept");
        // A runaway backlog (past target + 400 ms) is still cut to the target.
        for _ in 0..11 {
            b.push(&vec![0.0; FRAME * 2]);
        }
        assert_eq!(b.buffered_frames(), ms_to_frames(100));
    }

    #[test]
    fn delay_changes_converge_without_gaps_or_skips() {
        let mut b = SharePcmBuffer::new();
        b.set_delay_ms(100);
        // Primes on the 5th 20 ms packet: the first 4 outputs are silent.
        assert_eq!(run_steady(&mut b, 200), ms_to_frames(80), "only the initial prime is silent");
        // Raise the target: no re-buffer gap; the level grows at ~1%.
        b.set_delay_ms(160);
        assert_eq!(run_steady(&mut b, 8_000), 0, "raising the delay must not gap");
        assert!(b.buffered_frames().abs_diff(ms_to_frames(160)) <= ms_to_frames(DEADBAND_MS) + FRAME);
        // Lower it: no bulk drop; the level shrinks at ~1%.
        b.set_delay_ms(60);
        assert!(b.buffered_frames() > ms_to_frames(100), "lowering the delay must not cut audio at once");
        assert_eq!(run_steady(&mut b, 12_000), 0);
        assert!(b.buffered_frames().abs_diff(ms_to_frames(60)) <= ms_to_frames(DEADBAND_MS) + FRAME);
    }

    #[test]
    fn decode_roundtrip_and_plc() {
        let mut enc = OpusEncoder::new_music(FRAME, 128_000).unwrap();
        let mut rx = ShareRxStream::new().unwrap();
        let mut pcm = Vec::new();
        let frame: Vec<f32> = (0..FRAME).flat_map(|i| {
            let s = (i as f32 * 0.05).sin() * 0.3;
            [s, -s]
        }).collect();
        for seq in [0u64, 1, 3, 4] {
            let pkt = enc.encode_f32(&frame).unwrap();
            assert!(!rx.receive(seq, pkt, &mut pcm).unwrap());
        }
        // 0, 1, PLC(2), 3, 4 → 5 frames.
        assert_eq!(pcm.len(), FRAME * 2 * 5);
        // Garbage packet → concealed, not an error.
        rx.receive(5, vec![0xff, 0xff, 0xff], &mut pcm).unwrap();
        assert!(pcm.len() >= FRAME * 2 * 6);
        // Sender restart: reset reported, earlier output discarded.
        let pkt = enc.encode_f32(&frame).unwrap();
        assert!(rx.receive(5_000, pkt, &mut pcm).unwrap());
        assert_eq!(pcm.len(), FRAME * 2);
    }

    /// Real WASAPI capture on this machine. Run manually:
    /// `cargo test --lib share_audio::tests::live_loopback_smoke -- --ignored --nocapture`
    /// Checks the whole send path produces a steady 50 frames/s with
    /// contiguous seq/timestamps, whether or not anything is playing (the
    /// silence filler has to carry it when nothing is).
    #[test]
    #[ignore]
    fn live_loopback_smoke() {
        let frames = Arc::new(parking_lot::Mutex::new(Vec::<(u64, u64, usize)>::new()));
        let f2 = frames.clone();
        let tap = Arc::new(PcmTap::new());
        let tap_rx = tap.subscribe(500);
        let sender = start_sender("monitor:0", 128, tap, move |f| {
            f2.lock().push((f.seq, f.timestamp_ms, f.data.len()));
        })
        .expect("share audio start");
        println!("mode = {:?}", sender.mode());
        std::thread::sleep(std::time::Duration::from_millis(3_000));
        sender.stop();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let got = frames.lock().clone();
        println!("{} frames; first {:?} last {:?}", got.len(), got.first(), got.last());
        assert!(got.len() >= 130 && got.len() <= 160, "expected ~150 frames in 3 s, got {}", got.len());
        for w in got.windows(2) {
            assert_eq!(w[1].0, w[0].0 + 1, "seq contiguous");
            let dt = w[1].1 as i64 - w[0].1 as i64;
            assert!((19..=21).contains(&dt), "timestamps 20 ms apart, got {dt}");
        }
        let now = crate::loopback::qpc_now_ms() as u64;
        assert!(now - got.last().unwrap().1 < 500, "timestamps are on the QPC clock");
        let taps: Vec<_> = tap_rx.try_iter().collect();
        assert_eq!(taps.len(), got.len());
        assert!(taps.iter().all(|c| c.frames() == FRAME && c.channels == 2));
    }

    /// Goertzel power of `freq` in mono-summed interleaved stereo.
    fn tone_power(samples: &[f32], freq: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * freq / 48_000.0;
        let coeff = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0f64, 0.0f64);
        let n = samples.len() / 2;
        for f in samples.chunks(2) {
            let x = (f[0] + f[1]) as f64 * 0.5;
            let s0 = x + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n.max(1) as f64).powi(2)
    }

    /// The plan's S1 check, on real hardware: our own playback (here a quiet
    /// 1234 Hz tone through the plugin's playback mixer, as share audio)
    /// must be absent from process_exclude capture and present in
    /// device_loopback capture. Plays ~1.5 s of a -34 dBFS tone.
    /// `cargo test --lib live_exclude_does_not_hear_own_playback -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_exclude_does_not_hear_own_playback() {
        use crate::playback::{self, MixSources};
        use std::collections::HashMap;
        let freq = 1234.0;
        let share = Arc::new(parking_lot::Mutex::new(HashMap::new()));
        let mut buf = SharePcmBuffer::new();
        let tone: Vec<f32> = (0..48_000 * 3)
            .flat_map(|i| {
                let s = (2.0 * std::f32::consts::PI * freq as f32 * i as f32 / 48_000.0).sin() * 0.02;
                [s, s]
            })
            .collect();
        // Fill the queue directly: one 3 s push would hit the burst limit.
        buf.set_delay_ms(1_000);
        for c in tone.chunks(FRAME * 2) {
            buf.queue.extend(c.iter().copied());
        }
        buf.primed = true;
        share.lock().insert("tone".to_string(), buf);
        let _pb = playback::start(
            MixSources {
                voice: Arc::new(parking_lot::Mutex::new(HashMap::new())),
                share,
                voice_tap: Arc::new(PcmTap::new()),
            },
            None,
        )
        .expect("playback");
        std::thread::sleep(std::time::Duration::from_millis(200));

        let capture = |force_device: bool| {
            let pcm = Arc::new(parking_lot::Mutex::new(Vec::<f32>::new()));
            let p2 = pcm.clone();
            let h = loopback::imp::start(loopback::Target::Everything, force_device, move |s, _| {
                p2.lock().extend_from_slice(s)
            })
            .expect("loopback");
            std::thread::sleep(std::time::Duration::from_millis(600));
            let mode = h.mode;
            h.stop();
            let v = pcm.lock().clone();
            (mode, v)
        };
        let (m_ex, ex) = capture(false);
        let (m_dev, dev) = capture(true);
        let (p_ex, p_dev) = (tone_power(&ex, freq), tone_power(&dev, freq));
        println!("{:?} tone power {:.3e}; {:?} tone power {:.3e}", m_ex, p_ex, m_dev, p_dev);
        assert_eq!(m_ex, LoopbackMode::ProcessExclude);
        assert!(p_dev > 1e-6, "device loopback should hear our tone (is the output muted?)");
        assert!(p_ex < p_dev / 100.0, "process_exclude must not hear our own playback");
    }

    #[test]
    fn bitrate_and_delay_clamps() {
        assert_eq!(clamp_bitrate_kbps(None), 128);
        assert_eq!(clamp_bitrate_kbps(Some(8)), 32);
        assert_eq!(clamp_bitrate_kbps(Some(1000)), 256);
        assert_eq!(clamp_delay_ms(0), 20);
        assert_eq!(clamp_delay_ms(5000), 1000);
    }
}
