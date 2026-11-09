/**
 * Integration tests: admin panel authorization, sessions, audit log, bans,
 * and data-subject erasure.
 *
 * Requires: DB_DSN pointing to a test PostgreSQL instance with migrations
 * applied (incl. 000067_admin_hardening), as in CI's server-integration job.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import argon2 from 'argon2';
import { agent, pool, registerUser, cleanupUsers } from './helpers.js';

const stamp = Date.now();
const PASSWORD = 'AdminPass_1!';
const admins: Record<'viewer' | 'operator' | 'owner', { username: string; id?: string; token?: string }> = {
  viewer:   { username: `t_view_${stamp}`.slice(0, 32) },
  operator: { username: `t_oper_${stamp}`.slice(0, 32) },
  owner:    { username: `t_own_${stamp}`.slice(0, 32) },
};
const callsigns: string[] = [];

async function login(username: string) {
  const res = await agent().post('/admin/login').send({ username, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('admin panel', () => {
  let target: Awaited<ReturnType<typeof registerUser>>;
  let webUser: Awaited<ReturnType<typeof registerUser>>;

  beforeAll(async () => {
    const hash = await argon2.hash(PASSWORD);
    for (const [role, a] of Object.entries(admins)) {
      const r = await pool.query(
        `INSERT INTO platform_admins (username, password_hash, rotp_secret, permissions, role)
         VALUES ($1, $2, 'unused', '{}', $3) RETURNING id`,
        [a.username, hash, role],
      );
      a.id = r.rows[0].id;
      a.token = await login(a.username);
    }
    target = await registerUser('admtarget');
    webUser = await registerUser('admweb');
    callsigns.push(target.callsign, webUser.callsign);
    await pool.query(`UPDATE users SET hwid = 'browser-fallback-hwid' WHERE id = $1`, [webUser.userId]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM hardware_bans WHERE source_user_id = ANY($1::uuid[])`, [[target.userId, webUser.userId]]);
    await cleanupUsers(callsigns);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[target.userId, webUser.userId]]);
    await pool.query(`DELETE FROM platform_admins WHERE username = ANY($1::text[])`, [Object.values(admins).map((a) => a.username)]);
  });

  it('rejects a regular user token on every admin route (server-side gate)', async () => {
    const res = await agent().get('/admin/users').set(auth(target.token));
    expect(res.status).toBe(403);
  });

  it('enforces least privilege: viewer can read but not ban', async () => {
    const list = await agent().get('/admin/users?limit=5').set(auth(admins.viewer.token!));
    expect(list.status).toBe(200);
    expect(list.body.limit).toBe(5);
    expect(list.body.users[0]).not.toHaveProperty('hwid');
    const ban = await agent().post(`/admin/users/${target.userId}/ban`).set(auth(admins.viewer.token!))
      .send({ ban: true, reason: 'x', confirm_callsign: target.callsign });
    expect(ban.status).toBe(403);
  });

  it('caps page size server-side', async () => {
    const res = await agent().get('/admin/users?limit=5000').set(auth(admins.viewer.token!));
    expect(res.body.limit).toBe(100);
  });

  it('masks email in detail and audits an explicit reveal', async () => {
    const detail = await agent().get(`/admin/users/${target.userId}`).set(auth(admins.viewer.token!));
    expect(detail.status).toBe(200);
    expect(detail.body.user.email_masked).toMatch(/•••/);
    expect(JSON.stringify(detail.body)).not.toContain(target.email);

    const noReason = await agent().post(`/admin/users/${target.userId}/reveal-email`).set(auth(admins.operator.token!)).send({});
    expect(noReason.status).toBe(400);

    const reveal = await agent().post(`/admin/users/${target.userId}/reveal-email`).set(auth(admins.operator.token!))
      .send({ reason: 'support ticket #1' });
    expect(reveal.status).toBe(200);
    expect(reveal.body.email).toBe(target.email);
    const audit = await pool.query(
      `SELECT summary::text AS s FROM admin_audit_log WHERE action = 'user.email_revealed' AND target_id = $1`,
      [target.userId],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].s).not.toContain(target.email);
  });

  it('requires typed confirmation to ban, revokes sessions, and audits before/after', async () => {
    const noConfirm = await agent().post(`/admin/users/${target.userId}/ban`).set(auth(admins.operator.token!))
      .send({ ban: true, reason: 'tos' });
    expect(noConfirm.status).toBe(400);

    const ok = await agent().post(`/admin/users/${target.userId}/ban`).set(auth(admins.operator.token!))
      .send({ ban: true, reason: 'tos', confirm_callsign: target.callsign });
    expect(ok.status).toBe(200);
    expect(ok.body.sessions_revoked).toBeGreaterThan(0);

    const audit = await pool.query(
      `SELECT summary FROM admin_audit_log WHERE action = 'user.banned' AND target_id = $1`, [target.userId],
    );
    expect(audit.rows[0].summary.before.is_banned).toBe(false);
    expect(audit.rows[0].summary.after.is_banned).toBe(true);
  });

  it('refuses a hardware ban on the shared browser placeholder id', async () => {
    const res = await agent().post(`/admin/users/${webUser.userId}/ban`).set(auth(admins.operator.token!))
      .send({ ban: true, reason: 'tos', confirm_callsign: webUser.callsign, hwid_ban: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('HWID_NOT_BANNABLE');
    const ban = await pool.query(`SELECT 1 FROM hardware_bans WHERE hwid = 'browser-fallback-hwid'`);
    expect(ban.rowCount).toBe(0);
  });

  it('keeps the audit log append-only', async () => {
    await expect(pool.query(`UPDATE admin_audit_log SET reason = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM admin_audit_log`)).rejects.toThrow(/append-only/);
  });

  it('requires a fresh re-auth for erasure, then anonymises the account', async () => {
    await pool.query(`UPDATE admin_sessions SET reauth_at = NULL WHERE admin_id = $1`, [admins.owner.id]);
    const body = { reason: 'DSR-1', confirm_callsign: target.callsign };

    const blocked = await agent().post(`/admin/users/${target.userId}/erase`).set(auth(admins.owner.token!)).send(body);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('REAUTH_REQUIRED');

    const wrong = await agent().post('/admin/reauth').set(auth(admins.owner.token!)).send({ password: 'nope' });
    expect(wrong.status).toBe(401);
    const re = await agent().post('/admin/reauth').set(auth(admins.owner.token!)).send({ password: PASSWORD });
    expect(re.status).toBe(200);

    const preview = await agent().get(`/admin/users/${target.userId}/erasure-preview`).set(auth(admins.owner.token!));
    expect(preview.status).toBe(200);
    expect(preview.body.blockers.owned_orgs).toEqual([]);

    const exp = await agent().post(`/admin/users/${target.userId}/export`).set(auth(admins.owner.token!)).send(body);
    expect(exp.status).toBe(200);
    expect(exp.body.subject.email).toBe(target.email);
    expect(JSON.stringify(exp.body)).not.toMatch(/password_hash|token_hash/);

    const erased = await agent().post(`/admin/users/${target.userId}/erase`).set(auth(admins.owner.token!)).send(body);
    expect(erased.status).toBe(200);

    const row = await pool.query(
      `SELECT callsign, email_encrypted, hwid, erased_at, is_banned FROM users WHERE id = $1`, [target.userId],
    );
    expect(row.rows[0].callsign).toMatch(/^deleted_/);
    expect(row.rows[0].email_encrypted).toBeNull();
    expect(row.rows[0].erased_at).not.toBeNull();
    const tokens = await pool.query(`SELECT 1 FROM refresh_tokens WHERE user_id = $1`, [target.userId]);
    expect(tokens.rowCount).toBe(0);

    const login = await agent().post('/auth/login').send({ email: target.email, password: 'TestPass_1!' });
    expect(login.status).toBe(401);
  });

  it('expires idle sessions server-side and honours logout', async () => {
    const t = await login(admins.viewer.username);
    await pool.query(
      `UPDATE admin_sessions SET last_seen_at = NOW() - INTERVAL '6 hours' WHERE admin_id = $1 AND revoked_at IS NULL`,
      [admins.viewer.id],
    );
    const idle = await agent().get('/admin/me').set(auth(t));
    expect(idle.status).toBe(401);
    expect(idle.body.code).toBe('ADMIN_SESSION_EXPIRED');

    const t2 = await login(admins.viewer.username);
    expect((await agent().post('/admin/logout').set(auth(t2))).status).toBe(200);
    expect((await agent().get('/admin/me').set(auth(t2))).status).toBe(401);
  });

  it('applies a role change on the next request without re-login', async () => {
    const t = await login(admins.operator.username);
    await pool.query(`UPDATE platform_admins SET role = 'viewer' WHERE id = $1`, [admins.operator.id]);
    const res = await agent().get('/admin/audit').set(auth(t));
    expect(res.status).toBe(403);
  });
});
