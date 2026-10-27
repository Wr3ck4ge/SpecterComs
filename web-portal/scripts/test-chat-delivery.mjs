// MR2: chat delivery / catch-up pure logic (src/engine/chatSyncCore.js) and
// the strip's chat rows (bridge.js buildChatRows).
// Run: node scripts/test-chat-delivery.mjs
import assert from 'node:assert/strict';
import {
  mergeChannelRow, normalizeRow, isRetryable, pickRetryRows, computeSyncSince, selectReplyRows,
  toBundleItem, chunkBundle, parseBundle, isChannelRelay, syncReplyDelay, describeHealResult,
  SYNC_REPLY_MAX, SYNC_JITTER_MS, BUNDLE_MAX_BYTES, MAX_DECRYPT_ATTEMPTS,
} from '../src/engine/chatSyncCore.js';
import { buildChatRows } from '../src/engine/bridge.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (err) { console.error(`FAIL ${name}`); throw err; }
};

const ts = (i) => new Date(Date.UTC(2026, 9, 25, 12, 0, i)).toISOString();
const good = (id, i, extra = {}) => ({ id, channel_id: 'c1', sender_id: 'u2', timestamp: ts(i), plaintext: `m${id}`, encrypted_content: `ct-${id}`, ...extra });
const bad = (id, i, extra = {}) => ({ id, channel_id: 'c1', sender_id: 'u2', timestamp: ts(i), plaintext: null, encrypted_content: `ct-${id}`, fail_reason: 'epoch_ahead_unresolved', attempts: 1, ...extra });

// ── merge / dedupe ───────────────────────────────────────────────────────
test('new row is stored normalized; unreadable → pending', () => {
  const r = mergeChannelRow(undefined, bad('a', 1));
  assert.equal(r.pending, true);
  assert.equal(r.plaintext, null);
  assert.equal(r.fail_reason, 'epoch_ahead_unresolved');
  const g = mergeChannelRow(undefined, good('b', 2));
  assert.equal(g.pending, false);
  assert.equal(g.fail_reason, null);
});

test('readable stored row is final (not replaced by null, nor by a different relayed text)', () => {
  const stored = normalizeRow(good('a', 1));
  assert.equal(mergeChannelRow(stored, bad('a', 1)), null);
  assert.equal(mergeChannelRow(stored, { ...good('a', 1), plaintext: 'rewritten', relayed_by: 'evil' }), null);
});

test('readable replaces pending, keeping the stored ciphertext when the backfill has none', () => {
  const stored = normalizeRow(bad('a', 1));
  const r = mergeChannelRow(stored, { ...good('a', 1), encrypted_content: null, relayed_by: 'u3' });
  assert.equal(r.plaintext, 'ma');
  assert.equal(r.pending, false);
  assert.equal(r.encrypted_content, 'ct-a');
  assert.equal(r.relayed_by, 'u3');
  assert.equal(r.attempts, 0);
});

test('pending over pending: refreshes reason/attempts, no-op when identical', () => {
  const stored = normalizeRow(bad('a', 1));
  assert.equal(mergeChannelRow(stored, bad('a', 1)), null);
  const r = mergeChannelRow(stored, bad('a', 1, { fail_reason: 'epoch_too_old', attempts: 2 }));
  assert.equal(r.fail_reason, 'epoch_too_old');
  assert.equal(r.attempts, 2);
  // legacy row (no pending flag) is upgraded once
  const legacy = { ...bad('z', 1) };
  delete legacy.pending;
  assert.equal(mergeChannelRow(legacy, bad('z', 1)).pending, true);
});

