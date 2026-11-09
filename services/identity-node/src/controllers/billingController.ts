import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { getOrgTierConfig, getOrgTiers } from '../utils/orgTiers.js';
import { quoteCharge, validateContributionAmount } from '../utils/feeMath.js';
import { getPaymentProvider, paymentsEnabled, paymentsStatus } from '../payments/index.js';
import type { PaymentMethod } from '../payments/PaymentProvider.js';
import { getBillingConfig, billingEnforced, orgInBillingScope } from '../config/billingConfig.js';
import { settleOrg, computeServiceState, computeCycleCharge, getEffectiveTierConfig, buildCycleInfo } from '../utils/billingCycle.js';
import { withTransaction } from '../utils/billingCredit.js';

// Pricing (base price + data overage rate) is config-driven per tier — see
// config/billingConfig.ts. Member-hours is NOT a billed/tracked dimension —
// explicit product decision (docs/PRICING_MODEL_2026_05_28.md recommends keeping it; overridden).

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

/**
 * Member-facing contribution status. Exactly one of:
 *   pending   — checkout open, or ACH in flight
 *   succeeded — credited to the pool
 *   failed    — final failure (ACH returned, checkout creation failed)
 *   canceled  — checkout abandoned / expired
 *   refunded  — fully refunded (partial refunds stay 'succeeded'; see reversed_cents)
 *   disputed  — a chargeback is open, or was lost (the stored status stays
 *               succeeded/refunded; dispute_status has the detail)
 */
const MEMBER_STATUS_SQL = (a: string) =>
  `CASE WHEN ${a}.dispute_status IN ('open', 'lost') THEN 'disputed' ELSE ${a}.status END`;

function paymentsInfo(orgId: string) {
  const status = paymentsStatus();
  const cfg = getBillingConfig();
  return {
    enabled: status.enabled && orgInBillingScope(orgId),
    provider: status.provider,
    // Stripe payment method types offered at checkout. The contribute body
    // names them 'card' | 'ach' ('ach' = us_bank_account).
    methods: status.enabled ? ['card', 'us_bank_account'] : [],
    // 'test' lets clients show a TEST MODE badge; the disabled reason stays server-side
    mode: status.mode,
    currency: cfg.currency,
    card_fee: {
      mode: cfg.cardFeeMode,
      percent: cfg.cardFeePercent,
      fixed_cents: cfg.cardFeeFixedCents,
    },
    min_amount_cents: cfg.minContributionCents,
    max_amount_cents: cfg.maxContributionCents,
    card_min_amount_cents: cfg.cardMinContributionCents,
  };
}

function plansInfo() {
  return getOrgTiers()
    .filter(t => t.selectable)
    .map(t => ({
      id: t.id,
      name: t.name,
      price_cents: t.priceCents,
      data_bytes: t.cycleDataLimitBytes,
      overage_cents_per_gb: t.overageCentsPerGb,
      max_resolution: t.maxResolutionLabel,
    }));
}

const PAYMENT_METHODS: PaymentMethod[] = ['ach', 'card'];

