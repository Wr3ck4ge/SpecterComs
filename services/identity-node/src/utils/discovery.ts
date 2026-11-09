import { connectNats } from '../config/nats.js';
import { pool } from '../config/db.js';
import { noteNodeAltPort } from './mediaAltPort.js';
import { StringCodec } from 'nats';
import {
  NODE_CPU_ALERT_PCT,
  NODE_MEM_ALERT_PCT,
  NODE_BANDWIDTH_CAP_MBPS,
  NODE_BANDWIDTH_ALERT_PCT,
} from '../config/nodeThresholds.js';
import { liveSql } from '../config/nodeLiveness.js';
import { HEARTBEAT_SUBJECT, acceptNodeMessage, warnRejected } from './natsSubjects.js';

// Legacy single-node cache: the URL of whichever node heartbeated last. Only
// the last resort when no media_nodes row is live. lastSeen starts at 0 (not
// boot time), so right after identity-node boots the fallback is
// ACTIVE_MEDIA_URL rather than the dev-only https://localhost:4434 (eval L1).
let activeMediaUrl = 'https://localhost:4434';
let lastSeen = 0;

// Downsamples media_node_metrics_history inserts to ~1 per node per interval —
// heartbeats arrive every 5s, but a history row every 5s would grow the table far
// faster than the trend data is actually useful for.
const HISTORY_RECORD_INTERVAL_MS = 5 * 60 * 1000;
const lastHistoryRecordedAt = new Map<string, number>();

const UNDEFINED_COLUMN = '42703';
const UNDEFINED_TABLE = '42P01';
const isSchemaLag = (e: any) => e?.code === UNDEFINED_COLUMN || e?.code === UNDEFINED_TABLE;

export const initDiscovery = async () => {
    const sc = StringCodec();
    const nc = await connectNats();
    if (!nc) return;

    // Contract C2: scoped media.heartbeat.<NODE_ID> (the NATS server only lets a
    // node publish its own suffix), plus the legacy unscoped subject mid-rollout.
    for (const subject of [HEARTBEAT_SUBJECT, `${HEARTBEAT_SUBJECT}.*`]) {
        nc.subscribe(subject, {
            callback: (err, msg) => {
                if (err) {
                    console.error("NATS error on heartbeat:", err);
                    return;
                }
                try {
                    const data = JSON.parse(sc.decode(msg.data));
                    void handleHeartbeatMessage(msg.subject, data);
                } catch (e) {
                    console.error("Failed to parse NATS heartbeat", e);
                }
            },
        });
    }
};

/**
 * Subject-aware entry point: rejects a scoped heartbeat whose payload node_id
 * doesn't match the subject suffix (and, once NATS auth is on, a legacy
 * unscoped one for a node that isn't a legacy node), then applies it.
 */
export const handleHeartbeatMessage = (subject: string, data: any): Promise<void> => {
    const verdict = acceptNodeMessage(subject, HEARTBEAT_SUBJECT, data?.node_id);
    if (!verdict.ok) {
        warnRejected('heartbeat', verdict.reason);
        return Promise.resolve();
    }
    return handleHeartbeat(data);
};

const UPSERT_COLUMNS = `node_id, region, public_url, voice_sessions, video_viewers, video_sharers, cpu_pct, mem_pct, net_rx_mbps, net_tx_mbps`;
const UPSERT_SET = `
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
   updated_at        = NOW()`;

/**
 * Applies one decoded heartbeat payload: refreshes the legacy single-node
 * cache and upserts the node's media_nodes row (including the optional C3
 * `draining` flag — absent means false). Tests drive heartbeats through here
 * directly and await the upsert. Never rejects: DB failures are logged.
 */
export const handleHeartbeat = (data: any): Promise<void> => {
    if (data?.status === 'ok' && data.public_url) {
        activeMediaUrl = data.public_url;
        lastSeen = Date.now();
    }

    // Skipped for heartbeats without node_id (e.g. a not-yet-updated media-rust
    // binary mid-rollout) so it never throws on a partial/older payload.
    if (!(data?.status === 'ok' && data.node_id && data.public_url)) return Promise.resolve();
    noteNodeAltPort(data.public_url, data.alt_port); // optional; absent = no alternate port

    // cpu_pct/mem_pct/net_*_mbps are left NULL (not 0) when absent — an older
    // media-rust binary mid-rollout doesn't send them, and treating that as 0%
    // load would hide a node's real state from admins.
    const params = [
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
    ];
    const draining = data.draining === true;
    const upsert = () => pool.query(
        `INSERT INTO media_nodes (${UPSERT_COLUMNS}, draining, last_heartbeat_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (node_id) DO UPDATE SET ${UPSERT_SET}, draining = EXCLUDED.draining
         RETURNING id`,
        [...params, draining],
    ).catch((e: any) => {
        // Migration 000070 runs right AFTER the new containers start (deploy.ps1).
        if (!isSchemaLag(e)) throw e;
        return pool.query(
            `INSERT INTO media_nodes (${UPSERT_COLUMNS}, last_heartbeat_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             ON CONFLICT (node_id) DO UPDATE SET ${UPSERT_SET}
             RETURNING id`,
            params,
        );
    });

    return upsert().then((result) => {
        const nodeUuid = result.rows[0]?.id;
        if (!nodeUuid) return;

        const now = Date.now();
        const last = lastHistoryRecordedAt.get(data.node_id) ?? 0;
        if (now - last < HISTORY_RECORD_INTERVAL_MS) return;
        lastHistoryRecordedAt.set(data.node_id, now);

        return pool.query(
            `INSERT INTO media_node_metrics_history (node_id, cpu_pct, mem_pct, net_rx_mbps, net_tx_mbps)
             VALUES ($1, $2, $3, $4, $5)`,
            [nodeUuid, data.cpu_pct ?? null, data.mem_pct ?? null, data.net_rx_mbps ?? null, data.net_tx_mbps ?? null]
        ).then(() => undefined)
         .catch((e: unknown) => console.error('[discovery] media_node_metrics_history insert failed:', e));
    }).catch((e: unknown) => console.error('[discovery] media_nodes upsert failed:', e));
};

