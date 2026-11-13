// S7: share frames v2 through the real wasm-crypto bindings (this checkout's
// pkg, loaded directly) + the receive glue in src/engine/shareFrameV2.js.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initSync, SFrameCrypto, ShareFrameReceiver, ShareFrameSender } from '../wasm-crypto/pkg/wasm_crypto.js';
import {
  createVideoKey, openShareV2, resetShareWindows, isShareDrop, streamFrameVersion,
  SHARE_KIND_VIDEO, SHARE_KIND_AUDIO,
} from '../src/engine/shareFrameV2.js';
import { createKeyGraceSlot } from '../src/voiceRelayAudio.js';
import { openShareAudioPayload, encodeShareAudioInner, SHARE_AUDIO_FLAGS } from '../src/engine/shareAudio.js';

const ALICE = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const BOB = '0a0b0c0d-0e0f-4a1b-9c2d-3e4f5a6b7c8d';
const SECRET = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(8);

beforeAll(() => {
  const wasm = readFileSync(fileURLToPath(new URL('../wasm-crypto/pkg/wasm_crypto_bg.wasm', import.meta.url)));
  initSync({ module: wasm });
});

const wasm = () => ({ SFrameCrypto, ShareFrameReceiver });
const slotWith = (...secrets) => {
  const slot = createKeyGraceSlot({ setTimer: () => 0, clearTimer: () => {} });
  for (const s of secrets) slot.install(createVideoKey(s, wasm()));
  return slot;
};

describe('stream header → opener', () => {
  it('fv 2 selects v2; absent/other = v1', () => {
    expect(streamFrameVersion({ fv: 2, kind: 'share' })).toBe(2);
    expect(streamFrameVersion({ encrypted: true })).toBe(1);
    expect(streamFrameVersion({ fv: '2' })).toBe(1);
    expect(streamFrameVersion(null)).toBe(1);
  });
});

describe('v2 video', () => {
  it('opens, then refuses a replay; reset() (new subscription) re-admits the cached keyframe', () => {
    const slot = slotWith(SECRET);
    const tx = new ShareFrameSender(SECRET, SHARE_KIND_VIDEO, ALICE);
    const f = tx.seal(new Uint8Array([1, 2, 3]), 0, 1234);
    expect([...openShareV2(slot, f, { flags: 0, tsMs: 1234, sharerUserId: ALICE, kind: SHARE_KIND_VIDEO })]).toEqual([1, 2, 3]);
    let err;
    try { openShareV2(slot, f, { flags: 0, tsMs: 1234, sharerUserId: ALICE, kind: SHARE_KIND_VIDEO }); } catch (e) { err = e; }
    expect(err.message).toBe('replay');
    expect(isShareDrop(err)).toBe(true);
    resetShareWindows(slot);
    expect(openShareV2(slot, f, { flags: 0, tsMs: 1234, sharerUserId: ALICE, kind: SHARE_KIND_VIDEO }).length).toBe(3);
  });

  it('cross-sharer, flipped flags and wrong kind fail', () => {
    const slot = slotWith(SECRET);
    const tx = new ShareFrameSender(SECRET, SHARE_KIND_VIDEO, ALICE);
    const f = tx.seal(new Uint8Array([9]), 1, 5);
    const open = (o) => { try { openShareV2(slot, f, { flags: 1, tsMs: 5, sharerUserId: ALICE, kind: SHARE_KIND_VIDEO, ...o }); return 'ok'; } catch (e) { return e.message; } };
    expect(open({ sharerUserId: BOB })).toBe('auth-failed');
    expect(open({ flags: 0 })).toBe('auth-failed');
    expect(open({ kind: SHARE_KIND_AUDIO })).toBe('unsupported-kind');
    expect(open({})).toBe('ok');
  });

  it('stale frames are dropped (not decrypt failures)', () => {
    const slot = slotWith(SECRET);
    const tx = new ShareFrameSender(SECRET, SHARE_KIND_VIDEO, ALICE);
    const old = tx.seal_at(new Uint8Array([1]), 0, 0, Date.now() - 60_000);
    let err;
    try { openShareV2(slot, old, { flags: 0, tsMs: 0, sharerUserId: ALICE, kind: SHARE_KIND_VIDEO }); } catch (e) { err = e; }
    expect(err.message).toBe('stale-timestamp');
    expect(isShareDrop(err)).toBe(true);
  });

  it('rekey grace: a frame under the previous key still opens', () => {
    const slot = slotWith(SECRET, OTHER);
    const tx = new ShareFrameSender(SECRET, SHARE_KIND_VIDEO, ALICE);
    const f = tx.seal(new Uint8Array([4]), 0, 0);
    expect([...openShareV2(slot, f, { flags: 0, tsMs: 0, sharerUserId: ALICE, kind: SHARE_KIND_VIDEO })]).toEqual([4]);
  });

  it('v1 frames are untouched by the composite key', () => {
    const slot = slotWith(SECRET);
    const v1 = new SFrameCrypto(SECRET).encrypt(new Uint8Array([5, 6]));
    expect([...slot.current.decrypt(v1)]).toEqual([5, 6]);
    // a v1 frame fed to the v2 opener never opens
    expect(() => openShareV2(slot, v1, { flags: 0, tsMs: 0, sharerUserId: ALICE, kind: SHARE_KIND_VIDEO })).toThrow();
  });

  it('receiver.sender() seals for the same key (S8)', () => {
    const rx = new ShareFrameReceiver(SECRET);
    const tx = rx.sender(SHARE_KIND_VIDEO, ALICE);
    const f = tx.seal(new Uint8Array([7]), 0, 1);
    expect([...new ShareFrameReceiver(SECRET).open(f, 0, 1, ALICE, SHARE_KIND_VIDEO)]).toEqual([7]);
    expect(() => new ShareFrameSender(SECRET, 0x10, ALICE)).toThrow('unsupported-kind');
  });
});

describe('share audio, both formats', () => {
  const inner = encodeShareAudioInner({ seq: 3, durationMs: 20, opus: new Uint8Array([1, 2, 3, 4]) });
  it('v1 via SFrameCrypto', () => {
    const slot = slotWith(SECRET);
    const payload = slot.current.encrypt(inner);
    const out = openShareAudioPayload({ fv: 1, payload, tsMs: 9, openV1: (p) => slot.current.decrypt(p), openV2: () => { throw new Error('no'); } });
    expect(out.seq).toBe(3);
  });
  it('v2 via ShareFrameReceiver (datagram flags)', () => {
    const slot = slotWith(SECRET);
    const tx = new ShareFrameSender(SECRET, SHARE_KIND_AUDIO, ALICE);
    const payload = tx.seal(inner, SHARE_AUDIO_FLAGS, 9);
    const out = openShareAudioPayload({
      fv: 2, payload, tsMs: 9, openV1: () => { throw new Error('no'); },
      openV2: (p, f, ts) => openShareV2(slot, p, { flags: f, tsMs: ts, sharerUserId: ALICE, kind: SHARE_KIND_AUDIO }),
    });
    expect([...out.opus]).toEqual([1, 2, 3, 4]);
  });
});