function portalUrls(orgId: string, contributionId: string) {
  const portalUrl = process.env.BILLING_PORTAL_URL || 'http://localhost:1420';
  return {
    successUrl: `${portalUrl}/billing/return?org=${orgId}&contribution=${contributionId}&result=success`,
    cancelUrl:  `${portalUrl}/billing/return?org=${orgId}&contribution=${contributionId}&result=cancel`,
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

    // Close any elapsed cycles: one billing_cycle_charges row each, debited
    // only under BILLING_ENFORCE. Idempotent — the hourly job (billingCycle.ts)
    // normally gets there first. This replaces the old lazy rollover, which
    // zeroed usage without ever charging and lumped skipped months together.
    try {
      await settleOrg(orgId);
    } catch (err) {
      // Never let a settlement problem take the usage bars down with it.
      console.error('[billing] lazy settlement failed for org', orgId, err);
    }

    const orgRes = await pool.query(`SELECT tier FROM organizations WHERE id = $1`, [orgId]);
    const tier = Number(orgRes.rows[0]?.tier ?? 0);
    const tierConfig = getOrgTierConfig(tier);

    const billingRes = await pool.query(
      `SELECT balance_cents, cycle_bytes_out, cycle_start_at, grace_started_at
       FROM org_billing WHERE org_id = $1`,
      [orgId]
    );
    const row = billingRes.rows[0];

    const bytesOut       = Number(row.cycle_bytes_out);
    // Explicit cycle: dates, the price locked for it, next charge (utils/billingCycle.ts).
    const cycleInfo      = await buildCycleInfo(orgId, { includeCoverage: viewer.canViewBilling });
    const estimatedCents = cycleInfo?.nextChargeCents ?? computeCycleCharge(tierConfig, bytesOut).totalCents;
    const balanceCents   = Number(row.balance_cents);
    const service = computeServiceState({
      balanceCents,
      graceStartedAt: row.grace_started_at ? new Date(row.grace_started_at) : null,
      tierPriceCents: tierConfig.priceCents,
      now: new Date(),
    });
    const effectiveTier = await getEffectiveTierConfig(orgId, tier);

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
        // Additive: start, end, daysRemaining, tierId, tierName, priceCents,
        // nextCycle, nextChargeAt, nextChargeCents, enforced, state,
        // graceEndsAt (+ coversCycles for billing viewers).
        ...(cycleInfo ?? {}),
        bytesOut,
      },
      viewer: {
        can_view_billing: viewer.canViewBilling,
        is_contributor:   viewer.isContributor,
      },
      payments: paymentsInfo(orgId),
      plans: plansInfo(),
      enforcement_active: billingEnforced(orgId),
      // Visible to every member: members are the ones who can top the pool
      // up, so they need to know service is about to degrade. The balance
      // itself stays authority-only below.
      service: {
        state:               service.state,
        grace_ends_at:       service.graceEndsAt,
        grace_days:          getBillingConfig().graceDays,
        effective_tier:      effectiveTier.id,
        effective_tier_name: effectiveTier.name,
      },
    };

    if (viewer.canViewBilling) {
      const [contributorsRes, ledgerRes, cyclesRes] = await Promise.all([
        pool.query(
          `SELECT u.callsign, SUM(bc.amount_cents - bc.reversed_cents - bc.dispute_held_cents) AS total_cents
           FROM billing_contributions bc
           JOIN users u ON bc.user_id = u.id
           WHERE bc.org_id = $1 AND bc.status = 'succeeded'
           GROUP BY u.callsign
           ORDER BY total_cents DESC
           LIMIT 10`,
          [orgId]
        ),
        pool.query(
          `SELECT delta_cents, description, kind, balance_after_cents, created_at
           FROM billing_ledger
           WHERE org_id = $1
           ORDER BY created_at DESC
           LIMIT 10`,
          [orgId]
        ),
        pool.query(
          `SELECT cycle_start, cycle_end, tier, bytes_out, base_cents, overage_cents, total_cents, applied
           FROM billing_cycle_charges
           WHERE org_id = $1
           ORDER BY cycle_start DESC
           LIMIT 6`,
          [orgId]
        ),
      ]);
      body.balance_cents = balanceCents;
      body.contributors  = contributorsRes.rows;
      body.ledger        = ledgerRes.rows;
      body.cycle_charges = cyclesRes.rows;
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
                ${MEMBER_STATUS_SQL('bc')} AS status, bc.reversed_cents, bc.dispute_status, bc.created_at
         FROM billing_contributions bc
         LEFT JOIN users u ON bc.user_id = u.id
         WHERE bc.org_id = $1 AND bc.status IN ('succeeded', 'pending', 'refunded')
         ORDER BY bc.created_at DESC
         LIMIT $2 OFFSET $3`,
        [orgId, limit, offset]
      ),
      pool.query(
        `SELECT delta_cents, description, kind, balance_after_cents, created_at
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /orgs/:id/billing/contribute
 * Body: { amount_cents: number, method: 'ach' | 'card' }
 *
 * Creates a pending contribution and starts a checkout with the configured
 * payment provider. The org pool is credited only when the payment succeeds
 * (immediately for the dev provider; via webhook for Stripe). ACH carries no
 * fee; card fees are absorbed or grossed up per billing config (cardFeeMode).
 */
export const contributeToOrg = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const userId = req.user?.id;
  const { amount_cents, method } = req.body ?? {};

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  if (!paymentsEnabled() || !orgInBillingScope(orgId)) {
    return res.status(503).json({ message: 'Payments are not enabled on this server' });
  }
  if (!PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ message: "method must be 'ach' or 'card'" });
  }
  const amountError = validateContributionAmount(amount_cents, method);
  if (amountError) return res.status(400).json({ message: amountError });

  try {
    const viewer = await getBillingViewer(orgId, userId);
    if (!viewer.isMember) return res.status(403).json({ message: 'Forbidden' });

    const orgRes = await pool.query(`SELECT callsign FROM organizations WHERE id = $1`, [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    const orgName = orgRes.rows[0].callsign;

    // Card-testing / spam guard: each checkout is a provider object (and, for
    // ACH, a possible bank-verification fee), so cap open ones per member.
    const cfg = getBillingConfig();
    const recent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM billing_contributions
       WHERE user_id = $1 AND org_id = $2 AND status = 'pending' AND source = 'self_serve'
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [userId, orgId]
    );
    if (recent.rows[0].n >= cfg.maxPendingPerUserPerHour) {
      return res.status(429).json({ message: 'Too many unfinished payments — complete or wait for the open checkout first' });
    }

    const provider = await getPaymentProvider();
    const { chargeCents, feeCents } = quoteCharge(amount_cents, method);

    const insertRes = await pool.query(
      `INSERT INTO billing_contributions
         (org_id, user_id, amount_cents, fee_cents, charge_cents, payment_method, provider, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id`,
      [orgId, userId, amount_cents, feeCents, chargeCents, provider.name === 'dev' ? 'dev' : method, provider.name]
    );
    const contributionId = insertRes.rows[0].id;

    let checkout;
    try {
      checkout = await provider.createCheckout({
        contributionId, orgId, orgName, userId,
        netCents: amount_cents, feeCents, chargeCents, method,
        ...portalUrls(orgId, contributionId),
      });
    } catch (err) {
      // Don't leave an orphan 'pending' row that can never complete.
      await pool.query(
        `UPDATE billing_contributions SET status = 'failed', last_error = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [contributionId, `checkout creation failed: ${String((err as Error)?.message ?? err).slice(0, 300)}`]
      );
      throw err;
    }

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
  if (!UUID_RE.test(cid)) return res.status(404).json({ message: 'Contribution not found' });

  try {
    const result = await pool.query(
      `SELECT c.id, c.amount_cents, c.fee_cents, c.charge_cents, c.payment_method, ${MEMBER_STATUS_SQL('c')} AS status,
              c.reversed_cents, c.dispute_status, c.last_error, c.created_at, c.credited_at
       FROM billing_contributions c
       WHERE c.id = $1 AND c.org_id = $2 AND c.user_id = $3`,
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
      `SELECT c.id, c.amount_cents, c.invoice_reason, c.external_invoice_ref, ${MEMBER_STATUS_SQL('c')} AS status,
              c.created_at, c.credited_at
       FROM billing_contributions c
       WHERE c.org_id = $1 AND c.source = 'admin_invoice'
       ORDER BY c.created_at DESC`,
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
 * Pays a specific admin-issued pending invoice through the same checkout /
 * webhook / credit machinery as contributeToOrg.
 *
 * Calling it again (an abandoned checkout tab) is supported, but the previous
 * checkout is closed first: two open sessions for one invoice meant the
 * invoice could be paid twice, and the second payment was silently swallowed
 * (no credit, no refund). If the previous checkout was already completed —
 * payment in flight, e.g. ACH — this answers 409 instead of opening another.
 * The row lock serialises concurrent clicks.
 */
export const payOrgInvoice = async (req: AuthRequest, res: Response) => {
  const orgId  = req.params.id as string;
  const cid    = req.params.cid as string;
  const userId = req.user?.id;
  const { method } = req.body ?? {};

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!paymentsEnabled() || !orgInBillingScope(orgId)) {
    return res.status(503).json({ message: 'Payments are not enabled on this server' });
  }
  if (!PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ message: "method must be 'ach' or 'card'" });
  }
  if (!UUID_RE.test(cid)) return res.status(404).json({ message: 'Invoice not found or already paid' });

  try {
    const viewer = await getBillingViewer(orgId, userId);
    if (!viewer.isMember) return res.status(403).json({ message: 'Forbidden' });

    const orgRes = await pool.query(`SELECT callsign FROM organizations WHERE id = $1`, [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    const orgName = orgRes.rows[0].callsign;
    const provider = await getPaymentProvider();

    // Close the previous checkout under the row lock, so two concurrent clicks
    // can't both see it open. The new checkout is created after commit: the
    // dev provider credits synchronously and must be able to lock the row.
    const pre = await withTransaction(async (client) => {
      const invRes = await client.query(
        `SELECT amount_cents, provider_session_id, provider FROM billing_contributions
         WHERE id = $1 AND org_id = $2 AND source = 'admin_invoice' AND status = 'pending'
         FOR UPDATE`,
        [cid, orgId]
      );
      if (invRes.rows.length === 0) return { status: 404 as const };
      const inv = invRes.rows[0];
      if (inv.provider_session_id && inv.provider === provider.name) {
        const prev = await provider.expireCheckout(inv.provider_session_id);
        if (prev === 'completed') return { status: 409 as const };
        await client.query(
          `UPDATE billing_contributions SET provider_session_id = NULL, updated_at = NOW() WHERE id = $1`,
          [cid]
        );
      }
      return { status: 200 as const, netCents: Number(inv.amount_cents) };
    });

    if (pre.status === 404) return res.status(404).json({ message: 'Invoice not found or already paid' });
    if (pre.status === 409) {
      return res.status(409).json({ message: 'A payment for this invoice is already in progress — it will show as paid once it clears' });
    }

    const netCents = pre.netCents;
    const { chargeCents, feeCents } = quoteCharge(netCents, method);
    const checkout = await provider.createCheckout({
      contributionId: cid, orgId, orgName, userId,
      netCents, feeCents, chargeCents, method,
      attempt: Date.now(),
      ...portalUrls(orgId, cid),
    });
    // A residual race (two clicks landing between that commit and here) can
    // still open two sessions; a second payment is then detected as a
    // duplicate and auto-refunded (utils/billingEvents.ts).
    await pool.query(
      `UPDATE billing_contributions
       SET user_id = $2, payment_method = $3, provider = $4, fee_cents = $5, charge_cents = $6,
           provider_session_id = COALESCE($7, provider_session_id), updated_at = NOW()
       WHERE id = $1`,
      [cid, userId, provider.name === 'dev' ? 'dev' : method, provider.name, feeCents, chargeCents, checkout.providerSessionId ?? null]
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
              bc.amount_cents, bc.fee_cents, bc.payment_method, ${MEMBER_STATUS_SQL('bc')} AS status, bc.created_at
       FROM billing_contributions bc
       LEFT JOIN organizations o ON bc.org_id = o.id
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
