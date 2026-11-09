import fs from 'fs';
import { z } from 'zod';

// Billing configuration — every pricing/policy decision the owner has to make
// lives here as data, not code (docs/PAYMENT_PLAN_EVALUATION_2026_10_25.md §9).
//
// Source, in order of precedence:
//   1. BILLING_CONFIG_JSON  — inline JSON (handy for docker env files)
//   2. BILLING_CONFIG_PATH  — path to a JSON file
//   3. DEFAULT_BILLING_CONFIG below
// The override is shallow-merged over the defaults, and `tiers` (when given)
// replaces the default tier table wholesale. An invalid override is a startup
// error, never a silent fallback: a typo in a price must not go unnoticed.
//
// Per-field env shortcuts for the operational knobs (BILLING_GRACE_DAYS, etc.)
// win over both, so the grace period can be changed without editing JSON.

const tierSchema = z.object({
  id: z.number().int().min(0),
  name: z.string().min(1),
  maxVideoBitrateKbps: z.number().int().positive(),
  maxResolutionLabel: z.string().min(1),
  cycleDataLimitBytes: z.number().int().nonnegative(),
  priceCents: z.number().int().nonnegative(),
  /** null = no overage billing; usage is throttled at the cap instead */
  overageCentsPerGb: z.number().nonnegative().nullable(),
  /** false = not selectable by owners (e.g. a legacy or hidden tier) */
  selectable: z.boolean().default(true),
});

const configSchema = z.object({
  currency: z.literal('usd'),
  tiers: z.array(tierSchema).min(1),
  /** Tier an org falls back to once its pool has been negative past the grace period. */
  runDryTier: z.number().int().min(0),
  minContributionCents: z.number().int().min(50),
  maxContributionCents: z.number().int().positive(),
  /** Card payments below this are refused — the fixed 30¢ makes tiny card charges uneconomic. */
  cardMinContributionCents: z.number().int().min(50),
  /**
   * absorb       = the member pays exactly the amount; the platform eats the card fee.
   * pass_through = the card fee is added on top (grossed up). Check card-network and
   *                state surcharge rules before enabling — see the evaluation doc §4.
   */
  cardFeeMode: z.enum(['absorb', 'pass_through']),
  cardFeePercent: z.number().min(0).max(10),
  cardFeeFixedCents: z.number().int().min(0),
  /** Days an org may run a negative pool before it drops to runDryTier. */
  graceDays: z.number().min(0),
  /** "Low balance" = balance below this many cycles of the current plan price. */
  lowBalanceCycles: z.number().min(0),
  /** Max open (pending) checkouts per user per org per hour. */
  maxPendingPerUserPerHour: z.number().int().positive(),
  /** Refund a second successful payment for an already-paid contribution automatically. */
  autoRefundDuplicatePayments: z.boolean(),
  /** Refund a payment whose org was dissolved before the payment confirmed. */
  autoRefundOrphanPayments: z.boolean(),
});

export type BillingTier = z.infer<typeof tierSchema>;
export type BillingConfig = z.infer<typeof configSchema>;

// Defaults reproduce the tier table that shipped in utils/orgTiers.ts
// (docs/PRICING_MODEL_2026_05_28.md), with the evaluation's recommended policy
// defaults for everything that was previously hard-coded or missing.
export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  currency: 'usd',
  tiers: [
    { id: 0, name: 'Free Trial',  maxVideoBitrateKbps: 1280,  maxResolutionLabel: '720p',    cycleDataLimitBytes: 30_000_000_000,     priceCents: 0,     overageCentsPerGb: null, selectable: true },
    { id: 1, name: 'Ops Starter', maxVideoBitrateKbps: 4000,  maxResolutionLabel: '1080p',   cycleDataLimitBytes: 1_000_000_000_000,  priceCents: 1900,  overageCentsPerGb: 2.5,  selectable: true },
    { id: 2, name: 'Ops Growth',  maxVideoBitrateKbps: 8000,  maxResolutionLabel: '1440p',   cycleDataLimitBytes: 5_000_000_000_000,  priceCents: 4900,  overageCentsPerGb: 1.8,  selectable: true },
    { id: 3, name: 'Ops Command', maxVideoBitrateKbps: 20000, maxResolutionLabel: '1440p60', cycleDataLimitBytes: 20_000_000_000_000, priceCents: 14900, overageCentsPerGb: 1.2,  selectable: true },
  ],
  runDryTier: 0,
  minContributionCents: 100,
  maxContributionCents: 50_000,
  cardMinContributionCents: 500,
  cardFeeMode: 'absorb',
  cardFeePercent: 2.9,
  cardFeeFixedCents: 30,
  graceDays: 7,
  lowBalanceCycles: 1,
  maxPendingPerUserPerHour: 5,
  autoRefundDuplicatePayments: true,
  autoRefundOrphanPayments: true,
};

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`[billing] ${name} must be a number, got "${raw}"`);
  return n;
}

export interface ConfigIssue { path: string; message: string }

export type ValidationResult =
  | { ok: true; config: BillingConfig }
  | { ok: false; details: ConfigIssue[] };

/**
 * The one validator for every config source (env, file, DB row, admin PUT).
 * `input` is shallow-merged over the defaults first, so a partial override is
 * fine; `tiers`, when given, replaces the default table wholesale.
 */
