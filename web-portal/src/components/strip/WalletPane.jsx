import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Wallet } from 'lucide-react';
import { Alert, Badge, Button } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { PaneHeader, ToolRow } from './ServerTools';
import { api } from '../../api';
import { openExternal } from '../../utils/openExternal';
import { barColor, fmtBytes, fmtUsd } from '../../utils/format';
import { deriveBilling, getPendingFunding, setPendingFunding, useOrgBilling } from '../../billing/useOrgBilling';

// The server wallet and usage for the strip's server cabinet (StripView's
// ServerCabinet): the billing cycle, data used vs the plan's limit, the
// wallet balance (billing viewers only), and funding through Stripe Checkout
// in the system browser. Same compile flag as BillingPanel, so release
// builds without VITE_BILLING_UI don't show the row at all.

export const WALLET_UI_ENABLED = import.meta.env.VITE_BILLING_UI === 'true';

// ── Formatting ─────────────────────────────────────────────────────────────
const fmtDay = (d) => (d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—');
const fmtFull = (d) => (d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
// The backend's cycle end is exclusive; show the last day that is in the cycle.
const inclusiveEnd = (end) => (end ? new Date(end.getTime() - 1) : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Friendly text for the billing endpoints' error strings (fetchWithAuth passes messages, not codes). */
function friendlyError(msg) {
  const m = String(msg || '');
  if (/not enabled|HTTP 503/i.test(m)) return 'Funding isn’t available on this server yet.';
  if (/too many unfinished|HTTP 429/i.test(m)) return 'You already have a checkout open. Finish or close it in your browser, then try again in a few minutes.';
  if (/^forbidden|HTTP 403/i.test(m)) return 'You don’t have access to this server’s wallet.';
  if (/payment required|declined|HTTP 402/i.test(m)) return 'The payment couldn’t be started. Try another amount or method.';
  if (/network|failed to fetch/i.test(m)) return 'Can’t reach the server. Check your connection and try again.';
  return m || 'Something went wrong.';
}

// Mirrors backend utils/feeMath.ts quoteCharge (display only; same as BillingPanel).
const cardGrossUp = (netCents, feeCfg) => {
  if (feeCfg?.mode !== 'pass_through') return { chargeCents: netCents, feeCents: 0 };
  const pct = (feeCfg?.percent ?? 2.9) / 100;
  const fixed = feeCfg?.fixed_cents ?? 30;
  const charge = Math.ceil((netCents + fixed) / (1 - pct));
  return { chargeCents: charge, feeCents: charge - netCents };
};

/** Row subtitle: the balance at a glance for billing viewers, else the plan. */
function walletSubtitle(v, loading, error) {
  if (!v) return loading ? 'Loading…' : error ? 'Wallet unavailable' : 'Plan, usage and funding';
  const plan = `${v.tierName}${v.priceCents ? ` · ${fmtUsd(v.priceCents)}/cycle` : ''}`;
  const warn = v.state === 'grace' ? ' · overdrawn' : v.state === 'restricted' ? ' · restricted' : v.state === 'low_balance' ? ' · running low' : '';
  if (v.balanceCents != null) return `${fmtUsd(v.balanceCents)} balance · ${plan}${warn}`;
  return `${plan}${warn}`;
}

/** The cabinet's launcher row. Fetches once while the row is shown (cached 30 s). */
export function WalletToolRow({ org, onClick }) {
  const { data, loading, error } = useOrgBilling(org?.id);
  return (
    <ToolRow icon={<Wallet size={16} aria-hidden="true" />} title="Wallet & usage"
      subtitle={walletSubtitle(deriveBilling(data), loading, error)} onClick={onClick} />
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────
function Section({ title, children, className }) {
  return (
    <section className={cx('mx-4 py-2 border-t border-specter-border-divider', className)}>
      {title && <h4 className="pb-1 text-ui-xs font-medium uppercase tracking-wider text-specter-text-subtle">{title}</h4>}
      {children}
    </section>
  );
}

function Meter({ label, value, pct, barClass, title }) {
  const w = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div title={title}>
      <div className="flex items-baseline justify-between gap-2 text-ui-xs">
        <span className="text-specter-text-muted">{label}</span>
        <span className="tabular-nums text-specter-text-main">{value}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-pill bg-white/5 overflow-hidden" role="progressbar"
        aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(w)}>
        <div className={cx('h-full rounded-pill transition-[width] duration-500', barClass)} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

function StateBanner({ v }) {
  if (v.state === 'ok') return null;
  const until = fmtFull(v.graceEndsAt);
  const after = v.fallbackTierName && v.fallbackTierName !== v.tierName ? v.fallbackTierName : 'Free';
  const text = {
    low_balance: `The wallet is running low: it won’t cover the next charge on ${fmtDay(v.nextChargeAt)}. Top it up to keep ${v.tierName} limits.`,
    grace: `The wallet is overdrawn. Everything keeps working as normal${until ? ` until ${until}` : ' for now'}. After that, new streams fall back to ${after} limits until the wallet is topped up. Voice is never cut.`,
    restricted: `The wallet is overdrawn, so new streams use ${after} limits until it is topped up. Voice is never cut and live sessions aren’t interrupted.`,
  }[v.state];
  if (!text) return null;
  return (
    <div className="px-4 pb-2">
      <Alert variant={v.state === 'low_balance' ? 'warning' : 'error'}>
        {text}{!v.enforced && ' Billing isn’t active yet, so nothing changes for now.'}
      </Alert>
    </div>
  );
}

function CycleSection({ v }) {
  const lastDay = inclusiveEnd(v.end);
  const unlimited = !v.limitBytes;
  const dataPct = unlimited ? null : (v.bytesOut / v.limitBytes) * 100;
  // Same 70 % / 90 % thresholds as utils/format barColor (WarRoom, BillingPanel).
  const dataColor = dataPct == null ? null : barColor(dataPct);
  const dataBar = dataPct >= 90 ? 'bg-red-400' : dataPct >= 70 ? 'bg-amber-400' : 'bg-specter-primary-cyan';
  return (
    <Section className="border-t-0 pt-0">
      <p className="text-ui-sm text-specter-text-main">
        <span className="font-medium">Billing cycle:</span> {fmtDay(v.start)} – {fmtDay(lastDay)}
        {v.daysRemaining != null && <span className="text-specter-text-subtle"> · {plural(v.daysRemaining, 'day', 'days')} left</span>}
      </p>
      <p className="text-ui-xs text-specter-text-subtle">
        Plan: <span className="text-specter-text-main">{v.tierName}</span>
        {v.priceCents ? ` · ${fmtUsd(v.priceCents)} per cycle` : ' · no charge'}
      </p>
      <div className="mt-2 space-y-2">
        <Meter label="Time in cycle" value={v.elapsedPct == null ? '—' : `${Math.round(v.elapsedPct)}%`}
          pct={v.elapsedPct} barClass="bg-specter-text-subtle/60"
          title={v.start ? `${fmtFull(v.start)} → ${fmtFull(lastDay)}` : undefined} />
        <Meter label="Stream data"
          value={unlimited ? `${fmtBytes(v.bytesOut)} · no limit` : `${fmtBytes(v.bytesOut)} of ${fmtBytes(v.limitBytes)}`}
          pct={unlimited ? 0 : dataPct} barClass={dataBar}
          title={dataColor ? 'Close to this cycle’s data limit' : undefined} />
      </div>
      <p className="mt-1.5 text-ui-xs text-specter-text-subtle">
        The data limit resets at the start of the next cycle, {fmtDay(v.nextStart)}.
      </p>
      <p className="mt-1 text-ui-xs text-specter-text-main" title={fmtFull(v.nextChargeAt)}>
        {v.enforced
          ? (v.nextChargeCents
            ? <>Next charge: {fmtUsd(v.nextChargeCents)} on {fmtDay(v.nextChargeAt)} from the server wallet</>
            : <>No charge at the end of this cycle</>)
          : <>Billing not active yet; no charge</>}
      </p>
      {v.nextPriceCents != null && (
        <p className="text-ui-xs text-amber-300">
          Plan price changes to {fmtUsd(v.nextPriceCents)}{v.nextTierName && v.nextTierName !== v.tierName ? ` (${v.nextTierName})` : ''} from {fmtDay(v.nextStart)}.
        </p>
      )}
    </Section>
  );
}

function BalanceSection({ v }) {
  if (v.balanceCents == null) return null;
  return (
    <Section title="Wallet">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cx('text-ui-lg font-semibold tabular-nums', v.balanceCents < 0 ? 'text-red-300' : 'text-specter-text-main')}>
          {fmtUsd(v.balanceCents)}
        </span>
        {v.coversCycles != null && v.priceCents > 0 && (
          <span className="text-ui-xs text-specter-text-subtle">covers ~{plural(v.coversCycles, 'cycle', 'cycles')}</span>
        )}
      </div>
      {v.contributors?.length > 0 && (
        <div className="mt-1.5">
          <p className="text-ui-xs text-specter-text-subtle">Top contributors</p>
          <ul className="mt-0.5 space-y-0.5">
            {v.contributors.slice(0, 3).map((c) => (
              <li key={c.callsign} className="flex justify-between gap-2 text-ui-xs">
                <span className="truncate text-specter-text-main">{c.callsign}</span>
                <span className="tabular-nums text-specter-text-muted">{fmtUsd(Number(c.total_cents))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function ActivitySection({ v }) {
  // The ledger has funding and cycle charges together; older servers may only
  // send cycle_charges.
  const rows = v.ledger?.length
    ? v.ledger.slice(0, 5).map((l, i) => ({
      key: `l${i}`, when: new Date(l.created_at), label: l.description || l.kind, cents: Number(l.delta_cents),
    }))
    : (v.cycleCharges || []).slice(0, 4).map((c) => ({
      key: c.cycle_start, when: new Date(c.cycle_start), label: `Cycle charge${c.applied ? '' : ' (not charged)'}`, cents: -Number(c.total_cents),
    }));
  if (!rows.length) return null;
  return (
    <Section title="Recent activity">
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li key={r.key} className="flex items-baseline gap-2 text-ui-xs">
            <span className="shrink-0 w-12 text-specter-text-subtle">{fmtDay(r.when)}</span>
            <span className="flex-1 min-w-0 truncate text-specter-text-muted">{r.label}</span>
            <span className={cx('shrink-0 tabular-nums', r.cents > 0 ? 'text-emerald-300' : 'text-specter-text-main')}>
              {r.cents > 0 ? '+' : r.cents < 0 ? '−' : ''}{fmtUsd(Math.abs(r.cents))}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const PRESETS = [500, 1000, 2500, 5000];

function FundSection({ org, v, onFunded, refreshBilling }) {
  const p = v.payments;
  const [cents, setCents] = useState(1000);
  const [custom, setCustom] = useState('');
  const [method, setMethod] = useState('ach');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(() => getPendingFunding(org.id));
  const [credited, setCredited] = useState(null);
  const [checking, setChecking] = useState(false);

  const minCents = method === 'card'
    ? Math.max(p.card_min_amount_cents ?? 0, p.min_amount_cents ?? 100)
    : (p.min_amount_cents ?? 100);
  const maxCents = p.max_amount_cents ?? Infinity;
  const amount = custom !== '' ? Math.round(parseFloat(custom) * 100) : cents;
  const valid = Number.isFinite(amount) && amount >= minCents && amount <= maxCents;
  const fee = method === 'card' && valid ? cardGrossUp(amount, p.card_fee) : { chargeCents: amount, feeCents: 0 };
  const presets = PRESETS.filter((c) => c <= maxCents);

  const check = useCallback(async () => {
    const pend = getPendingFunding(org.id);
    if (!pend) { await refreshBilling(); return; }
    setChecking(true);
    const [{ data }] = await Promise.all([api.getContribution(org.id, pend.id), refreshBilling()]);
    setChecking(false);
    if (!data) return; // keep showing pending; the next focus tries again
    if (data.status === 'succeeded') {
      setPendingFunding(org.id, null);
      setPending(null);
      setCredited(Number(data.amount_cents ?? pend.netCents));
      onFunded?.();
    } else if (data.status === 'failed' || data.status === 'canceled') {
      setPendingFunding(org.id, null);
      setPending(null);
      setError(data.status === 'canceled' ? 'Checkout was canceled. Nothing was charged.' : 'The payment didn’t go through. Nothing was added to the wallet.');
    }
  }, [org.id, refreshBilling, onFunded]);

  // Back from the browser: the strip regains focus. Only while this pane is
  // mounted, and only when there's a checkout to check on.
  useEffect(() => {
    if (!pending) return undefined;
    const onFocus = () => { check(); };
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVis); };
  }, [pending, check]);
  // Reopened with a checkout outstanding: look once.
  useEffect(() => { if (getPendingFunding(org.id)) check(); }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true); setError(null); setCredited(null);
    const { data, error: err } = await api.contributeToOrg(org.id, { amount_cents: amount, method });
    setBusy(false);
    if (err) { setError(friendlyError(err)); return; }
    if (data?.status === 'succeeded') { // dev provider: credited immediately
      setCredited(Number(data.net_cents ?? amount));
      refreshBilling();
      onFunded?.();
      return;
    }
    if (!data?.redirect_url) { setError('The payment provider didn’t return a checkout page. Try again.'); return; }
    try {
      const opened = await openExternal(data.redirect_url);
      if (!opened) { setError('The checkout link was not a web address, so it was not opened.'); return; }
    } catch (e) {
      setError(`Couldn’t open the browser: ${e?.message || e}`);
      return;
    }
    const pend = { id: data.contribution_id, netCents: Number(data.net_cents ?? amount), startedAt: Date.now() };
    setPendingFunding(org.id, pend);
    setPending(pend);
  };

  const chip = (active) => cx(
    'h-7 px-2.5 rounded-ui-row text-ui-xs border transition-colors', focusRing,
    active ? 'border-specter-primary-cyan bg-specter-primary-cyan/10 text-specter-primary-neon'
      : 'border-specter-border text-specter-text-muted hover:border-specter-border-strong hover:text-specter-text-main',
  );

  if (!p.enabled) {
    return (
      <Section title="Fund server wallet">
        <Button size="sm" disabled full>Funding not available yet</Button>
      </Section>
    );
  }

  return (
    <Section title="Fund server wallet">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Amount">
        {presets.map((c) => (
          <button key={c} type="button" className={chip(custom === '' && cents === c)}
            onClick={() => { setCents(c); setCustom(''); }}>{fmtUsd(c).replace('.00', '')}</button>
        ))}
        <input type="text" aria-label="Custom amount in dollars" placeholder="Other $" inputMode="decimal" value={custom}
          onChange={(e) => setCustom(e.target.value.replace(/[^0-9.]/g, ''))} maxLength={8}
          className={cx(
            'h-7 w-20 px-2 rounded-ui-row text-ui-xs text-specter-text-main placeholder:text-specter-text-subtle bg-specter-bg-deep/60 border',
            'border-specter-border hover:border-specter-border-strong focus:border-specter-primary-cyan focus:outline-none',
          )} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="Payment method">
        <button type="button" className={chip(method === 'ach')} onClick={() => setMethod('ach')}>Bank (ACH) · no fee</button>
        <button type="button" className={chip(method === 'card')} onClick={() => setMethod('card')}>Card</button>
      </div>
      <p className="mt-1 text-ui-xs text-specter-text-subtle">
        {valid
          ? <>Wallet receives {fmtUsd(amount)}{fee.feeCents > 0 ? <> · card fee {fmtUsd(fee.feeCents)} · you pay {fmtUsd(fee.chargeCents)}</> : null}
            {method === 'ach' ? ' · bank transfers take 3–5 business days to clear' : ''}</>
          : <>Enter {fmtUsd(minCents)}{Number.isFinite(maxCents) ? ` to ${fmtUsd(maxCents)}` : ' or more'}{method === 'card' && p.card_min_amount_cents ? ' (card minimum)' : ''}.</>}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={!valid || busy} onClick={submit} icon={<ExternalLink size={14} />}>
          {busy ? 'Opening checkout…' : 'Fund server wallet'}
        </Button>
        {pending && (
          <Button size="sm" variant="secondary" disabled={checking} onClick={check}
            icon={<RefreshCw size={14} className={checking ? 'animate-spin' : undefined} />}>
            {checking ? 'Checking…' : 'Check status'}
          </Button>
        )}
      </div>
      {pending && (
        <p role="status" className="mt-1.5 text-ui-xs text-amber-300">
          Pending: finish the {fmtUsd(pending.netCents)} checkout in your browser. The wallet updates once the payment clears.
        </p>
      )}
      {credited != null && (
        <p role="status" className="mt-1.5 text-ui-xs text-specter-primary-neon">Credited {fmtUsd(credited)} to the server wallet. Thank you!</p>
      )}
      {error && <div className="mt-1.5"><Alert variant="error">{error}</Alert></div>}
    </Section>
  );
}

// ── The pane ───────────────────────────────────────────────────────────────
export function WalletPane({ org, onBack }) {
  const { data, error, loading, refresh } = useOrgBilling(org.id);
  const v = deriveBilling(data);
  return (
    <div className="pb-2">
      <div className="flex items-center justify-between gap-2 pr-3">
        <PaneHeader title={`Wallet · ${org.callsign}`} onBack={onBack} />
        <div className="flex items-center gap-1 pb-1">
          {v?.payments?.mode === 'test' && <Badge variant="warning">TEST MODE</Badge>}
          <button type="button" onClick={refresh} aria-label="Refresh wallet" disabled={loading}
            className={cx('inline-flex h-8 w-8 items-center justify-center rounded-ui-row text-specter-text-subtle hover:bg-white/5 hover:text-specter-text-main disabled:opacity-50', focusRing)}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : undefined} aria-hidden="true" />
          </button>
        </div>
      </div>
      {error && <div className="px-4 pb-2"><Alert variant="error">{friendlyError(error)}</Alert></div>}
      {!v && loading && <p className="px-4 py-2 text-ui-sm text-specter-text-subtle">Loading wallet…</p>}
      {v && (
        <>
          <StateBanner v={v} />
          <CycleSection v={v} />
          <BalanceSection v={v} />
          <FundSection org={org} v={v} refreshBilling={refresh} />
          <ActivitySection v={v} />
        </>
      )}
    </div>
  );
}
