// Shared load thresholds for media_nodes — used both to flag a node "overloaded"
// in the admin nodes listing (adminController.ts) and to rank candidate nodes in
// the shared-node load balancer (discovery.ts's getBestSharedNode). Kept in one
// place so the two don't drift into disagreeing about what counts as "hot".
export const NODE_CPU_ALERT_PCT = Number(process.env.NODE_CPU_ALERT_PCT ?? 80);
export const NODE_MEM_ALERT_PCT = Number(process.env.NODE_MEM_ALERT_PCT ?? 85);
// Bandwidth is the primary capacity signal for a relay node (it saturates NIC
// throughput long before CPU/mem), but unlike percentages there's no universal
// default — it depends entirely on the droplet plan's actual network cap. 800
// Mbps is a placeholder; set NODE_BANDWIDTH_CAP_MBPS per real node/plan sizing.
export const NODE_BANDWIDTH_CAP_MBPS = Number(process.env.NODE_BANDWIDTH_CAP_MBPS ?? 800);
export const NODE_BANDWIDTH_ALERT_PCT = Number(process.env.NODE_BANDWIDTH_ALERT_PCT ?? 80);
