// messageStore.js — local message persistence (IndexedDB for browser)
// For Tauri, the same API surface is used via IndexedDB (tauri-plugin-sql is
// available but would require a separate migration; IndexedDB is sufficient
// for the current phase and works in both environments).

const DB_NAME = 'specter_messages';
const DB_VERSION = 1;

let _db = null;

function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('channel_messages')) {
        const cs = db.createObjectStore('channel_messages', { keyPath: 'id' });
        cs.createIndex('by_channel_ts', ['channel_id', 'timestamp']);
      }
      if (!db.objectStoreNames.contains('dm_messages')) {
        const dm = db.createObjectStore('dm_messages', { keyPath: 'id' });
        dm.createIndex('by_conv_ts', ['conversation_id', 'timestamp']);
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror  = ()  => reject(req.error);
  });
}

function txStore(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

// ── Channel messages ─────────────────────────────────────────────────────────
// `plaintext` is separate from `encrypted_content` and populated once this
// device successfully decrypts a message — see the identical note on
// saveDmMessage below (an MLS application message can only ever be
// decrypted once per receiving device, so it must be cached, not re-derived).

export async function saveChannelMessage(msg) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'channel_messages', 'readwrite');
    const req = store.put({
      id:                msg.id,
      channel_id:        msg.channel_id,
      sender_id:         msg.sender_id,
      callsign:          msg.callsign ?? null,
      global_tag:        msg.global_tag ?? null,
      encrypted_content: msg.encrypted_content,
      plaintext:         msg.plaintext ?? null,
      image_url:         msg.image_url ?? null,
      timestamp:         msg.timestamp,
      received_at:       new Date().toISOString(),
    });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function getChannelMessages(channelId, limit = 100) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'channel_messages', 'readonly');
    const idx   = store.index('by_channel_ts');
    const range = IDBKeyRange.bound([channelId, ''], [channelId, '\uffff']);
    const req   = idx.getAll(range);
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      resolve(rows.slice(-limit));
    };
    req.onerror = () => reject(req.error);
  });
}

// \u2500\u2500 Peer backfill sync helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// getLatest* drives the `since` a client asks peers to fill in from; the
// respond* pair looks up what THIS client can offer another peer that asked.
// saveChannelMessages/saveDmMessages bulk-upsert a peer's answer in one
// transaction \u2014 `put()` is keyed by message id, so replies from multiple
// peers (or overlapping history) just harmlessly overwrite, no dedup needed.

export async function getLatestChannelTimestamp(channelId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'channel_messages', 'readonly');
    const idx   = store.index('by_channel_ts');
    const range = IDBKeyRange.bound([channelId, ''], [channelId, '\uffff']);
    const req   = idx.openCursor(range, 'prev'); // descending \u2014 first hit is latest
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
    const range = IDBKeyRange.bound(lower, [channelId, '\uffff'], Boolean(since), false);
    const req   = idx.getAll(range);
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      resolve(rows.slice(0, limit));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveChannelMessages(channelId, msgs) {
  if (!msgs || msgs.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('channel_messages', 'readwrite');
    const store = tx.objectStore('channel_messages');
    for (const msg of msgs) {
      store.put({
        id:                msg.id,
        channel_id:        channelId,
        sender_id:         msg.sender_id,
        callsign:          msg.callsign ?? null,
        global_tag:        msg.global_tag ?? null,
        encrypted_content: msg.encrypted_content,
        plaintext:         msg.plaintext ?? null,
        image_url:         msg.image_url ?? null,
        timestamp:         msg.timestamp,
        received_at:       new Date().toISOString(),
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
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
export async function saveDmMessage(msg) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'dm_messages', 'readwrite');
    const req = store.put({
      id:                msg.id,
      conversation_id:   msg.conversation_id,
      sender_id:         msg.sender_id,
      to_user_id:        msg.to_user_id ?? null,
      callsign:          msg.callsign ?? null,
      encrypted_content: msg.encrypted_content,
      plaintext:         msg.plaintext ?? null,
      timestamp:         msg.timestamp,
      received_at:       new Date().toISOString(),
    });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function getDmMessages(conversationId, limit = 100) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'dm_messages', 'readonly');
    const idx   = store.index('by_conv_ts');
    const range = IDBKeyRange.bound([conversationId, ''], [conversationId, '\uffff']);
    const req   = idx.getAll(range);
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      resolve(rows.slice(-limit));
    };
    req.onerror = () => reject(req.error);
  });
}

// \u2500\u2500 Peer backfill sync helpers (DM side \u2014 see the channel versions above) \u2500\u2500

export async function getLatestDmTimestamp(conversationId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = txStore(db, 'dm_messages', 'readonly');
    const idx   = store.index('by_conv_ts');
    const range = IDBKeyRange.bound([conversationId, ''], [conversationId, '\uffff']);
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
    const range = IDBKeyRange.bound(lower, [conversationId, '\uffff'], Boolean(since), false);
    const req   = idx.getAll(range);
    req.onsuccess = () => {
      const rows = (req.result || []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      resolve(rows.slice(0, limit));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveDmMessages(conversationId, msgs) {
  if (!msgs || msgs.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('dm_messages', 'readwrite');
    const store = tx.objectStore('dm_messages');
    for (const msg of msgs) {
      store.put({
        id:                msg.id,
        conversation_id:   conversationId,
        sender_id:         msg.sender_id,
        to_user_id:        msg.to_user_id ?? null,
        callsign:          msg.callsign ?? null,
        encrypted_content: msg.encrypted_content,
        plaintext:         msg.plaintext ?? null,
        timestamp:         msg.timestamp,
        received_at:       new Date().toISOString(),
      });
    }
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}
