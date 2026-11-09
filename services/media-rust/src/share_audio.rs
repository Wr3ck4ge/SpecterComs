//! Screen-share audio relay: in-stream frames and WebTransport datagrams.
//!
//! Share audio is one E2E-encrypted Opus packet per 20 ms (see
//! web-portal/src/engine/shareAudio.js). It used to ride only inside the
//! sharer's reliable video stream, where it queued behind large video frames
//! on a constrained uplink and reached viewers in bursts. It now travels as
//! QUIC datagrams wherever both ends support it, and this relay converts
//! between the two forms so every client generation keeps working.
//!
//! ## Wire format
//!
//! The in-stream frame (unchanged since 2.0.6):
//!
//! ```text
//!   [4B frame_size BE][1B flags = 0x05][4B timestamp_ms BE][ciphertext]
//! ```
//!
//! The datagram is that frame without the length prefix, byte for byte:
//!
//! ```text
//!   [1B type = 0x05][4B timestamp_ms BE][ciphertext]
//! ```
//!
//! Sharer to server, it goes on the sharer's video publish session; server
//! to viewer, on that viewer's video subscribe session. Both sessions are
//! already bound to a single sharer, so the cleartext names no one: the
//! server knows the sharer from the authenticated publish session, the viewer
//! knows it from the session it opened. The relay never decrypts anything and
//! never looks past the 5-byte header.
//!
//! Because the two forms differ only by the length prefix, conversion is cheap:
//!   * datagram to frame (ingress, new sharer): one allocation per packet,
//!     made once at ingress and shared by every subscriber;
//!   * frame to datagram (egress): `Bytes::slice(4..)`, which does not allocate.
//!
//! Every packet goes into the sharer's audio broadcast channel as a complete
//! in-stream frame. Each subscriber takes it in the form it asked for (see
//! [`ShareAudioDelivery`]).

use bytes::Bytes;
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

/// Flags byte of an in-stream share-audio frame, and the type byte of a
/// share-audio datagram: SHARE_FRAME_FLAG_AUDIO | VIDEO_FLAG_DELTA. Every
/// relay masks bit 0 for the keyframe test, so this is never cached as a
/// keyframe.
pub const SHARE_AUDIO_TYPE: u8 = 0x05;

/// `[type][4B ts]` ahead of the ciphertext.
pub const SHARE_AUDIO_DATAGRAM_HEADER_LEN: usize = 5;

/// Upper bound on an accepted share-audio datagram. A QUIC datagram can't be
/// bigger than the path MTU anyway (about 1.2 to 1.45 KB). This is only a
/// sanity cap; a 20 ms 128 kbps Opus packet plus framing is about 360 bytes.
pub const MAX_SHARE_AUDIO_DATAGRAM: usize = 1500;

/// Server to publisher, a one-byte uni stream on the publish session, sent
/// right after SHARE_AUDIO_CAPABLE (0x41): "you may send share audio as
/// datagrams on this session". Shipped publishers (2.0.6 to 2.0.8) read the
/// first byte of every server uni stream and act only on 0xAC / 0xDE / 0x4B /
/// 0x41, so they ignore it.
pub const SHARE_AUDIO_DGRAM_CAPABLE: u8 = 0x44;

/// Rate limit for share audio from one publisher, counted over a fixed window
/// in the same style as the large-video-frame limit. Real traffic is 50
/// packets/s (20 ms Opus). Twice that leaves room for 10 ms frames and bursts.
/// Packets over the limit are dropped; the session stays open.
pub const MAX_SHARE_AUDIO_PACKETS_PER_WINDOW: u32 = 100;
pub const SHARE_AUDIO_RATE_WINDOW: Duration = Duration::from_secs(1);

/// Capacity of a sharer's audio broadcast channel: about 1.3 s of 20 ms
/// packets. A subscriber that falls further behind than that skips ahead
/// (its playout would discard the stale audio anyway).
pub const SHARE_AUDIO_CHANNEL_CAPACITY: usize = 64;

/// Audio older than this by the time a subscriber's relay gets to it is
/// dropped. The viewer's playout would discard it, so writing it only adds load.
pub const MAX_SHARE_AUDIO_AGE: Duration = Duration::from_millis(400);

/// What one sharer's publish task broadcasts to its subscribers.
pub type ShareAudioTx = broadcast::Sender<(Bytes, Instant)>;

