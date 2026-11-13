// REQUIRE_EMAIL_VERIFICATION: switch semantics, signup marking, login/refresh
// gate, grandfathering and the non-enumerating public resend. DB/mail mocked.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn() }));
const mail = vi.hoisted(() => ({ sendVerificationEmail: vi.fn(async () => true) }));

vi.mock('../../src/config/db.js', () => ({
  pool: { query: db.query, connect: async () => ({ query: db.clientQuery, release: () => {} }) },
}));
vi.mock('../../src/config/nats.js', () => ({ publishEvent: vi.fn(async () => {}) }));
vi.mock('../../src/utils/emailService.js', () => ({
  sendPasswordResetEmail: vi.fn(),
  sendVerificationEmail: mail.sendVerificationEmail,
  sendEmailChangeNotice: vi.fn(),
  isMailerConfigured: () => true,
}));
vi.mock('argon2', () => ({
  default: { verify: vi.fn(async (_h: string, pw: string) => pw === 'right-password'), hash: vi.fn(async () => 'hash') },
}));

process.env.JWT_SECRET = 'unit-test-secret';
process.env.EMAIL_ENCRYPTION_KEY = 'a'.repeat(64);
const { register, login, refresh } = await import('../../src/controllers/authController.js');
const { resendVerificationPublic, PUBLIC_RESEND_MESSAGE } = await import('../../src/controllers/emailVerificationController.js');
const { requireEmailVerification, maskEmail, isBlockedUnverified } = await import('../../src/utils/emailVerification.js');
const { encryptEmail } = await import('../../src/utils/encryption.js');

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}
const userRow = (over: Record<string, unknown> = {}) => ({
  id: 'u1', callsign: 'Ghost', password_hash: '$argon2id$x', global_tag: null, profile_image_path: null,
  timezone: null, subscription_tier: 'free', is_banned: false, is_erased: false,
  email_verified_at: null, email_verification_required: false, email_encrypted: encryptEmail('jane@x.com'),
  email_verify_sent_at: null, pending_email_encrypted: null, ...over,
});

describe('helpers', () => {
  it('switch defaults off and parses truthy values', () => {
    expect(requireEmailVerification({} as any)).toBe(false);
    expect(requireEmailVerification({ REQUIRE_EMAIL_VERIFICATION: 'false' } as any)).toBe(false);
    expect(requireEmailVerification({ REQUIRE_EMAIL_VERIFICATION: 'true' } as any)).toBe(true);
    expect(requireEmailVerification({ REQUIRE_EMAIL_VERIFICATION: '1' } as any)).toBe(true);
  });
  it('masks the address', () => expect(maskEmail('jane@x.com')).toBe('j***@x.com'));
  it('blocks only required+unverified', () => {
    expect(isBlockedUnverified({ email_verification_required: true, email_verified_at: null })).toBe(true);
    expect(isBlockedUnverified({ email_verification_required: true, email_verified_at: new Date() })).toBe(false);
    expect(isBlockedUnverified({ email_verification_required: false, email_verified_at: null })).toBe(false);
  });
});

describe('register', () => {
  beforeEach(() => {
    db.query.mockReset(); db.clientQuery.mockReset(); mail.sendVerificationEmail.mockClear();
    db.query.mockImplementation(async (sql: string) =>
      /INSERT INTO refresh_tokens/.test(sql) ? { rows: [{ id: 'rt1' }] } : { rows: [], rowCount: 0 });
    db.clientQuery.mockImplementation(async (sql: string) =>
      /INSERT INTO users/.test(sql) ? { rows: [{ id: 'u1', callsign: 'Ghost', global_tag: null, timezone: null }] } : { rows: [] });
  });
  const body = { callsign: 'Ghost', email: 'jane@x.com', password: 'pw-long-enough' };
  const insertParams = () => db.clientQuery.mock.calls.find(([s]) => /INSERT INTO users/.test(s))![1];

  it('switch off: unchanged, tokens issued, account not marked', async () => {
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
    const res = mockRes();
    await register({ body } as any, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.verification_required).toBe(false);
    expect(insertParams()[7]).toBe(false);
  });
  it('switch on: account marked, no tokens, client told to check email', async () => {
    process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
    const res = mockRes();
    await register({ body } as any, res);
    delete process.env.REQUIRE_EMAIL_VERIFICATION;
    expect(res.statusCode).toBe(201);
    expect(res.body.token).toBeUndefined();
    expect(res.body.verification_required).toBe(true);
    expect(res.body.masked_email).toBe('j***@x.com');
    expect(insertParams()[7]).toBe(true);
    expect(mail.sendVerificationEmail).toHaveBeenCalled();
  });
});

