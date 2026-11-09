import { pool } from '../config/db.js';
import { getBillingConfig, billingEnforced, BillingConfig, BillingTier } from '../config/billingConfig.js';
import { getOrgTierConfig } from './orgTiers.js';
import { applyPoolDelta, withTransaction } from './billingCredit.js';
import { getActiveBillingConfigMeta, pricingSnapshot, TierPricing } from '../config/billingConfigStore.js';

// Monthly cycle settlement and the run-dry state machine.
//
// Before this, nothing ever debited a pool: balance_cents only went up, and
// the cycle was rolled over lazily (zeroing usage, charging nothing) whenever
// someone happened to open the billing panel. Now each closed cycle becomes
// exactly one billing_cycle_charges row (UNIQUE(org_id, cycle_start)), and —
// only when BILLING_ENFORCE=true — one idempotent ledger debit.
//
// Service policy when a pool runs dry (evaluation §6):
//   active → low_balance → grace (balance < 0, for graceDays) → restricted
// "restricted" only ever lowers the tier used for NEW media tokens (video
// bitrate / data cap of runDryTier). Voice is never gated and live sessions
// are never cut — a restriction lands at the next join, never mid-op.

export type ServiceState = 'active' | 'low_balance' | 'grace' | 'restricted';

/**
 * Calendar-month step in UTC, clamped to the target month's last day.
 * (Plain setMonth overflows: Jan 31 + 1 month = Mar 3, which silently
 * skipped February's cycle boundary.)
 */
export function addMonths(d: Date, n: number): Date {
  const day = d.getUTCDate();
  const copy = new Date(d);
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(copy.getUTCFullYear(), copy.getUTCMonth() + 1, 0)).getUTCDate();
  copy.setUTCDate(Math.min(day, lastDay));
  return copy;
}

export function computeCycleCharge(tier: BillingTier, bytesOut: number): { baseCents: number; overageCents: number; totalCents: number } {
  const baseCents = tier.priceCents;
  let overageCents = 0;
  if (tier.overageCentsPerGb != null) {
    const overGb = Math.max(0, (bytesOut - tier.cycleDataLimitBytes) / 1_000_000_000);
    overageCents = Math.ceil(overGb * tier.overageCentsPerGb);
  }
  return { baseCents, overageCents, totalCents: baseCents + overageCents };
}

export interface ServiceStateInput {
  balanceCents: number;
  graceStartedAt: Date | null;
  tierPriceCents: number;
  now: Date;
  cfg?: BillingConfig;
}

export interface ServiceStateResult {
  state: ServiceState;
  graceEndsAt: Date | null;
}

export function computeServiceState(i: ServiceStateInput): ServiceStateResult {
  const cfg = i.cfg ?? getBillingConfig();
  if (i.balanceCents < 0) {
    const start = i.graceStartedAt ?? i.now;
    const graceEndsAt = new Date(start.getTime() + cfg.graceDays * 86_400_000);
    return { state: i.now < graceEndsAt ? 'grace' : 'restricted', graceEndsAt };
  }
  if (i.tierPriceCents > 0 && i.balanceCents < i.tierPriceCents * cfg.lowBalanceCycles) {
    return { state: 'low_balance', graceEndsAt: null };
  }
  return { state: 'active', graceEndsAt: null };
}

/** Tier to charge/serve while restricted: runDryTier when it is cheaper than the org's own. */
function restrictedTier(stored: BillingTier, cfg: BillingConfig): BillingTier {
  const floor = cfg.tiers.find(t => t.id === cfg.runDryTier)!;
  return floor.priceCents < stored.priceCents ? floor : stored;
}

/**
 * The tier a new media token should be issued under. Without enforcement this
 * is always the org's own tier; with it, a restricted org gets runDryTier.
 */
export async function getEffectiveTierConfig(orgId: string, storedTier: number, now = new Date()): Promise<BillingTier> {
  const stored = getOrgTierConfig(storedTier);
  if (!billingEnforced(orgId)) return stored;
  const res = await pool.query(
    `SELECT balance_cents, grace_started_at FROM org_billing WHERE org_id = $1`,
    [orgId]
  );
  if (res.rows.length === 0) return stored;
  const { state } = computeServiceState({
    balanceCents: Number(res.rows[0].balance_cents),
    graceStartedAt: res.rows[0].grace_started_at ? new Date(res.rows[0].grace_started_at) : null,
    tierPriceCents: stored.priceCents,
    now,
  });
  return state === 'restricted' ? restrictedTier(stored, getBillingConfig()) : stored;
}

