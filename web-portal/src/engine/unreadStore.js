// Unread text-message counts per channel (P2A), owned by the engine and
// published to the strip as EngineState.unread (src/engine/bridge.js).
//
// Counted from the SSE message_relay events the engine already receives for
// every text channel of every server the user is in (sseController.ts
// subscribes the connection to all of them) — no decrypting needed, only the
// relay's channel_id / sender_id / timestamp. Persisted in the engine
// window's localStorage so counts survive a restart, per account (MR2):
//   specter_unread_v1:<userId> = { counts: { [channelId]: n }, lastRead: { [channelId]: iso } }
// (The pre-2.0.1 shared key `specter_unread_v1` is ignored: counts start over
// once rather than leak between accounts on a shared PC.)
// lastRead is when the strip last showed the channel; a relay at or before it
// (an SSE replay after a reconnect) isn't counted again.

const KEY_PREFIX = 'specter_unread_v1:';
const MAX_SEEN = 1000;

const keyFor = (userId) => (userId ? `${KEY_PREFIX}${userId}` : null);

export function loadUnread(userId) {
  const key = keyFor(userId);
  if (!key) return { counts: {}, lastRead: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    return {
      counts: raw?.counts && typeof raw.counts === 'object' ? raw.counts : {},
      lastRead: raw?.lastRead && typeof raw.lastRead === 'object' ? raw.lastRead : {},
    };
  } catch {
    return { counts: {}, lastRead: {} };
  }
}

export function saveUnread(store, userId) {
  const key = keyFor(userId);
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(store)); } catch { /* not fatal */ }
}

// Relay ids already counted this session (SSE can redeliver after a reconnect),
// for one account: switching accounts starts a fresh set.
const seen = new Set();
let seenFor = null;
function markSeen(id, userId) {
  if (userId !== seenFor) { seen.clear(); seenFor = userId; }
  if (!id) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
  return true;
}

/**
 * Pure-ish reducer: the store after one message_relay payload, or the same
 * object when it doesn't count (DM, my own message, the channel being viewed,
 * older than lastRead, already counted).
 */
export function countRelay(store, payload, { userId, viewingChannelId }) {
  const ch = payload?.channel_id;
  if (!ch || payload.context === 'dm') return store;
  if (userId && payload.sender_id === userId) return store;
  if (ch === viewingChannelId) return store;
  const lastRead = store.lastRead[ch];
  if (lastRead && payload.timestamp && String(payload.timestamp) <= lastRead) return store;
  if (!markSeen(payload.id, userId)) return store;
  return { ...store, counts: { ...store.counts, [ch]: (store.counts[ch] || 0) + 1 } };
}

/** The channel was shown (or is being left after being shown): read up to now. */
export function markRead(store, channelId, now = new Date().toISOString()) {
  if (!channelId) return store;
  const counts = { ...store.counts };
  delete counts[channelId];
  return { counts, lastRead: { ...store.lastRead, [channelId]: now } };
}

/**
 * Messages the Rust background sync cached while the engine wasn't running
 * (App.jsx's drainMessageCache): count those newer than lastRead.
 * byChannel = { [channelId]: messageRows }.
 */
export function countCachedMessages(byChannel, userId) {
  if (!userId) return; // whose counts? (per account since MR2)
  const store = loadUnread(userId);
  let changed = false;
  const counts = { ...store.counts };
  for (const [ch, rows] of Object.entries(byChannel || {})) {
    const lastRead = store.lastRead[ch];
    for (const m of rows || []) {
      if (userId && m.sender_id === userId) continue;
      if (lastRead && m.timestamp && String(m.timestamp) <= lastRead) continue;
      if (!markSeen(m.id, userId)) continue;
      counts[ch] = (counts[ch] || 0) + 1;
      changed = true;
    }
  }
  if (changed) {
    saveUnread({ ...store, counts }, userId);
    // WarRoom may already be running with its own copy: tell it to reload.
    try { window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT)); } catch { /* no window */ }
  }
}

export const UNREAD_CHANGED_EVENT = 'specter-unread-changed';
