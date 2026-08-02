use audiopus::{coder::Encoder, Application, Channels, SampleRate};

pub struct OpusEncoder {
    encoder: Encoder,
    frame_size: usize,
    output_buf: Vec<u8>,
}

impl OpusEncoder {
    pub fn new(sample_rate: u32, channels: u8, frame_size: usize) -> Result<Self, String> {
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

        let encoder = Encoder::new(sr, ch, Application::Voip)
            .map_err(|e| format!("Opus encoder creation failed: {:?}", e))?;

        Ok(Self {
            encoder,
            frame_size,
            output_buf: vec![0u8; 4000], // Max Opus packet size
        })
    }

    pub fn encode(&mut self, pcm: &[i16]) -> Result<Vec<u8>, String> {
        if pcm.len() != self.frame_size {
            return Err(format!(
                "Expected {} samples, got {}",
                self.frame_size,
                pcm.len()
            ));
        }

        let len = self
            .encoder
            .encode(pcm, &mut self.output_buf)
            .map_err(|e| format!("Opus encode error: {:?}", e))?;

        Ok(self.output_buf[..len].to_vec())
    }
}
