//! Voice activation for the capture path: decides, per 20 ms window, whether
//! the window is encoded and transmitted, and (optionally) denoises it first.
//!
//! Two gating modes:
//!
//! * **Manual** — the original behaviour, bit-for-bit: a window is sent when
//!   its raw RMS clears the user's threshold, or within `SEND_GATE_HANGOVER`
//!   of the last window that did (`should_send_at`). No denoising, no pre-roll,
//!   the PCM handed to Opus is the captured PCM. Push-to-talk also uses this.
//!
//! * **Auto (adaptive)** — RNNoise (`nnnoiseless`, a pure-Rust port; BSD-3)
//!   gives a per-10 ms voice probability and, optionally, the denoised signal.
//!   A minimum-statistics tracker learns the background level. The gate opens
//!   only when a window is voice-like (probability) AND clearly above the
//!   learned floor (margin) AND the level is modulated like speech (not a
//!   steady drone), for `confirm` consecutive windows (so a single keyboard
//!   click can't open it), then holds for a hangover (with looser "keep"
//!   criteria — hysteresis) so word gaps don't chop speech. The windows
//!   captured just before the gate opened are kept in a small pre-roll and
//!   sent first, so the first syllable survives the confirmation delay.
//!
//! Everything here is pure (no I/O; the only clock is the `now` passed in),
//! so it is unit-tested with synthetic signals below.

use nnnoiseless::DenoiseState;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::{Duration, Instant};

/// 20 ms at 48 kHz mono — the capture/Opus window.
pub const FRAME: usize = 960;
/// RNNoise works on 10 ms (480-sample) frames: two per capture window.
const SUB: usize = DenoiseState::FRAME_SIZE;

// ── Manual mode (unchanged behaviour) ──────────────────────────────────────

/// How long a stream keeps transmitting after last clearing `threshold`, so a
/// brief mid-word RMS dip (soft consonant, breath pause) doesn't chop real
/// speech at the source — mirrors the server mixer's old VAD_HANGOVER_FRAMES
/// (10 frames @ 20 ms = 200 ms).
pub const SEND_GATE_HANGOVER: Duration = Duration::from_millis(200);

/// Whether this 20 ms window should be encoded and transmitted: true if its RMS
/// clears `threshold`, or if it's within `SEND_GATE_HANGOVER` of the last window
/// that did. Updates `last_above` as a side effect. (Formerly capture.rs's
/// `should_send`, which read `Instant::now()` itself; the clock is a parameter
/// now so tests can drive it — the capture path passes `Instant::now()`.)
pub fn should_send_at(last_above: &mut Option<Instant>, threshold: f32, rms: f32, now: Instant) -> bool {
    if rms >= threshold {
        *last_above = Some(now);
        true
    } else {
        matches!(last_above, Some(t) if now.saturating_duration_since(*t) < SEND_GATE_HANGOVER)
    }
}

// ── Shared, live-updatable config ──────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadMode {
    Manual,
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sensitivity {
    Low,
    Normal,
    High,
}

impl Sensitivity {
    pub fn parse(s: &str) -> Self {
        match s {
            "low" => Sensitivity::Low,
            "high" => Sensitivity::High,
            _ => Sensitivity::Normal,
        }
    }
}

/// Live voice-activation settings, read by the capture callback every window.
/// Lives in `AudioState` so it survives start/stop_capture, like the threshold.
pub struct VadShared {
    mode: AtomicU8,
    suppression: AtomicBool,
    sensitivity: AtomicU8,
}

impl Default for VadShared {
    /// Defaults match the JS defaults (voiceActivation.js): Auto, suppression
    /// on, normal sensitivity — so a capture started before the engine pushes
    /// its config (e.g. a strip mic test) already behaves like the default.
    fn default() -> Self {
        Self {
            mode: AtomicU8::new(1),
            suppression: AtomicBool::new(true),
            sensitivity: AtomicU8::new(1),
        }
    }
}

impl VadShared {
    pub fn set(&self, mode: VadMode, suppression: bool, sensitivity: Sensitivity) {
        self.mode.store(if mode == VadMode::Auto { 1 } else { 0 }, Ordering::Relaxed);
        self.suppression.store(suppression, Ordering::Relaxed);
        self.sensitivity.store(
            match sensitivity { Sensitivity::Low => 0, Sensitivity::Normal => 1, Sensitivity::High => 2 },
            Ordering::Relaxed,
        );
    }
    pub fn mode(&self) -> VadMode {
        if self.mode.load(Ordering::Relaxed) == 1 { VadMode::Auto } else { VadMode::Manual }
    }
    pub fn suppression(&self) -> bool {
        self.suppression.load(Ordering::Relaxed)
    }
    pub fn sensitivity(&self) -> Sensitivity {
        match self.sensitivity.load(Ordering::Relaxed) {
            0 => Sensitivity::Low,
            2 => Sensitivity::High,
            _ => Sensitivity::Normal,
        }
    }
}

