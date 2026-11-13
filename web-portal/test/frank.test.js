// S7 franking (src/engine/frank.js) + the sync sanitiser carrying its fields.
import { describe, it, expect } from 'vitest';
import {
  frankText, openFranked, reverifyRow, decodeEnvelope, encodeEnvelope, plaintextFromBytes,
  computeCommitment, constantTimeEqual, isEnvelope, textContentJson, toB64,
  SCOPE_CHANNEL, SCOPE_DM, HEADER_LEN,
} from '../src/engine/frank.js';
import { normalizeRow, toBundleItem, parseBundle, chunkBundle } from '../src/engine/chatSyncCore.js';
import { buildChatRows } from '../src/engine/bridge.js';

const CHAN = '22222222-2222-4222-8222-222222222222';
const ALICE = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';
const FK = new Uint8Array(32).map((_, i) => (i * 37 + 200) & 0xff); // has bytes >= 0x80

async function sent(body, { scope = SCOPE_CHANNEL, conv = CHAN, sender = ALICE } = {}) {
  const f = await frankText({ body, scope, conversationId: conv, senderId: sender, fk: FK });
  // What the receiver's mlsSession hands back after decrypt:
  return { ...f, received: plaintextFromBytes(f.envelope) };
}

describe('envelope', () => {
  it('layout: \\x00SF 0x02 fk content_json, string form keeps the header', async () => {
    const { envelope, envelopeString, received } = await sent('héllo');
    expect([...envelope.slice(0, 4)]).toEqual([0x00, 0x53, 0x46, 0x02]);
    expect([...envelope.slice(4, HEADER_LEN)]).toEqual([...FK]);
    expect(new TextDecoder().decode(envelope.slice(HEADER_LEN))).toBe('{"k":"text","body":"héllo"}');
    expect(received).toBe(envelopeString);
    const env = decodeEnvelope(received);
    expect([...env.fk]).toEqual([...FK]);
    expect(env.content).toEqual({ k: 'text', body: 'héllo' });
    expect(decodeEnvelope(envelope).contentJson).toBe(env.contentJson);
  });
  it('v1 raw text is never an envelope', () => {
    expect(isEnvelope('hello')).toBe(false);
    expect(isEnvelope('SF\u0002' + 'x'.repeat(40))).toBe(false);
    expect(plaintextFromBytes(new TextEncoder().encode('plain'))).toBe('plain');
  });
  it('rejects a bad fk', () => {
    expect(() => encodeEnvelope(new Uint8Array(31), '{}')).toThrow();
  });
});

