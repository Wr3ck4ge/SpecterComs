//! Game / system audio capture for screen-share audio (STREAMING_PLAN S1).
//!
//! WASAPI *process* loopback (Windows 10 2004 / build 19041+):
//! `ActivateAudioInterfaceAsync` on the virtual device
//! `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` with
//! `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` params.
//!
//! - `window:<hwnd>`: INCLUDE_TARGET_PROCESS_TREE on the window's PID, so
//!   only the shared game/app is heard.
//! - `monitor:N` (and anything else): EXCLUDE_TARGET_PROCESS_TREE on *our own*
//!   PID, so everything except SpecterComs is heard. The exclusion is the
//!   whole point: our process tree plays voice, share-audio playback and the
//!   WebView's sounds, and none of that may loop back into what we send
//!   (an echo for everyone in the channel, and a feedback loop when two
//!   people share at once).
//! - When process loopback can't be activated (older Windows, or the
//!   activation fails for any other reason) we fall back to plain loopback
//!   on the default render device. That *does* contain our own output, so
//!   the start result says `echo_risk` and the UI warns.
//!
//! Output is a continuous 48 kHz stereo f32 stream stamped in QPC
//! milliseconds (the screen-capture encoder's timebase, for A/V sync).
//! "Continuous" matters: process loopback delivers *no packets at all*
//! while the target is silent, and the Opus stream on top of this must keep
//! a steady 20 ms cadence or the receiver's jitter buffer sees every pause
//! as loss. `Timeline` fills those holes with silence, and also absorbs the
//! slow drift between the device's sample clock and QPC.
//!
//! Everything runs on one dedicated thread that owns all COM objects. The
//! only code Windows calls back into is the activation completion handler,
//! which does nothing but `SetEvent` (no panics across FFI). Errors after
//! start (device invalidated, default device switched, audio service
//! restart) tear the session down and reopen the same mode with backoff,
//! with the silence filler keeping the timeline going meanwhile.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

/// Sample rate of everything this module hands out.
pub const OUT_RATE: u32 = 48_000;
const FRAMES_PER_MS: f64 = OUT_RATE as f64 / 1000.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopbackMode {
    /// Process loopback including only the shared window's process tree.
    ProcessInclude,
    /// Process loopback of everything except our own process tree.
    ProcessExclude,
    /// Fallback: loopback of the whole default render device (contains our
    /// own playback, so echo risk).
    DeviceLoopback,
}

impl LoopbackMode {
    pub fn as_str(self) -> &'static str {
        match self {
            LoopbackMode::ProcessInclude => "process_include",
            LoopbackMode::ProcessExclude => "process_exclude",
            LoopbackMode::DeviceLoopback => "device_loopback",
        }
    }

    pub fn echo_risk(self) -> bool {
        self == LoopbackMode::DeviceLoopback
    }
}

/// What the capture should target, parsed from a capture source id
/// (`window:<hwnd-decimal>` | `monitor:N`, the same ids capture/mod.rs uses).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Window(isize),
    Everything,
}

pub fn parse_source(source_id: &str) -> Result<Target, String> {
    if let Some(h) = source_id.strip_prefix("window:") {
        let hwnd: isize = h
            .trim()
            .parse()
            .map_err(|_| format!("Invalid window source id '{source_id}'"))?;
        if hwnd == 0 {
            return Err(format!("Invalid window source id '{source_id}'"));
        }
        return Ok(Target::Window(hwnd));
    }
    // monitor:N, and any id we don't recognise: a monitor-style share hears
    // everything except us, which is also the safe default.
    Ok(Target::Everything)
}

/// QPC milliseconds: QueryPerformanceCounter * 1000 / QueryPerformanceFrequency.
/// The video capture path stamps NAL units on this same clock.
#[cfg(windows)]
pub fn qpc_now_ms() -> f64 {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let mut c = 0i64;
    let mut f = 0i64;
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
        let _ = QueryPerformanceFrequency(&mut f);
    }
    if f <= 0 {
        return 0.0;
    }
    c as f64 * 1000.0 / f as f64
}

#[cfg(not(windows))]
pub fn qpc_now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

// ── Timeline: continuity + drift correction (pure, unit-tested) ──────────────

/// Within this much of the expected position, a packet is appended as is;
/// beyond it the timeline inserts silence (packet late) or trims the packet's
/// head (packet early / overlapping already-emitted silence). Large enough
/// that normal packet-timestamp jitter never triggers a correction, small
/// enough that clock drift is corrected long before it hurts A/V sync.
const TOLERANCE_MS: f64 = 30.0;
/// While no packets arrive, emit silence once the timeline is this far
/// behind real time...
const IDLE_LAG_MS: f64 = 60.0;
/// ...bringing it up to this far behind, which leaves room for a packet that
/// is merely late (its audio then still fits without a trim).
const IDLE_KEEP_MS: f64 = 20.0;
/// A gap bigger than this isn't filled sample by sample (that would burst
/// seconds of frames at once); the anchor jumps forward instead, so frame
/// timestamps jump but stay on the QPC clock.
const MAX_GAP_FILL_MS: f64 = 1000.0;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PacketPlan {
    /// Frames of silence to emit before the packet.
    pub silence_before: usize,
    /// Frames to drop from the head of the packet.
    pub skip_front: usize,
}

