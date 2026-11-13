// L3: two-factor authentication. Pure TOTP/recovery/challenge helpers, plus
// the store, login second step and REQUIRE_2FA_FOR_PRIVILEGED enforcement
// against an in-memory stand-in for the two tables (pg, NATS, argon2 mocked).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/config/db.js', () => ({
  pool: { query: db.query, connect: async () => ({ query: db.query, release: () => {} }) },
}));
vi.mock('../../src/config/nats.js', () => ({ publishEvent: vi.fn(async () => {}) }));
vi.mock('../../src/utils/emailService.js', () => ({ sendPasswordResetEmail: vi.fn(), sendVerificationEmail: vi.fn(), sendEmailChangeNotice: vi.fn(), isMailerConfigured: () => false }));
vi.mock('argon2', () => ({ default: { verify: vi.fn(async (_h: string, pw: string) => pw === 'right-password'), hash: vi.fn() } }));

process.env.JWT_SECRET = 'unit-test-secret';
process.env.EMAIL_ENCRYPTION_KEY = 'ab'.repeat(32);

const tf = await import('../../src/utils/twoFactor.js');
const store = await import('../../src/utils/twoFactorStore.js');
const { login, verifyTwoFactorLogin } = await import('../../src/controllers/authController.js');
const { requireOwnerTwoFactor, requireAdminTwoFactor, checkSecondFactor } = await import('../../src/controllers/twoFactorController.js');

const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_B32 = tf.base32Encode(RFC_KEY);

function mockRes() {
  const res: any = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  return res;
}

// ---- in-memory two_factor / two_factor_recovery_codes / users / orgs --------

let tfRow: { secret_encrypted: string; enabled: boolean; last_used_step: number | null } | null;
let rcRows: { code_hash: string; used: boolean }[];
let orgOwner: string | null;
const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