/// How one subscriber receives share audio, from its subscribe-URL capability
/// params.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareAudioDelivery {
    /// No share audio at all. This is every 2.0.0 to 2.0.5 viewer (no params),
    /// whose video decoder would choke on an audio frame.
    None,
    /// In-stream 0x05 frames (`share_audio=1` only: 2.0.6 to 2.0.8 viewers).
    InStream,
    /// Datagrams on the subscribe session (`share_audio_dgram=1`).
    Datagram,
}

impl ShareAudioDelivery {
    pub fn from_params(share_audio: bool, share_audio_dgram: bool) -> Self {
        // Advertising datagram support implies understanding share audio. A
        // datagram can't reach a shipped viewer's decoder either way: no 2.0.x
        // client reads datagrams on its video subscribe session.
        if share_audio_dgram {
            ShareAudioDelivery::Datagram
        } else if share_audio {
            ShareAudioDelivery::InStream
        } else {
            ShareAudioDelivery::None
        }
    }
}

/// Validates a datagram received on a publish session. Returns `true` if it is
/// a well-formed share-audio datagram: the right type byte, a timestamp, at
/// least one ciphertext byte, and no larger than the cap.
pub fn is_share_audio_datagram(payload: &[u8]) -> bool {
    payload.len() > SHARE_AUDIO_DATAGRAM_HEADER_LEN
        && payload.len() <= MAX_SHARE_AUDIO_DATAGRAM
        && payload[0] == SHARE_AUDIO_TYPE
}

/// Datagram to in-stream frame: prepends the 4-byte frame size. The rest of the
/// datagram is already the frame body.
pub fn frame_from_datagram(payload: &[u8]) -> Bytes {
    let mut framed = Vec::with_capacity(4 + payload.len());
    framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    framed.extend_from_slice(payload);
    Bytes::from(framed)
}

/// In-stream frame to datagram, without copying. Returns `None` for anything
/// that isn't a complete share-audio frame. An oversized frame from an old
/// sharer is returned too; the send then fails as too large and is dropped.
pub fn datagram_from_frame(frame: &Bytes) -> Option<Bytes> {
    if frame.len() <= 4 + SHARE_AUDIO_DATAGRAM_HEADER_LEN || frame[4] & 0x04 == 0 {
        return None;
    }
    let declared = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if declared != frame.len() - 4 {
        return None;
    }
    Some(frame.slice(4..))
}

/// Fixed-window packet counter for one publisher's share audio. Pure: every
/// call takes `now` explicitly.
pub struct ShareAudioRateLimiter {
    window_start: Instant,
    count: u32,
    max_per_window: u32,
    window: Duration,
    /// Packets dropped by the limit (for logging).
    pub dropped: u64,
}

impl ShareAudioRateLimiter {
    pub fn new(now: Instant) -> Self {
        Self::with_limit(now, MAX_SHARE_AUDIO_PACKETS_PER_WINDOW, SHARE_AUDIO_RATE_WINDOW)
    }

    pub fn with_limit(now: Instant, max_per_window: u32, window: Duration) -> Self {
        Self { window_start: now, count: 0, max_per_window, window, dropped: 0 }
    }

    /// `true` if one more packet may pass now.
    pub fn allow(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.window_start) >= self.window {
            self.window_start = now;
            self.count = 0;
        }
        if self.count >= self.max_per_window {
            self.dropped += 1;
            return false;
        }
        self.count += 1;
        true
    }
}

/// Ingress for one datagram received on a publish session. Returns the
/// in-stream frame to broadcast, or `None` if the datagram is dropped: wrong
/// type, malformed, or over the rate limit.
pub fn ingest_datagram(payload: &[u8], limiter: &mut ShareAudioRateLimiter, now: Instant) -> Option<Bytes> {
    if !is_share_audio_datagram(payload) || !limiter.allow(now) {
        return None;
    }
    Some(frame_from_datagram(payload))
}

/// Why a datagram send failed. A simplified form of
/// `wtransport::error::SendDatagramError`, so the forwarder can be tested
/// without a QUIC connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DatagramSendError {
    /// The connection is gone, so stop forwarding.
    Closed,
    /// The peer can't take datagrams, or this one is too big for the path.
    /// Drop this packet and keep going.
    Rejected,
}

impl From<wtransport::error::SendDatagramError> for DatagramSendError {
    fn from(e: wtransport::error::SendDatagramError) -> Self {
        match e {
            wtransport::error::SendDatagramError::NotConnected => DatagramSendError::Closed,
            _ => DatagramSendError::Rejected,
        }
    }
}

