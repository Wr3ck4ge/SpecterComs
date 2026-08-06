import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { getOrgTierConfig } from '../utils/orgTiers.js';
import { cardGrossUp, CARD_FEE_PERCENT, CARD_FEE_FIXED_CENTS, MIN_CONTRIBUTION_CENTS } from '../utils/feeMath.js';
import { getPaymentProvider, paymentsEnabled } from '../payments/index.js';

// Pricing (base price + data overage rate) now lives per-tier in utils/orgTiers.ts,
// matching docs/PRICING_MODEL_2026_05_28.md. Member-hours is NOT a billed/tracked
// dimension — explicit product decision (that doc recommends keeping it; overridden).

function addMonths(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setMonth(copy.getMonth() + n);
  return copy;
}

interface BillingViewer {
  isMember: boolean;
  canViewBilling: boolean;
  isContributor: boolean;
}

async function getBillingViewer(orgId: string, userId: string): Promise<BillingViewer> {
  const [memberRes, ownerRes, contribRes] = await Promise.all([
    pool.query(
      `SELECT r.permissions
       FROM org_members om
       LEFT JOIN org_roles r ON om.role_id = r.id
       WHERE om.org_id = $1 AND om.user_id = $2`,
      [orgId, userId]
    ),
    pool.query(`SELECT 1 FROM organizations WHERE id = $1 AND owner_id = $2`, [orgId, userId]),
    pool.query(
      `SELECT 1 FROM billing_contributions
       WHERE org_id = $1 AND user_id = $2 AND status = 'succeeded' LIMIT 1`,
      [orgId, userId]
    ),
  ]);

  const isOwner = ownerRes.rows.length > 0;
  return {
    isMember: memberRes.rows.length > 0 || isOwner,
    canViewBilling: isOwner || memberRes.rows.some((r: any) => r.permissions?.can_view_billing === true),
    isContributor: contribRes.rows.length > 0,
  };
}

function paymentsInfo() {
  return {
    enabled: paymentsEnabled(),
    provider: process.env.PAYMENTS_PROVIDER === 'stripe' ? 'stripe' : 'dev',
    card_fee: { percent: CARD_FEE_PERCENT, fixed_cents: CARD_FEE_FIXED_CENTS },
    min_amount_cents: MIN_CONTRIBUTION_CENTS,
  };
}

/**
 * GET /orgs/:id/billing
 * Any member: tier, limits, cycle usage (drives WarRoom consumption bars),
 * viewer flags, and payments config. Balance, contributors, and recent ledger
 * are included only for viewers with the can_view_billing permission.
 */
