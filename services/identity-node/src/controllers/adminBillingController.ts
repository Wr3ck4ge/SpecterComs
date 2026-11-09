import { Response } from 'express';
import { pool } from '../config/db.js';
import { getProviderByName, paymentsStatus } from '../payments/index.js';
import { reconcileBilling } from '../utils/billingReconcile.js';
import { applyPoolDelta, withTransaction } from '../utils/billingCredit.js';
import * as billingCycle from '../utils/billingCycle.js';
import { computeServiceState, settleDueOrgs, getEffectiveTierConfig } from '../utils/billingCycle.js';
import { getOrgTierConfig } from '../utils/orgTiers.js';
import { getBillingConfig, billingEnforced, orgInBillingScope, betaOrgs } from '../config/billingConfig.js';
import { AdminRequest, writeAudit } from './adminController.js';
import { isUuid, cleanReason, parseListParams, maskEmail, safeErr, escapeLike } from '../utils/adminPolicy.js';

// Platform-admin billing operations, mounted under /admin/billing by
// routes/admin.ts (after authenticateTokenStrict + requireAdminSession +
// adminRateLimit). Per-route roles live in routes/adminBilling.ts.
//
// Every money-moving handler here (refund, adjust, settle, reconcile repair,
// exception resolve) writes an admin_audit_log row with the actor, target,
// amount, reason and the client's request_id.

const MAX_RECONCILE_DAYS = 93;
/** Largest single refund / adjustment the panel will issue ($10,000). */
export const MAX_MONEY_CENTS = 1_000_000;
/** Client-generated idempotency key (the panel sends a UUID). */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const STUCK_WEBHOOK_SQL = `processed_at IS NULL AND received_at < NOW() - INTERVAL '10 minutes'`;

const isRequestId = (v: unknown): v is string => typeof v === 'string' && REQUEST_ID_RE.test(v);

function fail(res: Response, label: string, err: unknown, status = 500, message = 'Internal server error') {
  console.error(`[admin-billing] ${label} error:`, safeErr(err));
  return res.status(status).json({ message });
}

/**
 * Same-process guard against a double-click racing itself: the second request
 * with a request_id that is still being processed gets 409 instead of a
 * second provider call. Cross-request idempotency is the audit/ledger check.
 */
const inFlight = new Set<string>();
async function exclusive<T>(key: string, res: Response, fn: () => Promise<T>): Promise<T | undefined> {
  if (inFlight.has(key)) {
    res.status(409).json({ message: 'This request is already being processed.', code: 'REQUEST_IN_FLIGHT' });
    return undefined;
  }
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}

function stateFor(row: { tier: number; balance_cents: unknown; grace_started_at: unknown }, now = new Date()) {
  const tier = getOrgTierConfig(Number(row.tier ?? 0));
  const s = computeServiceState({
    balanceCents: Number(row.balance_cents ?? 0),
    graceStartedAt: row.grace_started_at ? new Date(row.grace_started_at as string) : null,
    tierPriceCents: tier.priceCents,
    now,
  });
  return { tier, state: s.state, grace_ends_at: s.graceEndsAt };
}

// ─── Read: overview ──────────────────────────────────────────────────────────

/**
 * GET /admin/billing/overview
 * One-screen health: payments mode, money in, orgs at risk, open exceptions,
 * stuck webhooks.
 */
