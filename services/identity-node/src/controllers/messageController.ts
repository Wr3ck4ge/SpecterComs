import { Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { getChannelScope, canUseChannel, channelMemberUserIds } from '../utils/eventChannelAccess.js'; // EVMLS

const IMAGE_URL_MAX = 700_000; // ~512 KB base64

const sendMessageSchema = z.object({
  encrypted_content: z.string().max(6000),
  image_url: z.string()
    .max(IMAGE_URL_MAX, 'Image too large (max 512 KB)')
    .refine(val => {
      try { new URL(val); return true; } catch { return false; }
    }, 'Must be a valid URL or data URI')
    .nullable()
    .optional(),
});

/**
 * POST /orgs/:orgId/channels/:chanId/messages
 * Relay send — membership-gated, no DB write.
 */
export const sendMessage = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId, chanId } = req.params;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }
  const { encrypted_content, image_url } = parsed.data;

  try {
    // Membership gate
    const memberCheck = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }

    // Verify channel belongs to org
    const scope = await getChannelScope(chanId as string, orgId as string);
    if (!scope) {
      return res.status(404).json({ message: 'Channel not found' });
    }
    // EVMLS: event channels are for their signed-up audience only
    // (utils/eventChannelAccess) — the same people who hold its MLS key.
    if (scope.scope === 'event' && !(await canUseChannel(scope, userId))) {
      return res.status(403).json({ message: 'Not assigned to this event channel' });
    }

    const userRes = await pool.query(
      'SELECT callsign, global_tag FROM users WHERE id = $1',
      [userId]
    );

    const msg_id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const relayPayload = {
      id: msg_id,
      channel_id: chanId,
      // The foreground already knows its own org_id from component state, so
      // this is only actually needed by the Rust background sync task
      // (background_sync.rs) — it has no equivalent "current org" context and
      // needs org_id to construct a sync-response URL if it later answers
      // another peer's backfill request with something cached from here.
      org_id: orgId,
      sender_id: userId,
      callsign: userRes.rows[0]?.callsign ?? null,
      global_tag: userRes.rows[0]?.global_tag ?? null,
      encrypted_content,
      image_url: image_url ?? null,
      timestamp,
    };

    // Fields at the top level for the client's SSE handlers (useEventStream
    // hands them the event itself) and again under `payload` for the Rust
    // background sync task (background_sync.rs), which reads the nested copy.
    await publishEvent(`specter.msg.channel.${chanId}`, {
      type: 'message_relay',
      ...relayPayload,
      payload: relayPayload,
    });

    res.status(201).json({ id: msg_id, timestamp });
  } catch (err) {
    console.error('sendMessage error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ── Peer backfill sync ────────────────────────────────────────────────────────
// The server holds no message history, so a client that missed messages while
// offline (or is opening the channel for the first time on a new device) can't
// ask the server for a gap-fill. Instead it asks whichever *other members* are
// currently online: sync-request fans out over the same per-channel NATS
// subject every member's SSE connection already subscribes to (see
// sseController.ts), and any peer holding newer local history responds
// directly to the requester's user-scoped subject with its own IndexedDB
// contents. The server only ever relays these — it doesn't read or store the
// message bodies, same as sendMessage above.
const SYNC_MESSAGES_MAX = 200;

const syncRequestSchema = z.object({
  since: z.string().datetime().nullable().optional(),
});

/**
 * POST /orgs/:orgId/channels/:chanId/messages/sync-request
 * Broadcast to all online members of this channel: "does anyone have
 * messages newer than `since`?" No server-side lookup — pure fan-out.
 */
export const requestChannelSync = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId, chanId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = syncRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });

  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }
    const scope = await getChannelScope(chanId as string, orgId as string);
    if (!scope) {
      return res.status(404).json({ message: 'Channel not found' });
    }
    // MR2: the same event-channel rule as sends — a non-participant must not
    // be able to solicit an event channel's history from its members.
    if (scope.scope === 'event' && !(await canUseChannel(scope, userId))) {
      return res.status(403).json({ message: 'Not assigned to this event channel' });
    }

    // Top level for the client, nested for background_sync.rs (see sendMessage).
    const syncRequest = { channel_id: chanId, org_id: orgId, requester_id: userId, since: parsed.data.since ?? null };
    await publishEvent(`specter.msg.channel.${chanId}`, {
      type: 'sync_request',
      ...syncRequest,
      payload: syncRequest,
    });

    res.status(202).json({ ok: true });
  } catch (err) {
    console.error('requestChannelSync error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const syncResponseSchema = z.object({
  to_user_id: z.string().uuid(),
  messages: z.array(z.object({
    id: z.string(),
    sender_id: z.string(),
    callsign: z.string().nullable().optional(),
    global_tag: z.string().nullable().optional(),
    encrypted_content: z.string().max(6000),
    image_url: z.string().max(IMAGE_URL_MAX).nullable().optional(),
    timestamp: z.string(),
  })).max(SYNC_MESSAGES_MAX),
});