// ── retry selection ──────────────────────────────────────────────────────
test('retryable: unreadable with ciphertext, non-terminal reason, under the attempt cap', () => {
  assert.equal(isRetryable(normalizeRow(bad('a', 1))), true);
  assert.equal(isRetryable(normalizeRow(good('a', 1))), false);
  assert.equal(isRetryable(normalizeRow(bad('a', 1, { fail_reason: 'epoch_too_old' }))), false);
  assert.equal(isRetryable(normalizeRow(bad('a', 1, { fail_reason: 'corrupt' }))), false);
  assert.equal(isRetryable(normalizeRow(bad('a', 1, { encrypted_content: null }))), false);
  assert.equal(isRetryable(normalizeRow(bad('a', 1, { attempts: MAX_DECRYPT_ATTEMPTS }))), false);
  assert.equal(isRetryable(normalizeRow(bad('a', 1, { fail_reason: 'not_member' }))), true);
});

test('retry rows come oldest first', () => {
  const rows = [bad('c', 3), good('x', 0), bad('a', 1), bad('t', 2, { fail_reason: 'epoch_too_old' })].map((r) => normalizeRow(r));
  assert.deepEqual(pickRetryRows(rows).map((r) => r.id), ['a', 'c']);
});

// ── what to ask for ──────────────────────────────────────────────────────
test('since: null for an empty channel, else newest timestamp', () => {
  assert.equal(computeSyncSince([]), null);
  assert.equal(computeSyncSince([good('a', 1), good('b', 5), good('c', 3)]), ts(5));
});

test('since: just before the oldest unreadable row so the backfill covers it', () => {
  const since = computeSyncSince([good('a', 1), bad('b', 4), good('c', 9), bad('d', 7)]);
  assert.equal(since, new Date(Date.parse(ts(4)) - 1).toISOString());
  assert.ok(since < ts(4) && since > ts(1));
});

// ── what to answer with ──────────────────────────────────────────────────
test('reply: readable rows after since, oldest first, capped; empty history gets the newest', () => {
  const rows = [];
  for (let i = 0; i < SYNC_REPLY_MAX + 50; i++) rows.push(good(`m${i}`, i));
  rows.push(bad('p', 3));
  const after = selectReplyRows(rows, ts(9));
  assert.equal(after.length, SYNC_REPLY_MAX);
  assert.equal(after[0].id, 'm10');
  assert.ok(after.every((r) => typeof r.plaintext === 'string'));
  const all = selectReplyRows(rows, null);
  assert.equal(all.length, SYNC_REPLY_MAX);
  assert.equal(all[all.length - 1].id, `m${SYNC_REPLY_MAX + 49}`);
  assert.deepEqual(selectReplyRows([bad('p', 3)], null), []);
});

// ── bundles ──────────────────────────────────────────────────────────────
test('bundle round trip keeps original id / sender / callsign / timestamp', () => {
  const items = [good('a', 1, { callsign: 'Nova', image_url: null }), good('b', 2)].map((r) => toBundleItem(normalizeRow(r)));
  const [chunk] = chunkBundle(items);
  assert.equal(chunk.count, 2);
  const rows = parseBundle(chunk.json, { channelId: 'c1', relayedBy: 'u3', now: ts(60) });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { id: rows[0].id, sender_id: rows[0].sender_id, callsign: rows[0].callsign, timestamp: rows[0].timestamp, plaintext: rows[0].plaintext, relayed_by: rows[0].relayed_by, channel_id: rows[0].channel_id, encrypted_content: rows[0].encrypted_content },
    { id: 'a', sender_id: 'u2', callsign: 'Nova', timestamp: ts(1), plaintext: 'ma', relayed_by: 'u3', channel_id: 'c1', encrypted_content: null },
  );
  // and it merges over a pending copy
  assert.equal(mergeChannelRow(normalizeRow(bad('a', 1)), rows[0]).plaintext, 'ma');
});

