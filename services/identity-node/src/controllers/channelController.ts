import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { publishEvent } from '../config/nats.js';
import { adultAvailableForIp, adultRegionRefusal, hasAttested, ADULT_UNAVAILABLE_IN_REGION, ADULT_ATTESTATION_REQUIRED } from '../utils/adultAccess.js'; // L11
import { getChannelScope, canUseChannel, annotateEventChannels } from '../utils/eventChannelAccess.js'; // EVMLS / OPTREE
import { getOrgAuthority, canSeeOrgChannel, has } from '../utils/orgAuthority.js';
import { TEXT_LIMITS, tooLong } from '../utils/validation.js';
import { watchAudience } from '../utils/audienceNarrowing.js'; // B3

// In-memory channel presence: channelId → Map<userId, callsign>
// Seeded from channel_subscriptions on startup and kept in sync by join/leave.
export const channelPresence = new Map<string, Map<string, string>>();

// Expire ghost channel presence when clients crash/force-close and miss explicit leave.
const STALE_PRESENCE_SECONDS = 90;
let presenceSweepStarted = false;

const startPresenceSweeper = () => {
  if (presenceSweepStarted) return;
  presenceSweepStarted = true;

  setInterval(async () => {
    try {
      const stale = await pool.query(
        `DELETE FROM channel_subscriptions
         WHERE joined_at < NOW() - ($1::int * INTERVAL '1 second')
         RETURNING org_id, channel_id, user_id`,
        [STALE_PRESENCE_SECONDS]
      );
      if (!stale.rowCount) return;

      const touched = new Set<string>(); // orgId:channelId
      for (const row of stale.rows as Array<{ org_id: string; channel_id: string; user_id: string }>) {
        const map = channelPresence.get(row.channel_id);
        if (map) {
          map.delete(row.user_id);
          if (map.size === 0) channelPresence.delete(row.channel_id);
        }
        touched.add(`${row.org_id}:${row.channel_id}`);
      }

      for (const key of touched) {
        const [orgId, channelId] = key.split(':');
        const occupants = Array.from(channelPresence.get(channelId)?.values() ?? []);
        await publishEvent(`specter.event.org.${orgId}`, {
          type: 'channel_presence_changed',
          channelId,
          occupants,
        });
      }
    } catch (err) {
      console.error('[channelController] presence sweeper error:', err);
    }
  }, 30_000);
};

startPresenceSweeper();

// ── Startup: clear stale presence ─────────────────────────────────────────────
// channel_subscriptions is ephemeral — it only reflects live WebTransport
// sessions.  On auth restart every existing row is stale (the SFU dropped all
// connections), so we wipe the table and start clean.  Connected clients will
// re-register themselves via joinChannelPresence once their session resumes.
export const seedPresenceFromDb = async (): Promise<void> => {
  try {
    const del = await pool.query(`DELETE FROM channel_subscriptions`);
    console.log(`[channelController] Cleared ${del.rowCount} stale channel subscriptions on startup.`);
  } catch (err) {
    console.error('[channelController] Failed to clear stale channel subscriptions:', err);
  }
};

interface CreateChannelInput {
  name: string;
  type?: number;       // 0=Public, 1=Private
  kind?: number;       // 0=Voice, 1=Text
  min_tier?: number;
  ducking_level?: number;
  event_id?: string;
}

/** undefined = invalid; missing/null = 0 (everyone). */
const parseVisibleMinLevel = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : undefined;
};

