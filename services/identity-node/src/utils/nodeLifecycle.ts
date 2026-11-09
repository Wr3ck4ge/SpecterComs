import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { getMediaTicketPublicKeyPem } from '../config/mediaTicketKey.js';
import { liveSql } from '../config/nodeLiveness.js';
import { finalizeMigration, pickBestSharedNode } from './discovery.js';
import {
  provisionNode, destroyNodeInfrastructure, listManagedDroplets, generateNodeId, nodeAddresses,
  ProvisionError, DROPLET_SIZE_TIER_ID,
} from './doProvisioning.js';
import { generateNodeSecret, storeNodeCredential, revokeNodeCredential } from './nodeCredentials.js';
import { legacyNodeIds } from './natsSubjects.js';

/**
 * Node and org lifecycle on top of discovery's placement table:
 *   provisionMediaNode — credential + out-of-service row + droplet, rolled back on failure
 *   migrateOrg        — move one org (a "cell") to another node, break-before-make
 *   teardownNode      — move its orgs away, revoke NATS, delete A record + droplet + row
 *   findOrphanDroplets — specter-managed droplets the control plane has no record of
 */

export class LifecycleError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type Publish = (subject: string, data: unknown) => Promise<void>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── migrateOrg ────────────────────────────────────────────────────────────────

export interface MigrateResult { orgId: string; from: string | null; to: string; epoch: number; finalized: boolean }

/**
 * Moves an org to `targetNodeId` (human node id), break-before-make with
 * today's clients (eval §7.2 fallback path):
 *   1. mark the org draining → target (new tickets resolve to the target at once);
 *   2. publish the existing specter.cmd.drain_org.<org>: every relay closes the
 *      org's sessions, clients auto-reconnect and re-ticket onto the target;
 *   3. after settleMs, clear draining: the target becomes the org's node.
 * Pinned orgs stay pinned (to the new node); auto ones stay auto.
 */
export async function migrateOrg(
  orgId: string,
  targetNodeId: string,
  opts: { settleMs?: number; publish?: Publish } = {},
): Promise<MigrateResult> {
  const publish = opts.publish ?? publishEvent;
  const target = (await pool.query(
    `SELECT id FROM media_nodes WHERE node_id = $1 AND ${liveSql('last_heartbeat_at')}`,
    [targetNodeId],
  )).rows[0];
  if (!target) throw new LifecycleError(`Target node ${targetNodeId} is unknown or not live`, 409);

  const before = (await pool.query(
    `SELECT ona.node_id, mn.node_id AS human FROM org_node_assignments ona
     JOIN media_nodes mn ON mn.id = ona.node_id WHERE ona.org_id = $1`,
    [orgId],
  )).rows[0];

  let epoch: number;
  if (before) {
    const r = await pool.query(
      `UPDATE org_node_assignments
       SET state = 'draining', target_node_id = $2, epoch = epoch + 1, updated_at = NOW()
       WHERE org_id = $1
       RETURNING epoch`,
      [orgId, target.id],
    );
    epoch = r.rows[0].epoch;
  } else {
    // Unplaced org: it lands on the target directly; the drain below still
    // moves any member currently on some other relay.
    const r = await pool.query(
      `INSERT INTO org_node_assignments (org_id, node_id, placement) VALUES ($1, $2, 'auto')
       ON CONFLICT (org_id) DO UPDATE SET state = 'draining', target_node_id = EXCLUDED.node_id,
         epoch = org_node_assignments.epoch + 1, updated_at = NOW()
       RETURNING epoch, state`,
      [orgId, target.id],
    );
    epoch = r.rows[0].epoch;
  }

  await publish(`specter.cmd.drain_org.${orgId}`, {});
  if (opts.settleMs) await sleep(opts.settleMs);
  const finalized = before ? await finalizeMigration(orgId, target.id, epoch) : true;
  return { orgId, from: before?.human ?? null, to: targetNodeId, epoch, finalized };
}

// ── provisionMediaNode ────────────────────────────────────────────────────────

