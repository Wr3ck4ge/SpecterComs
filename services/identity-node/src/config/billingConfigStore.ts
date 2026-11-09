import type { PoolClient } from 'pg';
import { pool } from './db.js';
import {
  BillingConfig, validateBillingConfig, formatConfigIssues, setActiveBillingConfig,
  getEnvBillingConfig, envBillingConfigPresent, getBillingConfig,
} from './billingConfig.js';

// Admin-editable billing config (prices, limits, policy), stored as an
// append-only version history in billing_config_versions (migration 000078).
//
// Precedence: the newest VALID DB version > env (BILLING_CONFIG_JSON / _PATH +
// shortcuts) > built-in defaults. Callers keep the synchronous
// getBillingConfig(); this module keeps it current:
//   - initBillingConfigStore() loads once before the server listens,
//   - saveBillingConfigVersion() refreshes right after its commit,
//   - a timer refreshes every REFRESH_MS so other processes converge.
// A DB row that fails validation (hand-edited, or written by a newer build)
// never crashes anything: it is logged and the previous valid version, then
// env, is used instead.

export const REFRESH_MS = 30_000;

export type ConfigSource = 'db' | 'env' | 'default';

export interface ActiveConfigMeta {
  version: number | null;
  createdAt: string | null;
  createdBy: string | null;
  reason: string | null;
  source: ConfigSource;
}

let meta: ActiveConfigMeta = { version: null, createdAt: null, createdBy: null, reason: null, source: 'default' };
const warnedInvalid = new Set<number>();
let warnedEnvShadowed = false;
let timer: NodeJS.Timeout | null = null;

export function getActiveBillingConfigMeta(): ActiveConfigMeta {
  return meta;
}

function envSource(): ConfigSource {
  return envBillingConfigPresent() ? 'env' : 'default';
}

interface VersionRow { version: number; config: unknown; created_at: Date | string; created_by: string | null; reason: string | null }

function iso(d: Date | string | null): string | null {
  return d == null ? null : new Date(d).toISOString();
}

/** Re-read the DB and install the newest valid version (or fall back to env). Never throws. */
export async function refreshBillingConfig(): Promise<ActiveConfigMeta> {
  let rows: VersionRow[];
  try {
    const res = await pool.query(
      `SELECT version, config, created_at, created_by, reason
       FROM billing_config_versions ORDER BY version DESC LIMIT 20`
    );
    rows = res.rows;
  } catch (err) {
    // Table missing (migration not applied yet) or DB down: keep what we have.
    console.error('[billing] could not read billing_config_versions — keeping the current config:', (err as Error).message);
    return meta;
  }

  for (const row of rows) {
    const r = validateBillingConfig(row.config);
    if (!r.ok) {
      if (!warnedInvalid.has(row.version)) {
        warnedInvalid.add(row.version);
        console.error(`[billing] !!! billing config version ${row.version} in the database is INVALID and is being skipped: ${formatConfigIssues(r.details)}`);
      }
      continue;
    }
    if (envBillingConfigPresent() && !warnedEnvShadowed) {
      warnedEnvShadowed = true;
      console.warn(`[billing] both a database billing config (v${row.version}) and BILLING_CONFIG_* / BILLING_* env overrides are set — the database version wins; env is ignored`);
    }
    setActiveBillingConfig(r.config);
    meta = {
      version: Number(row.version), createdAt: iso(row.created_at), createdBy: row.created_by ?? null,
      reason: row.reason ?? null, source: 'db',
    };
    return meta;
  }

  setActiveBillingConfig(null);
  if (rows.length > 0) console.error('[billing] no valid billing config version in the database — using env/default config');
  meta = { version: null, createdAt: null, createdBy: null, reason: null, source: envSource() };
  return meta;
}

/**
 * Startup: validates env config (throws on an invalid env config — that is an
 * operator error the process must not start with), then loads the DB version
 * and starts the refresh timer.
 */
export async function initBillingConfigStore(): Promise<ActiveConfigMeta> {
  getEnvBillingConfig();
  meta = { ...meta, source: envSource() };
  const m = await refreshBillingConfig();
  if (!timer && process.env.NODE_ENV !== 'test') {
    timer = setInterval(() => { void refreshBillingConfig(); }, REFRESH_MS);
    timer.unref();
  }
  return m;
}

