import { Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { getChannelScope, channelMemberUserIds, eventCascadeMemberUserIds } from '../utils/eventChannelAccess.js'; // EVMLS

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// MR1: the GroupInfo (with ratchet tree) for the epoch a commit produces. The
// tree grows with the group (~0.5 KB per device), hence the generous cap.
const groupInfoField = z.string().max(4000000).nullable().optional(); // base64

const submitDmCommitSchema = z.object({
  epoch: z.number().int().positive(),
  commit: z.string().max(200000), // base64
  // Present only when this Commit adds one or more new devices.
  welcome: z.string().max(500000).nullable().optional(), // base64
  group_info: groupInfoField,
});

/**
 * Ensures an mls_groups row exists (a brand-new group starts at epoch 0),
 * then atomically bumps current_epoch only if `epoch` is exactly the next
 * one — the Delivery Service ordering rule (RFC 9750 §3): accept exactly
 * one Commit per epoch, so two concurrent commits can't fork the group
 * into disagreeing states. Returns false (caller should 409) on conflict.
 *
 * Also durably logs the commit/welcome into mls_commit_log in the same
 * transaction as the epoch bump — see that migration's doc comment for why:
 * mls_commit/mls_welcome are relayed over plain NATS core pub/sub with no
 * replay, so without this a device that isn't connected at the exact
 * publish instant (a new install, a migrated machine, anyone who was
 * offline) loses that Commit/Welcome forever and can never catch up. The
 * catch-up endpoints below read this log back.
 *
 * MR1: `groupInfo` (the GroupInfo for the epoch this commit produces) is
 * stored in the same UPDATE as the bump, so the served GroupInfo can never
 * be ahead of or behind the epoch it claims. A commit without one (an older
 * client) leaves group_info_epoch behind current_epoch — that GroupInfo is
 * then stale and not served until a member re-uploads (putGroupInfo).
 */
async function bumpGroupEpoch(
  groupId: string,
  epoch: number,
  commit: string,
  welcome: string | null | undefined,
  welcomedUserIds: string[] | undefined,
  groupInfo?: string | null,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO mls_groups (group_id, current_epoch) VALUES ($1, 0) ON CONFLICT (group_id) DO NOTHING`,
      [groupId],
    );
    const bump = await client.query(
      `UPDATE mls_groups SET current_epoch = $2, updated_at = CURRENT_TIMESTAMP,
              group_info = CASE WHEN $3::bytea IS NULL THEN group_info ELSE $3::bytea END,
              group_info_epoch = CASE WHEN $3::bytea IS NULL THEN group_info_epoch ELSE $2 END
       WHERE group_id = $1 AND current_epoch = $2 - 1`,
      [groupId, epoch, groupInfo ? Buffer.from(groupInfo, 'base64') : null],
    );
    if ((bump.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO mls_commit_log (group_id, epoch, commit, welcome, welcomed_user_ids)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id, epoch) DO NOTHING`,
      [
        groupId,
        epoch,
        Buffer.from(commit, 'base64'),
        welcome ? Buffer.from(welcome, 'base64') : null,
        welcomedUserIds?.length ? welcomedUserIds : null,
      ],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reads mls_commit_log back for a device catching up on a group it doesn't yet
 * hold locally (or hasn't kept live). Returns this user's entry-point Welcome
 * (the earliest commit that actually welcomed them) plus **every** commit in the
 * group, for the client to replay via process_commit.
 *
 * `welcome: null` means this user has never been welcomed into this group at all
 * yet (nothing to catch up on until some existing member's next reconcile pass
 * adds them) — but commits are still returned, because a device may hold the
 * group already without this user ever having been welcomed to it: the device
 * that *created* the group via genesis is exactly that case.
 *
 * This deliberately does NOT filter to commits after the Welcome, which it used
 * to. `welcomed_user_ids` is per-*user*, not per-device, so on an account with
 * two devices the Welcome minted for device B became device A's anchor too — and
 * device A, already a member, was then handed zero commits and could never
 * advance. Observed in production: a device created a channel's group (epoch 1,
 * welcoming every other member), another member's reconcile pass then committed
 * epoch 2 to add that same account's second device, and the creator was pinned
 * at epoch 1 forever while everyone else moved to 2. Since export_secret is
 * epoch-derived, its media key silently stopped matching the channel's and no
 * amount of re-deriving could fix it, because syncChannelGroupEpoch had nothing
 * to apply.
 *
 * Returning everything is safe: the client applies each commit inside its own
 * try/catch (see catchUpGroup in mlsSession.js) and discards any that are
 * already applied or not actionable from its current epoch, which is precisely
 * what a commit from before its join looks like. Being liberal here and letting
 * the client decide is strictly more robust than the server guessing which
 * commits a given device still needs — the server cannot know, since it holds no
 * per-device epoch state.
 */
async function fetchGroupCatchUp(groupId: string, userId: string) {
  const result = await pool.query(
    `SELECT epoch, commit, welcome, welcomed_user_ids FROM mls_commit_log
     WHERE group_id = $1 ORDER BY epoch ASC`,
    [groupId],
  );
  let welcome: { epoch: number; welcome: string } | null = null;
  const commits: { epoch: number; commit: string }[] = [];
  for (const row of result.rows) {
    if (!welcome && row.welcome && ((row.welcomed_user_ids ?? []) as string[]).includes(userId)) {
      welcome = { epoch: Number(row.epoch), welcome: (row.welcome as Buffer).toString('base64') };
    }
    commits.push({ epoch: Number(row.epoch), commit: (row.commit as Buffer).toString('base64') });
  }
  // MR1: the server's epoch lets the client tell "caught up" from "can't
  // reach the server epoch" (diverged → resync); group_info_epoch tells a
  // member whether the stored GroupInfo is stale and worth re-uploading.
  const g = await pool.query(
    'SELECT current_epoch, group_info_epoch FROM mls_groups WHERE group_id = $1',
    [groupId],
  );
  const current_epoch = g.rows.length ? Number(g.rows[0].current_epoch) : 0;
  const group_info_epoch = g.rows[0]?.group_info_epoch == null ? null : Number(g.rows[0].group_info_epoch);
  return { welcome, commits, current_epoch, group_info_epoch };
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
  const { epoch, commit, welcome, group_info } = parsed.data;

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

    // DMs don't track welcomed_user_ids explicitly (see the doc comment
    // above on why both sides always get the live broadcast) — log both
    // participants as welcomed whenever a welcome is present, so catch-up
    // can find this commit as either side's entry point.
    if (!(await bumpGroupEpoch(convId, epoch, commit, welcome, welcome ? [me, otherUserId] : undefined, group_info))) {
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
  group_info: groupInfoField,
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
const submitEventGroupCommitSchema = z.object({
  epoch: z.number().int().positive(),
  commit: z.string().max(500000), // base64
  welcome: z.string().max(2000000).nullable().optional(), // base64
  welcomed_user_ids: z.array(z.string().uuid()).max(200).optional(),
  group_info: groupInfoField,
});

/**
 * POST /orgs/:orgId/events/:eventId/mls/commit
 * Event counterpart to submitDmCommit/submitChannelCommit — group_id is the
 * event's own UUID. This group exists so a priority speaker's voice-cascade
 * audio (see media-rust's cross-channel duck broadcast) can be decrypted by
 * every event participant, not just members of the speaker's own channel:
 * "every currently-accepted event_group_members row across the event's
 * groups" is used as the membership set rather than trying to track each
 * frequency's narrower role-based grant — frequency access is always a
 * subset of group membership (event_frequency_roles grants specific
 * event_group_roles rows, and holding one requires being an accepted member
 * of that role's group), so this set is a safe superset for every possible
 * cascade recipient. EVMLS: the event's staff (commander, creator,
 * planners) are members too, since they may use the command channel and
 * frequencies (utils/eventChannelAccess's eventCascadeMemberUserIds).
 *
 * Unlike a channel, no single existing NATS subject spans every event
 * participant (they're scattered across many channels/groups) — mirrors the
 * DM pattern instead, relaying both the Commit and any Welcome individually
 * to each current participant's `specter.event.user.{id}` subject.
 */
export const submitEventGroupCommit = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId, eventId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = submitEventGroupCommitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }
  const { epoch, commit, welcome, welcomed_user_ids, group_info } = parsed.data;

  try {
    const eventCheck = await pool.query(
      'SELECT 1 FROM events WHERE id = $1 AND org_id = $2',
      [eventId, orgId],
    );
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Event not found' });
    }

    // EVMLS: only a member of this group's audience — accepted participants
    // plus the event's staff (utils/eventChannelAccess) — may commit, and only
    // members of that audience may be welcomed into it.
    const members = await eventCascadeMemberUserIds(eventId as string);
    if (!members.includes(userId)) {
      return res.status(403).json({ message: 'Not a participant of this event' });
    }
    if ((welcomed_user_ids ?? []).some((id) => !members.includes(id))) {
      return res.status(403).json({ message: 'Cannot add someone who is not signed up to this event' });
    }

    if (!(await bumpGroupEpoch(eventId as string, epoch, commit, welcome, welcomed_user_ids, group_info))) {
      return res.status(409).json({ message: 'Epoch conflict — this commit no longer targets the current epoch' });
    }

    for (const memberId of members) {
      await publishEvent(`specter.event.user.${memberId}`, {
        type: 'mls_commit',
        event_group_id: eventId,
        commit,
      });
    }

    if (welcome && welcomed_user_ids?.length) {
      for (const recipientId of welcomed_user_ids) {
        await publishEvent(`specter.event.user.${recipientId}`, {
          type: 'mls_welcome',
          event_group_id: eventId,
          welcome,
        });
      }
    }

    res.status(202).json({ ok: true, epoch });
  } catch (err) {
    console.error('submitEventGroupCommit error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

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
  const { epoch, commit, welcome, welcomed_user_ids, group_info } = parsed.data;

  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }
    const scope = await getChannelScope(chanId as string, orgId as string);
    if (!scope) {
      return res.status(404).json({ message: 'Channel not found' });
    }
    // EVMLS: an event channel's group is limited to that channel's audience
    // (signed-up members with access; utils/eventChannelAccess). Only they may
    // commit, and a Welcome may only go to them — so a client still
    // reconciling against the whole org (pre-2.0.0) can't widen it again.
    if (scope.scope === 'event') {
      const allowed = await channelMemberUserIds(scope);
      if (!allowed.includes(userId)) {
        return res.status(403).json({ message: 'Not assigned to this event channel' });
      }
      if ((welcomed_user_ids ?? []).some((id) => !allowed.includes(id))) {
        return res.status(403).json({ message: 'Cannot add someone without access to this event channel' });
      }
    }

    if (!(await bumpGroupEpoch(chanId as string, epoch, commit, welcome, welcomed_user_ids, group_info))) {
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

/**
 * GET /dm/:userId/mls/catch-up
 * DM counterpart to getChannelMlsCatchUp — same auth gate as submitDmCommit.
 */
export const getDmMlsCatchUp = async (req: AuthRequest, res: Response) => {
  const me = req.user?.id;
  const otherUserId = req.params.userId as string;
  if (!me) return res.status(401).json({ message: 'Unauthorized' });
  if (!UUID_RE.test(otherUserId)) return res.status(400).json({ message: 'Invalid userId' });
  if (me === otherUserId) return res.status(400).json({ message: 'Cannot MLS-commit with yourself' });

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
    res.json(await fetchGroupCatchUp(convId, me));
  } catch (err) {
    console.error('getDmMlsCatchUp error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /orgs/:orgId/events/:eventId/mls/catch-up
 * Event counterpart to getChannelMlsCatchUp — same auth gate as
 * submitEventGroupCommit.
 */
export const getEventGroupMlsCatchUp = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId, eventId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const eventCheck = await pool.query(
      'SELECT 1 FROM events WHERE id = $1 AND org_id = $2',
      [eventId, orgId],
    );
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Event not found' });
    }
    if (!(await eventCascadeMemberUserIds(eventId as string)).includes(userId)) {
      return res.status(403).json({ message: 'Not a participant of this event' });
    }
    res.json(await fetchGroupCatchUp(eventId as string, userId));
  } catch (err) {
    console.error('getEventGroupMlsCatchUp error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /orgs/:orgId/channels/:chanId/mls/catch-up
 * Returns whatever this user's device needs to catch a channel group up to
 * current from scratch: the earliest commit that actually welcomed this
 * user (their entry point), plus every commit since, in order. Called
 * before deciding whether a missing local group means "this channel never
 * had a group" (genuinely create one) or "I'm just late" (a previous
 * add for this user never reached this device live) — same auth gate as
 * submitChannelCommit.
 */
export const getChannelMlsCatchUp = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId, chanId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

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
    res.json(await fetchGroupCatchUp(chanId as string, userId));
  } catch (err) {
    console.error('getChannelMlsCatchUp error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /orgs/:orgId/channels/:chanId/mls/members
 * EVMLS: the user ids a channel's MLS group should hold — what mlsSession.js's
 * ensureChannelGroup reconciles the group against (adding missing devices,
 * removing everyone else, which rotates the key).
 *   { scope: 'org',   user_ids }  a normal channel: every org member (unchanged)
 *   { scope: 'event', user_ids }  an event channel: its signed-up audience
 *                                 (utils/eventChannelAccess — the same rule
 *                                 that gates its tickets, presence and sends)
 * Readable by any org member: the list says no more than the event's roster
 * (GET /events/:id/groups) already does.
 */
export const getChannelMlsMembers = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId, chanId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }
    const scope = await getChannelScope(chanId as string, orgId as string);
    if (!scope) {
      return res.status(404).json({ message: 'Channel not found', code: 'CHANNEL_NOT_FOUND' });
    }
    const user_ids = await channelMemberUserIds(scope);
    res.json({
      scope: scope.scope,
      ...(scope.scope === 'event' ? { event_id: scope.eventId, kind: scope.kind } : {}),
      user_ids,
    });
  } catch (err) {
    console.error('getChannelMlsMembers error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ── MR1: GroupInfo + external commits (join / resync without a member) ─────
//
// A device that isn't in a group yet, or whose copy diverged, used to wait
// for some existing member's client to happen to reconcile it in (and a
// diverged one never recovered). Now every commit uploads the GroupInfo for
// the epoch it produces (bumpGroupEpoch), and such a device fetches it here
// and joins by an MLS external commit (RFC 9420 §12.4.3.2), which goes
// through exactly the same Delivery Service epoch check and mls_commit_log
// entry as any other commit.
//
// Authorization is the group's member LIST — the same rules as
// /mls/members, /mls/commit and /mls/catch-up (org membership; an event
// channel's signed-up audience via utils/eventChannelAccess; the event
// cascade group's participants + staff; DM friendship). Only a listed user
// may read the GroupInfo (it names every member device) or external-commit.
//
// Known limitation (documented, accepted): the server cannot parse MLS, so
// it cannot check that an external commit's new leaf really carries the
// caller's own credential (`${userId}:${deviceId}`) — "the caller must be
// the subject" is enforced only as "the caller must be on the list". A
// listed user could therefore insert a leaf with someone else's credential
// string; every client sees the leaf's credential + signature key, and
// reconcile removes leaves whose user isn't on the list. Clients only ever
// external-join with their own credential (join_external refuses anything
// else). The same holds for putGroupInfo: a listed user could upload a bogus
// GroupInfo, which joiners reject (it's signature-checked against the tree),
// so the worst case is a denial of external joins until the next commit.

type GroupAccess = {
  groupId: string;
  /** Relays an accepted commit the same way the regular submit endpoint does. */
  publishCommit: (commit: string) => Promise<void>;
};

const sendValidationError = (res: Response, error: z.ZodError) =>
  res.status(400).json({
    message: 'Validation failed',
    errors: error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
  });

/** DM group of the caller and :userId — friendship-gated like submitDmCommit. Sends the error and returns null on refusal. */
async function resolveDmGroup(req: AuthRequest, res: Response): Promise<GroupAccess | null> {
  const me = req.user?.id;
  const otherUserId = req.params.userId as string;
  if (!me) { res.status(401).json({ message: 'Unauthorized' }); return null; }
  if (!UUID_RE.test(otherUserId)) { res.status(400).json({ message: 'Invalid userId' }); return null; }
  if (me === otherUserId) { res.status(400).json({ message: 'Cannot MLS-commit with yourself' }); return null; }
  const friendCheck = await pool.query(
    `SELECT 1 FROM friendships
     WHERE status = 1
       AND ((user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1))`,
    [me, otherUserId],
  );
  if ((friendCheck.rowCount ?? 0) === 0) { res.status(403).json({ message: 'Not friends' }); return null; }
  const convId = [me, otherUserId].sort().join('-');
  return {
    groupId: convId,
    publishCommit: async (commit) => {
      for (const recipientId of [me, otherUserId]) {
        await publishEvent(`specter.event.user.${recipientId}`, { type: 'mls_commit', conversation_id: convId, commit });
      }
    },
  };
}

/** A channel's group — org membership, and for an event channel its audience (same rule as /mls/members). */
async function resolveChannelGroup(req: AuthRequest, res: Response): Promise<GroupAccess | null> {
  const userId = req.user?.id;
  const { orgId, chanId } = req.params as { orgId: string; chanId: string };
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return null; }
  const memberCheck = await pool.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (memberCheck.rows.length === 0) { res.status(403).json({ message: 'Not a member of this organization' }); return null; }
  const scope = await getChannelScope(chanId, orgId);
  if (!scope) { res.status(404).json({ message: 'Channel not found', code: 'CHANNEL_NOT_FOUND' }); return null; }
  if (scope.scope === 'event' && !(await channelMemberUserIds(scope)).includes(userId)) {
    res.status(403).json({ message: 'Not assigned to this event channel' });
    return null;
  }
  return {
    groupId: chanId,
    publishCommit: (commit) => publishEvent(`specter.msg.channel.${chanId}`, { type: 'mls_commit', channel_id: chanId, commit }),
  };
}

/** An event's cascade group — participants + staff, like submitEventGroupCommit. */
async function resolveEventGroup(req: AuthRequest, res: Response): Promise<GroupAccess | null> {
  const userId = req.user?.id;
  const { orgId, eventId } = req.params as { orgId: string; eventId: string };
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return null; }
  const eventCheck = await pool.query('SELECT 1 FROM events WHERE id = $1 AND org_id = $2', [eventId, orgId]);
  if (eventCheck.rows.length === 0) { res.status(404).json({ message: 'Event not found' }); return null; }
  const members = await eventCascadeMemberUserIds(eventId);
  if (!members.includes(userId)) { res.status(403).json({ message: 'Not a participant of this event' }); return null; }
  return {
    groupId: eventId,
    publishCommit: async (commit) => {
      for (const memberId of members) {
        await publishEvent(`specter.event.user.${memberId}`, { type: 'mls_commit', event_group_id: eventId, commit });
      }
    },
  };
}

type Resolver = (req: AuthRequest, res: Response) => Promise<GroupAccess | null>;

/**
 * GET …/mls/group-info
 *   { exists: false, epoch: 0, group_info: null }      no group yet → the
 *                                                      client may run genesis
 *   { exists: true, epoch, group_info, group_info_epoch }
 * group_info is null when the stored one is stale (group_info_epoch !==
 * epoch): an external commit built from it would target an old epoch.
 */
const getGroupInfo = (resolve: Resolver, label: string) => async (req: AuthRequest, res: Response) => {
  try {
    const access = await resolve(req, res);
    if (!access) return;
    const r = await pool.query(
      'SELECT current_epoch, group_info, group_info_epoch FROM mls_groups WHERE group_id = $1',
      [access.groupId],
    );
    const row = r.rows[0];
    if (!row || Number(row.current_epoch) === 0) {
      return res.json({ group_id: access.groupId, exists: false, epoch: 0, group_info: null, group_info_epoch: null });
    }
    const epoch = Number(row.current_epoch);
    const groupInfoEpoch = row.group_info_epoch == null ? null : Number(row.group_info_epoch);
    const fresh = row.group_info && groupInfoEpoch === epoch;
    res.json({
      group_id: access.groupId,
      exists: true,
      epoch,
      group_info: fresh ? (row.group_info as Buffer).toString('base64') : null,
      group_info_epoch: groupInfoEpoch,
    });
  } catch (err) {
    console.error(`${label} error:`, err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const putGroupInfoSchema = z.object({
  epoch: z.number().int().positive(),
  group_info: z.string().min(1).max(4000000), // base64
});

/**
 * PUT …/mls/group-info { epoch, group_info }
 * A member re-uploads the GroupInfo for the CURRENT epoch — heals groups whose
 * last commit came from a client that sent none (pre-2.0.1). 409 when `epoch`
 * isn't the current one (the group moved on; the uploader catches up first).
 */
const putGroupInfo = (resolve: Resolver, label: string) => async (req: AuthRequest, res: Response) => {
  const parsed = putGroupInfoSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);
  try {
    const access = await resolve(req, res);
    if (!access) return;
    const { epoch, group_info } = parsed.data;
    const r = await pool.query(
      `UPDATE mls_groups SET group_info = $3, group_info_epoch = $2
       WHERE group_id = $1 AND current_epoch = $2`,
      [access.groupId, epoch, Buffer.from(group_info, 'base64')],
    );
    if ((r.rowCount ?? 0) === 0) {
      return res.status(409).json({ message: 'Epoch conflict — not the current epoch', code: 'EPOCH_CONFLICT' });
    }
    res.json({ ok: true, epoch });
  } catch (err) {
    console.error(`${label} error:`, err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const externalCommitSchema = z.object({
  epoch: z.number().int().positive(),
  commit: z.string().max(500000), // base64
  group_info: groupInfoField,
});

/**
 * POST …/mls/external-commit { epoch, commit, group_info }
 * Same Delivery Service rule (exactly one commit per epoch → 409 otherwise)
 * and the same mls_commit_log entry as a regular commit; no Welcome (the
 * joiner already holds the group). Relayed as the usual flat `mls_commit`
 * event, so existing members apply it like any other commit.
 */
const submitExternalCommit = (resolve: Resolver, label: string) => async (req: AuthRequest, res: Response) => {
  const parsed = externalCommitSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);
  try {
    const access = await resolve(req, res);
    if (!access) return;
    const { epoch, commit, group_info } = parsed.data;
    if (!(await bumpGroupEpoch(access.groupId, epoch, commit, null, undefined, group_info))) {
      return res.status(409).json({ message: 'Epoch conflict — this commit no longer targets the current epoch' });
    }
    await access.publishCommit(commit);
    res.status(202).json({ ok: true, epoch });
  } catch (err) {
    console.error(`${label} error:`, err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const getChannelGroupInfo = getGroupInfo(resolveChannelGroup, 'getChannelGroupInfo');
export const putChannelGroupInfo = putGroupInfo(resolveChannelGroup, 'putChannelGroupInfo');
export const submitChannelExternalCommit = submitExternalCommit(resolveChannelGroup, 'submitChannelExternalCommit');
export const getEventGroupInfo = getGroupInfo(resolveEventGroup, 'getEventGroupInfo');
export const putEventGroupInfo = putGroupInfo(resolveEventGroup, 'putEventGroupInfo');
export const submitEventGroupExternalCommit = submitExternalCommit(resolveEventGroup, 'submitEventGroupExternalCommit');
export const getDmGroupInfo = getGroupInfo(resolveDmGroup, 'getDmGroupInfo');
export const putDmGroupInfo = putGroupInfo(resolveDmGroup, 'putDmGroupInfo');
export const submitDmExternalCommit = submitExternalCommit(resolveDmGroup, 'submitDmExternalCommit');

const deviceStatusSchema = z.object({
  device_id: z.string().min(1).max(64),
  groups: z.array(z.object({
    group_id: z.string().min(1).max(200),
    epoch: z.number().int().nonnegative().nullable(),
    status: z.string().max(120).nullable().optional(),
  })).max(500),
});

/**
 * POST /mls/device-status { device_id, groups: [{ group_id, epoch, status }] }
 * Diagnostics only (mls_device_epochs): which epoch each of the caller's
 * devices holds per group, and a short status code after a heal. Scoped to
 * the caller's own user id; nothing reads it for delivery or authorization.
 */
export const reportDeviceStatus = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  const parsed = deviceStatusSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);
  const { device_id, groups } = parsed.data;
  try {
    for (const g of groups) {
      await pool.query(
        `INSERT INTO mls_device_epochs (user_id, device_id, group_id, epoch, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, device_id, group_id)
         DO UPDATE SET epoch = EXCLUDED.epoch, status = EXCLUDED.status, updated_at = CURRENT_TIMESTAMP`,
        [userId, device_id, g.group_id, g.epoch, g.status ?? null],
      );
    }
    res.json({ ok: true, count: groups.length });
  } catch (err) {
    console.error('reportDeviceStatus error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