// ── Levels ────────────────────────────────────────────────────────────────

/// Lowest level we track: digital silence would otherwise be -inf dB.
pub const MIN_DB: f32 = -100.0;

/// RMS (i16 scale) → dBFS.
pub fn rms_to_db(rms: f32) -> f32 {
    if rms <= 0.0 { MIN_DB } else { (20.0 * (rms / 32_768.0).log10()).max(MIN_DB) }
}

/// dBFS → RMS (i16 scale).
pub fn db_to_rms(db: f32) -> f32 {
    32_768.0 * 10f32.powf(db / 20.0)
}

pub fn frame_rms(f: &[i16]) -> f32 {
    if f.is_empty() { return 0.0; }
    (f.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / f.len() as f64).sqrt() as f32
}

// ── Noise-floor tracker (minimum statistics) ───────────────────────────────

/// Windows per sub-window (25 × 20 ms = 500 ms).
const FLOOR_SUB_FRAMES: usize = 25;
/// Sub-windows remembered (6 × 500 ms = 3 s search window).
const FLOOR_SUBS: usize = 6;
/// The minimum of a fluctuating noise level sits below its mean; compensate.
const FLOOR_BIAS_DB: f32 = 1.5;

/// Tracks the background level as the minimum of a lightly smoothed level
/// over the last ~3 s (Martin-style minimum statistics). Speech always has
/// short gaps (between words, breaths), so the minimum keeps following the
/// noise even while someone talks — no need to freeze it while the gate is
/// open. It falls immediately when the noise drops (the current sub-window is
/// part of the minimum) and rises only once a full 3 s window sits above the
/// old floor — i.e. a fan switching on is learned within ~3 s, while a long
/// sentence can't pull the floor up to the voice.
pub struct NoiseFloor {
    smooth_db: f32,
    sub_min: f32,
    sub_count: usize,
    subs: [f32; FLOOR_SUBS],
    subs_filled: usize,
    subs_idx: usize,
    floor_db: f32,
    initialized: bool,
}

impl Default for NoiseFloor {
    fn default() -> Self { Self::new() }
}

impl NoiseFloor {
    pub fn new() -> Self {
        Self {
            smooth_db: MIN_DB,
            sub_min: f32::INFINITY,
            sub_count: 0,
            subs: [f32::INFINITY; FLOOR_SUBS],
            subs_filled: 0,
            subs_idx: 0,
            floor_db: MIN_DB,
            initialized: false,
        }
    }

    /// Feed one 20 ms window's level; returns the updated floor (dBFS).
    pub fn update(&mut self, level_db: f32) -> f32 {
        let level_db = level_db.max(MIN_DB);
        if !self.initialized {
            self.smooth_db = level_db;
            self.floor_db = level_db;
            self.initialized = true;
        } else {
            // ~60 ms EMA: knocks the variance down without hiding word gaps.
            self.smooth_db += 0.3 * (level_db - self.smooth_db);
        }
        self.sub_min = self.sub_min.min(self.smooth_db);
        self.sub_count += 1;
        if self.sub_count >= FLOOR_SUB_FRAMES {
            self.subs[self.subs_idx] = self.sub_min;
            self.subs_idx = (self.subs_idx + 1) % FLOOR_SUBS;
            self.subs_filled = (self.subs_filled + 1).min(FLOOR_SUBS);
            self.sub_min = f32::INFINITY;
            self.sub_count = 0;
        }
        let mut raw_min = self.sub_min;
        for m in &self.subs[..self.subs_filled] {
            raw_min = raw_min.min(*m);
        }
        if !raw_min.is_finite() { raw_min = self.smooth_db; }
        let target = (raw_min + FLOOR_BIAS_DB).max(MIN_DB);
        // Fall fast, rise gently (the window minimum already rises late).
        let k = if target < self.floor_db { 0.5 } else { 0.1 };
        self.floor_db += k * (target - self.floor_db);
        self.floor_db
    }

    #[cfg(test)]
    pub fn floor_db(&self) -> f32 { self.floor_db }
}

