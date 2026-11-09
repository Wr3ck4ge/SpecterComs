// MR2: the pure parts of channel-chat delivery and catch-up — merging a row
// into local history, picking what to ask peers for and what to answer them
// with, and the backfill bundle format. No React, IndexedDB, MLS or network
// here, so it runs under plain node (scripts/test-chat-delivery.mjs).
//
// A stored channel row (messageStore.js):
//   { id, channel_id, sender_id, callsign, global_tag, encrypted_content,
//     plaintext: string | null, image_url, timestamp, received_at,
//     pending, fail_reason, attempts, relayed_by }
// plaintext null = not readable yet. Such a row is never final: it's
// `pending` (shown as "Waiting for key…"), retried when its channel's MLS
// group changes (fail_reason permitting) and replaced by a peer's backfill.

/** Peer replies carry at most this many messages per channel. */
export const SYNC_REPLY_MAX = 200;
/** Responders wait a random 0..SYNC_JITTER_MS before answering. */
export const SYNC_JITTER_MS = 1500;
/**
 * Plaintext budget of one backfill bundle (JSON bytes before MLS + base64).
 * The server takes a bundle of at most 95 000 base64 chars (express.json's
 * 100 kB body limit): 48 kB → ~64 kB base64 plus MLS overhead.
 */
export const BUNDLE_MAX_BYTES = 48_000;
/** Bundle format version (inside the ciphertext). */
export const BUNDLE_VERSION = 1;
/** A pending row is retried on group changes at most this many times. */
export const MAX_DECRYPT_ATTEMPTS = 8;
/**
 * MlsDecryptError reasons (mlsSession.js, MR1) a retry can't fix: the message
 * is from an epoch this device will never hold, or it's garbage. Those rows
 * wait for a peer's backfill instead.
 */
export const TERMINAL_FAIL_REASONS = Object.freeze(['epoch_too_old', 'corrupt']);

export const isReadable = (row) => typeof row?.plaintext === 'string';

const cmpTs = (a, b) => String(a?.timestamp ?? '').localeCompare(String(b?.timestamp ?? ''));
export const sortByTimestamp = (rows) => [...rows].sort(cmpTs);

/** The stored shape of a row (defaults filled, unknown fields dropped). */
export function normalizeRow(msg, channelId = msg?.channel_id) {
  const readable = typeof msg.plaintext === 'string';
  return {
    id:                msg.id,
    channel_id:        channelId,
    sender_id:         msg.sender_id ?? null,
    callsign:          msg.callsign ?? null,
    global_tag:        msg.global_tag ?? null,
    encrypted_content: msg.encrypted_content ?? null,
    plaintext:         readable ? msg.plaintext : null,
    image_url:         msg.image_url ?? null,
    timestamp:         msg.timestamp,
    received_at:       msg.received_at ?? new Date().toISOString(),
    pending:           !readable,
    fail_reason:       readable ? null : (msg.fail_reason ?? null),
    attempts:          readable ? 0 : (msg.attempts ?? 0),
    relayed_by:        msg.relayed_by ?? null,
  };
}

/**
 * The row to store when `incoming` arrives for an id that may already exist,
 * or null when nothing should change. Rules:
 *   - a readable stored row is final: never replaced (not by a null, and not
 *     by a different text from a relayer — first good copy wins);
 *   - a readable incoming row replaces an unreadable one (keeping the stored
 *     ciphertext if the incoming one has none, e.g. a backfill bundle);
 *   - unreadable over unreadable keeps the row, refreshing fail_reason /
 *     attempts and filling a missing ciphertext.
 */
export function mergeChannelRow(existing, incoming) {
  return mergeNormalized(existing, normalizeRow(incoming, incoming.channel_id ?? existing?.channel_id));
}

