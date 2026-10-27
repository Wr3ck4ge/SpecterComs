/// Streaming linear-interpolation resampler for mono i16 PCM.
///
/// Used when a capture or playback device doesn't support 48 kHz natively
/// (e.g. some USB/virtual-mixer devices only expose 16 kHz or 44.1 kHz for
/// the mic side). Without this, code that hardcodes "960 samples = 20 ms"
/// (the Opus frame assumption) silently mis-times audio captured at a
/// different rate — e.g. 960 samples at 16 kHz is actually 60 ms of real
/// audio, so it gets encoded/played back 3x too fast (pitched-up "chipmunk"
/// audio). This resampler normalizes the sample rate before that assumption
/// is ever made, regardless of what rate the device actually delivers.
///
/// State (`pos` and `prev`) carries across calls to `process`, so audio
/// stays continuous across the arbitrarily-sized chunks a cpal callback
/// hands over — there's no fixed input/output chunk size requirement.
pub struct LinearResampler {
    /// output_rate / input_rate.
    ratio: f64,
    /// Fractional read position, in units of input samples, relative to the
    /// start of the *next* call's input slice (can be negative, meaning it
    /// falls within `prev`'s slot).
    pos: f64,
    /// Last sample from the previous call, used to interpolate across the
    /// call boundary. Zero (silence) before the first call.
    prev: i16,
}

impl LinearResampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Self {
        Self {
            ratio: output_rate as f64 / input_rate as f64,
            pos: 0.0,
            prev: 0,
        }
    }

    /// Resample `input` (at the configured input rate) and append the result
    /// (at the configured output rate) to `out`.
    pub fn process(&mut self, input: &[i16], out: &mut Vec<i16>) {
        if input.is_empty() {
            return;
        }
        let step = 1.0 / self.ratio;
        loop {
            let idx0f = self.pos.floor();
            let idx0 = idx0f as isize;
            let idx1 = idx0 + 1;
            if idx1 >= input.len() as isize {
                break;
            }
            let t = self.pos - idx0f;
            let s0 = if idx0 < 0 { self.prev } else { input[idx0 as usize] };
            let s1 = input[idx1 as usize];
            let interpolated = s0 as f64 + t * (s1 as f64 - s0 as f64);
            out.push(interpolated.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16);
            self.pos += step;
        }
        self.pos -= input.len() as f64;
        self.prev = *input.last().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsamples_16k_to_48k_ratio() {
        let mut r = LinearResampler::new(16_000, 48_000);
        let mut out = Vec::new();
        // 160 samples @ 16kHz = 10ms; should produce ~480 samples @ 48kHz.
        let input: Vec<i16> = (0..160).map(|i| (i * 100) as i16).collect();
        r.process(&input, &mut out);
        assert!((out.len() as i64 - 480).abs() <= 3, "got {} samples", out.len());
    }

    #[test]
    fn downsamples_96k_to_48k_ratio() {
        let mut r = LinearResampler::new(96_000, 48_000);
        let mut out = Vec::new();
        let input: Vec<i16> = (0..960).map(|i| (i % 100) as i16).collect();
        r.process(&input, &mut out);
        assert!((out.len() as i64 - 480).abs() <= 3, "got {} samples", out.len());
    }

    #[test]
    fn passthrough_when_rates_match() {
        // ratio == 1.0: after the one-sample startup transient (no `prev` yet
        // on the very first call), each call of N inputs yields N outputs at
        // t=0 (exact passthrough), so a single isolated call is one sample
        // short — later calls make it up via the carried-over `prev`.
        let mut r = LinearResampler::new(48_000, 48_000);
        let mut out = Vec::new();
        let input: Vec<i16> = vec![100, 200, 300, 400, -500];
        r.process(&input, &mut out);
        assert_eq!(out, vec![100, 200, 300, 400]);

        let input2: Vec<i16> = vec![-600, 700];
        r.process(&input2, &mut out);
        assert_eq!(&out[4..], &[-500, -600]);
    }

    #[test]
    fn continuous_across_calls() {
        let mut r = LinearResampler::new(16_000, 48_000);
        let mut out = Vec::new();
        for _ in 0..10 {
            let input: Vec<i16> = vec![1000; 37]; // odd, irregular chunk size on purpose
            r.process(&input, &mut out);
        }
        // Steady-state input of a constant value should resample to (approximately)
        // that same constant value throughout, with no NaN/garbage.
        assert!(out.iter().skip(10).all(|&s| (s - 1000).abs() <= 1));
    }
}
