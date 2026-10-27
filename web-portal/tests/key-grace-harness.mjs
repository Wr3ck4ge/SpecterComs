/**
 * Rekey grace-window harness (MR4, dev only).
 *
 * Exercises voiceRelayAudio.js's key-continuity pieces against the REAL wasm
 * ciphers (wasm-crypto's RelayAudioSender / RelayAudioReceiver / SFrameCrypto)
 * with an injected fake timer. Run with:
 *   node web-portal/tests/key-grace-harness.mjs
 *
 * Asserts:
 *  1. Slot lifecycle: install / same-key no-op / grace timer / expiry frees the
 *     previous key exactly once / a second rekey frees the displaced key /
 *     swap-back / clear() frees both with no grace and no double free.
 *  2. Relay audio dual-key rx: after a rekey, frames from a sender still on
 *     the old key play (via the previous receiver), new-key frames play via
 *     the current one, tx is already on the new key.
 *  3. Grace expiry: once the window closes the old key's frames drop as
 *     decrypt-failed (the stale-key recovery signal) and the old receiver is
 *     freed.
 *  4. A frame failing both keys → decrypt-failed; a replay authenticated under
 *     the previous key → 'replay' (not a key failure); lanes never cross.
 *  5. SFrame video: sameSFrameKey recognises a same-key re-export; withGraceKeys
 *     decrypts a not-yet-switched sharer's frame with the previous key, and
 *     stops after expiry.
 *  6. claimOrgHeal throttles the automatic org heal per org.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPkg = join(here, '..', 'wasm-crypto', 'pkg');
const { initSync, RelayAudioSender, RelayAudioReceiver, SFrameCrypto } = await import(new URL(`file:///${join(wasmPkg, 'wasm_crypto.js').replace(/\\/g, '/')}`).href);
initSync({ module: readFileSync(join(wasmPkg, 'wasm_crypto_bg.wasm')) });

const relay = await import(new URL(`file:///${join(here, '..', 'src', 'voiceRelayAudio.js').replace(/\\/g, '/')}`).href);
const {
  encodeAudioFrameProto, routeAudioDatagram, retainOrReplaceRelayCipher,
  createKeyGraceSlot, sameSFrameKey, withGraceKeys, claimOrgHeal,
  KEY_GRACE_MS, ORG_HEAL_MIN_INTERVAL_MS,
  DROP_DECRYPT_FAILED, DROP_REPLAY, DROP_NO_KEY,
} = relay;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
};

// Manual clock: setTimer records, tick(ms) fires what's due.
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map(); // id -> { at, fn }
  return {
    setTimer: (fn, ms) => { const id = nextId++; pending.set(id, { at: now + ms, fn, ms }); return id; },
    clearTimer: (id) => { pending.delete(id); },
    tick(ms) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) { pending.delete(id); t.fn(); }
      }
    },
    get pending() { return [...pending.values()]; },
  };
}

// Wraps a wasm object so frees are counted; a second free would throw from
// wasm-bindgen too, but count explicitly so a leak (0 frees) is caught.
const tracked = (inner, log, name) => {
  let frees = 0;
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'free') return () => { frees++; log.push(name); if (frees > 1) throw new Error(`double free of ${name}`); target.free(); };
      if (prop === '__frees') return frees;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
};
const fakeKey = (name, log) => ({ name, frees: 0, free() { this.frees++; log.push(name); if (this.frees > 1) throw new Error(`double free of ${name}`); } });

const SSRC_A = 0x1234_5678;
const opusFor = (ssrc, n) => new Uint8Array(Array.from({ length: 40 }, (_, i) => (ssrc + n * 7 + i) & 0xff));
const sealed = (tx, ssrc, n) => encodeAudioFrameProto(ssrc, n, tx.seal(opusFor(ssrc, n), ssrc), tx.is_global_broadcast, null);
const route = (bytes, chSlot, casSlot = createKeyGraceSlot()) => routeAudioDatagram(bytes, {
  relayMode: true,
  channelKey: chSlot.current,
  cascadeKey: casSlot.current,
  channelPrevKey: chSlot.previous,
  cascadePrevKey: casSlot.previous,
});

// ── 1. Slot lifecycle ────────────────────────────────────────────────────────

test('slot: install, same-key no-op, grace timer, expiry frees previous once', () => {
  const t = fakeTimers();
  const freed = [];
  const slot = createKeyGraceSlot(t);
  const k1 = fakeKey('k1', freed);
  const k2 = fakeKey('k2', freed);
  slot.install(k1);
  assert.equal(slot.current, k1);
  assert.equal(slot.previous, null);
  assert.equal(t.pending.length, 0, 'no grace timer without a previous key');
  slot.install(k1);
  assert.equal(slot.previous, null, 'same key again is a no-op');
  slot.install(k2);
  assert.equal(slot.current, k2);
  assert.equal(slot.previous, k1);
  assert.equal(t.pending.length, 1);
  assert.equal(t.pending[0].ms, KEY_GRACE_MS);
  assert.equal(KEY_GRACE_MS, 10_000);
  t.tick(KEY_GRACE_MS - 1);
  assert.equal(slot.previous, k1, 'still inside the window');
  t.tick(1);
  assert.equal(slot.previous, null);
  assert.equal(slot.current, k2);
  assert.deepEqual(freed, ['k1']);
  slot.expire(); // idempotent
  assert.deepEqual(freed, ['k1']);
});

test('slot: rekey inside the window frees the displaced key and restarts the timer', () => {
  const t = fakeTimers();
  const freed = [];
  const slot = createKeyGraceSlot(t);
  const [k1, k2, k3] = ['k1', 'k2', 'k3'].map((n) => fakeKey(n, freed));
  slot.install(k1);
  slot.install(k2);
  t.tick(4000);
  slot.install(k3);
  assert.deepEqual(freed, ['k1']);
  assert.equal(slot.previous, k2);
  assert.equal(t.pending.length, 1, 'old timer cancelled');
  t.tick(KEY_GRACE_MS - 1);
  assert.equal(slot.previous, k2, 'window restarted at the second rekey');
  t.tick(1);
  assert.deepEqual(freed, ['k1', 'k2']);
  assert.equal(slot.current, k3);
});

test('slot: swapping back to the previous key frees nothing', () => {
  const t = fakeTimers();
  const freed = [];
  const slot = createKeyGraceSlot(t);
  const [k1, k2] = ['k1', 'k2'].map((n) => fakeKey(n, freed));
  slot.install(k1);
  slot.install(k2);
  slot.install(k1);
  assert.equal(slot.current, k1);
  assert.equal(slot.previous, k2);
  assert.deepEqual(freed, []);
  t.tick(KEY_GRACE_MS);
  assert.deepEqual(freed, ['k2']);
});

test('slot: clear() frees both at once, cancels the timer, no double free after', () => {
  const t = fakeTimers();
  const freed = [];
  const slot = createKeyGraceSlot(t);
  const [k1, k2] = ['k1', 'k2'].map((n) => fakeKey(n, freed));
  slot.install(k1);
  slot.install(k2);
  slot.clear();
  assert.equal(slot.current, null);
  assert.equal(slot.previous, null);
  assert.deepEqual(freed.sort(), ['k1', 'k2']);
  assert.equal(t.pending.length, 0);
  t.tick(KEY_GRACE_MS * 2);
  slot.clear();
  slot.expire();
  assert.equal(freed.length, 2);
  // install(null) is a clear too.
  const k3 = fakeKey('k3', freed);
  slot.install(k3);
  slot.install(null);
  assert.equal(slot.current, null);
  assert.deepEqual(freed.slice(2), ['k3']);
});

// ── 2–4. Relay audio dual-key receive ────────────────────────────────────────

test('relay: rekey mid-stream — old-key sender plays via previous, tx switches at once', () => {
  const t = fakeTimers();
  const freed = [];
  const oldSecret = randomBytes(32);
  const newSecret = randomBytes(32);
  const rx = createKeyGraceSlot(t);
  rx.install(tracked(new RelayAudioReceiver(oldSecret, false), freed, 'rx-old'));
  const peerOld = new RelayAudioSender(oldSecret, false); // a peer that hasn't switched yet
  let ownTx = new RelayAudioSender(oldSecret, false);

  assert.equal(route(sealed(peerOld, SSRC_A, 0), rx).action, 'play');

  // Rekey: what installRelayAudioPair does.
  rx.install(retainOrReplaceRelayCipher(rx.current, newSecret, () => tracked(new RelayAudioReceiver(newSecret, false), freed, 'rx-new')));
  const nextTx = retainOrReplaceRelayCipher(ownTx, newSecret, () => new RelayAudioSender(newSecret, false));
  assert.notEqual(nextTx, ownTx, 'sender replaced immediately');
  ownTx.free();
  ownTx = nextTx;
  assert.ok(ownTx.matches_secret(newSecret));

  const r1 = route(sealed(peerOld, SSRC_A, 1), rx);
  assert.equal(r1.action, 'play', 'old-key frame still plays inside the window');
  assert.equal(r1.previousKey, true);
  assert.deepEqual(r1.opusBytes, opusFor(SSRC_A, 1));

  const r2 = route(sealed(ownTx, SSRC_A, 2), rx);
  assert.equal(r2.action, 'play');
  assert.equal(r2.previousKey, false, 'new-key frame opens with the current key');

  // A same-epoch re-export must not move the current receiver into the slot.
  rx.install(retainOrReplaceRelayCipher(rx.current, newSecret, () => { throw new Error('should retain'); }));
  assert.equal(route(sealed(peerOld, SSRC_A, 3), rx).action, 'play', 'previous key survives a same-key refresh');
  assert.deepEqual(freed, []);
  rx.clear();
  ownTx.free();
  peerOld.free();
});

test('relay: grace expiry — old-key frames then drop as decrypt-failed and the old receiver is freed', () => {
  const t = fakeTimers();
  const freed = [];
  const oldSecret = randomBytes(32);
  const newSecret = randomBytes(32);
  const rx = createKeyGraceSlot(t);
  rx.install(tracked(new RelayAudioReceiver(oldSecret, false), freed, 'rx-old'));
  rx.install(tracked(new RelayAudioReceiver(newSecret, false), freed, 'rx-new'));
  const peerOld = new RelayAudioSender(oldSecret, false);
  assert.equal(route(sealed(peerOld, SSRC_A, 0), rx).action, 'play');
  t.tick(KEY_GRACE_MS);
  assert.deepEqual(freed, ['rx-old'], 'previous receiver freed exactly once at expiry');
  assert.equal(rx.previous, null);
  const r = route(sealed(peerOld, SSRC_A, 1), rx);
  assert.equal(r.action, 'drop');
  assert.equal(r.reason, DROP_DECRYPT_FAILED, 'feeds the sustained-failure recovery');
  rx.clear();
  assert.deepEqual(freed, ['rx-old', 'rx-new']);
  peerOld.free();
});

test('relay: failing both keys → decrypt-failed; replay under previous → replay; no key → no-key', () => {
  const t = fakeTimers();
  const oldSecret = randomBytes(32);
  const newSecret = randomBytes(32);
  const rx = createKeyGraceSlot(t);
  assert.equal(route(sealed(new RelayAudioSender(oldSecret, false), SSRC_A, 0), rx).reason, DROP_NO_KEY);
  rx.install(new RelayAudioReceiver(oldSecret, false));
  rx.install(new RelayAudioReceiver(newSecret, false));

  const stranger = new RelayAudioSender(randomBytes(32), false);
  const both = route(sealed(stranger, SSRC_A, 0), rx);
  assert.equal(both.action, 'drop');
  assert.equal(both.reason, DROP_DECRYPT_FAILED);

  const peerOld = new RelayAudioSender(oldSecret, false);
  const f = sealed(peerOld, SSRC_A, 5);
  assert.equal(route(f, rx).action, 'play');
  const again = route(f, rx);
  assert.equal(again.action, 'drop');
  assert.equal(again.reason, DROP_REPLAY, 'authentic under the previous key — not a key failure');
  rx.clear();
  stranger.free();
  peerOld.free();
});

test('relay: a channel lane\'s previous key never opens cascade frames (and vice versa)', () => {
  const t = fakeTimers();
  const secret = randomBytes(32);
  const ch = createKeyGraceSlot(t);
  const cas = createKeyGraceSlot(t);
  ch.install(new RelayAudioReceiver(secret, false));
  ch.install(new RelayAudioReceiver(randomBytes(32), false)); // channel rekeyed; previous holds `secret`
  cas.install(new RelayAudioReceiver(randomBytes(32), true));
  // Cascade frame sealed under `secret`: only the channel lane's previous key
  // shares the secret, and the lane is AEAD-bound — must not open.
  const cascadeTx = new RelayAudioSender(secret, true);
  const r = route(sealed(cascadeTx, SSRC_A, 0), ch, cas);
  assert.equal(r.action, 'drop');
  assert.equal(r.reason, DROP_DECRYPT_FAILED);
  ch.clear();
  cas.clear();
  cascadeTx.free();
});

// ── 5. SFrame video ──────────────────────────────────────────────────────────

test('video: sameSFrameKey spots a same-key re-export; different keys differ', () => {
  const k = randomBytes(32);
  const a = new SFrameCrypto(k);
  const b = new SFrameCrypto(k);
  const c = new SFrameCrypto(randomBytes(32));
  assert.equal(sameSFrameKey(a, b), true);
  assert.equal(sameSFrameKey(a, c), false);
  assert.equal(sameSFrameKey(null, a), false);
  a.free(); b.free(); c.free();
});

test('video: withGraceKeys decrypts a not-yet-switched sharer, then stops after expiry', () => {
  const t = fakeTimers();
  const freed = [];
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const slot = createKeyGraceSlot(t);
  slot.install(tracked(new SFrameCrypto(oldKey), freed, 'v-old'));
  slot.install(tracked(new SFrameCrypto(newKey), freed, 'v-new'));
  const sharerOld = new SFrameCrypto(oldKey);
  const plain = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]);

  const viaPrev = withGraceKeys(slot, (k) => k.decrypt(sharerOld.encrypt(plain)));
  assert.equal(viaPrev.previousKey, true);
  assert.deepEqual(Uint8Array.from(viaPrev.value), plain);

  // Sending always uses the current key.
  const sent = slot.current.encrypt(plain);
  assert.throws(() => sharerOld.decrypt(sent));
  assert.equal(withGraceKeys(slot, (k) => k.decrypt(sent)).previousKey, false);

  t.tick(KEY_GRACE_MS);
  assert.deepEqual(freed, ['v-old']);
  assert.throws(() => withGraceKeys(slot, (k) => k.decrypt(sharerOld.encrypt(plain))));
  slot.clear();
  assert.throws(() => withGraceKeys(slot, (k) => k.decrypt(sent)), /no key/);
  sharerOld.free();
});

// ── 6. Org-heal throttle ─────────────────────────────────────────────────────

test('claimOrgHeal: one automatic heal per org per interval', () => {
  const t0 = 1_000_000;
  assert.equal(claimOrgHeal('org-a', t0), true);
  assert.equal(claimOrgHeal('org-a', t0 + 1000), false);
  assert.equal(claimOrgHeal('org-b', t0 + 1000), true, 'independent per org');
  assert.equal(claimOrgHeal('org-a', t0 + ORG_HEAL_MIN_INTERVAL_MS), true);
  assert.equal(claimOrgHeal(null, t0), false);
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
