import { pool } from '../config/db.js';
import { getNextTier } from '../config/dropletTiers.js';
import {
  NODE_CPU_ALERT_PCT,
  NODE_MEM_ALERT_PCT,
  NODE_BANDWIDTH_CAP_MBPS,
  NODE_BANDWIDTH_ALERT_PCT,
  NODE_OVERLOAD_SUSTAIN_SECONDS,
} from '../config/nodeThresholds.js';

// Wall-clock (not call-count) so the debounce is correct regardless of how often a
// caller polls getNodesWithStatus (admin UI ~20s, pushWatcher 10s) -- tracks when each
// node *first* crossed threshold, independent of who's asking.
const overloadedSince = new Map<string, number>();

// Shared between the admin GET /admin/nodes listing (adminController.ts) and
// pushWatcher.ts's polling loop, so both agree on what "overloaded" and
// "needs a new node" mean -- factored out rather than duplicated so the two
// can't silently drift apart.
export async function getNodesWithStatus() {
  const result = await pool.query(
    `SELECT mn.*,
            (mn.last_heartbeat_at > NOW() - INTERVAL '15 seconds') AS online,
            COUNT(ona.org_id)::int AS assigned_org_count
     FROM media_nodes mn
     LEFT JOIN org_node_assignments ona ON ona.node_id = mn.id
     GROUP BY mn.id
     ORDER BY mn.node_id ASC
     LIMIT 200`
  );

  const bandwidthAlertMbps = (NODE_BANDWIDTH_ALERT_PCT / 100) * NODE_BANDWIDTH_CAP_MBPS;
  const now = Date.now();

  const nodes = result.rows.map((node) => {
    const rawOverloaded =
      node.online &&
      ((node.cpu_pct ?? 0) >= NODE_CPU_ALERT_PCT ||
        (node.mem_pct ?? 0) >= NODE_MEM_ALERT_PCT ||
        Math.max(node.net_rx_mbps ?? 0, node.net_tx_mbps ?? 0) >= bandwidthAlertMbps);

    let since = overloadedSince.get(node.node_id);
    if (rawOverloaded) {
      if (since === undefined) {
        since = now;
        overloadedSince.set(node.node_id, since);
      }
    } else {
      since = undefined;
      overloadedSince.delete(node.node_id);
    }
    const overloaded = since !== undefined && (now - since) / 1000 >= NODE_OVERLOAD_SUSTAIN_SECONDS;

    return {
      ...node,
      overloaded,
      recommended_tier: overloaded ? getNextTier(node.plan_tier)?.id ?? null : null,
    };
  });

  // Mesh-wide "add a node" signal: every online node is at/over threshold, i.e.
  // there's nowhere left to route new load. A single hot node with other nodes
  // still under threshold is a rebalancing concern, not a capacity one, so it's
  // surfaced via each node's own `overloaded` flag instead of this.
  const onlineNodes = nodes.filter((n) => n.online);
  const scalingWarning = onlineNodes.length > 0 && onlineNodes.every((n) => n.overloaded);

  return {
    nodes,
    scalingWarning,
    thresholds: {
      cpu_pct: NODE_CPU_ALERT_PCT,
      mem_pct: NODE_MEM_ALERT_PCT,
      bandwidth_cap_mbps: NODE_BANDWIDTH_CAP_MBPS,
      bandwidth_alert_pct: NODE_BANDWIDTH_ALERT_PCT,
    },
  };
}
