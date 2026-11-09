import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { barColor, fmtBytes, fmtUsd, fmtDateTime } from '../utils/format';
import { isTauri } from '../auth/tokenStore';
import { billingErrorMessage } from './billingErrors';

export const BILLING_UI_ENABLED = import.meta.env.VITE_BILLING_UI === 'true';

// Checkout must open in the user's real browser (address bar, saved cards,
// password manager) — inside the Tauri webview window.open goes nowhere useful.
// The main window's opener permission is limited to Stripe Checkout
// (src-tauri/capabilities/billing.json), so refuse anything else up front
// instead of failing inside the plugin.
const CHECKOUT_URL_RE = /^https:\/\/checkout\.stripe\.com\//;
async function openCheckout(url) {
  if (isTauri()) {
    if (!CHECKOUT_URL_RE.test(url)) throw new Error('unexpected checkout address');
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

// Mirrors backend utils/feeMath.ts quoteCharge — display only; the server is
// authoritative. In 'absorb' mode (the default) card payers pay no extra fee.
const cardGrossUp = (netCents, feeCfg) => {
  if (feeCfg?.mode !== 'pass_through') return { chargeCents: netCents, feeCents: 0 };
  const pct = (feeCfg?.percent ?? 2.9) / 100;
  const fixed = feeCfg?.fixed_cents ?? 30;
  const charge = Math.ceil((netCents + fixed) / (1 - pct));
  return { chargeCents: charge, feeCents: charge - netCents };
};

const STATUS_COLORS = {
  succeeded: '#4ade80',
  pending:   '#fbbf24',
  failed:    '#f87171',
  canceled:  '#6b7280',
  refunded:  '#a78bfa',
  disputed:  '#f97316',
};

// Server-computed run-dry state (utils/billingCycle.ts). Only shown when
// something needs a member's attention.
function ServiceBanner({ service, enforcement }) {
  if (!service || service.state === 'active') return null;
  const until = service.grace_ends_at ? fmtDateTime(service.grace_ends_at) : null;
  const msg = {
    low_balance: 'Wallet is running low — less than one month of the current plan left.',
    grace: `Wallet is overdrawn. Service continues unchanged until ${until}; top up to avoid reduced quality.`,
    restricted: `Wallet is overdrawn. New connections use ${service.effective_tier_name} limits until it is topped up. Voice is never cut and live sessions are not interrupted.`,
  }[service.state];
  if (!msg) return null;
  const color = service.state === 'low_balance' ? '#fbbf24' : '#f97316';
  return (
    <div style={{ fontSize: 10, color, border: `1px solid ${color}55`, background: `${color}12`, borderRadius: 4, padding: '7px 10px', marginBottom: 12 }}>
      {msg}{!enforcement && ' (Billing enforcement is off — informational only.)'}
    </div>
  );
}

// Checkout happens in the system browser, so the app learns the outcome only
// by asking again: whenever the window regains focus or becomes visible, and
// (while `active`) on a slow timer for windows that never get focus.
function useRefetchOnReturn(refetch, { active = true, intervalMs = 0, events = true } = {}) {
  const ref = useRef(refetch);
  ref.current = refetch;
  useEffect(() => {
    if (!active) return undefined;
    const run = () => { if (document.visibilityState !== 'hidden') ref.current(); };
    if (events) {
      window.addEventListener('focus', run);
      document.addEventListener('visibilitychange', run);
    }
    // The timer ignores visibility: the main window may be the hidden engine.
    const t = intervalMs > 0 ? setInterval(() => ref.current(), intervalMs) : null;
    return () => {
      if (events) {
        window.removeEventListener('focus', run);
        document.removeEventListener('visibilitychange', run);
      }
      if (t) clearInterval(t);
    };
  }, [active, intervalMs, events]);
}

const SETTLED = ['succeeded', 'failed', 'canceled', 'refunded'];
const CHECKOUT_WATCH_MS = 30 * 60 * 1000; // stop the timer after half an hour; focus still refetches

const label = { fontSize: 9, color: '#0e7490', letterSpacing: '0.12em', fontFamily: 'monospace' };
const mono  = { fontFamily: 'monospace' };

function StatusBadge({ status }) {
  return (
    <span style={{
      fontSize: 9, fontFamily: 'monospace', letterSpacing: '0.08em',
      color: STATUS_COLORS[status] || '#6b7280',
      border: `1px solid ${STATUS_COLORS[status] || '#6b7280'}44`,
      borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase',
    }}>
      {status}
    </span>
  );
}

export default function BillingPanel({ orgId, orgName, billing, onClose, onFunded }) {
  const [tab, setTab] = useState('wallet'); // 'wallet' | 'usage' | 'invoices'
  const [amount, setAmount] = useState('10.00');
  const [method, setMethod] = useState('ach');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  // The checkout opened in the browser: { id, openedAt } until it settles.
  const [watching, setWatching] = useState(null);

  const viewer = billing?.viewer || {};
  const payments = billing?.payments || {};
  const canSeeHistory = viewer.can_view_billing || viewer.is_contributor;
  const fundingOpen = payments.enabled === true;

  const loadHistory = useCallback(() => {
    if (!canSeeHistory) return;
    api.getOrgBillingTransactions(orgId).then(({ data, error }) => {
      if (data) { setHistory(data); setHistoryError(null); }
      else setHistoryError(error || 'Failed to load history');
    });
  }, [orgId, canSeeHistory]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Back from the browser: refresh the wallet (balance, banner, payments
  // config) and history, and settle the watched checkout's status line.
  // `full` (focus/visibility) also reloads the wallet; the timer only asks
  // about the watched contribution, since GET /billing runs a settlement pass.
  const refreshAfterCheckout = useCallback(async (full = true) => {
    if (full) { loadHistory(); onFunded?.(); }
    if (!watching) return;
    const { data } = await api.getContribution(orgId, watching.id);
    if (!data || !SETTLED.includes(data.status)) {
      // Pending: checkout still open, or an ACH transfer in flight (days).
      if (Date.now() - watching.openedAt > CHECKOUT_WATCH_MS) setWatching(null);
      return;
    }
    setWatching(null);
    if (!full) { loadHistory(); onFunded?.(); }
    const msg = {
      succeeded: `Payment confirmed — ${fmtUsd(data.amount_cents)} added to the pool.`,
      failed:    `Payment failed — the pool was not credited.${data.last_error ? ` (${data.last_error})` : ''}`,
      canceled:  'Checkout was closed without a payment.',
      refunded:  'This payment was refunded.',
    }[data.status];
    setResult({ ...data, message: msg, tone: data.status === 'succeeded' ? 'ok' : 'muted' });
  }, [orgId, watching, loadHistory, onFunded]);

  useRefetchOnReturn(refreshAfterCheckout, { active: true });
  useRefetchOnReturn(() => refreshAfterCheckout(false), { active: Boolean(watching), intervalMs: 8000, events: false });

  const netCents = Math.round(parseFloat(amount || '0') * 100);
  const minCents = method === 'card'
    ? Math.max(payments.card_min_amount_cents ?? 0, payments.min_amount_cents ?? 100)
    : (payments.min_amount_cents ?? 100);
  const maxCents = payments.max_amount_cents ?? Infinity;
  const validAmount = Number.isFinite(netCents) && netCents >= minCents && netCents <= maxCents;
  const fee = method === 'card' && validAmount ? cardGrossUp(netCents, payments.card_fee) : { chargeCents: netCents, feeCents: 0 };
  const canSubmit = validAmount && !submitting && fundingOpen;

  const amountHint = !Number.isFinite(netCents) || netCents <= 0 ? null
    : netCents < minCents
      ? (method === 'card' && netCents >= (payments.min_amount_cents ?? 100)
          ? `Card payments start at ${fmtUsd(minCents)} — use a bank transfer for smaller amounts.`
          : `Minimum is ${fmtUsd(minCents)}.`)
      : netCents > maxCents ? `Maximum is ${fmtUsd(maxCents)} per payment.` : null;

  const submit = async () => {
    if (!validAmount || submitting || !fundingOpen) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    const { data, error } = await api.contributeToOrg(orgId, { amount_cents: netCents, method });
    setSubmitting(false);
    if (error) {
      setError(billingErrorMessage(error));
      // 503 (payments off / not in beta): the cached payments config is stale.
      onFunded?.();
      return;
    }
    if (data.redirect_url) {
      try {
        await openCheckout(data.redirect_url);
      } catch (err) {
        setError(`Couldn't open the browser: ${err?.message || err}`);
        return;
      }
      setWatching({ id: data.contribution_id, openedAt: Date.now() });
      const charge = data.charge_cents > data.net_cents ? ` You'll be charged ${fmtUsd(data.charge_cents)}.` : '';
      setResult({
        ...data,
        message: method === 'ach'
          ? `Complete checkout in your browser.${charge} Bank transfers take 3-5 business days to clear; the pool is credited then.`
          : `Complete checkout in your browser.${charge} The balance updates once Stripe confirms the payment.`,
      });
    } else {
      setResult({ ...data, message: 'Contribution recorded.', tone: 'ok' });
      loadHistory();
      onFunded?.();
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(2,8,16,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 440, maxHeight: '80vh', overflowY: 'auto',
          backdropFilter: 'blur(18px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.2)',
          background: 'linear-gradient(180deg, rgba(4,12,23,0.55), rgba(2,8,16,0.45))',
          border: '1px solid rgba(56,189,248,0.28)', borderRadius: 6,
          boxShadow: '0 0 0 1px rgba(34,211,238,0.12), 0 0 36px rgba(34,211,238,0.18), 0 24px 64px rgba(0,0,0,0.4)',
          padding: 16,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ ...label, fontSize: 11, color: '#22d3ee' }}>
            SERVER WALLET — {orgName?.toUpperCase()}
            {payments.mode === 'test' && (
              <span style={{ marginLeft: 8, color: '#fbbf24', border: '1px solid #fbbf2466', borderRadius: 3, padding: '0 4px' }}>TEST MODE</span>
            )}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: '#0e7490', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
          >✕</button>
        </div>

        {/* Tab switch */}
        <div className="flex items-center gap-3 border-b border-white/10 pb-1" style={{ marginBottom: 12 }}>
          {[['wallet', 'WALLET'], ['usage', 'USAGE'], ['invoices', 'INVOICES']].map(([val, lbl]) => (
            <button
              key={val}
              onClick={() => setTab(val)}
              style={{
                fontSize: 11, letterSpacing: '0.2em', paddingBottom: 4, background: 'none', border: 'none', cursor: 'pointer',
                color: tab === val ? '#22d3ee' : '#64748b',
                borderBottom: tab === val ? '2px solid #22d3ee' : '2px solid transparent',
              }}
            >
              {lbl}
            </button>
          ))}
        </div>

        {tab === 'usage' && <UsagePanel orgId={orgId} tierLimits={billing?.tier_limits} />}
        {tab === 'invoices' && <InvoicesPanel orgId={orgId} cardFeeCfg={payments.card_fee} />}

        {tab === 'wallet' && (
        <>
        <ServiceBanner service={billing?.service} enforcement={billing?.enforcement_active} />

        {/* Balance — authority only */}
        {viewer.can_view_billing && (
          <div style={{ border: '1px solid #0e2233', borderRadius: 4, padding: '10px 12px', marginBottom: 12, background: '#030a13' }}>
            <div style={label}>POOL BALANCE</div>
            <div style={{ ...mono, fontSize: 22, color: '#4ade80', marginTop: 2 }}>{fmtUsd(billing.balance_cents ?? 0)}</div>
            {billing.cycle?.estimated_cost_cents != null && (
              <div style={{ ...mono, fontSize: 10, color: '#0e7490', marginTop: 2 }}>
                est. cycle cost {fmtUsd(billing.cycle.estimated_cost_cents)}
              </div>
            )}
            {billing.cycle_charges?.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {billing.cycle_charges.slice(0, 3).map(c => (
                  <div key={c.cycle_start} style={{ ...mono, fontSize: 9, color: '#64748b', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{new Date(c.cycle_start).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} cycle</span>
                    <span>{fmtUsd(c.total_cents)}{!c.applied && c.total_cents > 0 && ' (not charged)'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Fund form */}
        <div style={{ border: '1px solid #0e2233', borderRadius: 4, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ ...label, marginBottom: 8 }}>FUND POOL</div>

          {!fundingOpen && (
            <div style={{ fontSize: 10, color: '#fbbf24', marginBottom: 10 }}>
              Funding isn't open for this server yet. Usage is still tracked; nothing is charged.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: amountHint ? 4 : 10 }}>
            <span style={{ ...mono, color: '#22d3ee', fontSize: 14 }}>$</span>
            <input
              type="number" min="1" step="0.01" value={amount}
              onChange={e => setAmount(e.target.value)}
              style={{
                flex: 1, background: '#030a13', border: '1px solid #0e2233', borderRadius: 4,
                color: '#e5e7eb', padding: '6px 8px', fontSize: 14, ...mono, outline: 'none',
              }}
            />
          </div>
          {amountHint && <div style={{ fontSize: 9, color: '#fbbf24', marginBottom: 10 }}>{amountHint}</div>}

          {/* Method selector */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {[
              { id: 'ach',  title: 'Bank transfer (ACH)', note: 'No fee — may take 3-5 business days to clear' },
              {
                id: 'card', title: 'Credit / debit card',
                note: [
                  payments.card_fee?.mode === 'pass_through'
                    ? (validAmount ? `Includes ${fmtUsd(cardGrossUp(netCents, payments.card_fee).feeCents)} processing fee` : 'Includes processing fee')
                    : 'No fee — clears instantly',
                  payments.card_min_amount_cents ? `minimum ${fmtUsd(payments.card_min_amount_cents)}` : null,
                ].filter(Boolean).join(' · '),
              },
            ].map(opt => (
              <button
                key={opt.id}
                onClick={() => setMethod(opt.id)}
                style={{
                  textAlign: 'left', cursor: 'pointer', borderRadius: 4, padding: '7px 10px',
                  background: method === opt.id ? '#06202e' : 'transparent',
                  border: `1px solid ${method === opt.id ? '#0891b2' : '#0e2233'}`,
                }}
              >
                <div style={{ fontSize: 11, color: method === opt.id ? '#22d3ee' : '#9ca3af' }}>
                  {opt.title}{opt.id === 'ach' && <span style={{ ...label, marginLeft: 6 }}>DEFAULT</span>}
                </div>
                <div style={{ fontSize: 9, color: '#0e7490', marginTop: 1 }}>{opt.note}</div>
              </button>
            ))}
          </div>

          {/* Charge summary */}
          {validAmount && (
            <div style={{ ...mono, fontSize: 10, color: '#9ca3af', marginBottom: 10 }}>
              Pool receives {fmtUsd(netCents)}
              {fee.feeCents > 0 && <> · fee {fmtUsd(fee.feeCents)} · you pay <span style={{ color: '#22d3ee' }}>{fmtUsd(fee.chargeCents)}</span></>}
            </div>
          )}

          <button
            onClick={submit}
            disabled={!canSubmit}
            style={{
              width: '100%', padding: '8px 0', borderRadius: 4, cursor: canSubmit ? 'pointer' : 'not-allowed',
              background: canSubmit ? '#0891b2' : '#0e2233', border: 'none',
              color: canSubmit ? '#030a13' : '#4b5563', fontSize: 12, fontWeight: 'bold', letterSpacing: '0.1em',
            }}
          >
            {submitting ? 'PROCESSING…' : 'FUND POOL'}
          </button>

          {error && <div style={{ fontSize: 10, color: '#f87171', marginTop: 8 }}>{error}</div>}
          {result && (
            <div style={{ fontSize: 10, color: result.tone === 'ok' ? '#4ade80' : result.tone === 'muted' ? '#9ca3af' : '#fbbf24', marginTop: 8 }}>
              {result.message} {result.status === 'pending' && <StatusBadge status="pending" />}
            </div>
          )}
        </div>

        {/* Org transaction history */}
        <div style={{ border: '1px solid #0e2233', borderRadius: 4, padding: '10px 12px' }}>
          <div style={{ ...label, marginBottom: 8 }}>TRANSACTION HISTORY</div>
          {!canSeeHistory ? (
            <div style={{ fontSize: 10, color: '#6b7280' }}>Visible to contributors and billing managers.</div>
          ) : historyError ? (
            <div style={{ fontSize: 10, color: '#f87171' }}>{historyError}</div>
          ) : !history ? (
            <div style={{ fontSize: 10, color: '#6b7280' }}>Loading…</div>
          ) : history.contributions.length === 0 ? (
            <div style={{ fontSize: 10, color: '#6b7280' }}>No contributions yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {history.contributions.map(tx => (
                <div key={tx.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 11, color: '#e5e7eb' }}>{tx.callsign}</span>
                    <span style={{ ...mono, fontSize: 9, color: '#0e7490', marginLeft: 6 }}>
                      {tx.payment_method.toUpperCase()} · {fmtDateTime(tx.created_at)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <span style={{ ...mono, fontSize: 11, color: '#4ade80' }}>+{fmtUsd(tx.amount_cents)}</span>
                    <StatusBadge status={tx.dispute_status === 'open' || tx.dispute_status === 'lost' ? 'disputed' : tx.status} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </>
        )}
      </div>
    </div>
  );
}

function InvoiceRow({ orgId, invoice, cardFeeCfg, onPaid }) {
  const [method, setMethod] = useState('ach');
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // set once a redirect is opened, for the "come back and pay again" note

  const fee = method === 'card' ? cardGrossUp(invoice.amount_cents, cardFeeCfg) : { chargeCents: invoice.amount_cents, feeCents: 0 };

  const pay = async () => {
    if (paying) return;
    setPaying(true); setError(null);
    const { data, error } = await api.payOrgInvoice(orgId, invoice.id, { method });
    setPaying(false);
    if (error) { setError(billingErrorMessage(error)); return; }
    if (data.redirect_url) {
      try {
        await openCheckout(data.redirect_url);
      } catch (err) {
        setError(`Couldn't open the browser: ${err?.message || err}`);
        return;
      }
      setPending(true);
    } else {
      onPaid?.();
    }
  };

  return (
    <div style={{ border: '1px solid #0e2233', borderRadius: 4, padding: '10px 12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
        <div style={{ minWidth: 0 }}>
          {invoice.invoice_reason && <div style={{ fontSize: 11, color: '#e5e7eb' }}>{invoice.invoice_reason}</div>}
          <div style={{ ...mono, fontSize: 9, color: '#0e7490', marginTop: 1 }}>
            {invoice.external_invoice_ref && <>#{invoice.external_invoice_ref} · </>}{fmtDateTime(invoice.created_at)}
          </div>
        </div>
        <span style={{ ...mono, fontSize: 13, color: '#e5e7eb', flexShrink: 0 }}>{fmtUsd(invoice.amount_cents)}</span>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {['ach', 'card'].map(m => (
          <button
            key={m}
            onClick={() => setMethod(m)}
            style={{
              fontSize: 10, padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
              background: method === m ? '#06202e' : 'transparent',
              border: `1px solid ${method === m ? '#0891b2' : '#0e2233'}`,
              color: method === m ? '#22d3ee' : '#9ca3af',
            }}
          >
            {m === 'ach' ? 'BANK (ACH)' : 'CARD'}
          </button>
        ))}
        {fee.feeCents > 0 && (
          <span style={{ ...mono, fontSize: 9, color: '#0e7490', alignSelf: 'center' }}>
            + {fmtUsd(fee.feeCents)} fee = {fmtUsd(fee.chargeCents)}
          </span>
        )}
      </div>

      <button
        onClick={pay}
        disabled={paying}
        style={{
          width: '100%', padding: '6px 0', borderRadius: 4, cursor: 'pointer',
          background: '#0891b2', border: 'none', color: '#030a13',
          fontSize: 11, fontWeight: 'bold', letterSpacing: '0.1em', opacity: paying ? 0.5 : 1,
        }}
      >
        {paying ? 'PROCESSING…' : 'PAY'}
      </button>
      {error && <div style={{ fontSize: 10, color: '#f87171', marginTop: 6 }}>{error}</div>}
      {pending && (
        <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 6 }}>
          Complete checkout in your browser. If payment didn't go through, come back here and click PAY again — the earlier checkout is closed automatically.
        </div>
      )}
    </div>
  );
}

function InvoicesPanel({ orgId, cardFeeCfg }) {
  const [invoices, setInvoices] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.getOrgInvoices(orgId).then(({ data, error }) => {
      if (data) { setInvoices(data.invoices || []); setError(null); }
      else setError(error || 'Failed to load invoices');
    });
  }, [orgId]);

  useEffect(() => { load(); }, [load]);
  // An invoice paid in the browser moves to history once the app is back in front.
  useRefetchOnReturn(load);

  if (error) return <div style={{ fontSize: 10, color: '#f87171' }}>{error}</div>;
  if (!invoices) return <div style={{ fontSize: 10, color: '#6b7280' }}>Loading…</div>;

  const pending = invoices.filter(inv => inv.status === 'pending');
  const settled = invoices.filter(inv => inv.status !== 'pending');

  return (
    <div>
      <div style={{ ...label, marginBottom: 8 }}>OUTSTANDING INVOICES</div>
      {pending.length === 0 ? (
        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 12 }}>No outstanding invoices.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {pending.map(inv => (
            <InvoiceRow key={inv.id} orgId={orgId} invoice={inv} cardFeeCfg={cardFeeCfg} onPaid={load} />
          ))}
        </div>
      )}

      {settled.length > 0 && (
        <div style={{ border: '1px solid #0e2233', borderRadius: 4, padding: '10px 12px' }}>
          <div style={{ ...label, marginBottom: 8 }}>INVOICE HISTORY</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {settled.map(inv => (
              <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 11, color: '#e5e7eb' }}>{inv.invoice_reason || 'Invoice'}</span>
                  <span style={{ ...mono, fontSize: 9, color: '#0e7490', marginLeft: 6 }}>{fmtDateTime(inv.created_at)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ ...mono, fontSize: 11, color: '#4ade80' }}>{fmtUsd(inv.amount_cents)}</span>
                  <StatusBadge status={inv.status} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UsagePanel({ orgId, tierLimits }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [monthIdx, setMonthIdx] = useState(0); // 0 = current month (daily detail), >0 = totals-only history

  useEffect(() => {
    let cancelled = false;
    api.getOrgUsageDaily(orgId, 6).then(({ data, error }) => {
      if (cancelled) return;
      if (data) setData(data);
      else setError(error || 'Failed to load usage');
    });
    return () => { cancelled = true; };
  }, [orgId]);

  if (error) return <div style={{ fontSize: 10, color: '#f87171' }}>{error}</div>;
  if (!data) return <div style={{ fontSize: 10, color: '#6b7280' }}>Loading…</div>;

  const monthly = data.monthly_totals || [];
  const selected = monthly[monthIdx];
  const isCurrentMonth = monthIdx === 0;

  // The real cap is monthly, not daily — this is a clearly-labeled average
  // reference, not a hard per-day limit.
  const dailyRefCap = (tierLimits?.data_bytes ?? 0) / 30;

  return (
    <div>
      <div style={{ border: '1px solid #0e2233', borderRadius: 4, padding: '10px 12px', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={label}>
            {isCurrentMonth ? 'DAILY USAGE — THIS MONTH' : 'MONTHLY TOTAL'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={() => setMonthIdx(i => Math.min(i + 1, monthly.length - 1))}
              disabled={monthIdx >= monthly.length - 1}
              style={{ background: 'none', border: 'none', color: '#0e7490', cursor: 'pointer', fontSize: 11, opacity: monthIdx >= monthly.length - 1 ? 0.3 : 1 }}
            >◀</button>
            <span style={{ ...mono, fontSize: 10, color: '#9ca3af', minWidth: 70, textAlign: 'center' }}>
              {selected ? new Date(selected.month).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '—'}
            </span>
            <button
              onClick={() => setMonthIdx(i => Math.max(i - 1, 0))}
              disabled={monthIdx === 0}
              style={{ background: 'none', border: 'none', color: '#0e7490', cursor: 'pointer', fontSize: 11, opacity: monthIdx === 0 ? 0.3 : 1 }}
            >▶</button>
          </div>
        </div>

        {isCurrentMonth ? (
          <>
            <div style={{ fontSize: 9, color: '#6b7280', marginBottom: 8 }}>
              % shown against an average daily allowance ({fmtBytes(dailyRefCap)}/day) derived from the monthly cap — not a hard daily limit.
            </div>
            {(data.current_month_daily || []).length === 0 ? (
              <div style={{ fontSize: 10, color: '#6b7280' }}>No usage recorded yet this month.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {data.current_month_daily.map(row => {
                  const bytes = Number(row.bytes_out);
                  const pct = dailyRefCap > 0 ? Math.min(100, Math.round(bytes / dailyRefCap * 100)) : 0;
                  const color = barColor(pct);
                  return (
                    <div key={row.day}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                        <span style={{ fontSize: 10, color: '#9ca3af', ...mono }}>
                          {new Date(row.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </span>
                        <span style={{ fontSize: 10, color: color?.label || '#22d3ee', ...mono }}>{fmtBytes(bytes)} · {pct}%</span>
                      </div>
                      <div style={{ height: 3, background: '#041018', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: color?.bar || 'linear-gradient(90deg, #0e7490, #22d3ee)', borderRadius: 2, transition: 'width 0.6s' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div style={{ ...mono, fontSize: 18, color: '#22d3ee' }}>
            {selected ? fmtBytes(Number(selected.bytes_out)) : '—'}
          </div>
        )}
      </div>
    </div>
  );
}
