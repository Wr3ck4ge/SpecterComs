// Shared load thresholds for media_nodes — used both to flag a node "overloaded"
// in the admin nodes listing (adminController.ts) and to rank candidate nodes in
// the shared-node load balancer (discovery.ts's getBestSharedNode). Kept in one
// place so the two don't drift into disagreeing about what counts as "hot".
//
// envNumber: a typo'd override (e.g. "80%") falls back to the default with a
// warning instead of becoming NaN and silently disabling the check.
import { envNumber } from './envNumber.js';

export const NODE_CPU_ALERT_PCT = envNumber('NODE_CPU_ALERT_PCT', 80, { min: 1, max: 100 });
export const NODE_MEM_ALERT_PCT = envNumber('NODE_MEM_ALERT_PCT', 85, { min: 1, max: 100 });
// Bandwidth is the primary capacity signal for a relay node (it saturates NIC
// throughput long before CPU/mem), but unlike percentages there's no universal
// default — it depends entirely on the droplet plan's actual network cap. 800
// Mbps is a placeholder; set NODE_BANDWIDTH_CAP_MBPS per real node/plan sizing.
export const NODE_BANDWIDTH_CAP_MBPS = envNumber('NODE_BANDWIDTH_CAP_MBPS', 800, { min: 1 });
export const NODE_BANDWIDTH_ALERT_PCT = envNumber('NODE_BANDWIDTH_ALERT_PCT', 80, { min: 1, max: 100 });

// A node must stay continuously over threshold this long before it's flagged
// "overloaded" (and can in turn count toward scaling_warning) -- on a small/single-node
// deployment a brief CPU blip (cert renewal, healthchecks, GC pause, etc.) can cross
// NODE_CPU_ALERT_PCT for a single 5s heartbeat without reflecting real sustained load.
export const NODE_OVERLOAD_SUSTAIN_SECONDS = envNumber('NODE_OVERLOAD_SUSTAIN_SECONDS', 30, { min: 0 });
