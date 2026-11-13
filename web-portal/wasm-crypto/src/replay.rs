//! Authenticated replay protection shared by relay voice (`relay_audio.rs`,
//! wire v3) and screen-share frames (`share_frame.rs`, wire v2).
//!
//! * [`ReplayWindow`]: a 128-frame sliding window over a per-session 64-bit
//!   sequence number.
//! * [`SessionTable`]: a bounded map of per-session state (derived cipher +
//!   window), LRU-evicted per group (relay audio: per ssrc; share frames: per
//!   (sharer, kind)) and in total. An evicted session's high-water mark is
//!   remembered (bounded) so its old frames stay rejected if it is re-admitted.
//!
//! [`SessionTable::open`] runs the exact order relay audio has always used:
//! window check → AEAD open → skew check → window accept. Nothing is stored
//! until the tag verified, so a party without the key can't create state,
//! burn window slots or evict genuine sessions; a stale (authentic but
//! out-of-skew) frame changes no state.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

/// Replay window width in frames (bitmap in a u128). At 50 frames/s this
/// tolerates ~2.5s of reordering, far beyond what the jitter path keeps.
pub const REPLAY_WINDOW: u64 = 128;

/// The frame's sequence number was already accepted, or is older than the
/// window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Replayed;

#[derive(Clone, Copy, Default)]
pub struct ReplayWindow {
    /// Highest authenticated sequence seen.
    highest: u64,
    /// Bit i set ⇔ (highest - i) was accepted.
    bitmap: u128,
}

impl ReplayWindow {
    pub fn fresh(seq: u64) -> Self {
        ReplayWindow { highest: seq, bitmap: 0 }
    }

    /// Window for a session re-admitted after eviction: everything at or
    /// below its last known high-water mark counts as already seen.
    pub fn resumed(highest: u64) -> Self {
        ReplayWindow { highest, bitmap: u128::MAX }
    }

    pub fn highest(&self) -> u64 {
        self.highest
    }

    pub fn check(&self, seq: u64) -> Result<(), Replayed> {
        if seq > self.highest {
            return Ok(());
        }
        let back = self.highest - seq;
        if back >= REPLAY_WINDOW {
            return Err(Replayed);
        }
        if self.bitmap & (1u128 << back) != 0 {
            return Err(Replayed);
        }
        Ok(())
    }

    pub fn accept(&mut self, seq: u64) {
        if seq > self.highest {
            let shift = seq - self.highest;
            self.bitmap = if shift >= REPLAY_WINDOW { 0 } else { self.bitmap << shift };
            self.highest = seq;
            self.bitmap |= 1;
        } else {
            self.bitmap |= 1u128 << (self.highest - seq);
        }
    }
}

/// Session key of a [`SessionTable`]: `group()` is the unit the per-group
/// session cap applies to.
pub trait SessionKey: Copy + Eq + Hash {
    type Group: Copy + Eq;
    fn group(&self) -> Self::Group;
}

/// Bounds of a [`SessionTable`].
#[derive(Clone, Copy)]
pub struct Limits {
    pub per_group: usize,
    pub total: usize,
    pub retired: usize,
}

/// Why [`SessionTable::open`] refused a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenError<E> {
    Replay,
    /// Authentic frame outside the caller's skew bound.
    Stale,
    /// The caller's decrypt failed (its own error).
    Decrypt(E),
}

struct Entry<S> {
    state: S,
    window: ReplayWindow,
    last_used: u64,
}

pub struct SessionTable<K: SessionKey, S> {
    limits: Limits,
    sessions: HashMap<K, Entry<S>>,
    retired: HashMap<K, u64>,
    retired_order: VecDeque<K>,
    tick: u64,
}