/// Maps a stream of irregular, possibly-gappy capture packets onto a
/// gap-free 48 kHz sample timeline anchored to QPC time.
///
/// Sample *n* of the output has timestamp `anchor_ms + n / 48`. Callers ask
/// `plan_packet` what to do with each packet, `idle_fill` how much silence
/// to emit when nothing arrives, and report what they emitted via `advance`.
pub struct Timeline {
    anchor_ms: f64,
    emitted: u64,
}

impl Timeline {
    pub fn new(start_ms: f64) -> Self {
        Self { anchor_ms: start_ms, emitted: 0 }
    }

    /// QPC-ms timestamp of the next frame to be emitted.
    pub fn next_ms(&self) -> f64 {
        self.anchor_ms + self.emitted as f64 / FRAMES_PER_MS
    }

    pub fn advance(&mut self, frames: usize) {
        self.emitted += frames as u64;
    }

    pub fn plan_packet(&mut self, packet_start_ms: f64, frames: usize) -> PacketPlan {
        let gap = packet_start_ms - self.next_ms();
        if gap > MAX_GAP_FILL_MS {
            // Re-anchor so that the packet lands exactly at next_ms().
            self.anchor_ms += gap;
            return PacketPlan::default();
        }
        if gap > TOLERANCE_MS {
            return PacketPlan { silence_before: (gap * FRAMES_PER_MS).round() as usize, skip_front: 0 };
        }
        if gap < -TOLERANCE_MS {
            let skip = ((-gap) * FRAMES_PER_MS).round() as usize;
            return PacketPlan { silence_before: 0, skip_front: skip.min(frames) };
        }
        PacketPlan::default()
    }

    /// Frames of silence to emit now, given no packet has arrived.
    pub fn idle_fill(&mut self, now_ms: f64) -> usize {
        let lag = now_ms - self.next_ms();
        if lag > MAX_GAP_FILL_MS {
            self.anchor_ms += lag - IDLE_KEEP_MS;
            return 0;
        }
        if lag > IDLE_LAG_MS {
            return ((lag - IDLE_KEEP_MS) * FRAMES_PER_MS).round() as usize;
        }
        0
    }
}

// ── Raw sample conversion (pure, unit-tested) ────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleKind {
    F32,
    I16,
    /// 24-bit packed (3 bytes per sample).
    I24,
    /// 32-bit integer container (24-in-32 or true 32-bit; both are left-aligned).
    I32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawFormat {
    pub rate: u32,
    pub channels: u16,
    pub kind: SampleKind,
    /// Whether channel 2 is front-centre (standard WAVE order with FL|FR|FC
    /// in the mask); it's folded into L/R so surround dialogue isn't lost.
    pub center_at_2: bool,
}

impl RawFormat {
    pub fn bytes_per_sample(&self) -> usize {
        match self.kind {
            SampleKind::F32 | SampleKind::I32 => 4,
            SampleKind::I16 => 2,
            SampleKind::I24 => 3,
        }
    }
}

fn read_sample(bytes: &[u8], kind: SampleKind) -> f32 {
    match kind {
        SampleKind::F32 => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        SampleKind::I16 => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32_768.0,
        SampleKind::I24 => {
            let v = i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]) >> 8;
            v as f32 / 8_388_608.0
        }
        SampleKind::I32 => i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0,
    }
}

/// Convert `frames` frames of raw device bytes to interleaved stereo f32
/// (still at the device rate), appending to `out`.
pub fn to_stereo_f32(data: &[u8], frames: usize, fmt: &RawFormat, out: &mut Vec<f32>) {
    let ch = fmt.channels.max(1) as usize;
    let bps = fmt.bytes_per_sample();
    let block = ch * bps;
    let frames = frames.min(data.len() / block.max(1));
    out.reserve(frames * 2);
    for f in 0..frames {
        let base = f * block;
        let s = |c: usize| read_sample(&data[base + c * bps..], fmt.kind);
        let (l, r) = if ch == 1 {
            let m = s(0);
            (m, m)
        } else if ch >= 3 && fmt.center_at_2 {
            let c = s(2) * std::f32::consts::FRAC_1_SQRT_2;
            (s(0) + c, s(1) + c)
        } else {
            (s(0), s(1))
        };
        out.push(l);
        out.push(r);
    }
}

// ── Timeline health counters ─────────────────────────────────────────────────

/// What the timeline did to the captured audio. Every silence or trim frame
/// on a stream that is actually playing is an audible dropout, so these are
/// logged every few seconds and on stop.
#[derive(Clone, Debug, Default)]
pub struct TimelineStats {
    pub packets: u64,
    pub packet_frames: u64,
    /// Silence emitted while no packet was pending (`idle_fill`).
    pub idle_silence_frames: u64,
    /// Silence emitted in front of a late packet (`plan_packet`).
    pub gap_silence_frames: u64,
    /// Captured frames dropped because they overlapped what was already emitted.
    pub trimmed_frames: u64,
    /// How long after its end a packet reached us (capture → GetBuffer), ms.
    pub latency_max_ms: f64,
    pub latency_sum_ms: f64,
}