export const getBillingOverview = async (_req: AdminRequest, res: Response) => {
  try {
    const [totals, orgs, exceptions, webhooks, pendingOld] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('succeeded','refunded')), 0)::bigint AS credited_cents,
           COALESCE(SUM(reversed_cents), 0)::bigint                                              AS reversed_cents,
           COALESCE(SUM(dispute_held_cents) FILTER (WHERE dispute_status = 'lost'), 0)::bigint   AS chargeback_cents,
           COUNT(*) FILTER (WHERE dispute_status = 'open')::int                                  AS open_disputes
         FROM billing_contributions`
      ),
      // Bounded: the most negative / grace orgs first. The full list is
      // GET /admin/billing/orgs (paginated).
      pool.query(
        `SELECT ob.org_id, o.callsign, o.tier, ob.balance_cents, ob.grace_started_at
         FROM org_billing ob JOIN organizations o ON o.id = ob.org_id
         WHERE ob.balance_cents < 0 OR ob.grace_started_at IS NOT NULL OR o.tier > 0
         ORDER BY ob.balance_cents ASC, ob.org_id
         LIMIT 500`
      ),
      pool.query(`SELECT kind, COUNT(*)::int AS n FROM billing_payment_exceptions WHERE resolved_at IS NULL GROUP BY kind`),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE ${STUCK_WEBHOOK_SQL})::int AS stuck,
                COUNT(*) FILTER (WHERE last_error IS NOT NULL AND received_at > NOW() - INTERVAL '24 hours')::int AS failed_24h,
                MAX(received_at) AS last_received_at
         FROM billing_webhook_events`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM billing_contributions
         WHERE status = 'pending' AND source = 'self_serve' AND created_at < NOW() - INTERVAL '10 days'`
      ),
    ]);

    const now = new Date();
    const atRisk = orgs.rows
      .map((r: any) => {
        const s = stateFor(r, now);
        return { org_id: r.org_id, callsign: r.callsign, tier: s.tier.name, balance_cents: Number(r.balance_cents),
                 state: s.state, grace_ends_at: s.grace_ends_at };
      })
      .filter((o: any) => o.state !== 'active');

    const status = paymentsStatus();
    const beta = betaOrgs();
    const w = webhooks.rows[0];
    res.json({
      payments: { enabled: status.enabled, provider: status.provider, mode: status.mode, reason: status.reason ?? null },
      enforcement_active: billingEnforced(),
      beta_org_count: beta ? beta.size : null,
      config: getBillingConfig(),
      totals: {
        credited_cents:   Number(totals.rows[0].credited_cents),
        reversed_cents:   Number(totals.rows[0].reversed_cents),
        chargeback_cents: Number(totals.rows[0].chargeback_cents),
        open_disputes:    totals.rows[0].open_disputes,
      },
      orgs_at_risk: atRisk,
      orgs_at_risk_truncated: orgs.rows.length >= 500,
      open_exceptions: Object.fromEntries(exceptions.rows.map((r: any) => [r.kind, r.n])),
      stuck_webhooks: w.stuck,
      failed_webhooks_24h: w.failed_24h,
      last_webhook_at: w.last_received_at ?? null,
      stale_pending_contributions: pendingOld.rows[0].n,
    });
  } catch (err) {
    return fail(res, 'overview', err);
  }
};

// ─── Read: orgs ──────────────────────────────────────────────────────────────

const BILLING_ORG_SORTS = {
  balance:    'COALESCE(ob.balance_cents, 0)',
  callsign:   'lower(o.callsign)',
  created_at: 'o.created_at',
  tier:       'o.tier',
};

/** GET /admin/billing/orgs?q=&filter=all|negative|grace|paid&sort=&dir=&page=&limit= */
export const listBillingOrgs = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, BILLING_ORG_SORTS, 'balance', 'asc');
  const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
  const conds: string[] = [];
  const params: any[] = [];
  const q: string = p.q;
  if (q) {
    if (isUuid(q)) { params.push(q); conds.push(`o.id = $${params.length}`); }
    else { params.push(`%${escapeLike(p.q)}%`); conds.push(`o.callsign ILIKE $${params.length}`); }
  }
  if (filter === 'negative') conds.push('ob.balance_cents < 0');
  else if (filter === 'grace') conds.push('ob.grace_started_at IS NOT NULL');
  else if (filter === 'paid') conds.push('o.tier > 0');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM organizations o LEFT JOIN org_billing ob ON ob.org_id = o.id ${where}`, params),
      pool.query(
        `SELECT o.id AS org_id, o.callsign, o.tier, o.created_at,
                COALESCE(ob.balance_cents, 0) AS balance_cents, ob.grace_started_at, ob.cycle_start_at
         FROM organizations o LEFT JOIN org_billing ob ON ob.org_id = o.id
         ${where}
         ORDER BY ${p.sortSql} ${p.dir} NULLS LAST, o.id ${p.dir}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      ),
    ]);
    const now = new Date();
    res.json({
      orgs: rows.rows.map((r: any) => {
        const s = stateFor(r, now);
        return {
          org_id: r.org_id, callsign: r.callsign, tier: Number(r.tier), tier_name: s.tier.name,
          balance_cents: Number(r.balance_cents), state: s.state, grace_ends_at: s.grace_ends_at,
          cycle_start_at: r.cycle_start_at ?? null, created_at: r.created_at,
          in_billing_scope: orgInBillingScope(r.org_id),
        };
      }),
      total: count.rows[0].n, page: p.page, limit: p.limit, sort: p.sort, dir: p.dir,
    });
  } catch (err) {
    return fail(res, 'list orgs', err);
  }
};

/**
 * GET /admin/billing/orgs/:orgId
 * Everything an operator needs for one org: wallet, state, the latest ledger
 * rows, contributions with provider ids, cycle charges and open exceptions.
 * Ledger and contributions have their own paginated endpoints.
 */
export const getBillingOrgDetail = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params as { orgId: string };
  if (!isUuid(orgId)) return res.status(400).json({ message: 'Invalid organization id' });
  try {
    const orgRes = await pool.query(
      `SELECT o.id, o.callsign, o.tier, o.created_at, o.owner_id, u.callsign AS owner_callsign
       FROM organizations o LEFT JOIN users u ON u.id = o.owner_id WHERE o.id = $1`,
      [orgId],
    );
    if (orgRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    const org = orgRes.rows[0];

    const [billing, ledger, contributions, cycles, exceptions, info] = await Promise.all([
      pool.query(
        `SELECT balance_cents, cycle_start_at, cycle_bytes_out, grace_started_at, updated_at
         FROM org_billing WHERE org_id = $1`, [orgId]),
      pool.query(
        `SELECT id, kind, delta_cents, balance_after_cents, description, contribution_id, created_at
         FROM billing_ledger WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 25`, [orgId]),
      pool.query(
        `SELECT bc.id, bc.status, bc.source, bc.provider, bc.payment_method, bc.amount_cents, bc.fee_cents,
                bc.charge_cents, bc.refunded_charge_cents, bc.reversed_cents, bc.dispute_status, bc.dispute_held_cents,
                bc.provider_payment_id, bc.provider_session_id, bc.external_invoice_ref, bc.last_error,
                bc.created_at, bc.credited_at, u.callsign AS contributor_callsign
         FROM billing_contributions bc LEFT JOIN users u ON u.id = bc.user_id
         WHERE bc.org_id = $1 ORDER BY bc.created_at DESC LIMIT 25`, [orgId]),
      pool.query(
        `SELECT id, cycle_start, cycle_end, tier, bytes_out, base_cents, overage_cents, total_cents, applied, created_at
         FROM billing_cycle_charges WHERE org_id = $1 ORDER BY cycle_start DESC LIMIT 24`, [orgId]),
      pool.query(
        `SELECT id, kind, provider_payment_id, contribution_id, detail, auto_action, created_at
         FROM billing_payment_exceptions WHERE org_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 50`, [orgId]),
      pool.query(`SELECT company_name, billing_email, is_tax_exempt, updated_at FROM org_billing_info WHERE org_id = $1`, [orgId]),
    ]);

    const b = billing.rows[0] ?? null;
    const s = stateFor({ tier: org.tier, balance_cents: b?.balance_cents ?? 0, grace_started_at: b?.grace_started_at ?? null });
    const effective = await getEffectiveTierConfig(orgId, Number(org.tier));
    const i = info.rows[0];
    // Cycle summary + last settled cycles from the billing core
    // (billingCycle.adminCycleDetail). Guarded: older cores don't export it,
    // and a failure there must not take the whole detail view down — the
    // panel then derives the cycle from cycle_start_at.
    let cycleDetail: { cycle: unknown; recentCycles: unknown[] } = { cycle: null, recentCycles: [] };
    const adminCycleDetail = (billingCycle as any).adminCycleDetail as undefined | ((id: string) => Promise<any>);
    if (typeof adminCycleDetail === 'function') {
      try { cycleDetail = await adminCycleDetail(orgId); } catch (err) { console.error('[admin-billing] cycle detail error:', safeErr(err)); }
    }

    res.json({
      org: { id: org.id, callsign: org.callsign, tier: Number(org.tier), tier_name: s.tier.name,
             owner_id: org.owner_id, owner_callsign: org.owner_callsign, created_at: org.created_at },
      billing: b && {
        balance_cents: Number(b.balance_cents), cycle_start_at: b.cycle_start_at, cycle_bytes_out: Number(b.cycle_bytes_out),
        grace_started_at: b.grace_started_at, updated_at: b.updated_at,
      },
      state: s.state,
      grace_ends_at: s.grace_ends_at,
      effective_tier: { id: effective.id, name: effective.name },
      in_billing_scope: orgInBillingScope(orgId),
      enforced: billingEnforced(orgId),
      // Contact details are PII: masked here. The raw record is
      // GET /admin/orgs/:orgId/billing-info (operator, for invoicing tools).
      billing_info: i ? {
        company_name: i.company_name, billing_email_masked: maskEmail(i.billing_email),
        is_tax_exempt: i.is_tax_exempt, updated_at: i.updated_at,
      } : null,
      ledger: ledger.rows.map((r: any) => ({ ...r, delta_cents: Number(r.delta_cents),
        balance_after_cents: r.balance_after_cents == null ? null : Number(r.balance_after_cents) })),
      contributions: contributions.rows,
      cycle_charges: cycles.rows.map((r: any) => ({ ...r, bytes_out: Number(r.bytes_out) })),
      open_exceptions: exceptions.rows,
      cycle: cycleDetail.cycle ?? null,
      recentCycles: cycleDetail.recentCycles ?? [],
    });
  } catch (err) {
    return fail(res, 'org detail', err);
  }
};

/** GET /admin/billing/orgs/:orgId/ledger?kind=&page=&limit= */
export const listOrgLedger = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params as { orgId: string };
  if (!isUuid(orgId)) return res.status(400).json({ message: 'Invalid organization id' });
  const p = parseListParams(req.query as any, { created_at: 'created_at' }, 'created_at');
  const params: any[] = [orgId];
  let where = 'WHERE org_id = $1';
  const KINDS = ['contribution', 'refund', 'dispute_hold', 'dispute_release', 'cycle_charge', 'adjustment'];
  if (typeof req.query.kind === 'string' && KINDS.includes(req.query.kind)) {
    params.push(req.query.kind); where += ` AND kind = $2`;
  }
  try {
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM billing_ledger ${where}`, params),
      pool.query(
        `SELECT id, kind, delta_cents, balance_after_cents, description, contribution_id, created_at
         FROM billing_ledger ${where}
         ORDER BY created_at ${p.dir}, id ${p.dir}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      ),
    ]);
    res.json({ entries: rows.rows, total: count.rows[0].n, page: p.page, limit: p.limit });
  } catch (err) {
    return fail(res, 'org ledger', err);
  }
};

// ─── Read: payments (all statuses) ───────────────────────────────────────────

const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'canceled', 'refunded'];

/**
 * GET /admin/billing/payments?org_id=&status=&disputed=true&q=&page=&limit=
 * q is an exact id: contribution uuid, provider payment id (pi_…), checkout
 * session id (cs_…) or external invoice ref. (GET /admin/billing/contributions
 * is the separate succeeded-only sync feed for external bookkeeping.)
 */
export const listPayments = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, { created_at: 'bc.created_at', amount: 'bc.amount_cents' }, 'created_at');
  const conds: string[] = [];
  const params: any[] = [];
  const orgId = req.query.org_id;
  if (orgId !== undefined && orgId !== '') {
    if (!isUuid(orgId)) return res.status(400).json({ message: 'Invalid org_id' });
    params.push(orgId); conds.push(`bc.org_id = $${params.length}`);
  }
  if (typeof req.query.status === 'string' && PAYMENT_STATUSES.includes(req.query.status)) {
    params.push(req.query.status); conds.push(`bc.status = $${params.length}`);
  }
  if (req.query.disputed === 'true') conds.push(`bc.dispute_status IS NOT NULL`);
  if (p.q) {
    params.push(p.q);
    const n = params.length;
    conds.push(isUuid(p.q)
      ? `bc.id = $${n}::uuid`
      : `(bc.provider_payment_id = $${n} OR bc.provider_session_id = $${n} OR bc.external_invoice_ref = $${n})`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  try {
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM billing_contributions bc ${where}`, params),
      pool.query(
        `SELECT bc.id, bc.org_id, o.callsign AS org_callsign, u.callsign AS contributor_callsign,
                bc.status, bc.source, bc.provider, bc.payment_method, bc.amount_cents, bc.fee_cents, bc.charge_cents,
                bc.refunded_charge_cents, bc.reversed_cents, bc.dispute_status, bc.dispute_held_cents,
                bc.provider_payment_id, bc.provider_session_id, bc.external_invoice_ref, bc.last_error,
                bc.created_at, bc.credited_at
         FROM billing_contributions bc
         LEFT JOIN organizations o ON o.id = bc.org_id
         LEFT JOIN users u ON u.id = bc.user_id
         ${where}
         ORDER BY ${p.sortSql} ${p.dir}, bc.id ${p.dir}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      ),
    ]);
    res.json({ payments: rows.rows, total: count.rows[0].n, page: p.page, limit: p.limit });
  } catch (err) {
    return fail(res, 'list payments', err);
  }
};

// ─── Read: webhooks ──────────────────────────────────────────────────────────

/** GET /admin/billing/webhooks?status=stuck|failed|unprocessed|all&page=&limit= */
export const listWebhookEvents = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, { received_at: 'received_at' }, 'received_at');
  const status = typeof req.query.status === 'string' ? req.query.status : 'stuck';
  const where = status === 'stuck' ? `WHERE ${STUCK_WEBHOOK_SQL}`
    : status === 'failed' ? 'WHERE last_error IS NOT NULL'
    : status === 'unprocessed' ? 'WHERE processed_at IS NULL'
    : '';
  try {
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM billing_webhook_events ${where}`),
      pool.query(
        `SELECT event_id, provider, type, livemode, received_at, processed_at, attempts, last_error
         FROM billing_webhook_events ${where}
         ORDER BY received_at ${p.dir}, event_id
         LIMIT $1 OFFSET $2`,
        [p.limit, p.offset],
      ),
    ]);
    res.json({
      events: rows.rows.map((r: any) => ({ ...r, last_error: r.last_error ? String(r.last_error).slice(0, 500) : null })),
      total: count.rows[0].n, page: p.page, limit: p.limit, status,
    });
  } catch (err) {
    return fail(res, 'list webhooks', err);
  }
};

