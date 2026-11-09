// messageStore.js — local message persistence (IndexedDB for browser)
// For Tauri, the same API surface is used via IndexedDB (tauri-plugin-sql is
// available but would require a separate migration; IndexedDB is sufficient
// for the current phase and works in both environments).
//
// MR2: one database PER ACCOUNT — `specter_messages_<userId>` — so on a
// shared PC one account never sees another's decrypted history. The account
// is set by the engine (setMessageStoreUser, from WarRoom); callers that run
// before that (App.jsx's message-cache drain) fall back to the logged-in
// user in localStorage. With no account at all every call rejects.
//
// The pre-2.0.1 shared database `specter_messages` is adopted (copied into
// the owner's database, then deleted) only by the account the Rust side
// names as the legacy MLS state's owner (invoke('mls_legacy_owner'), MR3). If
// that's another account, or unknown (null), the legacy database stays
// unopened.

import { mergeChannelRow, mergeDmRow, isReadable } from './engine/chatSyncCore.js';

const LEGACY_DB_NAME = 'specter_messages';
const DB_PREFIX = 'specter_messages_';
const DB_VERSION = 1;

let _userId = null;     // set by setMessageStoreUser
let _db = null;         // { userId, db }
let _opening = null;    // { userId, promise }

const dbNameFor = (userId) => `${DB_PREFIX}${userId}`;

function upgrade(e) {
  const db = e.target.result;
  if (!db.objectStoreNames.contains('channel_messages')) {
    const cs = db.createObjectStore('channel_messages', { keyPath: 'id' });
    cs.createIndex('by_channel_ts', ['channel_id', 'timestamp']);
  }
  if (!db.objectStoreNames.contains('dm_messages')) {
    const dm = db.createObjectStore('dm_messages', { keyPath: 'id' });
    dm.createIndex('by_conv_ts', ['conversation_id', 'timestamp']);
  }
}

function fallbackUserId() {
  try { return JSON.parse(localStorage.getItem('specter_user') || 'null')?.id ?? null; } catch { return null; }
}

/** The account whose history the store reads/writes (null = none). */
export function getMessageStoreUser() {
  return _userId || fallbackUserId();
}

/**
 * Switch the store to this account's database (null = logged out: closes
 * it). Safe to call repeatedly with the same id.
 */
export function setMessageStoreUser(userId) {
  const next = userId || null;
  if (next === _userId) return;
  _userId = next;
  if (_db && _db.userId !== next) {
    try { _db.db.close(); } catch { /* already closed */ }
    _db = null;
  }
}

