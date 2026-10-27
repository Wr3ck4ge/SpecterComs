/**
 * EVMLS / LEADFREQ: who may use an event channel — the single rule shared by
 * the voice/video media ticket (orgController), channel presence
 * (channelController), event-channel text sends and MLS commits
 * (messageController / mlsGroupController) and the MLS membership list the
 * client reconciles each event channel's group against
 * (GET /orgs/:orgId/channels/:chanId/mls/members → mlsSession.js's
 * ensureChannelGroup).
 *
 * User decision (2026-10-24): "the only players that should have access to
 * these channels are members that have signed up to the event." So an event
 * channel's audience is never "every org member":
 *
 *   group channel      accepted members of the group that owns the channel
 *   frequency channel  accepted members holding a role the frequency is
 *                      assigned to (event_frequency_roles) — e.g. the
 *                      Leadership net → exactly its assigned roles — plus the
 *                      event's staff
 *   command channel    every accepted participant of the event, plus staff
 *   other event chan.  (debrief, a planner-made channel) same as command
 *
 *   staff = the event's commander, creator and planners (event_planners) —
 *   the people the event's own management rules already treat as running it
 *   (canManageThisEvent minus the org-wide permission, which is not a
 *   sign-up).
 *
 * "Signed up" means status = 'accepted'. A pending sign-up (awaiting planner
 * approval, or an assignment not yet accepted) is NOT a member: it gets no
 * channel key and no ticket until it is accepted, which is when the group's
 * next reconcile adds it (the same moment the server starts issuing tickets).
 *
 * This deliberately ignores events.access_mode: 'open'/'restricted' decide who
 * may SIGN UP; once launched, channels are for signed-up members either way.
 */
import { pool } from '../config/db.js';

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type ChannelScope =
  | { scope: 'org'; orgId: string; channelId: string }
  | {
      scope: 'event';
      orgId: string;
      channelId: string;
      eventId: string;
      kind: 'command' | 'group' | 'frequency' | 'other';
      groupId: string | null;
      frequencyId: string | null;
    };

/** Classifies a channel of `orgId`; null when it doesn't exist in that org. */
export async function getChannelScope(channelId: string, orgId: string, db: Queryable = pool): Promise<ChannelScope | null> {
  const res = await db.query(
    `SELECT c.id, c.event_id, COALESCE(c.is_frequency, false) AS is_frequency,
            e.command_channel_id,
            (SELECT eg.id FROM event_groups eg WHERE eg.channel_id = c.id LIMIT 1) AS group_id,
            (SELECT ef.id FROM event_frequencies ef WHERE ef.channel_id = c.id LIMIT 1) AS frequency_id
     FROM channels c
     LEFT JOIN events e ON e.id = c.event_id
     WHERE c.id = $1 AND c.org_id = $2`,
    [channelId, orgId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (!row.event_id) return { scope: 'org', orgId, channelId };
  let kind: 'command' | 'group' | 'frequency' | 'other' = 'other';
  if (row.command_channel_id && row.command_channel_id === channelId) kind = 'command';
  else if (row.is_frequency) kind = 'frequency';
  else if (row.group_id) kind = 'group';
  return {
    scope: 'event', orgId, channelId, eventId: row.event_id, kind,
    groupId: row.group_id ?? null, frequencyId: row.frequency_id ?? null,
  };
}

const STAFF_SQL = `
  SELECT commander_user_id AS user_id FROM events WHERE id = $1 AND commander_user_id IS NOT NULL
  UNION SELECT creator_id FROM events WHERE id = $1 AND creator_id IS NOT NULL
  UNION SELECT user_id FROM event_planners WHERE event_id = $1`;

const eventParticipantsSql = (p: string) => `
  SELECT egm.user_id FROM event_group_members egm
  JOIN event_groups eg ON eg.id = egm.group_id
  WHERE eg.event_id = ${p} AND egm.status = 'accepted'`;

/**
 * Every user allowed on an event channel (see the module comment), deduped.
 * For an org channel: every org member (unchanged behaviour).
 */
export async function channelMemberUserIds(scope: ChannelScope, db: Queryable = pool): Promise<string[]> {
  if (scope.scope === 'org') {
    const r = await db.query(`SELECT user_id FROM org_members WHERE org_id = $1`, [scope.orgId]);
    return r.rows.map((x) => x.user_id);
  }
  let sql: string;
  let params: unknown[];
  if (scope.kind === 'group') {
    sql = `SELECT DISTINCT egm.user_id FROM event_group_members egm
           WHERE egm.group_id = $1 AND egm.status = 'accepted'`;
    params = [scope.groupId];
  } else if (scope.kind === 'frequency') {
    sql = `SELECT DISTINCT egm.user_id FROM event_frequency_roles efr
           JOIN event_group_members egm ON egm.role_id = efr.role_id AND egm.status = 'accepted'
           JOIN event_groups eg ON eg.id = egm.group_id AND eg.event_id = $1
           WHERE efr.frequency_id = $2
           UNION ${STAFF_SQL}`;
    params = [scope.eventId, scope.frequencyId];
  } else {
    sql = `${eventParticipantsSql('$1')}
           UNION ${STAFF_SQL}`;
    params = [scope.eventId];
  }
  const r = await db.query(sql, params);
  return [...new Set<string>(r.rows.map((x) => x.user_id).filter(Boolean))];
}

/**
 * The event-scoped (priority-cascade) MLS group's members: every accepted
 * participant plus the event's staff — the union of every event channel's
 * audience, since a cascade speaker is heard in every channel of the tree.
 */
export async function eventCascadeMemberUserIds(eventId: string, db: Queryable = pool): Promise<string[]> {
  const r = await db.query(`${eventParticipantsSql('$1')} UNION ${STAFF_SQL}`, [eventId]);
  return [...new Set<string>(r.rows.map((x) => x.user_id).filter(Boolean))];
}

/** Is `userId` allowed on this channel? Org channels: always true here (callers check org membership). */
export async function canUseChannel(scope: ChannelScope, userId: string, db: Queryable = pool): Promise<boolean> {
  if (scope.scope === 'org') return true;
  return (await channelMemberUserIds(scope, db)).includes(userId);
}
