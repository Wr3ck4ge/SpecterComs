/**
 * Server admin authority (owner, 2026-11-08): rank hierarchy, permission
 * grants, channel visibility, the admin member roster, online tracking.
 * Pure rules plus the real SQL against PGlite.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const holder = vi.hoisted(() => ({ db: null as any, published: [] as { subject: string; data: any }[] }));
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

const {
  authorityFrom, outranks, ungrantablePermissions, canSeeOrgChannel, canViewRoster, memberStatus, has,
} = await import('../../src/utils/orgAuthority.js');
const { canUseChannel, channelMemberUserIds, getChannelScope } = await import('../../src/utils/eventChannelAccess.js');
const online = await import('../../src/utils/onlineUsers.js');
const mod = await import('../../src/controllers/modController.js');
const roles = await import('../../src/controllers/roleController.js');
const chans = await import('../../src/controllers/channelController.js');

const owner = authorityFrom(true, []);
const commander = authorityFrom(false, [{ level: 100, permissions: { can_manage_roles: true, can_view_members: true, can_kick: true, can_manage_channels: true } }]);
const officer = authorityFrom(false, [{ level: 50, permissions: { can_manage_channels: true, can_invite: true } }]);
const operative = authorityFrom(false, [{ level: 10, permissions: { can_invite: true } }]);

describe('rank hierarchy (pure)', () => {
  it('the owner outranks everyone and holds every permission', () => {
    expect(outranks(owner, 100000)).toBe(true);
    expect(has(owner, 'can_ban')).toBe(true);
    expect(canViewRoster(owner)).toBe(true);
  });
  it('strictly higher level only', () => {
    expect(outranks(commander, 50)).toBe(true);
    expect(outranks(commander, 100)).toBe(false);
    expect(outranks(officer, 100)).toBe(false);
  });
  it('a member with several ranks counts the highest; JSON-string permissions read too', () => {
    const a = authorityFrom(false, [{ level: 10, permissions: {} }, { level: 50, permissions: '{"can_kick":true}' }]);
    expect(a.level).toBe(50);
    expect(has(a, 'can_kick')).toBe(true);
  });
  it('roster: owner, can_view_members or can_manage_roles', () => {
    expect(canViewRoster(commander)).toBe(true);
    expect(canViewRoster(officer)).toBe(false);
    expect(canViewRoster(authorityFrom(false, [{ level: 20, permissions: { can_view_members: true } }]))).toBe(true);
  });
  it('grants: only permissions you hold; false flags fine; unknown keys refused', () => {
    expect(ungrantablePermissions(commander, { can_kick: true, can_view_members: true })).toEqual([]);
    expect(ungrantablePermissions(commander, { can_ban: true, can_kick: true })).toEqual(['can_ban']);
    expect(ungrantablePermissions(operative, { can_ban: false })).toEqual([]);
    expect(ungrantablePermissions(owner, { super_admin: true })).toEqual(['super_admin']);
  });
  it('visibility: 0 = everyone, else level >= threshold, or the owner', () => {
    expect(canSeeOrgChannel(operative, 0)).toBe(true);
    expect(canSeeOrgChannel(operative, 50)).toBe(false);
    expect(canSeeOrgChannel(officer, 50)).toBe(true);
    expect(canSeeOrgChannel(owner, 999)).toBe(true);
  });
  it('status: voice > invisible > online/away/busy > offline', () => {
    expect(memberStatus({ online: true, inVoice: true, presenceStatus: 3 })).toBe('voice');
    expect(memberStatus({ online: true, inVoice: false, presenceStatus: 3 })).toBe('offline');
    expect(memberStatus({ online: true, inVoice: false, presenceStatus: 0 })).toBe('online');
    expect(memberStatus({ online: true, inVoice: false, presenceStatus: 1 })).toBe('away');
    expect(memberStatus({ online: true, inVoice: false, presenceStatus: 2 })).toBe('busy');
    expect(memberStatus({ online: false, inVoice: false })).toBe('offline');
  });
  it('online tracking counts open streams per user', () => {
    online.resetOnlineUsers();
    online.markStreamOpen('a'); online.markStreamOpen('a'); online.markStreamClosed('a');
    expect(online.isUserOnline('a')).toBe(true);
    online.markStreamClosed('a');
    expect(online.isUserOnline('a')).toBe(false);
    online.markStreamClosed('a'); // never negative
    online.markStreamOpen('a');
    expect(online.isUserOnline('a')).toBe(true);
    online.resetOnlineUsers();
  });
});

// ── Against the real SQL ────────────────────────────────────────────────────
const SCHEMA = `
  CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), callsign TEXT, profile_image_path TEXT); -- as prod: no presence column
  CREATE TABLE organizations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID, callsign TEXT, default_role_id UUID);
  CREATE TABLE org_invites (code TEXT PRIMARY KEY, org_id UUID, assigned_role_id UUID);
  CREATE TABLE org_roles (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID, name TEXT, permissions JSONB DEFAULT '{}', level INT NOT NULL DEFAULT 0);
  CREATE TABLE org_members (org_id UUID, user_id UUID, role_id UUID, joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (org_id, user_id));
  CREATE TABLE channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID, event_id UUID, name TEXT,
    type INT DEFAULT 0, channel_kind INT DEFAULT 0, min_tier INT DEFAULT 0, ducking_level REAL DEFAULT 0,
    is_frequency BOOLEAN NOT NULL DEFAULT FALSE, visible_min_level INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT clock_timestamp()
  );
  CREATE TABLE events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), launched BOOLEAN DEFAULT FALSE, command_channel_id UUID);
  CREATE TABLE channel_subscriptions (channel_id UUID, user_id UUID, org_id UUID, joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (user_id, org_id));
  CREATE TABLE event_groups (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), channel_id UUID);
  CREATE TABLE event_frequencies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), channel_id UUID, is_leadership BOOLEAN DEFAULT FALSE);
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

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(SCHEMA);
  for (const n of ['owner', 'cmdr', 'cmdr2', 'officer', 'op', 'guest', 'outsider']) {
    ids[n] = (await q(`INSERT INTO users (callsign) VALUES ($1) RETURNING id`, [n]))[0].id;
  }
  orgId = (await q(`INSERT INTO organizations (owner_id, callsign) VALUES ($1, 'ORG') RETURNING id`, [ids.owner]))[0].id;
  const mk = async (name: string, level: number, perms: object) =>
    (role[name] = (await q(`INSERT INTO org_roles (org_id, name, permissions, level) VALUES ($1, $2, $3, $4) RETURNING id`, [orgId, name, JSON.stringify(perms), level]))[0].id);
  await mk('Commander', 100, { can_view_members: true, can_manage_roles: true, can_manage_channels: true, can_kick: true });
  await mk('Officer', 50, { can_manage_channels: true, can_invite: true });
  await mk('Operative', 10, { can_invite: true });
  await mk('Guest', 0, {});
  const join = (u: string, r: string) => q(`INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`, [orgId, ids[u], role[r]]);
  await join('owner', 'Commander');
  await join('cmdr', 'Commander');
  await join('cmdr2', 'Commander');
  await join('officer', 'Officer');
  await join('op', 'Operative');
  await join('guest', 'Guest');
});
beforeEach(() => { holder.published = []; online.resetOnlineUsers(); });

describe('member roster', () => {
  it('owner and Commanders see it; Officers and outsiders do not', async () => {
    expect((await call(mod.getMemberRoster, ids.owner, { orgId })).status).toBe(200);
    expect((await call(mod.getMemberRoster, ids.cmdr, { orgId })).status).toBe(200);
    expect((await call(mod.getMemberRoster, ids.officer, { orgId })).status).toBe(403);
    expect((await call(mod.getMemberRoster, ids.outsider, { orgId })).status).toBe(403);
  });
  it('carries status, rank and what the viewer may do', async () => {
    online.markStreamOpen(ids.op);
    const r = await call(mod.getMemberRoster, ids.cmdr, { orgId });
    const by = Object.fromEntries(r.body.members.map((m: any) => [m.callsign, m]));
    expect(by.op.status).toBe('online');
    expect(by.guest.status).toBe('offline');
    expect(by.owner).toMatchObject({ is_owner: true, role_name: 'Owner', manageable: false });
    expect(by.cmdr2.manageable).toBe(false); // a peer
    expect(by.cmdr.manageable).toBe(false); // myself
    expect(by.officer.manageable).toBe(true);
    expect(r.body.members[0].callsign).toBe('op'); // online first
    const editable = Object.fromEntries(r.body.roles.map((x: any) => [x.name, x.editable]));
    expect(editable).toEqual({ Commander: false, Officer: true, Operative: true, Guest: true });
    expect(r.body.permission_keys).toContain('can_view_members');
  });
});

describe('changing ranks', () => {
  it('a Commander can promote below their rank, not to it, and not touch a peer or the owner', async () => {
    expect((await call(mod.assignMemberRole, ids.cmdr, { orgId, userId: ids.op }, { role_id: role.Officer })).status).toBe(200);
    expect((await call(mod.assignMemberRole, ids.cmdr, { orgId, userId: ids.op }, { role_id: role.Commander })).status).toBe(403);
    // Was allowed before: a can_manage_roles member demoting a peer Commander.
    expect((await call(mod.assignMemberRole, ids.cmdr, { orgId, userId: ids.cmdr2 }, { role_id: role.Guest })).status).toBe(403);
    expect((await call(mod.assignMemberRole, ids.cmdr, { orgId, userId: ids.owner }, { role_id: role.Guest })).status).toBe(403);
    expect((await call(mod.assignMemberRole, ids.officer, { orgId, userId: ids.guest }, { role_id: role.Operative })).status).toBe(403);
    expect(holder.published.filter((p) => p.data.type === 'member_updated')).toHaveLength(1);
  });
  it('only the owner makes more admins', async () => {
    expect((await call(mod.assignMemberRole, ids.owner, { orgId, userId: ids.op }, { role_id: role.Commander })).status).toBe(200);
    await call(mod.assignMemberRole, ids.owner, { orgId, userId: ids.op }, { role_id: role.Operative });
  });
  it('rank permissions: only ones you hold; ranks list is members-only', async () => {
    const bad = await call(roles.updateRole, ids.cmdr, { orgId, roleId: role.Officer }, { permissions: { can_ban: true } });
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('PERMISSION_NOT_HELD');
    expect((await call(roles.updateRole, ids.cmdr, { orgId, roleId: role.Officer }, { permissions: { can_manage_channels: true, can_view_members: true } })).status).toBe(200);
    expect((await call(roles.updateRole, ids.owner, { orgId, roleId: role.Officer }, { permissions: { can_manage_channels: true, can_invite: true } })).status).toBe(200);
    // Keeping a permission the rank already has isn't granting it.
    await call(roles.updateRole, ids.owner, { orgId, roleId: role.Operative }, { permissions: { can_invite: true, can_ban: true } });
    expect((await call(roles.updateRole, ids.cmdr, { orgId, roleId: role.Operative }, { permissions: { can_invite: true, can_ban: true, can_kick: true } })).status).toBe(200);
    expect((await call(roles.updateRole, ids.cmdr, { orgId, roleId: role.Operative }, { permissions: { can_invite: true } })).status).toBe(200);
    expect((await call(roles.getRoles, ids.outsider, { orgId })).status).toBe(403);
    expect((await call(roles.getRoles, ids.guest, { orgId })).status).toBe(200);
  });
});

describe('deleting a rank', () => {
  it('its members fall back to no rank', async () => {
    const tmp = (await q(`INSERT INTO org_roles (org_id, name, level) VALUES ($1, 'Temp', 5) RETURNING id`, [orgId]))[0].id;
    const u = (await q(`INSERT INTO users (callsign) VALUES ('temp') RETURNING id`))[0].id;
    await q(`INSERT INTO org_members (org_id, user_id, role_id) VALUES ($1, $2, $3)`, [orgId, u, tmp]);
    await q(`UPDATE organizations SET default_role_id = $2 WHERE id = $1`, [orgId, tmp]);
    expect((await call(roles.deleteRole, ids.cmdr, { orgId, roleId: tmp })).status).toBe(200);
    expect((await q(`SELECT role_id FROM org_members WHERE user_id = $1`, [u]))[0].role_id).toBeNull();
    expect((await q(`SELECT default_role_id FROM organizations WHERE id = $1`, [orgId]))[0].default_role_id).toBeNull();
  });
});

describe('channel visibility', () => {
  let officersOnly: string;
  it('create: channel admins only, never above their own rank', async () => {
    expect((await call(chans.createChannel, ids.op, { orgId }, { name: 'nope' })).status).toBe(403);
    expect((await call(chans.createChannel, ids.officer, { orgId }, { name: 'too high', visible_min_level: 100 })).status).toBe(403);
    const ok = await call(chans.createChannel, ids.officer, { orgId }, { name: 'officers', visible_min_level: 50 });
    expect(ok.status).toBe(201);
    officersOnly = ok.body.id;
    // Lower ranks only get a refetch nudge, not the restricted channel's details.
    expect(holder.published.at(-1)!.data).toEqual({ type: 'channel_created', channelId: officersOnly });
    await call(chans.createChannel, ids.owner, { orgId }, { name: 'general' });
  });
  it('the list hides it below the threshold', async () => {
    const names = async (u: string) => (await call(chans.listChannels, ids[u], { orgId })).body.channels.map((c: any) => c.name).sort();
    expect(await names('op')).toEqual(['general']);
    expect(await names('officer')).toEqual(['general', 'officers']);
    expect(await names('owner')).toEqual(['general', 'officers']);
  });
  it('the shared access rule (presence, ticket, messages, MLS keys) follows it', async () => {
    const scope = (await getChannelScope(officersOnly, orgId))!;
    expect(scope).toMatchObject({ scope: 'org', minLevel: 50 });
    expect(await canUseChannel(scope, ids.op)).toBe(false);
    expect(await canUseChannel(scope, ids.officer)).toBe(true);
    expect(new Set(await channelMemberUserIds(scope))).toEqual(new Set([ids.owner, ids.cmdr, ids.cmdr2, ids.officer]));
    expect((await call(chans.joinChannelPresence, ids.op, { orgId, channelId: officersOnly })).status).toBe(403);
  });
  it('update / delete: hidden channels are "not found" to lower ranks', async () => {
    expect((await call(chans.updateChannel, ids.op, { orgId, channelId: officersOnly }, { visible_min_level: 0 })).status).toBe(403);
    expect((await call(chans.updateChannel, ids.officer, { orgId, channelId: officersOnly }, { visible_min_level: 60 })).status).toBe(403);
    expect((await call(chans.updateChannel, ids.owner, { orgId, channelId: officersOnly }, { visible_min_level: 100, name: 'command' })).status).toBe(200);
    expect((await call(chans.updateChannel, ids.officer, { orgId, channelId: officersOnly }, { name: 'x' })).status).toBe(404);
    expect((await call(chans.deleteChannel, ids.officer, { orgId, channelId: officersOnly })).status).toBe(404);
    expect((await call(chans.deleteChannel, ids.cmdr, { orgId, channelId: officersOnly })).status).toBe(200);
  });
});