impl<K: SessionKey, S> SessionTable<K, S> {
    pub fn new(limits: Limits) -> Self {
        SessionTable {
            limits,
            sessions: HashMap::new(),
            retired: HashMap::new(),
            retired_order: VecDeque::new(),
            tick: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn retired_len(&self) -> usize {
        self.retired.len()
    }

    /// Forgets every session and retired high-water mark.
    pub fn clear(&mut self) {
        self.sessions.clear();
        self.retired.clear();
        self.retired_order.clear();
    }

    /// Replay-checks, decrypts (`decrypt` with the session's state, built by
    /// `make` for an unknown session), skew-checks (`fresh`, already computed
    /// from the — still unauthenticated — header) and only then records the
    /// frame. See the module docs for the ordering rationale.
    pub fn open<E>(
        &mut self,
        key: K,
        seq: u64,
        fresh: bool,
        make: impl FnOnce() -> S,
        decrypt: impl FnOnce(&S) -> Result<Vec<u8>, E>,
    ) -> Result<Vec<u8>, OpenError<E>> {
        self.tick += 1;
        let tick = self.tick;

        if let Some(entry) = self.sessions.get_mut(&key) {
            entry.window.check(seq).map_err(|_| OpenError::Replay)?;
            let pt = decrypt(&entry.state).map_err(OpenError::Decrypt)?;
            if !fresh {
                return Err(OpenError::Stale);
            }
            entry.window.accept(seq);
            entry.last_used = tick;
            return Ok(pt);
        }

        // Unknown (or evicted) session.
        let mut window = match self.retired.get(&key) {
            Some(&highest) => {
                let w = ReplayWindow::resumed(highest);
                w.check(seq).map_err(|_| OpenError::Replay)?;
                w
            }
            None => ReplayWindow::fresh(seq),
        };
        let state = make();
        let pt = decrypt(&state).map_err(OpenError::Decrypt)?;
        if !fresh {
            return Err(OpenError::Stale);
        }
        window.accept(seq);
        if self.retired.remove(&key).is_some() {
            self.retired_order.retain(|k| k != &key);
        }
        self.make_room_for(key.group());
        self.sessions.insert(key, Entry { state, window, last_used: tick });
        Ok(pt)
    }

    fn make_room_for(&mut self, group: K::Group) {
        let same_group = self.sessions.keys().filter(|k| k.group() == group).count();
        if same_group >= self.limits.per_group {
            self.evict_lru(Some(group));
        }
        if self.sessions.len() >= self.limits.total {
            self.evict_lru(None);
        }
    }

    fn evict_lru(&mut self, only_group: Option<K::Group>) {
        let victim = self
            .sessions
            .iter()
            .filter(|(k, _)| only_group.is_none_or(|g| k.group() == g))
            .min_by_key(|(_, e)| e.last_used)
            .map(|(k, _)| *k);
        if let Some((k, e)) = victim.and_then(|k| self.sessions.remove(&k).map(|e| (k, e))) {
            self.retire(k, e.window.highest);
        }
    }

    fn retire(&mut self, key: K, highest: u64) {
        if self.retired.insert(key, highest).is_none() {
            self.retired_order.push_back(key);
        }
        while self.retired_order.len() > self.limits.retired {
            if let Some(old) = self.retired_order.pop_front() {
                self.retired.remove(&old);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_shift_math() {
        let mut w = ReplayWindow::fresh(10);
        w.accept(10);
        assert_eq!(w.check(10), Err(Replayed));
        assert!(w.check(9).is_ok());
        w.accept(10 + REPLAY_WINDOW + 5);
        assert_eq!(w.check(10), Err(Replayed)); // fell out of window
        assert!(w.check(10 + REPLAY_WINDOW + 4).is_ok());
        w.accept(u64::MAX - 1);
        assert_eq!(w.check(u64::MAX - 1), Err(Replayed));
        assert!(w.check(u64::MAX).is_ok());
    }

    #[derive(Clone, Copy, PartialEq, Eq, Hash)]
    struct K(u8, u8);
    impl SessionKey for K {
        type Group = u8;
        fn group(&self) -> u8 {
            self.0
        }
    }

    #[test]
    fn clear_forgets_everything() {
        let mut t: SessionTable<K, ()> = SessionTable::new(Limits { per_group: 1, total: 4, retired: 4 });
        let ok = |_: &()| Ok::<_, ()>(vec![1]);
        assert!(t.open(K(1, 1), 0, true, || (), ok).is_ok());
        assert!(t.open(K(1, 2), 0, true, || (), ok).is_ok()); // evicts K(1,1)
        assert_eq!(t.len(), 1);
        assert_eq!(t.retired_len(), 1);
        assert_eq!(t.open(K(1, 1), 0, true, || (), ok), Err(OpenError::Replay));
        t.clear();
        assert_eq!((t.len(), t.retired_len()), (0, 0));
        assert!(t.open(K(1, 1), 0, true, || (), ok).is_ok());
    }
}