describe('commitment + verify', () => {
  it('matches the documented HMAC input', async () => {
    const contentJson = textContentJson('x');
    const enc = new TextEncoder();
    const lp = (s) => { const b = enc.encode(s); return [b.length >> 8, b.length & 0xff, ...b]; };
    const data = new Uint8Array([...enc.encode('specter/frank/v1'), 1, ...lp(CHAN), ...lp(ALICE), ...enc.encode(contentJson)]);
    const key = await crypto.subtle.importKey('raw', FK, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const want = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
    const got = await computeCommitment({ fk: FK, scope: SCOPE_CHANNEL, conversationId: CHAN, senderId: ALICE, contentJson });
    expect(constantTimeEqual(got, want)).toBe(true);
  });

  it('match → verified body', async () => {
    const { frank, received } = await sent('hi there');
    const out = await openFranked(received, { frank: { ...frank, kid: 'k1', tag: 'dGFn' }, scope: SCOPE_CHANNEL, conversationId: CHAN, senderId: ALICE });
    expect(out).toMatchObject({ plaintext: 'hi there', verify: 'ok', frank: { v: 1, c: frank.c, kid: 'k1', tag: 'dGFn' } });
    expect(out.fk).toBe(toB64(FK));
  });

  it('mismatch → failed (wrong sender, conversation, scope, commitment, missing frank)', async () => {
    const { frank, received } = await sent('hi');
    const base = { frank, scope: SCOPE_CHANNEL, conversationId: CHAN, senderId: ALICE };
    for (const over of [
      { senderId: BOB }, { conversationId: 'other' }, { scope: SCOPE_DM },
      { frank: { v: 1, c: toB64(new Uint8Array(32)) } }, { frank: undefined }, { frank: { v: 2, c: frank.c } },
    ]) {
      const out = await openFranked(received, { ...base, ...over });
      expect(out.verify, JSON.stringify(over)).toBe('failed');
      expect(out.plaintext).toBe('hi'); // kept for click-to-reveal
    }
  });

  it('tampered content breaks the commitment', async () => {
    const { frank, received } = await sent('pay 10');
    const tampered = received.replace('pay 10', 'pay 99');
    const out = await openFranked(tampered, { frank, scope: SCOPE_CHANNEL, conversationId: CHAN, senderId: ALICE });
    expect(out.verify).toBe('failed');
  });

  it('v1 text passes through untouched', async () => {
    expect(await openFranked('plain', { frank: undefined, scope: SCOPE_CHANNEL, conversationId: CHAN, senderId: ALICE })).toEqual({ plaintext: 'plain' });
  });

  it('DMs commit to the DM conversation id', async () => {
    const conv = [ALICE, BOB].sort().join('-');
    const { frank, received } = await sent('dm', { scope: SCOPE_DM, conv });
    const ok = await openFranked(received, { frank, scope: SCOPE_DM, conversationId: conv, senderId: ALICE });
    expect(ok.verify).toBe('ok');
  });
});

describe('carry-through (storage, backfill, strip rows)', () => {
  it('normalizeRow keeps franking fields; v1 rows keep their old shape', async () => {
    const { frank, received } = await sent('kept');
    const opened = await openFranked(received, { frank, scope: SCOPE_CHANNEL, conversationId: CHAN, senderId: ALICE });
    const row = normalizeRow({ id: 'm1', channel_id: CHAN, sender_id: ALICE, timestamp: '2026-11-12T00:00:00.000Z', ...opened });
    expect(row).toMatchObject({ plaintext: 'kept', content_json: opened.content_json, fk: opened.fk, frank, verify: 'ok' });
    const v1 = normalizeRow({ id: 'm2', channel_id: CHAN, timestamp: '2026-11-12T00:00:00.000Z', plaintext: 'x' });
    expect(Object.keys(v1)).not.toContain('frank');
    expect(Object.keys(v1)).not.toContain('verify');
  });

  it('bundle carries fk/frank/content_json but never a verdict; receiver re-verifies', async () => {
    const { frank, received } = await sent('backfilled');
    const opened = await openFranked(received, { frank, scope: SCOPE_CHANNEL, conversationId: CHAN, senderId: ALICE });
    const stored = { id: 'm1', sender_id: ALICE, timestamp: '2026-11-12T00:00:00.000Z', ...opened };
    const item = toBundleItem(stored);
    expect(item.verify).toBeUndefined();
    const [chunk] = chunkBundle([item]);
    const [row] = parseBundle(chunk.json, { channelId: CHAN, relayedBy: BOB });
    expect(row.fk).toBe(opened.fk);
    expect((await reverifyRow(row, { scope: SCOPE_CHANNEL, conversationId: CHAN })).verify).toBe('ok');
    // A relayer that edits the text or the content gets it marked unverified.
    const edited = await reverifyRow({ ...row, content_json: textContentJson('forged') }, { scope: SCOPE_CHANNEL, conversationId: CHAN });
    expect(edited).toMatchObject({ verify: 'failed', plaintext: 'forged' });
    const textOnly = await reverifyRow({ ...row, plaintext: 'forged text' }, { scope: SCOPE_CHANNEL, conversationId: CHAN });
    expect(textOnly).toMatchObject({ verify: 'ok', plaintext: 'backfilled' });
  });

  it('strip rows flag unverified messages (D2)', () => {
    const rows = buildChatRows([
      { id: 'a', plaintext: 'ok', timestamp: 't', verify: 'ok' },
      { id: 'b', plaintext: 'bad', timestamp: 't', verify: 'failed' },
      { id: 'c', plaintext: 'v1', timestamp: 't' },
    ]);
    expect(rows.map((r) => Boolean(r.unverified))).toEqual([false, true, false]);
  });
});
