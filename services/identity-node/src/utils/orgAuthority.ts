/**
 * Server (org) authority: who outranks whom, what a rank may grant, and who
 * can see an org channel. One place, so the member roster, rank edits and the
 * channel access rule all agree (owner, 2026-11-08).
 *
 *  - The owner outranks everyone and holds every permission.
 *  - A member's level is the highest level among their ranks (normally one).
 *  - Ranks, members and channels are managed strictly BELOW your own level:
 *    you can't edit, assign or remove a rank at/above yours, or change the
 *    rank of someone at/above you.
 *  - You can only grant permissions you hold yourself (no escalation by
 *    building a lower rank with powers you don't have).
 *  - An org channel with visible_min_level N is visible to — and usable by —
 *    members at level >= N, and the owner. 0 = everyone.
 */
import { pool } from '../config/db.js';

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Every permission a rank can carry, in display order. */
export const ORG_PERMISSION_KEYS = [
  'can_view_members',
  'can_manage_roles',
  'can_manage_channels',
  'can_kick',
  'can_ban',
  'can_mute',
  'can_invite',
  'can_create_events',
  'can_view_calendar',
  'can_view_billing',
] as const;
export type OrgPermission = (typeof ORG_PERMISSION_KEYS)[number];

export interface OrgAuthority {
  isOwner: boolean;
  isMember: boolean;
  level: number;
  permissions: Record<string, boolean>;
}

const parsePerms = (p: unknown): Record<string, unknown> =>
  typeof p === 'string' ? (() => { try { return JSON.parse(p); } catch { return {}; } })() : ((p as any) || {});

/** Pure: combine a member's rank rows (owner gets everything). */
export function authorityFrom(isOwner: boolean, rows: Array<{ permissions: unknown; level: unknown }>, isMember = rows.length > 0): OrgAuthority {
  if (isOwner) {
    return {
      isOwner: true, isMember: true, level: Number.MAX_SAFE_INTEGER,
      permissions: Object.fromEntries(ORG_PERMISSION_KEYS.map((k) => [k, true])),
    };
  }
  let level = 0;
  const permissions: Record<string, boolean> = {};
  for (const r of rows) {
    const lv = Number(r.level ?? 0);
    if (lv > level) level = lv;
    for (const [k, v] of Object.entries(parsePerms(r.permissions))) if (v === true) permissions[k] = true;
  }
  return { isOwner: false, isMember, level, permissions };
}

export async function getOrgAuthority(orgId: string, userId: string, db: Queryable = pool): Promise<OrgAuthority> {
  const own = await db.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
  const isOwner = own.rows[0]?.owner_id === userId;
  const r = await db.query(
    `SELECT r.permissions, COALESCE(r.level, 0) AS level, (r.id IS NOT NULL) AS has_role
     FROM org_members m LEFT JOIN org_roles r ON r.id = m.role_id
     WHERE m.org_id = $1 AND m.user_id = $2`,
    [orgId, userId],
  );
  const rows = r.rows.filter((x: any) => x.has_role);
  return authorityFrom(isOwner, rows, isOwner || r.rows.length > 0);
}

export const has = (a: OrgAuthority, perm: OrgPermission | string): boolean => a.isOwner || a.permissions[perm] === true;

/** May see the admin member roster (online status, ranks). */
export const canViewRoster = (a: OrgAuthority): boolean =>
  a.isOwner || has(a, 'can_view_members') || has(a, 'can_manage_roles');

/** Pure: true when `a` strictly outranks `level` (the owner outranks all). */
export const outranks = (a: OrgAuthority, level: number): boolean => a.isOwner || a.level > Number(level ?? 0);

/**
 * Pure: the permission keys in `requested` that `a` may NOT grant (empty = ok).
 * Unknown keys are refused too, so a typo can't smuggle a flag in.
 */
export function ungrantablePermissions(a: OrgAuthority, requested: unknown): string[] {
  const p = parsePerms(requested);
  const bad: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v !== true) continue;
    if (!(ORG_PERMISSION_KEYS as readonly string[]).includes(k)) { bad.push(k); continue; }
    if (!has(a, k)) bad.push(k);
  }
  return bad;
}

/** Pure: may `a` see/use an org channel with this visibility threshold? */
export const canSeeOrgChannel = (a: Pick<OrgAuthority, 'isOwner' | 'level'>, visibleMinLevel: unknown): boolean =>
  a.isOwner || a.level >= Number(visibleMinLevel ?? 0);

/**
 * Members allowed on an org channel (visibility rule above). `minLevel` 0 →
 * every member (the rule before visibility existed).
 */
export async function orgChannelAudience(orgId: string, minLevel: number, db: Queryable = pool): Promise<string[]> {
  const r = await db.query(
    `SELECT m.user_id
     FROM org_members m
     LEFT JOIN org_roles r ON r.id = m.role_id
     JOIN organizations o ON o.id = m.org_id
     WHERE m.org_id = $1
     GROUP BY m.user_id, o.owner_id
     HAVING m.user_id = o.owner_id OR COALESCE(MAX(r.level), 0) >= $2`,
    [orgId, Number(minLevel) || 0],
  );
  return r.rows.map((x: any) => x.user_id);
}

/** Pure: a roster member's status for the admin pane. */
export type MemberStatus = 'voice' | 'online' | 'away' | 'busy' | 'offline';
export function memberStatus(o: { online: boolean; presenceStatus?: number | null; inVoice: boolean }): MemberStatus {
  // In voice shows regardless: the channel list already shows them there.
  if (o.inVoice) return 'voice';
  // presence_status 3 = Invisible: shown as offline.
  if (o.presenceStatus === 3) return 'offline';
  if (!o.online) return 'offline';
  if (o.presenceStatus === 1) return 'away';
  if (o.presenceStatus === 2) return 'busy';
  return 'online';
}