/**
 * POST /orgs/:orgId/channels/:chanId/messages/sync-response
 * A peer answering someone else's sync-request with messages from its own
 * local store. Delivered only to the original requester's user-scoped
 * subject — not broadcast back to the whole channel.
 */
export const respondChannelSync = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId, chanId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = syncResponseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });

  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }
    // The recipient must also be a member — prevents using this endpoint to
    // shove arbitrary channel content at an unrelated user.
    const recipientCheck = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, parsed.data.to_user_id]
    );
    if (recipientCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Recipient is not a member of this organization' });
    }
    const denied = await eventChannelDenial(chanId as string, orgId as string, [userId, parsed.data.to_user_id]);
    if (denied) return res.status(denied.status).json({ message: denied.message });

    // Top level only: the client reads it there, nothing reads a nested copy,
    // and duplicating up to SYNC_MESSAGES_MAX messages would double the size.
    await publishEvent(`specter.event.user.${parsed.data.to_user_id}`, {
      type: 'sync_response',
      channel_id: chanId,
      org_id: orgId,
      relayed_by: userId,
      messages: parsed.data.messages,
    });

    res.status(202).json({ ok: true });
  } catch (err) {
    console.error('respondChannelSync error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * null when every one of `userIds` may use the channel (org channels: always —
 * callers check org membership), else the status/message to refuse with.
 */
async function eventChannelDenial(chanId: string, orgId: string, userIds: string[]) {
  const scope = await getChannelScope(chanId, orgId);
  if (!scope) return { status: 404, message: 'Channel not found' };
  if (scope.scope !== 'event') return null;
  const allowed = new Set(await channelMemberUserIds(scope));
  if (userIds.every((u) => allowed.has(u))) return null;
  return { status: 403, message: 'Not assigned to this event channel' };
}

// ── MR2: org-wide catch-up ────────────────────────────────────────────────────
// One request covers every channel of a server, and any online member answers
// from its local history for any channel (not only the one it has open), so
// a client starting up / reconnecting / joining a server catches up on all of
// them at once.
//
//   POST /orgs/:orgId/messages/sync-request  { channels: [{ channel_id, since }] }
//     → fan-out on specter.event.org.<orgId> as
//       { type: 'org_sync_request', org_id, requester_id, channels: [{ channel_id, since }] }
//       (flat, top-level fields). Channels the caller may not use (another
//       org's, unknown, or an event channel they're not signed up to — see
//       utils/eventChannelAccess) are dropped before publishing.
//
//   POST /orgs/:orgId/messages/sync-response { to_user_id, channel_id, bundle, count }
//     → specter.event.user.<to_user_id> as
//       { type: 'sync_response', org_id, channel_id, relayed_by, bundle, count }
//       `bundle` is ONE MLS application message (the responder encrypted its
//       stored plaintexts, with their original id / sender / callsign /
//       timestamp, under the channel group's CURRENT epoch), so it is opaque
//       here. One ciphertext per bundle rather than one per message: every
//       MLS encrypt advances the responder's sender ratchet, and hundreds of
//       backfill-only generations would push its next live message past the
//       other members' forward-distance limit. relayed_by is the
//       authenticated responder; the original sender's authorship of a
//       relayed message rests on that responder (accepted trade-off — a
//       backfilled message is only as trustworthy as the member who relayed it).
//
// The server still reads and stores nothing: it checks who may ask / answer
// and relays.
const ORG_SYNC_MAX_CHANNELS = 500;
// express.json()'s default body limit is 100 kB; the client chunks bundles below this.
const SYNC_BUNDLE_MAX = 95_000;

const orgSyncRequestSchema = z.object({
  channels: z.array(z.object({
    channel_id: z.string().uuid(),
    since: z.string().datetime().nullable().optional(),
  })).min(1).max(ORG_SYNC_MAX_CHANNELS),
});

/**
 * Pure: the requested channels the caller may use, deduped, in request order.
 * orgChannels = this org's channels ({ id, event_id }); canUseEventChannel is
 * asked only for event channels.
 */
export async function filterSyncChannels(
  requested: { channel_id: string; since?: string | null }[],
  orgChannels: { id: string; event_id: string | null }[],
  canUseEventChannel: (channelId: string) => Promise<boolean>,
): Promise<{ channel_id: string; since: string | null }[]> {
  const byId = new Map(orgChannels.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: { channel_id: string; since: string | null }[] = [];
  for (const r of requested) {
    if (seen.has(r.channel_id)) continue;
    seen.add(r.channel_id);
    const ch = byId.get(r.channel_id);
    if (!ch) continue;
    if (ch.event_id && !(await canUseEventChannel(ch.id))) continue;
    out.push({ channel_id: ch.id, since: r.since ?? null });
  }
  return out;
}

export const requestOrgSync = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = orgSyncRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });

  try {
    const memberCheck = await pool.query(
      'SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2',
      [orgId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }
    const chanRes = await pool.query(
      'SELECT id, event_id FROM channels WHERE org_id = $1 AND id = ANY($2::uuid[])',
      [orgId, parsed.data.channels.map((c) => c.channel_id)]
    );
    const channels = await filterSyncChannels(parsed.data.channels, chanRes.rows, async (chanId) => {
      const scope = await getChannelScope(chanId, orgId as string);
      return Boolean(scope) && (await canUseChannel(scope!, userId));
    });

    if (channels.length > 0) {
      await publishEvent(`specter.event.org.${orgId}`, {
        type: 'org_sync_request',
        org_id: orgId,
        requester_id: userId,
        channels,
      });
    }

    res.status(202).json({ ok: true, channels: channels.map((c) => c.channel_id) });
  } catch (err) {
    console.error('requestOrgSync error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const orgSyncResponseSchema = z.object({
  to_user_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  bundle: z.string().min(1).max(SYNC_BUNDLE_MAX),
  count: z.number().int().min(0).max(SYNC_MESSAGES_MAX).optional(),
});

export const respondOrgSync = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { orgId } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = orgSyncResponseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
  const { to_user_id, channel_id, bundle, count } = parsed.data;
  if (to_user_id === userId) return res.status(400).json({ message: 'Cannot answer your own sync request' });

  try {
    const members = await pool.query(
      'SELECT user_id FROM org_members WHERE org_id = $1 AND user_id = ANY($2::uuid[])',
      [orgId, [userId, to_user_id]]
    );
    const memberIds = new Set(members.rows.map((r: any) => r.user_id));
    if (!memberIds.has(userId)) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }
    if (!memberIds.has(to_user_id)) {
      return res.status(403).json({ message: 'Recipient is not a member of this organization' });
    }
    // Both ends must be allowed on the channel (event-channel rule).
    const denied = await eventChannelDenial(channel_id, orgId as string, [userId, to_user_id]);
    if (denied) return res.status(denied.status).json({ message: denied.message });

    await publishEvent(`specter.event.user.${to_user_id}`, {
      type: 'sync_response',
      org_id: orgId,
      channel_id,
      relayed_by: userId,
      bundle,
      count: count ?? null,
    });

    res.status(202).json({ ok: true });
  } catch (err) {
    console.error('respondOrgSync error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ── Removed: getMessages, deleteMessage ──────────────────────────────────────
// Server-side message history no longer exists. Clients store messages locally.
// These routes now return 404 (route entries removed from message.ts).

// placeholder to suppress TS unused-import on older export consumers
export const _relayOnly = true;

/**
 * @deprecated removed — relay-only architecture
 * @internal kept so TypeScript does not complain about import-nothing modules
 */
export const getMessages = async (_req: AuthRequest, res: Response) => {
  res.status(404).json({ message: 'Message history is not stored on the server' });
};

/**
 * @deprecated removed — relay-only architecture
 */
export const deleteMessage = async (_req: AuthRequest, res: Response) => {
  res.status(404).json({ message: 'Message history is not stored on the server' });
};

// sentinel — end of file
