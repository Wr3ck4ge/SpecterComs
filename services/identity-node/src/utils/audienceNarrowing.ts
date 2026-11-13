/**
 * B3 (S1): re-key a channel's MLS group as soon as its audience NARROWS.
 *
 * The access rule (utils/eventChannelAccess canUseChannel / channelMemberUserIds)
 * already refuses a removed user tickets, messages and MLS commits the moment
 * the rule changes — but the channel's MLS group still holds their devices, so
 * they keep the current epoch's key until somebody's next reconcile. Every
 * change that can shrink a channel's audience (a channel's visibility raised, a
 * member demoted, a rank's level/permissions lowered or the rank deleted, a
 * kick / ban) snapshots the affected audiences before and after the write; each
 * channel that lost anyone gets
 *
 *   { type: 'channel_audience_narrowed', orgId, channelId }
 *
 * on the user subject of every member who is STILL allowed (never the removed
 * ones, and the event never says who left). Their clients re-run the channel's
 * reconcile (mlsSession ensureChannelGroup), which commits the removal and
 * advances the epoch — the new key. No event on a widening or a no-op.
 *
 * B5: the removed users' open SSE streams drop those channels' subjects at
 * the same moment (revokeRemoved → sseController revokeChannelSubscriptions).
 *
 * Best effort by design: a failure here is logged and never fails the request
 * (the rule itself is already enforced; the next channel open reconciles too).
 */
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { orgChannelAudience } from './orgAuthority.js';
import { audienceFor, classifyEventChannel, loadEventAudience } from './eventChannelAccess.js';
import { revokeChannelSubscriptions } from '../controllers/sseController.js'; // B5

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** channelId → the user ids allowed on it. */
export type AudienceSnapshot = Map<string, Set<string>>;

export interface Narrowed { channelId: string; remaining: string[]; removed: string[] }

/**
 * Pure: the channels whose audience lost at least one user between `before`
 * and `after`, each with who is still allowed (`after`'s set, sorted) and who
 * lost it (`removed`, sorted; server-side only — never sent to anyone). A
 * channel missing from `after` (deleted, op ended) is skipped: there is no
 * group left to re-key. Additions alone are not a narrowing.
 */
export function narrowedChannels(before: AudienceSnapshot, after: AudienceSnapshot): Narrowed[] {
  const out: Narrowed[] = [];
  for (const [channelId, was] of before) {
    const now = after.get(channelId);
    if (!now) continue;
    const removed = [...was].filter((id) => !now.has(id));
    if (removed.length === 0) continue;
    out.push({ channelId, remaining: [...now].sort(), removed: removed.sort() });
  }
  return out;
}

/** Pure: removed user → the narrowed channels they lost (B5). */
export function removedByUser(narrowed: Narrowed[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { channelId, removed } of narrowed) {
    for (const uid of removed) {
      const list = out.get(uid);
      if (list) list.push(channelId); else out.set(uid, [channelId]);
    }
  }
  return out;
}

/**
 * B5: drop the lost channels' subjects from each removed user's live SSE
 * streams now (sseController), so they stop receiving that channel's relays
 * and commits before their next reconnect. Sends them nothing.
 */
export function revokeRemoved(narrowed: Narrowed[]): void {
  for (const [uid, channelIds] of removedByUser(narrowed)) {
    try {
      revokeChannelSubscriptions(uid, channelIds);
    } catch (err) {
      console.error('[audienceNarrowing] SSE revoke failed', err);
    }
  }
}

export interface SnapshotScope {
  /** Only this org channel (a visibility change). */
  channelId?: string;
  /** Also channels open to every member (visible_min_level 0): only a kick / ban narrows those. */
  includeOpen?: boolean;
}

/**
 * The audiences a change might narrow, read through the same rule as
 * /mls/members: org channels (rank-restricted ones; all with includeOpen) and,
 * unless `channelId` is given, the channels of the org's live operations
 * (organisers come from rank permissions). Each half fails on its own.
 */
export async function snapshotAudiences(orgId: string, scope: SnapshotScope = {}, db: Queryable = pool): Promise<AudienceSnapshot> {
  const snap: AudienceSnapshot = new Map();
  try {
    const rows = (await db.query(
      `SELECT id, COALESCE(visible_min_level, 0) AS visible_min_level FROM channels
       WHERE org_id = $1 AND event_id IS NULL AND COALESCE(is_frequency, false) = false
         AND ($2::uuid IS NULL OR id = $2::uuid)`,
      [orgId, scope.channelId ?? null],
    )).rows;
    const byLevel = new Map<number, Set<string>>();
    for (const r of rows) {
      const level = Number(r.visible_min_level) || 0;
      if (level === 0 && !scope.includeOpen && !scope.channelId) continue;
      let aud = byLevel.get(level);
      if (!aud) { aud = new Set(await orgChannelAudience(orgId, level, db)); byLevel.set(level, aud); }
      snap.set(r.id, aud);
    }
  } catch (err) {
    console.error('[audienceNarrowing] org channel snapshot failed', err);
  }
  if (scope.channelId) return snap;
  try {
    const rows = (await db.query(
      `SELECT c.id, c.event_id, COALESCE(c.is_frequency, false) AS is_frequency,
              (SELECT eg.id FROM event_groups eg WHERE eg.channel_id = c.id LIMIT 1) AS group_id,
              (SELECT ef.id FROM event_frequencies ef WHERE ef.channel_id = c.id
                ORDER BY ef.is_leadership DESC LIMIT 1) AS frequency_id
       FROM channels c JOIN events e ON e.id = c.event_id
       WHERE c.org_id = $1 AND COALESCE(e.launched, false) AND e.ended_at IS NULL`,
      [orgId],
    )).rows;
    const audiences = new Map<string, Awaited<ReturnType<typeof loadEventAudience>>>();
    for (const r of rows) {
      let a = audiences.get(r.event_id);
      if (!a) { a = await loadEventAudience(r.event_id, db); audiences.set(r.event_id, a); }
      snap.set(r.id, audienceFor({ kind: classifyEventChannel(r), groupId: r.group_id ?? null, frequencyId: r.frequency_id ?? null }, a));
    }
  } catch (err) {
    console.error('[audienceNarrowing] event channel snapshot failed', err);
  }
  return snap;
}

/** Publishes channel_audience_narrowed to each remaining member of each narrowed channel. */
export async function announceNarrowed(orgId: string, narrowed: Narrowed[]): Promise<void> {
  for (const { channelId, remaining } of narrowed) {
    await Promise.all(remaining.map((uid) =>
      publishEvent(`specter.event.user.${uid}`, { type: 'channel_audience_narrowed', orgId, channelId })));
  }
}

/**
 * Snapshot now; call the returned function after the write to diff and
 * announce. Never throws (see the module comment).
 */
export async function watchAudience(orgId: string, scope: SnapshotScope = {}, db: Queryable = pool): Promise<() => Promise<void>> {
  let before: AudienceSnapshot;
  try {
    before = await snapshotAudiences(orgId, scope, db);
  } catch (err) {
    console.error('[audienceNarrowing] snapshot failed', err);
    return async () => {};
  }
  return async () => {
    try {
      if (before.size === 0) return;
      const after = await snapshotAudiences(orgId, scope, db);
      const narrowed = narrowedChannels(before, after);
      revokeRemoved(narrowed); // B5: first, so the re-key commit doesn't reach them live
      await announceNarrowed(orgId, narrowed);
    } catch (err) {
      console.error('[audienceNarrowing] announce failed', err);
    }
  };
}
