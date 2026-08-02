import { connectNats } from '../config/nats.js';
import { pool } from '../config/db.js';
import { StringCodec } from 'nats';
import {
  NODE_CPU_ALERT_PCT,
  NODE_MEM_ALERT_PCT,
  NODE_BANDWIDTH_CAP_MBPS,
  NODE_BANDWIDTH_ALERT_PCT,
} from '../config/nodeThresholds.js';

// Keep track of the active node
let activeMediaUrl = 'https://localhost:4434'; // Default to Green
let lastSeen = Date.now();

// Downsamples media_node_metrics_history inserts to ~1 per node per interval —
// heartbeats arrive every 5s, but a history row every 5s would grow the table far
// faster than the trend data is actually useful for.
const HISTORY_RECORD_INTERVAL_MS = 5 * 60 * 1000;
const lastHistoryRecordedAt = new Map<string, number>();

export const initDiscovery = async () => {
    const sc = StringCodec();
    const nc = await connectNats();
    if (!nc) return;

    nc.subscribe("media.heartbeat", {
        callback: (err, msg) => {
            if (err) {
                console.error("NATS error on heartbeat:", err);
                return;
            }
            try {
                const data = JSON.parse(sc.decode(msg.data));
                if (data.status === 'ok' && data.public_url) {
                    activeMediaUrl = data.public_url;
                    lastSeen = Date.now();
                }

                // Phase A of multi-tenant infra (media_nodes control-plane table) —
                // additive side effect, independent of the legacy single-node cache
                // above. Skipped for heartbeats without node_id (e.g. a
                // not-yet-updated media-rust binary mid-rollout) so it never throws
                // on a partial/older payload.
                if (data.status === 'ok' && data.node_id && data.public_url) {
                    // cpu_pct/mem_pct/net_*_mbps are left NULL (not 0) when absent —
                    // an older media-rust binary mid-rollout doesn't send them, and
                    // treating that as 0% load would hide a node's real state from admins.
                    pool.query(
                        `INSERT INTO media_nodes
                           (node_id, region, public_url, voice_sessions, video_viewers, video_sharers, cpu_pct, mem_pct, net_rx_mbps, net_tx_mbps, last_heartbeat_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                         ON CONFLICT (node_id) DO UPDATE SET
                           region            = EXCLUDED.region,
                           public_url        = EXCLUDED.public_url,
                           voice_sessions    = EXCLUDED.voice_sessions,
                           video_viewers     = EXCLUDED.video_viewers,
                           video_sharers     = EXCLUDED.video_sharers,
                           cpu_pct           = EXCLUDED.cpu_pct,
                           mem_pct           = EXCLUDED.mem_pct,
                           net_rx_mbps       = EXCLUDED.net_rx_mbps,
                           net_tx_mbps       = EXCLUDED.net_tx_mbps,
                           last_heartbeat_at = NOW(),
                           updated_at        = NOW()
                         RETURNING id`,
                        [
                            data.node_id,
                            data.region ?? 'default',
                            data.public_url,
                            data.voice_sessions ?? 0,
                            data.video_viewers ?? 0,
                            data.video_sharers ?? 0,
                            data.cpu_pct ?? null,
                            data.mem_pct ?? null,
                            data.net_rx_mbps ?? null,
                            data.net_tx_mbps ?? null,
                        ]
                    ).then((result) => {
                        const nodeUuid = result.rows[0]?.id;
                        if (!nodeUuid) return;

                        const now = Date.now();
                        const last = lastHistoryRecordedAt.get(data.node_id) ?? 0;
                        if (now - last < HISTORY_RECORD_INTERVAL_MS) return;
                        lastHistoryRecordedAt.set(data.node_id, now);

                        pool.query(
                            `INSERT INTO media_node_metrics_history (node_id, cpu_pct, mem_pct, net_rx_mbps, net_tx_mbps)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [nodeUuid, data.cpu_pct ?? null, data.mem_pct ?? null, data.net_rx_mbps ?? null, data.net_tx_mbps ?? null]
                        ).catch((e: unknown) => console.error('[discovery] media_node_metrics_history insert failed:', e));
                    }).catch((e: unknown) => console.error('[discovery] media_nodes upsert failed:', e));
                }
            } catch (e) {
                console.error("Failed to parse NATS heartbeat", e);
            }
        },
    });
};

export const getActiveMediaUrl = () => {
    // Fallback if heartbeats are stale or missing (timeout 10 seconds)
    if (Date.now() - lastSeen > 10000) {
        // As a default fallback we could use the ENV var or return 4434
        return process.env.ACTIVE_MEDIA_URL || 'https://localhost:4434';
    }
    return activeMediaUrl;
};

/**
 * Live public_url for an org's explicit node assignment, or null if the org has no
 * assignment, or its assigned node's heartbeat has gone stale — callers must fall
 * back to getActiveMediaUrl() in that case rather than routing to a dead node.
 *
 * 15s threshold = 3 missed 5s heartbeat ticks. Reused verbatim by the admin nodes
 * listing query so the "online" status shown to admins and this actual routing
 * decision can never disagree.
 */
export const getNodeForOrg = async (orgId: string): Promise<string | null> => {
    const result = await pool.query(
        `SELECT mn.public_url
         FROM org_node_assignments ona
         JOIN media_nodes mn ON mn.id = ona.node_id
         WHERE ona.org_id = $1
           AND mn.last_heartbeat_at > NOW() - INTERVAL '15 seconds'`,
        [orgId]
    );
    return result.rows.length > 0 ? result.rows[0].public_url : null;
};

/**
 * Picks the shared-tenancy, in-service, online node with the most headroom, for
 * orgs with no explicit org_node_assignments row. "Most headroom" = lowest of
 * (cpu_pct, mem_pct, bandwidth) each expressed as a fraction of its own alert
 * threshold from config/nodeThresholds.ts, so the three resources are compared
 * on the same scale rather than raw units. Nodes with no metrics yet (NULL —
 * e.g. mid-rollout to an older media-rust build) are treated as 0 load, not
 * excluded, so a freshly-online node is still eligible.
 *
 * Only considers `in_service = true` nodes — a node existing in media_nodes
 * (i.e. it's heartbeating) is not by itself permission to start routing new
 * orgs onto it; see 000052_media_node_in_service.up.sql.
 */
export const getBestSharedNode = async (): Promise<string | null> => {
    const bandwidthAlertMbps = (NODE_BANDWIDTH_ALERT_PCT / 100) * NODE_BANDWIDTH_CAP_MBPS;
    const result = await pool.query(
        `SELECT public_url
         FROM media_nodes
         WHERE tenancy_mode = 'shared'
           AND in_service = true
           AND last_heartbeat_at > NOW() - INTERVAL '15 seconds'
         ORDER BY GREATEST(
           COALESCE(cpu_pct, 0) / $1,
           COALESCE(mem_pct, 0) / $2,
           COALESCE(GREATEST(net_rx_mbps, net_tx_mbps), 0) / $3
         ) ASC
         LIMIT 1`,
        [NODE_CPU_ALERT_PCT, NODE_MEM_ALERT_PCT, bandwidthAlertMbps]
    );
    return result.rows.length > 0 ? result.rows[0].public_url : null;
};