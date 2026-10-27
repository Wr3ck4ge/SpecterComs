/**
 * Integration tests: refresh token rotation, reuse (theft) detection, and the
 * benign-retry grace window.
 *
 * - Every successful redemption rotates the token (old one revoked, chained
 *   via replaced_by to the successor).
 * - Re-presenting a token that was rotated within REFRESH_REUSE_GRACE_SECONDS,
 *   from the same client, while its successor is still unused, returns the
 *   SAME successor (lost-response retry) — no new credential is minted.
 * - Re-presenting it after the grace window, after the successor was used, or
 *   from a different client is treated as theft: every refresh token the user
 *   has is revoked (all devices), exactly as before the grace window existed.
 * - Concurrent submissions of one token serialize: exactly one rotation.
 *
 * Requires: DB_DSN pointing to a test PostgreSQL instance with migrations applied,
 * JWT_SECRET set, NODE_ENV=test.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app, pool, registerUser, cleanupUsers } from './helpers.js';
import { REFRESH_REUSE_GRACE_SECONDS } from '../controllers/authController.js';

const UA = 'SpecterComs-Test/1.0';
const callsigns: string[] = [];

async function newUser(tag: string) {
  const u = await registerUser(tag);
  callsigns.push(u.callsign);
  return u;
}

const doRefresh = (token: string, ua = UA) =>
  request(app).post('/auth/refresh').set('User-Agent', ua).send({ refresh_token: token });

async function activeTokenCount(userId: string): Promise<number> {
  const r = await pool.query(
    'SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  return r.rows[0].n;
}

async function totalTokenCount(userId: string): Promise<number> {
  const r = await pool.query('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1', [userId]);
  return r.rows[0].n;
}

/** Simulate a second logged-in device for the same user. */
async function loginSecondDevice(callsign: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ callsign, password: 'TestPass_1!' });
  expect(res.status).toBe(200);
  return res.body.refresh_token;
}

afterAll(async () => {
  await cleanupUsers(callsigns);
});

describe('Refresh token rotation', () => {
  it('normal rotation: issues a new pair, revokes the old token, chains replaced_by', async () => {
    const u = await newUser('rot_normal');
    const res = await doRefresh(u.refreshToken);

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.refresh_token).not.toBe(u.refreshToken);

    const rows = await pool.query(
      'SELECT revoked_at, replaced_by FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at',
      [u.userId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].revoked_at).not.toBeNull();
    expect(rows.rows[0].replaced_by).not.toBeNull();
    expect(rows.rows[1].revoked_at).toBeNull();

    // The successor works and itself rotates.
    const next = await doRefresh(res.body.refresh_token);
    expect(next.status).toBe(200);
  });

  it('retry within grace returns the same, working successor (no new credential)', async () => {
    const u = await newUser('rot_grace');
    const first = await doRefresh(u.refreshToken);
    expect(first.status).toBe(200);

    // Response "lost" — client retries with the old token.
    const retry = await doRefresh(u.refreshToken);
    expect(retry.status).toBe(200);
    expect(retry.body.refresh_token).toBe(first.body.refresh_token);
    expect(retry.body.token).toBeTruthy();
    expect(await totalTokenCount(u.userId)).toBe(2); // no extra row minted

    // The replayed successor is a working token.
    const next = await doRefresh(retry.body.refresh_token);
    expect(next.status).toBe(200);
  });

  it('retry after the grace window → whole family revoked (theft)', async () => {
    const u = await newUser('rot_late');
    const otherDevice = await loginSecondDevice(u.callsign);
    const first = await doRefresh(u.refreshToken);
    expect(first.status).toBe(200);

    // Age the rotation past the grace window.
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() - make_interval(secs => $2::double precision)
       WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
      [u.refreshToken, REFRESH_REUSE_GRACE_SECONDS + 5],
    );

    const replay = await doRefresh(u.refreshToken);
    expect(replay.status).toBe(401);
    expect(await activeTokenCount(u.userId)).toBe(0);
    expect((await doRefresh(first.body.refresh_token)).status).toBe(401);
    expect((await doRefresh(otherDevice)).status).toBe(401);
  });

  it('retry after the successor was used → whole family revoked (theft)', async () => {
    const u = await newUser('rot_used');
    const otherDevice = await loginSecondDevice(u.callsign);
    const first = await doRefresh(u.refreshToken);
    expect(first.status).toBe(200);
    const second = await doRefresh(first.body.refresh_token);
    expect(second.status).toBe(200);

    // Old token replayed (still within the grace window) after its successor
    // was already redeemed.
    const replay = await doRefresh(u.refreshToken);
    expect(replay.status).toBe(401);
    expect(await activeTokenCount(u.userId)).toBe(0);
    expect((await doRefresh(second.body.refresh_token)).status).toBe(401);
    expect((await doRefresh(otherDevice)).status).toBe(401);
  });

  it('retry within grace from a different client (User-Agent) → whole family revoked', async () => {
    const u = await newUser('rot_ua');
    const first = await doRefresh(u.refreshToken, UA);
    expect(first.status).toBe(200);

    const replay = await doRefresh(u.refreshToken, 'Attacker/9.9');
    expect(replay.status).toBe(401);
    expect(await activeTokenCount(u.userId)).toBe(0);
    expect((await doRefresh(first.body.refresh_token)).status).toBe(401);
  });

  it('concurrent double-submit → exactly one rotation, both get the same successor', async () => {
    const u = await newUser('rot_race');
    const results = await Promise.all([
      doRefresh(u.refreshToken),
      doRefresh(u.refreshToken),
      doRefresh(u.refreshToken),
    ]);

    for (const r of results) expect(r.status).toBe(200);
    const successors = new Set(results.map(r => r.body.refresh_token));
    expect(successors.size).toBe(1);
    expect(await totalTokenCount(u.userId)).toBe(2);
    expect(await activeTokenCount(u.userId)).toBe(1);

    const next = await doRefresh([...successors][0]);
    expect(next.status).toBe(200);
  });

  it('logged-out token stays a plain 401 without revoking other devices', async () => {
    const u = await newUser('rot_logout');
    const otherDevice = await loginSecondDevice(u.callsign);
    await request(app).post('/auth/logout').send({ refresh_token: u.refreshToken });

    expect((await doRefresh(u.refreshToken)).status).toBe(401);
    expect((await doRefresh(otherDevice)).status).toBe(200);
  });

  it('unknown token → 401', async () => {
    expect((await doRefresh('deadbeef'.repeat(8))).status).toBe(401);
  });
});