/** Tests only. */
export function resetBillingConfigStoreForTests(): void {
  meta = { version: null, createdAt: null, createdBy: null, reason: null, source: 'default' };
  warnedInvalid.clear();
  warnedEnvShadowed = false;
  setActiveBillingConfig(null);
}

export interface HistoryEntry { version: number; createdAt: string; createdBy: string | null; reason: string | null }

export async function listConfigHistory(limit = 50): Promise<HistoryEntry[]> {
  const res = await pool.query(
    `SELECT version, created_at, created_by, reason FROM billing_config_versions ORDER BY version DESC LIMIT $1`,
    [limit]
  );
  return res.rows.map((r: VersionRow) => ({
    version: Number(r.version), createdAt: iso(r.created_at)!, createdBy: r.created_by ?? null, reason: r.reason ?? null,
  }));
}

export async function getConfigVersion(version: number) {
  const res = await pool.query(
    `SELECT version, config, created_at, created_by, reason FROM billing_config_versions WHERE version = $1`,
    [version]
  );
  const r: VersionRow | undefined = res.rows[0];
  if (!r) return null;
  return { version: Number(r.version), config: r.config, createdAt: iso(r.created_at), createdBy: r.created_by ?? null, reason: r.reason ?? null };
}

/** The billing-relevant fields of each tier, frozen onto a cycle when it starts. */
export interface TierPricing { id: number; name: string; priceCents: number; overageCentsPerGb: number | null; cycleDataLimitBytes: number }

export function pricingSnapshot(cfg: BillingConfig = getBillingConfig()): TierPricing[] {
  return cfg.tiers.map(t => ({
    id: t.id, name: t.name, priceCents: t.priceCents, overageCentsPerGb: t.overageCentsPerGb, cycleDataLimitBytes: t.cycleDataLimitBytes,
  }));
}

export type SaveResult =
  | { status: 'saved'; version: number; previousVersion: number | null; previous: BillingConfig }
  | { status: 'version_conflict'; currentVersion: number | null }
  | { status: 'tier_in_use'; tierId: number; orgCount: number };

/**
 * Append a new version inside the caller's transaction. The caller has
 * already validated `config`. Serialised with a table lock so two admins
 * can't both save "on top of" the same version.
 *
 * Before the new prices activate, every org whose current cycle has no price
 * snapshot yet gets one from the OUTGOING config — so a cycle in progress
 * always settles at the prices in effect when it started (utils/billingCycle.ts).
 */
export async function saveBillingConfigVersion(
  client: PoolClient,
  p: { config: BillingConfig; reason: string; expectedVersion: number | null; adminId: string | null }
): Promise<SaveResult> {
  await client.query('LOCK TABLE billing_config_versions IN EXCLUSIVE MODE');
  const cur = await client.query(`SELECT MAX(version) AS v FROM billing_config_versions`);
  const currentVersion = cur.rows[0]?.v == null ? null : Number(cur.rows[0].v);
  if (currentVersion !== p.expectedVersion) return { status: 'version_conflict', currentVersion };

  // What is live right now (as of the lock), not this process's possibly stale cache.
  await refreshBillingConfig();
  const previous = getBillingConfig();
  const activeVersion = meta.source === 'db' ? meta.version : null;

  // Tier ids are stable keys (organizations.tier); refuse dropping one in use.
  const newIds = p.config.tiers.map(t => t.id);
  const removed = previous.tiers.map(t => t.id).filter(id => !newIds.includes(id));
  if (removed.length > 0) {
    const used = await client.query(
      `SELECT tier, COUNT(*)::int AS n FROM organizations WHERE tier = ANY($1::int[]) GROUP BY tier ORDER BY tier`,
      [removed]
    );
    if (used.rows.length > 0) {
      return { status: 'tier_in_use', tierId: Number(used.rows[0].tier), orgCount: Number(used.rows[0].n) };
    }
  }

  await client.query(
    `UPDATE org_billing SET cycle_pricing = $1::jsonb, cycle_config_version = $2
     WHERE cycle_pricing IS NULL`,
    [JSON.stringify(pricingSnapshot(previous)), activeVersion]
  );

  const ins = await client.query(
    `INSERT INTO billing_config_versions (config, created_by, reason)
     VALUES ($1::jsonb, $2, $3) RETURNING version`,
    [JSON.stringify(p.config), p.adminId, p.reason]
  );
  return { status: 'saved', version: Number(ins.rows[0].version), previousVersion: currentVersion, previous };
}
