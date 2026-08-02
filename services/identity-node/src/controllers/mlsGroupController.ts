import { Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const submitDmCommitSchema = z.object({
  epoch: z.number().int().positive(),
  commit: z.string().max(200000), // base64
  // Present only when this Commit adds one or more new devices.
  welcome: z.string().max(500000).nullable().optional(), // base64
});

/**
 * Ensures an mls_groups row exists (a brand-new group starts at epoch 0),
 * then atomically bumps current_epoch only if `epoch` is exactly the next
 * one — the Delivery Service ordering rule (RFC 9750 §3): accept exactly
 * one Commit per epoch, so two concurrent commits can't fork the group
 * into disagreeing states. Returns false (caller should 409) on conflict.
 */
async function bumpGroupEpoch(groupId: string, epoch: number): Promise<boolean> {
  await pool.query(
    `INSERT INTO mls_groups (group_id, current_epoch) VALUES ($1, 0) ON CONFLICT (group_id) DO NOTHING`,
    [groupId],
  );
  const bump = await pool.query(
    `UPDATE mls_groups SET current_epoch = $2, updated_at = CURRENT_TIMESTAMP
     WHERE group_id = $1 AND current_epoch = $2 - 1`,
    [groupId, epoch],
  );
  return (bump.rowCount ?? 0) > 0;
}

/**
 * POST /dm/:userId/mls/commit
 * Submit an MLS Commit (optionally bundled with a Welcome) advancing a DM's
 * group to the next epoch. This is the one piece of real state this
 * otherwise content-blind relay holds (see the mls_groups migration) — MLS's
 * Delivery Service role requires accepting exactly one Commit per epoch, or
 * two concurrent commits could fork the group into disagreeing states
 * (RFC 9750 §3, "ordering server" DS). group_id here is the DM's existing
 * deterministic conversation_id (see dmController.ts), not a separate id.
 *
 * The commit (and welcome, if present) is relayed to *both* participants'
 * user-scoped subjects rather than trying to guess which side needs which:
 * a Welcome is only actionable by a device that doesn't yet hold this group
 * locally (a brand-new member, or the committer's own freshly-added second
 * device), and a Commit is only actionable by a device that already does —
 * every other recipient's attempt is a harmless no-op that the client
 * discards, same as this codebase's existing fire-and-forget relay pattern.
 */
export const submitDmCommit = async (req: AuthRequest, res: Response) => {
  const me = req.user?.id;
  const otherUserId = req.params.userId as string;
  if (!me) return res.status(401).json({ message: 'Unauthorized' });
  if (!UUID_RE.test(otherUserId)) return res.status(400).json({ message: 'Invalid userId' });
  if (me === otherUserId) return res.status(400).json({ message: 'Cannot MLS-commit with yourself' });

  const parsed = submitDmCommitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }
  const { epoch, commit, welcome } = parsed.data;

  try {
    const friendCheck = await pool.query(
      `SELECT 1 FROM friendships
       WHERE status = 1
         AND ((user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1))`,
      [me, otherUserId],
    );
    if ((friendCheck.rowCount ?? 0) === 0) {
      return res.status(403).json({ message: 'Not friends' });
    }

    const convId = [me, otherUserId].sort().join('-');

    if (!(await bumpGroupEpoch(convId, epoch))) {
      return res.status(409).json({ message: 'Epoch conflict — this commit no longer targets the current epoch' });
    }

    for (const recipientId of [me, otherUserId]) {
      await publishEvent(`specter.event.user.${recipientId}`, {
        type: 'mls_commit',
        conversation_id: convId,
        commit,
      });
      if (welcome) {
        await publishEvent(`specter.event.user.${recipientId}`, {
          type: 'mls_welcome',
          conversation_id: convId,
          welcome,
        });
      }
    }

    res.status(202).json({ ok: true, epoch });
  } catch (err) {
    console.error('submitDmCommit error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const submitChannelCommitSchema = z.object({
  epoch: z.number().int().positive(),
  commit: z.string().max(500000), // base64 — larger cap than DM's: a channel add/remove can bundle many devices
  welcome: z.string().max(2000000).nullable().optional(), // base64
  // Which user(s) this Commit's Welcome is for (empty/omitted for a plain
  // remove, or for an add that's re-syncing the committer's own second
  // device). The server can't infer this itself since it doesn't track MLS
  // group membership — only the client authoring the add knows.
  welcomed_user_ids: z.array(z.string().uuid()).max(50).optional(),
});

/**
 * POST /orgs/:orgId/channels/:chanId/mls/commit
 * Channel counterpart to submitDmCommit — group_id is the channel's own
 * UUID (channel_id), membership-gated the same way sendMessage is (any org
 * member can access any org channel by default; see messageController.ts).
 *
 * Unlike a DM, existing members already share a channel-wide NATS subject
 * (specter.msg.channel.${chanId}, subscribed via SSE for every channel in
 * every org a user belongs to) — so the Commit is published there once
 * instead of once per member. A Welcome still can't rely on that subject:
 * a brand-new member's SSE subscription list is computed once at connect
 * time (see sseController.ts), so they may not be subscribed to this
 * channel's subject until their next reconnect. It's delivered directly to
 * each welcomed user's own `specter.event.user.{id}` subject instead, which
 * every connected client is always subscribed to regardless of channel
 * membership timing.
 */
export const submitChannelCommit = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId, chanId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = submitChannelCommitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }
  const { epoch, commit, welcome, welcomed_user_ids } = parsed.data;

  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }
    const chanCheck = await pool.query(
      'SELECT 1 FROM channels WHERE id = $1 AND org_id = $2',
      [chanId, orgId],
    );
    if (chanCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    if (!(await bumpGroupEpoch(chanId as string, epoch))) {
      return res.status(409).json({ message: 'Epoch conflict — this commit no longer targets the current epoch' });
    }

    await publishEvent(`specter.msg.channel.${chanId}`, {
      type: 'mls_commit',
      channel_id: chanId,
      commit,
    });

    if (welcome && welcomed_user_ids?.length) {
      for (const recipientId of welcomed_user_ids) {
        await publishEvent(`specter.event.user.${recipientId}`, {
          type: 'mls_welcome',
          channel_id: chanId,
          welcome,
        });
      }
    }

    res.status(202).json({ ok: true, epoch });
  } catch (err) {
    console.error('submitChannelCommit error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
