/**
 * Shared test helpers for identity-node integration tests.
 *
 * Usage:
 *   import { getApp, cleanup } from './helpers.js';
 *
 * Tests must set DB_DSN and NODE_ENV=test before the first import of index.ts
 * (achieved via the vitest.config.ts `env` block or a .env.test file).
 */
import request from 'supertest';
import { app } from '../index.js';
import { pool } from '../config/db.js';

export { app, pool };

export const agent = () => request(app);

/** Register a throw-away user and return { token, refreshToken, userId }. */
export async function registerUser(suffix: string): Promise<{
  token: string;
  refreshToken: string;
  userId: string;
  callsign: string;
  email: string;
}> {
  const callsign = `test_${suffix}_${Date.now()}`;
  const email = `${callsign}@test.invalid`;
  const res = await request(app)
    .post('/auth/register')
    .send({ callsign, email, password: 'TestPass_1!' });
  if (res.status !== 201) {
    throw new Error(`registerUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.token,
    refreshToken: res.body.refresh_token,
    userId: res.body.user.id,
    callsign,
    email,
  };
}

/** Delete all rows created by a test by callsign list. */
export async function cleanupUsers(callsigns: string[]): Promise<void> {
  if (!callsigns.length) return;
  await pool.query(
    `DELETE FROM users WHERE callsign = ANY($1::text[])`,
    [callsigns],
  );
}

export async function cleanupHwidBan(hwid: string): Promise<void> {
  await pool.query('DELETE FROM hardware_bans WHERE hwid = $1', [hwid]);
}
