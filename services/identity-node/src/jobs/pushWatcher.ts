import { getNodesWithStatus } from '../utils/nodeStatus.js';
import { sendNodeOfflineAlert, sendNodeOverloadedAlert, sendScalingWarningAlert } from '../utils/pushService.js';
import { logNodeAlertEvent } from '../utils/nodeAlertLog.js';

// Polls the same node-status derivation the admin /admin/nodes listing uses
// (getNodesWithStatus, shared rather than duplicated) and fires a push only on
// a state *transition* -- online->offline, not-overloaded->overloaded, or the
// mesh-wide scaling_warning flipping on -- never on every steady-state poll.
// In-memory state resets on a server restart (first poll after restart could
// theoretically miss or double-fire one transition); acceptable while
// identity-node runs as a single container, revisit if that ever changes.
const POLL_INTERVAL_MS = 10_000;

interface NodeSnapshot {
  online: boolean;
  overloaded: boolean;
}

const lastKnown = new Map<string, NodeSnapshot>();
let lastScalingWarning = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  try {
    const { nodes, scalingWarning } = await getNodesWithStatus();

    for (const node of nodes) {
      const prev = lastKnown.get(node.node_id);
      const curr: NodeSnapshot = { online: node.online, overloaded: node.overloaded };
      lastKnown.set(node.node_id, curr);

      if (!prev) continue; // first sighting of this node -- nothing to compare against yet

      if (prev.online && !curr.online) {
        console.log(`[pushWatcher] detected ${node.node_id} online->offline, sending alert`);
        const message = `${node.node_id} has stopped heartbeating.`;
        await logNodeAlertEvent('offline', node.node_id, message).catch((e) => console.error('[pushWatcher] log failed:', e));
        await sendNodeOfflineAlert(node.node_id).catch((e) => console.error('[pushWatcher] send failed:', e));
      }
      if (!prev.overloaded && curr.overloaded) {
        console.log(`[pushWatcher] detected ${node.node_id} overloaded, sending alert`);
        const message = `${node.node_id} is at or over its load threshold.`;
        await logNodeAlertEvent('overloaded', node.node_id, message).catch((e) => console.error('[pushWatcher] log failed:', e));
        await sendNodeOverloadedAlert(node.node_id).catch((e) => console.error('[pushWatcher] send failed:', e));
      }
    }

    if (!lastScalingWarning && scalingWarning) {
      console.log('[pushWatcher] detected mesh-wide scaling warning, sending alert');
      const message = 'Every online node is overloaded — no headroom left in the pool.';
      await logNodeAlertEvent('scaling_warning', null, message).catch((e) => console.error('[pushWatcher] log failed:', e));
      await sendScalingWarningAlert().catch((e) => console.error('[pushWatcher] send failed:', e));
    }
    lastScalingWarning = scalingWarning;
  } catch (e) {
    console.error('[pushWatcher] tick failed:', e);
  }
}

export function startPushWatcher(): void {
  if (timer) return; // already started
  timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
}
