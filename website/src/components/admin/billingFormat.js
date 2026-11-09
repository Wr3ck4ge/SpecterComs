// Pure helpers for the admin Billing and Plans & Pricing sections (no React,
// no fetch) so they can be unit-tested — see website/test/billing-format.test.js.

// ─── Money / units ─────────────────────────────────────────────────────────────

export const usd = (cents) => {
  if (cents === null || cents === undefined || Number.isNaN(Number(cents))) return '—';
  const n = Number(cents);
  return `${n < 0 ? '-' : ''}$${(Math.abs(n) / 100).toFixed(2)}`;
};

/**
 * "12.34" -> 1234, "-5" -> -500. Exact (no float maths): null for anything
 * that is not a plain decimal with at most two places.
 */
export function dollarsToCents(input, { allowNegative = false } = {}) {
  const s = String(input ?? '').trim().replace(/^\$/, '');
  const re = allowNegative ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/;
  if (!re.test(s)) return null;
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

export const centsToDollarsInput = (cents) => (cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2));

/** Decimal GB (10^9 bytes), matching the server's overage maths. */
export const GB = 1_000_000_000;
export const bytesToGbInput = (bytes) => {
  if (bytes === null || bytes === undefined) return '';
  const gb = Number(bytes) / GB;
  return String(Math.round(gb * 1000) / 1000);
};
export function gbToBytes(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const bytes = Math.round(Number(s) * GB);
  return Number.isSafeInteger(bytes) ? bytes : null;
}
export const fmtBytes = (bytes) => {
  const n = Number(bytes || 0);
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${n} B`;
};

/** Idempotency key for one money action (reused on retry, fresh per new action). */
export const newRequestId = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// ─── Billing cycles ────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/** Same month arithmetic as the server's addMonths (UTC, clamps to month end). */
export function addMonthsUtc(d, n) {
  const date = new Date(d);
  const day = date.getUTCDate();
  const r = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

export const utcDay = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * "Nov 3 – Dec 2 (12 days left)". `end` is exclusive (the next cycle's
 * start), so the displayed last day is end − 1 ms, in UTC.
 */
export function formatCycleRange(start, end, now = new Date()) {
  if (!start || !end) return '—';
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '—';
  const left = Math.max(0, Math.ceil((e.getTime() - new Date(now).getTime()) / DAY));
  return `${utcDay(s)} – ${utcDay(e.getTime() - 1)} (${left} day${left === 1 ? '' : 's'} left)`;
}

/** Display range without the countdown (cycle history rows). */
export function formatCycleDates(start, end) {
  if (!start || !end) return '—';
  return `${utcDay(start)} – ${utcDay(new Date(end).getTime() - 1)}`;
}

/**
 * Normalises the per-org cycle view. Prefers the server's `cycle` object
 * (start, end, daysRemaining, tierId, tierName, priceCents, nextCycle,
 * nextChargeAt, nextChargeCents, enforced, state, graceEndsAt, coversCycles);
 * falls back to what older servers return (billing.cycle_start_at + the
 * tier price from the config) so the panel degrades instead of breaking.
 */
export function deriveCycle(detail, config, now = new Date()) {
  if (!detail) return null;
  const c = detail.cycle;
  if (c && c.start && c.end) {
    return {
      start: c.start,
      end: c.end,
      daysRemaining: c.daysRemaining ?? Math.max(0, Math.ceil((new Date(c.end) - new Date(now)) / DAY)),
      tierName: c.tierName ?? detail.org?.tier_name ?? null,
      priceCents: c.priceCents ?? null,
      nextPriceCents: c.nextCycle?.priceCents ?? null,
      nextTierName: c.nextCycle?.tierName ?? tierNameFrom(config, c.nextCycle?.tierId) ?? null,
      nextChargeAt: c.nextChargeAt ?? c.end,
      nextChargeCents: c.nextChargeCents ?? null,
      enforced: c.enforced ?? detail.enforced ?? false,
      state: c.state ?? detail.state ?? null,
      graceEndsAt: c.graceEndsAt ?? detail.grace_ends_at ?? null,
      coversCycles: c.coversCycles ?? null,
      derived: false,
    };
  }
  const startRaw = detail.billing?.cycle_start_at;
  if (!startRaw) return null;
  const end = addMonthsUtc(startRaw, 1);
  const tier = (config?.tiers || []).find((t) => t.id === detail.org?.tier);
  const price = tier ? tier.priceCents : null;
  const balance = detail.billing?.balance_cents;
  return {
    start: startRaw,
    end: end.toISOString(),
    daysRemaining: Math.max(0, Math.ceil((end - new Date(now)) / DAY)),
    tierName: detail.org?.tier_name ?? tier?.name ?? null,
    priceCents: price,
    nextPriceCents: price,
    nextTierName: null,
    nextChargeAt: end.toISOString(),
    nextChargeCents: price,
    enforced: !!detail.enforced,
    state: detail.state ?? null,
    graceEndsAt: detail.grace_ends_at ?? null,
    coversCycles: price && price > 0 && typeof balance === 'number' ? Math.max(0, Math.floor(balance / price)) : null,
    derived: true,
  };
}

const tierNameFrom = (config, id) => (id === undefined || id === null ? null : (config?.tiers || []).find((t) => t.id === id)?.name ?? null);

/** Settled-cycle rows from whichever shape the server sent. */
export function cycleHistory(detail) {
  if (!detail) return [];
  // An empty array from the core is not authoritative while the older
  // cycle_charges rows exist — fall back to those.
  const fromNew = [detail.recentCycles, detail.cycles, detail.settledCycles, detail.recent_cycles, detail.cycle?.history]
    .find((a) => Array.isArray(a) && a.length > 0);
  if (fromNew) {
    return fromNew.map((r) => ({
      start: r.start ?? r.cycle_start, end: r.end ?? r.cycle_end,
      chargeCents: r.chargeCents ?? r.total_cents ?? null, applied: !!r.applied,
      configVersion: r.configVersion ?? r.config_version ?? null,
      tier: r.tierName ?? r.tier ?? null, bytesOut: r.bytesOut ?? r.bytes_out ?? null,
    }));
  }
  return (detail.cycle_charges || []).map((r) => ({
    start: r.cycle_start, end: r.cycle_end, chargeCents: r.total_cents, applied: !!r.applied,
    configVersion: r.config_version ?? null, tier: r.tier, bytesOut: r.bytes_out,
  }));
}

// ─── Plans & pricing: form <-> config ─────────────────────────────────────────

export const POLICY_FIELDS = [
  { key: 'cardFeeMode',              label: 'Card fee mode',            kind: 'enum', options: ['absorb', 'pass_through'],
    help: 'absorb: the member pays exactly the amount and the platform pays the card fee. pass_through: the fee is added on top (check surcharge rules first).' },
  { key: 'minContributionCents',     label: 'Minimum contribution',     kind: 'usd', min: 50, help: 'Smallest amount a member can add to a wallet (at least $0.50).' },
  { key: 'maxContributionCents',     label: 'Maximum contribution',     kind: 'usd', min: 1,  help: 'Largest single contribution. Must be at least the minimum.' },
  { key: 'cardMinContributionCents', label: 'Card minimum',             kind: 'usd', min: 50, help: 'Card payments below this are refused (the fixed card fee makes tiny charges uneconomic).' },
  { key: 'cardFeePercent',           label: 'Card fee %',               kind: 'number', min: 0, max: 10, unit: '%', help: 'Provider percentage fee used for display and pass-through.' },
  { key: 'cardFeeFixedCents',        label: 'Card fee fixed',           kind: 'int', min: 0, unit: '¢', help: 'Provider fixed fee per card charge, in cents.' },
  { key: 'graceDays',                label: 'Grace period',             kind: 'number', min: 0, unit: 'days', help: 'Days a server may run a negative balance before it drops to the run-dry plan.' },
  { key: 'lowBalanceCycles',         label: 'Low-balance warning',      kind: 'number', min: 0, unit: 'cycles', help: 'Warn when the balance covers fewer than this many cycles of the current plan.' },
  { key: 'runDryTier',               label: 'Run-dry plan',             kind: 'tier', help: 'Plan a server falls back to once its grace period ends.' },
  { key: 'maxPendingPerUserPerHour', label: 'Open checkouts per hour',  kind: 'int', min: 1, help: 'Max pending checkouts per member per server per hour.' },
  { key: 'autoRefundDuplicatePayments', label: 'Auto-refund duplicates', kind: 'bool', help: 'Refund a second successful payment for an already-paid contribution.' },
  { key: 'autoRefundOrphanPayments',    label: 'Auto-refund orphans',    kind: 'bool', help: 'Refund a payment whose server was dissolved before it confirmed.' },
];

export const TIER_FIELDS = ['name', 'priceCents', 'cycleDataLimitBytes', 'maxVideoBitrateKbps', 'maxResolutionLabel', 'overageCentsPerGb', 'selectable'];

export function configToForm(config) {
  const cfg = config || {};
  const policy = {};
  for (const f of POLICY_FIELDS) {
    const v = cfg[f.key];
    policy[f.key] = f.kind === 'usd' ? centsToDollarsInput(v)
      : f.kind === 'bool' ? !!v
      : f.kind === 'enum' ? (v ?? f.options[0])
      : v === undefined || v === null ? '' : String(v);
  }
  const known = new Set(['tiers', ...POLICY_FIELDS.map((f) => f.key)]);
  const extra = Object.fromEntries(Object.entries(cfg).filter(([k]) => !known.has(k)));
  return {
    tiers: (cfg.tiers || []).map((t) => ({
      id: t.id,
      name: t.name ?? '',
      priceUsd: centsToDollarsInput(t.priceCents),
      dataGb: bytesToGbInput(t.cycleDataLimitBytes),
      bitrate: t.maxVideoBitrateKbps === undefined ? '' : String(t.maxVideoBitrateKbps),
      resolution: t.maxResolutionLabel ?? '',
      overageOn: t.overageCentsPerGb !== null && t.overageCentsPerGb !== undefined,
      overage: t.overageCentsPerGb === null || t.overageCentsPerGb === undefined ? '' : String(t.overageCentsPerGb),
      selectable: t.selectable !== false,
    })),
    policy,
    extra,
  };
}

export const nextTierId = (form) => (form.tiers.length ? Math.max(...form.tiers.map((t) => Number(t.id) || 0)) + 1 : 0);

const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s ?? '').trim());
const isInt = (s) => /^\d+$/.test(String(s ?? '').trim());

/**
 * Converts the editor form to a config and validates it with the same rules
 * as the server's zod schema + loadBillingConfig checks. Returns
 * { config, errors } where errors maps a path ("tiers.1.priceCents",
 * "graceDays") to a message.
 */
export function formToConfig(form) {
  const errors = {};
  const err = (path, msg) => { if (!errors[path]) errors[path] = msg; };

  const tiers = form.tiers.map((t, i) => {
    const p = `tiers.${i}`;
    const priceCents = dollarsToCents(t.priceUsd);
    if (priceCents === null) err(`${p}.priceCents`, 'Enter a price in dollars, e.g. 19.00');
    const bytes = gbToBytes(t.dataGb);
    if (bytes === null) err(`${p}.cycleDataLimitBytes`, 'Enter a data limit in GB (0 or more)');
    if (!isInt(t.bitrate) || Number(t.bitrate) <= 0) err(`${p}.maxVideoBitrateKbps`, 'Whole kbps above 0');
    if (!String(t.name).trim()) err(`${p}.name`, 'Required');
    if (!String(t.resolution).trim()) err(`${p}.maxResolutionLabel`, 'Required');
    let overage = null;
    if (t.overageOn) {
      if (!isNum(t.overage) || Number(t.overage) < 0) err(`${p}.overageCentsPerGb`, '¢/GB, 0 or more');
      else overage = Number(t.overage);
    }
    if (!Number.isInteger(Number(t.id)) || Number(t.id) < 0) err(`${p}.id`, 'Whole number, 0 or more');
    return {
      id: Number(t.id),
      name: String(t.name).trim(),
      maxVideoBitrateKbps: Number(t.bitrate),
      maxResolutionLabel: String(t.resolution).trim(),
      cycleDataLimitBytes: bytes,
      priceCents,
      overageCentsPerGb: overage,
      selectable: !!t.selectable,
    };
  });

  if (tiers.length === 0) err('tiers', 'At least one plan is required');
  const ids = tiers.map((t) => t.id);
  ids.forEach((id, i) => { if (ids.indexOf(id) !== i) err(`tiers.${i}.id`, `Duplicate plan id ${id}`); });
  if (!ids.includes(0)) err('tiers', 'Plan 0 (the default for new servers) must exist');

  const config = { ...form.extra, tiers };
  for (const f of POLICY_FIELDS) {
    const raw = form.policy[f.key];
    if (f.kind === 'bool') { config[f.key] = !!raw; continue; }
    if (f.kind === 'enum') {
      if (!f.options.includes(raw)) err(f.key, `One of ${f.options.join(', ')}`);
      config[f.key] = raw;
      continue;
    }
    if (f.kind === 'usd') {
      const c = dollarsToCents(raw);
      if (c === null) err(f.key, 'Enter dollars, e.g. 5.00');
      else if (f.min !== undefined && c < f.min) err(f.key, `At least ${usd(f.min)}`);
      config[f.key] = c;
      continue;
    }
    if (f.kind === 'tier') {
      if (!isInt(raw)) err(f.key, 'Pick a plan');
      else if (!ids.includes(Number(raw))) err(f.key, 'Must be one of the plans above');
      config[f.key] = Number(raw);
      continue;
    }
    const intOnly = f.kind === 'int';
    if (intOnly ? !isInt(raw) : !isNum(raw)) { err(f.key, intOnly ? 'Whole number' : 'Number'); config[f.key] = null; continue; }
    const n = Number(raw);
    if (f.min !== undefined && n < f.min) err(f.key, `At least ${f.min}`);
    if (f.max !== undefined && n > f.max) err(f.key, `At most ${f.max}`);
    config[f.key] = n;
  }
  if (Number.isInteger(config.minContributionCents) && Number.isInteger(config.maxContributionCents)
      && config.maxContributionCents < config.minContributionCents) {
    err('maxContributionCents', 'Must be at least the minimum contribution');
  }
  if (config.currency === undefined) config.currency = 'usd';
  return { config, errors };
}

/** Server 400 details [{path, message}] -> { "tiers.1.priceCents": message }. */
export function mapServerErrors(details) {
  const out = {};
  for (const d of Array.isArray(details) ? details : []) {
    const path = Array.isArray(d.path) ? d.path.join('.')
      : String(d.path ?? '').replace(/\[(\d+)\]/g, '.$1').replace(/^\./, '');
    if (!out[path || '_']) out[path || '_'] = d.message || 'Invalid';
  }
  return out;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

const POLICY_LABEL = Object.fromEntries(POLICY_FIELDS.map((f) => [f.key, f.label]));
const TIER_LABEL = {
  name: 'name', priceCents: 'price', cycleDataLimitBytes: 'data limit', maxVideoBitrateKbps: 'bitrate',
  maxResolutionLabel: 'resolution', overageCentsPerGb: 'overage', selectable: 'selectable',
};

function show(key, v) {
  if (v === undefined) return '—';
  if (v === null) return key === 'overageCentsPerGb' ? 'off (throttle)' : 'null';
  if (/Cents$/.test(key) && key !== 'cardFeeFixedCents' && key !== 'overageCentsPerGb') return usd(v);
  if (key === 'overageCentsPerGb') return `${v}¢/GB`;
  if (key === 'cycleDataLimitBytes') return `${bytesToGbInput(v)} GB`;
  if (key === 'maxVideoBitrateKbps') return `${v} kbps`;
  return String(v);
}

/** [{ label, from, to, kind: 'price'|'limit'|'policy'|'added'|'removed' }] */
export function diffConfigs(before, after) {
  const rows = [];
  const a = before || {};
  const b = after || {};
  const byId = (cfg) => new Map((cfg.tiers || []).map((t) => [t.id, t]));
  const ta = byId(a);
  const tb = byId(b);
  const allIds = [...new Set([...ta.keys(), ...tb.keys()])].sort((x, y) => x - y);
  for (const id of allIds) {
    const x = ta.get(id);
    const y = tb.get(id);
    if (!x) { rows.push({ label: `Plan ${id} (${y.name})`, from: '—', to: `added at ${usd(y.priceCents)}`, kind: 'added' }); continue; }
    if (!y) { rows.push({ label: `Plan ${id} (${x.name})`, from: 'present', to: 'removed', kind: 'removed' }); continue; }
    for (const k of TIER_FIELDS) {
      const vx = k === 'selectable' ? x[k] !== false : x[k];
      const vy = k === 'selectable' ? y[k] !== false : y[k];
      if (JSON.stringify(vx ?? null) !== JSON.stringify(vy ?? null)) {
        rows.push({ label: `Plan ${id} (${y.name}) · ${TIER_LABEL[k]}`, from: show(k, vx), to: show(k, vy),
                    kind: k === 'priceCents' || k === 'overageCentsPerGb' ? 'price' : 'limit' });
      }
    }
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'tiers').sort();
  for (const k of keys) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) {
      rows.push({ label: POLICY_LABEL[k] ?? k, from: show(k, a[k]), to: show(k, b[k]), kind: 'policy' });
    }
  }
  return rows;
}