// ─── Exceptions ──────────────────────────────────────────────────────────────

const EXCEPTION_KINDS = ['duplicate_payment', 'unmatched_payment', 'amount_mismatch', 'status_mismatch',
  'refund_mismatch', 'missing_at_provider', 'org_deleted', 'balance_drift', 'dispute_lost'];

/** GET /admin/billing/exceptions?status=open|resolved|all&kind=&org_id=&page=&limit= (offset= still accepted) */
export const listExceptions = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, { created_at: 'e.created_at' }, 'created_at');
  const legacyOffset = parseInt(String(req.query.offset ?? ''), 10);
  const offset = req.query.page === undefined && Number.isFinite(legacyOffset) ? Math.min(100_000, Math.max(0, legacyOffset)) : p.offset;
  const status = (req.query.status as string) || 'open';
  const conds: string[] = [];
  const params: any[] = [];
  if (status === 'resolved') conds.push('e.resolved_at IS NOT NULL');
  else if (status !== 'all') conds.push('e.resolved_at IS NULL');
  if (typeof req.query.kind === 'string' && EXCEPTION_KINDS.includes(req.query.kind)) {
    params.push(req.query.kind); conds.push(`e.kind = $${params.length}`);
  }
  if (req.query.org_id !== undefined && req.query.org_id !== '') {
    if (!isUuid(req.query.org_id)) return res.status(400).json({ message: 'Invalid org_id' });
    params.push(req.query.org_id); conds.push(`e.org_id = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  try {
    const [count, result] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM billing_payment_exceptions e ${where}`, params),
      pool.query(
        `SELECT e.*, o.callsign AS org_callsign
         FROM billing_payment_exceptions e
         LEFT JOIN organizations o ON o.id = e.org_id
         ${where}
         ORDER BY e.created_at ${p.dir}, e.id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, offset],
      ),
    ]);
    const total = count.rows[0].n as number;
    res.json({ exceptions: result.rows, total, page: p.page, limit: p.limit, has_more: offset + result.rows.length < total });
  } catch (err) {
    return fail(res, 'list exceptions', err);
  }
};

/** POST /admin/billing/exceptions/:id/resolve  Body: { note: string } */
export const resolveException = async (req: AdminRequest, res: Response) => {
  const { id } = req.params as { id: string };
  const note = cleanReason(req.body?.note, 1000);
  if (!isUuid(id)) return res.status(404).json({ message: 'Exception not found' });
  if (!note) return res.status(400).json({ message: 'A resolution note is required' });
  try {
    const done = await withTransaction(async (c) => {
      const r = await c.query(
        `UPDATE billing_payment_exceptions
         SET resolved_at = NOW(), resolved_note = $2
         WHERE id = $1 AND resolved_at IS NULL
         RETURNING kind, org_id, contribution_id, provider_payment_id`,
        [id, `${note} (admin ${req.admin?.username ?? req.admin?.id ?? 'unknown'})`],
      );
      if (r.rows.length === 0) return null;
      const e = r.rows[0];
      await writeAudit(c, req, {
        action: 'billing.exception_resolved', targetType: 'billing_exception', targetId: id, reason: note,
        summary: { kind: e.kind, org_id: e.org_id, contribution_id: e.contribution_id, provider_payment_id: e.provider_payment_id },
      });
      return e;
    });
    if (!done) return res.status(404).json({ message: 'Exception not found or already resolved' });
    res.json({ message: 'Resolved.' });
  } catch (err) {
    return fail(res, 'resolve exception', err);
  }
};

// ─── Reconcile ───────────────────────────────────────────────────────────────

/**
 * POST /admin/billing/reconcile
 * Body: { since?: ISO, until?: ISO, repair?: boolean, confirm?: 'REPAIR' }
 * Default window: the last 7 days. Read-only unless repair=true; a repair run
 * needs the owner role (routes/adminBilling.ts) and confirm: 'REPAIR'.
 */
export const runReconciliation = async (req: AdminRequest, res: Response) => {
  const { since, until, repair, confirm } = req.body ?? {};
  const untilDate = until ? new Date(until) : new Date();
  const sinceDate = since ? new Date(since) : new Date(untilDate.getTime() - 7 * 86_400_000);
  if (Number.isNaN(sinceDate.getTime()) || Number.isNaN(untilDate.getTime()) || sinceDate >= untilDate) {
    return res.status(400).json({ message: 'since/until must be valid ISO dates with since < until' });
  }
  if (untilDate.getTime() - sinceDate.getTime() > MAX_RECONCILE_DAYS * 86_400_000) {
    return res.status(400).json({ message: `window must be at most ${MAX_RECONCILE_DAYS} days` });
  }
  if (repair !== undefined && typeof repair !== 'boolean') return res.status(400).json({ message: 'repair must be a boolean' });
  if (repair === true && confirm !== 'REPAIR') {
    return res.status(400).json({ message: 'Type REPAIR to confirm a repair run.', code: 'CONFIRMATION_REQUIRED' });
  }

  try {
    const status = paymentsStatus();
    const provider = status.provider ? await getProviderByName(status.provider) : null;
    const report = await reconcileBilling({ since: sinceDate, until: untilDate, provider, repair: repair === true });
    await writeAudit(pool, req, {
      action: repair === true ? 'billing.reconcile_repair' : 'billing.reconcile',
      targetType: 'billing', targetId: null,
      summary: {
        since: report.since, until: report.until, provider: report.provider, mode: status.mode,
        issues: report.issues.length, repaired: report.repaired,
      },
    });
    res.json(report);
  } catch (err) {
    console.error('[admin-billing] reconcile error:', safeErr(err));
    res.status(500).json({ message: 'Reconciliation failed', detail: String((err as Error)?.message ?? err).slice(0, 300) });
  }
};

// ─── Money: refund ───────────────────────────────────────────────────────────

/**
 * POST /admin/billing/contributions/:id/refund
 * Body: { amount_cents?: number (charge-side, default = everything not yet refunded),
 *         confirm_amount_cents: number (must equal the amount refunded),
 *         reason: string, request_id: string }
 *
 * Issues the refund at the provider only. The pool reversal is applied when
 * the provider confirms (charge.refunded webhook, or synchronously for dev),
 * through the same idempotent path as a refund made in the Stripe dashboard.
 *
 * request_id makes a double-click one refund, not two: a request_id already
 * recorded as issued answers duplicate:true without calling the provider, a
 * concurrent one gets 409 REQUEST_IN_FLIGHT, and the provider call itself
 * carries an idempotency key derived from it.
 */
export const refundContribution = async (req: AdminRequest, res: Response) => {
  const { id } = req.params as { id: string };
  const { amount_cents, confirm_amount_cents, request_id } = req.body ?? {};
  const reason = cleanReason(req.body?.reason);
  if (!isUuid(id)) return res.status(404).json({ message: 'Contribution not found' });
  if (!reason) return res.status(400).json({ message: 'reason is required' });
  if (!isRequestId(request_id)) return res.status(400).json({ message: 'request_id is required (8-64 chars, A-Z a-z 0-9 _ -)' });
  if (amount_cents !== undefined && (!Number.isInteger(amount_cents) || amount_cents <= 0 || amount_cents > MAX_MONEY_CENTS)) {
    return res.status(400).json({ message: `amount_cents must be a whole number between 1 and ${MAX_MONEY_CENTS}` });
  }

  await exclusive(`refund:${request_id}`, res, async () => {
    try {
      const prior = await pool.query(
        `SELECT summary FROM admin_audit_log
         WHERE action = 'billing.refund_issued' AND target_type = 'contribution' AND target_id = $1
           AND summary->>'request_id' = $2
         LIMIT 1`,
        [id, request_id],
      );
      if (prior.rows.length > 0) {
        const s = prior.rows[0].summary ?? {};
        return res.json({ message: 'Already issued (same request_id).', duplicate: true,
                          refund_id: s.refund_id ?? null, amount_cents: s.amount_cents ?? null });
      }

      const rowRes = await pool.query(
        `SELECT org_id, provider, provider_payment_id, status, charge_cents, amount_cents, fee_cents,
                refunded_charge_cents, dispute_status
         FROM billing_contributions WHERE id = $1`,
        [id],
      );
      const row = rowRes.rows[0];
      if (!row) return res.status(404).json({ message: 'Contribution not found' });
      if (row.status !== 'succeeded' || !row.provider_payment_id) {
        return res.status(409).json({ message: `Only a succeeded payment can be refunded (status: ${row.status})` });
      }
      if (row.dispute_status === 'open' || row.dispute_status === 'lost') {
        return res.status(409).json({ message: 'This payment is disputed — the card network handles the money; respond to the dispute instead' });
      }
      const charge = Number(row.charge_cents ?? Number(row.amount_cents) + Number(row.fee_cents));
      const refundable = charge - Number(row.refunded_charge_cents);
      const amount: number = amount_cents ?? refundable;
      if (amount <= 0) return res.status(409).json({ message: 'Nothing left to refund on this payment' });
      if (amount > refundable) return res.status(400).json({ message: `At most ${refundable} cents can still be refunded` });
      if (confirm_amount_cents !== amount) {
        return res.status(400).json({ message: `Type the refund amount (${amount} cents) to confirm.`, code: 'CONFIRMATION_REQUIRED', amount_cents: amount });
      }

      const provider = await getProviderByName(row.provider);
      if (!provider) return res.status(503).json({ message: `Provider ${row.provider} is not configured on this server` });

      const summary = {
        request_id, amount_cents: amount, refundable_before_cents: refundable, charge_cents: charge,
        org_id: row.org_id, provider: row.provider, provider_payment_id: row.provider_payment_id,
        mode: paymentsStatus().mode,
      };
      // Intent first: the trail records the attempt even if the process dies mid-call.
      await writeAudit(pool, req, { action: 'billing.refund_requested', targetType: 'contribution', targetId: id, reason, summary });

      let out: { refundId: string };
      try {
        out = await provider.refund(row.provider_payment_id, amount, `admin:${request_id}`);
      } catch (err) {
        await writeAudit(pool, req, {
          action: 'billing.refund_failed', targetType: 'contribution', targetId: id, reason,
          summary: { ...summary, error: String((err as Error)?.message ?? err).slice(0, 300) },
        }).catch(() => {});
        console.error('[admin-billing] refund provider error:', safeErr(err));
        return res.status(502).json({ message: 'Refund failed at the provider', detail: String((err as Error)?.message ?? err).slice(0, 300) });
      }

      await writeAudit(pool, req, {
        action: 'billing.refund_issued', targetType: 'contribution', targetId: id, reason,
        summary: { ...summary, refund_id: out.refundId },
      });
      console.log(`[admin-billing] refund ${out.refundId} of ${amount}c on contribution ${id} by admin ${req.admin?.id}`);
      res.json({ refund_id: out.refundId, amount_cents: amount, message: 'Refund issued — the pool is adjusted when the provider confirms it.' });
    } catch (err) {
      return fail(res, 'refund', err);
    }
  });
};

// ─── Money: adjust ───────────────────────────────────────────────────────────

/**
 * POST /admin/billing/orgs/:orgId/adjust
 * Body: { delta_cents: number (non-zero, +credit / -debit), confirm_amount_cents: number (= delta_cents),
 *         reason: string, request_id: string }
 * Manual goodwill credit or correction — always a ledger row, never a raw
 * balance edit. The ledger idempotency key (adjust:<org>:<request_id>) makes a
 * replay a no-op; the audit row is written in the same transaction.
 */
export const adjustOrgBalance = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params as { orgId: string };
  const { delta_cents, confirm_amount_cents, request_id } = req.body ?? {};
  const reason = cleanReason(req.body?.reason, 200);
  if (!isUuid(orgId)) return res.status(404).json({ message: 'Organization not found' });
  if (!Number.isInteger(delta_cents) || delta_cents === 0 || Math.abs(delta_cents) > MAX_MONEY_CENTS) {
    return res.status(400).json({ message: `delta_cents must be a non-zero whole number (max ±${MAX_MONEY_CENTS})` });
  }
  if (!reason) return res.status(400).json({ message: 'reason is required' });
  if (!isRequestId(request_id)) return res.status(400).json({ message: 'request_id is required (8-64 chars, A-Z a-z 0-9 _ -)' });
  if (confirm_amount_cents !== delta_cents) {
    return res.status(400).json({ message: 'Type the adjustment amount to confirm.', code: 'CONFIRMATION_REQUIRED' });
  }

  await exclusive(`adjust:${orgId}:${request_id}`, res, async () => {
    try {
      const exists = await pool.query(`SELECT callsign FROM organizations WHERE id = $1`, [orgId]);
      if (exists.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
      const balance = await withTransaction(async (client) => {
        const before = await client.query(`SELECT balance_cents FROM org_billing WHERE org_id = $1 FOR UPDATE`, [orgId]);
        const after = await applyPoolDelta(client, {
          orgId,
          deltaCents: delta_cents,
          kind: 'adjustment',
          description: `Admin adjustment: ${reason}`,
          idempotencyKey: `adjust:${orgId}:${request_id}`,
        });
        if (after !== null) {
          await writeAudit(client, req, {
            action: 'billing.adjusted', targetType: 'org', targetId: orgId, reason,
            summary: {
              request_id, delta_cents, callsign: exists.rows[0].callsign,
              balance_before_cents: before.rows[0] ? Number(before.rows[0].balance_cents) : 0,
              balance_after_cents: after,
            },
          });
        }
        return after;
      });
      if (balance === null) return res.json({ message: 'Already applied (same request_id).', duplicate: true });
      res.json({ message: 'Adjustment applied.', balance_cents: balance });
    } catch (err) {
      return fail(res, 'adjust', err);
    }
  });
};

// ─── Money: settle ───────────────────────────────────────────────────────────

/**
 * POST /admin/billing/settle  Body: { confirm: 'SETTLE' }
 * Runs cycle settlement now instead of waiting for the hourly job. Idempotent
 * per cycle (unique cycle row + ledger key); with enforcement on it debits.
 */
export const runSettlement = async (req: AdminRequest, res: Response) => {
  if (req.body?.confirm !== 'SETTLE') {
    return res.status(400).json({ message: 'Type SETTLE to confirm.', code: 'CONFIRMATION_REQUIRED' });
  }
  await exclusive('settle', res, async () => {
    try {
      const n = await settleDueOrgs();
      await writeAudit(pool, req, {
        action: 'billing.settlement_run', targetType: 'billing', targetId: null,
        summary: { orgs_settled: n, enforcement_active: billingEnforced() },
      });
      res.json({ orgs_settled: n, enforcement_active: billingEnforced() });
    } catch (err) {
      return fail(res, 'settle', err);
    }
  });
};
