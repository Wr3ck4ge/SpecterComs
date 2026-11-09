import crypto from 'crypto';
import { pool } from '../config/db.js';
import { isNatsNodeId } from './natsSubjects.js';

/**
 * Per-node NATS secrets (contract C2). A node authenticates to NATS as user
 * <NODE_ID> with password NATS_PASSWORD. Two sources:
 *   - media_node_credentials (provisioned nodes): SHA-256 of the secret, written
 *     by provisioning, deleted by teardown;
 *   - NATS_NODE_CREDENTIALS env, "id:secret,id:secret" (nodes on the control-plane
 *     droplet: node-1, node-1-green). Entries with an empty secret are ignored, so
 *     compose can template them unconditionally.
 */

const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb);
}

export function staticNodeCredentials(): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of (process.env.NATS_NODE_CREDENTIALS ?? '').split(',')) {
    const i = entry.indexOf(':');
    if (i <= 0) continue;
    const id = entry.slice(0, i).trim();
    const secret = entry.slice(i + 1).trim();
    if (isNatsNodeId(id) && secret) out.set(id, sha256(secret));
  }
  return out;
}

/** A new 256-bit secret, URL/env/heredoc-safe (base64url). */
export function generateNodeSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export async function storeNodeCredential(nodeId: string, secret: string, db: Queryable = pool): Promise<void> {
  if (!isNatsNodeId(nodeId)) throw new Error(`invalid node id ${nodeId}`);
  await db.query(
    `INSERT INTO media_node_credentials (node_id, secret_sha256) VALUES ($1, $2)
     ON CONFLICT (node_id) DO UPDATE SET secret_sha256 = EXCLUDED.secret_sha256, created_at = NOW()`,
    [nodeId, sha256(secret)],
  );
}

export async function revokeNodeCredential(nodeId: string, db: Queryable = pool): Promise<void> {
  await db.query(`DELETE FROM media_node_credentials WHERE node_id = $1`, [nodeId]);
}

/** True iff `secret` is the current NATS secret for `nodeId`. Never throws. */
export async function verifyNodeCredential(nodeId: string, secret: string, db: Queryable = pool): Promise<boolean> {
  if (!isNatsNodeId(nodeId) || !secret) return false;
  const given = sha256(secret);
  const fromEnv = staticNodeCredentials().get(nodeId);
  if (fromEnv && timingSafeEqualHex(fromEnv, given)) return true;
  try {
    const r = await db.query(`SELECT secret_sha256 FROM media_node_credentials WHERE node_id = $1`, [nodeId]);
    const stored = r.rows[0]?.secret_sha256;
    return typeof stored === 'string' && timingSafeEqualHex(stored, given);
  } catch (e) {
    console.error('[nats-auth] credential lookup failed:', (e as Error).message);
    return false;
  }
}
