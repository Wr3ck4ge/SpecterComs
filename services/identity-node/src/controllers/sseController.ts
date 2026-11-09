import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { connectNats } from '../config/nats.js';
import { pool } from '../config/db.js';
import { StringCodec, Subscription } from 'nats';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getJwtSecret } from '../config/jwtSecret.js';
import { markStreamOpen, markStreamClosed } from '../utils/onlineUsers.js';

const sc = StringCodec();

/**
 * POST /events/ticket
 * Issues a short-lived, SSE-purpose token so EventSource does not need to use
 * the long-lived account JWT in a URL query string.
 */
export const issueSseTicket = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const ticket = jwt.sign(
    {
      id: userId,
      callsign: req.user?.callsign,
      purpose: 'sse',
      jti: randomUUID(),
    },
    getJwtSecret(),
    { expiresIn: '2m' }
  );

  return res.json({ ticket, expires_in_seconds: 120 });
};

/**
 * GET /events/stream
 * Server-Sent Events endpoint.
 * Subscribes to NATS subjects relevant to the authenticated user and
 * forwards them as SSE messages so the frontend can reactively update UI.
 *
 * NATS subject convention:
 *   specter.event.org.<orgId>   — org-scoped events  (channel/member/role/settings changes)
 *   specter.event.user.<userId> — user-scoped events  (friend list, kicked from org, etc.)
 */
export const eventStream = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  // ── SSE headers ────────────────────────────────────────────────────────────
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',       // disable nginx buffering for SSE
  });
  res.flushHeaders();

  // Keepalive comment every 25s so proxies don't close the connection
  const keepalive = setInterval(() => res.write(':keepalive\n\n'), 25_000);
  // Online status for the server admin roster (utils/onlineUsers).
  markStreamOpen(userId);
  let counted = true;
  const uncount = () => { if (counted) { counted = false; markStreamClosed(userId); } };
  req.on('close', uncount); // early, so a failure below can't leak the count

  // ── Determine which orgs the user belongs to ──────────────────────────────
  let orgIds: string[] = [];
  try {
    const result = await pool.query(
      'SELECT org_id FROM org_members WHERE user_id = $1',
      [userId],
    );
    orgIds = result.rows.map((r: any) => r.org_id);
  } catch (err) {
    console.error('SSE: failed to fetch user orgs', err);
  }

  // ── Subscribe to NATS ─────────────────────────────────────────────────────
  const subs: Subscription[] = [];
  const nc = await connectNats();

  // ── Channel message subjects (specter.msg.channel.<id>) ─────────────────
  // Carries channel message_relay AND the channel MLS group's mls_commit
  // (mlsGroupController submitChannelCommit / external commits). This list
  // used to be computed once at connect time, so a channel created later —
  // every channel an operation's launch creates, the post-launch group /
  // frequency channels, the debrief channel — was never subscribed by anyone
  // already connected: its live commits never arrived, members' local epoch
  // fell behind, and voice on event channels sat in "Waiting for channel key"
  // until a decrypt failure happened to trigger a heal. OPTREE: re-synced on
  // every channel_created / event_launched / channel_deleted / operation_ended
  // org event that passes through this stream.
  const chanSubs = new Map<string, Subscription>();
  let closed = false;
  let syncing: Promise<void> | null = null;
  let resyncQueued = false;
  const syncChannelSubs = async (): Promise<void> => {
    if (!nc || closed || orgIds.length === 0) return;
    if (syncing) { resyncQueued = true; return syncing; }
    syncing = (async () => {
      try {
        const chanResult = await pool.query(
          // Rank-restricted org channels (visible_min_level) only for members
          // at/above the threshold, and the owner (utils/orgAuthority).
          `SELECT c.id FROM channels c
           JOIN org_members om ON om.org_id = c.org_id
           JOIN organizations o ON o.id = c.org_id
           LEFT JOIN org_roles r ON r.id = om.role_id
           WHERE om.user_id = $1
             AND (COALESCE(c.visible_min_level, 0) = 0 OR o.owner_id = $1
                  OR COALESCE(r.level, 0) >= c.visible_min_level)`,
          [userId]
        );
        if (closed) return;
        const want = new Set<string>(chanResult.rows.map((r: any) => r.id));
        for (const id of want) {
          if (chanSubs.has(id)) continue;
          const chanSub = nc.subscribe(`specter.msg.channel.${id}`);
          chanSubs.set(id, chanSub);
          forward(chanSub);
        }
        for (const [id, sub] of chanSubs) {
          if (!want.has(id)) { sub.unsubscribe(); chanSubs.delete(id); }
        }
      } catch (err) {
        console.error('SSE: failed to subscribe to channel message subjects', err);
      } finally {
        syncing = null;
        if (resyncQueued && !closed) { resyncQueued = false; void syncChannelSubs(); }
      }
    })();
    return syncing;
  };
  // channel_updated (visibility) and member_updated (a rank change) can move
  // a rank-restricted channel in or out of this user's set.
  const CHANNEL_SET_CHANGES = new Set(['channel_created', 'channel_deleted', 'channel_updated', 'member_updated', 'event_launched', 'operation_ended']);

  const forward = (sub: Subscription, onPayload?: (payload: any) => void) => {
    (async () => {
      for await (const msg of sub) {
        try {
          const payload = JSON.parse(sc.decode(msg.data));
          const sseData = JSON.stringify({ subject: msg.subject, ...payload });
          res.write(`data: ${sseData}\n\n`);
          onPayload?.(payload);
        } catch { /* malformed message — skip */ }
      }
    })();
  };

  if (nc) {
    // User-scoped events (kicked, friend updates, etc.)
    const userSub = nc.subscribe(`specter.event.user.${userId}`);
    subs.push(userSub);
    forward(userSub);

    // Org-scoped events
    for (const orgId of orgIds) {
      const orgSub = nc.subscribe(`specter.event.org.${orgId}`);
      subs.push(orgSub);
      forward(orgSub, (payload) => {
        if (CHANNEL_SET_CHANGES.has(payload?.type)) void syncChannelSubs();
      });
    }

    // ── Relay-only message delivery ───────────────────────────────────────
    // Channel messages: subscribe per channel the user has access to
    await syncChannelSubs();

    // DM messages: subscribe to all conversation subjects involving this user
    // Subject pattern: specter.msg.dm.{min(a,b)}-{max(a,b)}
    // We cannot wildcard-subscribe per-user cheaply without a fan-out service,
    // so we subscribe to DM relays via the existing user-scoped subject and
    // also add a dedicated DM relay listener using the user event subject.
    // The dmController now publishes to specter.msg.dm.{convId}; the client
    // will receive it because both participants share the same convId.
    // To deliver to the recipient without knowing all their conversation IDs at
    // connect time, the dmController additionally publishes a copy to each
    // participant's user-scoped event subject (handled below in sendDirectMessage).
    // For the sender's own SSE connection, the channel sub above is sufficient.
    // No additional wildcard sub needed here — the user event subject carries DMs.
  }

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: 'connected', orgIds })}\n\n`);

  // ── Cleanup on disconnect ─────────────────────────────────────────────────
  req.on('close', () => {
    uncount();
    closed = true;
    clearInterval(keepalive);
    for (const sub of subs) sub.unsubscribe();
    for (const sub of chanSubs.values()) sub.unsubscribe();
    chanSubs.clear();
  });
};
