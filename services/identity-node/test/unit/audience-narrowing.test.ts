/**
 * B3 (S1): when a channel's audience narrows, its remaining members get
 * channel_audience_narrowed (their clients re-key the MLS group). Widening or
 * a no-op sends nothing; the removed user never gets it. Pure diff plus the
 * real controllers against PGlite.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const holder = vi.hoisted(() => ({
  db: null as any,
  published: [] as { subject: string; data: any }[],
  revoked: [] as { userId: string; channelIds: string[] }[], // B5
}));
vi.mock('../../src/controllers/sseController.js', () => ({
  revokeChannelSubscriptions: (userId: string, channelIds: Iterable<string>) => {
    holder.revoked.push({ userId, channelIds: [...channelIds].sort() });
    return 1;
  },
}));
vi.mock('../../src/config/db.js', () => {
  const query = async (text: string, params: unknown[] = []) => {
    const r = await holder.db.query(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  return { pool: { query, connect: async () => ({ query, release: () => {} }) }, query };
});
vi.mock('../../src/config/nats.js', () => ({
  publishEvent: async (subject: string, data: any) => { holder.published.push({ subject, data }); },
  connectNats: async () => null,
  getNatsConnection: () => null,
}));

const { narrowedChannels, removedByUser } = await import('../../src/utils/audienceNarrowing.js');
const mls = await import('../../src/controllers/mlsGroupController.js');
const { validateEvent } = await import('../../../../shared/events/schema.js');
const mod = await import('../../src/controllers/modController.js');
const roles = await import('../../src/controllers/roleController.js');
const chans = await import('../../src/controllers/channelController.js');

const S = (...ids: string[]) => new Set(ids);

describe('narrowedChannels (pure)', () => {
  it('a lost member → the channel, with who remains', () => {
    const before = new Map([['c1', S('a', 'b', 'c')]]);
    const after = new Map([['c1', S('a', 'c')]]);
    expect(narrowedChannels(before, after)).toEqual([{ channelId: 'c1', remaining: ['a', 'c'], removed: ['b'] }]);
  });
  it('widening or no change → nothing', () => {
    expect(narrowedChannels(new Map([['c1', S('a')]]), new Map([['c1', S('a', 'b')]]))).toEqual([]);
    expect(narrowedChannels(new Map([['c1', S('a', 'b')]]), new Map([['c1', S('b', 'a')]]))).toEqual([]);
  });
  it('a swap (one in, one out) is still a narrowing; the newcomer is told too', () => {
    expect(narrowedChannels(new Map([['c1', S('a', 'b')]]), new Map([['c1', S('a', 'n')]])))
      .toEqual([{ channelId: 'c1', remaining: ['a', 'n'], removed: ['b'] }]);
  });
  it('a channel gone afterwards (deleted / op ended) is skipped; only narrowed channels listed', () => {
    const before = new Map([['gone', S('a', 'b')], ['same', S('a')], ['less', S('a', 'b')]]);
    const after = new Map([['same', S('a')], ['less', S('b')]]);
    expect(narrowedChannels(before, after)).toEqual([{ channelId: 'less', remaining: ['b'], removed: ['a'] }]);
  });
  it('removedByUser groups the lost channels per removed user (B5)', () => {
    expect(removedByUser([
      { channelId: 'c1', remaining: ['a'], removed: ['b', 'c'] },
      { channelId: 'c2', remaining: [], removed: ['b'] },
    ])).toEqual(new Map([['b', ['c1', 'c2']], ['c', ['c1']]]));
  });
});

// ── Against the real SQL ────────────────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), callsign TEXT, profile_image_path TEXT);
  CREATE TABLE organizations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID, callsign TEXT, default_role_id UUID);
  CREATE TABLE org_invites (code TEXT PRIMARY KEY, org_id UUID, assigned_role_id UUID);
  CREATE TABLE org_roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID, name TEXT, permissions JSONB DEFAULT '{}', level INT NOT NULL DEFAULT 0);
  CREATE TABLE org_members (org_id UUID, user_id UUID, role_id UUID, joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (org_id, user_id));
  CREATE TABLE org_bans (org_id UUID, user_id UUID, reason TEXT, expires_at TIMESTAMPTZ);
  CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID, event_id UUID, name TEXT,
    type INT DEFAULT 0, channel_kind INT DEFAULT 0, min_tier INT DEFAULT 0, ducking_level REAL DEFAULT 0,
    is_frequency BOOLEAN NOT NULL DEFAULT FALSE, visible_min_level INT NOT NULL DEFAULT 0, is_adult BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT clock_timestamp()
  );
  CREATE TABLE events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID, creator_id UUID, commander_user_id UUID,
    launched BOOLEAN DEFAULT FALSE, ended_at TIMESTAMPTZ, command_channel_id UUID);
  CREATE TABLE event_planners (event_id UUID, user_id UUID);
  CREATE TABLE channel_subscriptions (channel_id UUID, user_id UUID, org_id UUID, joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (user_id, org_id));
  CREATE TABLE event_groups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_id UUID, channel_id UUID);
  CREATE TABLE event_group_roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), is_commander BOOLEAN DEFAULT FALSE);
  CREATE TABLE event_group_members (group_id UUID, user_id UUID, role_id UUID, status TEXT);
  CREATE TABLE event_frequencies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_id UUID, channel_id UUID, is_leadership BOOLEAN DEFAULT FALSE);
  CREATE TABLE event_frequency_members (frequency_id UUID, user_id UUID);
  CREATE TABLE event_frequency_roles (frequency_id UUID, role_id UUID);
`;
const q = (text: string, params: unknown[] = []) => holder.db.query(text, params).then((r: any) => r.rows);

function call(handler: (req: any, res: any) => any, userId: string, params: Record<string, string>, body: any = {}) {
  let status = 200; let json: any;
  const res: any = { status(s: number) { status = s; return res; }, json(b: unknown) { json = b; return res; } };
  return Promise.resolve(handler({ user: { id: userId, callsign: 'x' }, params, body }, res)).then(() => ({ status, body: json }));
}

const ids: Record<string, string> = {};
const role: Record<string, string> = {};
let orgId: string;
let general: string;
let officers: string;
let debrief: string; // a live op's "other" channel: participants ∪ organisers
let alpha: string; // a live op's group channel: its accepted members only

const narrowed = () => holder.published.filter((p) => p.data.type === 'channel_audience_narrowed');
/** channelId → the user ids it was sent to. */
const sentTo = () => {
  const m = new Map<string, Set<string>>();
  for (const p of narrowed()) {
    expect(validateEvent(p.data, p.subject)).toEqual([]);
    expect(p.data.orgId).toBe(orgId);
    const uid = p.subject.split('.').pop()!;
    if (!m.has(p.data.channelId)) m.set(p.data.channelId, new Set());
    m.get(p.data.channelId)!.add(uid);
  }
  return m;
};

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(SCHEMA);
  for (const n of ['owner', 'cmdr', 'officer', 'officer2', 'op', 'planner']) {
    ids[n] = (await q(`INSERT INTO users (callsign) VALUES ($1) RETURNING id`, [n]))[0].id;
  }
  orgId = (await q(`INSERT INTO organizations (owner_id, callsign) VALUES ($1, 'ORG') RETURNING id`, [ids.owner]))[0].id;
  const mk = async (name: string, level: number, perms: object) =>
    (role[name] = (await q(`INSERT INTO org_roles (org_id, name, permissions, level) VALUES ($1, $2, $3, $4) RETURNING id`, [orgId, name, JSON.stringify(perms), level]))[0].id);
  await mk('Commander', 100, { can_manage_roles: true, can_manage_channels: true, can_kick: true, can_ban: true });
  await mk('Officer', 50, { can_manage_channels: true });
  await mk('Operative', 10, {});
  await mk('Planner', 20, { can_create_events: true });
  const join = (u: string, r: string) => q(`INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`, [orgId, ids[u], role[r]]);
  await join('owner', 'Commander');
  await join('cmdr', 'Commander');
  await join('officer', 'Officer');
  await join('officer2', 'Officer');
  await join('op', 'Operative');
  await join('planner', 'Planner');
  general = (await q(`INSERT INTO channels (org_id, name) VALUES ($1, 'general') RETURNING id`, [orgId]))[0].id;
  officers = (await q(`INSERT INTO channels (org_id, name, visible_min_level) VALUES ($1, 'officers', 50) RETURNING id`, [orgId]))[0].id;
  // A live op: creator = cmdr, op is an accepted participant; planner is an
  // organiser only through its rank's can_create_events.
  const ev = (await q(`INSERT INTO events (org_id, creator_id, launched) VALUES ($1, $2, true) RETURNING id`, [orgId, ids.cmdr]))[0].id;
  debrief = (await q(`INSERT INTO channels (org_id, event_id, name) VALUES ($1, $2, 'debrief') RETURNING id`, [orgId, ev]))[0].id;
  alpha = (await q(`INSERT INTO channels (org_id, event_id, name) VALUES ($1, $2, 'alpha') RETURNING id`, [orgId, ev]))[0].id;
  const grp = (await q(`INSERT INTO event_groups (event_id, channel_id) VALUES ($1, $2) RETURNING id`, [ev, alpha]))[0].id;
  await q(`INSERT INTO event_group_members (group_id, user_id, status) VALUES ($1, $2, 'accepted')`, [grp, ids.op]);
});
beforeEach(() => { holder.published = []; holder.revoked = []; });
/** userId → the channel ids revoked from their live SSE streams (B5). */
const revokedFor = (uid: string) => holder.revoked.filter((r) => r.userId === uid).flatMap((r) => r.channelIds).sort();

