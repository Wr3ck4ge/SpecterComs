/**
 * EVMLS / LEADFREQ / OPTREE: who may use an event channel — the single rule
 * shared by the voice/video media ticket (orgController), channel presence
 * (channelController), event-channel text sends and MLS commits
 * (messageController / mlsGroupController), the MLS membership list the
 * client reconciles each event channel's group against
 * (GET /orgs/:orgId/channels/:chanId/mls/members → mlsSession.js's
 * ensureChannelGroup) and the channel list's per-channel `can_join`
 * (channelController listChannels → the strip's event tree).
 *
 * User decisions: "the only players that should have access to these
 * channels are members that have signed up to the event" (2026-10-24), and
 * (2026-10-31) "a member may only join their own group's channel; command is
 * a branch of authority — group leaders plus the commander — not a channel
 * for everyone; organisers can join any of the event's channels".
 *
 *   organisers   the event's commander, creator and planners (event_planners),
 *                plus the org's owner and members whose org role may manage
 *                events (can_create_events / can_manage_channels) — exactly
 *                the people canManageThisEvent lets run the event.
 *   commanders   events.commander_user_id + accepted holders of a role flagged
 *                is_commander (Mission Wide transmitters).
 *   participants accepted members of any of the event's groups.
 *   freq members FREQWL: each frequency's explicit whitelist
 *                (event_frequency_members), set by the planner.
 *
 *   channel kind       audience
 *   group channel      accepted members of THAT group ONLY (GROUPSTRICT, owner
 *                      2026-11-08, supersedes the 2026-10-31 "organisers can
 *                      join any of the event's channels": no organiser bypass,
 *                      not even the owner or commander; sign up to enter)
 *   frequency channel  its whitelist ONLY, ∩ (participants ∪ organisers) (FREQWL, 2026-11-07: "the frequency
 *                      whitelist for its members is decided during mission
 *                      planning. If a commander wants to be in every frequency
 *                      he can assign it there.") — no implicit access for the
 *                      commander, group leaders, organisers or a Leadership
 *                      net. Roles are only a planner shortcut for adding
 *                      their holders to the whitelist.
 *   other event chan.  participants ∪ organisers (debrief, planner-made)
 *   event cascade grp  participants ∪ organisers (eventCascadeMemberUserIds:
 *                      a cascade speaker is heard in every channel of the tree)
 *
 * "Signed up" means status = 'accepted'. A pending sign-up (awaiting planner
 * approval, or an assignment not yet accepted) is NOT a member: it gets no
 * channel key and no ticket until it is accepted, which is when the group's
 * next reconcile adds it (the same moment the server starts issuing tickets).
 *
 * This deliberately ignores events.access_mode: 'open'/'restricted' decide who
 * may SIGN UP; once launched, channels are for signed-up members either way.
 *
 * Implementation: loadEventAudience reads every set above for one event (a
 * handful of queries), audienceFor is the pure rule over them. Every caller
 * goes through these two, so the ticket, the MLS list and the UI can't drift.
 */
import { orgChannelAudience } from './orgAuthority.js';
import { pool } from '../config/db.js';

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

// Phase 2: no 'command' kind — events no longer have a command channel.
export type EventChannelKind = 'group' | 'frequency' | 'other';

export type ChannelScope =
  // minLevel: channels.visible_min_level (utils/orgAuthority). 0 = every member.
  | { scope: 'org'; orgId: string; channelId: string; minLevel: number }
  | {
      scope: 'event';
      orgId: string;
      channelId: string;
      eventId: string;
      kind: EventChannelKind;
      groupId: string | null;
      frequencyId: string | null;
    };

/** Pure classification of an event channel row (see getChannelScope). */
export function classifyEventChannel(row: {
  id: string; is_frequency?: boolean | null;
  group_id?: string | null; frequency_id?: string | null;
}): EventChannelKind {
  if (row.is_frequency) return 'frequency';
  if (row.group_id) return 'group';
  return 'other';
}

