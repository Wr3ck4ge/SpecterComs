use audiopus::{coder::Encoder, Application, Bitrate, Channels, SampleRate};

pub struct OpusEncoder {
    encoder: Encoder,
    frame_size: usize,
    channels: usize,
    output_buf: Vec<u8>,
}

impl OpusEncoder {
    /// Voice encoder (OPUS_APPLICATION_VOIP, libopus default bitrate). The
    /// mic path in capture.rs; unchanged.
    pub fn new(sample_rate: u32, channels: u8, frame_size: usize) -> Result<Self, String> {
        Self::with_application(sample_rate, channels, frame_size, Application::Voip)
    }

    /// Share-audio encoder: 48 kHz stereo, OPUS_APPLICATION_AUDIO (music/game
    /// audio; VOIP mode's speech-oriented filtering and bandwidth choices
    /// audibly flatten music), fixed target bitrate. A separate instance from
    /// the voice encoder: Opus encoders are stateful and per-stream.
    /// `frame_size` is per channel (960 = 20 ms).
    pub fn new_music(frame_size: usize, bitrate_bps: i32) -> Result<Self, String> {
        let mut enc = Self::with_application(48_000, 2, frame_size, Application::Audio)?;
        enc.encoder
            .set_bitrate(Bitrate::BitsPerSecond(bitrate_bps))
            .map_err(|e| format!("Opus set_bitrate({bitrate_bps}) failed: {:?}", e))?;
        Ok(enc)
    }

    fn with_application(sample_rate: u32, channels: u8, frame_size: usize, app: Application) -> Result<Self, String> {
        let sr = match sample_rate {
            48_000 => SampleRate::Hz48000,
            24_000 => SampleRate::Hz24000,
            16_000 => SampleRate::Hz16000,
            12_000 => SampleRate::Hz12000,
            8_000 => SampleRate::Hz8000,
            _ => return Err(format!("Unsupported sample rate: {}", sample_rate)),
        };
        let ch = match channels {
            1 => Channels::Mono,
            2 => Channels::Stereo,
            _ => return Err("Only mono or stereo supported".into()),
        };

        let encoder = Encoder::new(sr, ch, app)
            .map_err(|e| format!("Opus encoder creation failed: {:?}", e))?;

        Ok(Self {
            encoder,
            frame_size,
            channels: channels as usize,
            output_buf: vec![0u8; 4000], // Max Opus packet size
        })
    }

    pub fn encode(&mut self, pcm: &[i16]) -> Result<Vec<u8>, String> {
        if pcm.len() != self.frame_size * self.channels {
            return Err(format!(
                "Expected {} samples, got {}",
                self.frame_size * self.channels,
                pcm.len()
            ));
        }

        let len = self
            .encoder
            .encode(pcm, &mut self.output_buf)
            .map_err(|e| format!("Opus encode error: {:?}", e))?;

        Ok(self.output_buf[..len].to_vec())
    }

    /// Encode one frame of interleaved f32 PCM (`frame_size * channels` samples).
    pub fn encode_f32(&mut self, pcm: &[f32]) -> Result<Vec<u8>, String> {
        if pcm.len() != self.frame_size * self.channels {
            return Err(format!(
                "Expected {} samples, got {}",
                self.frame_size * self.channels,
                pcm.len()
            ));
        }

        let len = self
            .encoder
            .encode_float(pcm, &mut self.output_buf)
            .map_err(|e| format!("Opus encode error: {:?}", e))?;

        Ok(self.output_buf[..len].to_vec())
    }
}
