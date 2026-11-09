import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

// GET /orgs/:id/billing for the strip's wallet row and pane. One fetch when
// the server cabinet shows the row (or the pane opens), never a poll: the
// pane refetches on window focus / "Check status" only. Results are cached
// per server so switching between the cabinet list and the pane is free.

const STALE_MS = 30_000;
const cache = new Map(); // orgId -> { data, at }

export function useOrgBilling(orgId, { enabled = true } = {}) {
  const cached = orgId ? cache.get(orgId) : null;
  const [state, setState] = useState(() => ({
    data: cached?.data ?? null, error: null, loading: Boolean(orgId && enabled && !cached),
  }));
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!orgId) return null;
    const seq = ++seqRef.current;
    setState((s) => ({ ...s, loading: true }));
    const { data, error } = await api.getOrgBilling(orgId);
    if (seq !== seqRef.current) return null; // a newer fetch (or another server) won
    if (error) { setState((s) => ({ data: s.data, error, loading: false })); return null; }
    cache.set(orgId, { data, at: Date.now() });
    setState({ data, error: null, loading: false });
    return data;
  }, [orgId]);

  useEffect(() => {
    if (!orgId || !enabled) return;
    const c = cache.get(orgId);
    setState({ data: c?.data ?? null, error: null, loading: !c });
    if (!c || Date.now() - c.at > STALE_MS) refresh();
  }, [orgId, enabled, refresh]);

  return { ...state, refresh };
}

// A checkout handed to the browser, per server. Module-level so it survives
// the strip hiding while the user is in the browser and the pane remounting.
const pendingByOrg = new Map(); // orgId -> { id, netCents, startedAt }
export const getPendingFunding = (orgId) => pendingByOrg.get(orgId) || null;
export const setPendingFunding = (orgId, p) => { if (p) pendingByOrg.set(orgId, p); else pendingByOrg.delete(orgId); };

// ── Cycle math ─────────────────────────────────────────────────────────────

/** Calendar-month step in UTC, clamped — mirrors backend utils/billingCycle.ts addMonths. */
function addMonthsUtc(d, n) {
  const day = d.getUTCDate();
  const copy = new Date(d);
  copy.setUTCDate(1);
  copy.setUTCMonth(copy.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(copy.getUTCFullYear(), copy.getUTCMonth() + 1, 0)).getUTCDate();
  copy.setUTCDate(Math.min(day, lastDay));
  return copy;
}

const toDate = (v) => {
  if (v == null) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Server state names: the new `cycle.state` uses 'ok'; the older
// `service.state` uses 'active'.
const normState = (s) => (s === 'active' ? 'ok' : s || 'ok');

/**
 * Normalizes GET /orgs/:id/billing into what the wallet UI shows. Prefers the
 * backend's `cycle` object fields (start, end, daysRemaining, tierName,
 * priceCents, nextCycle, nextChargeAt, nextChargeCents, enforced, state,
 * graceEndsAt, coversCycles); falls back to the older top-level fields
 * (cycle.start_at + one UTC calendar month, tier_name, tier_price_cents,
 * cycle.estimated_cost_cents, enforcement_active, service.*). Fields the
 * backend leaves out for this viewer stay null.
 */
export function deriveBilling(b, now = new Date()) {
  if (!b) return null;
  const c = b.cycle || {};
  const start = toDate(c.start ?? c.start_at);
  const end = toDate(c.end) ?? (start ? addMonthsUtc(start, 1) : null); // exclusive
  const totalMs = start && end ? end - start : 0;
  const elapsedPct = totalMs > 0 ? Math.min(100, Math.max(0, ((now - start) / totalMs) * 100)) : null;
  const daysRemaining = num(c.daysRemaining) ?? (end ? Math.max(0, Math.ceil((end - now) / 86_400_000)) : null);

  const priceCents = num(c.priceCents) ?? num(b.tier_price_cents);
  const next = c.nextCycle || null;
  const nextStart = toDate(next?.start) ?? end;
  const nextPriceCents = num(next?.priceCents);

  const viewerCanSeeBalance = Boolean(b.viewer?.can_view_billing) && b.balance_cents != null;
  const balanceCents = viewerCanSeeBalance ? Number(b.balance_cents) : null;
  const coversCycles = !viewerCanSeeBalance ? null
    : num(c.coversCycles) ?? (priceCents > 0 ? Math.max(0, Math.floor(balanceCents / priceCents)) : null);

  const svc = b.service || {};
  return {
    tierName: c.tierName ?? b.tier_name ?? 'Free',
    priceCents,
    start, end, nextStart, elapsedPct, daysRemaining,
    nextChargeAt: toDate(c.nextChargeAt) ?? end,
    nextChargeCents: num(c.nextChargeCents) ?? num(c.estimated_cost_cents) ?? priceCents,
    nextPriceCents: nextPriceCents != null && nextPriceCents !== priceCents ? nextPriceCents : null,
    nextTierName: next?.tierName ?? null,
    enforced: c.enforced ?? b.enforcement_active ?? false,
    state: normState(c.state ?? svc.state),
    graceEndsAt: toDate(c.graceEndsAt ?? svc.grace_ends_at),
    fallbackTierName: svc.effective_tier_name || 'Free',
    bytesOut: num(c.bytes_out ?? c.bytesOut) ?? 0,
    limitBytes: num(b.tier_limits?.data_bytes),
    balanceCents,
    coversCycles,
    contributors: Array.isArray(b.contributors) ? b.contributors : null,
    ledger: Array.isArray(b.ledger) ? b.ledger : null,
    cycleCharges: Array.isArray(b.cycle_charges) ? b.cycle_charges : null,
    payments: b.payments || {},
    // true when the backend sent the new cycle object (end date is authoritative)
    hasCycleObject: c.end != null,
  };
}