export const getActiveMediaUrl = () => {
    // Fallback if heartbeats are stale or missing (timeout 10 seconds)
    if (Date.now() - lastSeen > 10000) {
        return process.env.ACTIVE_MEDIA_URL || 'https://localhost:4434';
    }
    return activeMediaUrl;
};

/**
 * Live public_url for an org's assignment row (pinned or auto), or null if the
 * org has none, or its node's heartbeat is stale. Uses the same liveness
 * window (config/nodeLiveness.ts) as the admin listing, so "online" for admins
 * and the routing decision never disagree.
 */
export const getNodeForOrg = async (orgId: string): Promise<string | null> => {
    const result = await pool.query(
        `SELECT mn.public_url
         FROM org_node_assignments ona
         JOIN media_nodes mn ON mn.id = ona.node_id
         WHERE ona.org_id = $1
           AND ${liveSql('mn.last_heartbeat_at')}`,
        [orgId]
    );
    return result.rows.length > 0 ? result.rows[0].public_url : null;
};

interface NodeChoice { id: string; public_url: string }

/**
 * The shared-tenancy, in-service, live node with the most headroom, preferring
 * nodes that don't report `draining`. Draining is a preference, not a filter:
 * media-rust sets it for ≥10 s after ANY drain_org on that node, and drain_org
 * fans out to every relay — so a hard filter would leave no candidate at all
 * during every migration. "Most headroom" = lowest of (cpu, mem, bandwidth) each as a
 * fraction of its alert threshold (config/nodeThresholds.ts). NULL metrics
 * count as 0 load. Ties (e.g. co-located relays reporting the same host-wide
 * numbers, eval M6) break on fewer voice sessions, then node_id, so the choice
 * is deterministic.
 */
export async function pickBestSharedNode(excludeNodeUuids: string[] = []): Promise<NodeChoice | null> {
    const bandwidthAlertMbps = (NODE_BANDWIDTH_ALERT_PCT / 100) * NODE_BANDWIDTH_CAP_MBPS;
    const run = (withDraining: boolean) => pool.query(
        `SELECT id, public_url
         FROM media_nodes
         WHERE tenancy_mode = 'shared'
           AND in_service = true
           AND ${liveSql('last_heartbeat_at')}
           AND NOT (id = ANY($4::uuid[]))
         ORDER BY ${withDraining ? 'draining ASC,' : ''} GREATEST(
           COALESCE(cpu_pct, 0) / $1,
           COALESCE(mem_pct, 0) / $2,
           COALESCE(GREATEST(net_rx_mbps, net_tx_mbps), 0) / $3
         ) ASC, voice_sessions ASC, node_id ASC
         LIMIT 1`,
        [NODE_CPU_ALERT_PCT, NODE_MEM_ALERT_PCT, bandwidthAlertMbps, excludeNodeUuids]
    );
    const result = await run(true).catch((e: any) => {
        if (isSchemaLag(e)) return run(false);
        throw e;
    });
    return result.rows[0] ?? null;
}

/** URL form of pickBestSharedNode, for orgs with no assignment row. */
export const getBestSharedNode = async (): Promise<string | null> =>
    (await pickBestSharedNode())?.public_url ?? null;

interface PlacementRow {
    node_uuid: string;
    placement: 'pinned' | 'auto';
    state: 'active' | 'draining';
    target_node_id: string | null;
    epoch: number;
    stuck_draining: boolean;
    node_url: string;
    node_live: boolean;
    target_url: string | null;
    target_live: boolean;
}

/** A migration whose final step never ran (process restart) is finalized after this long. */
const STUCK_DRAINING_SECONDS = 120;