/** Classifies a channel of `orgId`; null when it doesn't exist in that org. */
export async function getChannelScope(channelId: string, orgId: string, db: Queryable = pool): Promise<ChannelScope | null> {
  const res = await db.query(
    `SELECT c.id, c.event_id, COALESCE(c.is_frequency, false) AS is_frequency,
            COALESCE(c.visible_min_level, 0) AS visible_min_level,
            (SELECT eg.id FROM event_groups eg WHERE eg.channel_id = c.id LIMIT 1) AS group_id,
            (SELECT ef.id FROM event_frequencies ef WHERE ef.channel_id = c.id
              ORDER BY ef.is_leadership DESC LIMIT 1) AS frequency_id
     FROM channels c
     WHERE c.id = $1 AND c.org_id = $2`,
    [channelId, orgId],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (!row.event_id) return { scope: 'org', orgId, channelId, minLevel: Number(row.visible_min_level) || 0 };
  return {
    scope: 'event', orgId, channelId, eventId: row.event_id, kind: classifyEventChannel(row),
    groupId: row.group_id ?? null, frequencyId: row.frequency_id ?? null,
  };
}

/** Everything the rule needs about one event's people (see the module comment). */
export interface EventAudience {
  organisers: Set<string>;
  commanders: Set<string>;
  participants: Set<string>;
  /** group_id → accepted members */
  groupMembers: Map<string, Set<string>>;
  /** FREQWL: frequency_id → its planner whitelist (every frequency of the op has an entry) */
  frequencyMembers: Map<string, Set<string>>;
}

const addTo = (m: Map<string, Set<string>>, k: string, v: string) => {
  let s = m.get(k);
  if (!s) { s = new Set(); m.set(k, s); }
  s.add(v);
};

/** Reads one event's audience sets. An unknown event yields empty sets. */
export async function loadEventAudience(eventId: string, db: Queryable = pool): Promise<EventAudience> {
  const a: EventAudience = {
    organisers: new Set(), commanders: new Set(), participants: new Set(),
    groupMembers: new Map(), frequencyMembers: new Map(),
  };
  const ev = await db.query(`SELECT org_id, creator_id, commander_user_id FROM events WHERE id = $1`, [eventId]);
  if (ev.rows.length === 0) return a;
  const { org_id: orgId, creator_id: creatorId, commander_user_id: commanderId } = ev.rows[0];
  if (creatorId) a.organisers.add(creatorId);
  if (commanderId) { a.organisers.add(commanderId); a.commanders.add(commanderId); }

  // Planners + the org's owner + org roles that may manage events
  // (eventsController canManageEvents: can_create_events / can_manage_channels).
  const org = await db.query(
    `SELECT user_id FROM event_planners WHERE event_id = $1
     UNION SELECT owner_id FROM organizations WHERE id = $2 AND owner_id IS NOT NULL
     UNION SELECT om.user_id FROM org_members om JOIN org_roles r ON r.id = om.role_id
           WHERE om.org_id = $2
             AND (COALESCE(r.permissions->>'can_create_events', 'false') = 'true'
               OR COALESCE(r.permissions->>'can_manage_channels', 'false') = 'true')`,
    [eventId, orgId],
  );
  for (const r of org.rows) if (r.user_id) a.organisers.add(r.user_id);

  // FREQWL: each frequency's whitelist — the planner's explicit list, nothing derived.
  const freqs = await db.query(
    `SELECT ef.id, fm.user_id
     FROM event_frequencies ef LEFT JOIN event_frequency_members fm ON fm.frequency_id = ef.id
     WHERE ef.event_id = $1`,
    [eventId],
  );
  for (const f of freqs.rows) {
    if (!a.frequencyMembers.has(f.id)) a.frequencyMembers.set(f.id, new Set());
    if (f.user_id) addTo(a.frequencyMembers, f.id, f.user_id);
  }

  const members = await db.query(
    `SELECT egm.user_id, egm.group_id, egm.role_id, COALESCE(egr.is_commander, false) AS is_commander
     FROM event_group_members egm
     JOIN event_groups eg ON eg.id = egm.group_id
     LEFT JOIN event_group_roles egr ON egr.id = egm.role_id
     WHERE eg.event_id = $1 AND egm.status = 'accepted'`,
    [eventId],
  );
  for (const m of members.rows) {
    if (!m.user_id) continue;
    a.participants.add(m.user_id);
    addTo(a.groupMembers, m.group_id, m.user_id);
    if (m.is_commander) a.commanders.add(m.user_id);
  }
  return a;
}

/** The rule (module comment): the user ids allowed on one event channel. Pure. */
export function audienceFor(
  scope: { kind: EventChannelKind; groupId: string | null; frequencyId: string | null },
  a: EventAudience,
): Set<string> {
  // FREQWL: a frequency is its whitelist alone — organisers are NOT added.
  // A whitelisted user must still be in the op (an accepted participant or an
  // organiser), so every member also holds the event MLS group's keys (op
  // video / cascade) and someone who leaves the op drops off its nets.
  if (scope.kind === 'frequency') {
    const out = new Set<string>();
    for (const id of (scope.frequencyId ? a.frequencyMembers.get(scope.frequencyId) : undefined) || []) {
      if (a.participants.has(id) || a.organisers.has(id)) out.add(id);
    }
    return out;
  }
  // GROUPSTRICT (2026-11-08): a group channel is its accepted members ONLY —
  // no organiser bypass, not even the owner/commander. Sign up to enter.
  if (scope.kind === 'group') {
    return new Set<string>((scope.groupId ? a.groupMembers.get(scope.groupId) : undefined) || []);
  }
  return new Set<string>([...a.organisers, ...a.participants]);
}

/** FREQPRIO / FREQWL: a frequency's members — its whitelist. Pure. */
export function frequencyAudience(a: EventAudience, frequencyId: string): Set<string> {
  return audienceFor({ kind: 'frequency', groupId: null, frequencyId }, a);
}

/**
 * FREQPRIO / FREQWL: every frequency of the op whose whitelist has `userId` —
 * what my-assignment lists so each shows in the member's toggle cycle. Pure.
 */
export function allowedFrequencyIds(a: EventAudience, userId: string): Set<string> {
  const out = new Set<string>();
  for (const fid of a.frequencyMembers.keys()) if (frequencyAudience(a, fid).has(userId)) out.add(fid);
  return out;
}

/** The event cascade group's audience: participants ∪ organisers. Pure. */
export function cascadeAudience(a: EventAudience): Set<string> {
  return new Set<string>([...a.participants, ...a.organisers]);
}

/**
 * Frequency overlay phase 3, MISSION WIDE: a one-way broadcast from the op's
 * commanders to everyone in the op. It is not a channel (no channels row, never
 * listed): its relay room id IS the event id, its audio key is exported from
 * the event-level MLS group (ensureEventGroup, label 'audio-mission-wide'),
 * whose members are cascadeAudience — so the room's listeners and the key's
 * holders are the same set.
 *
 *   rx   participants ∪ organisers (the event group's audience)
 *   tx   commanders only (events.commander_user_id + accepted is_commander roles)
 *
 * An op without a commander has no Mission Wide at all: nobody gets either.
 * The ticket carries `listen_only: true` for rx-without-tx, and media-rust
 * drops every audio datagram from such a session (ticket_listen_only), so a
 * participant can't talk on it even with a modified client. Pure.
 */
export function missionWideAccess(a: EventAudience, userId: string): { rx: boolean; tx: boolean } {
  if (a.commanders.size === 0) return { rx: false, tx: false };
  const tx = a.commanders.has(userId);
  const rx = tx || cascadeAudience(a).has(userId);
  return { rx, tx: tx && rx };
}

/** The exporter label for the Mission Wide audio key (event MLS group). */
export const MISSION_WIDE_KEY_LABEL = 'audio-mission-wide';

/**
 * Every user allowed on a channel (see the module comment), deduped.
 * For an org channel: every org member (unchanged behaviour).
 */
export async function channelMemberUserIds(scope: ChannelScope, db: Queryable = pool): Promise<string[]> {
  if (scope.scope === 'org') {
    // Visibility (owner, 2026-11-08): members at or above the channel's rank
    // threshold, plus the owner. Threshold 0 = every member, as before.
    return orgChannelAudience(scope.orgId, scope.minLevel ?? 0, db);
  }
  return [...audienceFor(scope, await loadEventAudience(scope.eventId, db))];
}

/**
 * The event-scoped (priority-cascade) MLS group's members: every accepted
 * participant plus the event's organisers — the union of the group / other
 * channels' audiences, since a cascade speaker is heard in every channel of
 * the tree.
 */
export async function eventCascadeMemberUserIds(eventId: string, db: Queryable = pool): Promise<string[]> {
  return [...cascadeAudience(await loadEventAudience(eventId, db))];
}

/**
 * Is `userId` allowed on this channel? Org channels open to everyone
 * (threshold 0): always true here (callers check org membership). A
 * rank-restricted org channel: its visibility audience.
 */
export async function canUseChannel(scope: ChannelScope, userId: string, db: Queryable = pool): Promise<boolean> {
  if (scope.scope === 'org' && !(scope.minLevel > 0)) return true;
  return (await channelMemberUserIds(scope, db)).includes(userId);
}

/** Is `userId` a commander of the event (events.commander_user_id or an accepted is_commander role)? */
export async function isEventCommander(eventId: string, userId: string, db: Queryable = pool): Promise<boolean> {
  return (await loadEventAudience(eventId, db)).commanders.has(userId);
}

/**
 * OPTREE: per-channel annotations for the channel list (channelController
 * listChannels → the strip's event tree). For each event channel among `rows`:
 *   event_name, event_kind ('group' | 'frequency' | 'other'), event_group_id,
 *   can_join (the rule above, for `userId`), is_my_group (an accepted member
 *   of that group). Org channels are returned unchanged. One audience load per
 *   event, not per channel.
 */
export async function annotateEventChannels<T extends { id: string; event_id?: string | null }>(
  rows: T[], userId: string, db: Queryable = pool,
): Promise<(T & Record<string, unknown>)[]> {
  const eventIds = [...new Set(rows.map((r) => r.event_id).filter(Boolean) as string[])];
  if (eventIds.length === 0) return rows;
  const info = await db.query(
    `SELECT c.id, COALESCE(c.is_frequency, false) AS is_frequency, e.name AS event_name,
            (SELECT eg.id FROM event_groups eg WHERE eg.channel_id = c.id LIMIT 1) AS group_id,
            (SELECT ef.id FROM event_frequencies ef WHERE ef.channel_id = c.id
              ORDER BY ef.is_leadership DESC LIMIT 1) AS frequency_id
     FROM channels c JOIN events e ON e.id = c.event_id
     WHERE c.event_id = ANY($1::uuid[])`,
    [eventIds],
  );
  const byId = new Map<string, any>(info.rows.map((r: any) => [r.id, r]));
  const audiences = new Map<string, EventAudience>();
  for (const id of eventIds) audiences.set(id, await loadEventAudience(id, db));
  return rows.map((r) => {
    if (!r.event_id) return r;
    const row = byId.get(r.id);
    const a = audiences.get(r.event_id);
    if (!row || !a) return r;
    const kind = classifyEventChannel(row);
    const scope = { kind, groupId: row.group_id ?? null, frequencyId: row.frequency_id ?? null };
    return {
      ...r,
      event_name: row.event_name ?? null,
      event_kind: kind,
      event_group_id: row.group_id ?? null,
      can_join: audienceFor(scope, a).has(userId),
      is_my_group: Boolean(row.group_id && a.groupMembers.get(row.group_id)?.has(userId)),
    };
  });
}

/**
 * Op-wide screen share (frequency co-members). During a LAUNCHED op a share in
 * an event GROUP channel is encrypted with a key exported from the event MLS
 * group (ensureEventGroup, label OP_VIDEO_KEY_LABEL) instead of the group
 * channel's own 'video' key, and uploaded once. Who may receive it:
 *   - the sharer's group channel (the ordinary ticket, unchanged), and
 *   - anyone who shares a frequency of that op with the sharer: a
 *     video_subscribe ticket requested against a FREQUENCY channel is minted
 *     for the sharer's group channel, with the `sharer` claim pinned to that
 *     sharer (media-rust refuses a subscribe whose sharer/channel/role differ
 *     from the claims, and voice needs purpose media_voice) — so it watches
 *     that one stream and can't talk, publish or watch anyone else.
 * Frequency membership is the whitelist (audienceFor(frequency)) — the same
 * rule as its key; a commander/organiser not on it can't watch through it.
 */
export const OP_VIDEO_KEY_LABEL = 'video-op';

/** Do `x` and `y` share any frequency of this op? Pure. */
export function sharesAFrequency(a: EventAudience, x: string, y: string): boolean {
  for (const frequencyId of a.frequencyMembers.keys()) {
    const aud = audienceFor({ kind: 'frequency', groupId: null, frequencyId }, a);
    if (aud.has(x) && aud.has(y)) return true;
  }
  return false;
}

export type FrequencyShareDecision = { ok: true; groupId: string } | { ok: false; reason: string };

/**
 * May `viewerId` get a ticket for `sharerId`'s stream through a frequency?
 * Only a plain video_subscribe, only while the op is live, only for a sharer
 * who is an accepted member of one of its groups (that group's channel is
 * where the stream lives; several → the lowest id, deterministic). Pure.
 */
export function frequencyShareAccess(
  a: EventAudience, viewerId: string, sharerId: string | null,
  opts: { kind: string; live: boolean },
): FrequencyShareDecision {
  if (opts.kind !== 'video_subscribe') return { ok: false, reason: 'Only screen-share viewing is available across frequencies' };
  if (!opts.live) return { ok: false, reason: 'The operation is not live' };
  if (!sharerId || sharerId === viewerId) return { ok: false, reason: 'Unknown sharer' };
  if (!sharesAFrequency(a, viewerId, sharerId)) return { ok: false, reason: 'You do not share a frequency with this sharer' };
  const groups = [...a.groupMembers].filter(([, m]) => m.has(sharerId)).map(([g]) => g).sort();
  if (groups.length === 0) return { ok: false, reason: 'Sharer is not in a group of this operation' };
  return { ok: true, groupId: groups[0] };
}

/**
 * The DB side of frequencyShareAccess: resolves the sharer's callsign (an
 * org member) and returns the group channel to mint the ticket for.
 */
export async function resolveFrequencyShare(
  orgId: string, eventId: string, viewerId: string, sharerCallsign: string, kind: string, db: Queryable = pool,
): Promise<{ ok: true; groupChannelId: string } | { ok: false; reason: string }> {
  const ev = await db.query(`SELECT launched, ended_at FROM events WHERE id = $1 AND org_id = $2`, [eventId, orgId]);
  const live = Boolean(ev.rows[0]?.launched && !ev.rows[0]?.ended_at);
  const sharers = await db.query(
    `SELECT u.id FROM users u JOIN org_members om ON om.user_id = u.id AND om.org_id = $2 WHERE u.callsign = $1`,
    [sharerCallsign, orgId],
  );
  const a = await loadEventAudience(eventId, db);
  let reason = 'Unknown sharer';
  for (const r of sharers.rows) {
    const d = frequencyShareAccess(a, viewerId, r.id, { kind, live });
    if (!d.ok) { reason = d.reason; continue; }
    const g = await db.query(`SELECT channel_id FROM event_groups WHERE id = $1 AND event_id = $2`, [d.groupId, eventId]);
    if (g.rows[0]?.channel_id) return { ok: true, groupChannelId: String(g.rows[0].channel_id) };
    reason = 'Sharer group has no channel';
  }
  return { ok: false, reason };
}
