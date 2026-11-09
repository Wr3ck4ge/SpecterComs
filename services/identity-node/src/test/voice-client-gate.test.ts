/**
 * E2EV: voice is end-to-end encrypted relay voice only (2.0.0+).
 *
 *  - voiceClientGate's version parsing/comparison (pure).
 *  - POST /orgs/:id/media-ticket kind=voice: refused with 426 +
 *    CLIENT_UPGRADE_REQUIRED (and a message old clients can show verbatim)
 *    when client_version is missing or below the minimum; issued for >= 2.0.0
 *    with voice_relay=true and a signed client_version claim — even when the
 *    channel's voice_relay_mode column says false.
 *  - Video tickets don't need client_version.
 *
 * Requires: DB_DSN pointing to a test PostgreSQL instance with migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app, pool, registerUser, cleanupUsers } from './helpers.js';
import {
  parseClientVersion, meetsVoiceMinimum, upgradeRequiredBody, CLIENT_UPGRADE_REQUIRED,
} from '../utils/voiceClientGate.js';

describe('voiceClientGate (pure)', () => {
  it('parses MAJOR.MINOR.PATCH with optional v and suffix', () => {
    expect(parseClientVersion('2.0.0')).toEqual([2, 0, 0]);
    expect(parseClientVersion('v2.3.4-beta.1')).toEqual([2, 3, 4]);
    expect(parseClientVersion('1.10.46+build7')).toEqual([1, 10, 46]);
    expect(parseClientVersion('2.0')).toBeNull();
    expect(parseClientVersion('')).toBeNull();
    expect(parseClientVersion(undefined)).toBeNull();
    expect(parseClientVersion(200)).toBeNull();
  });

  it('compares numerically, not lexically', () => {
    expect(meetsVoiceMinimum('2.0.0', '2.0.0')).toBe(true);
    expect(meetsVoiceMinimum('10.0.0', '2.0.0')).toBe(true);
    expect(meetsVoiceMinimum('2.0.10', '2.0.9')).toBe(true);
    expect(meetsVoiceMinimum('1.10.46', '2.0.0')).toBe(false);
    expect(meetsVoiceMinimum('1.99.99', '2.0.0')).toBe(false);
    expect(meetsVoiceMinimum(undefined, '2.0.0')).toBe(false);
    expect(meetsVoiceMinimum('nonsense', '2.0.0')).toBe(false);
  });

  it('refusal message carries the whole instruction for old clients', () => {
    const body = upgradeRequiredBody('2.0.0');
    expect(body.code).toBe(CLIENT_UPGRADE_REQUIRED);
    expect(body.message).toContain('Update SpecterComs to v2.0.0 to use voice');
  });
});

describe('POST /orgs/:id/media-ticket — voice version gate', () => {
  let token: string;
  let userId: string;
  let callsign: string;
  let orgId: string;
  let channelId: string;

  beforeAll(async () => {
    const u = await registerUser('e2ev');
    token = u.token;
    userId = u.userId;
    callsign = u.callsign;
    const orgRes = await request(app)
      .post('/orgs')
      .set('Authorization', `Bearer ${token}`)
      .send({ callsign: `E2EV${Date.now()}`.slice(0, 30) });
    if (orgRes.status !== 201) throw new Error(`createOrg failed: ${orgRes.status} ${JSON.stringify(orgRes.body)}`);
    orgId = orgRes.body.org.id;
    // A channel whose legacy column still says "mixed": must not matter.
    const ch = await pool.query(
      `INSERT INTO channels (org_id, name, voice_relay_mode) VALUES ($1, 'e2ev-test', FALSE) RETURNING id`,
      [orgId],
    );
    channelId = ch.rows[0].id;
  });

  afterAll(async () => {
    if (orgId) await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await cleanupUsers([callsign]);
  });

  const ticket = (body: Record<string, unknown>) => request(app)
    .post(`/orgs/${orgId}/media-ticket`)
    .set('Authorization', `Bearer ${token}`)
    .send({ channel_id: channelId, ...body });

  it('refuses a voice ticket without client_version (every pre-2.0.0 client)', async () => {
    const res = await ticket({ kind: 'voice' });
    expect(res.status).toBe(426);
    expect(res.body.code).toBe(CLIENT_UPGRADE_REQUIRED);
    expect(res.body.message).toContain('Update SpecterComs to v2.0.0 to use voice');
    expect(res.body.ticket).toBeUndefined();
  });

  it('refuses a voice ticket for a client below the minimum', async () => {
    const res = await ticket({ kind: 'voice', client_version: '1.10.46' });
    expect(res.status).toBe(426);
    expect(res.body.code).toBe(CLIENT_UPGRADE_REQUIRED);
  });

  it('issues a relay voice ticket with a signed client_version for >= 2.0.0, regardless of the column', async () => {
    const res = await ticket({ kind: 'voice', client_version: '2.0.0' });
    expect(res.status).toBe(200);
    expect(res.body.voice_relay).toBe(true);
    const claims = jwt.decode(res.body.ticket) as Record<string, unknown>;
    expect(claims.purpose).toBe('media_voice');
    expect(claims.voice_relay).toBe(true);
    expect(claims.client_version).toBe('2.0.0');
    expect(claims.channel_id).toBe(channelId);
    expect(claims.sub).toBe(userId);
  });

  it('does not gate video tickets', async () => {
    const res = await ticket({ kind: 'video_publish' });
    expect(res.status).toBe(200);
    const claims = jwt.decode(res.body.ticket) as Record<string, unknown>;
    expect(claims.purpose).toBe('media_video');
    expect(claims.client_version).toBeUndefined();
  });
});