// B6 first, while the ranks are as seeded (officers = level 50).
describe('MLS member list (B6): only callers allowed on the channel', () => {
  const members = (uid: string, chanId: string) => call(mls.getChannelMlsMembers, uid, { orgId, chanId });
  it('a rank-restricted channel: a lower rank gets 403, an allowed rank the list', async () => {
    const low = await members(ids.op, officers);
    expect(low.status).toBe(403);
    expect(low.body.user_ids).toBeUndefined();
    const ok = await members(ids.officer, officers);
    expect(ok.status).toBe(200);
    expect(new Set(ok.body.user_ids)).toEqual(S(ids.owner, ids.cmdr, ids.officer, ids.officer2));
    expect((await members(ids.owner, officers)).status).toBe(200);
  });
  it('an open channel: any member', async () => {
    expect((await members(ids.op, general)).status).toBe(200);
  });
  it('an event channel: its audience only (a group channel = its accepted members)', async () => {
    expect((await members(ids.op, debrief)).status).toBe(200);
    expect((await members(ids.op, alpha)).status).toBe(200);
    expect((await members(ids.officer, alpha)).status).toBe(403);
    expect((await members(ids.cmdr, alpha)).status).toBe(403); // GROUPSTRICT: no organiser bypass
  });
  it('catch-up follows the same gate', async () => {
    expect((await call(mls.getChannelMlsCatchUp, ids.op, { orgId, chanId: officers })).status).toBe(403);
  });
});

