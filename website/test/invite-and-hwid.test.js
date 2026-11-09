import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { redeemInviteOnce, _resetInviteAttempts } from '../src/inviteRedeem.js';
import { buildLoginPayload, buildRegisterPayload } from '../src/auth/payloads.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('invite redemption guard', () => {
  beforeEach(() => _resetInviteAttempts());

  it('a double-fired redeem (StrictMode effect) hits the server once', async () => {
    const redeem = vi.fn(async () => ({ data: { org: { callsign: 'X' } }, error: null }));

    const [a, b] = await Promise.all([redeemInviteOnce(redeem, 'ABC'), redeemInviteOnce(redeem, 'ABC')]);
    const c = await redeemInviteOnce(redeem, 'ABC'); // a later remount

    expect(redeem).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(c).toBe(a);
  });

  it('different codes are independent', async () => {
    const redeem = vi.fn(async () => ({ data: {}, error: null }));
    await redeemInviteOnce(redeem, 'A');
    await redeemInviteOnce(redeem, 'B');
    expect(redeem.mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
  });

  it('a failed redeem can be retried', async () => {
    const redeem = vi.fn()
      .mockResolvedValueOnce({ data: null, error: 'Network Error' })
      .mockResolvedValueOnce({ data: { org: {} }, error: null });

    expect((await redeemInviteOnce(redeem, 'ABC')).error).toBe('Network Error');
    expect((await redeemInviteOnce(redeem, 'ABC')).error).toBeNull();
    expect(redeem).toHaveBeenCalledTimes(2);
  });

  it('JoinPage redeems through the guard behind a ref, not straight from the effect', () => {
    const app = fs.readFileSync(path.join(SRC, 'App.jsx'), 'utf8');
    expect(app).toMatch(/redeemInviteOnce\(api\.redeemInvite, code\)/);
    expect(app).toMatch(/startedFor\.current === code/);
    expect(app).not.toMatch(/api\.redeemInvite\(code\)/);
  });
});

describe('no hardcoded hardware id', () => {
  it('login and register payloads carry no hwid', () => {
    const form = { callsign: 'Ghost_1', global_tag: 'TAG', email: 'g@x.io', password: 'hunter22' };
    expect(buildLoginPayload(form)).toEqual({ email: 'g@x.io', password: 'hunter22' });
    const reg = buildRegisterPayload(form, 'UTC');
    expect(reg).toEqual({ callsign: 'Ghost_1', email: 'g@x.io', password: 'hunter22', timezone: 'UTC', global_tag: 'TAG' });
    expect('hwid' in reg).toBe(false);
  });

  it('no website source sends a hwid or the old shared placeholder', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        // The admin panel only *displays* stored hwids / manages bans.
        if (ent.isDirectory()) { if (path.relative(SRC, p) !== path.join('components', 'admin')) walk(p); }
        else if (/\.(jsx?|tsx?)$/.test(ent.name) && ent.name !== 'AdminPortal.jsx') {
          const src = fs.readFileSync(p, 'utf8');
          if (/browser-fallback-hwid|\bhwid\s*[:,}]/.test(src)) offenders.push(path.relative(SRC, p));
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
