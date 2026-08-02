import crypto from 'crypto';
import { Response } from 'express';
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── POST /dm/:userId/messages — relay a DM (no server persistence) ────────────
export const sendDirectMessage = async (req: AuthRequest, res: Response) => {
  const me = req.user?.id;
  const recipientId = req.params.userId as string;
  if (!me) return res.status(401).json({ message: 'Unauthorized' });

  // Validate recipientId to prevent NATS subject injection
  if (!UUID_RE.test(recipientId)) {
    return res.status(400).json({ message: 'Invalid userId' });
  }
  if (me === recipientId) return res.status(400).json({ message: 'Cannot DM yourself' });

  const encrypted_content: string = req.body?.encrypted_content ?? '';
  if (!encrypted_content || encrypted_content.length < 1 || encrypted_content.length > 8000) {
    return res.status(400).json({ message: 'encrypted_content must be 1–8000 characters' });
  }

  try {
    // Friendship gate — server only relays between friends
    const friendCheck = await pool.query(
      `SELECT 1 FROM friendships
       WHERE status = 1
         AND ((user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1))`,
      [me, recipientId],
    );
    if ((friendCheck.rowCount ?? 0) === 0) {
      return res.status(403).json({ message: 'Not friends' });
    }

    // Sender callsign
    const callerRes = await pool.query(`SELECT callsign FROM users WHERE id = $1`, [me]);
    const fromCallsign: string = callerRes.rows[0]?.callsign ?? 'Unknown';

    const msg_id    = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    // Conversation ID is deterministic and order-independent
    const convId    = [me, recipientId].sort().join('-');

    const relayPayload = {
      id:                msg_id,
      conversation_id:   convId,
      sender_id:         me,
      to_user_id:        recipientId,
      callsign:          fromCallsign,
      encrypted_content,
      timestamp,
    };

    // Notify recipient of new DM (drives notification badge)
    await publishEvent(`specter.event.user.${recipientId}`, {
      type:           'dm_received',
      from_user_id:   me,
      from_callsign:  fromCallsign,
    });
    // Relay full message to recipient
    await publishEvent(`specter.event.user.${recipientId}`, {
      type:       'message_relay',
      context:    'dm',
      partner_id: me,
      message:    relayPayload,
    });
    // Relay back to sender (multi-device / multi-tab sync)
    await publishEvent(`specter.event.user.${me}`, {
      type:       'message_relay',
      context:    'dm',
      partner_id: recipientId,
      message:    relayPayload,
    });
    // JetStream offline buffer — raw payload; consumer reconstructs partner_id from sender_id
    await publishEvent(`specter.msg.dm.${convId}`, relayPayload);

    res.status(201).json({ id: msg_id, timestamp });
  } catch (err) {
    console.error('sendDirectMessage error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Peer backfill sync (see messageController.ts for the same pattern on
// channels) — DMs are 1:1 so there's no channel subject to fan out on; the
// request/response are addressed straight to the other participant's own
// user-scoped subject, which they're already subscribed to for everything
// else (dm_received, message_relay, etc.). No server-side message storage
// or lookup involved either way.
const DM_SYNC_MESSAGES_MAX = 200;

// ── POST /dm/:userId/sync-request — ask the other participant "anything newer than `since`?" ──
export const requestDmSync = async (req: AuthRequest, res: Response) => {
  const me = req.user?.id;
  const otherId = req.params.userId as string;
  if (!me) return res.status(401).json({ message: 'Unauthorized' });
  if (!UUID_RE.test(otherId)) return res.status(400).json({ message: 'Invalid userId' });

  const since = req.body?.since ?? null;
  if (since !== null && typeof since !== 'string') {
    return res.status(400).json({ message: 'since must be a string or null' });
  }

  try {
    const friendCheck = await pool.query(
      `SELECT 1 FROM friendships
       WHERE status = 1
         AND ((user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1))`,
      [me, otherId],
    );
    if ((friendCheck.rowCount ?? 0) === 0) {
      return res.status(403).json({ message: 'Not friends' });
    }

    const convId = [me, otherId].sort().join('-');
    await publishEvent(`specter.event.user.${otherId}`, {
      type: 'dm_sync_request',
      payload: { conversation_id: convId, requester_id: me, since },
    });

    res.status(202).json({ ok: true });
  } catch (err) {
    console.error('requestDmSync error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── POST /dm/:userId/sync-response — answer someone else's sync-request with local history ──
export const respondDmSync = async (req: AuthRequest, res: Response) => {
  const me = req.user?.id;
  const requesterId = req.params.userId as string;
  if (!me) return res.status(401).json({ message: 'Unauthorized' });
  if (!UUID_RE.test(requesterId)) return res.status(400).json({ message: 'Invalid userId' });

  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > DM_SYNC_MESSAGES_MAX) {
    return res.status(400).json({ message: `messages must be a non-empty array of at most ${DM_SYNC_MESSAGES_MAX}` });
  }

  try {
    const friendCheck = await pool.query(
      `SELECT 1 FROM friendships
       WHERE status = 1
         AND ((user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1))`,
      [me, requesterId],
    );
    if ((friendCheck.rowCount ?? 0) === 0) {
      return res.status(403).json({ message: 'Not friends' });
    }

    const convId = [me, requesterId].sort().join('-');
    await publishEvent(`specter.event.user.${requesterId}`, {
      type: 'dm_sync_response',
      payload: { conversation_id: convId, messages },
    });

    res.status(202).json({ ok: true });
  } catch (err) {
    console.error('respondDmSync error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};
