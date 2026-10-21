/**
 * Integration test: MLS epoch concurrency (RFC 9750 §3 — exactly one Commit
 * per epoch). Two concurrent POSTs targeting the same group at the same epoch
 * must produce exactly one 202 and one 409 — the database transaction in
 * bumpGroupEpoch is the enforcement point.
 *
 * Requires: DB_DSN pointing to a test PostgreSQL instance with migrations applied.
 * Run: NODE_ENV=test DB_DSN=<test-dsn> npx vitest run
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app, pool, registerUser, cleanupUsers } from './helpers.js';

describe('MLS epoch concurrency', () => {
  let token: string;
  let userId: string;
  let friendId: string;
  const callsigns: string[] = [];

  beforeAll(async () => {
    const u1 = await registerUser('mls_a');
    const u2 = await registerUser('mls_b');
    token = u1.token;
    userId = u1.userId;
    friendId = u2.userId;
    callsigns.push(u1.callsign, u2.callsign);

    // Insert a confirmed friendship so the DM commit endpoint permits the call.
    // (Status 1 = accepted — see friendController.ts.)
    const [sortedA, sortedB] = [userId, friendId].sort();
    await pool.query(
      `INSERT INTO friendships (user_a_id, user_b_id, status, initiated_by)
       VALUES ($1, $2, 1, $1)
       ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
      [sortedA, sortedB],
    );
  });

  afterAll(async () => {
    await cleanupUsers(callsigns);
    const [sortedA2, sortedB2] = [userId, friendId].sort();
    await pool.query(
      'DELETE FROM friendships WHERE user_a_id = $1 AND user_b_id = $2',
      [sortedA2, sortedB2],
    );
    const convId = [userId, friendId].sort().join('-');
    await pool.query('DELETE FROM mls_groups WHERE group_id = $1', [convId]);
    await pool.query('DELETE FROM mls_commit_log WHERE group_id = $1', [convId]);
  });

  it('accepts exactly one commit at epoch 1 and rejects the concurrent duplicate with 409', async () => {
    const commitPayload = {
      epoch: 1,
      commit: Buffer.from('test-genesis-commit').toString('base64'),
    };

    // Fire both requests concurrently — race condition is the whole point.
    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/dm/${friendId}/mls/commit`)
        .set('Authorization', `Bearer ${token}`)
        .send(commitPayload),
      request(app)
        .post(`/dm/${friendId}/mls/commit`)
        .set('Authorization', `Bearer ${token}`)
        .send(commitPayload),
    ]);

    const statuses = [res1.status, res2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([202, 409]);
  });
});