describe('channel visibility', () => {
  it('raised → the remaining members are told, the removed are not', async () => {
    expect((await call(chans.updateChannel, ids.owner, { orgId, channelId: officers }, { visible_min_level: 100 })).status).toBe(200);
    const m = sentTo();
    expect([...m.keys()]).toEqual([officers]);
    expect(m.get(officers)).toEqual(S(ids.owner, ids.cmdr));
    // B5: the two officers' live streams drop it; nobody else's.
    expect(revokedFor(ids.officer)).toEqual([officers]);
    expect(revokedFor(ids.officer2)).toEqual([officers]);
    expect(holder.revoked.map((r) => r.userId).sort()).toEqual([ids.officer, ids.officer2].sort());
  });
  it('lowered (widening) or a rename → nothing', async () => {
    expect((await call(chans.updateChannel, ids.owner, { orgId, channelId: officers }, { visible_min_level: 50 })).status).toBe(200);
    expect((await call(chans.updateChannel, ids.owner, { orgId, channelId: officers }, { name: 'officer deck' })).status).toBe(200);
    expect(narrowed()).toEqual([]);
    expect(holder.revoked).toEqual([]);
  });
  it('an open channel restricted → narrowed', async () => {
    const c = (await q(`INSERT INTO channels (org_id, name) VALUES ($1, 'lounge') RETURNING id`, [orgId]))[0].id;
    await call(chans.updateChannel, ids.owner, { orgId, channelId: c }, { visible_min_level: 50 });
    expect(sentTo().get(c)).toEqual(S(ids.owner, ids.cmdr, ids.officer, ids.officer2));
  });
});

