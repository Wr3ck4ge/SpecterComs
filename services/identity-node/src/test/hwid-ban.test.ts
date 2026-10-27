/**
 * Integration test: HWID ban is checked inside the registration transaction,
 * so a banned device must receive 403 AND leave no user row behind.
 *
 * The transactionality guarantee: authController.register opens a transaction,
 * checks hardware_bans, and ROLLBACKs before inserting the user if banned.
 * This test verifies that the DB is consistent (no partial user row) after a
 * banned registration attempt — a regression guard against accidentally moving
 * the ban check outside the transaction.
 *
 * Requires: DB_DSN pointing to a test PostgreSQL instance with migrations applied.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app, pool, cleanupHwidBan } from './helpers.js';

const TEST_HWID = `test-hwid-ban-${Date.now()}`;
const TEST_CALLSIGN = `banned_user_${Date.now()}`;
const TEST_EMAIL = `${TEST_CALLSIGN}@test.invalid`;

describe('HWID ban transactionality', () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO hardware_bans (hwid, reason) VALUES ($1, 'integration test ban')
       ON CONFLICT (hwid) DO NOTHING`,
      [TEST_HWID],
    );
  });

  afterAll(async () => {
    await cleanupHwidBan(TEST_HWID);
    // User row should not exist, but clean up defensively in case the test fails
    await pool.query('DELETE FROM users WHERE callsign = $1', [TEST_CALLSIGN]);
  });

  it('returns 403 for registration with a banned HWID', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({
        callsign: TEST_CALLSIGN,
        email: TEST_EMAIL,
        password: 'TestPass_1!',
        hwid: TEST_HWID,
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/banned/i);
  });

  it('leaves no user row in the database after the rejected registration', async () => {
    const check = await pool.query(
      'SELECT id FROM users WHERE callsign = $1',
      [TEST_CALLSIGN],
    );
    expect(check.rows).toHaveLength(0);
  });
});
