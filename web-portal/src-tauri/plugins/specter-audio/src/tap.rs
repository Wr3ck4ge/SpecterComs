//! PCM taps: a way for another part of the app to receive a copy of a PCM
//! stream this plugin produces, without being able to slow that stream down.
//!
//! Built for the future Go Live / Twitch output (docs/STREAMING_PLAN_2026_10_29.md,
//! S4's audio mix), which needs the raw 48 kHz share audio and, opt-in, the
//! decoded voice-channel mix, before either is Opus-encoded or played. There is
//! no consumer yet. The contract every tap keeps:
//!
//! - Publishing never blocks. Each subscriber has its own bounded channel and
//!   gets `try_send`; a subscriber that falls behind loses chunks (counted in
//!   `dropped()`), the capture thread / audio callback never waits on it.
//! - A dropped `Receiver` unsubscribes itself: the next publish sees the
//!   disconnect and removes that sender.
//! - With no subscribers, `is_active()` is false and producers skip building
//!   chunks altogether, so an unused tap costs one relaxed atomic load.

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::Arc;

/// One chunk of PCM handed to tap subscribers.
#[derive(Clone, Debug)]
pub struct PcmChunk {
    /// QPC milliseconds (QueryPerformanceCounter * 1000 / frequency) of the
    /// chunk's first sample: the same timebase the screen-capture encoder
    /// stamps video NAL units with, so a muxer can interleave them directly.
    /// Fractional on purpose: 20 ms frames at 48 kHz land on exact
    /// millisecond boundaries only by accident of the anchor.
    pub timestamp_ms: f64,
    /// Always 48 000 today.
    pub sample_rate: u32,
    /// 2 for share audio (interleaved L/R), 1 for the voice mix tap.
    pub channels: u16,
    /// Interleaved f32 samples in -1.0..=1.0.
    pub samples: Arc<[f32]>,
}

impl PcmChunk {
    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels.max(1) as usize
    }
}

#[derive(Default)]
pub struct PcmTap {
    subs: Mutex<Vec<SyncSender<PcmChunk>>>,
    active: AtomicBool,
    dropped: AtomicU64,
}

impl PcmTap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe a bounded channel of `capacity` chunks (20 ms each for both
    /// taps today, so 50 = one second of slack). Drop the receiver to
    /// unsubscribe.
    pub fn subscribe(&self, capacity: usize) -> Receiver<PcmChunk> {
        let (tx, rx) = sync_channel(capacity.max(1));
        let mut subs = self.subs.lock();
        subs.push(tx);
        self.active.store(true, Ordering::Relaxed);
        rx
    }

    /// Whether anyone is subscribed. Producers check this before allocating
    /// a chunk.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    /// Total chunks dropped because a subscriber's channel was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Hand `chunk` to every subscriber without blocking.
    pub(crate) fn publish(&self, chunk: PcmChunk) {
        let mut subs = self.subs.lock();
        if subs.is_empty() {
            return;
        }
        subs.retain(|tx| match tx.try_send(chunk.clone()) {
            Ok(()) => true,
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                true
            }
            Err(TrySendError::Disconnected(_)) => false,
        });
        self.active.store(!subs.is_empty(), Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(ts: f64) -> PcmChunk {
        PcmChunk { timestamp_ms: ts, sample_rate: 48_000, channels: 2, samples: Arc::from(vec![0.0f32; 4]) }
    }

    #[test]
    fn full_subscriber_drops_instead_of_blocking() {
        let tap = PcmTap::new();
        let rx = tap.subscribe(2);
        for i in 0..5 {
            tap.publish(chunk(i as f64));
        }
        assert_eq!(tap.dropped(), 3);
        assert_eq!(rx.try_recv().unwrap().timestamp_ms, 0.0);
        assert_eq!(rx.try_recv().unwrap().timestamp_ms, 1.0);
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn dropped_receiver_unsubscribes() {
        let tap = PcmTap::new();
        assert!(!tap.is_active());
        let rx = tap.subscribe(4);
        assert!(tap.is_active());
        drop(rx);
        tap.publish(chunk(0.0));
        assert!(!tap.is_active());
    }
}