/**
 * A tier as it is priced for a cycle: the current config's tier (limits,
 * bitrate — those apply immediately) with the billing fields (price, overage
 * rate, included data, name) taken from the cycle's price snapshot when the
 * snapshot has that tier id. `snapshot` null = no price change since the
 * cycle started, so the current config IS the cycle's pricing.
 */
export function pricedTier(current: BillingTier, snapshot: TierPricing[] | null | undefined): BillingTier {
  const s = snapshot?.find(p => p.id === current.id);
  if (!s) return current;
  return {
    ...current, name: s.name, priceCents: s.priceCents,
    overageCentsPerGb: s.overageCentsPerGb, cycleDataLimitBytes: s.cycleDataLimitBytes,
  };
}

function parseSnapshot(raw: unknown): TierPricing[] | null {
  if (!raw) return null;
  const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(v) ? v as TierPricing[] : null;
}

function activeVersion(): number | null {
  const m = getActiveBillingConfigMeta();
  return m.source === 'db' ? m.version : null;
}

/**
 * Settle every fully elapsed cycle for one org. Safe to call concurrently and
 * repeatedly (row lock + unique cycle row + ledger idempotency key). Returns
 * how many cycles were closed.
 *
 * Usage per cycle comes from org_usage_daily (day granularity: a cycle owns
 * the days in [start::date, end::date)), so cycles that elapsed while nobody
 * looked are each billed for their own usage instead of being lumped together.
 *
 * Price lock: a cycle is charged at the prices in effect when it STARTED.
 * org_billing.cycle_pricing holds that snapshot (filled from the outgoing
 * config whenever an admin saves a new one — config/billingConfigStore.ts —
 * and re-taken from the live config each time a new cycle starts here). When
 * several cycles are caught up at once, only the first has a recorded
 * snapshot; the later ones use the live config (the hourly job makes that
 * case rare). The org's tier itself is still read at settlement, as before.
 */
export async function settleOrg(orgId: string, now = new Date()): Promise<number> {
  const cfg = getBillingConfig();
  const enforce = billingEnforced(orgId);

  return withTransaction(async (client) => {
    const res = await client.query(
      `SELECT ob.cycle_start_at, ob.balance_cents, ob.grace_started_at, ob.cycle_pricing, ob.cycle_config_version, o.tier
       FROM org_billing ob
       JOIN organizations o ON o.id = ob.org_id
       WHERE ob.org_id = $1
       FOR UPDATE OF ob`,
      [orgId]
    );
    if (res.rows.length === 0) return 0;

    let start = new Date(res.rows[0].cycle_start_at);
    if (now < addMonths(start, 1)) return 0;

    const current = getOrgTierConfig(Number(res.rows[0].tier ?? 0));
    let snapshot = parseSnapshot(res.rows[0].cycle_pricing);
    let cycleVersion: number | null = snapshot ? (res.rows[0].cycle_config_version ?? null) : activeVersion();
    let settled = 0;

    while (now >= addMonths(start, 1)) {
      const stored = pricedTier(current, snapshot);
      const floor = pricedTier(cfg.tiers.find(t => t.id === cfg.runDryTier)!, snapshot);
      const end = addMonths(start, 1);
      const usage = await client.query(
        `SELECT COALESCE(SUM(bytes_out), 0) AS bytes
         FROM org_usage_daily
         WHERE org_id = $1 AND day >= $2::timestamptz::date AND day < $3::timestamptz::date`,
        [orgId, start, end]
      );
      const bytes = Number(usage.rows[0].bytes);

      // An org that was already restricted at this cycle's close is charged
      // for the service it actually got, not the plan it couldn't pay for —
      // otherwise debt compounds every month it sits dry.
      const bal = await client.query(`SELECT balance_cents, grace_started_at FROM org_billing WHERE org_id = $1`, [orgId]);
      const { state } = computeServiceState({
        balanceCents: Number(bal.rows[0].balance_cents),
        graceStartedAt: bal.rows[0].grace_started_at ? new Date(bal.rows[0].grace_started_at) : null,
        tierPriceCents: stored.priceCents,
        now: end,
        cfg,
      });
      const tier = enforce && state === 'restricted' && floor.priceCents < stored.priceCents ? floor : stored;
      const charge = computeCycleCharge(tier, bytes);
      const applied = enforce && charge.totalCents > 0;

      const ins = await client.query(
        `INSERT INTO billing_cycle_charges
           (org_id, cycle_start, cycle_end, tier, bytes_out, base_cents, overage_cents, total_cents, applied, config_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (org_id, cycle_start) DO NOTHING
         RETURNING id`,
        [orgId, start, end, tier.id, bytes, charge.baseCents, charge.overageCents, charge.totalCents, applied, cycleVersion]
      );
      if (ins.rows.length > 0 && applied) {
        await applyPoolDelta(client, {
          orgId,
          deltaCents: -charge.totalCents,
          kind: 'cycle_charge',
          description: `${tier.name} plan ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`
            + (charge.overageCents > 0 ? ` incl. ${(charge.overageCents / 100).toFixed(2)} data overage` : ''),
          idempotencyKey: `cycle:${orgId}:${start.toISOString()}`,
          at: end,
        });
      }
      settled++;
      start = end;
      // Cycles after the first start now-ish (catch-up): live config.
      snapshot = null;
      cycleVersion = activeVersion();
    }

    // The new cycle locks in the live prices.
    await client.query(
      `UPDATE org_billing
       SET cycle_start_at = $2,
           cycle_bytes_out = (SELECT COALESCE(SUM(bytes_out), 0) FROM org_usage_daily
                              WHERE org_id = $1 AND day >= $2::timestamptz::date),
           cycle_pricing = $3::jsonb,
           cycle_config_version = $4,
           updated_at = NOW()
       WHERE org_id = $1`,
      [orgId, start, JSON.stringify(pricingSnapshot(cfg)), activeVersion()]
    );
    return settled;
  });
}

