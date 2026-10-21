/**
 * Integration test: refresh token rotation — each token is single-use.
 * Using a token once issues a new token and revokes the old one (revoked_at
 * is set in the DB). A second use of the original token must return 401.
 *
 * This guards against a regression where revocation isn't persisted, which
 * would allow an attacker who stole a refresh token to use it indefinitely
 * even after the legitimate owner had already rotated past it.
 *
 * Requires: DB_DSN pointing to a test PostgreSQL instance with migrations applied.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import { app, pool, registerUser, cleanupUsers } from './helpers.js';

describe('Refresh token rotation', () => {
  let initialRefreshToken: string;
  const callsigns: string[] = [];

  beforeAll(async () => {
    const user = await registerUser('refresh_rot');
    initialRefreshToken = user.refreshToken;
    callsigns.push(user.callsign);
  });

  afterAll(async () => {
    await cleanupUsers(callsigns);
  });

  it('accepts the initial refresh token and returns a new token pair', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refresh_token: initialRefreshToken });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('refresh_token');
    // New token must differ from the one we just consumed
    expect(res.body.refresh_token).not.toBe(initialRefreshToken);
  });

  it('rejects a second use of the already-rotated refresh token with 401', async () => {
    const res = await request(app)
      .post('/auth/refresh')
      .send({ refresh_token: initialRefreshToken });

    expect(res.status).toBe(401);
  });
});
