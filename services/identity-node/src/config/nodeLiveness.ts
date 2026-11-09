/**
 * One definition of "this media node is live", used by every SQL site that
 * routes or reports on nodes (discovery.ts, nodeStatus.ts, the provisioning
 * reconciler). Previously the literal 15s window was repeated in each.
 *
 * Contract C3: media-rust heartbeats every HEARTBEAT_INTERVAL_MS (default
 * 5000). A node is stale once NODE_STALE_MISSED_HEARTBEATS (default 3)
 * consecutive heartbeats are missing — 15 s at the defaults, the same as before.
 *
 * NODE_HEARTBEAT_INTERVAL_MS here MUST match the nodes' HEARTBEAT_INTERVAL_MS.
 * Lowering both (e.g. to 2000 → stale after 6 s) is the server-side half of the
 * failover fix (eval M1): the registry then stops offering a dead node before a
 * client's 10 s QUIC idle timeout fires and it re-tickets. Lower the nodes FIRST,
 * then identity-node — the other order makes healthy nodes flap offline.
 */
import { envNumber } from './envNumber.js';

export const NODE_HEARTBEAT_INTERVAL_MS = envNumber('NODE_HEARTBEAT_INTERVAL_MS', 5000, { min: 500, max: 60_000 });
export const NODE_STALE_MISSED_HEARTBEATS = envNumber('NODE_STALE_MISSED_HEARTBEATS', 3, { min: 2, max: 10 });

/** Seconds since the last heartbeat after which a node no longer counts as live. */
export const NODE_STALE_AFTER_SECONDS = (NODE_HEARTBEAT_INTERVAL_MS * NODE_STALE_MISSED_HEARTBEATS) / 1000;

/**
 * SQL predicate "<column> is within the liveness window". The number is
 * validated above (finite, bounded), so inlining it is injection-safe and keeps
 * every call site's parameter numbering unchanged.
 */
export function liveSql(column: string): string {
  return `(${column} IS NOT NULL AND ${column} > NOW() - make_interval(secs => ${NODE_STALE_AFTER_SECONDS}))`;
}