test('chunks stay under the byte budget; oversized images are dropped, oversized items skipped', () => {
  const items = [];
  for (let i = 0; i < 200; i++) items.push({ id: `m${i}`, sender_id: 'u', callsign: 'c', global_tag: null, timestamp: ts(i), text: 'x'.repeat(900), image_url: null });
  items.push({ id: 'img', sender_id: 'u', callsign: 'c', global_tag: null, timestamp: ts(300), text: 'pic', image_url: `data:image/png;base64,${'A'.repeat(BUNDLE_MAX_BYTES)}` });
  items.push({ id: 'huge', sender_id: 'u', callsign: 'c', global_tag: null, timestamp: ts(301), text: 'y'.repeat(BUNDLE_MAX_BYTES), image_url: null });
  const chunks = chunkBundle(items);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(Buffer.byteLength(c.json) <= BUNDLE_MAX_BYTES, `chunk ${Buffer.byteLength(c.json)} bytes`);
  const parsed = chunks.flatMap((c) => parseBundle(c.json, { channelId: 'c1' }));
  assert.equal(parsed.length, 201);
  assert.equal(parsed.find((r) => r.id === 'img').image_url, null);
  assert.equal(parsed.find((r) => r.id === 'huge'), undefined);
  assert.equal(chunks.reduce((n, c) => n + c.count, 0), 201);
});

test('parseBundle drops malformed docs and items', () => {
  assert.deepEqual(parseBundle('not json', { channelId: 'c1' }), []);
  assert.deepEqual(parseBundle(JSON.stringify({ v: 99, items: [] }), { channelId: 'c1' }), []);
  const rows = parseBundle(JSON.stringify({ v: 1, items: [
    { id: 'ok', timestamp: ts(1), text: 'hi' },
    { id: 'no-text', timestamp: ts(1) },
    { id: 'bad-ts', timestamp: 'yesterday', text: 'x' },
    { timestamp: ts(1), text: 'no id' },
    { id: { $ne: 1 }, timestamp: ts(1), text: 'obj id' },
  ] }), { channelId: 'c1' });
  assert.deepEqual(rows.map((r) => r.id), ['ok']);
});

// ── relay classification, jitter, result text ─────────────────────────────
test('relay classification excludes DMs', () => {
  assert.equal(isChannelRelay({ id: '1', channel_id: 'c' }), true);
  assert.equal(isChannelRelay({ id: '1', channel_id: 'c', context: 'dm' }), false);
  assert.equal(isChannelRelay({ id: '1', conversation_id: 'x', channel_id: 'c' }), false);
  assert.equal(isChannelRelay({ channel_id: 'c' }), false);
});

test('responder jitter is within 0..1.5 s', () => {
  assert.equal(syncReplyDelay(() => 0), 0);
  assert.ok(syncReplyDelay(() => 0.999999) < SYNC_JITTER_MS);
  assert.equal(SYNC_JITTER_MS, 1500);
});

test('heal result lines', () => {
  assert.deepEqual(describeHealResult({ healed: 3, failed: 0, checked: 5 }), { ok: true, message: '3 channels re-synced' });
  assert.deepEqual(describeHealResult({ healed: 1, failed: 0, checked: 1 }), { ok: true, message: '1 channel re-synced' });
  assert.equal(describeHealResult({ healed: 0, failed: 0, checked: 4 }).message, 'Encryption is in sync (4 channels checked)');
  assert.deepEqual(describeHealResult({ healed: 2, failed: 1, checked: 3 }), { ok: false, message: "1 channel couldn't be re-synced (2 re-synced)" });
});

// ── strip rows ───────────────────────────────────────────────────────────
test('chat rows: pending rows are flagged, never blank text without a flag', () => {
  const rows = buildChatRows([normalizeRow(good('a', 1)), normalizeRow(bad('b', 2)), { ...normalizeRow(good('c', 3)), relayed_by: 'u3' }], { userId: 'u2' });
  assert.equal(rows[0].pending, false);
  assert.equal(rows[0].text, 'ma');
  assert.equal(rows[1].pending, true);
  assert.equal(rows[1].text, null);
  assert.equal(rows[2].relayedBy, 'u3');
  assert.equal(rows[0].mine, true);
});

console.log(`chat delivery: ${passed} tests passed`);