export const getBillingStatus = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const viewer = await getBillingViewer(orgId, userId);
    if (!viewer.isMember) return res.status(403).json({ message: 'Forbidden' });

    // Ensure a billing row exists (orgs created before this migration won't have one)
    await pool.query(
      `INSERT INTO org_billing (org_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [orgId]
    );

    const orgRes = await pool.query(`SELECT tier FROM organizations WHERE id = $1`, [orgId]);
    const tier = Number(orgRes.rows[0]?.tier ?? 0);
    const tierConfig = getOrgTierConfig(tier);

    const billingRes = await pool.query(
      `SELECT balance_cents, cycle_bytes_out, cycle_start_at
       FROM org_billing WHERE org_id = $1`,
      [orgId]
    );
    let row = billingRes.rows[0];

    // Usage cycles are rolling monthly anniversaries from cycle_start_at, but
    // nothing ever advanced cycle_start_at or zeroed cycle_bytes_out on
    // rollover — billingConsumer.ts only ever increments it — so usage just
    // accumulated across every month boundary indefinitely. Lazily catch up
    // on read here (same on-demand pattern as the row-creation INSERT above)
    // rather than requiring a cron job. The cycle_start_at = $3 guard makes
    // this a no-op if another concurrent request already advanced it.
    let cycleStart = new Date(row.cycle_start_at);
    const now = new Date();
    if (now >= addMonths(cycleStart, 1)) {
      const originalCycleStart = row.cycle_start_at;
      while (now >= addMonths(cycleStart, 1)) cycleStart = addMonths(cycleStart, 1);
      const resetRes = await pool.query(
        `UPDATE org_billing SET cycle_bytes_out = 0, cycle_start_at = $2, updated_at = NOW()
         WHERE org_id = $1 AND cycle_start_at = $3
         RETURNING cycle_bytes_out, cycle_start_at`,
        [orgId, cycleStart, originalCycleStart]
      );
      if (resetRes.rows.length > 0) {
        row = { ...row, cycle_bytes_out: resetRes.rows[0].cycle_bytes_out, cycle_start_at: resetRes.rows[0].cycle_start_at };
      }
    }

    const bytesOut     = Number(row.cycle_bytes_out);
    const gbOut        = bytesOut / 1_000_000_000;
    const includedGb   = tierConfig.cycleDataLimitBytes / 1_000_000_000;
    const overageGb    = Math.max(0, gbOut - includedGb);
    const estimatedCents = tierConfig.overageCentsPerGb == null
      ? tierConfig.priceCents                                                    // Free Trial: throttle at cap, no overage charge
      : Math.round(tierConfig.priceCents + overageGb * tierConfig.overageCentsPerGb);

    const body: Record<string, unknown> = {
      tier,
      tier_name: tierConfig.name,
      tier_price_cents: tierConfig.priceCents,
      tier_limits: {
        data_bytes: tierConfig.cycleDataLimitBytes,
      },
      cycle: {
        start_at:             row.cycle_start_at,
        bytes_out:            bytesOut,
        estimated_cost_cents: estimatedCents,
      },
      viewer: {
        can_view_billing: viewer.canViewBilling,
        is_contributor:   viewer.isContributor,
      },
      payments: paymentsInfo(),
      enforcement_active: process.env.BILLING_ENFORCE === 'true',
    };

    if (viewer.canViewBilling) {
      const [contributorsRes, ledgerRes] = await Promise.all([
        pool.query(
          `SELECT u.callsign, SUM(bc.amount_cents) AS total_cents
           FROM billing_contributions bc
           JOIN users u ON bc.user_id = u.id
           WHERE bc.org_id = $1 AND bc.status = 'succeeded'
           GROUP BY u.callsign
           ORDER BY total_cents DESC
           LIMIT 10`,
          [orgId]
        ),
        pool.query(
          `SELECT delta_cents, description, created_at
           FROM billing_ledger
           WHERE org_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [orgId]
        ),
      ]);
      body.balance_cents = row.balance_cents;
      body.contributors  = contributorsRes.rows;
      body.ledger        = ledgerRes.rows;
    }

    res.json(body);
  } catch (err) {
    console.error('[billing] getBillingStatus error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /orgs/:id/billing/transactions?limit=&offset=
 * Full org funding history + ledger. Visible to contributors (>=1 succeeded
 * contribution) and viewers with can_view_billing.
 */
export const getOrgTransactions = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const viewer = await getBillingViewer(orgId, userId);
    if (!viewer.isMember) return res.status(403).json({ message: 'Forbidden' });
    if (!viewer.canViewBilling && !viewer.isContributor) {
      return res.status(403).json({ message: 'Forbidden: billing history is visible to contributors and billing managers' });
    }

    const [contribRes, ledgerRes] = await Promise.all([
      pool.query(
        `SELECT bc.id, u.callsign, bc.amount_cents, bc.fee_cents, bc.payment_method,
                bc.status, bc.created_at
         FROM billing_contributions bc
         JOIN users u ON bc.user_id = u.id
         WHERE bc.org_id = $1 AND bc.status IN ('succeeded', 'pending')
         ORDER BY bc.created_at DESC
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset]
      ),
      pool.query(
        `SELECT delta_cents, description, created_at
         FROM billing_ledger
         WHERE org_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset]
      ),
    ]);

    res.json({ contributions: contribRes.rows, ledger: ledgerRes.rows, limit, offset });
  } catch (err) {
    console.error('[billing] getOrgTransactions error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /orgs/:id/billing/contribute
 * Body: { amount_cents: number, method: 'ach' | 'card' }
 *
 * Creates a pending contribution and starts a checkout with the configured
 * payment provider. The org pool is credited only when the payment succeeds
 * (immediately for the dev provider; via webhook for Stripe). ACH carries no
 * fee; card charges are grossed up so the pool nets exactly amount_cents.
 */
export const contributeToOrg = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const userId = req.user?.id;
  const { amount_cents, method } = req.body;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  if (!paymentsEnabled()) {
    return res.status(503).json({ message: 'Payments are not enabled on this server' });
  }
  if (!amount_cents || typeof amount_cents !== 'number' || !Number.isInteger(amount_cents) || amount_cents < MIN_CONTRIBUTION_CENTS) {
    return res.status(400).json({ message: `amount_cents must be a whole number >= ${MIN_CONTRIBUTION_CENTS} (minimum $1.00)` });
  }
  if (method !== 'ach' && method !== 'card') {
    return res.status(400).json({ message: "method must be 'ach' or 'card'" });
  }

  try {
    const viewer = await getBillingViewer(orgId, userId);
    if (!viewer.isMember) return res.status(403).json({ message: 'Forbidden' });

    const orgRes = await pool.query(`SELECT callsign FROM organizations WHERE id = $1`, [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    const orgName = orgRes.rows[0].callsign;

    const provider = await getPaymentProvider();
    const { chargeCents, feeCents } = method === 'card'
      ? cardGrossUp(amount_cents)
      : { chargeCents: amount_cents, feeCents: 0 };

    const insertRes = await pool.query(
      `INSERT INTO billing_contributions (org_id, user_id, amount_cents, fee_cents, payment_method, provider, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')
       RETURNING id`,
      [orgId, userId, amount_cents, feeCents, provider.name === 'dev' ? 'dev' : method, provider.name]
    );
    const contributionId = insertRes.rows[0].id;

    const portalUrl = process.env.BILLING_PORTAL_URL || 'http://localhost:1420';
    const checkout = await provider.createCheckout({
      contributionId,
      orgId,
      orgName,
      userId,
      netCents: amount_cents,
      feeCents,
      chargeCents,
      method,
      successUrl: `${portalUrl}/billing/return?org=${orgId}&contribution=${contributionId}&result=success`,
      cancelUrl:  `${portalUrl}/billing/return?org=${orgId}&contribution=${contributionId}&result=cancel`,
    });

    if (checkout.providerSessionId) {
      await pool.query(
        `UPDATE billing_contributions SET provider_session_id = $2 WHERE id = $1`,
        [contributionId, checkout.providerSessionId]
      );
    }

    res.status(201).json({
      contribution_id: contributionId,
      status:          checkout.immediate ? 'succeeded' : 'pending',
      redirect_url:    checkout.redirectUrl ?? null,
      net_cents:       amount_cents,
      fee_cents:       feeCents,
      charge_cents:    chargeCents,
    });
  } catch (err) {
    console.error('[billing] contributeToOrg error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /orgs/:id/billing/contributions/:cid
 * Status polling for the contribution owner (used after Stripe redirect).
 */
export const getContributionStatus = async (req: AuthRequest, res: Response) => {
  const { id: orgId, cid } = req.params as { id: string; cid: string };
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const result = await pool.query(
      `SELECT id, amount_cents, fee_cents, payment_method, status, created_at, credited_at
       FROM billing_contributions
       WHERE id = $1 AND org_id = $2 AND user_id = $3`,
      [cid, orgId, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Contribution not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[billing] getContributionStatus error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /orgs/:id/billing/usage-daily?months=N
 * Any member: current month's daily bytes_out rows in full, plus monthly
 * totals for the trailing N months (default 6, max 12) for history browsing.
 */
export const getUsageDaily = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 12);

  try {
    const viewer = await getBillingViewer(orgId, userId);
    if (!viewer.isMember) return res.status(403).json({ message: 'Forbidden' });

    const [dailyRes, monthlyRes] = await Promise.all([
      pool.query(
        `SELECT day, bytes_out FROM org_usage_daily
         WHERE org_id = $1 AND day >= date_trunc('month', CURRENT_DATE)
         ORDER BY day ASC`,
        [orgId]
      ),
      pool.query(
        `SELECT date_trunc('month', day) AS month, SUM(bytes_out) AS bytes_out
         FROM org_usage_daily
         WHERE org_id = $1 AND day >= date_trunc('month', CURRENT_DATE) - ($2 || ' months')::interval
         GROUP BY 1 ORDER BY 1 DESC`,
        [orgId, months]
      ),
    ]);

    res.json({
      current_month_daily: dailyRes.rows,
      monthly_totals: monthlyRes.rows,
    });
  } catch (err) {
    console.error('[billing] getUsageDaily error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /orgs/:id/billing/info
 * Owner-only, same gate as updateOrgSettings (orgController.ts) — billing contact
 * info (address/tax ID) is at least as sensitive as the org profile fields already
 * gated that way. Row may not exist yet (PUT upserts); return nulls if so rather
 * than 404, so the client can render an empty form either way.
 */
export const getBillingInfo = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const orgRes = await pool.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    if (orgRes.rows[0].owner_id !== userId) return res.status(403).json({ message: 'Only the owner can view billing info' });

    const result = await pool.query(`SELECT * FROM org_billing_info WHERE org_id = $1`, [orgId]);
    res.json(result.rows[0] ?? { org_id: orgId });
  } catch (err) {
    console.error('[billing] getBillingInfo error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * PUT /orgs/:id/billing/info
 * Owner-only. Upserts the org's billing contact/tax info.
 */
export const updateBillingInfo = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const {
    contact_name, company_name, billing_email, phone,
    address_line1, address_line2, city, state, zip,
    tax_id, is_tax_exempt, tax_exemption_number,
  } = req.body;

  try {
    const orgRes = await pool.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    if (orgRes.rows[0].owner_id !== userId) return res.status(403).json({ message: 'Only the owner can update billing info' });

    await pool.query(
      `INSERT INTO org_billing_info
         (org_id, contact_name, company_name, billing_email, phone,
          address_line1, address_line2, city, state, zip,
          tax_id, is_tax_exempt, tax_exemption_number, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), $14)
       ON CONFLICT (org_id) DO UPDATE SET
         contact_name         = EXCLUDED.contact_name,
         company_name         = EXCLUDED.company_name,
         billing_email        = EXCLUDED.billing_email,
         phone                = EXCLUDED.phone,
         address_line1        = EXCLUDED.address_line1,
         address_line2        = EXCLUDED.address_line2,
         city                 = EXCLUDED.city,
         state                = EXCLUDED.state,
         zip                  = EXCLUDED.zip,
         tax_id               = EXCLUDED.tax_id,
         is_tax_exempt        = EXCLUDED.is_tax_exempt,
         tax_exemption_number = EXCLUDED.tax_exemption_number,
         updated_at           = NOW(),
         updated_by           = EXCLUDED.updated_by`,
      [
        orgId, contact_name ?? '', company_name ?? null, billing_email ?? '', phone ?? '',
        address_line1 ?? '', address_line2 ?? '', city ?? '', state ?? '', zip ?? '',
        tax_id ?? '', is_tax_exempt ?? false, tax_exemption_number ?? '', userId,
      ]
    );
    res.json({ message: 'Billing info updated.' });
  } catch (err) {
    console.error('[billing] updateBillingInfo error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /orgs/:id/billing/invoices
 * Any member — same tier as contributeToOrg, not owner/can_view_billing-only.
 * Admin-issued invoices only (source='admin_invoice'); today's arbitrary
 * self-serve contributions stay on getOrgTransactions, a semantically different
 * list ("who funded" vs. "what's owed").
 */
export const listOrgInvoices = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const viewer = await getBillingViewer(orgId, userId);
    if (!viewer.isMember) return res.status(403).json({ message: 'Forbidden' });

    const result = await pool.query(
      `SELECT id, amount_cents, invoice_reason, external_invoice_ref, status, created_at, credited_at
       FROM billing_contributions
       WHERE org_id = $1 AND source = 'admin_invoice'
       ORDER BY created_at DESC`,
      [orgId]
    );
    res.json({ invoices: result.rows });
  } catch (err) {
    console.error('[billing] listOrgInvoices error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * POST /orgs/:id/billing/invoices/:cid/pay
 * Body: { method: 'ach' | 'card' }
 *
 * Pays a specific admin-issued pending invoice, reusing the exact same
 * provider.createCheckout call contributeToOrg makes — no stripeProvider.ts
 * changes needed. Safe to call more than once for the same invoice (e.g. an
 * abandoned earlier checkout tab): each call just overwrites provider_session_id
 * with a fresh session; the webhook matches by metadata.contribution_id, not
 * session id, so a stale session sitting in the row is harmless.
 */
export const payOrgInvoice = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const cid    = req.params.cid as string;
  const userId = req.user?.id;
  const { method } = req.body;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!paymentsEnabled()) {
    return res.status(503).json({ message: 'Payments are not enabled on this server' });
  }
  if (method !== 'ach' && method !== 'card') {
    return res.status(400).json({ message: "method must be 'ach' or 'card'" });
  }

  try {
    const viewer = await getBillingViewer(orgId, userId);
    if (!viewer.isMember) return res.status(403).json({ message: 'Forbidden' });

    const invRes = await pool.query(
      `SELECT amount_cents FROM billing_contributions
       WHERE id = $1 AND org_id = $2 AND source = 'admin_invoice' AND status = 'pending'`,
      [cid, orgId]
    );
    if (invRes.rows.length === 0) return res.status(404).json({ message: 'Invoice not found or already paid' });
    const netCents = invRes.rows[0].amount_cents;

    const orgRes = await pool.query(`SELECT callsign FROM organizations WHERE id = $1`, [orgId]);
    const orgName = orgRes.rows[0].callsign;

    const provider = await getPaymentProvider();
    const { chargeCents, feeCents } = method === 'card'
      ? cardGrossUp(netCents)
      : { chargeCents: netCents, feeCents: 0 };

    const portalUrl = process.env.BILLING_PORTAL_URL || 'http://localhost:1420';
    const checkout = await provider.createCheckout({
      contributionId: cid,
      orgId,
      orgName,
      userId,
      netCents,
      feeCents,
      chargeCents,
      method,
      successUrl: `${portalUrl}/billing/return?org=${orgId}&contribution=${cid}&result=success`,
      cancelUrl:  `${portalUrl}/billing/return?org=${orgId}&contribution=${cid}&result=cancel`,
    });

    await pool.query(
      `UPDATE billing_contributions
       SET user_id = $2, payment_method = $3, provider = $4, fee_cents = $5,
           provider_session_id = $6
       WHERE id = $1`,
      [cid, userId, provider.name === 'dev' ? 'dev' : method, provider.name, feeCents, checkout.providerSessionId ?? null]
    );

    res.json({
      contribution_id: cid,
      status:          checkout.immediate ? 'succeeded' : 'pending',
      redirect_url:    checkout.redirectUrl ?? null,
      net_cents:       netCents,
      fee_cents:       feeCents,
      charge_cents:    chargeCents,
    });
  } catch (err) {
    console.error('[billing] payOrgInvoice error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /users/me/transactions?limit=&offset=
 * The caller's personal transaction history across all orgs.
 */
export const getMyTransactions = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const limit  = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const result = await pool.query(
      `SELECT 'org_funding' AS type, bc.id, bc.org_id, o.callsign AS org_name,
              bc.amount_cents, bc.fee_cents, bc.payment_method, bc.status, bc.created_at
       FROM billing_contributions bc
       JOIN organizations o ON bc.org_id = o.id
       WHERE bc.user_id = $1
       ORDER BY bc.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    res.json({ transactions: result.rows, limit, offset });
  } catch (err) {
    console.error('[billing] getMyTransactions error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
