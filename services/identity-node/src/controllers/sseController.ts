import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { connectNats } from '../config/nats.js';
import { pool } from '../config/db.js';
import { StringCodec, Subscription } from 'nats';

const sc = StringCodec();

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

  const forward = (sub: Subscription) => {
    (async () => {
      for await (const msg of sub) {
        try {
          const payload = JSON.parse(sc.decode(msg.data));
          const sseData = JSON.stringify({ subject: msg.subject, ...payload });
          res.write(`data: ${sseData}\n\n`);
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
      forward(orgSub);
    }

    // ── Relay-only message delivery ───────────────────────────────────────
    // Channel messages: subscribe per channel the user has access to
    if (orgIds.length > 0) {
      try {
        const chanResult = await pool.query(
          `SELECT c.id FROM channels c
           JOIN org_members om ON om.org_id = c.org_id
           WHERE om.user_id = $1`,
          [userId]
        );
        for (const row of chanResult.rows) {
          const chanSub = nc.subscribe(`specter.msg.channel.${row.id}`);
          subs.push(chanSub);
          forward(chanSub);
        }
      } catch (err) {
        console.error('SSE: failed to subscribe to channel message subjects', err);
      }
    }

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
    clearInterval(keepalive);
    for (const sub of subs) sub.unsubscribe();
  });
};
