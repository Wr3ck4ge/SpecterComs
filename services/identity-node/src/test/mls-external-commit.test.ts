/**
 * MR1: GroupInfo storage, external commits and device-status diagnostics.
 *
 *  - Every commit can carry group_info, stored atomically with the epoch
 *    bump; a commit without one leaves it stale, and stale is never served.
 *  - PUT group-info re-uploads for the CURRENT epoch only.
 *  - POST external-commit: same one-commit-per-epoch rule and mls_commit_log
 *    entry as a regular commit; published as the usual flat mls_commit.
 *  - Access = the group's member list (DM friendship; org membership; an
 *    event channel's audience; the event cascade group's participants+staff).
 *
 * Requires: DB_DSN pointing to a test PostgreSQL instance with migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';

const published: { subject: string; data: any }[] = [];
vi.mock('../config/nats.js', () => ({
  publishEvent: async (subject: string, data: any) => { published.push({ subject, data }); },
  connectNats: async () => null,
}));

const { app, pool, registerUser, cleanupUsers } = await import('./helpers.js');

type U = { token: string; userId: string; callsign: string };
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('MLS GroupInfo + external commits', () => {
  let a: U; let b: U; let c: U;
  let orgId: string; let orgChan: string; let eventId: string; let eventChan: string;
  const auth = (u: U) => ({ Authorization: `Bearer ${u.token}` });
  const convId = () => [a.userId, b.userId].sort().join('-');

  beforeAll(async () => {
    [a, b, c] = await Promise.all(['mlsxa', 'mlsxb', 'mlsxc'].map((s) => registerUser(s)));
    const [x, y] = [a.userId, b.userId].sort();
    await pool.query(
      `INSERT INTO friendships (user_a_id, user_b_id, status, initiated_by) VALUES ($1, $2, 1, $1) ON CONFLICT DO NOTHING`,
      [x, y],
    );
    const orgRes = await request(app).post('/orgs').set(auth(a)).send({ callsign: `MX${Date.now()}`.slice(0, 30) });
    if (orgRes.status !== 201) throw new Error(`createOrg failed: ${orgRes.status} ${JSON.stringify(orgRes.body)}`);
    orgId = orgRes.body.org.id;
    await pool.query(
      `INSERT INTO org_members (org_id, user_id, role_id)
       SELECT $1, $2, id FROM org_roles WHERE org_id = $1 ORDER BY level ASC NULLS FIRST LIMIT 1`,
      [orgId, b.userId],
    );
    orgChan = (await pool.query(`INSERT INTO channels (org_id, name) VALUES ($1, 'mx-general') RETURNING id`, [orgId])).rows[0].id;
    const ev = await request(app).post(`/orgs/${orgId}/events`).set(auth(a))
      .send({ name: 'Op MX', start_time: new Date(Date.now() + 3600_000).toISOString() });
    if (ev.status !== 201) throw new Error(`createEvent failed: ${ev.status}`);
    eventId = ev.body.event.id;
    // An event channel of kind 'other': audience = participants + staff (a is the creator).
    eventChan = (await pool.query(
      `INSERT INTO channels (org_id, name, event_id) VALUES ($1, 'mx-debrief', $2) RETURNING id`, [orgId, eventId],
    )).rows[0].id;
  });

  afterAll(async () => {
    const groups = [convId(), orgChan, eventChan, eventId].filter(Boolean);
    await pool.query('DELETE FROM mls_groups WHERE group_id = ANY($1::text[])', [groups]);
    await pool.query('DELETE FROM mls_commit_log WHERE group_id = ANY($1::text[])', [groups]);
    const [x, y] = [a.userId, b.userId].sort();
    await pool.query('DELETE FROM friendships WHERE user_a_id = $1 AND user_b_id = $2', [x, y]);
    if (orgId) {
      await pool.query('DELETE FROM channels WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM events WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await cleanupUsers([a, b, c].filter(Boolean).map((u) => u.callsign));
  });

  it('DM: group-info lifecycle (absent → stored with commit → stale → re-uploaded)', async () => {
    const gi = (u: U) => request(app).get(`/dm/${u === a ? b.userId : a.userId}/mls/group-info`).set(auth(u));
    let r = await gi(a);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ exists: false, epoch: 0, group_info: null });

    r = await request(app).post(`/dm/${b.userId}/mls/commit`).set(auth(a))
      .send({ epoch: 1, commit: b64('c1'), welcome: b64('w1'), group_info: b64('gi1') });
    expect(r.status).toBe(202);
    r = await gi(b);
    expect(r.body).toMatchObject({ exists: true, epoch: 1, group_info: b64('gi1'), group_info_epoch: 1 });

    // An older client's commit (no group_info) → the stored one is stale, not served.
    r = await request(app).post(`/dm/${b.userId}/mls/commit`).set(auth(a)).send({ epoch: 2, commit: b64('c2') });
    expect(r.status).toBe(202);
    r = await gi(a);
    expect(r.body).toMatchObject({ exists: true, epoch: 2, group_info: null, group_info_epoch: 1 });

    // Re-upload: only for the current epoch.
    r = await request(app).put(`/dm/${b.userId}/mls/group-info`).set(auth(a)).send({ epoch: 1, group_info: b64('old') });
    expect(r.status).toBe(409);
    r = await request(app).put(`/dm/${b.userId}/mls/group-info`).set(auth(a)).send({ epoch: 2, group_info: b64('gi2') });
    expect(r.status).toBe(200);
    r = await gi(b);
    expect(r.body).toMatchObject({ epoch: 2, group_info: b64('gi2'), group_info_epoch: 2 });

    const cu = await request(app).get(`/dm/${a.userId}/mls/catch-up`).set(auth(b));
    expect(cu.body).toMatchObject({ current_epoch: 2, group_info_epoch: 2 });
  });

  it('DM: external commit is ordered, logged, stored and published flat', async () => {
    published.length = 0;
    const ext = (epoch: number, tag: string) => request(app).post(`/dm/${a.userId}/mls/external-commit`).set(auth(b))
      .send({ epoch, commit: b64(tag), group_info: b64(`gi-${tag}`) });
    expect((await ext(2, 'stale')).status).toBe(409); // targets an epoch that's already taken
    const [r1, r2] = await Promise.all([ext(3, 'x1'), ext(3, 'x2')]);
    expect([r1.status, r2.status].sort()).toEqual([202, 409]);

    const winner = r1.status === 202 ? 'x1' : 'x2';
    const cu = await request(app).get(`/dm/${b.userId}/mls/catch-up`).set(auth(a));
    expect(cu.body.current_epoch).toBe(3);
    expect(cu.body.commits.find((x: any) => x.epoch === 3).commit).toBe(b64(winner));
    const gi = await request(app).get(`/dm/${b.userId}/mls/group-info`).set(auth(a));
    expect(gi.body).toMatchObject({ epoch: 3, group_info: b64(`gi-${winner}`) });

    const events = published.filter((p) => p.data.type === 'mls_commit');
    expect(events.map((e) => e.subject).sort()).toEqual([`specter.event.user.${a.userId}`, `specter.event.user.${b.userId}`].sort());
    for (const e of events) expect(e.data).toEqual({ type: 'mls_commit', conversation_id: convId(), commit: b64(winner) });
  });

  it('DM: non-friends get nothing', async () => {
    expect((await request(app).get(`/dm/${a.userId}/mls/group-info`).set(auth(c))).status).toBe(403);
    expect((await request(app).post(`/dm/${a.userId}/mls/external-commit`).set(auth(c))
      .send({ epoch: 4, commit: b64('evil') })).status).toBe(403);
    expect((await request(app).put(`/dm/${a.userId}/mls/group-info`).set(auth(c))
      .send({ epoch: 3, group_info: b64('evil') })).status).toBe(403);
  });

  it('org channel: members only; external commit relayed on the channel subject', async () => {
    const base = `/orgs/${orgId}/channels/${orgChan}/mls`;
    expect((await request(app).get(`${base}/group-info`).set(auth(c))).status).toBe(403);
    let r = await request(app).post(`${base}/commit`).set(auth(a)).send({ epoch: 1, commit: b64('g'), group_info: b64('cgi1') });
    expect(r.status).toBe(202);
    r = await request(app).get(`${base}/group-info`).set(auth(b));
    expect(r.body).toMatchObject({ exists: true, epoch: 1, group_info: b64('cgi1') });
    published.length = 0;
    r = await request(app).post(`${base}/external-commit`).set(auth(b)).send({ epoch: 2, commit: b64('bj'), group_info: b64('cgi2') });
    expect(r.status).toBe(202);
    expect(published).toEqual([{ subject: `specter.msg.channel.${orgChan}`, data: { type: 'mls_commit', channel_id: orgChan, commit: b64('bj') } }]);
    expect((await request(app).post(`${base}/external-commit`).set(auth(c)).send({ epoch: 3, commit: b64('x') })).status).toBe(403);
  });

  it('event channel: only its audience (org members who did not sign up are refused)', async () => {
    const base = `/orgs/${orgId}/channels/${eventChan}/mls`;
    expect((await request(app).get(`${base}/group-info`).set(auth(a))).status).toBe(200); // staff
    expect((await request(app).get(`${base}/group-info`).set(auth(b))).status).toBe(403); // org member, not signed up
    expect((await request(app).post(`${base}/external-commit`).set(auth(b)).send({ epoch: 1, commit: b64('x') })).status).toBe(403);
  });

  it('event cascade group: participants + staff', async () => {
    const base = `/orgs/${orgId}/events/${eventId}/mls`;
    let r = await request(app).post(`${base}/commit`).set(auth(a)).send({ epoch: 1, commit: b64('e1'), group_info: b64('egi1') });
    expect(r.status).toBe(202);
    r = await request(app).get(`${base}/group-info`).set(auth(a));
    expect(r.body).toMatchObject({ epoch: 1, group_info: b64('egi1') });
    expect((await request(app).get(`${base}/group-info`).set(auth(b))).status).toBe(403);
    published.length = 0;
    r = await request(app).post(`${base}/external-commit`).set(auth(a)).send({ epoch: 2, commit: b64('e2') });
    expect(r.status).toBe(202);
    expect(published.every((p) => p.data.type === 'mls_commit' && p.data.event_group_id === eventId)).toBe(true);
    // No group_info with it → stale now.
    r = await request(app).get(`${base}/group-info`).set(auth(a));
    expect(r.body).toMatchObject({ epoch: 2, group_info: null, group_info_epoch: 1 });
  });

  it('device-status upserts diagnostics for the caller only', async () => {
    const send = (groups: any[]) => request(app).post('/mls/device-status').set(auth(a)).send({ device_id: 'dev-a', groups });
    expect((await send([{ group_id: orgChan, epoch: 1, status: 'ok' }])).status).toBe(200);
    expect((await send([{ group_id: orgChan, epoch: 2, status: 'resynced' }, { group_id: 'x', epoch: null }])).status).toBe(200);
    const rows = await pool.query('SELECT group_id, epoch, status FROM mls_device_epochs WHERE user_id = $1 ORDER BY group_id', [a.userId]);
    expect(rows.rows.find((x: any) => x.group_id === orgChan)).toMatchObject({ epoch: '2', status: 'resynced' });
    expect(rows.rows.find((x: any) => x.group_id === 'x')).toMatchObject({ epoch: null });
    expect((await request(app).post('/mls/device-status').send({ device_id: 'd', groups: [] })).status).toBe(401);
    expect((await send([{ group_id: '', epoch: 1 }])).status).toBe(400);
  });
});