async function readPlacement(orgId: string): Promise<PlacementRow | null> {
    const r = await pool.query(
        `SELECT ona.node_id AS node_uuid, ona.placement, ona.state, ona.target_node_id, ona.epoch,
                (ona.state = 'draining' AND ona.updated_at < NOW() - make_interval(secs => ${STUCK_DRAINING_SECONDS})) AS stuck_draining,
                mn.public_url AS node_url,
                ${liveSql('mn.last_heartbeat_at')} AS node_live,
                tn.public_url AS target_url,
                COALESCE(${liveSql('tn.last_heartbeat_at')}, false) AS target_live
         FROM org_node_assignments ona
         JOIN media_nodes mn ON mn.id = ona.node_id
         LEFT JOIN media_nodes tn ON tn.id = ona.target_node_id
         WHERE ona.org_id = $1`,
        [orgId],
    );
    return r.rows[0] ?? null;
}

/**
 * Sticky placement (eval H1). Every member of an org must land on the same
 * relay — media-rust has no cross-node forwarding — so the node is chosen once
 * and stored:
 *
 *  - no row         → pick the best shared node and INSERT an 'auto' row
 *                     (ON CONFLICT DO NOTHING, then re-read, so concurrent
 *                     first tickets all agree on whichever insert won);
 *  - draining       → the migration target (utils/nodeLifecycle.migrateOrg);
 *  - node live      → that node, however loaded (placement is never redone
 *                     just because load shifted);
 *  - node stale, auto   → re-place: compare-and-swap the row onto the best other
 *                     live node, then re-read (again, everyone agrees);
 *  - node stale, pinned → a SHARED failover target, stored in target_node_id
 *                     the same way, so all members fail over together; the pin
 *                     is kept and the org returns home when its node is back.
 *  - nothing live   → the legacy cache / ACTIVE_MEDIA_URL; nothing is written.
 */
async function resolvePlaced(orgId: string): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt++) {
        const row = await readPlacement(orgId);
        if (!row) {
            const best = await pickBestSharedNode();
            if (!best) return getActiveMediaUrl();
            await pool.query(
                `INSERT INTO org_node_assignments (org_id, node_id, placement)
                 VALUES ($1, $2, 'auto')
                 ON CONFLICT (org_id) DO NOTHING`,
                [orgId, best.id],
            );
            continue;
        }

        if (row.state === 'draining') {
            if (row.stuck_draining && row.target_node_id) {
                await finalizeMigration(orgId, row.target_node_id, row.epoch);
                continue;
            }
            if (row.target_live && row.target_url) return row.target_url;
            // Target died mid-migration: keep serving from the current node if it's live.
        }

        if (row.node_live) return row.node_url;

        if (row.placement === 'auto') {
            const best = await pickBestSharedNode([row.node_uuid]);
            if (!best) return getActiveMediaUrl();
            await pool.query(
                `UPDATE org_node_assignments
                 SET node_id = $2, state = 'active', target_node_id = NULL, epoch = epoch + 1, updated_at = NOW()
                 WHERE org_id = $1 AND node_id = $3`,
                [orgId, best.id, row.node_uuid],
            );
            continue;
        }

        // Pinned, node stale.
        if (row.state === 'active' && row.target_node_id && row.target_live && row.target_url) return row.target_url;
        const best = await pickBestSharedNode([row.node_uuid]);
        if (!best) return getActiveMediaUrl();
        await pool.query(
            `UPDATE org_node_assignments
             SET target_node_id = $2, updated_at = NOW()
             WHERE org_id = $1 AND node_id = $3 AND state = 'active'
               AND target_node_id IS NOT DISTINCT FROM $4::uuid`,
            [orgId, best.id, row.node_uuid, row.target_node_id],
        );
    }
    // Lost every race (pathological churn): answer from the latest row, unsticky.
    return (await getNodeForOrg(orgId)) || (await getBestSharedNode()) || getActiveMediaUrl();
}

/** Last step of a migration: the target becomes the org's node. CAS on epoch. */
export async function finalizeMigration(orgId: string, targetNodeUuid: string, epoch: number): Promise<boolean> {
    const r = await pool.query(
        `UPDATE org_node_assignments
         SET node_id = $2, state = 'active', target_node_id = NULL, updated_at = NOW()
         WHERE org_id = $1 AND state = 'draining' AND target_node_id = $2 AND epoch = $3`,
        [orgId, targetNodeUuid, epoch],
    );
    return (r.rowCount ?? 0) > 0;
}

/** Pre-000070 routing: explicit live pin, else least-loaded shared node, else legacy cache. Never writes. */
async function resolveUnplaced(orgId: string): Promise<string> {
    const assignedMediaUrl = await getNodeForOrg(orgId);
    return assignedMediaUrl || (await getBestSharedNode()) || getActiveMediaUrl();
}

/**
 * The media node a new ticket for this org should point at (called by
 * orgController.getOrgChannelAccessContext for every media/org token).
 * Falls back to the pre-placement policy if the 000070 schema isn't there yet.
 */
export const resolveMediaUrlForOrg = async (orgId: string): Promise<string> => {
    try {
        return await resolvePlaced(orgId);
    } catch (e: any) {
        if (!isSchemaLag(e)) console.error('[discovery] sticky placement failed, using unplaced routing:', e?.message ?? e);
        return resolveUnplaced(orgId);
    }
};