// ─── The explicit cycle object (GET /orgs/:id/billing → cycle, admin detail) ──
//
// Cycle anchor: org_billing.cycle_start_at, i.e. when the org's billing row
// was first created — the first billing activity (first metered usage, first
// visit to the billing panel, first funding), or migration 000008 for orgs
// that existed then. It is NOT the org's creation date nor its first payment.
// Each cycle is one calendar month from its start in UTC, end exclusive; the
// day is clamped to the target month's last day (addMonths): a Jan 31 start
// ends Feb 28 (Feb 29 in a leap year), and the next cycle runs from there.
// Settlement debits at `end` (the hourly job closes it within the hour).

export interface CycleInfo {
  start: string;
  end: string;
  daysRemaining: number;
  tierId: number;
  tierName: string;
  /** Plan price locked for this cycle (the snapshot taken when it started). */
  priceCents: number;
  nextCycle: { start: string; tierId: number; priceCents: number };
  nextChargeAt: string;
  /** What settlement would debit at `end` with usage so far (price + any overage). */
  nextChargeCents: number;
  /** true = a real debit; false = a shadow charge (recorded, never debited). */
  enforced: boolean;
  state: 'ok' | 'low_balance' | 'grace' | 'restricted';
  graceEndsAt: string | null;
  /** Full cycles the balance covers at the next cycle's price (floor); null for a free plan. Billing viewers only. */
  coversCycles?: number | null;
}