impl TimelineStats {
    pub fn summary(&self) -> String {
        let ms = |f: u64| f as f64 / FRAMES_PER_MS;
        format!(
            "packets={} audio={:.0}ms idle_silence={:.0}ms gap_silence={:.0}ms trimmed={:.0}ms latency avg={:.1}ms max={:.1}ms",
            self.packets,
            ms(self.packet_frames),
            ms(self.idle_silence_frames),
            ms(self.gap_silence_frames),
            ms(self.trimmed_frames),
            if self.packets > 0 { self.latency_sum_ms / self.packets as f64 } else { 0.0 },
            self.latency_max_ms,
        )
    }
}

// ── Handle ───────────────────────────────────────────────────────────────────

pub struct LoopbackHandle {
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub mode: LoopbackMode,
    pub stats: Arc<parking_lot::Mutex<TimelineStats>>,
}

impl LoopbackHandle {
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            // The capture loop waits at most ~10 ms per iteration, so this
            // returns promptly.
            let _ = t.join();
        }
    }
}

impl Drop for LoopbackHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Start capturing for `source_id`. `on_pcm(samples, timestamp_ms)` is called
/// on the capture thread with contiguous interleaved 48 kHz stereo f32 chunks
/// (any length) and the QPC-ms time of each chunk's first frame; consecutive
/// chunks never overlap or leave gaps. Returns once the capture is actually
/// running (or has failed to start), with the mode that was used.
pub fn start<F>(source_id: &str, on_pcm: F) -> Result<LoopbackHandle, String>
where
    F: FnMut(&[f32], f64) + Send + 'static,
{
    let target = parse_source(source_id)?;
    imp::start(target, false, on_pcm)
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn start<F>(_target: Target, _force_device: bool, _on_pcm: F) -> Result<LoopbackHandle, String>
    where
        F: FnMut(&[f32], f64) + Send + 'static,
    {
        Err("Share audio capture is only supported on Windows".into())
    }
}

#[cfg(windows)]
pub(crate) mod imp {
    use super::*;
    use crate::resample::StereoLinearResampler;
    use crate::write_audio_log;
    use std::sync::mpsc::sync_channel;
    use std::time::Duration;
    use windows::core::{implement, Interface, HRESULT, PCWSTR, PROPVARIANT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient,
        IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
        WAVEFORMATEXTENSIBLE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IAgileObject, IAgileObject_Impl, CLSCTX_ALL,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{
        AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW, GetCurrentProcessId, SetEvent,
        WaitForSingleObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

    const WAVE_FORMAT_PCM: u16 = 1;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
    const SPEAKER_FRONT_LEFT: u32 = 0x1;
    const SPEAKER_FRONT_RIGHT: u32 = 0x2;
    const SPEAKER_FRONT_CENTER: u32 = 0x4;
    /// KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT share this GUID tail; Data1 is
    /// the WAVE_FORMAT tag.
    const KSDATAFORMAT_SUBTYPE_TAIL: (u16, u16, [u8; 8]) =
        (0x0000, 0x0010, [0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]);
    const VT_BLOB: u16 = 65;
    /// 100 ms shared-mode buffer: plenty of headroom for a scheduling hiccup
    /// on the capture thread, irrelevant to latency (we drain every ~10 ms).
    const BUFFER_HNS: i64 = 1_000_000;
    const ACTIVATE_TIMEOUT_MS: u32 = 5_000;
    const POLL_MS: u32 = 10;

    /// Mirror of PROPVARIANT's layout for the one variant we need (VT_BLOB):
    /// `vt`, three reserved WORDs, then the BLOB {cbSize, pBlobData} in the
    /// union. windows-rs 0.58 doesn't expose a safe VT_BLOB constructor.
    /// Only ever passed by pointer to ActivateAudioInterfaceAsync, which
    /// copies it; never dropped as a real PROPVARIANT (that would try to
    /// CoTaskMemFree our stack-owned params).
    #[repr(C)]
    struct BlobPropVariant {
        vt: u16,
        r1: u16,
        r2: u16,
        r3: u16,
        cb: u32,
        p: *const u8,
    }

    /// Completion handler for ActivateAudioInterfaceAsync. Must be agile
    /// (IAgileObject) or activation fails / is called on an apartment we
    /// don't pump. Does nothing but signal the waiting capture thread, so
    /// there is no way for it to panic across the COM boundary.
    #[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
    struct ActivateHandler {
        done: HANDLE,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateHandler_Impl {
        fn ActivateCompleted(&self, _op: Option<&IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            unsafe {
                let _ = SetEvent(self.done);
            }
            Ok(())
        }
    }

    impl IAgileObject_Impl for ActivateHandler_Impl {}

    /// Owns a Win32 event handle.
    struct Event(HANDLE);
    impl Event {
        fn new(manual_reset: bool) -> windows::core::Result<Self> {
            unsafe { CreateEventW(None, manual_reset, false, PCWSTR::null()).map(Event) }
        }
    }
    impl Drop for Event {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    struct Session {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        event: Event,
        fmt: RawFormat,
    }

    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
            }
        }
    }

    fn float_stereo_48k() -> WAVEFORMATEX {
        WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: 2,
            nSamplesPerSec: OUT_RATE,
            nAvgBytesPerSec: OUT_RATE * 8,
            nBlockAlign: 8,
            wBitsPerSample: 32,
            cbSize: 0,
        }
    }

