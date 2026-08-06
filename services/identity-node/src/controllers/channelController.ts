import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { publishEvent } from '../config/nats.js';

// In-memory channel presence: channelId → Map<userId, callsign>
// Seeded from channel_subscriptions on startup and kept in sync by join/leave.
const channelPresence = new Map<string, Map<string, string>>();

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

export const createChannel = async (req: AuthRequest, res: Response) => {
  const { orgId } = req.params;
  const { name, type, kind, min_tier, ducking_level, event_id } = req.body as CreateChannelInput;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  // Basic validation
  if (!name) {
    return res.status(400).json({ message: 'Channel name is required' });
  }

  try {
    // Permission check: owner or role with can_manage_channels
    const ownerRes = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
    if (ownerRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    const isOwner = ownerRes.rows[0].owner_id === userId;
    if (!isOwner) {
      const permRes = await pool.query(
        `SELECT r.permissions FROM org_members om JOIN org_roles r ON om.role_id = r.id WHERE om.org_id = $1 AND om.user_id = $2`,
        [orgId, userId]
      );
      const canManage = permRes.rows.some((r: any) => r.permissions?.can_manage_channels === true);
      if (!canManage) return res.status(403).json({ message: 'Forbidden: Cannot manage channels' });
    }

    const result = await pool.query(
      `INSERT INTO channels (org_id, name, type, channel_kind, min_tier, ducking_level, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [orgId, name, type || 0, kind ?? 0, min_tier || 0, ducking_level || 0.0, event_id || null]
    );

    const channel = result.rows[0];
    await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_created', channel });
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

    // Attach real-time occupant list from in-memory presence store
    const channels = result.rows.map((ch: any) => ({
      ...ch,
      occupants: Array.from(channelPresence.get(ch.id)?.values() ?? []),
    }));

    res.json({ channels });
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
    // Verify channel exists in this org and fetch event context (if any)
    const chk = await pool.query(
      `SELECT c.id, c.event_id, COALESCE(c.is_frequency, false) AS is_frequency,
              e.access_mode, e.command_channel_id
       FROM channels c
       LEFT JOIN events e ON c.event_id = e.id
       WHERE c.id = $1 AND c.org_id = $2`,
      [channelId, orgId]
    );
    if (!chk.rowCount) return res.status(404).json({ message: 'Channel not found' });

    const { event_id, access_mode, is_frequency, command_channel_id } = chk.rows[0];
    const isEventChannel = !!event_id;
    const isCommandChannel = isEventChannel && channelId === command_channel_id;
    const isGroupChannel = isEventChannel && !isCommandChannel && !is_frequency;

    // ── Event channel access enforcement ─────────────────────────────────────
    // Group channels are always assignment-locked: user must be accepted in the
    // exact group that owns this channel.
    if (isGroupChannel) {
      const groupCheck = await pool.query(
        `SELECT 1 FROM event_group_members egm
         JOIN event_groups eg ON egm.group_id = eg.id
         WHERE eg.channel_id = $1 AND egm.user_id = $2 AND egm.status = 'accepted'
         LIMIT 1`,
        [channelId, userId]
      );
      if (!groupCheck.rowCount)
        return res.status(403).json({ message: 'Forbidden: not confirmed for this group channel' });
    }

    // Restricted command/frequency channels keep elevated access rules.
    if (isEventChannel && access_mode === 'restricted' && !isGroupChannel) {
      const accessCheck = await pool.query(
        `SELECT 1 FROM event_group_members egm
         JOIN event_groups eg ON egm.group_id = eg.id
         WHERE eg.channel_id = $1 AND egm.user_id = $2 AND egm.status = 'accepted'
         UNION
         SELECT 1 FROM events WHERE id = $3 AND commander_user_id = $4
         UNION
         SELECT 1 FROM event_planners WHERE event_id = $3 AND user_id = $4
         LIMIT 1`,
        [channelId, userId, event_id, userId]
      );
      if (!accessCheck.rowCount)
        return res.status(403).json({ message: 'Forbidden: not assigned to this channel' });
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
    const isOwner = ownerRes.rows[0].owner_id === userId;
    if (!isOwner) {
      const permRes = await pool.query(
        `SELECT r.permissions FROM org_members om JOIN org_roles r ON om.role_id = r.id WHERE om.org_id = $1 AND om.user_id = $2`,
        [orgId, userId]
      );
      const canManage = permRes.rows.some((r: any) => r.permissions?.can_manage_channels === true);
      if (!canManage) return res.status(403).json({ message: 'Forbidden: Cannot manage channels' });
    }

    // Check if channel exists and belongs to org
    const checkRes = await pool.query('SELECT id FROM channels WHERE id = $1 AND org_id = $2', [channelId, orgId]);
    
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ message: 'Channel not found' });
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