function openNamed(name, { allowCreate = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = (e) => {
      if (!allowCreate) { e.target.transaction.abort(); return; }
      upgrade(e);
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked`));
  });
}

async function legacyDbExists() {
  try {
    if (typeof indexedDB.databases === 'function') {
      const list = await indexedDB.databases();
      return list.some((d) => d.name === LEGACY_DB_NAME);
    }
  } catch { /* fall through */ }
  // No databases(): opening without permission to create tells us (the
  // upgrade is aborted when it doesn't exist, and nothing is created).
  try {
    const db = await openNamed(LEGACY_DB_NAME, { allowCreate: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

async function legacyOwner() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const owner = await invoke('mls_legacy_owner');
    return typeof owner === 'string' && owner ? owner : null;
  } catch {
    return null; // MR3 not present / no legacy state: leave the legacy DB alone
  }
}

function readAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Copy the shared pre-2.0.1 history into `userId`'s database, if it's theirs. */
async function adoptLegacyIfOwner(userId, db) {
  if (!(await legacyDbExists())) return;
  const owner = await legacyOwner();
  if (!owner || owner !== userId) return;
  let legacy;
  try {
    legacy = await openNamed(LEGACY_DB_NAME, { allowCreate: false });
  } catch {
    return;
  }
  try {
    const channel = legacy.objectStoreNames.contains('channel_messages') ? await readAll(legacy, 'channel_messages') : [];
    const dm = legacy.objectStoreNames.contains('dm_messages') ? await readAll(legacy, 'dm_messages') : [];
    await mergeChannelRowsInto(db, channel);
    await mergeRowsInto(db, 'dm_messages', mergeDmRow, dm);
  } finally {
    legacy.close();
  }
  // Copied: remove the shared copy so no other account can ever adopt it.
  await new Promise((resolve) => {
    const del = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    del.onsuccess = del.onerror = del.onblocked = () => resolve();
  });
}

function openDb() {
  const userId = getMessageStoreUser();
  if (!userId) return Promise.reject(new Error('No account: message history is unavailable'));
  if (_db && _db.userId === userId) return Promise.resolve(_db.db);
  if (_opening && _opening.userId === userId) return _opening.promise;
  const promise = (async () => {
    const db = await openNamed(dbNameFor(userId));
    try { await adoptLegacyIfOwner(userId, db); } catch (err) { console.warn('[messageStore] legacy adoption failed:', err); }
    // Switched accounts while opening: hand it out for this call only.
    if (getMessageStoreUser() === userId) _db = { userId, db };
    db.onversionchange = () => { db.close(); if (_db?.db === db) _db = null; };
    return db;
  })();
  _opening = { userId, promise };
  promise.finally(() => { if (_opening?.promise === promise) _opening = null; }).catch(() => {});
  return promise;
}

function txStore(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

// ── Channel messages ─────────────────────────────────────────────────────────
// `plaintext` is separate from `encrypted_content` and populated once this
// device successfully decrypts a message — see the identical note on
// saveDmMessage below (an MLS application message can only ever be
// decrypted once per receiving device, so it must be cached, not re-derived).
//
// MR2: every write is a merge (chatSyncCore.mergeChannelRow): a readable row
// is never overwritten by an unreadable copy of the same id, and an
// unreadable row (pending: "Waiting for key…") is replaced as soon as a
// readable copy arrives — from a retry, the live relay or a peer's backfill.

/** Merge rows into the channel store in one transaction; resolves with the rows actually written. */
function mergeChannelRowsInto(db, msgs, channelId) {
  return mergeRowsInto(db, 'channel_messages', mergeChannelRow, msgs, channelId ? { channel_id: channelId } : null);
}

function mergeRowsInto(db, storeName, merge, msgs, fixed) {
  return new Promise((resolve, reject) => {
    const written = [];
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const msg of msgs) {
      if (!msg?.id || !msg.timestamp) continue;
      const incoming = fixed ? { ...msg, ...fixed } : msg;
      const get = store.get(incoming.id);
      get.onsuccess = () => {
        const row = merge(get.result, incoming);
        if (row) { store.put(row); written.push(row); }
      };
    }
    tx.oncomplete = () => resolve(written);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/** Upsert one message (merge rules above). Resolves with the stored row, or null if unchanged. */
export async function saveChannelMessage(msg) {
  const db = await openDb();
  const written = await mergeChannelRowsInto(db, [msg]);
  return written[0] ?? null;
}

export async function getChannelMessages(channelId, limit = 100) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'channel_messages', 'readonly');
    const idx   = store.index('by_channel_ts');
    const range = IDBKeyRange.bound([channelId, ''], [channelId, '￿']);
    const req   = idx.getAll(range);
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      resolve(rows.slice(-limit));
    };
    req.onerror = () => reject(req.error);
  });
}

/** MR2: every stored row of a channel (oldest first). */
export function getAllChannelMessages(channelId) {
  return getChannelMessages(channelId, Number.MAX_SAFE_INTEGER);
}

/** MR2: the channel's rows that still can't be read (oldest first). */
export async function getUnreadableChannelMessages(channelId) {
  return (await getAllChannelMessages(channelId)).filter((r) => !isReadable(r));
}

// ── Peer backfill sync helpers ──────────────────────────────────────────────
// getLatest* drives the `since` a client asks peers to fill in from; the
// respond* pair looks up what THIS client can offer another peer that asked.
// saveChannelMessages/saveDmMessages bulk-upsert a peer's answer in one
// transaction — keyed by message id, so replies from multiple peers (or
// overlapping history) merge per the rules above.

export async function getLatestChannelTimestamp(channelId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'channel_messages', 'readonly');
    const idx   = store.index('by_channel_ts');
    const range = IDBKeyRange.bound([channelId, ''], [channelId, '￿']);
    const req   = idx.openCursor(range, 'prev'); // descending — first hit is latest
    req.onsuccess = (e) => resolve(e.target.result ? e.target.result.value.timestamp : null);
    req.onerror   = () => reject(req.error);
  });
}

export async function getChannelMessagesSince(channelId, since, limit = 200) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'channel_messages', 'readonly');
    const idx   = store.index('by_channel_ts');
    const lower = since ? [channelId, since] : [channelId, ''];
    const range = IDBKeyRange.bound(lower, [channelId, '￿'], Boolean(since), false);
    const req   = idx.getAll(range);
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      resolve(rows.slice(0, limit));
    };
    req.onerror = () => reject(req.error);
  });
}

/** Bulk merge-upsert; resolves with the rows actually written. */
export async function saveChannelMessages(channelId, msgs) {
  if (!msgs || msgs.length === 0) return [];
  const db = await openDb();
  return mergeChannelRowsInto(db, msgs, channelId);
}

// ── DM messages ──────────────────────────────────────────────────────────────

// `plaintext` is separate from `encrypted_content` and populated once this
// device successfully decrypts a message — an MLS application message can
// only ever be decrypted once per receiving device (the ratchet consumes
// that generation's key), so re-opening the app must read the cached
// plaintext rather than re-attempt decryption, which would fail. The raw
// `encrypted_content` stays untouched alongside it so this device can still
// answer another peer's backfill sync-request with genuine ciphertext (see
// getDmMessagesSince below) rather than leaking plaintext into that relay.
// MR2: DM writes merge like channel writes (chatSyncCore.mergeDmRow).
/** Upsert one DM (merge rules). Resolves with the stored row, or null if unchanged. */
export async function saveDmMessage(msg) {
  const db = await openDb();
  const written = await mergeRowsInto(db, 'dm_messages', mergeDmRow, [msg]);
  return written[0] ?? null;
}

export async function getDmMessages(conversationId, limit = 100) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'dm_messages', 'readonly');
    const idx   = store.index('by_conv_ts');
    const range = IDBKeyRange.bound([conversationId, ''], [conversationId, '￿']);
    const req   = idx.getAll(range);
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      resolve(rows.slice(-limit));
    };
    req.onerror = () => reject(req.error);
  });
}

// ── Peer backfill sync helpers (DM side — see the channel versions above) ──

export async function getLatestDmTimestamp(conversationId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'dm_messages', 'readonly');
    const idx   = store.index('by_conv_ts');
    const range = IDBKeyRange.bound([conversationId, ''], [conversationId, '￿']);
    const req   = idx.openCursor(range, 'prev');
    req.onsuccess = (e) => resolve(e.target.result ? e.target.result.value.timestamp : null);
    req.onerror   = () => reject(req.error);
  });
}

export async function getDmMessagesSince(conversationId, since, limit = 200) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'dm_messages', 'readonly');
    const idx   = store.index('by_conv_ts');
    const lower = since ? [conversationId, since] : [conversationId, ''];
    const range = IDBKeyRange.bound(lower, [conversationId, '￿'], Boolean(since), false);
    const req   = idx.getAll(range);
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      resolve(rows.slice(0, limit));
    };
    req.onerror = () => reject(req.error);
  });
}

/** Bulk merge-upsert of one conversation's DMs; resolves with the rows actually written. */
export async function saveDmMessages(conversationId, msgs) {
  if (!msgs || msgs.length === 0) return [];
  const db = await openDb();
  return mergeRowsInto(db, 'dm_messages', mergeDmRow, msgs, { conversation_id: conversationId });
}