export interface ProvisionConfig {
  region: string;
  nodeId?: string;
  requestedBy: string | null;
  natsUrl: string;
  mediaImageRef: string;
  ghcrPullToken: string;
  ghcrPullUser: string;
  vpcUuid?: string;
}

export async function provisionMediaNode(cfg: ProvisionConfig) {
  const publicKey = getMediaTicketPublicKeyPem();
  if (!publicKey) {
    // Remote nodes never get JWT_SECRET, so they can only verify ES256 tickets.
    throw new LifecycleError('MEDIA_TICKET_PRIVATE_KEY is not configured — a remote node could not verify media tickets without the platform JWT secret.', 503);
  }
  const nodeId = cfg.nodeId || generateNodeId();
  const { publicUrl } = nodeAddresses(nodeId);
  const secret = generateNodeSecret();

  // The NATS credential must exist before the node boots; the row is created
  // out of service (eval M7) and tagged with its plan tier (eval L2). An admin
  // puts it in service (PUT /admin/nodes/:id) after checking it.
  await storeNodeCredential(nodeId, secret);
  await pool.query(
    `INSERT INTO media_nodes (node_id, region, public_url, in_service, plan_tier)
     VALUES ($1, $2, $3, false, $4)
     ON CONFLICT (node_id) DO NOTHING`,
    [nodeId, cfg.region, publicUrl, DROPLET_SIZE_TIER_ID],
  );
  const undoDb = async () => {
    await revokeNodeCredential(nodeId).catch((e) => console.error('[provision] revoke failed:', e));
    await pool.query(`DELETE FROM media_nodes WHERE node_id = $1 AND last_heartbeat_at IS NULL`, [nodeId])
      .catch((e) => console.error('[provision] media_nodes cleanup failed:', e));
  };

  let result;
  try {
    result = await provisionNode({
      region: cfg.region,
      nodeId,
      natsUrl: cfg.natsUrl,
      natsPassword: secret,
      mediaTicketPublicKey: publicKey,
      mediaImageRef: cfg.mediaImageRef,
      ghcrPullToken: cfg.ghcrPullToken,
      ghcrPullUser: cfg.ghcrPullUser,
      vpcUuid: cfg.vpcUuid,
    });
  } catch (e) {
    await undoDb();
    if (e instanceof ProvisionError) {
      await pool.query(
        `INSERT INTO node_provision_requests (node_id, region, droplet_id, status, requested_by, last_error)
         VALUES ($1, $2, $3, 'failed', $4, $5)`,
        [nodeId, cfg.region, e.dropletId, cfg.requestedBy, e.message.slice(0, 2000)],
      ).catch((err) => console.error('[provision] could not record failed request:', err));
    }
    throw e;
  }

  try {
    await pool.query(
      `INSERT INTO node_provision_requests (node_id, region, droplet_id, dns_record_id, requested_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [result.nodeId, cfg.region, result.dropletId, result.dnsRecordId, cfg.requestedBy],
    );
  } catch (e) {
    // Without a record nothing would ever clean this droplet up.
    const cleanup = await destroyNodeInfrastructure({ nodeId, dropletId: result.dropletId, dnsRecordId: result.dnsRecordId });
    await undoDb();
    throw new ProvisionError(
      `Provisioned droplet ${result.dropletId} but could not record it (${(e as Error).message}); ${cleanup.dropletDeleted ? 'it was deleted' : `CLEANUP INCOMPLETE: ${cleanup.errors.join('; ')}`}`,
      result.dropletId, cleanup.dropletDeleted, e,
    );
  }
  return result;
}

// ── teardownNode ──────────────────────────────────────────────────────────────

export interface TeardownResult {
  nodeId: string;
  migratedOrgs: MigrateResult[];
  droppedOrgs: string[];
  dropletDeleted: boolean;
  dnsDeleted: boolean | null;
  rowDeleted: boolean;
  errors: string[];
}

/**
 * Retires a provisioned node: out of service → its orgs migrated to other live
 * nodes (drain_org per org) → NATS credential revoked → A record and droplet
 * deleted → media_nodes row deleted (cascades its assignments). Refuses the
 * control-plane droplet's own relays (node-1/node-1-green), and only deletes a
 * droplet carrying the specter-managed tag and the node's name.
 *
 * If no other live node can take an org, it refuses unless `force` (then the
 * org's assignment is dropped and it re-places on its next ticket).
 */
export async function teardownNode(
  nodeId: string,
  opts: { force?: boolean; settleMs?: number; publish?: Publish } = {},
): Promise<TeardownResult> {
  if (legacyNodeIds().includes(nodeId) || nodeId === 'node-1') {
    throw new LifecycleError(`${nodeId} runs on the control-plane droplet and cannot be torn down`, 400);
  }
  const node = (await pool.query(`SELECT id FROM media_nodes WHERE node_id = $1`, [nodeId])).rows[0] as { id: string } | undefined;
  const request = (await pool.query(
    `SELECT droplet_id, dns_record_id FROM node_provision_requests WHERE node_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [nodeId],
  )).rows[0];
  if (!node && !request) throw new LifecycleError(`Unknown node ${nodeId}`, 404);

  const migratedOrgs: MigrateResult[] = [];
  const droppedOrgs: string[] = [];
  if (node) {
    await pool.query(`UPDATE media_nodes SET in_service = false, updated_at = NOW() WHERE id = $1`, [node.id]);
    const orgs = (await pool.query(
      `SELECT org_id FROM org_node_assignments WHERE node_id = $1 OR target_node_id = $1`,
      [node.id],
    )).rows as Array<{ org_id: string }>;
    const target = orgs.length ? await pickBestSharedNode([node.id]) : null;
    const targetHuman = target
      ? (await pool.query(`SELECT node_id FROM media_nodes WHERE id = $1`, [target.id])).rows[0]?.node_id
      : null;
    if (orgs.length && !targetHuman && !opts.force) {
      throw new LifecycleError(`${orgs.length} org(s) are placed on ${nodeId} and no other live shared node can take them (pass force to drop their placement)`, 409);
    }
    for (const { org_id } of orgs) {
      if (targetHuman) {
        migratedOrgs.push(await migrateOrg(org_id, targetHuman, { settleMs: opts.settleMs, publish: opts.publish }));
      } else {
        await pool.query(`DELETE FROM org_node_assignments WHERE org_id = $1`, [org_id]);
        await (opts.publish ?? publishEvent)(`specter.cmd.drain_org.${org_id}`, {});
        droppedOrgs.push(org_id);
      }
    }
  }

  await revokeNodeCredential(nodeId);
  const destroyed = await destroyNodeInfrastructure({
    nodeId,
    dropletId: request?.droplet_id != null ? Number(request.droplet_id) : null,
    dnsRecordId: request?.dns_record_id != null ? Number(request.dns_record_id) : null,
    lookup: true,
    verifyTag: true,
  });

  let rowDeleted = false;
  if (destroyed.dropletDeleted) {
    if (node) {
      await pool.query(`DELETE FROM media_nodes WHERE id = $1`, [node.id]);
      rowDeleted = true;
    }
    await pool.query(`UPDATE node_provision_requests SET status = 'torn_down', updated_at = NOW() WHERE node_id = $1`, [nodeId]);
  }
  return {
    nodeId, migratedOrgs, droppedOrgs,
    dropletDeleted: destroyed.dropletDeleted, dnsDeleted: destroyed.dnsDeleted, rowDeleted, errors: destroyed.errors,
  };
}

// ── reconciler ────────────────────────────────────────────────────────────────

/** specter-managed droplets with no media_nodes row and no live provision record. Read-only: nothing is deleted. */
export async function findOrphanDroplets() {
  const droplets = await listManagedDroplets();
  const known = new Set<string>([
    ...(await pool.query(`SELECT node_id FROM media_nodes`)).rows.map((r: any) => r.node_id),
    ...(await pool.query(`SELECT node_id FROM node_provision_requests WHERE status IN ('provisioning', 'ready')`)).rows.map((r: any) => r.node_id),
  ]);
  return droplets.filter((d) => !known.has(d.name));
}