export const createChannel = async (req: AuthRequest, res: Response) => {
  const { orgId } = req.params;
  const { name, type, kind, min_tier, ducking_level, event_id } = req.body as CreateChannelInput;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  // Basic validation
  if (!name || (typeof name === 'string' && !name.trim())) {
    return res.status(400).json({ message: 'Channel name is required' });
  }
  const nameLimitErr = tooLong('Channel name', name, TEXT_LIMITS.channelName);
  if (nameLimitErr) return res.status(400).json({ message: nameLimitErr });

  try {
    // Permission check: owner or role with can_manage_channels
    const ownerRes = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
    if (ownerRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    const actor = await getOrgAuthority(String(orgId), userId);
    if (!has(actor, 'can_manage_channels')) return res.status(403).json({ message: 'Forbidden: Cannot manage channels' });

    // Visibility: a non-owner can't restrict a channel above their own rank
    // (they'd lock themselves out of it).
    const visibleMinLevel = parseVisibleMinLevel((req.body as any)?.visible_min_level);
    if (visibleMinLevel === undefined) return res.status(400).json({ message: 'visible_min_level must be a whole number from 0' });
    if (!canSeeOrgChannel(actor, visibleMinLevel)) {
      return res.status(403).json({ message: 'Forbidden: Cannot restrict a channel above your own rank' });
    }

    // L11: the adult flag is only offered where adult channels are available.
    const wantAdult = (req.body as any)?.is_adult === true && !event_id;
    if (wantAdult && !(await adultAvailableForIp(req.ip))) {
      return res.status(403).json({ message: 'Adult channels are not available in your region', code: ADULT_UNAVAILABLE_IN_REGION });
    }

    const result = await pool.query(
      `INSERT INTO channels (org_id, name, type, channel_kind, min_tier, ducking_level, event_id, visible_min_level, is_adult)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [orgId, name, type || 0, kind ?? 0, min_tier || 0, ducking_level || 0.0, event_id || null, visibleMinLevel, wantAdult]
    );
    if (wantAdult) {
      await pool.query('INSERT INTO adult_channel_audit (org_id, channel_id, actor_id, is_adult) VALUES ($1, $2, $3, true)', [orgId, result.rows[0].id, userId]);
    }

    const channel = result.rows[0];
    // Clients only refetch on this; a restricted channel's details stay off
    // the org-wide stream (lower ranks get just the refetch nudge).
    if (visibleMinLevel > 0 || wantAdult) {
      await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_created', channelId: channel.id });
    } else {
      await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_created', channel });
    }
    res.status(201).json(channel);
  } catch (error: any) {
    console.error('Error creating channel:', error);
    res.status(500).json({ message: 'Server error creating channel' });
  }
};

export const listChannels = async (req: AuthRequest, res: Response) => {
  const { orgId } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM channels WHERE org_id = $1 AND COALESCE(is_frequency, false) = false ORDER BY created_at ASC`,
      [orgId]
    );

    // Visibility (owner, 2026-11-08): a rank-restricted channel is hidden from
    // members below its threshold (utils/orgAuthority canSeeOrgChannel).
    const viewer = req.user?.id ? await getOrgAuthority(String(orgId), req.user.id) : { isOwner: false, level: 0 };
    let visibleRows = result.rows.filter((ch: any) => ch.event_id || canSeeOrgChannel(viewer, ch.visible_min_level));

    // L11: adult channels. Where the feature is unavailable for this requester
    // (kill switch, restricted or unknown region) they are hidden entirely;
    // otherwise an unattested member sees a locked entry, with no occupants.
    const adultAvailable = await adultAvailableForIp(req.ip);
    const attested = adultAvailable && req.user?.id && visibleRows.some((ch: any) => ch.is_adult)
      ? await hasAttested(String(orgId), req.user.id) : false;
    visibleRows = visibleRows.filter((ch: any) => !ch.is_adult || adultAvailable);

    // Attach real-time occupant list from in-memory presence store
    let channels: any[] = visibleRows.map((ch: any) => (ch.is_adult && !attested
      ? { ...ch, occupants: [], adult_locked: true }
      : { ...ch, occupants: Array.from(channelPresence.get(ch.id)?.values() ?? []) }));

    // OPTREE: event channels carry who may join them (the shared rule in
    // utils/eventChannelAccess — the same one the media ticket enforces) and
    // their place in the event (event_name, event_kind, event_group_id,
    // can_join, is_my_group), so the strip can show a launched event as one
    // tree. Computed per request for req.user: nothing here is cached, and the
    // org-wide channel_created event only makes clients refetch this. A
    // failure here only costs the annotations, never the list.
    const userId = req.user?.id;
    if (userId && channels.some((c) => c.event_id)) {
      try {
        channels = await annotateEventChannels(channels, userId);
        // A sign-up still awaiting approval isn't a member (no ticket, no key),
        // but its group must not read as somebody else's: the strip says why.
        const pending = await pool.query(
          `SELECT eg.channel_id FROM event_group_members egm
           JOIN event_groups eg ON eg.id = egm.group_id
           WHERE egm.user_id = $1 AND egm.status = 'pending' AND eg.channel_id = ANY($2::uuid[])`,
          [userId, channels.filter((c) => c.event_id).map((c) => c.id)],
        );
        const pendingIds = new Set(pending.rows.map((r: any) => r.channel_id));
        if (pendingIds.size > 0) channels = channels.map((c) => (pendingIds.has(c.id) ? { ...c, my_signup_pending: true } : c));
      } catch (err) {
        console.error('Error annotating event channels:', err);
      }
    }

    res.json({ channels, adult_available: adultAvailable });
  } catch (error: any) {
    console.error('Error listing channels:', error);
    res.status(500).json({ message: 'Server error listing channels' });
  }
};

export const joinChannelPresence = async (req: AuthRequest, res: Response) => {
  const orgId = req.params.orgId as string;
  const channelId = req.params.channelId as string;
  const userId = req.user?.id;
  const callsign = req.user?.callsign;
  if (!userId || !callsign) return res.status(401).json({ message: 'Unauthorized' });

  try {
    // Verify channel exists in this org and classify it (org / event channel)
    const scope = await getChannelScope(channelId, orgId);
    if (!scope) return res.status(404).json({ message: 'Channel not found' });

    // L11: adult channel: region first, then the member's 18+ attestation.
    const adultNo = await adultRegionRefusal(scope, req.ip);
    if (adultNo) return res.status(403).json(adultNo);
    if (scope.scope === 'org' && scope.adult && !(await hasAttested(orgId, userId))) {
      return res.status(403).json({ message: '18+ channel: confirm your age to enter', code: ADULT_ATTESTATION_REQUIRED });
    }

    // ── Event channel access enforcement ─────────────────────────────────────
    // EVMLS: the shared rule (utils/eventChannelAccess) — signed-up members
    // with access to this channel (+ the event's staff on command/frequency
    // channels), whatever the event's access_mode.
    if (!(await canUseChannel(scope, userId))) {
      return res.status(403).json({
        message: scope.scope === 'org' ? 'Forbidden: this channel is restricted to higher ranks'
          : scope.kind === 'group' ? 'Forbidden: not confirmed for this group channel' : 'Forbidden: not assigned to this channel',
      });
    }

    // ── Evict user from any other channel in this org (one channel at a time) ─
    const prevSub = await pool.query(
      `SELECT channel_id FROM channel_subscriptions WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId]
    );
    if (prevSub.rowCount && prevSub.rows[0].channel_id !== channelId) {
      const oldChannelId: string = prevSub.rows[0].channel_id;
      // Remove from old in-memory slot
      const oldMap = channelPresence.get(oldChannelId);
      if (oldMap) {
        oldMap.delete(userId);
        if (oldMap.size === 0) channelPresence.delete(oldChannelId);
      }
      // Broadcast departure from old channel
      await publishEvent(`specter.event.org.${orgId}`, {
        type: 'channel_presence_changed',
        channelId: oldChannelId,
        occupants: oldMap ? Array.from(oldMap.values()) : [],
      });
    }

    // ── Persist subscription ───────────────────────────────────────────────────
    await pool.query(
      `INSERT INTO channel_subscriptions (channel_id, user_id, org_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, org_id) DO UPDATE
         SET channel_id = EXCLUDED.channel_id,
             joined_at  = NOW()`,
      [channelId, userId, orgId]
    );

    // ── Update in-memory map ───────────────────────────────────────────────────
    if (!channelPresence.has(channelId)) channelPresence.set(channelId, new Map());
    channelPresence.get(channelId)!.set(userId, callsign);

    const occupants = Array.from(channelPresence.get(channelId)!.values());
    await publishEvent(`specter.event.org.${orgId}`, {
      type: 'channel_presence_changed',
      channelId,
      occupants,
    });

    res.json({ ok: true, occupants });
  } catch (err: any) {
    console.error('Error joining channel presence:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const leaveChannelPresence = async (req: AuthRequest, res: Response) => {
  const orgId = req.params.orgId as string;
  const channelId = req.params.channelId as string;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  await evictUserPresence(userId, orgId, channelId);

  const occupants = Array.from(channelPresence.get(channelId)?.values() ?? []);
  res.json({ ok: true, occupants });
};

// Presence heartbeat: refreshes joined_at without forcing noisy join/leave churn.
export const pingChannelPresence = async (req: AuthRequest, res: Response) => {
  const orgId = req.params.orgId as string;
  const channelId = req.params.channelId as string;
  const userId = req.user?.id;
  const callsign = req.user?.callsign;
  if (!userId || !callsign) return res.status(401).json({ message: 'Unauthorized' });

  try {
    await pool.query(
      `INSERT INTO channel_subscriptions (channel_id, user_id, org_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, org_id) DO UPDATE
         SET channel_id = EXCLUDED.channel_id,
             joined_at  = NOW()`,
      [channelId, userId, orgId]
    );

    if (!channelPresence.has(channelId)) channelPresence.set(channelId, new Map());
    channelPresence.get(channelId)!.set(userId, callsign);

    const occupants = Array.from(channelPresence.get(channelId)?.values() ?? []);
    res.json({ ok: true, occupants });
  } catch (err: any) {
    // 23503 = foreign_key_violation. In practice this means channelId belongs
    // to a channel that's since been deleted (client still had a stale ref
    // from a session that predates the delete) — a client-fixable 404, not a
    // server fault. Logging it at full error severity every 20s forever (this
    // is a presence heartbeat) was also just log spam for an expected case.
    if (err?.code === '23503') {
      return res.status(404).json({ message: 'Channel not found' });
    }
    console.error('Error pinging channel presence:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Internal helper: evict a single user from presence ───────────────────────
// Called by both leaveChannelPresence (HTTP) and the NATS session_end consumer
// (SFU disconnect).  Safe to call with a stale channelId — the DB delete is
// narrowed to (user_id, org_id, channel_id) so it can't corrupt a re-join.
export const evictUserPresence = async (
  userId: string,
  orgId: string,
  channelId: string,
): Promise<void> => {
  try {
    await pool.query(
      `DELETE FROM channel_subscriptions
       WHERE user_id = $1 AND org_id = $2 AND channel_id = $3`,
      [userId, orgId, channelId]
    );
  } catch (err) {
    console.error('[channelController] evictUserPresence DB error:', err);
  }

  const map = channelPresence.get(channelId);
  if (map) {
    map.delete(userId);
    if (map.size === 0) channelPresence.delete(channelId);
  }

  const occupants = map ? Array.from(map.values()) : [];
  await publishEvent(`specter.event.org.${orgId}`, {
    type: 'channel_presence_changed',
    channelId,
    occupants,
  });
};

// ── Internal helper: move a batch of users to a new channel ──────────────────
// Used by endOperation for lobby and debrief moves.
export const bulkMoveUsers = async (
  orgId: string,
  fromChannelIds: string[],
  toChannelId: string,
  toChannelName: string,
): Promise<void> => {
  if (!fromChannelIds.length) return;

  // Fetch all subscribed users across the source channels
  const subs = await pool.query(
    `SELECT cs.user_id, cs.channel_id, u.callsign
     FROM channel_subscriptions cs
     JOIN users u ON cs.user_id = u.id
     WHERE cs.channel_id = ANY($1::uuid[])`,
    [fromChannelIds]
  );
  if (!subs.rowCount) return;

  // Update all subscriptions in one shot
  const userIds: string[] = subs.rows.map((r: any) => r.user_id);
  await pool.query(
    `INSERT INTO channel_subscriptions (channel_id, user_id, org_id)
     SELECT $1, unnest($2::uuid[]), $3
     ON CONFLICT (user_id, org_id) DO UPDATE
       SET channel_id = EXCLUDED.channel_id, joined_at = NOW()`,
    [toChannelId, userIds, orgId]
  );

  // Update in-memory presence: remove from old channels, add to new
  const affectedOldChannels = new Set<string>();
  for (const row of subs.rows) {
    const oldMap = channelPresence.get(row.channel_id);
    if (oldMap) {
      oldMap.delete(row.user_id);
      if (oldMap.size === 0) channelPresence.delete(row.channel_id);
    }
    affectedOldChannels.add(row.channel_id);

    if (!channelPresence.has(toChannelId)) channelPresence.set(toChannelId, new Map());
    channelPresence.get(toChannelId)!.set(row.user_id, row.callsign);
  }

  // Broadcast presence updates
  const toOccupants = Array.from(channelPresence.get(toChannelId)?.values() ?? []);
  const broadcasts: Promise<void>[] = [
    publishEvent(`specter.event.org.${orgId}`, {
      type: 'channel_presence_changed',
      channelId: toChannelId,
      occupants: toOccupants,
    }),
  ];
  for (const oldId of affectedOldChannels) {
    const oldOccupants = Array.from(channelPresence.get(oldId)?.values() ?? []);
    broadcasts.push(
      publishEvent(`specter.event.org.${orgId}`, {
        type: 'channel_presence_changed',
        channelId: oldId,
        occupants: oldOccupants,
      })
    );
  }
  await Promise.all(broadcasts);
};

export const deleteChannel = async (req: AuthRequest, res: Response) => {
  const { orgId, channelId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  try {
    // Permission check: owner or role with can_manage_channels
    const ownerRes = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
    if (ownerRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    const actor = await getOrgAuthority(String(orgId), userId);
    if (!has(actor, 'can_manage_channels')) return res.status(403).json({ message: 'Forbidden: Cannot manage channels' });

    // Check if channel exists and belongs to org
    const checkRes = await pool.query(
      `SELECT c.id, COALESCE(e.launched, false) AS launched, COALESCE(c.visible_min_level, 0) AS visible_min_level,
              (e.command_channel_id = c.id
                OR EXISTS (SELECT 1 FROM event_groups eg WHERE eg.channel_id = c.id)
                OR COALESCE(c.is_frequency, false)) AS generated
       FROM channels c LEFT JOIN events e ON e.id = c.event_id
       WHERE c.id = $1 AND c.org_id = $2`,
      [channelId, orgId],
    );

    // A channel hidden from you (above your rank) doesn't exist, as far as you can tell.
    if (checkRes.rows.length === 0 || !canSeeOrgChannel(actor, checkRes.rows[0].visible_min_level)) {
      return res.status(404).json({ message: 'Channel not found' });
    }
    // OPTREE: the command / group / frequency channels of a running operation
    // belong to it — deleting one by hand left ops "launched" with no command
    // channel (command_channel_id SET NULL) and a broken tree. End the
    // operation instead; that removes them all.
    if (checkRes.rows[0].launched && checkRes.rows[0].generated) {
      return res.status(409).json({ message: 'This channel belongs to a running operation — end the operation to remove it' });
    }

    // Perform deletion
    await pool.query('DELETE FROM channels WHERE id = $1', [channelId]);

    await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_deleted', channelId });
    res.json({ message: 'Channel deleted successfully', id: channelId });
  } catch (error: any) {
    console.error('Error deleting channel:', error);
    res.status(500).json({ message: 'Server error deleting channel' });
  }
};

/**
 * PUT /orgs/:orgId/channels/:channelId  { name?, visible_min_level? }
 * Rename a channel or change who can see it (owner, 2026-11-08: channel
 * visibility is set by someone with channel-admin authority). Same rules as
 * create: can_manage_channels, and a non-owner can neither touch a channel
 * above their rank nor restrict one above it. Event channels belong to their
 * operation and aren't edited here.
 */
export const updateChannel = async (req: AuthRequest, res: Response) => {
  const orgId = String(req.params.orgId);
  const channelId = String(req.params.channelId);
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'User not authenticated' });
  const body = (req.body || {}) as { name?: unknown; visible_min_level?: unknown; is_adult?: unknown };

  let name: string | null = null;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return res.status(400).json({ message: 'Channel name is required' });
    const err = tooLong('Channel name', body.name, TEXT_LIMITS.channelName);
    if (err) return res.status(400).json({ message: err });
    name = body.name.trim();
  }
  let level: number | null = null;
  if (body.visible_min_level !== undefined) {
    const v = parseVisibleMinLevel(body.visible_min_level);
    if (v === undefined) return res.status(400).json({ message: 'visible_min_level must be a whole number from 0' });
    level = v;
  }
  let adult: boolean | null = null;
  if (body.is_adult !== undefined) {
    if (typeof body.is_adult !== 'boolean') return res.status(400).json({ message: 'is_adult must be true or false' });
    adult = body.is_adult;
  }
  if (name === null && level === null && adult === null) return res.status(400).json({ message: 'Nothing to change' });

  try {
    const actor = await getOrgAuthority(orgId, userId);
    if (!has(actor, 'can_manage_channels')) return res.status(403).json({ message: 'Forbidden: Cannot manage channels' });
    const cur = await pool.query(
      `SELECT id, event_id, COALESCE(is_frequency, false) AS is_frequency, COALESCE(visible_min_level, 0) AS visible_min_level
       FROM channels WHERE id = $1 AND org_id = $2`,
      [channelId, orgId],
    );
    const row = cur.rows[0];
    if (!row || !canSeeOrgChannel(actor, row.visible_min_level)) return res.status(404).json({ message: 'Channel not found' });
    if (row.event_id || row.is_frequency) return res.status(409).json({ message: 'Operation channels are managed by their operation' });
    if (level !== null && !canSeeOrgChannel(actor, level)) {
      return res.status(403).json({ message: 'Forbidden: Cannot restrict a channel above your own rank' });
    }

    // L11: turning the flag ON needs availability in the actor's region (turning
    // it off never does). Hidden/unavailable means refused, not silently ignored.
    if (adult === true && !(await adultAvailableForIp(req.ip))) {
      return res.status(403).json({ message: 'Adult channels are not available in your region', code: ADULT_UNAVAILABLE_IN_REGION });
    }

    // B3: raising the threshold drops people from the channel → re-key its group.
    const narrowing = level !== null && level > Number(row.visible_min_level)
      ? await watchAudience(orgId, { channelId })
      : null;
    const upd = await pool.query(
      `UPDATE channels SET name = COALESCE($1, name), visible_min_level = COALESCE($2, visible_min_level),
         is_adult = COALESCE($5, is_adult)
       WHERE id = $3 AND org_id = $4 RETURNING *`,
      [name, level, channelId, orgId, adult],
    );
    const channel = upd.rows[0];
    if (adult !== null) {
      await pool.query('INSERT INTO adult_channel_audit (org_id, channel_id, actor_id, is_adult) VALUES ($1, $2, $3, $4)', [orgId, channelId, userId, adult]);
    }
    await narrowing?.();
    // An adult channel's details stay off the org-wide stream (nudge only).
    const restricted = Number(channel.visible_min_level) > 0 || Number(row.visible_min_level) > 0 || channel.is_adult || adult !== null;
    if (restricted) {
      await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_updated', channelId });
    } else {
      await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_updated', channel });
    }
    res.json(channel);
  } catch (error: any) {
    console.error('Error updating channel:', error);
    res.status(500).json({ message: 'Server error updating channel' });
  }
};

/**
 * POST /orgs/:orgId/adult-attestation  { confirm: true }
 * L11: the member's one-time "I am 18 or older" for this server. Explicit
 * confirm required; refused where adult channels are unavailable (no row is
 * written there); idempotent.
 */
export const attestAdult = async (req: AuthRequest, res: Response) => {
  const orgId = String(req.params.orgId);
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'User not authenticated' });
  if ((req.body as any)?.confirm !== true) return res.status(400).json({ message: 'Confirm that you are 18 or older' });
  try {
    if (!(await adultAvailableForIp(req.ip))) {
      return res.status(403).json({ message: 'Adult channels are not available in your region', code: ADULT_UNAVAILABLE_IN_REGION });
    }
    const actor = await getOrgAuthority(orgId, userId);
    if (!actor.isMember) return res.status(403).json({ message: 'Not a member of this organization' });
    await pool.query(
      `INSERT INTO org_adult_attestations (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, orgId],
    );
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error recording adult attestation:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