    fn pcm16_stereo_48k() -> WAVEFORMATEX {
        WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM,
            nChannels: 2,
            nSamplesPerSec: OUT_RATE,
            nAvgBytesPerSec: OUT_RATE * 4,
            nBlockAlign: 4,
            wBitsPerSample: 16,
            cbSize: 0,
        }
    }

    /// Describe a WAVEFORMATEX(-TENSIBLE) we can convert, or None.
    unsafe fn describe(wf: *const WAVEFORMATEX) -> Option<RawFormat> {
        let f = *wf;
        let (tag, mask) = if f.wFormatTag == WAVE_FORMAT_EXTENSIBLE && f.cbSize >= 22 {
            let ext = *(wf as *const WAVEFORMATEXTENSIBLE);
            let sub = ext.SubFormat;
            let (d2, d3, d4) = KSDATAFORMAT_SUBTYPE_TAIL;
            if sub.data2 != d2 || sub.data3 != d3 || sub.data4 != d4 {
                return None;
            }
            (sub.data1 as u16, ext.dwChannelMask)
        } else {
            (f.wFormatTag, 0)
        };
        let kind = match (tag, f.wBitsPerSample, f.nBlockAlign / f.nChannels.max(1)) {
            (WAVE_FORMAT_IEEE_FLOAT, 32, 4) => SampleKind::F32,
            (WAVE_FORMAT_PCM, 16, 2) => SampleKind::I16,
            (WAVE_FORMAT_PCM, 24, 3) => SampleKind::I24,
            (WAVE_FORMAT_PCM, 24 | 32, 4) => SampleKind::I32,
            _ => return None,
        };
        let center_at_2 = mask & (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER)
            == (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER);
        if f.nChannels == 0 || f.nSamplesPerSec == 0 {
            return None;
        }
        Some(RawFormat { rate: f.nSamplesPerSec, channels: f.nChannels, kind, center_at_2 })
    }

    fn hr_str(e: &windows::core::Error) -> String {
        format!("0x{:08X} {}", e.code().0 as u32, e.message())
    }

    /// Finish setting up an initialized client: event handle, capture
    /// service, start.
    unsafe fn finish(client: IAudioClient, fmt: RawFormat) -> Result<Session, String> {
        let event = Event::new(false).map_err(|e| format!("CreateEvent: {}", hr_str(&e)))?;
        // Event signalling isn't guaranteed for every loopback flavour; the
        // capture loop polls on a 10 ms timeout regardless, so a failure here
        // only costs a little latency.
        let _ = client.SetEventHandle(event.0);
        let capture: IAudioCaptureClient =
            client.GetService().map_err(|e| format!("GetService(IAudioCaptureClient): {}", hr_str(&e)))?;
        client.Start().map_err(|e| format!("IAudioClient::Start: {}", hr_str(&e)))?;
        Ok(Session { client, capture, event, fmt })
    }

    unsafe fn open_process(pid: u32, include: bool) -> Result<Session, String> {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: if include {
                        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                    } else {
                        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                    },
                },
            },
        };
        let prop = BlobPropVariant {
            vt: VT_BLOB,
            r1: 0,
            r2: 0,
            r3: 0,
            cb: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            p: &params as *const _ as *const u8,
        };
        debug_assert_eq!(std::mem::size_of::<BlobPropVariant>(), std::mem::size_of::<PROPVARIANT>());

        let done = Event::new(true).map_err(|e| format!("CreateEvent: {}", hr_str(&e)))?;
        let handler: IActivateAudioInterfaceCompletionHandler = ActivateHandler { done: done.0 }.into();
        let op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&prop as *const BlobPropVariant as *const PROPVARIANT),
            &handler,
        )
        .map_err(|e| format!("ActivateAudioInterfaceAsync: {}", hr_str(&e)))?;

        if WaitForSingleObject(done.0, ACTIVATE_TIMEOUT_MS) != WAIT_OBJECT_0 {
            return Err("process loopback activation timed out".into());
        }
        let mut hr = HRESULT(0);
        let mut unk: Option<windows::core::IUnknown> = None;
        op.GetActivateResult(&mut hr, &mut unk)
            .map_err(|e| format!("GetActivateResult: {}", hr_str(&e)))?;
        hr.ok().map_err(|e| format!("process loopback activation: {}", hr_str(&e)))?;
        let client: IAudioClient = unk
            .ok_or("process loopback activation returned no interface")?
            .cast()
            .map_err(|e| format!("cast IAudioClient: {}", hr_str(&e)))?;

        // Process loopback has no mix format (GetMixFormat is E_NOTIMPL); the
        // virtual device converts to whatever we ask for. Float first, then
        // 16-bit PCM in case a build is picky.
        let flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM;
        let mut last_err = String::new();
        for wf in [float_stereo_48k(), pcm16_stereo_48k()] {
            match client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER_HNS, 0, &wf, None) {
                Ok(()) => {
                    let fmt = describe(&wf).expect("our own formats are describable");
                    return finish(client, fmt);
                }
                Err(e) => {
                    let bits = wf.wBitsPerSample; // packed struct: copy out before formatting
                    last_err = format!("Initialize({}bit): {}", bits, hr_str(&e));
                }
            }
        }
        Err(last_err)
    }

    unsafe fn open_device() -> Result<Session, String> {
        let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("MMDeviceEnumerator: {}", hr_str(&e)))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint: {}", hr_str(&e)))?;

        // 1) Let the audio engine convert to 48 kHz stereo float for us.
        //    (A client can only be initialized once, so each attempt
        //    activates a fresh one.)
        let base = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
        let convert = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        let wf = float_stereo_48k();
        for flags in [base | convert, AUDCLNT_STREAMFLAGS_LOOPBACK | convert] {
            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| format!("IMMDevice::Activate: {}", hr_str(&e)))?;
            if client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, BUFFER_HNS, 0, &wf, None).is_ok() {
                return finish(client, describe(&wf).expect("our own format is describable"));
            }
        }

        // 2) Raw mix format; we convert and resample ourselves.
        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("IMMDevice::Activate: {}", hr_str(&e)))?;
        let mix = client.GetMixFormat().map_err(|e| format!("GetMixFormat: {}", hr_str(&e)))?;
        let fmt = describe(mix);
        let init = match fmt {
            Some(_) => client
                .Initialize(AUDCLNT_SHAREMODE_SHARED, base, BUFFER_HNS, 0, mix, None)
                .or_else(|_| client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, BUFFER_HNS, 0, mix, None))
                .map_err(|e| format!("Initialize(mix format): {}", hr_str(&e))),
            None => Err("unsupported device mix format".to_string()),
        };
        CoTaskMemFree(Some(mix as *const _));
        init?;
        finish(client, fmt.unwrap())
    }

    unsafe fn open(mode: LoopbackMode, target_pid: u32) -> Result<Session, String> {
        match mode {
            LoopbackMode::ProcessInclude => open_process(target_pid, true),
            LoopbackMode::ProcessExclude => open_process(target_pid, false),
            LoopbackMode::DeviceLoopback => open_device(),
        }
    }

    fn log_session(mode: LoopbackMode, s: &Session, pid: u32) {
        write_audio_log(&format!(
            "share-audio: loopback open mode={} pid={} format={:?} rate={}Hz channels={} resample={}",
            mode.as_str(),
            pid,
            s.fmt.kind,
            s.fmt.rate,
            s.fmt.channels,
            s.fmt.rate != OUT_RATE
        ));
    }

    /// Converts packets to 48 kHz stereo and runs them through the Timeline.
    struct Pump<F> {
        timeline: Timeline,
        on_pcm: F,
        resampler: Option<(u32, StereoLinearResampler)>,
        raw: Vec<f32>,
        out: Vec<f32>,
        zeros: Vec<f32>,
        stats: Arc<parking_lot::Mutex<TimelineStats>>,
        last_log_ms: f64,
    }

    const STATS_LOG_INTERVAL_MS: f64 = 10_000.0;

    /// Emit `frames` of silence onto the timeline, in 20 ms pieces.
    fn emit_silence<F: FnMut(&[f32], f64)>(timeline: &mut Timeline, on_pcm: &mut F, zeros: &mut Vec<f32>, mut frames: usize) {
        while frames > 0 {
            let n = frames.min(OUT_RATE as usize / 50);
            if zeros.len() < n * 2 {
                zeros.resize(n * 2, 0.0);
            }
            on_pcm(&zeros[..n * 2], timeline.next_ms());
            timeline.advance(n);
            frames -= n;
        }
    }

    impl<F: FnMut(&[f32], f64)> Pump<F> {
        fn idle(&mut self) {
            let now = qpc_now_ms();
            let n = self.timeline.idle_fill(now);
            emit_silence(&mut self.timeline, &mut self.on_pcm, &mut self.zeros, n);
            if n > 0 {
                self.stats.lock().idle_silence_frames += n as u64;
            }
            if now - self.last_log_ms >= STATS_LOG_INTERVAL_MS {
                self.last_log_ms = now;
                write_audio_log(&format!("share-audio: timeline {}", self.stats.lock().summary()));
            }
        }

        /// One captured packet, already converted to stereo f32 at `rate`.
        /// `latency_ms` is how long after the packet's end it reached us.
        fn packet(&mut self, rate: u32, packet_start_ms: f64, latency_ms: f64) {
            let samples: &[f32] = if rate == OUT_RATE {
                &self.raw
            } else {
                let r = match &mut self.resampler {
                    Some((rr, r)) if *rr == rate => r,
                    slot => {
                        *slot = Some((rate, StereoLinearResampler::new(rate, OUT_RATE)));
                        &mut slot.as_mut().unwrap().1
                    }
                };
                self.out.clear();
                r.process(&self.raw, &mut self.out);
                &self.out
            };
            let frames = samples.len() / 2;
            if frames == 0 {
                return;
            }
            let plan = self.timeline.plan_packet(packet_start_ms, frames);
            let skip = plan.skip_front;
            {
                let mut st = self.stats.lock();
                st.packets += 1;
                st.packet_frames += frames as u64;
                st.gap_silence_frames += plan.silence_before as u64;
                st.trimmed_frames += skip.min(frames) as u64;
                st.latency_sum_ms += latency_ms;
                st.latency_max_ms = st.latency_max_ms.max(latency_ms);
            }
            // Field-level borrows: `samples` borrows raw/out, silence needs
            // timeline/on_pcm/zeros.
            emit_silence(&mut self.timeline, &mut self.on_pcm, &mut self.zeros, plan.silence_before);
            if skip < frames {
                let ts = self.timeline.next_ms();
                (self.on_pcm)(&samples[skip * 2..], ts);
                self.timeline.advance(frames - skip);
            }
        }
    }

    /// Drain one session until stop (Ok) or a WASAPI error (Err, reopen).
    unsafe fn run_session<F: FnMut(&[f32], f64)>(
        s: &Session,
        pump: &mut Pump<F>,
        running: &AtomicBool,
    ) -> Result<(), String> {
        let bpf = s.fmt.bytes_per_sample() * s.fmt.channels as usize;
        let mut discontinuities = 0u32;
        while running.load(Ordering::Relaxed) {
            let _ = WaitForSingleObject(s.event.0, POLL_MS);
            loop {
                let next = s.capture.GetNextPacketSize().map_err(|e| format!("GetNextPacketSize: {}", hr_str(&e)))?;
                if next == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                let mut qpc_pos = 0u64;
                s.capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc_pos))
                    .map_err(|e| format!("GetBuffer: {}", hr_str(&e)))?;
                pump.raw.clear();
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                if silent || data.is_null() {
                    pump.raw.resize(frames as usize * 2, 0.0);
                } else {
                    let bytes = std::slice::from_raw_parts(data, frames as usize * bpf);
                    to_stereo_f32(bytes, frames as usize, &s.fmt, &mut pump.raw);
                }
                s.capture.ReleaseBuffer(frames).map_err(|e| format!("ReleaseBuffer: {}", hr_str(&e)))?;
                if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                    discontinuities += 1;
                    if discontinuities <= 3 || discontinuities % 100 == 0 {
                        write_audio_log(&format!("share-audio: data discontinuity (#{discontinuities})"));
                    }
                }
                // GetBuffer's QPC position is already in 100 ns units. Use it
                // when it's plausible; otherwise assume the packet just ended.
                let now = qpc_now_ms();
                let dur_ms = frames as f64 * 1000.0 / s.fmt.rate as f64;
                let reported = qpc_pos as f64 / 10_000.0;
                let start_ms = if qpc_pos != 0 && (reported - (now - dur_ms)).abs() < 1000.0 {
                    reported
                } else {
                    now - dur_ms
                };
                pump.packet(s.fmt.rate, start_ms, now - (start_ms + dur_ms));
            }
            pump.idle();
        }
        Ok(())
    }

    fn target_pid(target: Target) -> Result<(LoopbackMode, u32), String> {
        match target {
            Target::Window(hwnd) => {
                let mut pid = 0u32;
                unsafe {
                    GetWindowThreadProcessId(HWND(hwnd as *mut core::ffi::c_void), Some(&mut pid));
                }
                if pid == 0 {
                    return Err(format!("Window {hwnd} not found (no owning process)"));
                }
                Ok((LoopbackMode::ProcessInclude, pid))
            }
            Target::Everything => Ok((LoopbackMode::ProcessExclude, unsafe { GetCurrentProcessId() })),
        }
    }

    /// `force_device` skips process loopback (tests exercise the fallback
    /// path with it).
    pub fn start<F>(target: Target, force_device: bool, on_pcm: F) -> Result<LoopbackHandle, String>
    where
        F: FnMut(&[f32], f64) + Send + 'static,
    {
        let (mut wanted_mode, pid) = target_pid(target)?;
        if force_device {
            wanted_mode = LoopbackMode::DeviceLoopback;
        }
        if wanted_mode == LoopbackMode::ProcessInclude && pid == unsafe { GetCurrentProcessId() } {
            write_audio_log("share-audio: shared window belongs to SpecterComs itself; its audio would echo");
        }
        let running = Arc::new(AtomicBool::new(true));
        let running_t = running.clone();
        let stats = Arc::new(parking_lot::Mutex::new(TimelineStats::default()));
        let stats_t = stats.clone();
        let (init_tx, init_rx) = sync_channel::<Result<LoopbackMode, String>>(1);

        let thread = std::thread::Builder::new()
            .name("specter-share-audio".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                    capture_thread(wanted_mode, pid, on_pcm, &running_t, init_tx, stats_t)
                }));
                if result.is_err() {
                    write_audio_log("share-audio: capture thread panicked; share audio stopped");
                }
            })
            .map_err(|e| format!("spawn share-audio thread: {e}"))?;

        match init_rx.recv_timeout(Duration::from_millis(ACTIVATE_TIMEOUT_MS as u64 * 2 + 2_000)) {
            Ok(Ok(mode)) => Ok(LoopbackHandle { running, thread: Some(thread), mode, stats }),
            Ok(Err(e)) => {
                running.store(false, Ordering::SeqCst);
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                // Thread is stuck in an OS call; let it go rather than block.
                running.store(false, Ordering::SeqCst);
                Err("share audio capture did not start in time".into())
            }
        }
    }

    unsafe fn capture_thread<F: FnMut(&[f32], f64)>(
        wanted_mode: LoopbackMode,
        pid: u32,
        on_pcm: F,
        running: &AtomicBool,
        init_tx: std::sync::mpsc::SyncSender<Result<LoopbackMode, String>>,
        stats: Arc<parking_lot::Mutex<TimelineStats>>,
    ) {
        let com = CoInitializeEx(None, COINIT_MULTITHREADED);
        let com_ok = com.is_ok();
        // "Audio" MMCSS class: keeps the 10 ms drain loop on time under load.
        let mut task_idx = 0u32;
        let mmcss = AvSetMmThreadCharacteristicsW(windows::core::w!("Audio"), &mut task_idx).ok();

        // Open: requested process-loopback mode, else device loopback.
        let (mode, mut first) = match open(wanted_mode, pid) {
            Ok(s) => (wanted_mode, Some(s)),
            Err(e) => {
                write_audio_log(&format!(
                    "share-audio: {} unavailable ({e}); falling back to device loopback (echo risk)",
                    wanted_mode.as_str()
                ));
                match open(LoopbackMode::DeviceLoopback, pid) {
                    Ok(s) => (LoopbackMode::DeviceLoopback, Some(s)),
                    Err(e2) => {
                        write_audio_log(&format!("share-audio: device loopback failed too: {e2}"));
                        let _ = init_tx.send(Err(format!("Share audio capture unavailable: {e}; fallback: {e2}")));
                        cleanup(mmcss, com_ok);
                        return;
                    }
                }
            }
        };
        if let Some(s) = &first {
            log_session(mode, s, pid);
        }
        let _ = init_tx.send(Ok(mode));
        drop(init_tx);

        let mut pump = Pump {
            timeline: Timeline::new(qpc_now_ms()),
            on_pcm,
            resampler: None,
            raw: Vec::new(),
            out: Vec::new(),
            zeros: Vec::new(),
            stats,
            last_log_ms: qpc_now_ms(),
        };
        let mut backoff_ms = 250u64;
        while running.load(Ordering::Relaxed) {
            let session = match first.take() {
                Some(s) => s,
                None => match open(mode, pid) {
                    Ok(s) => {
                        log_session(mode, &s, pid);
                        backoff_ms = 250;
                        s
                    }
                    Err(e) => {
                        write_audio_log(&format!("share-audio: reopen {} failed: {e}; retry in {backoff_ms} ms", mode.as_str()));
                        // Keep the timeline (and so the Opus stream) going
                        // while we wait.
                        let until = qpc_now_ms() + backoff_ms as f64;
                        while running.load(Ordering::Relaxed) && qpc_now_ms() < until {
                            std::thread::sleep(Duration::from_millis(POLL_MS as u64));
                            pump.idle();
                        }
                        backoff_ms = (backoff_ms * 2).min(4_000);
                        continue;
                    }
                },
            };
            match run_session(&session, &mut pump, running) {
                Ok(()) => break,
                Err(e) => {
                    write_audio_log(&format!("share-audio: capture error ({e}); reopening"));
                    drop(session);
                    pump.resampler = None;
                }
            }
        }
        write_audio_log(&format!("share-audio: loopback stopped; timeline {}", pump.stats.lock().summary()));
        drop(pump);
        cleanup(mmcss, com_ok);
    }

    unsafe fn cleanup(mmcss: Option<HANDLE>, com_ok: bool) {
        if let Some(h) = mmcss {
            let _ = AvRevertMmThreadCharacteristics(h);
        }
        if com_ok {
            CoUninitialize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real WASAPI: run with `-- --ignored --nocapture`. Starts the given
    /// mode for 1 s and checks a steady, contiguous 48 kHz stream comes out.
    #[cfg(windows)]
    fn live(target: Target, force_device: bool, expect: LoopbackMode) {
        let got = Arc::new(parking_lot::Mutex::new((0usize, Vec::<f64>::new())));
        let g2 = got.clone();
        let h = imp::start(target, force_device, move |s, ts| {
            let mut g = g2.lock();
            g.0 += s.len() / 2;
            g.1.push(ts);
        })
        .expect("start");
        assert_eq!(h.mode, expect);
        std::thread::sleep(std::time::Duration::from_millis(1_000));
        h.stop();
        let g = got.lock();
        println!("{:?}: {} frames in {} chunks", expect, g.0, g.1.len());
        // ~1 s, minus up to IDLE_LAG_MS of not-yet-filled tail.
        assert!(g.0 >= 48_000 * 85 / 100 && g.0 <= 48_000 * 11 / 10, "frames {}", g.0);
    }

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_process_exclude_self() {
        live(Target::Everything, false, LoopbackMode::ProcessExclude);
    }

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_process_include_window() {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
        // The taskbar always exists; explorer's tree is a valid include target.
        let hwnd = unsafe { FindWindowW(w!("Shell_TrayWnd"), None) }.expect("taskbar window");
        live(Target::Window(hwnd.0 as isize), false, LoopbackMode::ProcessInclude);
    }

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_device_loopback_fallback() {
        live(Target::Everything, true, LoopbackMode::DeviceLoopback);
    }

    /// Timeline health while something is actually playing: start an audio
    /// player in another process first, then run with
    /// `SPECTER_TEST_PID=<player pid>` for include mode (else exclude-self).
    /// Every ms of silence/trim here is a dropout a viewer hears.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_timeline_health_while_playing() {
        let target = match std::env::var("SPECTER_TEST_PID").ok().and_then(|p| p.parse::<u32>().ok()) {
            Some(pid) => {
                use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId};
                use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
                unsafe extern "system" fn find(h: HWND, lp: LPARAM) -> BOOL {
                    let want = &mut *(lp.0 as *mut (u32, isize));
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(h, Some(&mut pid));
                    if pid == want.0 { want.1 = h.0 as isize; BOOL(0) } else { BOOL(1) }
                }
                let mut want = (pid, 0isize);
                unsafe { let _ = EnumWindows(Some(find), LPARAM(&mut want as *mut _ as isize)); }
                assert!(want.1 != 0, "no window for pid {pid}");
                Target::Window(want.1)
            }
            None => Target::Everything,
        };
        let h = imp::start(target, false, |_, _| {}).expect("start");
        std::thread::sleep(std::time::Duration::from_secs(5));
        let st = h.stats.lock().clone();
        let mode = h.mode;
        h.stop();
        println!("{:?}: {}", mode, st.summary());
    }

    #[test]
    fn parses_sources() {
        assert_eq!(parse_source("window:123456").unwrap(), Target::Window(123456));
        assert_eq!(parse_source("monitor:0").unwrap(), Target::Everything);
        assert_eq!(parse_source("monitor:2").unwrap(), Target::Everything);
        assert!(parse_source("window:abc").is_err());
        assert!(parse_source("window:0").is_err());
    }

    #[test]
    fn contiguous_packets_need_no_correction() {
        let mut t = Timeline::new(1000.0);
        for i in 0..100 {
            // 10 ms packets with ±5 ms timestamp jitter.
            let jitter = if i % 2 == 0 { 5.0 } else { -5.0 };
            let plan = t.plan_packet(1000.0 + i as f64 * 10.0 + jitter, 480);
            assert_eq!(plan, PacketPlan::default());
            t.advance(480);
        }
        assert!((t.next_ms() - 2000.0).abs() < 1e-9);
    }

    #[test]
    fn late_packet_gets_silence_before_it() {
        let mut t = Timeline::new(0.0);
        t.advance(480); // 10 ms emitted
        let plan = t.plan_packet(50.0, 480); // 40 ms gap
        assert_eq!(plan.silence_before, 40 * 48);
        assert_eq!(plan.skip_front, 0);
    }

    #[test]
    fn early_packet_overlapping_silence_is_trimmed() {
        let mut t = Timeline::new(0.0);
        t.advance(48 * 100); // 100 ms emitted (e.g. silence fill)
        let plan = t.plan_packet(40.0, 48 * 100); // starts 60 ms "in the past"
        assert_eq!(plan.silence_before, 0);
        assert_eq!(plan.skip_front, 60 * 48);
        // A packet entirely in the past is dropped whole.
        let plan = t.plan_packet(-500.0, 480);
        assert_eq!(plan.skip_front, 480);
    }

    #[test]
    fn idle_fill_keeps_timeline_near_real_time() {
        let mut t = Timeline::new(0.0);
        assert_eq!(t.idle_fill(30.0), 0, "below the lag threshold nothing is filled");
        let n = t.idle_fill(100.0);
        assert_eq!(n, 80 * 48);
        t.advance(n);
        assert!((t.next_ms() - 80.0).abs() < 1e-9);
        // Silence for a long stretch, filled in 10 ms ticks: frame count
        // tracks wall time, so the Opus stream stays at 50 frames/s.
        let mut now = 100.0;
        for _ in 0..1000 {
            now += 10.0;
            let n = t.idle_fill(now);
            t.advance(n);
        }
        assert!(now - t.next_ms() <= IDLE_LAG_MS + 1e-9 && now - t.next_ms() >= IDLE_KEEP_MS - 1e-9);
    }

    #[test]
    fn huge_gap_reanchors_instead_of_bursting() {
        let mut t = Timeline::new(0.0);
        let plan = t.plan_packet(10_000.0, 480);
        assert_eq!(plan, PacketPlan::default());
        assert!((t.next_ms() - 10_000.0).abs() < 1e-9);
        assert_eq!(t.idle_fill(30_000.0), 0);
        assert!((t.next_ms() - (30_000.0 - IDLE_KEEP_MS)).abs() < 1e-9);
    }

    #[test]
    fn converts_formats_to_stereo() {
        let mut out = Vec::new();
        // Mono i16: duplicated.
        let fmt = RawFormat { rate: 48_000, channels: 1, kind: SampleKind::I16, center_at_2: false };
        to_stereo_f32(&16_384i16.to_le_bytes(), 1, &fmt, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
        // 5.1 float with centre: centre folded into both sides.
        out.clear();
        let fmt = RawFormat { rate: 48_000, channels: 6, kind: SampleKind::F32, center_at_2: true };
        let frame: Vec<u8> = [0.1f32, 0.2, 0.5, 0.0, 0.9, 0.9].iter().flat_map(|s| s.to_le_bytes()).collect();
        to_stereo_f32(&frame, 1, &fmt, &mut out);
        let c = 0.5 * std::f32::consts::FRAC_1_SQRT_2;
        assert!((out[0] - (0.1 + c)).abs() < 1e-6 && (out[1] - (0.2 + c)).abs() < 1e-6);
        // 24-bit packed.
        out.clear();
        let fmt = RawFormat { rate: 44_100, channels: 2, kind: SampleKind::I24, center_at_2: false };
        let bytes = [0x00, 0x00, 0x40, 0x00, 0x00, 0xC0]; // +0.5, -0.5
        to_stereo_f32(&bytes, 1, &fmt, &mut out);
        assert_eq!(out, vec![0.5, -0.5]);
        // Truncated buffer never reads out of bounds.
        out.clear();
        to_stereo_f32(&bytes[..4], 5, &fmt, &mut out);
        assert!(out.is_empty());
    }
}
