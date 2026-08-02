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

// ── DM messages ──────────────────────────────────────────────────────────────

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