/** A stored DM row (messageStore dm_messages) — same pending fields as channels. */
export function normalizeDmRow(msg, conversationId = msg?.conversation_id) {
  const readable = typeof msg.plaintext === 'string';
  return {
    id:                msg.id,
    conversation_id:   conversationId,
    sender_id:         msg.sender_id ?? null,
    to_user_id:        msg.to_user_id ?? null,
    callsign:          msg.callsign ?? null,
    encrypted_content: msg.encrypted_content ?? null,
    plaintext:         readable ? msg.plaintext : null,
    timestamp:         msg.timestamp,
    received_at:       msg.received_at ?? new Date().toISOString(),
    pending:           !readable,
    fail_reason:       readable ? null : (msg.fail_reason ?? null),
    attempts:          readable ? 0 : (msg.attempts ?? 0),
    relayed_by:        msg.relayed_by ?? null,
  };
}

/** mergeChannelRow's rules for a DM row. */
export function mergeDmRow(existing, incoming) {
  return mergeNormalized(existing, normalizeDmRow(incoming, incoming.conversation_id ?? existing?.conversation_id));
}

function mergeNormalized(existing, next) {
  if (!existing) return next;
  if (isReadable(existing)) return null;
  if (isReadable(next)) {
    return {
      ...next,
      encrypted_content: next.encrypted_content ?? existing.encrypted_content ?? null,
      received_at: existing.received_at ?? next.received_at,
    };
  }
  const merged = {
    ...existing,
    pending: true,
    encrypted_content: existing.encrypted_content ?? next.encrypted_content ?? null,
    fail_reason: next.fail_reason ?? existing.fail_reason ?? null,
    attempts: Math.max(existing.attempts ?? 0, next.attempts ?? 0),
  };
  const same = merged.encrypted_content === existing.encrypted_content
    && merged.fail_reason === existing.fail_reason
    && merged.attempts === (existing.attempts ?? 0)
    && existing.pending === true;
  return same ? null : merged;
}

/** Would decrypting this unreadable row again possibly work? */
export function isRetryable(row, maxAttempts = MAX_DECRYPT_ATTEMPTS) {
  if (!row || isReadable(row)) return false;
  if (!row.encrypted_content) return false; // nothing to decrypt; backfill only
  if (TERMINAL_FAIL_REASONS.includes(row.fail_reason)) return false;
  return (row.attempts ?? 0) < maxAttempts;
}

/** A channel's unreadable rows worth retrying, oldest first (MLS is order-sensitive). */
export const pickRetryRows = (rows, maxAttempts) => sortByTimestamp(rows.filter((r) => isRetryable(r, maxAttempts)));

/**
 * What to ask peers for: everything after my newest readable message, or —
 * if some rows still can't be read — from just before the oldest of those, so
 * a backfill can replace them. null = "everything you have" (empty history).
 */
export function computeSyncSince(rows) {
  if (!rows?.length) return null;
  const sorted = sortByTimestamp(rows);
  const firstUnreadable = sorted.find((r) => !isReadable(r));
  if (firstUnreadable?.timestamp) {
    const t = Date.parse(firstUnreadable.timestamp);
    if (Number.isFinite(t)) return t > 0 ? new Date(t - 1).toISOString() : null;
  }
  return sorted[sorted.length - 1].timestamp ?? null;
}

/**
 * What I can answer a peer's request with: my readable rows newer than
 * `since` (oldest first, the first SYNC_REPLY_MAX — the requester's next
 * catch-up continues from there), or my newest SYNC_REPLY_MAX for an empty
 * history (since null). Rows I only hold as ciphertext are never offered.
 */
export function selectReplyRows(rows, since, max = SYNC_REPLY_MAX) {
  const readable = sortByTimestamp(rows.filter(isReadable));
  if (!since) return readable.slice(-max);
  return readable.filter((r) => String(r.timestamp) > String(since)).slice(0, max);
}

/** A stored row → one item inside a backfill bundle. */
export const toBundleItem = (row) => ({
  id: row.id,
  sender_id: row.sender_id ?? null,
  callsign: row.callsign ?? null,
  global_tag: row.global_tag ?? null,
  timestamp: row.timestamp,
  text: row.plaintext,
  image_url: row.image_url ?? null,
});

const byteLength = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length * 3);

/**
 * Splits bundle items into JSON documents of at most maxBytes each. An item
 * too big on its own loses its image (images stay a live-only feature for
 * backfill); one still too big is skipped.
 */