// ── Gate state machine ─────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub struct GateParams {
    /// Voice probability needed to count a window toward opening.
    pub vad_open: f32,
    /// Voice probability that keeps an open gate open (hysteresis).
    pub vad_keep: f32,
    /// Level above the noise floor needed to open (dB).
    pub margin_open_db: f32,
    /// Level above the noise floor that keeps the gate open (dB).
    pub margin_keep_db: f32,
    /// Absolute level below which nothing opens the gate (dBFS).
    pub abs_min_db: f32,
    /// Level modulation (max − min over the last `SPREAD_FRAMES`) needed to
    /// open / to stay open (dB). Speech always dips between syllables; a fan,
    /// hum or steady game drone doesn't. RNNoise alone isn't enough here: its
    /// voice probability climbs towards 1.0 on LOUD steady noise (measured:
    /// ~0.99 on low-passed noise at -35 dBFS, ~0.7 on white noise at -20 dBFS),
    /// so without this a noise that starts suddenly would hold the gate open
    /// until the floor tracker caught up (~3 s).
    pub spread_open_db: f32,
    pub spread_keep_db: f32,
    /// Consecutive qualifying windows needed to open.
    pub confirm: u32,
    /// Windows held open after the last qualifying window.
    pub hangover: u32,
}

/// 16 × 20 ms = 320 ms hold before the gate closes.
pub const AUTO_HANGOVER_FRAMES: u32 = 16;
/// 2 × 20 ms windows of onset confirmation.
pub const AUTO_CONFIRM_FRAMES: u32 = 2;
/// Windows kept from before the gate opened and sent first (40 ms).
pub const PRE_ROLL_FRAMES: usize = 2;

impl GateParams {
    pub fn for_sensitivity(s: Sensitivity) -> Self {
        let (vad_open, vad_keep, margin_open_db, abs_min_db) = match s {
            Sensitivity::Low => (0.85, 0.50, 12.0, -60.0),
            Sensitivity::Normal => (0.70, 0.40, 9.0, -66.0),
            Sensitivity::High => (0.50, 0.25, 6.0, -72.0),
        };
        Self {
            vad_open,
            vad_keep,
            margin_open_db,
            margin_keep_db: margin_open_db - 4.0,
            abs_min_db,
            spread_open_db: 6.0,
            spread_keep_db: 3.0,
            confirm: AUTO_CONFIRM_FRAMES,
            hangover: AUTO_HANGOVER_FRAMES,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateStep {
    /// Closed, this window is not sent.
    Closed,
    /// Just opened on this window: send the pre-roll, then this window.
    Opened,
    /// Open (talking or in hangover): send this window.
    Open,
    /// Hangover ran out on this window: not sent, gate now closed.
    Closing,
}

impl GateStep {
    pub fn sends(self) -> bool { matches!(self, GateStep::Opened | GateStep::Open) }
}

#[derive(Default)]
pub struct Gate {
    open: bool,
    streak: u32,
    hang: u32,
}

impl Gate {
    #[cfg(test)]
    pub fn is_open(&self) -> bool { self.open }

    pub fn reset(&mut self) { *self = Gate::default(); }

    /// `spread_db`: level modulation over the recent past (see `LevelSpread`).
    pub fn step(&mut self, p: &GateParams, level_db: f32, floor_db: f32, vad: f32, spread_db: f32) -> GateStep {
        let opens = vad >= p.vad_open
            && level_db >= floor_db + p.margin_open_db
            && level_db >= p.abs_min_db
            && spread_db >= p.spread_open_db;
        if !self.open {
            if opens {
                self.streak += 1;
                if self.streak >= p.confirm {
                    self.open = true;
                    self.streak = 0;
                    self.hang = p.hangover;
                    return GateStep::Opened;
                }
            } else {
                self.streak = 0;
            }
            return GateStep::Closed;
        }
        let keeps = opens
            || (vad >= p.vad_keep
                && level_db >= floor_db + p.margin_keep_db
                && level_db >= p.abs_min_db
                && spread_db >= p.spread_keep_db);
        if keeps {
            self.hang = p.hangover;
            GateStep::Open
        } else if self.hang > 1 {
            self.hang -= 1;
            GateStep::Open
        } else {
            self.open = false;
            self.hang = 0;
            GateStep::Closing
        }
    }
}

/// Windows in the modulation look-back (25 × 20 ms = 500 ms).
pub const SPREAD_FRAMES: usize = 25;

/// max − min of the window level over the last `SPREAD_FRAMES` windows.
pub struct LevelSpread {
    hist: [f32; SPREAD_FRAMES],
    idx: usize,
    filled: usize,
}

impl Default for LevelSpread {
    fn default() -> Self { Self { hist: [MIN_DB; SPREAD_FRAMES], idx: 0, filled: 0 } }
}

impl LevelSpread {
    pub fn push(&mut self, level_db: f32) -> f32 {
        self.hist[self.idx] = level_db;
        self.idx = (self.idx + 1) % SPREAD_FRAMES;
        self.filled = (self.filled + 1).min(SPREAD_FRAMES);
        let h = &self.hist[..self.filled];
        let (lo, hi) = h.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &x| (lo.min(x), hi.max(x)));
        hi - lo
    }
}

// ── The processor the capture callback drives ──────────────────────────────

/// What one 20 ms window produced: frames to encode+send (oldest first) and
/// the meter/indicator data for `specter://audio-level`.
pub struct Outcome<'a> {
    pub send: &'a [Vec<i16>],
    pub rms: f32,
    pub floor_rms: f32,
    /// RNNoise voice probability (max of the two 10 ms halves); None in Manual.
    pub vad: Option<f32>,
    /// Whether this window is transmitted (manual: should_send; auto: gate).
    pub gate: bool,
    /// What the local "speaking" indicators should show. Manual keeps the old
    /// semantics (raw RMS ≥ threshold, no hangover); Auto = gate open.
    pub speaking: bool,
    pub mode: VadMode,
}

pub struct VoiceProcessor {
    floor: NoiseFloor,
    spread: LevelSpread,
    gate: Gate,
    last_above: Option<Instant>,
    denoise: Option<Box<DenoiseState<'static>>>,
    pre_roll: VecDeque<Vec<i16>>,
    out: Vec<Vec<i16>>,
    last_mode: VadMode,
    in_f: [f32; SUB],
    out_f: [f32; SUB],
}

impl Default for VoiceProcessor {
    fn default() -> Self { Self::new() }
}

impl VoiceProcessor {
    pub fn new() -> Self {
        Self {
            floor: NoiseFloor::new(),
            spread: LevelSpread::default(),
            gate: Gate::default(),
            last_above: None,
            denoise: None,
            pre_roll: VecDeque::with_capacity(PRE_ROLL_FRAMES + 1),
            out: Vec::with_capacity(PRE_ROLL_FRAMES + 1),
            last_mode: VadMode::Manual,
            in_f: [0.0; SUB],
            out_f: [0.0; SUB],
        }
    }

