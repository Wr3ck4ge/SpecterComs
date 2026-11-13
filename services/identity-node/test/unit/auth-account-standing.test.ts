// Login and /auth/refresh refuse banned and erased accounts. No database:
// pg, NATS, argon2 and mail are mocked, and each test scripts the rows the
// controller's queries get back — so this runs whether or not the erased_at
// column (admin hardening migration) exists anywhere.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
}));

vi.mock('../../src/config/db.js', () => ({
  pool: {
    query: db.query,
    connect: async () => ({ query: db.clientQuery, release: () => {} }),
  },
}));
vi.mock('../../src/config/nats.js', () => ({ publishEvent: vi.fn(async () => {}) }));
vi.mock('../../src/utils/emailService.js', () => ({ sendPasswordResetEmail: vi.fn() }));
vi.mock('argon2', () => ({ default: { verify: vi.fn(async (_h: string, pw: string) => pw === 'right-password'), hash: vi.fn() } }));

process.env.JWT_SECRET = 'unit-test-secret';
const { login, refresh } = await import('../../src/controllers/authController.js');

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

const userRow = (over: Record<string, unknown> = {}) => ({
  id: 'u1', callsign: 'Ghost', password_hash: '$argon2id$x', global_tag: null,
  profile_image_path: null, timezone: null, subscription_tier: 'free',
  is_banned: false, is_erased: false, ...over,
});

describe('login: account standing', () => {
  beforeEach(() => {
    db.query.mockReset();
    db.query.mockImplementation(async (sql: string) => {
      if (/^\s*SELECT u\.id/.test(sql)) return { rows: [currentUser] };
      if (/INSERT INTO refresh_tokens/.test(sql)) return { rows: [{ id: 'rt1' }] };
      return { rows: [], rowCount: 0 };
    });
  });
  let currentUser = userRow();

  it('lets a user in good standing log in', async () => {
    currentUser = userRow();
    const res = mockRes();
    await login({ body: { email: 'g@x.io', password: 'right-password' } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
  });

  it('refuses a banned account with a generic 403 and issues no tokens', async () => {
    currentUser = userRow({ is_banned: true });
    const res = mockRes();
    await login({ body: { email: 'g@x.io', password: 'right-password' } } as any, res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: 'Account access has been revoked. To appeal, visit https://spectercoms.net/appeal' });
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO refresh_tokens/.test(sql))).toBe(false);
  });

  it('does not reveal a ban to someone without the password', async () => {
    currentUser = userRow({ is_banned: true });
    const res = mockRes();
    await login({ body: { email: 'g@x.io', password: 'wrong' } } as any, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Invalid credentials' });
  });

  it('answers an erased account exactly like an unknown one', async () => {
    currentUser = userRow({ is_erased: true });
    const res = mockRes();
    await login({ body: { email: 'g@x.io', password: 'right-password' } } as any, res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Invalid credentials' });
  });

  it('reads erased_at in a way that works before the column exists', async () => {
    currentUser = userRow();
    await login({ body: { email: 'g@x.io', password: 'right-password' } } as any, mockRes());
    const sql = db.query.mock.calls.find(([s]) => /^\s*SELECT u\.id/.test(s))![0] as string;
    expect(sql).toMatch(/to_jsonb\(u\) ->> 'erased_at'/);
    expect(sql).not.toMatch(/u\.erased_at/);
  });
});

describe('refresh: account standing', () => {
  let row: Record<string, unknown>;
  beforeEach(() => {
    db.clientQuery.mockReset();
    db.clientQuery.mockImplementation(async (sql: string) => {
      if (/FROM refresh_tokens rt JOIN users u/.test(sql)) return { rows: [row] };
      if (/INSERT INTO refresh_tokens/.test(sql)) return { rows: [{ id: 'rt2' }] };
      if (/UPDATE refresh_tokens/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [], rowCount: 0 };
    });
  });
  const req = { body: { refresh_token: 'a'.repeat(64) }, get: () => 'ua' } as any;
  const baseRow = { id: 'rt1', user_id: 'u1', revoked_at: null, replaced_by: null, callsign: 'Ghost', expired: false, within_grace: false };

  it('rotates for a user in good standing', async () => {
    row = { ...baseRow, is_banned: false, is_erased: false };
    const res = mockRes();
    await refresh(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  for (const [label, standing] of [['banned', { is_banned: true, is_erased: false }], ['erased', { is_banned: false, is_erased: true }]] as const) {
    it(`refuses a ${label} account: 403, no new token, every refresh token revoked`, async () => {
      row = { ...baseRow, ...standing };
      const res = mockRes();
      await refresh(req, res);
      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ message: 'Account access has been revoked. To appeal, visit https://spectercoms.net/appeal' });
      const sqls = db.clientQuery.mock.calls.map(([s]) => s as string);
      expect(sqls.some((s) => /INSERT INTO refresh_tokens/.test(s))).toBe(false);
      expect(sqls.some((s) => /UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE user_id = \$1/.test(s))).toBe(true);
    });
  }
});
