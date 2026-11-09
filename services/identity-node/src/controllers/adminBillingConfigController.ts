import { Response } from 'express';
import { DEFAULT_BILLING_CONFIG, getBillingConfig, validateBillingConfig, BillingConfig } from '../config/billingConfig.js';
import {
  refreshBillingConfig, listConfigHistory, getConfigVersion, saveBillingConfigVersion,
} from '../config/billingConfigStore.js';
import { withTransaction } from '../utils/billingCredit.js';
import { AdminRequest, writeAudit } from './adminController.js';

// Admin-editable billing config — routes/adminBillingConfig.ts.
// Contract (the admin UI is built against exactly this):
//   GET  /admin/billing/config
//   GET  /admin/billing/config/versions/:version
//   PUT  /admin/billing/config  { config, reason, expectedVersion }

export const getBillingConfigAdmin = async (_req: AdminRequest, res: Response) => {
  try {
    const meta = await refreshBillingConfig();
    const history = await listConfigHistory(50);
    res.json({
      active: {
        version: meta.source === 'db' ? meta.version : null,
        config: getBillingConfig(),
        createdAt: meta.source === 'db' ? meta.createdAt : null,
        createdBy: meta.source === 'db' ? meta.createdBy : null,
        reason: meta.source === 'db' ? meta.reason : null,
      },
      source: meta.source,
      defaults: DEFAULT_BILLING_CONFIG,
      history,
    });
  } catch (err) {
    console.error('[billing] getBillingConfigAdmin error:', (err as Error).message);
    res.status(500).json({ error: 'internal_error' });
  }
};

export const getBillingConfigVersionAdmin = async (req: AdminRequest, res: Response) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647) {
    return res.status(404).json({ error: 'not_found' });
  }
  try {
    const row = await getConfigVersion(version);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (err) {
    console.error('[billing] getBillingConfigVersionAdmin error:', (err as Error).message);
    res.status(500).json({ error: 'internal_error' });
  }
};

/** Compact leaf-level diff; tiers are matched by id. Capped so an audit row stays small. */
export function diffConfigs(a: BillingConfig, b: BillingConfig, max = 40): Array<{ path: string; from: unknown; to: unknown }> {
  const out: Array<{ path: string; from: unknown; to: unknown }> = [];
  const push = (path: string, from: unknown, to: unknown) => {
    if (out.length < max && JSON.stringify(from) !== JSON.stringify(to)) out.push({ path, from: from ?? null, to: to ?? null });
  };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === 'tiers') continue;
    push(k, (a as any)[k], (b as any)[k]);
  }
  const ids = new Set([...a.tiers.map(t => t.id), ...b.tiers.map(t => t.id)]);
  for (const id of [...ids].sort((x, y) => x - y)) {
    const ta = a.tiers.find(t => t.id === id) as Record<string, unknown> | undefined;
    const tb = b.tiers.find(t => t.id === id) as Record<string, unknown> | undefined;
    if (!ta || !tb) { push(`tiers[${id}]`, ta ? 'present' : null, tb ? 'present' : null); continue; }
    for (const f of new Set([...Object.keys(ta), ...Object.keys(tb)])) push(`tiers[${id}].${f}`, ta[f], tb[f]);
  }
  return out;
}

export const putBillingConfigAdmin = async (req: AdminRequest, res: Response) => {
  const { config, reason, expectedVersion } = req.body ?? {};
  const details: Array<{ path: string; message: string }> = [];

  const reasonText = typeof reason === 'string' ? reason.trim() : '';
  if (reasonText.length < 3 || reasonText.length > 500) details.push({ path: 'reason', message: 'required, 3–500 characters' });
  if (!(expectedVersion === null || (Number.isInteger(expectedVersion) && expectedVersion >= 1))) {
    details.push({ path: 'expectedVersion', message: 'must be the version you edited (a positive integer) or null when none exists' });
  }
  // The full config is required: filling gaps from the built-in defaults
  // would silently reset prices that only the active config had.
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    for (const k of Object.keys(DEFAULT_BILLING_CONFIG)) {
      if (!(k in config)) details.push({ path: `config.${k}`, message: 'required' });
    }
  }
  let validated: BillingConfig | null = null;
  const v = validateBillingConfig(config);
  if (v.ok) validated = v.config;
  else details.push(...v.details.map(d => ({ path: d.path ? `config.${d.path}` : 'config', message: d.message })));
  if (details.length || !validated) return res.status(400).json({ error: 'invalid_config', details });

  try {
    const out = await withTransaction(async (client) => {
      const r = await saveBillingConfigVersion(client, {
        config: validated!, reason: reasonText, expectedVersion, adminId: req.admin?.id ?? null,
      });
      if (r.status === 'saved') {
        await writeAudit(client, req, {
          action: 'billing.config_update',
          targetType: 'billing_config',
          targetId: String(r.version),
          summary: { old_version: r.previousVersion, new_version: r.version, diff: diffConfigs(r.previous, validated!) },
          reason: reasonText,
        });
      }
      return r;
    });

    if (out.status === 'version_conflict') {
      return res.status(409).json({ error: 'version_conflict', currentVersion: out.currentVersion });
    }
    if (out.status === 'tier_in_use') {
      return res.status(409).json({ error: 'tier_in_use', tierId: out.tierId, orgCount: out.orgCount });
    }
    const meta = await refreshBillingConfig();
    if (meta.version !== out.version) {
      console.error(`[billing] saved billing config v${out.version} but v${meta.version} is active — check the logs above`);
    }
    console.log(`[billing] billing config v${out.version} saved by admin ${req.admin?.username ?? req.admin?.id ?? '?'}: ${reasonText}`);
    res.json({ version: out.version });
  } catch (err) {
    console.error('[billing] putBillingConfigAdmin error:', (err as Error).message);
    res.status(500).json({ error: 'internal_error' });
  }
};