    /// Process one 20 ms window (`frame.len() == FRAME`).
    pub fn process(
        &mut self,
        frame: Vec<i16>,
        mode: VadMode,
        threshold: f32,
        suppression: bool,
        sensitivity: Sensitivity,
        now: Instant,
    ) -> Outcome<'_> {
        debug_assert_eq!(frame.len(), FRAME);
        self.out.clear();
        if mode != self.last_mode {
            // Fresh state on a mode switch: no stale pre-roll or half-open gate.
            self.gate.reset();
            self.pre_roll.clear();
            self.last_above = None;
            self.last_mode = mode;
        }

        let rms = frame_rms(&frame);
        let level_db = rms_to_db(rms);
        // The floor is cheap, so it's tracked in both modes (the meter shows it).
        let floor_db = self.floor.update(level_db);
        let floor_rms = db_to_rms(floor_db);
        let spread_db = self.spread.push(level_db);

        if mode == VadMode::Manual {
            let send = should_send_at(&mut self.last_above, threshold, rms, now);
            if send { self.out.push(frame); }
            return Outcome {
                send: &self.out,
                rms,
                floor_rms,
                vad: None,
                gate: send,
                speaking: rms >= threshold,
                mode,
            };
        }

        // Auto: RNNoise over both 10 ms halves for the voice probability (and
        // the denoised PCM when suppression is on).
        let dn = self.denoise.get_or_insert_with(DenoiseState::new);
        let mut vad: f32 = 0.0;
        let mut processed = if suppression { Vec::with_capacity(FRAME) } else { Vec::new() };
        for half in frame.chunks_exact(SUB) {
            for (d, &s) in self.in_f.iter_mut().zip(half) { *d = s as f32; }
            let p = dn.process_frame(&mut self.out_f, &self.in_f);
            vad = vad.max(p);
            if suppression {
                processed.extend(self.out_f.iter().map(|&x| x.clamp(-32_768.0, 32_767.0) as i16));
            }
        }
        let tx = if suppression { processed } else { frame };