export function chunkBundle(items, maxBytes = BUNDLE_MAX_BYTES) {
  const wrap = (list) => JSON.stringify({ v: BUNDLE_VERSION, items: list });
  const overhead = byteLength(wrap([]));
  const chunks = [];
  let cur = [];
  let curBytes = overhead;
  for (let item of items) {
    let size = byteLength(JSON.stringify(item)) + 1;
    if (overhead + size > maxBytes && item.image_url) {
      item = { ...item, image_url: null };
      size = byteLength(JSON.stringify(item)) + 1;
    }
    if (overhead + size > maxBytes) continue;
    if (curBytes + size > maxBytes && cur.length) {
      chunks.push({ json: wrap(cur), count: cur.length });
      cur = [];
      curBytes = overhead;
    }
    cur.push(item);
    curBytes += size;
  }
  if (cur.length) chunks.push({ json: wrap(cur), count: cur.length });
  return chunks;
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

/**
 * A decrypted bundle → rows ready for mergeChannelRow, validated (malformed
 * items are dropped, never trusted). relayedBy = the authenticated responder.
 */
export function parseBundle(json, { channelId, relayedBy = null, now = new Date().toISOString() } = {}) {
  let doc;
  try { doc = JSON.parse(json); } catch { return []; }
  if (!doc || doc.v !== BUNDLE_VERSION || !Array.isArray(doc.items)) return [];
  const out = [];
  for (const it of doc.items.slice(0, SYNC_REPLY_MAX)) {
    const id = str(it?.id, 128);
    const timestamp = str(it?.timestamp, 64);
    const text = str(it?.text, 20_000);
    if (!id || !timestamp || text === null || !Number.isFinite(Date.parse(timestamp))) continue;
    out.push({
      id,
      channel_id: channelId,
      sender_id: str(it.sender_id, 128),
      callsign: str(it.callsign, 128),
      global_tag: str(it.global_tag, 128),
      encrypted_content: null,
      plaintext: text,
      image_url: str(it.image_url, 800_000),
      timestamp,
      received_at: now,
      relayed_by: relayedBy,
    });
  }
  return out;
}

/** Is this SSE message_relay a channel message (not a DM)? */
export const isChannelRelay = (p) => Boolean(p?.channel_id && p?.id && p.context !== 'dm' && !p.conversation_id);

/** The DM message inside an SSE message_relay with context 'dm' ({ partner_id, message }), or null. */
export const dmRelayMessage = (p) => (p?.context === 'dm' && p.message?.id && p.message.conversation_id ? p.message : null);

/** Deterministic, order-independent DM conversation id (as dmController.ts builds it). */
export const dmConversationId = (a, b) => [a, b].sort().join('-');

/** Bundle rows (parseBundle) → DM rows of conversation convId between me and partnerId. */
export const bundleRowsToDm = (rows, { convId, me, partnerId }) => rows
  .filter((r) => r.sender_id === me || r.sender_id === partnerId)
  .map(({ channel_id: _c, image_url: _i, global_tag: _g, ...r }) => ({
    ...r,
    conversation_id: convId,
    to_user_id: r.sender_id === me ? partnerId : me,
  }));

/** Responder jitter, so not every online member answers in the same instant. */
export const syncReplyDelay = (rand = Math.random) => Math.floor(rand() * SYNC_JITTER_MS);

/** "3 channels re-synced" etc. — the strip's resync result line. */
export function describeHealResult(r) {
  const healed = r?.healed ?? 0;
  const failed = r?.failed ?? 0;
  const checked = r?.checked ?? 0;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (failed > 0) {
    return { ok: false, message: `${plural(failed, 'channel')} couldn't be re-synced${healed ? ` (${healed} re-synced)` : ''}` };
  }
  if (healed > 0) return { ok: true, message: `${plural(healed, 'channel')} re-synced` };
  return { ok: true, message: checked > 0 ? `Encryption is in sync (${plural(checked, 'channel')} checked)` : 'Nothing to re-sync' };
}
