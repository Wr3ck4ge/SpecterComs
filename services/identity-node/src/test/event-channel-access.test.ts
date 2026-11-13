/**
 * LEADFREQ + EVMLS + frequency overlay phase 2: the (optional) Leadership
 * frequency and the event-channel access rule.
 *
 *  - A new event starts with NO frequency (command is optional); a planner adds
 *    a LEADERSHIP (is_leadership) net like any other frequency.
 *  - The planner's save keeps/sets is_leadership; a save that omits the field
 *    (a pre-2.0.0 client) doesn't clear it.
 *  - Launch creates no command channel (command_channel_id stays NULL); every
 *    frequency, the Leadership net included, gets its own hidden channel.
 *  - In-group role priority still reaches the ticket (priority_level), which
 *    is what media-rust's per-room ducking runs on.
 *  - A groups-only op (no frequencies at all) launches and works.
 *  - Access to an event channel = signed-up (accepted) members with access to
 *    that channel, plus the event's organisers (utils/eventChannelAccess):
 *      GET .../channels/:id/mls/members (what the client's MLS group follows),
 *      the voice ticket, channel commits/welcomes, event participants.
 *    Pending sign-ups and org members who didn't sign up are excluded.
 *
 * Requires: DB_DSN pointing to a test PostgreSQL instance with migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, pool, registerUser, cleanupUsers } from './helpers.js';

type U = { token: string; userId: string; callsign: string };

describe('Leadership frequency + event channel access', () => {
  let owner: U; // creates the org + event → event staff (creator)
  let lead: U; // accepted in "Squad Lead", which is on the Leadership net
  let rifle: U; // accepted in "Rifleman" (not on the Leadership net)
  let pending: U; // pending sign-up for "Squad Lead"
  let outsider: U; // org member, never signed up
  let orgId: string;
  let eventId: string;
  let leadFreqId: string;
  let groupId: string;
  let leadRoleId: string;
  let rifleRoleId: string;
  let orgChannelId: string;
  let leadChan: string;
  let groupChan: string;

  const auth = (u: U) => ({ Authorization: `Bearer ${u.token}` });

  beforeAll(async () => {
    [owner, lead, rifle, pending, outsider] = await Promise.all(
      ['lfown', 'lflead', 'lfrifle', 'lfpend', 'lfout'].map((s) => registerUser(s)),
    );
    const orgRes = await request(app).post('/orgs').set(auth(owner)).send({ callsign: `LF${Date.now()}`.slice(0, 30) });
    if (orgRes.status !== 201) throw new Error(`createOrg failed: ${orgRes.status} ${JSON.stringify(orgRes.body)}`);
    orgId = orgRes.body.org.id;
    for (const u of [lead, rifle, pending, outsider]) {
      await pool.query(
        `INSERT INTO org_members (org_id, user_id, role_id)
         SELECT $1, $2, id FROM org_roles WHERE org_id = $1 ORDER BY level ASC NULLS FIRST LIMIT 1`,
        [orgId, u.userId],
      );
    }
    const ch = await pool.query(`INSERT INTO channels (org_id, name) VALUES ($1, 'lf-general') RETURNING id`, [orgId]);
    orgChannelId = ch.rows[0].id;
  });

  afterAll(async () => {
    if (orgId) {
      await pool.query('DELETE FROM channels WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM events WHERE org_id = $1', [orgId]);
      await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    }
    await cleanupUsers([owner, lead, rifle, pending, outsider].filter(Boolean).map((u) => u.callsign));
  });

  it('a new event starts with no frequency (no leadership seeding)', async () => {
    const res = await request(app).post(`/orgs/${orgId}/events`).set(auth(owner))
      .send({ name: 'Op Leadfreq', start_time: new Date(Date.now() + 3600_000).toISOString() });
    expect(res.status).toBe(201);
    eventId = res.body.event.id;

    const g = await request(app).get(`/orgs/${orgId}/events/${eventId}/groups`).set(auth(owner));
    expect(g.status).toBe(200);
    expect(g.body.frequencies).toEqual([]);
  });

  it('save assigns roles to it and keeps the flag; a save without is_leadership does not clear it', async () => {
    const body = (withFlag: boolean) => ({
      groups: [{
        id: groupId || null, name: 'Alpha', max_members: 0, parent_index: null, linked_index: null, ships: [],
        roles: [
          { id: leadRoleId || null, name: 'Squad Lead', priority: 4, assignment_mode: 'open', max_slots: 1, is_commander: false, auto_approve: true },
          { id: rifleRoleId || null, name: 'Rifleman', priority: 3, assignment_mode: 'open', max_slots: 4, is_commander: false, auto_approve: true },
        ],
      }],
      frequencies: [{
        id: leadFreqId || null, name: 'LEADERSHIP', ...(withFlag ? { is_leadership: true } : {}),
        role_refs: [{ group_index: 0, role_index: 0 }],
      }],
    });
    const s1 = await request(app).put(`/orgs/${orgId}/events/${eventId}/groups`).set(auth(owner)).send(body(true));
    expect(s1.status).toBe(200);
    const g1 = await request(app).get(`/orgs/${orgId}/events/${eventId}/groups`).set(auth(owner));
    groupId = g1.body.groups[0].id;
    leadRoleId = g1.body.groups[0].roles.find((r: any) => r.name === 'Squad Lead').id;
    rifleRoleId = g1.body.groups[0].roles.find((r: any) => r.name === 'Rifleman').id;
    leadFreqId = g1.body.frequencies[0].id;
    expect(g1.body.frequencies).toHaveLength(1);
    expect(g1.body.frequencies[0]).toMatchObject({ name: 'LEADERSHIP', is_leadership: true, role_refs: [{ gi: 0, ri: 0 }] });

    const s2 = await request(app).put(`/orgs/${orgId}/events/${eventId}/groups`).set(auth(owner)).send(body(false));
    expect(s2.status).toBe(200);
    const g2 = await request(app).get(`/orgs/${orgId}/events/${eventId}/groups`).set(auth(owner));
    expect(g2.body.frequencies[0].is_leadership).toBe(true);
  });

  it('launch creates no command channel; the Leadership net gets its own hidden channel', async () => {
    const add = (u: U, roleId: string, status: string) => pool.query(
      `INSERT INTO event_group_members (group_id, user_id, role_id, status) VALUES ($1, $2, $3, $4)`,
      [groupId, u.userId, roleId, status],
    );
    await add(lead, leadRoleId, 'accepted');
    await add(rifle, rifleRoleId, 'accepted');
    await add(pending, leadRoleId, 'pending');

    const l = await request(app).post(`/orgs/${orgId}/events/${eventId}/launch`).set(auth(owner)).send({});
    expect(l.status).toBe(200);
    expect(l.body.command_channel_id).toBeNull();
    const ev = await pool.query(`SELECT launched, command_channel_id FROM events WHERE id = $1`, [eventId]);
    expect(ev.rows[0]).toMatchObject({ launched: true, command_channel_id: null });
    const f = await pool.query(
      `SELECT ef.channel_id, c.is_frequency, c.parent_channel_id FROM event_frequencies ef JOIN channels c ON c.id = ef.channel_id WHERE ef.id = $1`,
      [leadFreqId],
    );
    expect(f.rows[0].is_frequency).toBe(true);
    expect(f.rows[0].parent_channel_id).toBeNull();
    leadChan = f.rows[0].channel_id;
    groupChan = (await pool.query(`SELECT channel_id FROM event_groups WHERE id = $1`, [groupId])).rows[0].channel_id;
    const gc = await pool.query(`SELECT parent_channel_id FROM channels WHERE id = $1`, [groupChan]);
    expect(gc.rows[0].parent_channel_id).toBeNull();
    // Exactly the group channel + the frequency channel: nothing named COMMAND.
    const all = await pool.query(`SELECT id FROM channels WHERE event_id = $1`, [eventId]);
    expect(new Set(all.rows.map((r: any) => r.id))).toEqual(new Set([groupChan, leadChan]));
  });

  it('the op tree lists group channels only (no command, no frequency)', async () => {
    const t = await request(app).get(`/orgs/${orgId}/events/${eventId}/tree`).set(auth(owner));
    expect(t.status).toBe(200);
    expect(t.body.command_channel_id).toBeNull();
    expect(t.body.channels.map((c: any) => c.id)).toEqual([groupChan]);
    expect(t.body.channels[0]).toMatchObject({ tier: 0, is_command: false, parent_channel_id: null });
  });

  const members = async (chan: string, as: U = owner) => {
    const r = await request(app).get(`/orgs/${orgId}/channels/${chan}/mls/members`).set(auth(as));
    expect(r.status).toBe(200);
    return r.body as { scope: string; kind?: string; user_ids: string[] };
  };

  it('MLS members: Leadership net = leaders (its assigned roles\' accepted members) + organisers', async () => {
    // B6: only the channel's audience may read its list.
    const denied = await request(app).get(`/orgs/${orgId}/channels/${leadChan}/mls/members`).set(auth(outsider));
    expect(denied.status).toBe(403);
    const m = await members(leadChan, lead);
    expect(m.scope).toBe('event');
    expect(m.kind).toBe('frequency');
    expect(new Set(m.user_ids)).toEqual(new Set([lead.userId, owner.userId]));
  });

  it('MLS members: group channel = its accepted members + organisers; the Leadership net is not every participant', async () => {
    expect(new Set((await members(groupChan)).user_ids)).toEqual(new Set([lead.userId, rifle.userId, owner.userId]));
    expect((await members(leadChan)).user_ids).not.toContain(rifle.userId);
  });

  it('MLS members: a normal channel is still every org member', async () => {
    const m = await members(orgChannelId);
    expect(m.scope).toBe('org');
    for (const u of [owner, lead, rifle, pending, outsider]) expect(m.user_ids).toContain(u.userId);
  });

  it('an accepted sign-up is added and a departure removed (membership follows the roster)', async () => {
    await pool.query(`UPDATE event_group_members SET status = 'accepted' WHERE user_id = $1 AND group_id = $2`, [pending.userId, groupId]);
    expect((await members(leadChan)).user_ids).toContain(pending.userId);
    await pool.query(`DELETE FROM event_group_members WHERE user_id = $1 AND group_id = $2`, [pending.userId, groupId]);
    expect((await members(leadChan)).user_ids).not.toContain(pending.userId);
  });

  const voiceTicket = (u: U, chan: string) => request(app).post(`/orgs/${orgId}/media-ticket`).set(auth(u))
    .send({ channel_id: chan, kind: 'voice', client_version: '2.0.0' });

  it('voice tickets follow the same rule', async () => {
    expect((await voiceTicket(lead, leadChan)).status).toBe(200);
    expect((await voiceTicket(owner, leadChan)).status).toBe(200);
    expect((await voiceTicket(rifle, leadChan)).status).toBe(403);
    expect((await voiceTicket(outsider, leadChan)).status).toBe(403);
    expect((await voiceTicket(outsider, groupChan)).status).toBe(403); // even though the event is 'open'
    expect((await voiceTicket(rifle, groupChan)).status).toBe(200);
    expect((await voiceTicket(owner, groupChan)).status).toBe(200); // OPTREE: organisers may join any event channel
  });

  // The ticket's priority_level is media-rust's scale (1,2 = priority
  // speakers). media-rust ducks the speaker's OWN room on it (in-group role
  // ducking); phase 2 only removed the cross-channel cascade.
  const ticketClaims = (body: any) => JSON.parse(Buffer.from(String(body.ticket).split('.')[1], 'base64url').toString('utf8'));

  it('in-group role priority still reaches the ticket (drives per-room ducking)', async () => {
    const leadT = await voiceTicket(lead, groupChan);
    const rifleT = await voiceTicket(rifle, groupChan);
    expect(leadT.status).toBe(200);
    expect(rifleT.status).toBe(200);
    // Squad Lead priority 4 -> level 2 (priority speaker); Rifleman 3 -> level 3.
    expect(ticketClaims(leadT.body)).toMatchObject({ is_priority_channel: true, priority_level: 2 });
    expect(ticketClaims(rifleT.body)).toMatchObject({ is_priority_channel: true, priority_level: 3 });
  });

  // Phase 3, Mission Wide: the room id is the event id. No commander → none.
  it('Mission Wide: no commander → no room; commander TX, participant RX-only, non-participant denied', async () => {
    expect((await voiceTicket(rifle, eventId)).status).toBe(403);
    await pool.query(`UPDATE events SET commander_user_id = $1 WHERE id = $2`, [lead.userId, eventId]);
    try {
      const cmd = await voiceTicket(lead, eventId);
      expect(cmd.status).toBe(200);
      expect(cmd.body).toMatchObject({ mission_wide: true, listen_only: false });
      expect(ticketClaims(cmd.body)).toMatchObject({ channel_id: eventId, listen_only: false });
      const rx = await voiceTicket(rifle, eventId);
      expect(rx.status).toBe(200);
      expect(ticketClaims(rx.body)).toMatchObject({ channel_id: eventId, listen_only: true });
      expect((await voiceTicket(outsider, eventId)).status).toBe(403);
      expect((await voiceTicket(pending, eventId)).status).toBe(403);
      const video = await request(app).post(`/orgs/${orgId}/media-ticket`).set(auth(lead))
        .send({ channel_id: eventId, kind: 'video_publish' });
      expect(video.status).toBe(403);
      const mine = await request(app).get(`/orgs/${orgId}/events/${eventId}/my-assignment`).set(auth(rifle));
      expect(mine.body.mission_wide).toMatchObject({ room_id: eventId, can_transmit: false });
    } finally {
      await pool.query(`UPDATE events SET commander_user_id = NULL WHERE id = $1`, [eventId]);
    }
  });

  it('channel commits: outsiders can\'t commit, and nobody can welcome an outsider', async () => {
    const commit = (u: U, welcomed: string[]) => request(app).post(`/orgs/${orgId}/channels/${leadChan}/mls/commit`).set(auth(u))
      .send({ epoch: 1, commit: 'AAAA', welcome: welcomed.length ? 'AAAA' : null, welcomed_user_ids: welcomed });
    expect((await commit(outsider, [])).status).toBe(403);
    expect((await commit(lead, [rifle.userId])).status).toBe(403);
    expect((await commit(lead, [owner.userId])).status).toBe(202);
  });

  it('event participants (cascade group) = accepted participants + staff', async () => {
    const r = await request(app).get(`/orgs/${orgId}/events/${eventId}/participants`).set(auth(lead));
    expect(r.status).toBe(200);
    expect(new Set(r.body.participants.map((p: any) => p.user_id))).toEqual(new Set([lead.userId, rifle.userId, owner.userId]));
  });

  it('my-assignment marks the Leadership frequency for its members', async () => {
    const r = await request(app).get(`/orgs/${orgId}/events/${eventId}/my-assignment`).set(auth(lead));
    expect(r.status).toBe(200);
    // No synthetic COMMAND entry: just the planner's Leadership net.
    expect(r.body.assignment.frequencies).toEqual([expect.objectContaining({ id: leadFreqId, channel_id: leadChan, is_leadership: true })]);
    expect(r.body.assignment.frequencies[0].is_command).toBeUndefined();
    expect(r.body.command).toBeNull();
    const r2 = await request(app).get(`/orgs/${orgId}/events/${eventId}/my-assignment`).set(auth(rifle));
    expect(r2.body.assignment.frequencies).toEqual([]);
  });

  it('a frequency added after launch gets its channel', async () => {
    const res = await request(app).put(`/orgs/${orgId}/events/${eventId}/groups`).set(auth(owner)).send({
      groups: [{
        id: groupId, name: 'Alpha', max_members: 0, parent_index: null, linked_index: null, ships: [],
        roles: [
          { id: leadRoleId, name: 'Squad Lead', priority: 4, assignment_mode: 'open', max_slots: 1 },
          { id: rifleRoleId, name: 'Rifleman', priority: 3, assignment_mode: 'open', max_slots: 4 },
        ],
      }],
      frequencies: [
        { id: leadFreqId, name: 'LEADERSHIP', is_leadership: true, role_refs: [{ group_index: 0, role_index: 0 }] },
        { id: null, name: 'LOGISTICS', role_refs: [{ group_index: 0, role_index: 1 }] },
      ],
    });
    expect(res.status).toBe(200);
    const f = await pool.query(`SELECT channel_id, is_leadership FROM event_frequencies WHERE event_id = $1 AND name = 'LOGISTICS'`, [eventId]);
    expect(f.rows[0].channel_id).toBeTruthy();
    expect(f.rows[0].is_leadership).toBe(false);
    expect(new Set((await members(f.rows[0].channel_id)).user_ids)).toEqual(new Set([rifle.userId, owner.userId]));
  });

  it('a groups-only op (no frequencies at all) launches and works', async () => {
    const res = await request(app).post(`/orgs/${orgId}/events`).set(auth(owner))
      .send({ name: 'Op Groups Only', start_time: new Date(Date.now() + 3600_000).toISOString() });
    expect(res.status).toBe(201);
    const evId = res.body.event.id;
    const s = await request(app).put(`/orgs/${orgId}/events/${evId}/groups`).set(auth(owner)).send({
      groups: [
        { id: null, name: 'Bravo', max_members: 0, parent_index: null, linked_index: null, ships: [],
          roles: [{ id: null, name: 'Pilot', priority: 3, assignment_mode: 'open', max_slots: 2 }] },
        { id: null, name: 'Bravo-1', max_members: 0, parent_index: 0, linked_index: null, ships: [],
          roles: [{ id: null, name: 'Gunner', priority: 3, assignment_mode: 'open', max_slots: 2 }] },
      ],
      frequencies: [],
    });
    expect(s.status).toBe(200);
    const g = await request(app).get(`/orgs/${orgId}/events/${evId}/groups`).set(auth(owner));
    const bravo = g.body.groups.find((x: any) => x.name === 'Bravo');
    await pool.query(
      `INSERT INTO event_group_members (group_id, user_id, role_id, status) VALUES ($1, $2, $3, 'accepted')`,
      [bravo.id, rifle.userId, bravo.roles[0].id],
    );
    const l = await request(app).post(`/orgs/${orgId}/events/${evId}/launch`).set(auth(owner)).send({});
    expect(l.status).toBe(200);
    expect(l.body.command_channel_id).toBeNull();
    const chans = await pool.query(`SELECT id, COALESCE(is_frequency, false) AS f FROM channels WHERE event_id = $1`, [evId]);
    expect(chans.rows).toHaveLength(2);
    expect(chans.rows.every((c: any) => c.f === false)).toBe(true);
    const t = await request(app).get(`/orgs/${orgId}/events/${evId}/tree`).set(auth(owner));
    expect(t.status).toBe(200);
    expect(t.body.channels.map((c: any) => c.tier).sort()).toEqual([0, 1]); // sub-group under its parent group
    const r = await request(app).get(`/orgs/${orgId}/events/${evId}/my-assignment`).set(auth(rifle));
    expect(r.status).toBe(200);
    expect(r.body.frequencies).toEqual([]);
    expect(r.body.command).toBeNull();
  });
});