export async function buildCycleInfo(orgId: string, opts: { includeCoverage: boolean; now?: Date }): Promise<CycleInfo | null> {
  const now = opts.now ?? new Date();
  const res = await pool.query(
    `SELECT ob.cycle_start_at, ob.cycle_bytes_out, ob.balance_cents, ob.grace_started_at, ob.cycle_pricing, o.tier
     FROM org_billing ob JOIN organizations o ON o.id = ob.org_id
     WHERE ob.org_id = $1`,
    [orgId]
  );
  const row = res.rows[0];
  if (!row) return null;

  const cfg = getBillingConfig();
  const start = new Date(row.cycle_start_at);
  const end = addMonths(start, 1);
  const current = getOrgTierConfig(Number(row.tier ?? 0));
  const locked = pricedTier(current, parseSnapshot(row.cycle_pricing));
  const balanceCents = Number(row.balance_cents);
  const enforced = billingEnforced(orgId);

  const svc = computeServiceState({
    balanceCents,
    graceStartedAt: row.grace_started_at ? new Date(row.grace_started_at) : null,
    tierPriceCents: locked.priceCents,
    now,
    cfg,
  });
  // Same tier choice settlement makes at `end`.
  const floor = pricedTier(cfg.tiers.find(t => t.id === cfg.runDryTier)!, parseSnapshot(row.cycle_pricing));
  const atEnd = computeServiceState({
    balanceCents,
    graceStartedAt: row.grace_started_at ? new Date(row.grace_started_at) : null,
    tierPriceCents: locked.priceCents,
    now: end,
    cfg,
  });
  const chargedTier = enforced && atEnd.state === 'restricted' && floor.priceCents < locked.priceCents ? floor : locked;

  const info: CycleInfo = {
    start: start.toISOString(),
    end: end.toISOString(),
    daysRemaining: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000)),
    tierId: locked.id,
    tierName: locked.name,
    priceCents: locked.priceCents,
    nextCycle: { start: end.toISOString(), tierId: current.id, priceCents: current.priceCents },
    nextChargeAt: end.toISOString(),
    nextChargeCents: computeCycleCharge(chargedTier, Number(row.cycle_bytes_out)).totalCents,
    enforced,
    state: svc.state === 'active' ? 'ok' : svc.state,
    graceEndsAt: svc.graceEndsAt ? svc.graceEndsAt.toISOString() : null,
  };
  if (opts.includeCoverage) {
    info.coversCycles = current.priceCents > 0 ? Math.max(0, Math.floor(balanceCents / current.priceCents)) : null;
  }
  return info;
}

export interface SettledCycle { start: string; end: string; chargeCents: number; applied: boolean; configVersion: number | null }

/** Last `limit` settled cycles, newest first — for the admin per-org view. */
export async function recentSettledCycles(orgId: string, limit = 6): Promise<SettledCycle[]> {
  const res = await pool.query(
    `SELECT cycle_start, cycle_end, total_cents, applied, config_version
     FROM billing_cycle_charges WHERE org_id = $1 ORDER BY cycle_start DESC LIMIT $2`,
    [orgId, limit]
  );
  return res.rows.map((r: any) => ({
    start: new Date(r.cycle_start).toISOString(),
    end: new Date(r.cycle_end).toISOString(),
    chargeCents: Number(r.total_cents),
    applied: !!r.applied,
    configVersion: r.config_version == null ? null : Number(r.config_version),
  }));
}

/** Admin per-org detail: the member-facing cycle object (with coverage) + the last 6 settled cycles. */
export async function adminCycleDetail(orgId: string): Promise<{ cycle: CycleInfo | null; recentCycles: SettledCycle[] }> {
  const [cycle, recentCycles] = await Promise.all([
    buildCycleInfo(orgId, { includeCoverage: true }),
    recentSettledCycles(orgId, 6),
  ]);
  return { cycle, recentCycles };
}

/** Settle every org with an elapsed cycle. Returns orgs settled; one org's failure doesn't stop the rest. */
export async function settleDueOrgs(now = new Date()): Promise<number> {
  const due = await pool.query(
    `SELECT ob.org_id FROM org_billing ob
     JOIN organizations o ON o.id = ob.org_id
     WHERE ob.cycle_start_at <= $1::timestamptz - INTERVAL '1 month'`,
    [now]
  );
  let n = 0;
  for (const { org_id } of due.rows) {
    try {
      if (await settleOrg(org_id, now) > 0) n++;
    } catch (err) {
      console.error(`[billing] cycle settlement failed for org ${org_id}:`, err);
    }
  }
  return n;
}

let schedulerTimer: NodeJS.Timeout | null = null;

/**
 * Hourly settlement. Runs whenever the server runs (metering is always on);
 * with BILLING_ENFORCE unset it only records shadow charges. Opt out with
 * BILLING_SCHEDULER=false.
 */
export function startBillingCycleScheduler(intervalMs = 60 * 60 * 1000): void {
  if (schedulerTimer || process.env.BILLING_SCHEDULER === 'false' || process.env.NODE_ENV === 'test') return;
  const tick = () => {
    settleDueOrgs().then(n => {
      if (n > 0) console.log(`[billing] settled cycles for ${n} org(s)`);
    }).catch(err => console.error('[billing] settlement sweep failed:', err));
  };
  setTimeout(tick, 60_000).unref();
  schedulerTimer = setInterval(tick, intervalMs);
  schedulerTimer.unref();
}