export function validateBillingConfig(input: unknown): ValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, details: [{ path: '', message: 'config must be a JSON object' }] };
  }
  const merged = { ...DEFAULT_BILLING_CONFIG, ...(input as Record<string, unknown>) };
  const r = configSchema.safeParse(merged);
  if (!r.success) {
    return {
      ok: false,
      details: r.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const parsed = r.data;
  const details: ConfigIssue[] = [];
  const ids = parsed.tiers.map(t => t.id);
  if (new Set(ids).size !== ids.length) details.push({ path: 'tiers', message: 'duplicate tier id' });
  if (!ids.includes(0)) details.push({ path: 'tiers', message: 'must define tier 0 (the default for new orgs)' });
  if (!ids.includes(parsed.runDryTier)) details.push({ path: 'runDryTier', message: `${parsed.runDryTier} is not a defined tier` });
  if (parsed.maxContributionCents < parsed.minContributionCents) {
    details.push({ path: 'maxContributionCents', message: 'must be >= minContributionCents' });
  }
  if (details.length) return { ok: false, details };
  parsed.tiers.sort((a, b) => a.id - b.id);
  return { ok: true, config: parsed };
}

export function formatConfigIssues(details: ConfigIssue[]): string {
  return details.map(d => `${d.path || '(root)'}: ${d.message}`).join('; ');
}

/** Whether any env source (JSON, file, or a per-field shortcut) overrides the defaults. */
export function envBillingConfigPresent(): boolean {
  return ['BILLING_CONFIG_JSON', 'BILLING_CONFIG_PATH', 'BILLING_GRACE_DAYS', 'BILLING_LOW_BALANCE_CYCLES',
    'BILLING_RUN_DRY_TIER', 'BILLING_CARD_FEE_MODE'].some(k => !!process.env[k]);
}

/** The env/file/default config (no DB). Throws a one-line, operator-readable error when invalid. */
export function loadBillingConfig(): BillingConfig {
  let override: Record<string, unknown> = {};
  const source = process.env.BILLING_CONFIG_JSON ? 'BILLING_CONFIG_JSON'
    : process.env.BILLING_CONFIG_PATH ? `BILLING_CONFIG_PATH (${process.env.BILLING_CONFIG_PATH})` : null;
  if (source) {
    try {
      override = JSON.parse(process.env.BILLING_CONFIG_JSON
        ?? fs.readFileSync(process.env.BILLING_CONFIG_PATH!, 'utf8'));
    } catch (err) {
      throw new Error(`[billing] invalid ${source}: ${(err as Error).message}`);
    }
  }

  const merged: Record<string, unknown> = { ...override };
  const envOverrides: Array<[keyof BillingConfig, string]> = [
    ['graceDays', 'BILLING_GRACE_DAYS'],
    ['lowBalanceCycles', 'BILLING_LOW_BALANCE_CYCLES'],
    ['runDryTier', 'BILLING_RUN_DRY_TIER'],
  ];
  for (const [key, env] of envOverrides) {
    const v = envNumber(env);
    if (v !== undefined) merged[key] = v;
  }
  if (process.env.BILLING_CARD_FEE_MODE) merged.cardFeeMode = process.env.BILLING_CARD_FEE_MODE;

  const r = validateBillingConfig(merged);
  if (!r.ok) {
    throw new Error(`[billing] invalid billing config (${source ?? 'env shortcuts'}): ${formatConfigIssues(r.details)}`);
  }
  return r.config;
}

let cached: BillingConfig | null = null;
// Set by config/billingConfigStore.ts when an admin-saved DB version is active.
let active: BillingConfig | null = null;

/** Sync getter used everywhere. Precedence: active DB version > env/file > defaults. */
export function getBillingConfig(): BillingConfig {
  if (active) return active;
  if (!cached) cached = loadBillingConfig();
  return cached;
}

/** The env/file/default config, ignoring any DB version. */
export function getEnvBillingConfig(): BillingConfig {
  if (!cached) cached = loadBillingConfig();
  return cached;
}

/** Store only: install (or with null, clear) the DB-sourced config. Must already be validated. */
export function setActiveBillingConfig(cfg: BillingConfig | null): void {
  active = cfg;
}

/** Tests only: drop the cached config so env changes take effect (also clears a DB-sourced one). */
export function resetBillingConfigCache(): void {
  cached = null;
  active = null;
}

export function getTier(id: number): BillingTier | undefined {
  return getBillingConfig().tiers.find(t => t.id === Number(id));
}

/**
 * Private-beta allowlist: BILLING_BETA_ORGS=<uuid>,<uuid>,… When set, only
 * those orgs can pay (contribute / pay invoices) and only they are subject to
 * BILLING_ENFORCE — everyone else stays on shadow billing and can't be
 * downgraded for not paying a bill they had no way to pay. Unset = no allowlist.
 */
export function betaOrgs(): Set<string> | null {
  const raw = process.env.BILLING_BETA_ORGS;
  if (!raw || !raw.trim()) return null;
  return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

export function orgInBillingScope(orgId: string): boolean {
  const beta = betaOrgs();
  return !beta || beta.has(String(orgId).toLowerCase());
}

/** Whether enforcement applies — globally, or (with orgId) to that org under the beta allowlist. */
export function billingEnforced(orgId?: string): boolean {
  if (process.env.BILLING_ENFORCE !== 'true') return false;
  return orgId === undefined ? true : orgInBillingScope(orgId);
}
