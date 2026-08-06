import { Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

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
    const chanCheck = await pool.query(
      'SELECT 1 FROM channels WHERE id = $1 AND org_id = $2',
      [chanId, orgId]
    );
    if (chanCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Channel not found' });
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

    await publishEvent(`specter.msg.channel.${chanId}`, {
      type: 'message_relay',
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
    const chanCheck = await pool.query(
      'SELECT 1 FROM channels WHERE id = $1 AND org_id = $2',
      [chanId, orgId]
    );
    if (chanCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Channel not found' });
    }

    await publishEvent(`specter.msg.channel.${chanId}`, {
      type: 'sync_request',
      payload: { channel_id: chanId, org_id: orgId, requester_id: userId, since: parsed.data.since ?? null },
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

    await publishEvent(`specter.event.user.${parsed.data.to_user_id}`, {
      type: 'sync_response',
      payload: { channel_id: chanId, messages: parsed.data.messages },
    });

    res.status(202).json({ ok: true });
  } catch (err) {
    console.error('respondChannelSync error:', err);
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
