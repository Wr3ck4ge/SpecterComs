import { Request, Response } from 'express';
import * as argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { publishEvent } from '../config/nats.js';
import { getJwtSecret } from '../config/jwtSecret.js';
import { provisionNode as provisionNodeOrchestrator, isValidRegion, isValidNodeId } from '../utils/doProvisioning.js';
import { DROPLET_TIERS } from '../config/dropletTiers.js';
import { getNodesWithStatus } from '../utils/nodeStatus.js';

// ─── Types ─────────────────────────────────────────────────────────────────────
interface AdminRequest extends Request {
  user?: { id: string; username: string; role: string; permissions: any };
}

export const adminLogin = async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password required' });
  }

  try {
    // Accept either username or email as the identifier
    const adminRes = await pool.query(
      'SELECT id, username, email, password_hash, permissions FROM platform_admins WHERE username = $1 OR email = $1',
      [username]
    );

    if (adminRes.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const admin = adminRes.rows[0];
    const isValid = await argon2.verify(admin.password_hash, password);

    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    await pool.query('UPDATE platform_admins SET last_login = NOW() WHERE id = $1', [admin.id]);

    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: 'platform_admin', permissions: admin.permissions },
      getJwtSecret(),
      { expiresIn: '4h' }
    );

    res.json({
      message: 'Admin login successful',
      token,
      admin: { id: admin.id, username: admin.username, email: admin.email, permissions: admin.permissions }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const getSystemStats = async (req: AuthRequest, res: Response) => {
  try {
    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    const orgCount = await pool.query('SELECT COUNT(*) FROM organizations');
    
    res.json({
      users: parseInt(userCount.rows[0].count),
      organizations: parseInt(orgCount.rows[0].count),
      status: 'operational'
    });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const listUsers = async (req: AuthRequest, res: Response) => {
  try {
    const usersRes = await pool.query(
      'SELECT id, callsign, global_tag, created_at, is_banned FROM users ORDER BY created_at DESC LIMIT 100'
    );
    res.json({ users: usersRes.rows });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const banGlobalUser = async (req: AuthRequest, res: Response) => {
    const { userId } = req.params;
    const { ban, reason } = req.body; // true to ban, false to unban
  
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // 1. Update user account 'is_banned'
        await client.query(
          'UPDATE users SET is_banned = $1 WHERE id = $2',
          [ban, userId]
        );

        // 2. Manage HWID ban
        const userRes = await client.query('SELECT hwid FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length > 0) {
           const hwid = userRes.rows[0].hwid;
           if (hwid) {
               if (ban) {
                   await client.query(
                       'INSERT INTO hardware_bans (hwid, reason) VALUES ($1, $2) ON CONFLICT (hwid) DO NOTHING',
                       [hwid, reason || 'Banned by platform admin']
                   );
               } else {
                   await client.query('DELETE FROM hardware_bans WHERE hwid = $1', [hwid]);
               }
           }
        }

        await client.query('COMMIT');
        res.json({ message: `User ${ban ? 'banned' : 'unbanned'} successfully` });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch(err) {
      console.error('Ban error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  };

// ─── Extended Admin Endpoints ──────────────────────────────────────────────────

export const listUsersExtended = async (req: AdminRequest, res: Response) => {
  const q      = (req.query.q as string || '').trim();
  const page   = Math.max(1, parseInt(req.query.page as string || '1'));
  const limit  = Math.min(100, parseInt(req.query.limit as string || '50'));
  const offset = (page - 1) * limit;

  try {
    const where = q ? `WHERE callsign ILIKE $3 OR (global_tag IS NOT NULL AND global_tag ILIKE $3)` : '';
    const params: any[] = q ? [limit, offset, `%${q}%`] : [limit, offset];

    const countQ   = q ? `SELECT COUNT(*) FROM users WHERE callsign ILIKE $1 OR (global_tag IS NOT NULL AND global_tag ILIKE $1)` : `SELECT COUNT(*) FROM users`;
    const countRes = await pool.query(countQ, q ? [`%${q}%`] : []);

    const usersRes = await pool.query(
      `SELECT id, callsign, global_tag, subscription_tier, timezone, created_at, is_banned, hwid
       FROM users
       ${where}
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    res.json({
      users: usersRes.rows,
      total: parseInt(countRes.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    console.error('List users extended error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const getUserDetail = async (req: AdminRequest, res: Response) => {
  const { userId } = req.params;
  try {
    const userRes = await pool.query(
      `SELECT id, callsign, global_tag, subscription_tier, timezone, created_at, is_banned, hwid
       FROM users WHERE id = $1`,
      [userId]
    );
    if (userRes.rowCount === 0) return res.status(404).json({ message: 'User not found' });

    const orgsRes = await pool.query(
      `SELECT o.id, o.callsign, r.name as role_name, om.joined_at
       FROM org_members om
       JOIN organizations o ON o.id = om.org_id
       LEFT JOIN org_roles r ON r.id = om.role_id
       WHERE om.user_id = $1`,
      [userId]
    );

    const hwid = userRes.rows[0].hwid;
    let isHwidBanned = false;
    if (hwid) {
      const hwidRes = await pool.query('SELECT 1 FROM hardware_bans WHERE hwid = $1', [hwid]);
      isHwidBanned = (hwidRes.rowCount ?? 0) > 0;
    }

    res.json({
      user: { ...userRes.rows[0], is_hwid_banned: isHwidBanned },
      orgs: orgsRes.rows,
    });
  } catch (err) {
    console.error('Get user detail error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const listOrgs = async (req: AdminRequest, res: Response) => {
  const q      = (req.query.q as string || '').trim();
  const page   = Math.max(1, parseInt(req.query.page as string || '1'));
  const limit  = Math.min(100, parseInt(req.query.limit as string || '50'));
  const offset = (page - 1) * limit;

  try {
    const where  = q ? `WHERE o.callsign ILIKE $3` : '';
    const params: any[] = q ? [limit, offset, `%${q}%`] : [limit, offset];

    const countQ   = q ? `SELECT COUNT(*) FROM organizations WHERE callsign ILIKE $1` : `SELECT COUNT(*) FROM organizations`;
    const countRes = await pool.query(countQ, q ? [`%${q}%`] : []);

    const orgsRes = await pool.query(
      `SELECT o.id, o.callsign, o.is_public, o.join_method, o.description, o.created_at,
              u.callsign AS owner_callsign,
              COUNT(DISTINCT om.user_id) AS member_count,
              COUNT(DISTINCT c.id)       AS channel_count,
              mn.node_id AS assigned_node_id
       FROM organizations o
       JOIN users u ON u.id = o.owner_id
       LEFT JOIN org_members om ON om.org_id = o.id
       LEFT JOIN channels c ON c.org_id = o.id
       LEFT JOIN org_node_assignments ona ON ona.org_id = o.id
       LEFT JOIN media_nodes mn ON mn.id = ona.node_id
       ${where}
       GROUP BY o.id, u.callsign, mn.node_id
       ORDER BY o.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    res.json({
      orgs: orgsRes.rows,
      total: parseInt(countRes.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    console.error('Admin list orgs error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /admin/billing/contributions?since=&limit=&offset=
 * Admin-wide, cross-org contribution feed for external consumers (e.g. EES Ledger's
 * billing sync) to mirror as bookkeeping records — SpecterComs stays the only place
 * money actually moves; this is a read-only reflection of what already happened.
 * Only `succeeded` contributions are returned — pending/failed must never be booked
 * as revenue. `credited_at` (not `created_at`) is the incremental-sync cursor since
 * it's set exactly once, only when a payment is actually confirmed.
 */
export const listBillingContributions = async (req: AdminRequest, res: Response) => {
  const since  = (req.query.since as string) || null;
  const limit  = Math.min(200, parseInt(req.query.limit as string || '50'));
  const offset = Math.max(0, parseInt(req.query.offset as string || '0'));

  try {
    const result = await pool.query(
      `SELECT bc.id, bc.org_id, o.callsign AS org_callsign,
              bc.user_id, u.callsign AS contributor_callsign,
              bc.amount_cents, bc.fee_cents, bc.payment_method, bc.provider,
              bc.status, bc.created_at, bc.credited_at,
              bc.source, bc.invoice_reason, bc.external_invoice_ref
       FROM billing_contributions bc
       JOIN organizations o ON o.id = bc.org_id
       JOIN users u ON u.id = bc.user_id
       WHERE bc.status = 'succeeded'
         AND ($3::timestamptz IS NULL OR bc.credited_at > $3::timestamptz)
       ORDER BY bc.credited_at ASC
       LIMIT $1 OFFSET $2`,
      [limit + 1, offset, since]
    );

    const hasMore = result.rows.length > limit;
    res.json({ contributions: result.rows.slice(0, limit), has_more: hasMore });
  } catch (err) {
    console.error('Admin list billing contributions error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /admin/node-alerts
 * History of node-health alerts (offline / overloaded / scaling_warning),
 * persisted independent of push delivery -- see jobs/pushWatcher.ts.
 */
export const listNodeAlertEvents = async (req: AdminRequest, res: Response) => {
  const limit  = Math.min(200, parseInt(req.query.limit as string || '50'));
  const offset = Math.max(0, parseInt(req.query.offset as string || '0'));

  try {
    const result = await pool.query(
      `SELECT id, event_type, node_id, message, created_at
       FROM node_alert_events
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit + 1, offset]
    );

    const hasMore = result.rows.length > limit;
    res.json({ events: result.rows.slice(0, limit), has_more: hasMore });
  } catch (err) {
    console.error('Admin list node alert events error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /admin/orgs/:orgId/billing-info
 * What an external invoicing tool (EES Ledger) polls to build/refresh a customer
 * record. Returns nulls rather than 404 if the org owner hasn't filled it in yet.
 */
export const getOrgBillingInfo = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  try {
    const result = await pool.query(`SELECT * FROM org_billing_info WHERE org_id = $1`, [orgId]);
    res.json(result.rows[0] ?? { org_id: orgId });
  } catch (err) {
    console.error('Admin get org billing info error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /admin/orgs/:orgId/billing/invoices
 * Body: { amount_cents: number, reason: string, external_invoice_ref: string }
 *
 * Issues a formal invoice on an org's behalf — inserts a `pending`
 * billing_contributions row the org owner later pays via POST
 * /orgs/:id/billing/invoices/:cid/pay, reusing the exact same Stripe checkout/
 * webhook/credit machinery as self-serve funding. user_id is set to the org's
 * owner_id as a placeholder (billing_contributions.user_id is NOT NULL and three
 * existing queries assume it's always set) — overwritten with the real payer's
 * id once someone actually pays.
 *
 * No Stripe session is created here (see external_invoice_ref uniqueness note
 * below) — Checkout Sessions expire in ~24h and this invoice may sit unpaid for
 * days, so the session is created lazily at pay-time instead.
 */
export const createOrgInvoice = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  const { amount_cents, reason, external_invoice_ref } = req.body as {
    amount_cents?: number;
    reason?: string;
    external_invoice_ref?: string;
  };

  if (!amount_cents || typeof amount_cents !== 'number' || !Number.isInteger(amount_cents) || amount_cents <= 0) {
    return res.status(400).json({ message: 'amount_cents must be a positive whole number' });
  }

  try {
    const orgRes = await pool.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    const ownerId = orgRes.rows[0].owner_id;

    const result = await pool.query(
      `INSERT INTO billing_contributions
         (org_id, user_id, amount_cents, fee_cents, payment_method, provider, status,
          source, invoice_reason, issued_by_admin_id, external_invoice_ref)
       VALUES ($1, $2, $3, 0, 'dev', 'dev', 'pending', 'admin_invoice', $4, $5, $6)
       RETURNING id`,
      [orgId, ownerId, amount_cents, reason ?? null, req.user?.id ?? null, external_invoice_ref ?? null]
    );
    res.status(201).json({ contribution_id: result.rows[0].id });
  } catch (err: any) {
    // uq_contrib_external_ref — this exact invoice was already pushed. 409, not a
    // raw 500, so a caller (e.g. Ledger's push flow) can tell "already pushed"
    // from a real error and not retry indefinitely.
    if (err?.code === '23505') {
      return res.status(409).json({ message: 'An invoice with this external_invoice_ref already exists for this org' });
    }
    console.error('Admin create org invoice error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const dissolveOrg = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  try {
    // Fetch members before deletion so we can notify them
    const membersRes = await pool.query('SELECT user_id FROM org_members WHERE org_id = $1', [orgId]);
    const result = await pool.query('DELETE FROM organizations WHERE id = $1 RETURNING callsign', [orgId]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Organization not found' });

    // Notify all former members that their org list changed
    for (const row of membersRes.rows) {
      await publishEvent(`specter.event.user.${row.user_id}`, { type: 'orgs_changed' });
    }

    res.json({ message: `Organization "${result.rows[0].callsign}" dissolved.` });
  } catch (err) {
    console.error('Dissolve org error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const listHwidBans = async (req: AdminRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT hb.hwid, hb.reason, hb.created_at, u.callsign, u.id AS user_id
       FROM hardware_bans hb
       LEFT JOIN users u ON u.hwid = hb.hwid
       ORDER BY hb.created_at DESC
       LIMIT 200`
    );
    res.json({ bans: result.rows });
  } catch (err) {
    console.error('List HWID bans error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const removeHwidBan = async (req: AdminRequest, res: Response) => {
  const { hwid } = req.params;
  try {
    await pool.query('DELETE FROM hardware_bans WHERE hwid = $1', [hwid]);
    res.json({ message: 'HWID ban removed.' });
  } catch (err) {
    console.error('Remove HWID ban error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const getSystemOverview = async (req: AdminRequest, res: Response) => {
  try {
    const [users, orgs, bans, hwidBans, channels, admins] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM users`),
      pool.query(`SELECT COUNT(*) FROM organizations`),
      pool.query(`SELECT COUNT(*) FROM users WHERE is_banned = true`),
      pool.query(`SELECT COUNT(*) FROM hardware_bans`),
      pool.query(`SELECT COUNT(*) FROM channels`),
      pool.query(`SELECT username, last_login FROM platform_admins ORDER BY last_login DESC NULLS LAST`),
    ]);

    const recentUsers = await pool.query(
      `SELECT callsign, created_at FROM users ORDER BY created_at DESC LIMIT 5`
    );
    const recentOrgs = await pool.query(
      `SELECT callsign, created_at FROM organizations ORDER BY created_at DESC LIMIT 5`
    );

    res.json({
      stats: {
        users:     parseInt(users.rows[0].count),
        orgs:      parseInt(orgs.rows[0].count),
        banned:    parseInt(bans.rows[0].count),
        hwidBans:  parseInt(hwidBans.rows[0].count),
        channels:  parseInt(channels.rows[0].count),
      },
      admins: admins.rows,
      recentUsers: recentUsers.rows,
      recentOrgs:  recentOrgs.rows,
      status: 'operational',
    });
  } catch (err) {
    console.error('System overview error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─── Media Nodes (Phase A of multi-tenant infra) ────────────────────────────────

export const listMediaNodes = async (req: AdminRequest, res: Response) => {
  try {
    const { nodes, scalingWarning, thresholds } = await getNodesWithStatus();
    res.json({
      nodes,
      scaling_warning: scalingWarning,
      thresholds,
      tier_catalog: DROPLET_TIERS,
    });
  } catch (err) {
    console.error('List media nodes error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const updateMediaNode = async (req: AdminRequest, res: Response) => {
  const { nodeId } = req.params; // human node_id, e.g. "node-1", not the UUID PK
  const { region, tenancy_mode, plan_tier, in_service } = req.body as {
    region?: string;
    tenancy_mode?: string;
    plan_tier?: string;
    in_service?: boolean;
  };

  if (tenancy_mode && !['shared', 'dedicated'].includes(tenancy_mode)) {
    return res.status(400).json({ message: 'tenancy_mode must be shared or dedicated' });
  }
  if (plan_tier && !DROPLET_TIERS.some((t) => t.id === plan_tier)) {
    return res.status(400).json({ message: 'plan_tier must be a known tier id' });
  }

  try {
    const result = await pool.query(
      `UPDATE media_nodes
       SET region       = COALESCE($2, region),
           tenancy_mode = COALESCE($3, tenancy_mode),
           plan_tier    = COALESCE($4, plan_tier),
           in_service   = COALESCE($5, in_service),
           updated_at   = NOW()
       WHERE node_id = $1`,
      [nodeId, region ?? null, tenancy_mode ?? null, plan_tier ?? null, in_service ?? null]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: 'Node not found' });
    res.json({ message: 'Node updated.' });
  } catch (err) {
    console.error('Update media node error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const getNodeMetricsHistory = async (req: AdminRequest, res: Response) => {
  const { nodeId } = req.params; // human node_id, e.g. "node-1", not the UUID PK
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);

  try {
    const result = await pool.query(
      `SELECT h.cpu_pct, h.mem_pct, h.net_rx_mbps, h.net_tx_mbps, h.recorded_at
       FROM media_node_metrics_history h
       JOIN media_nodes mn ON mn.id = h.node_id
       WHERE mn.node_id = $1
         AND h.recorded_at > NOW() - ($2 || ' hours')::INTERVAL
       ORDER BY h.recorded_at ASC
       LIMIT 5000`,
      [nodeId, hours]
    );
    res.json({ history: result.rows });
  } catch (err) {
    console.error('Get node metrics history error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const assignOrgToNode = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  const { node_id } = req.body as { node_id?: string };
  if (!node_id) return res.status(400).json({ message: 'node_id is required' });

  try {
    const nodeRes = await pool.query('SELECT id FROM media_nodes WHERE node_id = $1', [node_id]);
    if (nodeRes.rowCount === 0) return res.status(404).json({ message: 'Node not found' });
    const nodeUuid = nodeRes.rows[0].id;

    const orgRes = await pool.query('SELECT id FROM organizations WHERE id = $1', [orgId]);
    if (orgRes.rowCount === 0) return res.status(404).json({ message: 'Organization not found' });

    await pool.query(
      `INSERT INTO org_node_assignments (org_id, node_id)
       VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET
         node_id    = EXCLUDED.node_id,
         updated_at = NOW()`,
      [orgId, nodeUuid]
    );
    res.json({ message: 'Org assigned to node.' });
  } catch (err) {
    console.error('Assign org to node error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const unassignOrgFromNode = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  try {
    const result = await pool.query('DELETE FROM org_node_assignments WHERE org_id = $1', [orgId]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'No assignment for this org' });
    res.json({ message: 'Org unassigned — routes to shared default capacity.' });
  } catch (err) {
    console.error('Unassign org from node error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Force-closes every active session for one org across whatever node(s) currently
// host it, without affecting other orgs sharing the same node — e.g. as the last
// step of a node migration, or to temporarily suspend an org's voice/video. Kept
// deliberately separate from assign/unassignOrgFromNode: reassigning routing and
// hard-closing live sessions are two independent operations, and callers may want
// either one without the other.
export const drainOrg = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  try {
    const orgRes = await pool.query('SELECT id FROM organizations WHERE id = $1', [orgId]);
    if (orgRes.rowCount === 0) return res.status(404).json({ message: 'Organization not found' });

    await publishEvent(`specter.cmd.drain_org.${orgId}`, {});
    res.json({ message: 'Drain command sent.' });
  } catch (err) {
    console.error('Drain org error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// ─── Node Provisioning (Phase B of multi-tenant infra) ──────────────────────────

export const provisionNode = async (req: AdminRequest, res: Response) => {
  const { region, node_id } = req.body as { region?: string; node_id?: string };
  if (!region) return res.status(400).json({ message: 'region is required' });
  if (!isValidRegion(region)) return res.status(400).json({ message: 'Unsupported region' });
  if (node_id && !isValidNodeId(node_id)) {
    return res.status(400).json({ message: 'node_id must be 3-20 lowercase letters, digits, or hyphens' });
  }

  try {
    if (node_id) {
      // Fail before ever calling the DO API — a collision discovered only after
      // the droplet already exists (e.g. at DNS record creation) would leave an
      // orphaned billable droplet with no automated cleanup (see Phase B plan's
      // "no auto-rollback" risk note).
      const [existingNode, existingRequest] = await Promise.all([
        pool.query('SELECT 1 FROM media_nodes WHERE node_id = $1', [node_id]),
        pool.query(`SELECT 1 FROM node_provision_requests WHERE node_id = $1 AND status = 'provisioning'`, [node_id]),
      ]);
      if ((existingNode.rowCount ?? 0) > 0 || (existingRequest.rowCount ?? 0) > 0) {
        return res.status(409).json({ message: `node_id "${node_id}" is already in use or currently provisioning` });
      }
    }

    // New nodes join the same JWT trust domain and central NATS as node-1.
    // NATS_PRIVATE_HOST/NATS_AUTH_TOKEN/DO_VPC_UUID are unset until the Stage 1
    // manual VPC migration is complete — provisioning intentionally can't
    // succeed before that (a node with no way to reach NATS isn't useful).
    const natsPrivateHost = process.env.NATS_PRIVATE_HOST;
    const natsAuthToken = process.env.NATS_AUTH_TOKEN;
    if (!natsPrivateHost || !natsAuthToken) {
      return res.status(503).json({ message: 'Central NATS is not yet reachable beyond this droplet (VPC migration not complete) — cannot provision a node that could not reach it.' });
    }

    const result = await provisionNodeOrchestrator({
      region,
      nodeId: node_id,
      jwtSecret: getJwtSecret(),
      natsUrl: `nats://${natsPrivateHost}:4223`,
      natsAuthToken,
      vpcUuid: process.env.DO_VPC_UUID,
    });

    await pool.query(
      `INSERT INTO node_provision_requests (node_id, region, droplet_id, requested_by)
       VALUES ($1, $2, $3, $4)`,
      [result.nodeId, region, result.dropletId, req.user?.id]
    );
    res.status(202).json({ node_id: result.nodeId, droplet_id: result.dropletId, region, status: 'provisioning' });
  } catch (err: any) {
    if (err.message?.includes('DO_API_TOKEN') || err.message?.includes('DO_DNS_SCOPED_TOKEN')) {
      return res.status(503).json({ message: 'Provisioning not configured on this server.' });
    }
    console.error('Provision node error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const listProvisioningRequests = async (req: AdminRequest, res: Response) => {
  try {
    // Reconciled lazily at read time, same pattern as "online" being computed
    // from last_heartbeat_at elsewhere rather than written by a sweep task.
    await pool.query(
      `UPDATE node_provision_requests npr SET status = 'ready', updated_at = NOW()
       WHERE npr.status = 'provisioning'
         AND EXISTS (
           SELECT 1 FROM media_nodes mn
           WHERE mn.node_id = npr.node_id AND mn.last_heartbeat_at > NOW() - INTERVAL '15 seconds'
         )`
    );
    await pool.query(
      `UPDATE node_provision_requests SET status = 'timed_out', updated_at = NOW()
       WHERE status = 'provisioning' AND created_at < NOW() - INTERVAL '10 minutes'`
    );
    const result = await pool.query(
      `SELECT * FROM node_provision_requests ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('List provisioning requests error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