describe('rank changes', () => {
  it('a demotion below a restricted channel → narrowed; a promotion → nothing', async () => {
    await call(mod.assignMemberRole, ids.owner, { orgId, userId: ids.op }, { role_id: role.Officer });
    expect(narrowed()).toEqual([]);
    expect(holder.revoked).toEqual([]);
    await call(mod.assignMemberRole, ids.owner, { orgId, userId: ids.op }, { role_id: role.Operative });
    const m = sentTo();
    expect(m.get(officers)?.has(ids.op)).toBe(false);
    expect(m.get(officers)).toEqual(S(ids.owner, ids.cmdr, ids.officer, ids.officer2));
    expect(m.has(general)).toBe(false); // open channels are unaffected by rank
    // B5: only the demoted member's streams lose the restricted channels
    // (officers + the lounge restricted above), never an open one.
    expect(holder.revoked.map((r) => r.userId)).toEqual([ids.op]);
    expect(revokedFor(ids.op)).toContain(officers);
    expect(revokedFor(ids.op)).not.toContain(general);
  });
  it("a rank's level lowered → its holders leave restricted channels", async () => {
    await call(roles.updateRole, ids.owner, { orgId, roleId: role.Officer }, { level: 40 });
    expect(sentTo().get(officers)).toEqual(S(ids.owner, ids.cmdr));
    await call(roles.updateRole, ids.owner, { orgId, roleId: role.Officer }, { level: 50 }); // widening
    expect(sentTo().get(officers)).toEqual(S(ids.owner, ids.cmdr));
    holder.published = [];
    await call(roles.updateRole, ids.owner, { orgId, roleId: role.Officer }, { name: 'Officer' });
    expect(narrowed()).toEqual([]);
  });
  it('a rank losing can_create_events drops its holders from a live op (organisers)', async () => {
    await call(roles.updateRole, ids.owner, { orgId, roleId: role.Planner }, { permissions: {} });
    const m = sentTo();
    expect([...m.keys()]).toEqual([debrief]);
    expect(m.get(debrief)?.has(ids.planner)).toBe(false);
    expect(m.get(debrief)?.has(ids.op)).toBe(true);
  });
  it('a rank deleted → its holders leave restricted channels', async () => {
    await call(roles.deleteRole, ids.owner, { orgId, roleId: role.Officer });
    expect(sentTo().get(officers)).toEqual(S(ids.owner, ids.cmdr));
  });
});

describe('kick / ban', () => {
  it('a kick narrows every channel they were on, open ones included', async () => {
    expect((await call(mod.kickMember, ids.owner, { orgId, userId: ids.officer2 }, {})).status).toBe(200);
    const m = sentTo();
    expect(m.get(general)?.has(ids.officer2)).toBe(false);
    expect(m.get(general)?.has(ids.op)).toBe(true);
    expect(m.has(officers)).toBe(false); // they had lost it already (rank deleted)
    // B5: every org channel they were still on, open ones included.
    const lost = revokedFor(ids.officer2);
    expect(lost).toContain(general);
    expect(lost).not.toContain(officers);
    expect(holder.revoked.every((r) => r.userId === ids.officer2)).toBe(true);
  });
  it('a ban too', async () => {
    expect((await call(mod.banMember, ids.owner, { orgId, userId: ids.op }, {})).status).toBe(200);
    const m = sentTo();
    expect(m.get(general)?.has(ids.op)).toBe(false);
    // The op's audience is its sign-ups, not org membership (eventChannelAccess):
    // a banned participant stays on it, so it doesn't narrow here.
    expect(m.has(debrief)).toBe(false);
    expect(revokedFor(ids.op)).toContain(general);
    expect(revokedFor(ids.op)).not.toContain(debrief);
  });
});