/// Counters from one subscriber's datagram forwarder.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ForwardStats {
    pub sent: u64,
    pub bytes: u64,
    pub stale: u64,
    pub rejected: u64,
    pub lagged: u64,
}

/// Forwards one sharer's audio to one subscriber as datagrams until the
/// channel closes or the connection does. Runs in its own task, so a viewer
/// whose video stream write is stalled (slow downlink) still gets its audio on
/// time. That is the reason this is not an arm of the subscriber's video loop.
/// `send` must not block (wtransport's `send_datagram` doesn't).
/// `bytes_out` adds up egress for billing.
pub async fn forward_datagrams<F>(
    mut rx: broadcast::Receiver<(Bytes, Instant)>,
    mut send: F,
    bytes_out: &std::sync::atomic::AtomicU64,
) -> ForwardStats
where
    F: FnMut(&[u8]) -> Result<(), DatagramSendError>,
{
    let mut stats = ForwardStats::default();
    loop {
        match rx.recv().await {
            Ok((frame, produced_at)) => {
                if frame.is_empty() { break; } // publisher's end-of-stream sentinel
                if produced_at.elapsed() > MAX_SHARE_AUDIO_AGE { stats.stale += 1; continue; }
                let Some(dgram) = datagram_from_frame(&frame) else { continue };
                match send(&dgram) {
                    Ok(()) => {
                        stats.sent += 1;
                        stats.bytes += dgram.len() as u64;
                        bytes_out.fetch_add(dgram.len() as u64, std::sync::atomic::Ordering::Relaxed);
                    }
                    Err(DatagramSendError::Rejected) => stats.rejected += 1,
                    Err(DatagramSendError::Closed) => break,
                }
            }
            Err(broadcast::error::RecvError::Lagged(n)) => stats.lagged += n,
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
    stats
}

/// `recv()` on an optional receiver. With `None` this never resolves, so it
/// can sit in a `select!` arm for subscribers that take no in-stream audio.
pub async fn recv_opt(
    rx: &mut Option<broadcast::Receiver<(Bytes, Instant)>>,
) -> Result<(Bytes, Instant), broadcast::error::RecvError> {
    match rx {
        Some(rx) => rx.recv().await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    /// What a 2.0.6+ sharer writes into its share stream for one packet.
    fn in_stream_frame(ts: u32, ct: &[u8]) -> Bytes {
        let mut v = Vec::new();
        v.extend_from_slice(&((1 + 4 + ct.len()) as u32).to_be_bytes());
        v.push(SHARE_AUDIO_TYPE);
        v.extend_from_slice(&ts.to_be_bytes());
        v.extend_from_slice(ct);
        Bytes::from(v)
    }

    /// What a new sharer sends as a datagram for the same packet.
    fn datagram(ts: u32, ct: &[u8]) -> Vec<u8> {
        let mut v = vec![SHARE_AUDIO_TYPE];
        v.extend_from_slice(&ts.to_be_bytes());
        v.extend_from_slice(ct);
        v
    }

    #[test]
    fn delivery_follows_subscribe_params() {
        assert_eq!(ShareAudioDelivery::from_params(false, false), ShareAudioDelivery::None);
        assert_eq!(ShareAudioDelivery::from_params(true, false), ShareAudioDelivery::InStream);
        assert_eq!(ShareAudioDelivery::from_params(true, true), ShareAudioDelivery::Datagram);
        assert_eq!(ShareAudioDelivery::from_params(false, true), ShareAudioDelivery::Datagram);
    }

    #[test]
    fn repackaging_is_byte_exact_both_ways() {
        let ct: Vec<u8> = (0..320u32).map(|i| (i * 7) as u8).collect();
        let dg = datagram(0xDEAD_BEEF, &ct);
        let frame = in_stream_frame(0xDEAD_BEEF, &ct);
        // Datagram → the exact frame a 2.0.6–2.0.8 viewer parses today.
        assert_eq!(frame_from_datagram(&dg), frame);
        // Frame (old sharer) → the exact datagram a new viewer parses.
        assert_eq!(datagram_from_frame(&frame).unwrap().as_ref(), dg.as_slice());
        // Round trip.
        assert_eq!(datagram_from_frame(&frame_from_datagram(&dg)).unwrap().as_ref(), dg.as_slice());
        // The audio flag survives: an old relay's keyframe mask still says "delta".
        assert_eq!(frame_from_datagram(&dg)[4] & 0x01, 0x01);
    }

    #[test]
    fn frame_to_datagram_does_not_copy() {
        let frame = in_stream_frame(1, &[9u8; 64]);
        let dg = datagram_from_frame(&frame).unwrap();
        assert_eq!(dg.as_ptr(), frame[4..].as_ptr(), "egress must be a zero-copy slice");
    }

    #[test]
    fn only_well_formed_share_audio_datagrams_are_accepted() {
        assert!(is_share_audio_datagram(&datagram(5, &[1])));
        assert!(!is_share_audio_datagram(&[]));
        assert!(!is_share_audio_datagram(&[SHARE_AUDIO_TYPE, 0, 0, 0, 1])); // header only
        assert!(!is_share_audio_datagram(&datagram(5, &[1])[..4]));
        // Not share audio: the viewer's keyframe request, video flags.
        assert!(!is_share_audio_datagram(&[0x4B]));
        let mut wrong = datagram(5, &[1, 2, 3]);
        wrong[0] = 0x01;
        assert!(!is_share_audio_datagram(&wrong));
        // Size cap.
        assert!(is_share_audio_datagram(&datagram(5, &vec![0u8; MAX_SHARE_AUDIO_DATAGRAM - 5])));
        assert!(!is_share_audio_datagram(&datagram(5, &vec![0u8; MAX_SHARE_AUDIO_DATAGRAM - 4])));
    }

    #[test]
    fn non_audio_or_truncated_frames_never_become_datagrams() {
        let mut video = in_stream_frame(1, &[1, 2, 3]).to_vec();
        video[4] = 0x01; // a video delta
        assert!(datagram_from_frame(&Bytes::from(video)).is_none());
        let full = in_stream_frame(1, &[1, 2, 3]);
        assert!(datagram_from_frame(&full.slice(..full.len() - 1)).is_none(), "size prefix mismatch");
        assert!(datagram_from_frame(&Bytes::new()).is_none());
    }

    #[test]
    fn rate_limiter_caps_packets_per_window_and_recovers() {
        let t0 = Instant::now();
        let mut lim = ShareAudioRateLimiter::with_limit(t0, 3, Duration::from_millis(100));
        assert!(lim.allow(t0) && lim.allow(t0) && lim.allow(t0));
        assert!(!lim.allow(t0 + Duration::from_millis(50)));
        assert_eq!(lim.dropped, 1);
        assert!(lim.allow(t0 + Duration::from_millis(100)), "a new window resets the count");
        // Real traffic (50 pps) never trips the production limit.
        let mut prod = ShareAudioRateLimiter::new(t0);
        for i in 0..500u64 {
            assert!(prod.allow(t0 + Duration::from_millis(i * 20)));
        }
        assert_eq!(prod.dropped, 0);
    }

    #[test]
    fn ingest_frames_valid_datagrams_and_drops_the_rest() {
        let t0 = Instant::now();
        let mut lim = ShareAudioRateLimiter::with_limit(t0, 2, Duration::from_secs(1));
        let dg = datagram(42, &[7, 7, 7]);
        assert_eq!(ingest_datagram(&dg, &mut lim, t0), Some(in_stream_frame(42, &[7, 7, 7])));
        assert_eq!(ingest_datagram(&[0x4B], &mut lim, t0), None);
        assert!(ingest_datagram(&dg, &mut lim, t0).is_some());
        assert_eq!(ingest_datagram(&dg, &mut lim, t0), None, "over the limit");
    }

    type Sent = Arc<Mutex<Vec<Vec<u8>>>>;
    fn recorder() -> (Sent, impl FnMut(&[u8]) -> Result<(), DatagramSendError>) {
        let sent: Sent = Arc::new(Mutex::new(Vec::new()));
        let s2 = sent.clone();
        (sent, move |d: &[u8]| { s2.lock().unwrap().push(d.to_vec()); Ok(()) })
    }

    #[tokio::test]
    async fn subscribers_only_get_the_sharer_they_watch() {
        // Two sharers in one room, each with its own audio channel, as
        // handle_video_publish creates them.
        let (alice_tx, _) = broadcast::channel::<(Bytes, Instant)>(SHARE_AUDIO_CHANNEL_CAPACITY);
        let (bob_tx, _) = broadcast::channel::<(Bytes, Instant)>(SHARE_AUDIO_CHANNEL_CAPACITY);
        // A viewer watching Alice subscribes to Alice's channel only.
        let (sent, send) = recorder();
        let bytes = Arc::new(AtomicU64::new(0));
        let b2 = bytes.clone();
        let rx = alice_tx.subscribe();
        let task = tokio::spawn(async move { forward_datagrams(rx, send, &b2).await });

        let mut lim = ShareAudioRateLimiter::new(Instant::now());
        let a = datagram(1, b"alice-ciphertext");
        let b = datagram(1, b"bob-ciphertext");
        alice_tx.send((ingest_datagram(&a, &mut lim, Instant::now()).unwrap(), Instant::now())).unwrap();
        let _ = bob_tx.send((frame_from_datagram(&b), Instant::now()));
        // An old (in-stream) sharer's frame on Alice's channel → datagram too.
        alice_tx.send((in_stream_frame(2, b"alice-legacy"), Instant::now())).unwrap();
        alice_tx.send((Bytes::new(), Instant::now())).unwrap(); // end of stream
        let stats = task.await.unwrap();

        let got = sent.lock().unwrap().clone();
        assert_eq!(got, vec![a.clone(), datagram(2, b"alice-legacy")]);
        assert_eq!(stats.sent, 2);
        assert_eq!(bytes.load(Ordering::Relaxed), (a.len() + datagram(2, b"alice-legacy").len()) as u64);
    }

    #[tokio::test]
    async fn forwarder_drops_stale_and_rejected_and_stops_when_closed() {
        let (tx, _) = broadcast::channel::<(Bytes, Instant)>(SHARE_AUDIO_CHANNEL_CAPACITY);
        let rx = tx.subscribe();
        let calls = Arc::new(Mutex::new(0u32));
        let c2 = calls.clone();
        let send = move |_d: &[u8]| {
            let mut n = c2.lock().unwrap();
            *n += 1;
            match *n { 1 => Err(DatagramSendError::Rejected), 2 => Ok(()), _ => Err(DatagramSendError::Closed) }
        };
        let bytes = AtomicU64::new(0);
        let old = Instant::now() - (MAX_SHARE_AUDIO_AGE + Duration::from_millis(50));
        tx.send((in_stream_frame(1, b"stale"), old)).unwrap();
        tx.send((in_stream_frame(2, b"too-big"), Instant::now())).unwrap();
        tx.send((in_stream_frame(3, b"ok"), Instant::now())).unwrap();
        tx.send((in_stream_frame(4, b"conn-gone"), Instant::now())).unwrap();
        tx.send((in_stream_frame(5, b"never"), Instant::now())).unwrap();
        let stats = forward_datagrams(rx, send, &bytes).await;
        assert_eq!(stats.stale, 1);
        assert_eq!(stats.rejected, 1);
        assert_eq!(stats.sent, 1);
        assert_eq!(*calls.lock().unwrap(), 3, "stops at the first Closed");
    }

    #[tokio::test]
    async fn forwarder_skips_ahead_after_lagging() {
        let (tx, _) = broadcast::channel::<(Bytes, Instant)>(4);
        let rx = tx.subscribe();
        for i in 0..10u32 { tx.send((in_stream_frame(i, b"x"), Instant::now())).unwrap(); }
        drop(tx); // Closed after the backlog
        let (sent, send) = recorder();
        let bytes = AtomicU64::new(0);
        let stats = forward_datagrams(rx, send, &bytes).await;
        assert_eq!(stats.lagged, 6);
        let got = sent.lock().unwrap().clone();
        assert_eq!(got.first().unwrap(), &datagram(6, b"x"), "resumes at the oldest still buffered");
        assert_eq!(got.len(), 4);
    }

    #[tokio::test]
    async fn recv_opt_none_never_resolves() {
        let mut none: Option<broadcast::Receiver<(Bytes, Instant)>> = None;
        let r = tokio::time::timeout(Duration::from_millis(20), recv_opt(&mut none)).await;
        assert!(r.is_err());
        let (tx, rx) = broadcast::channel::<(Bytes, Instant)>(4);
        let mut some = Some(rx);
        tx.send((Bytes::from_static(b"a"), Instant::now())).unwrap();
        assert_eq!(recv_opt(&mut some).await.unwrap().0, Bytes::from_static(b"a"));
    }
}