function fakeDb(sql: string, params: any[] = []) {
  if (/SELECT \(t\.enabled_at IS NOT NULL\) AS enabled/.test(sql)) {
    return { rows: tfRow ? [{ enabled: tfRow.enabled, remaining: rcRows.filter((r) => !r.used).length }] : [] };
  }
  if (/SELECT secret_encrypted, last_used_step FROM two_factor/.test(sql)) {
    const wantEnabled = /enabled_at IS NOT NULL/.test(sql);
    return { rows: tfRow && tfRow.enabled === wantEnabled ? [{ ...tfRow }] : [] };
  }
  if (/UPDATE two_factor SET last_used_step = \$3/.test(sql)) {
    const step = params[2];
    if (tfRow && tfRow.enabled && (tfRow.last_used_step === null || tfRow.last_used_step < step)) {
      tfRow.last_used_step = step;
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }
  if (/UPDATE two_factor_recovery_codes rc SET used_at/.test(sql)) {
    const r = rcRows.find((x) => x.code_hash === params[2] && !x.used);
    if (tfRow?.enabled && r) { r.used = true; return { rowCount: 1, rows: [{ id: 1 }] }; }
    return { rowCount: 0, rows: [] };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM two_factor_recovery_codes/.test(sql)) {
    return { rows: [{ n: rcRows.filter((r) => !r.used).length }] };
  }
  if (/^\s*SELECT u\.id/.test(sql)) {
    return { rows: [{ id: USER, callsign: 'Ghost', password_hash: '$argon2id$x', is_banned: false, is_erased: false, subscription_tier: 'free' }] };
  }
  if (/INSERT INTO refresh_tokens/.test(sql)) return { rows: [{ id: 'rt1' }] };
  if (/SELECT owner_id FROM organizations/.test(sql)) return { rows: orgOwner ? [{ owner_id: orgOwner }] : [] };
  return { rows: [], rowCount: 0 };
}

const subject = { type: 'user' as const, id: USER };
function enrol(enabled = true, lastStep: number | null = null) {
  tfRow = { secret_encrypted: tf.encryptTotpSecret(RFC_B32, subject), enabled, last_used_step: lastStep };
}

beforeEach(() => {
  tfRow = null; rcRows = []; orgOwner = null;
  db.query.mockReset();
  db.query.mockImplementation(async (sql: string, params?: any[]) => fakeDb(sql, params));
  delete process.env.REQUIRE_2FA_FOR_PRIVILEGED;
});

// ---------------------------------------------------------------------------

describe('TOTP (RFC 6238 SHA-1 vectors)', () => {
  const vectors: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [t, code] of vectors) {
    it(`T=${t} -> ${code}`, () => {
      expect(tf.hotp(RFC_KEY, Math.floor(t / 30), 8)).toBe(code);
    });
  }

  it('6-digit codes are the low digits; base32 round-trips', () => {
    expect(tf.base32Decode(RFC_B32).equals(RFC_KEY)).toBe(true);
    expect(tf.totp(RFC_B32, 59_000)).toBe('287082');
  });

  it('accepts the previous / current / next step, not two away', () => {
    const now = 1_700_000_000_000;
    const step = tf.timeStep(now);
    const key = tf.base32Decode(RFC_B32);
    expect(tf.matchTotp(RFC_B32, tf.hotp(key, step), null, now)).toBe(step);
    expect(tf.matchTotp(RFC_B32, tf.hotp(key, step - 1), null, now)).toBe(step - 1);
    expect(tf.matchTotp(RFC_B32, tf.hotp(key, step + 1), null, now)).toBe(step + 1);
    expect(tf.matchTotp(RFC_B32, tf.hotp(key, step - 2), null, now)).toBeNull();
    expect(tf.matchTotp(RFC_B32, tf.hotp(key, step + 2), null, now)).toBeNull();
    expect(tf.matchTotp(RFC_B32, 'abcdef', null, now)).toBeNull();
    expect(tf.matchTotp(RFC_B32, `${tf.hotp(key, step).slice(0, 3)} ${tf.hotp(key, step).slice(3)}`, null, now)).toBe(step);
  });

  it('refuses a step at or before the last used one (replay)', () => {
    const now = 1_700_000_000_000;
    const step = tf.timeStep(now);
    const code = tf.hotp(tf.base32Decode(RFC_B32), step);
    expect(tf.matchTotp(RFC_B32, code, step, now)).toBeNull();
    expect(tf.matchTotp(RFC_B32, code, step + 1, now)).toBeNull();
    expect(tf.matchTotp(RFC_B32, code, step - 1, now)).toBe(step);
  });

  it('otpauth URI carries issuer, secret and parameters', () => {
    const uri = tf.otpauthUri(RFC_B32, 'Ghost');
    expect(uri).toMatch(/^otpauth:\/\/totp\/SpecterComs%3AGhost\?/);
    expect(uri).toContain(`secret=${RFC_B32}`);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('secret encryption + recovery codes', () => {
  it('encrypts the secret at rest, bound to its subject', () => {
    const enc = tf.encryptTotpSecret(RFC_B32, subject);
    expect(enc).not.toContain(RFC_B32);
    expect(tf.decryptTotpSecret(enc, subject)).toBe(RFC_B32);
    expect(() => tf.decryptTotpSecret(enc, { type: 'admin', id: USER })).toThrow();
  });

  it('makes 10 distinct well-formed codes, hashed with a server key', () => {
    const codes = tf.generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const norm = tf.normalizeRecoveryCode(codes[0].toLowerCase().replace(/-/g, ' '))!;
    expect(norm).toBe(codes[0].replace(/-/g, ''));
    expect(tf.hashRecoveryCode(norm)).not.toBe(tf.hashRecoveryCode(norm, { EMAIL_ENCRYPTION_KEY: 'cd'.repeat(32) } as any));
    expect(tf.normalizeRecoveryCode('short')).toBeNull();
  });
});

describe('login challenge', () => {
  it('verifies for its own subject type only', () => {
    const { challenge } = tf.signChallenge(subject, 'secret');
    expect(tf.verifyChallenge(challenge, 'secret', 'user')?.sub).toBe(USER);
    expect(tf.verifyChallenge(challenge, 'secret', 'admin')).toBeNull();
    expect(tf.verifyChallenge(challenge, 'other', 'user')).toBeNull();
  });

  it('is not an access token, and an access token is not a challenge', () => {
    const { challenge } = tf.signChallenge(subject, 'secret');
    expect(() => jwt.verify(challenge, 'secret')).toThrow();
    const access = jwt.sign({ id: USER, sub: USER, st: 'user', jti: 'x', aud: 'specter-2fa' }, 'secret');
    expect(tf.verifyChallenge(access, 'secret', 'user')).toBeNull();
  });

  it('expires', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
      const { challenge } = tf.signChallenge(subject, 'secret');
      vi.setSystemTime(new Date('2026-11-12T12:04:59Z'));
      expect(tf.verifyChallenge(challenge, 'secret', 'user')).not.toBeNull();
      vi.setSystemTime(new Date('2026-11-12T12:05:01Z'));
      expect(tf.verifyChallenge(challenge, 'secret', 'user')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('store: verifyFactor', () => {
  it('accepts a code once, then refuses the same step', async () => {
    enrol();
    const code = tf.totp(RFC_B32);
    expect((await store.verifyFactor(subject, { code })).ok).toBe(true);
    expect((await store.verifyFactor(subject, { code })).ok).toBe(false);
  });

  it('spends a recovery code exactly once', async () => {
    enrol();
    const [code] = tf.generateRecoveryCodes(1);
    rcRows = [{ code_hash: tf.hashRecoveryCode(tf.normalizeRecoveryCode(code)!), used: false }];
    const first = await store.verifyFactor(subject, { recovery_code: code });
    expect(first).toEqual({ ok: true, method: 'recovery', recovery_remaining: 0 });
    expect((await store.verifyFactor(subject, { recovery_code: code })).ok).toBe(false);
  });

  it('refuses everything while enrolment is only pending', async () => {
    enrol(false);
    expect((await store.verifyFactor(subject, { code: tf.totp(RFC_B32) })).ok).toBe(false);
  });

  it('reads "not enrolled" when the table does not exist yet', async () => {
    db.query.mockImplementationOnce(async () => { throw Object.assign(new Error('missing'), { code: '42P01' }); });
    expect(await store.isEnabled(subject)).toBe(false);
  });
});

describe('login with 2FA', () => {
  const body = { email: 'g@x.io', password: 'right-password' };

  it('without 2FA: tokens straight away', async () => {
    const res = mockRes();
    await login({ body } as any, res);
    expect(res.body.token).toBeTruthy();
  });

  it('with 2FA: a challenge and no tokens, then code -> tokens; the challenge is single-use', async () => {
    enrol();
    const res = mockRes();
    await login({ body } as any, res);
    expect(res.body.two_factor_required).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(db.query.mock.calls.some(([s]) => /INSERT INTO refresh_tokens/.test(s))).toBe(false);

    const bad = mockRes();
    await verifyTwoFactorLogin({ body: { challenge: res.body.challenge, code: '000000' } } as any, bad);
    expect(bad.statusCode).toBe(401);

    const ok = mockRes();
    await verifyTwoFactorLogin({ body: { challenge: res.body.challenge, code: tf.totp(RFC_B32) } } as any, ok);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.refresh_token).toBeTruthy();

    const again = mockRes();
    await verifyTwoFactorLogin({ body: { challenge: res.body.challenge, code: tf.totp(RFC_B32) } } as any, again);
    expect(again.statusCode).toBe(401);
    expect(again.body.code).toBe('TWO_FACTOR_CHALLENGE_EXPIRED');
  });

  it('stops a challenge after 5 wrong codes', async () => {
    enrol();
    const res = mockRes();
    await login({ body } as any, res);
    for (let i = 0; i < 5; i++) await verifyTwoFactorLogin({ body: { challenge: res.body.challenge, code: '000000' } } as any, mockRes());
    const last = mockRes();
    await verifyTwoFactorLogin({ body: { challenge: res.body.challenge, code: tf.totp(RFC_B32) } } as any, last);
    expect(last.body.code).toBe('TWO_FACTOR_CHALLENGE_EXPIRED');
  });

  it('refuses a garbage challenge', async () => {
    const res = mockRes();
    await verifyTwoFactorLogin({ body: { challenge: 'nope', code: '123456' } } as any, res);
    expect(res.statusCode).toBe(401);
  });
});

describe('re-auth second factor', () => {
  it('passes through when 2FA is off; needs a valid code when on', async () => {
    expect(await checkSecondFactor(subject, {}, mockRes())).toBe(true);
    enrol();
    const missing = mockRes();
    expect(await checkSecondFactor(subject, {}, missing)).toBe(false);
    expect(missing.body.code).toBe('TWO_FACTOR_CODE_REQUIRED');
    expect(await checkSecondFactor(subject, { code: tf.totp(RFC_B32) }, mockRes())).toBe(true);
  });
});

describe('REQUIRE_2FA_FOR_PRIVILEGED', () => {
  const ownerReq = () => ({ params: { id: ORG }, user: { id: USER } });

  it('off: owner actions pass without touching the database', async () => {
    orgOwner = USER;
    const next = vi.fn();
    await requireOwnerTwoFactor(ownerReq(), mockRes(), next);
    await requireAdminTwoFactor({ admin: { id: USER } }, mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('on: an owner without 2FA gets 403 TWO_FACTOR_REQUIRED, with 2FA passes', async () => {
    process.env.REQUIRE_2FA_FOR_PRIVILEGED = 'true';
    orgOwner = USER;
    const res = mockRes();
    const next = vi.fn();
    await requireOwnerTwoFactor(ownerReq(), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('TWO_FACTOR_REQUIRED');
    expect(next).not.toHaveBeenCalled();
    enrol();
    await requireOwnerTwoFactor(ownerReq(), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('on: a non-owner is never blocked by it', async () => {
    process.env.REQUIRE_2FA_FOR_PRIVILEGED = 'true';
    orgOwner = '33333333-3333-4333-8333-333333333333';
    const next = vi.fn();
    await requireOwnerTwoFactor(ownerReq(), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('on: an admin without 2FA gets 403', async () => {
    process.env.REQUIRE_2FA_FOR_PRIVILEGED = '1';
    const res = mockRes();
    const next = vi.fn();
    await requireAdminTwoFactor({ admin: { id: USER } }, res, next);
    expect(res.body.code).toBe('TWO_FACTOR_REQUIRED');
    expect(next).not.toHaveBeenCalled();
  });
});
