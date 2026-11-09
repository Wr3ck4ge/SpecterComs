//! Org drain support: the registry of live video sessions (so `drain_org`
//! can close share publish/subscribe sessions, not just voice — eval M9) and
//! the tracker behind the heartbeat's `draining` flag.
//!
//! Neither is touched on the media path: a video session registers once when
//! it is accepted and deregisters when it ends; the tracker is read once per
//! heartbeat. Both use a std Mutex that is never held across an await.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Something a drain can close. Implemented for the WebTransport connection;
/// tests use a mock.
pub trait CloseHandle: Send + Sync {
    fn close_for_drain(&self);
}

impl CloseHandle for wtransport::Connection {
    fn close_for_drain(&self) {
        // Same code as a voice kick/drain (0). The handler's own reads then
        // fail and it runs its normal cleanup (viewer counts, sharer-left
        // announce, usage event), and the client reconnects — re-ticketing
        // onto whichever node the org is now placed on.
        self.close(wtransport::VarInt::from_u32(0), b"Org Drained");
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding one of these locks can't leave the map in a
    // state worth refusing to read.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct VideoEntry<C: ?Sized> {
    org_id: String,
    conn: Arc<C>,
}

/// Live video sessions (publish and subscribe), keyed by a per-session id.
pub struct VideoSessionRegistry<C: ?Sized + CloseHandle> {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, VideoEntry<C>>>,
}

impl<C: ?Sized + CloseHandle> Default for VideoSessionRegistry<C> {
    fn default() -> Self {
        Self { next_id: AtomicU64::new(1), sessions: Mutex::new(HashMap::new()) }
    }
}

/// Deregisters its session when dropped (every exit path of the handler).
pub struct VideoSessionGuard<C: ?Sized + CloseHandle> {
    registry: Arc<VideoSessionRegistry<C>>,
    id: u64,
}

impl<C: ?Sized + CloseHandle> Drop for VideoSessionGuard<C> {
    fn drop(&mut self) {
        lock(&self.registry.sessions).remove(&self.id);
    }
}

impl<C: ?Sized + CloseHandle> VideoSessionRegistry<C> {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn register(self: &Arc<Self>, org_id: &str, conn: Arc<C>) -> VideoSessionGuard<C> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        lock(&self.sessions).insert(id, VideoEntry { org_id: org_id.to_string(), conn });
        VideoSessionGuard { registry: Arc::clone(self), id }
    }

    /// Close every video session of `org_id`. Returns how many were closed.
    /// The connections are collected under the lock and closed after it is
    /// released.
    pub fn close_org(&self, org_id: &str) -> usize {
        let targets: Vec<Arc<C>> = lock(&self.sessions)
            .values()
            .filter(|e| e.org_id == org_id)
            .map(|e| Arc::clone(&e.conn))
            .collect();
        for c in &targets {
            c.close_for_drain();
        }
        targets.len()
    }

    pub fn count_org(&self, org_id: &str) -> usize {
        lock(&self.sessions).values().filter(|e| e.org_id == org_id).count()
    }

    pub fn len(&self) -> usize {
        lock(&self.sessions).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// `draining` is reported for at least this long after a drain_org, so the
/// control plane sees it on at least one heartbeat even if the org's
/// sessions all close at once.
pub const DRAIN_MIN_HOLD: Duration = Duration::from_secs(10);
/// ...and for at most this long, even if some of the org's clients keep
/// coming back here (e.g. the org wasn't actually re-placed).
pub const DRAIN_MAX: Duration = Duration::from_secs(60);

/// Pure rule: is a drain that started `elapsed` ago still in progress?
pub fn drain_in_progress(elapsed: Duration, org_still_has_sessions: bool) -> bool {
    elapsed < DRAIN_MIN_HOLD || (org_still_has_sessions && elapsed < DRAIN_MAX)
}

/// Orgs with a drain in progress on this node: org_id -> when it started.
#[derive(Default)]
pub struct DrainTracker {
    started: Mutex<HashMap<String, Instant>>,
}

impl DrainTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Record a drain_org (a repeat restarts the clock).
    pub fn begin(&self, org_id: &str) {
        self.begin_at(org_id, Instant::now());
    }

    pub fn begin_at(&self, org_id: &str, at: Instant) {
        lock(&self.started).insert(org_id.to_string(), at);
    }

    /// Orgs currently tracked (for the heartbeat to look their sessions up).
    pub fn orgs(&self) -> Vec<String> {
        lock(&self.started).keys().cloned().collect()
    }

    /// True if any drain is still in progress at `now`; forgets drains that
    /// have finished. `has_sessions(org)` says whether the org still has any
    /// voice or video session on this node.
    pub fn evaluate(&self, now: Instant, has_sessions: impl Fn(&str) -> bool) -> bool {
        let mut map = lock(&self.started);
        map.retain(|org, started| drain_in_progress(now.saturating_duration_since(*started), has_sessions(org)));
        !map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[derive(Default)]
    struct Mock(AtomicUsize);
    impl CloseHandle for Mock {
        fn close_for_drain(&self) { self.0.fetch_add(1, Ordering::SeqCst); }
    }

    #[test]
    fn close_org_closes_only_that_org_and_guards_deregister() {
        let reg: Arc<VideoSessionRegistry<Mock>> = VideoSessionRegistry::new();
        let (a1, a2, b) = (Arc::new(Mock::default()), Arc::new(Mock::default()), Arc::new(Mock::default()));
        let g1 = reg.register("org-a", a1.clone());
        let _g2 = reg.register("org-a", a2.clone());
        let _g3 = reg.register("org-b", b.clone());
        assert_eq!(reg.len(), 3);
        assert_eq!(reg.count_org("org-a"), 2);

        assert_eq!(reg.close_org("org-a"), 2);
        assert_eq!((a1.0.load(Ordering::SeqCst), a2.0.load(Ordering::SeqCst), b.0.load(Ordering::SeqCst)), (1, 1, 0));
        assert_eq!(reg.close_org("nobody"), 0);

        drop(g1);
        assert_eq!(reg.count_org("org-a"), 1);
        assert_eq!(reg.len(), 2);
    }

    #[test]
    fn drain_window() {
        assert!(drain_in_progress(Duration::ZERO, false));
        assert!(drain_in_progress(Duration::from_secs(9), false));
        assert!(!drain_in_progress(Duration::from_secs(10), false));
        assert!(drain_in_progress(Duration::from_secs(59), true));
        assert!(!drain_in_progress(Duration::from_secs(60), true));
    }

    #[test]
    fn tracker_forgets_finished_drains() {
        let t = DrainTracker::new();
        let t0 = Instant::now();
        assert!(!t.evaluate(t0, |_| true), "nothing tracked");
        t.begin_at("org-a", t0);
        assert!(t.evaluate(t0 + Duration::from_secs(5), |_| false));
        assert!(t.evaluate(t0 + Duration::from_secs(30), |o| o == "org-a"));
        assert!(!t.evaluate(t0 + Duration::from_secs(30), |_| false));
        assert!(t.orgs().is_empty(), "finished drain is forgotten");
    }
}