        let params = GateParams::for_sensitivity(sensitivity);
        let step = self.gate.step(&params, level_db, floor_db, vad, spread_db);
        match step {
            GateStep::Opened => {
                self.out.extend(self.pre_roll.drain(..));
                self.out.push(tx);
            }
            GateStep::Open => self.out.push(tx),
            GateStep::Closed | GateStep::Closing => {
                self.pre_roll.push_back(tx);
                while self.pre_roll.len() > PRE_ROLL_FRAMES { self.pre_roll.pop_front(); }
            }
        }
        let gate = step.sends();
        Outcome { send: &self.out, rms, floor_rms, vad: Some(vad), gate, speaking: gate, mode }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Synthetic signal helpers (deterministic) ──────────────────────────

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((self.0 >> 33) as f32 / (1u64 << 31) as f32) * 2.0 - 1.0
        }
    }

    /// Low-passed noise ("fan") at roughly the given RMS.
    fn fan(rng: &mut Lcg, frames: usize, rms: f32) -> Vec<Vec<i16>> {
        let mut y = 0.0f32;
        let mut out = Vec::new();
        for _ in 0..frames {
            let mut f = Vec::with_capacity(FRAME);
            for _ in 0..FRAME {
                y += 0.15 * (rng.next() - y);
                f.push((y * rms * 4.5).clamp(-32_768.0, 32_767.0) as i16);
            }
            out.push(f);
        }
        out
    }

    fn silence(frames: usize) -> Vec<Vec<i16>> {
        vec![vec![0i16; FRAME]; frames]
    }

    fn add(a: &mut [Vec<i16>], b: &[Vec<i16>]) {
        for (fa, fb) in a.iter_mut().zip(b) {
            for (x, y) in fa.iter_mut().zip(fb) {
                *x = (*x as i32 + *y as i32).clamp(-32_768, 32_767) as i16;
            }
        }
    }

    /// Vowel-like: 110-140 Hz glottal pulse train through three formant
    /// resonators, syllable-rate amplitude envelope (~4 Hz).
    fn voice(frames: usize, peak: f32, t0: usize) -> Vec<Vec<i16>> {
        let fs = 48_000.0f32;
        let formants = [(700.0f32, 130.0f32), (1220.0, 70.0), (2600.0, 160.0)];
        let mut st = [(0.0f32, 0.0f32); 3];
        let coef: Vec<(f32, f32)> = formants.iter().map(|&(f, bw)| {
            let r = (-std::f32::consts::PI * bw / fs).exp();
            (2.0 * r * (2.0 * std::f32::consts::PI * f / fs).cos(), -r * r)
        }).collect();
        let mut phase = 0.0f32;
        let mut out = Vec::new();
        for fi in 0..frames {
            let mut f = Vec::with_capacity(FRAME);
            for i in 0..FRAME {
                let n = (t0 + fi * FRAME + i) as f32 / fs;
                let f0 = 120.0 + 15.0 * (2.0 * std::f32::consts::PI * 3.0 * n).sin();
                phase += f0 / fs;
                let pulse = if phase >= 1.0 { phase -= 1.0; 1.0 } else { 0.0 };
                let mut x = pulse;
                for (k, &(a1, a2)) in coef.iter().enumerate() {
                    let y = x + a1 * st[k].0 + a2 * st[k].1;
                    st[k].1 = st[k].0;
                    st[k].0 = y;
                    x = y;
                }
                let env = 0.55 + 0.45 * (2.0 * std::f32::consts::PI * 4.0 * n).sin();
                f.push(x * env);
            }
            out.push(f);
        }
        // Normalise to the requested peak.
        let m = out.iter().flatten().fold(0.0f32, |m, &x| m.max(x.abs())).max(1e-6);
        out.into_iter()
            .map(|f| f.into_iter().map(|x| (x / m * peak) as i16).collect())
            .collect()
    }

    /// Keyboard typing: a sharp decaying click (~4 ms) every ~150 ms.
    fn clicks(rng: &mut Lcg, frames: usize, amp: f32) -> Vec<Vec<i16>> {
        let total = frames * FRAME;
        let mut s = vec![0f32; total];
        let mut t = 2_000usize;
        while t < total {
            for k in 0..200 {
                if t + k < total {
                    s[t + k] += rng.next() * amp * (-(k as f32) / 40.0).exp();
                }
            }
            t += 6_000 + (rng.next().abs() * 3_000.0) as usize;
        }
        s.chunks(FRAME).map(|c| c.iter().map(|&x| x as i16).collect()).collect()
    }

    fn run(p: &mut VoiceProcessor, frames: &[Vec<i16>], mode: VadMode, thr: f32) -> (Vec<bool>, usize) {
        let mut gates = Vec::new();
        let mut sent = 0;
        let t0 = Instant::now();
        for (i, f) in frames.iter().enumerate() {
            let now = t0 + Duration::from_millis(20 * i as u64);
            let o = p.process(f.clone(), mode, thr, true, Sensitivity::Normal, now);
            gates.push(o.gate);
            sent += o.send.len();
        }
        (gates, sent)
    }

    // ── Noise floor ───────────────────────────────────────────────────────

    #[test]
    fn floor_tracks_steady_noise_and_ignores_speech_bursts() {
        let mut nf = NoiseFloor::new();
        // 3 s of -60 dB background.
        for _ in 0..150 { nf.update(-60.0); }
        assert!((nf.floor_db() + 60.0).abs() < 2.5, "floor {}", nf.floor_db());
        // 10 s of speech bursts at -25 dB with 100 ms gaps every 600 ms.
        for i in 0..500 {
            let lvl = if i % 30 < 25 { -25.0 } else { -60.0 };
            nf.update(lvl);
        }
        assert!(nf.floor_db() < -50.0, "speech pulled the floor up to {}", nf.floor_db());
    }

    #[test]
    fn floor_learns_a_fan_switching_on_within_seconds_and_drops_fast() {
        let mut nf = NoiseFloor::new();
        for _ in 0..150 { nf.update(-70.0); }
        for _ in 0..250 { nf.update(-45.0); } // 5 s of fan
        assert!(nf.floor_db() > -48.0, "fan not learned: {}", nf.floor_db());
        for _ in 0..10 { nf.update(-70.0); } // fan off: 200 ms
        assert!(nf.floor_db() < -60.0, "floor slow to drop: {}", nf.floor_db());
    }

    #[test]
    fn floor_handles_digital_silence() {
        let mut nf = NoiseFloor::new();
        for _ in 0..100 { nf.update(rms_to_db(0.0)); }
        assert!(nf.floor_db().is_finite() && nf.floor_db() < -95.0, "floor {}", nf.floor_db());
    }

    // ── Gate state machine (injected voice probability) ────────────────────

    fn p() -> GateParams { GateParams::for_sensitivity(Sensitivity::Normal) }

    #[test]
    fn gate_needs_confirmation_then_holds_for_hangover() {
        let mut g = Gate::default();
        let pp = p();
        assert_eq!(g.step(&pp, -30.0, -60.0, 0.95, 30.0), GateStep::Closed);
        assert_eq!(g.step(&pp, -30.0, -60.0, 0.95, 30.0), GateStep::Opened);
        assert_eq!(g.step(&pp, -30.0, -60.0, 0.95, 30.0), GateStep::Open);
        // Silence: held for hangover windows, then closes.
        let mut held = 0;
        loop {
            match g.step(&pp, -60.0, -60.0, 0.02, 30.0) {
                GateStep::Open => held += 1,
                GateStep::Closing => break,
                s => panic!("unexpected {s:?}"),
            }
        }
        assert_eq!(held, AUTO_HANGOVER_FRAMES - 1);
        assert!(!g.is_open());
        let ms = (held + 1) * 20;
        assert!((250..=400).contains(&ms), "hangover {ms} ms");
    }

    #[test]
    fn single_click_windows_never_open_even_with_vad_spikes() {
        let mut g = Gate::default();
        let pp = p();
        // A click every 7 windows: loud, and a worst-case VAD spike.
        for i in 0..500 {
            let (lvl, v) = if i % 7 == 0 { (-20.0, 0.9) } else { (-60.0, 0.05) };
            assert!(!g.step(&pp, lvl, -60.0, v, 40.0).sends(), "click opened the gate at {i}");
        }
    }

    #[test]
    fn hysteresis_keeps_soft_word_endings_without_chatter() {
        let mut g = Gate::default();
        let pp = p();
        g.step(&pp, -30.0, -60.0, 0.9, 30.0);
        assert_eq!(g.step(&pp, -30.0, -60.0, 0.9, 30.0), GateStep::Opened);
        // Trailing-off syllable: below the open criteria but above keep.
        for _ in 0..40 {
            assert_eq!(g.step(&pp, -54.0, -60.0, 0.5, 8.0), GateStep::Open);
        }
        // Count transitions over alternating speech / short pause: one open run.
        let mut transitions = 0;
        let mut last = true;
        for i in 0..300 {
            let talking = (i / 10) % 2 == 0; // 200 ms on/off
            let s = g.step(&pp, if talking { -30.0 } else { -60.0 }, -60.0, if talking { 0.9 } else { 0.05 }, 30.0);
            if s.sends() != last { transitions += 1; last = s.sends(); }
        }
        assert_eq!(transitions, 0, "gate chattered through 200 ms pauses");
    }

    #[test]
    fn loud_steady_non_voice_noise_does_not_open() {
        let mut g = Gate::default();
        let pp = p();
        for _ in 0..500 {
            assert!(!g.step(&pp, -30.0, -60.0, 0.1, 30.0).sends());
        }
    }

    #[test]
    fn stationary_noise_with_high_vad_does_not_open_and_closes_an_open_gate() {
        // RNNoise reports ~0.99 on loud steady noise; the floor hasn't caught
        // up yet (level 25 dB above it) — the missing modulation must block it.
        let mut g = Gate::default();
        let pp = p();
        for _ in 0..200 {
            assert!(!g.step(&pp, -35.0, -60.0, 0.99, 1.5).sends());
        }
        // Gate already open (fan switched on mid-sentence): closes after hangover.
        let mut g = Gate::default();
        g.step(&pp, -30.0, -60.0, 0.9, 30.0);
        g.step(&pp, -30.0, -60.0, 0.9, 30.0);
        let open = (0..100).take_while(|_| g.step(&pp, -35.0, -60.0, 0.99, 1.5).sends()).count();
        assert_eq!(open as u32, AUTO_HANGOVER_FRAMES - 1);
    }

    // ── Full processor (real RNNoise) on synthetic signals ────────────────

    #[test]
    fn auto_silence_never_sends() {
        let mut vp = VoiceProcessor::new();
        let (gates, sent) = run(&mut vp, &silence(250), VadMode::Auto, 150.0);
        assert!(gates.iter().all(|g| !g));
        assert_eq!(sent, 0);
    }

    #[test]
    fn auto_steady_fan_noise_never_sends() {
        let mut rng = Lcg(7);
        let mut vp = VoiceProcessor::new();
        // Loud fan: RMS ~600 (≈ -35 dBFS) — would hold a 150 manual gate open forever.
        let (gates, _) = run(&mut vp, &fan(&mut rng, 500, 600.0), VadMode::Auto, 150.0);
        let opened = gates.iter().filter(|g| **g).count();
        assert!(opened <= 5, "fan opened the gate for {opened} windows");
    }

    #[test]
    fn auto_loud_fan_switching_on_mid_session_is_short_and_never_reopens() {
        let mut rng = Lcg(13);
        // 3 s quiet room, then a loud fan (RNNoise VAD ~0.99 on it) for 8 s.
        let mut sig = fan(&mut rng, 150, 20.0);
        sig.extend(fan(&mut rng, 400, 600.0));
        let mut vp = VoiceProcessor::new();
        let (gates, _) = run(&mut vp, &sig, VadMode::Auto, 150.0);
        let open: Vec<usize> = gates.iter().enumerate().filter(|(_, g)| **g).map(|(i, _)| i).collect();
        if let Some(&last) = open.last() {
            // At most the onset transient + hangover (< ~1 s after onset at 150).
            assert!(last < 150 + 50, "fan held the gate open until window {last}");
        }
        println!("loud fan onset: {} windows transmitted", open.len());
        assert!(open.len() <= 45, "fan onset transmitted {} windows", open.len());
    }

    #[test]
    fn auto_keyboard_clicks_over_quiet_room_do_not_open() {
        let mut rng = Lcg(11);
        let mut sig = fan(&mut rng, 500, 30.0);
        add(&mut sig, &clicks(&mut rng, 500, 12_000.0));
        let mut vp = VoiceProcessor::new();
        let (gates, _) = run(&mut vp, &sig, VadMode::Auto, 150.0);
        let opened = gates.iter().filter(|g| **g).count();
        assert!(opened <= 5, "typing opened the gate for {opened} windows");
    }

    #[test]
    fn auto_voice_over_fan_opens_and_sends_pre_roll() {
        let mut rng = Lcg(3);
        // 4 s fan, then 3 s voice + fan, then 2 s fan.
        let mut sig = fan(&mut rng, 450, 200.0);
        let v = voice(150, 9_000.0, 200 * FRAME);
        add(&mut sig[200..350], &v);
        let mut vp = VoiceProcessor::new();
        let mut first_open = None;
        let mut sent_at_open = 0;
        let mut open_in_voice = 0;
        let mut open_after = 0;
        let t0 = Instant::now();
        for (i, f) in sig.iter().enumerate() {
            let o = vp.process(f.clone(), VadMode::Auto, 150.0, true, Sensitivity::Normal,
                t0 + Duration::from_millis(20 * i as u64));
            if o.gate && first_open.is_none() { first_open = Some(i); sent_at_open = o.send.len(); }
            if (200..350).contains(&i) && o.gate { open_in_voice += 1; }
            if i >= 370 && o.gate { open_after += 1; }
        }
        let first = first_open.expect("voice never opened the gate");
        assert!((200..215).contains(&first), "opened late/early at window {first}");
        assert_eq!(sent_at_open, PRE_ROLL_FRAMES + 1, "pre-roll not sent on open");
        assert!(open_in_voice >= 120, "gate open for only {open_in_voice}/150 voice windows");
        assert_eq!(open_after, 0, "gate stayed open after voice + hangover");
    }

    // ── Manual mode = the old behaviour ───────────────────────────────────

    #[test]
    fn manual_mode_matches_legacy_should_send_exactly() {
        let mut rng = Lcg(5);
        let mut sig = fan(&mut rng, 300, 80.0);
        add(&mut sig[100..160], &voice(60, 6_000.0, 100 * FRAME));
        add(&mut sig, &clicks(&mut rng, 300, 9_000.0));
        let thr = 150.0;
        let t0 = Instant::now();
        let mut vp = VoiceProcessor::new();
        let mut legacy_last: Option<Instant> = None;
        for (i, f) in sig.iter().enumerate() {
            let now = t0 + Duration::from_millis(20 * i as u64);
            // Legacy capture.rs inline computation.
            let rms = (f.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / 960.0).sqrt() as f32;
            let legacy = should_send_at(&mut legacy_last, thr, rms, now);
            let o = vp.process(f.clone(), VadMode::Manual, thr, true, Sensitivity::Normal, now);
            assert_eq!(o.gate, legacy, "window {i}");
            assert_eq!(o.speaking, rms >= thr, "window {i}");
            assert_eq!(o.rms, rms);
            assert!(o.vad.is_none());
            if legacy {
                assert_eq!(o.send.len(), 1);
                assert_eq!(&o.send[0], f, "manual mode altered the PCM (window {i})");
            } else {
                assert!(o.send.is_empty());
            }
        }
        assert!(vp.denoise.is_none(), "manual mode must not run RNNoise");
    }

    #[test]
    fn manual_hangover_is_200ms() {
        let t0 = Instant::now();
        let mut last = None;
        assert!(should_send_at(&mut last, 100.0, 200.0, t0));
        assert!(should_send_at(&mut last, 100.0, 10.0, t0 + Duration::from_millis(180)));
        assert!(!should_send_at(&mut last, 100.0, 10.0, t0 + Duration::from_millis(200)));
    }

    /// CPU cost of Auto mode per 20 ms window. Run with
    /// `cargo test --release -p tauri-plugin-specter-audio vad_cost -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn vad_cost() {
        let mut rng = Lcg(9);
        let sig = fan(&mut rng, 1000, 300.0);
        let mut vp = VoiceProcessor::new();
        let t = Instant::now();
        for f in &sig {
            let _ = vp.process(f.clone(), VadMode::Auto, 150.0, true, Sensitivity::Normal, Instant::now());
        }
        let per = t.elapsed().as_secs_f64() * 1e6 / sig.len() as f64;
        println!("auto+suppression: {per:.1} us per 20 ms window ({:.2}% of one core)", per / 200.0);
        let mut vp = VoiceProcessor::new();
        let t = Instant::now();
        for f in &sig {
            let _ = vp.process(f.clone(), VadMode::Manual, 150.0, true, Sensitivity::Normal, Instant::now());
        }
        let per = t.elapsed().as_secs_f64() * 1e6 / sig.len() as f64;
        println!("manual: {per:.2} us per 20 ms window");
        let t = Instant::now();
        let _ = DenoiseState::new();
        println!("DenoiseState::new: {:.2} ms", t.elapsed().as_secs_f64() * 1e3);
        // Voice-probability distributions on the synthetic signals.
        let stats = |name: &str, frames: &[Vec<i16>]| {
            let mut vp = VoiceProcessor::new();
            let mut v: Vec<f32> = frames.iter()
                .map(|f| vp.process(f.clone(), VadMode::Auto, 150.0, true, Sensitivity::Normal, Instant::now()).vad.unwrap())
                .collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!("{name}: vad p50={:.2} p90={:.2} p99={:.2} max={:.2}",
                v[v.len() / 2], v[v.len() * 9 / 10], v[v.len() * 99 / 100], v[v.len() - 1]);
        };
        let mut rng = Lcg(1);
        stats("fan", &fan(&mut rng, 300, 600.0));
        stats("clicks", &clicks(&mut rng, 300, 12_000.0));
        stats("voice", &voice(300, 9_000.0, 0));
        let white = |rng: &mut Lcg, a: f32| -> Vec<Vec<i16>> {
            (0..300).map(|_| (0..FRAME).map(|_| (rng.next() * a) as i16).collect()).collect()
        };
        stats("white 300", &white(&mut rng, 300.0));
        stats("white 3000", &white(&mut rng, 3000.0));
        let mut b = 0.0f32;
        let brown: Vec<Vec<i16>> = (0..300).map(|_| (0..FRAME).map(|_| { b = 0.995 * b + 0.1 * rng.next(); (b * 3000.0) as i16 }).collect()).collect();
        stats("brown", &brown);
        stats("fan 60", &fan(&mut rng, 300, 60.0));
    }
}
