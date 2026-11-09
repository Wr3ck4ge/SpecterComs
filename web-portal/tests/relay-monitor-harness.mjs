/**
 * Relay-mode receive-path harness (dev only).
 *
 * Feeds synthetic AudioFrame datagrams through the exact routing
 * useMonitorChannel uses (voiceRelayAudio.routeAudioDatagram + per-ssrc lane
 * ids), sealed/opened with the REAL wasm relay wire-v3 implementation
 * (wasm-crypto's RelayAudioSender / RelayAudioReceiver). Run with:
 *   node web-portal/tests/relay-monitor-harness.mjs
 *
 * Asserts:
 *  1. Interleaved frames from two senders each decrypt to their own plaintext
 *     and land on their own lane (no cross-lane interleaving).
 *  2. Wrong key / tampered ssrc, header sequence or session id → dropped.
 *  3. Relay mode with no key yet → dropped (fail closed), not passed through.
 *  4. is_global_broadcast frames use the cascade receiver only; cascade and
 *     channel keys never cross (even with an identical secret, by lane).
 *  5. Replayed frame → dropped as 'replay'; a forged frame does not burn the
 *     genuine frame's window slot.
 *  6. Two sessions of the same ssrc (reconnect / second device), both
 *     counting from 0, decrypt independently and both play.
 *  7. A v1 frame (old encrypt_framed format) → dropped, never played.
 *  8. retainOrReplaceRelayCipher keeps a receiver (and its replay window) on a
 *     same-secret refresh and replaces it on a new secret.
 *  9. Mixed mode: ssrc=0 plaintext passes through untouched; an ssrc≠0
 *     (relay cascade ciphertext) frame is dropped.
 * 10. Duck multiplier spares only the active speaker's lane.
 * 11. (E2EV, wire v3) The sender timestamp is AEAD-bound; frames outside the
 *     ±30 s skew window drop as 'stale'; a restarted receiver (empty replay
 *     windows) refuses recorded old frames; v2 frames are refused.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes, createCipheriv } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(here, '..', 'wasm-crypto', 'pkg');
const { initSync, RelayAudioSender, RelayAudioReceiver } = await import(new URL(`file:///${join(wasmPkg, 'wasm_crypto.js').replace(/\\/g, '/')}`).href);
initSync({ module: readFileSync(join(wasmPkg, 'wasm_crypto_bg.wasm')) });

const relay = await import(new URL(`file:///${join(here, '..', 'src', 'voiceRelayAudio.js').replace(/\\/g, '/')}`).href);
const {
  encodeAudioFrameProto, routeAudioDatagram, relayLaneStreamId, laneDuckMultiplier, retainOrReplaceRelayCipher,
  DROP_NO_KEY, DROP_DECRYPT_FAILED, DROP_REPLAY, DROP_BAD_FORMAT, DROP_UNEXPECTED_RELAY_FRAME, DROP_STALE,
} = relay;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
};

const channelSecret = randomBytes(32);
const cascadeSecret = randomBytes(32);
const wrongSecret = randomBytes(32);

// Fresh receivers per test (replay state is per receiver).
const receivers = () => ({
  channelKey: new RelayAudioReceiver(channelSecret, false),
  cascadeKey: new RelayAudioReceiver(cascadeSecret, true),
});

const SSRC_A = 0x1234_5678;
const SSRC_B = 0x0abc_def0;
const CHANNEL_ID = 'chan-under-test';

// Distinct fake "Opus" payloads per sender/frame so a cross-lane mixup or a
// ciphertext passthrough is detectable byte-for-byte.
const opusFor = (ssrc, n) => new Uint8Array(Array.from({ length: 40 }, (_, i) => (ssrc + n * 7 + i) & 0xff));

const sealed = (tx, ssrc, n, { global = tx.is_global_broadcast, sig = null, protoSeq = n } = {}) =>
  encodeAudioFrameProto(ssrc, protoSeq, tx.seal(opusFor(ssrc, n), ssrc), global, sig);
// Same, with an explicit sender clock (E2EV skew tests).
const sealedAt = (tx, ssrc, n, nowMs) =>
  encodeAudioFrameProto(ssrc, n, tx.seal_at(opusFor(ssrc, n), ssrc, nowMs), tx.is_global_broadcast, null);

// Minimal stand-in for the hook's lane map: what each lane would decode.
function runMonitor(datagrams, ctx) {
  const lanes = new Map();   // streamId -> Uint8Array[]
  const drops = [];
  const skips = [];
  for (const d of datagrams) {
    const r = routeAudioDatagram(d, ctx);
    if (r.action === 'play') {
      const id = ctx.relayMode ? relayLaneStreamId(CHANNEL_ID, r.ssrc) : CHANNEL_ID;
      if (!lanes.has(id)) lanes.set(id, []);
      lanes.get(id).push(r.opusBytes);
    } else if (r.action === 'drop') drops.push(r.reason);
    else skips.push(r.reason);
  }
  return { lanes, drops, skips };
}

console.log('relay-monitor-harness');

test('two interleaved senders decrypt onto separate lanes', () => {
  const txA = new RelayAudioSender(channelSecret, false);
  const txB = new RelayAudioSender(channelSecret, false);
  const dgrams = [];
  for (let n = 0; n < 20; n++) {
    dgrams.push(sealed(txA, SSRC_A, n, { sig: new Uint8Array(64).fill(1) }));
    dgrams.push(sealed(txB, SSRC_B, n + 1000));
  }
  const { lanes, drops } = runMonitor(dgrams, { relayMode: true, ...receivers() });
  assert.equal(drops.length, 0);
  assert.equal(lanes.size, 2);
  const a = lanes.get(`${CHANNEL_ID}:${SSRC_A}`);
  const b = lanes.get(`${CHANNEL_ID}:${SSRC_B}`);
  assert.equal(a.length, 20);
  assert.equal(b.length, 20);
  a.forEach((p, n) => assert.deepEqual(p, opusFor(SSRC_A, n)));
  b.forEach((p, i) => assert.deepEqual(p, opusFor(SSRC_B, i + 1000)));
});

test('wrong key → every frame dropped, nothing played', () => {
  const tx = new RelayAudioSender(wrongSecret, false);
  const dgrams = [sealed(tx, SSRC_A, 1), sealed(tx, SSRC_B, 2)];
  const { lanes, drops } = runMonitor(dgrams, { relayMode: true, ...receivers() });
  assert.equal(lanes.size, 0);
  assert.deepEqual(drops, [DROP_DECRYPT_FAILED, DROP_DECRYPT_FAILED]);
});

test('ssrc / header sequence / session id are AEAD-bound; proto sequence is not trusted', () => {
  const tx = new RelayAudioSender(channelSecret, false);
  const ct = tx.seal(opusFor(SSRC_A, 5), SSRC_A);
  const wrongSsrc = encodeAudioFrameProto(SSRC_B, 5, ct, false, null);
  const badSeq = ct.slice(); badSeq[24] ^= 1;
  const badSession = ct.slice(); badSession[5] ^= 1;
  const { lanes, drops } = runMonitor([
    wrongSsrc,
    encodeAudioFrameProto(SSRC_A, 5, badSeq, false, null),
    encodeAudioFrameProto(SSRC_A, 5, badSession, false, null),
  ], { relayMode: true, ...receivers() });
  assert.equal(lanes.size, 0);
  assert.deepEqual(drops, [DROP_DECRYPT_FAILED, DROP_DECRYPT_FAILED, DROP_DECRYPT_FAILED]);
  // Rewriting the (unauthenticated) proto sequence field changes nothing.
  const r = runMonitor([encodeAudioFrameProto(SSRC_A, 99999, ct, false, null)], { relayMode: true, ...receivers() });
  assert.deepEqual(r.lanes.get(`${CHANNEL_ID}:${SSRC_A}`), [opusFor(SSRC_A, 5)]);
});

test('relay mode with no key yet → dropped (fail closed)', () => {
  const dgrams = [
    sealed(new RelayAudioSender(channelSecret, false), SSRC_A, 1),
    sealed(new RelayAudioSender(cascadeSecret, true), SSRC_B, 1),
  ];
  const { lanes, drops } = runMonitor(dgrams, { relayMode: true, channelKey: null, cascadeKey: null });
  assert.equal(lanes.size, 0);
  assert.deepEqual(drops, [DROP_NO_KEY, DROP_NO_KEY]);
});

test('is_global_broadcast uses the cascade receiver only; cascade vs channel keys separate', () => {
  const cascadeTx = new RelayAudioSender(cascadeSecret, true);
  const channelTx = new RelayAudioSender(channelSecret, false);
  const good = sealed(cascadeTx, SSRC_B, 7);
  const channelSealedButFlaggedGlobal = sealed(channelTx, SSRC_B, 8, { global: true });
  const cascadeSealedNotGlobal = sealed(cascadeTx, SSRC_A, 9, { global: false });
  const { lanes, drops } = runMonitor([good, channelSealedButFlaggedGlobal, cascadeSealedNotGlobal],
    { relayMode: true, ...receivers() });
  assert.deepEqual(lanes.get(`${CHANNEL_ID}:${SSRC_B}`), [opusFor(SSRC_B, 7)]);
  assert.equal(lanes.size, 1);
  assert.deepEqual(drops, [DROP_DECRYPT_FAILED, DROP_DECRYPT_FAILED]);
  // Even if both lanes were (mis)derived from one secret, the lane is bound
  // into the KDF and AAD: a channel-lane frame flagged global fails.
  const same = randomBytes(32);
  const tx = new RelayAudioSender(same, false);
  const r2 = runMonitor([sealed(tx, SSRC_A, 1, { global: true })], {
    relayMode: true, channelKey: new RelayAudioReceiver(same, false), cascadeKey: new RelayAudioReceiver(same, true),
  });
  assert.deepEqual(r2.drops, [DROP_DECRYPT_FAILED]);
  // Channel receiver present, cascade receiver missing → cascade frame no-key.
  const r = runMonitor([sealed(new RelayAudioSender(cascadeSecret, true), SSRC_B, 1)],
    { relayMode: true, channelKey: new RelayAudioReceiver(channelSecret, false), cascadeKey: null });
  assert.deepEqual(r.drops, [DROP_NO_KEY]);
});

test('replayed frame dropped; same frame on another session/ssrc unaffected', () => {
  const ctx = { relayMode: true, ...receivers() };
  const txA = new RelayAudioSender(channelSecret, false);
  const txB = new RelayAudioSender(channelSecret, false);
  const a0 = sealed(txA, SSRC_A, 3);
  const b0 = sealed(txB, SSRC_B, 3);
  const { lanes, drops } = runMonitor([a0, a0, b0, a0, b0], ctx);
  assert.equal(lanes.get(`${CHANNEL_ID}:${SSRC_A}`).length, 1);
  assert.equal(lanes.get(`${CHANNEL_ID}:${SSRC_B}`).length, 1);
  assert.deepEqual(drops, [DROP_REPLAY, DROP_REPLAY, DROP_REPLAY]);
});

test('a forged frame does not burn the genuine frame\'s replay slot', () => {
  const ctx = { relayMode: true, ...receivers() };
  const tx = new RelayAudioSender(channelSecret, false);
  const ct = tx.seal(opusFor(SSRC_A, 11), SSRC_A);
  const forged = ct.slice(); forged[forged.length - 1] ^= 1;
  const { lanes, drops } = runMonitor([
    encodeAudioFrameProto(SSRC_A, 11, forged, false, null),
    encodeAudioFrameProto(SSRC_A, 11, ct, false, null),
  ], ctx);
  assert.deepEqual(drops, [DROP_DECRYPT_FAILED]);
  assert.deepEqual(lanes.get(`${CHANNEL_ID}:${SSRC_A}`), [opusFor(SSRC_A, 11)]);
});

test('two sessions of the same ssrc (reconnect / 2nd device) decrypt independently', () => {
  const ctx = { relayMode: true, ...receivers() };
  const before = new RelayAudioSender(channelSecret, false); // pre-reconnect session
  const after = new RelayAudioSender(channelSecret, false);  // post-reconnect, counter back at 0
  assert.notDeepEqual(before.session_id, after.session_id);
  const dgrams = [];
  for (let n = 0; n < 10; n++) {
    // Both use proto sequence n — the old (ssrc, seq) dedup would have dropped these.
    dgrams.push(sealed(before, SSRC_A, n, { protoSeq: n }));
    dgrams.push(sealed(after, SSRC_A, n + 500, { protoSeq: n }));
  }
  const { lanes, drops } = runMonitor(dgrams, ctx);
  assert.equal(drops.length, 0);
  const lane = lanes.get(`${CHANNEL_ID}:${SSRC_A}`);
  assert.equal(lane.length, 20);
  for (let n = 0; n < 10; n++) {
    assert.deepEqual(lane[2 * n], opusFor(SSRC_A, n));
    assert.deepEqual(lane[2 * n + 1], opusFor(SSRC_A, n + 500));
  }
  assert.equal(ctx.channelKey.session_count, 2);
  // And their first-frame ciphertexts differ for identical plaintext (no
  // keystream reuse across sessions).
  const s1 = new RelayAudioSender(channelSecret, false).seal(new Uint8Array(32), SSRC_A);
  const s2 = new RelayAudioSender(channelSecret, false).seal(new Uint8Array(32), SSRC_A);
  assert.notDeepEqual(s1.slice(33), s2.slice(33));
});

test('old v1 (encrypt_framed) frame is dropped, never played', () => {
  // Reproduce the v1 wire format exactly: ChaCha20-Poly1305 under the raw
  // group secret, nonce = ssrc_be32 || seq_be64, AAD = ssrc_be32 || seq_be32.
  const seq = 4;
  const nonce = Buffer.alloc(12); nonce.writeUInt32BE(SSRC_A, 0); nonce.writeBigUInt64BE(BigInt(seq), 4);
  const aad = Buffer.alloc(8); aad.writeUInt32BE(SSRC_A, 0); aad.writeUInt32BE(seq, 4);
  const c = createCipheriv('chacha20-poly1305', channelSecret, nonce, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: 40 });
  const v1 = Buffer.concat([c.update(opusFor(SSRC_A, seq)), c.final(), c.getAuthTag()]);
  const v1Forced = Buffer.from(v1); v1Forced[0] = 0x03; // even with a v3-looking first byte
  const { lanes, drops } = runMonitor([
    encodeAudioFrameProto(SSRC_A, seq, new Uint8Array(v1), false, null),
    encodeAudioFrameProto(SSRC_A, seq, new Uint8Array(v1Forced), false, null),
  ], { relayMode: true, ...receivers() });
  assert.equal(lanes.size, 0);
  assert.equal(drops.length, 2);
  for (const d of drops) assert.ok(d === DROP_BAD_FORMAT || d === DROP_DECRYPT_FAILED, d);
  if (v1[0] !== 0x03) assert.equal(drops[0], DROP_BAD_FORMAT);
});

test('same-secret refresh keeps the receiver (replay window survives); new secret replaces it', () => {
  const rx = new RelayAudioReceiver(channelSecret, false);
  const tx = new RelayAudioSender(channelSecret, false);
  const f = sealed(tx, SSRC_A, 1);
  assert.equal(runMonitor([f], { relayMode: true, channelKey: rx, cascadeKey: null }).drops.length, 0);
  const kept = retainOrReplaceRelayCipher(rx, Uint8Array.from(channelSecret), () => new RelayAudioReceiver(channelSecret, false));
  assert.equal(kept, rx);
  assert.deepEqual(runMonitor([f], { relayMode: true, channelKey: kept, cascadeKey: null }).drops, [DROP_REPLAY]);
  const replaced = retainOrReplaceRelayCipher(rx, wrongSecret, () => new RelayAudioReceiver(wrongSecret, false));
  assert.notEqual(replaced, rx);
  assert.ok(tx.matches_secret(channelSecret));
  assert.ok(!tx.matches_secret(wrongSecret));
});

test('mixed mode: ssrc=0 plaintext passes through, relay ciphertext (ssrc≠0) dropped', () => {
  const mix = encodeAudioFrameProto(0, 1, opusFor(0, 1), false, null);
  const mixAgain = encodeAudioFrameProto(0, 1, opusFor(0, 2), false, null); // reused seq: not deduped
  const mixedCascade = encodeAudioFrameProto(0, 2, opusFor(0, 3), true, null);
  const relayCascade = sealed(new RelayAudioSender(cascadeSecret, true), SSRC_A, 4);
  const { lanes, drops } = runMonitor([mix, mixAgain, mixedCascade, relayCascade], { relayMode: false });
  assert.deepEqual(lanes.get(CHANNEL_ID), [opusFor(0, 1), opusFor(0, 2), opusFor(0, 3)]);
  assert.deepEqual(drops, [DROP_UNEXPECTED_RELAY_FRAME]);
});

test('control datagrams and empty frames are skipped', () => {
  const { lanes, skips } = runMonitor(
    [new Uint8Array([0xff, 0x04, 0, 0, 0, 1]), new Uint8Array([0x10]), encodeAudioFrameProto(SSRC_A, 1, new Uint8Array(0), false, null)],
    { relayMode: true, ...receivers() });
  assert.equal(lanes.size, 0);
  assert.deepEqual(skips, ['control', 'short', 'empty']);
});

// ── E2EV: wire v3 sender timestamp ──────────────────────────────────────────

test('v3: header carries an AEAD-bound sender timestamp; tampering it fails auth', () => {
  const tx = new RelayAudioSender(channelSecret, false);
  const before = Date.now();
  const ct = tx.seal(opusFor(SSRC_A, 1), SSRC_A);
  assert.equal(ct[0], 0x03);
  const ts = Number(Buffer.from(ct.slice(25, 33)).readBigUInt64BE(0));
  assert.ok(ts >= before && ts <= Date.now(), `ts ${ts}`);
  const t = ct.slice(); t[32] ^= 1;
  const { drops } = runMonitor([encodeAudioFrameProto(SSRC_A, 1, t, false, null)], { relayMode: true, ...receivers() });
  assert.deepEqual(drops, [DROP_DECRYPT_FAILED]);
});

test('v3: frames outside ±max_skew_ms are dropped as stale; edges accepted', () => {
  const ctx = { relayMode: true, ...receivers() };
  const skew = ctx.channelKey.max_skew_ms;
  assert.equal(skew, 30000);
  const now = Date.now();
  // Generous 2 s margin either side so wall-clock progress during the test
  // can't flip an edge case.
  const okOld = sealedAt(new RelayAudioSender(channelSecret, false), SSRC_A, 1, now - skew + 2000);
  const okNew = sealedAt(new RelayAudioSender(channelSecret, false), SSRC_A, 2, now + skew - 2000);
  const tooOld = sealedAt(new RelayAudioSender(channelSecret, false), SSRC_A, 3, now - skew - 2000);
  const tooNew = sealedAt(new RelayAudioSender(channelSecret, false), SSRC_A, 4, now + skew + 2000);
  const { lanes, drops } = runMonitor([okOld, okNew, tooOld, tooNew], ctx);
  assert.deepEqual(lanes.get(`${CHANNEL_ID}:${SSRC_A}`), [opusFor(SSRC_A, 1), opusFor(SSRC_A, 2)]);
  assert.deepEqual(drops, [DROP_STALE, DROP_STALE]);
  assert.equal(ctx.channelKey.session_count, 2); // stale frames created no state
});

test('v3: receiver restart mid-epoch — recorded frames older than the skew window never replay', () => {
  const tx = new RelayAudioSender(channelSecret, false);
  const recordedAt = Date.now() - 5 * 60_000; // recorded 5 min ago, same epoch secret
  const recorded = [0, 1, 2].map((n) => sealedAt(tx, SSRC_A, n, recordedAt + n * 20));
  const restarted = { relayMode: true, ...receivers() }; // empty replay windows
  const { lanes, drops } = runMonitor(recorded, restarted);
  assert.equal(lanes.size, 0);
  assert.deepEqual(drops, [DROP_STALE, DROP_STALE, DROP_STALE]);
  // The same live session keeps working with current frames.
  const live = sealed(tx, SSRC_A, 9);
  assert.equal(runMonitor([live], restarted).drops.length, 0);
});

test('v3: a v2-format frame (0x02 header, no timestamp) is refused as bad-format', () => {
  const v2 = new Uint8Array(25 + 40 + 16); v2[0] = 0x02; v2.set(randomBytes(v2.length - 1), 1);
  const { lanes, drops } = runMonitor([encodeAudioFrameProto(SSRC_A, 1, v2, false, null)], { relayMode: true, ...receivers() });
  assert.equal(lanes.size, 0);
  assert.deepEqual(drops, [DROP_BAD_FORMAT]);
});

test('duck multiplier spares only the active speaker lane', () => {
  const duck = { active: true, activeSsrc: SSRC_A, level: 1 };
  assert.equal(laneDuckMultiplier(duck, SSRC_A), 1.0);
  assert.equal(laneDuckMultiplier(duck, SSRC_B), 0.05);
  assert.equal(laneDuckMultiplier({ ...duck, level: 2 }, SSRC_B), 0.1);
  assert.equal(laneDuckMultiplier({ active: false, activeSsrc: null, level: 0 }, SSRC_B), 1.0);
});

console.log(`${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
