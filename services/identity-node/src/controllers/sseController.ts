import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { connectNats } from '../config/nats.js';
import { pool } from '../config/db.js';
import { StringCodec, Subscription } from 'nats';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getJwtSecret } from '../config/jwtSecret.js';
import { markStreamOpen, markStreamClosed } from '../utils/onlineUsers.js';
import { getChannelScope, canUseChannel } from '../utils/eventChannelAccess.js'; // B5

const sc = StringCodec();

// ── B5: live-stream registry ────────────────────────────────────────────────
// A user who loses access to a channel (kick, ban, demotion, a rank lowered or
// deleted, a visibility raise — utils/audienceNarrowing) used to keep that
// channel's specter.msg.channel.<id> subscription on every open stream until
// they reconnected. Each open stream registers its revocation hooks here so
// the narrowing path can drop them immediately, on every device. Nothing is
// sent to the user (no event that could hint at who else is in the channel).

/** One open SSE stream's revocation hooks. */
export interface LiveStream {
  /** Unsubscribe these channel subjects and keep them off until access is re-checked. */
  revokeChannels(channelIds: string[]): void;
  /** Drop the org's event subject and all of its channel subjects (kick / ban). */
  revokeOrg(orgId: string): void;
}

const liveStreams = new Map<string, Set<LiveStream>>();

/** Registers an open stream; returns its unregister function (idempotent). */
export function registerLiveStream(userId: string, stream: LiveStream): () => void {
  let set = liveStreams.get(userId);
  if (!set) { set = new Set(); liveStreams.set(userId, set); }
  set.add(stream);
  return () => {
    const s = liveStreams.get(userId);
    if (!s) return;
    s.delete(stream);
    if (s.size === 0) liveStreams.delete(userId);
  };
}

function eachStream(userId: string, fn: (s: LiveStream) => void): number {
  const set = liveStreams.get(userId);
  if (!set) return 0;
  for (const s of [...set]) {
    try { fn(s); } catch (err) { console.error('SSE: revoke failed', err); }
  }
  return set.size;
}

/**
 * B5: drop `channelIds` from every open stream of `userId` (0, 1 or several
 * devices). Returns how many streams were touched. Safe with no stream open.
 */
export function revokeChannelSubscriptions(userId: string, channelIds: Iterable<string>): number {
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return 0;
  return eachStream(userId, (s) => s.revokeChannels(ids));
}

/** B5: drop an org (its event subject + every channel subject of it) from every open stream of `userId`. */
export function revokeOrgSubscriptions(userId: string, orgId: string): number {
  return eachStream(userId, (s) => s.revokeOrg(orgId));
}

/** Test hook: how many streams `userId` has registered. */
export function liveStreamCount(userId: string): number {
  return liveStreams.get(userId)?.size ?? 0;
}

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

  // ── Per-stream subscription state (declared up front so B5 revocations
  // that arrive while the stream is still being set up apply too) ─────────
  let orgIds: string[] = [];
  const orgSubs = new Map<string, Subscription>();
  // Channel message subjects: channelId → its subscription + org.
  const chanSubs = new Map<string, { sub: Subscription; orgId: string }>();
  // B5: channels revoked on this stream. syncChannelSubs only re-subscribes
  // one after canUseChannel passes again (its broad query includes every
  // event channel of the org, so it would otherwise re-add them).
  const revoked = new Set<string>();
  let closed = false;
  const dropChannel = (id: string) => {
    const entry = chanSubs.get(id);
    if (entry) { entry.sub.unsubscribe(); chanSubs.delete(id); }
  };
  const revokeOrg = (orgId: string) => {
    orgIds = orgIds.filter((o) => o !== orgId);
    orgSubs.get(orgId)?.unsubscribe();
    orgSubs.delete(orgId);
    for (const [id, entry] of [...chanSubs]) if (entry.orgId === orgId) dropChannel(id);
  };
  const unregister = registerLiveStream(userId, {
    revokeChannels: (ids) => { for (const id of ids) { revoked.add(id); dropChannel(id); } },
    revokeOrg,
  });
  req.on('close', unregister);

  // ── Determine which orgs the user belongs to ──────────────────────────────
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
          `SELECT c.id, c.org_id FROM channels c
           JOIN org_members om ON om.org_id = c.org_id
           JOIN organizations o ON o.id = c.org_id
           LEFT JOIN org_roles r ON r.id = om.role_id
           WHERE om.user_id = $1
             AND (COALESCE(c.visible_min_level, 0) = 0 OR o.owner_id = $1
                  OR COALESCE(r.level, 0) >= c.visible_min_level)`,
          [userId]
        );
        if (closed) return;
        const inOrgs = new Set(orgIds);
        const want = new Map<string, string>();
        for (const r of chanResult.rows as { id: string; org_id: string }[]) {
          if (inOrgs.has(r.org_id)) want.set(r.id, r.org_id);
        }
        // B5: a revoked channel comes back only once the shared rule allows it again.
        const regained = new Set<string>();
        for (const [id, orgId] of want) {
          if (!revoked.has(id)) continue;
          try {
            const scope = await getChannelScope(id, orgId);
            if (scope && (await canUseChannel(scope, userId))) regained.add(id);
          } catch (err) {
            console.error('SSE: access re-check failed', err);
          }
        }
        if (closed) return;
        for (const id of regained) revoked.delete(id);
        for (const [id, orgId] of want) {
          if (chanSubs.has(id) || revoked.has(id)) continue;
          const chanSub = nc.subscribe(`specter.msg.channel.${id}`);
          chanSubs.set(id, { sub: chanSub, orgId });
          forward(chanSub);
        }
        for (const id of [...chanSubs.keys()]) {
          if (!want.has(id) || revoked.has(id)) dropChannel(id);
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
      if (closed) break;
      const orgSub = nc.subscribe(`specter.event.org.${orgId}`);
      orgSubs.set(orgId, orgSub);
      forward(orgSub, (payload) => {
        // B5: kicked / banned / left — this stream stops following the org now.
        if (payload?.type === 'member_removed' && payload.userId === userId) { revokeOrg(orgId); return; }
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
    for (const sub of orgSubs.values()) sub.unsubscribe();
    orgSubs.clear();
    for (const { sub } of chanSubs.values()) sub.unsubscribe();
    chanSubs.clear();
  });
};
