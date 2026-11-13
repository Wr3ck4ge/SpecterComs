/**
 * S7 franking (utils/franking.ts) + wire caps (utils/wireCaps.ts): pure
 * functions, no DB or NATS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import {
  parseFrankKeys, parseFrankInput, issueFrank, verifyFrankTag, computeFrankTag,
  frankTagInput, frankKeyring, _resetFrankingForTests,
} from '../../src/utils/franking.js';

vi.mock('../../src/config/db.js', () => ({ pool: { query: vi.fn(async () => { throw new Error('relation has no column wire_caps'); }) } }));
const { parseWireCapsHeader, deviceCapsFor, recordWireCaps } = await import('../../src/utils/wireCaps.js');

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const C = Buffer.alloc(32, 7).toString('base64');
const CTX = { senderId: 'u1', conversationId: 'chan1', msgId: 'm1', timestamp: '2026-11-12T00:00:00.000Z' };

beforeEach(() => { _resetFrankingForTests(); delete process.env.FRANK_KEYS; });

describe('parseFrankKeys', () => {
  it('last entry signs, every entry verifies', () => {
    const ring = parseFrankKeys(`a:${K1}, b:${K2}`);
    expect(ring.signing?.kid).toBe('b');
    expect([...ring.byKid.keys()]).toEqual(['a', 'b']);
  });
  it('unset → no keys', () => {
    expect(parseFrankKeys(undefined).signing).toBeNull();
    expect(parseFrankKeys('  ').byKid.size).toBe(0);
  });
  it('rejects short keys, bad kids and duplicates', () => {
    expect(() => parseFrankKeys(`a:${Buffer.alloc(16).toString('base64')}`)).toThrow(/32 bytes/);
    expect(() => parseFrankKeys(`:${K1}`)).toThrow(/kid/);
    expect(() => parseFrankKeys(`a:${K1},a:${K2}`)).toThrow(/duplicate/);
  });
  it('a malformed env value never throws from frankKeyring (relay untagged)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.FRANK_KEYS = 'nonsense';
    expect(frankKeyring().signing).toBeNull();
    expect(frankKeyring().signing).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('parseFrankInput', () => {
  it('absent is fine (optional until S9)', () => {
    expect(parseFrankInput(undefined)).toEqual({ ok: true, frank: null });
    expect(parseFrankInput(null)).toEqual({ ok: true, frank: null });
  });
  it('accepts v1 with a 32-byte commitment', () => {
    expect(parseFrankInput({ v: 1, c: C })).toEqual({ ok: true, frank: { v: 1, c: C } });
  });
  it.each([
    ['31 bytes', { v: 1, c: Buffer.alloc(31).toString('base64') }],
    ['33 bytes', { v: 1, c: Buffer.alloc(33).toString('base64') }],
    ['not base64', { v: 1, c: `${'!'.repeat(43)}=` }],
    ['base64url', { v: 1, c: `${Buffer.alloc(32, 0xfb).toString('base64url')}=` }],
    ['wrong version', { v: 2, c: C }],
    ['not an object', 'abc'],
    ['array', [1]],
  ])('rejects %s', (_l, v) => {
    expect(parseFrankInput(v).ok).toBe(false);
  });
});

describe('tag', () => {
  it('matches the documented construction', () => {
    const lp = (s: string) => Buffer.concat([Buffer.from([0, Buffer.byteLength(s)]), Buffer.from(s)]);
    const input = Buffer.concat([Buffer.from('specter/frank-tag/v1'), Buffer.from(C, 'base64'),
      lp('u1'), lp('chan1'), lp('m1'), lp(CTX.timestamp)]);
    expect(frankTagInput(C, CTX).equals(input)).toBe(true);
    const want = crypto.createHmac('sha256', Buffer.alloc(32, 1)).update(input).digest('base64');
    expect(computeFrankTag(Buffer.alloc(32, 1), C, CTX)).toBe(want);
  });

  it('issue → verify, any field change fails, old keys still verify', () => {
    const ring = parseFrankKeys(`a:${K1}`);
    const f = issueFrank({ v: 1, c: C }, CTX, ring) as any;
    expect(f).toMatchObject({ v: 1, c: C, kid: 'a' });
    expect(Buffer.from(f.tag, 'base64')).toHaveLength(32);
    expect(verifyFrankTag(f, CTX, ring)).toBe(true);
    for (const k of Object.keys(CTX) as (keyof typeof CTX)[]) {
      expect(verifyFrankTag(f, { ...CTX, [k]: `${CTX[k]}x` }, ring)).toBe(false);
    }
    expect(verifyFrankTag({ ...f, c: Buffer.alloc(32, 8).toString('base64') }, CTX, ring)).toBe(false);
    // Rotation: b signs now, a's tags still verify; an unknown kid fails.
    const rotated = parseFrankKeys(`a:${K1},b:${K2}`);
    expect(verifyFrankTag(f, CTX, rotated)).toBe(true);
    expect(issueFrank({ v: 1, c: C }, CTX, rotated).kid).toBe('b');
    expect(verifyFrankTag(f, CTX, parseFrankKeys(`b:${K2}`))).toBe(false);
  });

  it('no keys → untagged relay, warned once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ring = parseFrankKeys('');
    expect(issueFrank({ v: 1, c: C }, CTX, ring)).toEqual({ v: 1, c: C });
    issueFrank({ v: 1, c: C }, CTX, ring);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('parseWireCapsHeader', () => {
  it.each([
    [undefined, 0], ['3', 3], [' 1 ', 1], [['2'], 2], ['abc', 0], ['-1', 0], ['70000', 0], ['1.5', 0],
  ])('%j → %d', (v, n) => {
    expect(parseWireCapsHeader(v)).toBe(n);
  });
});

describe('wire caps storage is best-effort (migration may lag the deploy)', () => {
  it('a failing query never throws: caps read as {} (everyone v1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordWireCaps('d', 'u', '3')).resolves.toBeUndefined();
    await expect(deviceCapsFor(['u'])).resolves.toEqual({});
    await expect(deviceCapsFor([])).resolves.toEqual({});
    warn.mockRestore();
  });
});