describe('login / refresh gate', () => {
  let row = userRow();
  beforeEach(() => {
    db.query.mockReset(); db.clientQuery.mockReset();
    db.query.mockImplementation(async (sql: string) => {
      if (/^\s*SELECT u\.id/.test(sql)) return { rows: [row] };
      if (/INSERT INTO refresh_tokens/.test(sql)) return { rows: [{ id: 'rt1' }] };
      return { rows: [], rowCount: 0 };
    });
    db.clientQuery.mockImplementation(async (sql: string) => {
      if (/FROM refresh_tokens rt/.test(sql)) return { rows: [{ ...row, id: 'rt1', user_id: 'u1', revoked_at: null, expired: false, within_grace: false }] };
      return { rows: [{ id: 'rt2' }] };
    });
  });
  it('blocks a required, unverified account with EMAIL_NOT_VERIFIED and no tokens', async () => {
    row = userRow({ email_verification_required: true });
    const res = mockRes();
    await login({ body: { email: 'jane@x.com', password: 'right-password' } } as any, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(res.body.masked_email).toBe('j***@x.com');
    expect(res.body.token).toBeUndefined();
    expect(db.query.mock.calls.some(([s]) => /INSERT INTO refresh_tokens/.test(s))).toBe(false);
  });
  it('does not reveal the state without the right password', async () => {
    row = userRow({ email_verification_required: true });
    const res = mockRes();
    await login({ body: { email: 'jane@x.com', password: 'nope' } } as any, res);
    expect(res.statusCode).toBe(401);
  });
  it('lets a verified required account in', async () => {
    row = userRow({ email_verification_required: true, email_verified_at: new Date() });
    const res = mockRes();
    await login({ body: { email: 'jane@x.com', password: 'right-password' } } as any, res);
    expect(res.statusCode).toBe(200);
  });
  it('grandfathered unverified account is unaffected', async () => {
    row = userRow();
    const res = mockRes();
    await login({ body: { email: 'jane@x.com', password: 'right-password' } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
  it('refresh refuses a required, unverified account', async () => {
    row = userRow({ email_verification_required: true });
    const res = mockRes();
    await refresh({ body: { refresh_token: 'x'.repeat(40) }, get: () => '' } as any, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
  });
});

describe('public resend is non-enumerating', () => {
  let row: any;
  beforeEach(() => {
    mail.sendVerificationEmail.mockClear(); db.query.mockReset();
    db.query.mockImplementation(async (sql: string) =>
      /FROM users/.test(sql) ? { rows: row ? [row] : [] } : { rows: [], rowCount: 1 });
  });
  const call = async (b: any) => { const res = mockRes(); await resendVerificationPublic({ body: b } as any, res); return res; };

  it('unknown account, wrong password and real account get the same answer; only the real one mails', async () => {
    row = undefined;
    const a = await call({ email: 'ghost@x.com', password: 'right-password' });
    row = userRow({ email_verification_required: true });
    const b = await call({ email: 'jane@x.com', password: 'wrong' });
    expect(mail.sendVerificationEmail).not.toHaveBeenCalled();
    const c = await call({ email: 'jane@x.com', password: 'right-password' });
    expect(mail.sendVerificationEmail).toHaveBeenCalledTimes(1);
    for (const r of [a, b, c]) { expect(r.statusCode).toBe(200); expect(r.body).toEqual({ message: PUBLIC_RESEND_MESSAGE }); }
  });
  it('respects the cooldown and skips accounts that do not need verification', async () => {
    row = userRow({ email_verification_required: true, email_verify_sent_at: new Date() });
    const a = await call({ callsign: 'Ghost', password: 'right-password' });
    row = userRow();
    const b = await call({ callsign: 'Ghost', password: 'right-password' });
    expect(mail.sendVerificationEmail).not.toHaveBeenCalled();
    expect(a.body).toEqual(b.body);
  });
});
