import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  RBtn, StatCard, Table, Alert, Pagination, Modal, Field, TextInput, Badge, Time, SearchBar, can, useDebounced,
} from '../admin/ui';
import {
  usd, dollarsToCents, centsToDollarsInput, newRequestId, fmtBytes,
  deriveCycle, cycleHistory, formatCycleRange, formatCycleDates, utcDay,
} from '../admin/billingFormat';

// Platform-admin billing view, mounted from AdminPortal.jsx as the "Billing"
// section: <AdminBillingSection adminApi={adminApi} role={role} />.
// Backed by /admin/billing/* (services/identity-node/src/routes/adminBilling.ts).
//
// Every request goes through admin/adminApi.js, so a 401 ends the admin
// session and a 403 REAUTH_REQUIRED prompts for the password and retries
// once with the SAME body (same request_id, so the retry cannot double-pay).
// Roles are enforced server-side: viewer = overview only, operator = all
// reads + read-only reconcile + resolve, owner = refund / adjust / settle /
// repair. Hiding buttons here is UX only.

const STATE_TONE = { active: 'green', ok: 'green', low_balance: 'amber', grace: 'amber', restricted: 'red' };
const PAY_TONE = { succeeded: 'green', pending: 'amber', failed: 'red', canceled: 'gray', refunded: 'blue' };
const short = (s, n = 14) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '—');
const Code = ({ v, n }) => <code className="text-xs text-gray-500" title={v || ''}>{short(v, n)}</code>;
const StateBadge = ({ state }) => (state ? <Badge tone={STATE_TONE[state] || 'gray'}>{state.replace('_', ' ')}</Badge> : <span>—</span>);

function ModeBadge({ payments }) {
  if (!payments) return null;
  const label = !payments.enabled ? 'PAYMENTS DISABLED' : payments.mode === 'live' ? 'LIVE MODE' : payments.mode === 'test' ? 'TEST MODE' : 'DEV PROVIDER';
  const cls = !payments.enabled ? 'bg-gray-200 text-gray-700'
    : payments.mode === 'live' ? 'bg-red-600 text-white' : payments.mode === 'test' ? 'bg-amber-400 text-amber-950' : 'bg-blue-100 text-blue-800';
  return <span className={`px-2.5 py-1 rounded text-xs font-bold tracking-wider ${cls}`}>{label}</span>;
}

// ─── Confirmation modals (money) ──────────────────────────────────────────────

function RefundModal({ adminApi, payment, onClose, onDone }) {
  const refundable = Number(payment.charge_cents ?? (payment.amount_cents + payment.fee_cents)) - Number(payment.refunded_charge_cents || 0);
  const [amount, setAmount] = useState(centsToDollarsInput(refundable));
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // One key per opened dialog: a double-click, a re-auth retry or a resubmit
  // after a network error all reuse it, so the server refunds at most once.
  const requestId = useRef(newRequestId()).current;
  const cents = dollarsToCents(amount);
  const valid = cents !== null && cents > 0 && cents <= refundable && reason.trim() && dollarsToCents(typed) === cents;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const { data, error } = await adminApi.refundPayment(payment.id, {
      amount_cents: cents, confirm_amount_cents: cents, reason: reason.trim(), request_id: requestId,
    });
    setBusy(false);
    if (error) { setErr(error); return; }
    onDone(data.duplicate ? 'That refund was already issued.' : `Refund ${data.refund_id} for ${usd(data.amount_cents)} issued — the wallet updates when the provider confirms.`);
  };

  return (
    <Modal title="Refund payment" onClose={onClose}>
      <div className="text-sm text-gray-600 space-y-1">
        <div>Payment <Code v={payment.provider_payment_id} n={28} /> · {payment.org_callsign || 'org'} · charged {usd(payment.charge_cents)}</div>
        <div>Still refundable: <b>{usd(refundable)}</b>. The money goes back to the payer and the same amount leaves the server's wallet.</div>
      </div>
      <Field label="Amount (USD)"><TextInput value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
      <Field label="Reason (required, kept in the audit log)"><TextInput value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label={`Type ${cents !== null ? centsToDollarsInput(cents) : 'the amount'} to confirm`}>
        <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </Field>
      {cents !== null && cents > refundable && <Alert type="warn">At most {usd(refundable)} can be refunded.</Alert>}
      {err && <Alert>{err}</Alert>}
      <div className="flex justify-end gap-2">
        <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
        <RBtn variant="danger" disabled={busy || !valid} onClick={submit}>{busy ? 'Refunding…' : `Refund ${cents ? usd(cents) : ''}`}</RBtn>
      </div>
    </Modal>
  );
}

function AdjustModal({ adminApi, org, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const requestId = useRef(newRequestId()).current;
  const cents = dollarsToCents(amount, { allowNegative: true });
  const inRange = cents !== null && cents !== 0 && Math.abs(cents) <= 1_000_000;
  const valid = inRange && reason.trim() && dollarsToCents(typed, { allowNegative: true }) === cents;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const { data, error } = await adminApi.adjustOrgBalance(org.org_id, {
      delta_cents: cents, confirm_amount_cents: cents, reason: reason.trim(), request_id: requestId,
    });
    setBusy(false);
    if (error) { setErr(error); return; }
    onDone(data.duplicate ? 'That adjustment was already applied.' : `Adjustment applied — balance now ${usd(data.balance_cents)}.`);
  };

  return (
    <Modal title={`Adjust wallet — ${org.callsign}`} onClose={onClose}>
      <p className="text-sm text-gray-600">Adds a ledger row (positive = credit, negative = debit). Current balance {usd(org.balance_cents)}. Limit ±$10,000.</p>
      <Field label="Amount (USD, e.g. 10.00 or -5.00)"><TextInput value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Reason (required, shown in the server's ledger)"><TextInput value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label={`Type ${cents !== null ? (cents < 0 ? '-' : '') + centsToDollarsInput(Math.abs(cents)) : 'the amount'} to confirm`}>
        <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </Field>
      {amount && !inRange && <Alert type="warn">Enter a non-zero amount up to ±$10,000.00 with at most two decimals.</Alert>}
      {err && <Alert>{err}</Alert>}
      <div className="flex justify-end gap-2">
        <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
        <RBtn variant="danger" disabled={busy || !valid} onClick={submit}>
          {busy ? 'Applying…' : inRange ? `${cents > 0 ? 'Credit' : 'Debit'} ${usd(Math.abs(cents))}` : 'Apply'}
        </RBtn>
      </div>
    </Modal>
  );
}

function TypeWordModal({ title, word, children, busyLabel, actionLabel, onConfirm, onClose }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    const e = await onConfirm();
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="text-sm text-gray-600 space-y-2">{children}</div>
      <Field label={`Type ${word} to confirm`}><TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
      {err && <Alert>{err}</Alert>}
      <div className="flex justify-end gap-2">
        <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
        <RBtn variant="danger" disabled={busy || typed.trim() !== word} onClick={go}>{busy ? busyLabel : actionLabel}</RBtn>
      </div>
    </Modal>
  );
}

function ResolveModal({ adminApi, ex, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const submit = async () => {
    setBusy(true);
    const { error } = await adminApi.resolveBillingException(ex.id, note.trim());
    setBusy(false);
    if (error) { setErr(error); return; }
    onDone('Exception resolved.');
  };
  return (
    <Modal title={`Resolve ${ex.kind}`} onClose={onClose}>
      <pre className="text-xs bg-gray-50 border border-gray-200 rounded p-2 overflow-x-auto">{JSON.stringify(ex.detail, null, 2)}</pre>
      <Field label="What was done (required, audited)"><TextInput value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></Field>
      {err && <Alert>{err}</Alert>}
      <div className="flex justify-end gap-2">
        <RBtn variant="ghost" onClick={onClose}>Cancel</RBtn>
        <RBtn disabled={busy || !note.trim()} onClick={submit}>{busy ? 'Saving…' : 'Mark resolved'}</RBtn>
      </div>
    </Modal>
  );
}

// ─── Payments table (shared by the Payments tab and the org detail) ───────────

function PaymentsTable({ rows, role, onRefund, showOrg = true, loading, error }) {
  const cols = ['When', ...(showOrg ? ['Server'] : []), 'Payer', 'Status', 'Amount', 'Charged', 'Refunded', 'Provider ids', ''];
  return (
    <Table cols={cols} loading={loading} error={error} empty="No payments.">
      {rows.map((p) => {
        const refundable = Number(p.charge_cents ?? 0) - Number(p.refunded_charge_cents || 0);
        return (
          <tr key={p.id} className="border-b border-gray-100 align-top">
            <td className="px-4 py-2 text-xs text-gray-500"><Time ts={p.created_at} /></td>
            {showOrg && <td className="px-4 py-2 text-sm text-gray-700">{p.org_callsign || <Code v={p.org_id} n={8} />}</td>}
            <td className="px-4 py-2 text-sm text-gray-600">{p.contributor_callsign || '—'}</td>
            <td className="px-4 py-2 space-x-1">
              <Badge tone={PAY_TONE[p.status] || 'gray'}>{p.status}</Badge>
              {p.dispute_status && <Badge tone="red">dispute {p.dispute_status}</Badge>}
              {p.source === 'admin_invoice' && <Badge tone="blue">invoice</Badge>}
            </td>
            <td className="px-4 py-2 text-sm">{usd(p.amount_cents)}</td>
            <td className="px-4 py-2 text-sm text-gray-600">{usd(p.charge_cents)} <span className="text-xs text-gray-400">{p.payment_method}</span></td>
            <td className="px-4 py-2 text-sm text-gray-600">{p.refunded_charge_cents ? usd(p.refunded_charge_cents) : '—'}</td>
            <td className="px-4 py-2 space-y-0.5">
              <div><Code v={p.provider_payment_id} n={22} /></div>
              {p.provider_session_id && <div><Code v={p.provider_session_id} n={22} /></div>}
              {p.last_error && <div className="text-xs text-red-600" title={p.last_error}>{short(p.last_error, 40)}</div>}
            </td>
            <td className="px-4 py-2 text-right">
              {can(role, 'owner') && p.status === 'succeeded' && refundable > 0 && !['open', 'lost'].includes(p.dispute_status) && (
                <RBtn small variant="danger" onClick={() => onRefund(p)}>Refund…</RBtn>
              )}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

// ─── Org detail ───────────────────────────────────────────────────────────────

function CyclePanel({ detail, config }) {
  const c = deriveCycle(detail, config);
  if (!c) return <div className="text-sm text-gray-400">No billing cycle yet (the wallet row is created on first use).</div>;
  const priceChanges = c.priceCents !== null && c.nextPriceCents !== null && c.priceCents !== c.nextPriceCents;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wider">Current cycle (UTC)</div>
        <div className="font-semibold text-gray-800">{formatCycleRange(c.start, c.end)}</div>
        <div className="text-xs text-gray-500">{c.tierName || '—'}</div>
      </div>
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wider">Price this cycle → next</div>
        <div className={`font-semibold ${priceChanges ? 'text-amber-700' : 'text-gray-800'}`}>
          {usd(c.priceCents)} <span className="text-gray-400">(locked)</span> → {usd(c.nextPriceCents)}
        </div>
        {priceChanges && <div className="text-xs text-amber-700">Price changes at the next cycle{c.nextTierName ? ` (${c.nextTierName})` : ''}.</div>}
      </div>
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wider">Next charge</div>
        <div className="font-semibold text-gray-800">{usd(c.nextChargeCents)} on {c.nextChargeAt ? utcDay(c.nextChargeAt) : '—'}</div>
        {!c.enforced && <Badge tone="gray">Shadow (not charged)</Badge>}
      </div>
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wider">State</div>
        <div className="flex items-center gap-2"><StateBadge state={c.state} />
          {c.coversCycles !== null && <span className="text-xs text-gray-500">covers {c.coversCycles} cycle{c.coversCycles === 1 ? '' : 's'}</span>}
        </div>
        {c.graceEndsAt && <div className="text-xs text-orange-700">Grace ends <Time ts={c.graceEndsAt} /></div>}
      </div>
      {c.derived && <div className="sm:col-span-2 lg:col-span-4 text-xs text-gray-400">Cycle derived in the browser from the cycle start (this server does not send a cycle summary yet).</div>}
    </div>
  );
}

function OrgDetailModal({ adminApi, role, orgId, config, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [ledger, setLedger] = useState({ entries: [], total: 0 });
  const [ledgerPage, setLedgerPage] = useState(1);
  const [refund, setRefund] = useState(null);
  const [adjust, setAdjust] = useState(false);

  const load = useCallback(() => {
    adminApi.billingOrg(orgId).then(({ data, error }) => { if (error) setError(error); else setDetail(data); });
  }, [adminApi, orgId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    adminApi.billingOrgLedger(orgId, { page: ledgerPage, limit: 25 }).then(({ data }) => { if (data) setLedger(data); });
  }, [adminApi, orgId, ledgerPage, detail]);

  const done = (m) => { setRefund(null); setAdjust(false); setMsg(m); load(); };
  const history = cycleHistory(detail);

  return (
    <Modal title={detail ? `Billing — ${detail.org.callsign}` : 'Billing'} onClose={onClose} wide>
      {error && <Alert>{error}</Alert>}
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      {!detail && !error && <div className="text-sm text-gray-400">Loading…</div>}
      {detail && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-2xl font-bold text-gray-900">{usd(detail.billing?.balance_cents ?? 0)}</span>
            <StateBadge state={detail.state} />
            <span className="text-gray-500">plan {detail.org.tier_name}{detail.effective_tier && detail.effective_tier.id !== detail.org.tier ? ` (serving ${detail.effective_tier.name})` : ''}</span>
            {!detail.in_billing_scope && <Badge tone="gray">not in beta allowlist</Badge>}
            <Badge tone={detail.enforced ? 'red' : 'gray'}>{detail.enforced ? 'enforced' : 'shadow billing'}</Badge>
            <code className="text-xs text-gray-400">{detail.org.id}</code>
            {can(role, 'owner') && <span className="ml-auto"><RBtn small variant="danger" onClick={() => setAdjust(true)}>Adjust wallet…</RBtn></span>}
          </div>
          <div className="text-xs text-gray-500">
            Owner {detail.org.owner_callsign || '—'} · usage this cycle {fmtBytes(detail.billing?.cycle_bytes_out)}
            {detail.billing_info && <> · billing contact {detail.billing_info.company_name || '—'} {detail.billing_info.billing_email_masked || ''}</>}
          </div>

          <section className="border border-gray-200 rounded p-3"><CyclePanel detail={detail} config={config} /></section>

          {detail.open_exceptions?.length > 0 && (
            <Alert type="warn">{detail.open_exceptions.length} open exception(s): {detail.open_exceptions.map((e) => e.kind).join(', ')}</Alert>
          )}

          <section>
            <h4 className="text-xs uppercase tracking-wider text-gray-500 mb-1">Cycle history</h4>
            <Table cols={['Cycle (UTC)', 'Plan', 'Usage', 'Charge', 'Applied', 'Config']} empty="No settled cycles yet.">
              {history.map((h) => (
                <tr key={h.start} className="border-b border-gray-100">
                  <td className="px-4 py-2 text-sm">{formatCycleDates(h.start, h.end)}</td>
                  <td className="px-4 py-2 text-sm text-gray-600">{h.tier ?? '—'}</td>
                  <td className="px-4 py-2 text-sm text-gray-600">{h.bytesOut !== null ? fmtBytes(h.bytesOut) : '—'}</td>
                  <td className="px-4 py-2 text-sm">{usd(h.chargeCents)}</td>
                  <td className="px-4 py-2">{h.applied ? <Badge tone="green">charged</Badge> : <Badge tone="gray">shadow</Badge>}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">{h.configVersion ? `v${h.configVersion}` : '—'}</td>
                </tr>
              ))}
            </Table>
          </section>

          <section>
            <h4 className="text-xs uppercase tracking-wider text-gray-500 mb-1">Payments (latest 25 — full list in the Payments tab)</h4>
            <PaymentsTable rows={detail.contributions || []} role={role} onRefund={(p) => setRefund({ ...p, org_callsign: detail.org.callsign })} showOrg={false} />
          </section>

          <section className="space-y-2">
            <h4 className="text-xs uppercase tracking-wider text-gray-500">Ledger ({ledger.total})</h4>
            <Table cols={['When', 'Kind', 'Change', 'Balance after', 'Description']} empty="No ledger entries.">
              {(ledger.entries || []).map((l) => (
                <tr key={l.id} className="border-b border-gray-100">
                  <td className="px-4 py-2 text-xs text-gray-500"><Time ts={l.created_at} /></td>
                  <td className="px-4 py-2 text-xs">{l.kind}</td>
                  <td className={`px-4 py-2 text-sm ${Number(l.delta_cents) < 0 ? 'text-red-700' : 'text-green-700'}`}>{usd(l.delta_cents)}</td>
                  <td className="px-4 py-2 text-sm text-gray-600">{l.balance_after_cents === null ? '—' : usd(l.balance_after_cents)}</td>
                  <td className="px-4 py-2 text-xs text-gray-600">{l.description}</td>
                </tr>
              ))}
            </Table>
            <Pagination page={ledgerPage} limit={25} total={ledger.total} onPage={setLedgerPage} />
          </section>
        </div>
      )}
      {refund && <RefundModal adminApi={adminApi} payment={refund} onClose={() => setRefund(null)} onDone={done} />}
      {adjust && detail && (
        <AdjustModal adminApi={adminApi}
          org={{ org_id: detail.org.id, callsign: detail.org.callsign, balance_cents: detail.billing?.balance_cents ?? 0 }}
          onClose={() => setAdjust(false)} onDone={done} />
      )}
    </Modal>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function OverviewTab({ adminApi, role, overview, reload, onOpenOrg, setMsg }) {
  const [days, setDays] = useState(7);
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null); // 'repair' | 'settle'

  const reconcile = async (repair) => {
    const until = new Date();
    const since = new Date(until.getTime() - days * 86_400_000);
    const { data, error } = await adminApi.reconcileBilling({
      since: since.toISOString(), until: until.toISOString(), repair, ...(repair ? { confirm: 'REPAIR' } : {}),
    });
    if (error) return error;
    setReport(data);
    reload();
    return null;
  };

  const o = overview;
  const exTotal = Object.values(o.open_exceptions || {}).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-4">
      {err && <Alert onDismiss={() => setErr(null)}>{err}</Alert>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Credited (all time)" value={usd(o.totals.credited_cents)} />
        <StatCard label="Refunded" value={usd(o.totals.reversed_cents)} sub={`chargebacks ${usd(o.totals.chargeback_cents)}`} />
        <StatCard label="Open exceptions" value={exTotal} sub={`${o.totals.open_disputes} open dispute(s)`} />
        <StatCard label="Stuck webhooks" value={o.stuck_webhooks} sub={`${o.failed_webhooks_24h ?? 0} errored in 24h`} />
      </div>
      <div className="border border-gray-200 bg-white rounded-lg p-4 shadow-sm text-sm text-gray-600 flex flex-wrap gap-x-6 gap-y-1">
        <span>Enforcement: <b className={o.enforcement_active ? 'text-red-700' : ''}>{o.enforcement_active ? 'ON' : 'off (shadow charges)'}</b></span>
        {o.beta_org_count !== null && o.beta_org_count !== undefined && <span>Beta allowlist: <b>{o.beta_org_count}</b> server(s)</span>}
        <span>Grace {o.config?.graceDays} d · card fee {o.config?.cardFeeMode}</span>
        <span>{o.stale_pending_contributions} checkout(s) pending &gt;10 days</span>
        <span>Last webhook: {o.last_webhook_at ? <Time ts={o.last_webhook_at} /> : 'never'}</span>
        {!o.payments.enabled && o.payments.reason && <span className="text-gray-500">Disabled: {o.payments.reason}</span>}
      </div>

      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 text-xs uppercase tracking-wider text-gray-500 font-medium">
          Servers needing attention ({o.orgs_at_risk.length}{o.orgs_at_risk_truncated ? '+' : ''})
        </div>
        <Table cols={['Server', 'Plan', 'Balance', 'State', 'Grace ends']} empty="None.">
          {o.orgs_at_risk.map((r) => (
            <tr key={r.org_id} className={`border-b border-gray-100 ${can(role, 'operator') ? 'hover:bg-gray-50 cursor-pointer' : ''}`}
                onClick={() => can(role, 'operator') && onOpenOrg(r.org_id)}>
              <td className="px-4 py-2 font-medium text-gray-800">{r.callsign}</td>
              <td className="px-4 py-2 text-gray-600">{r.tier}</td>
              <td className={`px-4 py-2 ${r.balance_cents < 0 ? 'text-red-700' : ''}`}>{usd(r.balance_cents)}</td>
              <td className="px-4 py-2"><StateBadge state={r.state} /></td>
              <td className="px-4 py-2 text-xs text-gray-500"><Time ts={r.grace_ends_at} /></td>
            </tr>
          ))}
        </Table>
      </div>

      {can(role, 'operator') && (
        <div className="border border-gray-200 bg-white rounded-lg p-4 shadow-sm space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-gray-700 mr-2">Reconciliation</span>
            <span className="text-gray-500">last</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="bg-white border border-gray-300 rounded text-sm px-2 py-1">
              {[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
            </select>
            <RBtn disabled={running} onClick={async () => { setRunning(true); const e = await reconcile(false); setRunning(false); if (e) setErr(e); }}>
              {running ? 'Checking…' : 'Check'}
            </RBtn>
            {can(role, 'owner') && <RBtn variant="danger" onClick={() => setConfirm('repair')}>Check &amp; repair…</RBtn>}
            {can(role, 'owner') && <span className="ml-auto"><RBtn variant="danger" onClick={() => setConfirm('settle')}>Run cycle settlement…</RBtn></span>}
          </div>
          {report && (
            <div className="text-xs text-gray-700 space-y-1">
              <div>Provider <b>{report.provider || 'none'}</b> · {report.provider_payments_checked} provider payments · {report.contributions_checked} payments · {report.orgs_checked} wallets · {report.repaired} repaired</div>
              {report.issues.length === 0 ? <div className="text-green-700">No discrepancies.</div> : (
                <ul className="list-disc pl-5">
                  {report.issues.map((i, n) => (
                    <li key={n}><b>{i.kind}</b>{i.repaired && <span className="text-green-700"> (repaired)</span>} {i.provider_payment_id && <Code v={i.provider_payment_id} n={28} />}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {confirm === 'repair' && (
        <TypeWordModal title="Reconcile and repair" word="REPAIR" busyLabel="Repairing…" actionLabel="Repair"
          onClose={() => setConfirm(null)}
          onConfirm={async () => { const e = await reconcile(true); if (!e) { setConfirm(null); setMsg('Repair run finished.'); } return e; }}>
          <p>Applies missed credits and refunds (the last {days} day{days > 1 ? 's' : ''}) to server wallets, through the same path a late webhook would take. Everything else is queued as an exception.</p>
        </TypeWordModal>
      )}
      {confirm === 'settle' && (
        <TypeWordModal title="Run cycle settlement" word="SETTLE" busyLabel="Settling…" actionLabel="Settle now"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const { data, error } = await adminApi.settleBilling();
            if (error) return error;
            setConfirm(null); setMsg(`Settled cycles for ${data.orgs_settled} server(s).`); reload(); return null;
          }}>
          <p>Closes every elapsed billing cycle now instead of waiting for the hourly job. {o.enforcement_active
            ? <b className="text-red-700">Enforcement is ON: enforced servers are debited.</b>
            : 'Enforcement is off: only shadow charges are recorded.'}</p>
        </TypeWordModal>
      )}
    </div>
  );
}

function OrgsTab({ adminApi, onOpenOrg }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('balance');
  const [dir, setDir] = useState('asc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const dq = useDebounced(q);
  const seq = useRef(0);
  const limit = 50;

  useEffect(() => { setPage(1); }, [dq, filter, sort, dir]);
  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    adminApi.billingOrgs({ q: dq, filter, sort, dir, page, limit }).then(({ data, error }) => {
      if (mine !== seq.current) return;
      setLoading(false);
      setError(error);
      if (data) { setRows(data.orgs || []); setTotal(data.total || 0); }
    });
  }, [adminApi, dq, filter, sort, dir, page]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBar value={q} onChange={setQ} placeholder="Server callsign or id…" />
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="bg-white border border-gray-300 rounded text-sm px-2 py-1.5">
          <option value="all">All servers</option>
          <option value="negative">Negative balance</option>
          <option value="grace">In grace</option>
          <option value="paid">Paid plans</option>
        </select>
        <span className="text-sm text-gray-500 ml-auto">{total.toLocaleString()} servers</span>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table
          cols={[{ key: 'callsign', label: 'Server', sortable: true }, { key: 'tier', label: 'Plan', sortable: true },
                 { key: 'balance', label: 'Balance', sortable: true }, { key: 'state', label: 'State' }, { key: 'cycle', label: 'Cycle start' }, { key: 'x', label: '' }]}
          sort={sort} dir={dir} onSort={(k, d) => { setSort(k); setDir(d); }}
          loading={loading} error={error} empty="No servers match."
        >
          {rows.map((r) => (
            <tr key={r.org_id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-4 py-2 font-medium text-gray-800">{r.callsign}{!r.in_billing_scope && <span className="ml-2"><Badge>not in beta</Badge></span>}</td>
              <td className="px-4 py-2 text-gray-600">{r.tier_name}</td>
              <td className={`px-4 py-2 ${r.balance_cents < 0 ? 'text-red-700' : ''}`}>{usd(r.balance_cents)}</td>
              <td className="px-4 py-2"><StateBadge state={r.state} /></td>
              <td className="px-4 py-2 text-xs text-gray-500"><Time ts={r.cycle_start_at} dateOnly /></td>
              <td className="px-4 py-2 text-right"><RBtn small onClick={() => onOpenOrg(r.org_id)}>Open</RBtn></td>
            </tr>
          ))}
        </Table>
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />
    </div>
  );
}

function PaymentsTab({ adminApi, role, setMsg }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [disputed, setDisputed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refund, setRefund] = useState(null);
  const [tick, setTick] = useState(0);
  const dq = useDebounced(q);
  const limit = 50;

  useEffect(() => { setPage(1); }, [dq, status, disputed]);
  useEffect(() => {
    setLoading(true);
    adminApi.billingPayments({ q: dq.trim(), status, disputed: disputed ? 'true' : '', page, limit }).then(({ data, error }) => {
      setLoading(false);
      setError(error);
      if (data) { setRows(data.payments || []); setTotal(data.total || 0); }
    });
  }, [adminApi, dq, status, disputed, page, tick]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBar value={q} onChange={setQ} placeholder="Exact id: pi_…, cs_…, payment uuid, invoice ref" className="w-80" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="bg-white border border-gray-300 rounded text-sm px-2 py-1.5">
          <option value="">Any status</option>
          {['pending', 'succeeded', 'failed', 'canceled', 'refunded'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="text-sm text-gray-600 flex items-center gap-1"><input type="checkbox" checked={disputed} onChange={(e) => setDisputed(e.target.checked)} /> disputed</label>
        <span className="text-sm text-gray-500 ml-auto">{total.toLocaleString()} payments</span>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <PaymentsTable rows={rows} role={role} onRefund={setRefund} loading={loading} error={error} />
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />
      {refund && <RefundModal adminApi={adminApi} payment={refund} onClose={() => setRefund(null)}
        onDone={(m) => { setRefund(null); setMsg(m); setTick((n) => n + 1); }} />}
    </div>
  );
}

function ExceptionsTab({ adminApi, role, setMsg, reload, onOpenOrg }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('open');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [resolve, setResolve] = useState(null);
  const [refund, setRefund] = useState(null);
  const [tick, setTick] = useState(0);
  const limit = 50;

  useEffect(() => { setPage(1); }, [status]);
  useEffect(() => {
    setLoading(true);
    adminApi.billingExceptions({ status, page, limit }).then(({ data, error }) => {
      setLoading(false);
      setError(error);
      if (data) { setRows(data.exceptions || []); setTotal(data.total ?? (data.exceptions || []).length); }
    });
  }, [adminApi, status, page, tick]);

  const openRefund = async (ex) => {
    const { data, error } = await adminApi.billingPayments({ q: ex.contribution_id, limit: 1 });
    if (error || !data?.payments?.[0]) { setError(error || 'Payment not found'); return; }
    setRefund(data.payments[0]);
  };
  const done = (m) => { setResolve(null); setRefund(null); setMsg(m); setTick((n) => n + 1); reload(); };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="bg-white border border-gray-300 rounded text-sm px-2 py-1.5">
          <option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option>
        </select>
        <span className="text-sm text-gray-500 ml-auto">{total.toLocaleString()} exceptions</span>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['Kind', 'Server', 'Payment', 'Detail', 'Auto', 'When', '']} loading={loading} error={error} empty="Queue is empty.">
          {rows.map((ex) => (
            <tr key={ex.id} className="border-b border-gray-100 align-top">
              <td className="px-4 py-2 font-medium text-gray-800">{ex.kind}</td>
              <td className="px-4 py-2 text-sm">
                {ex.org_id ? <button className="underline text-gray-700" onClick={() => onOpenOrg(ex.org_id)}>{ex.org_callsign || short(ex.org_id, 8)}</button> : '—'}
              </td>
              <td className="px-4 py-2"><Code v={ex.provider_payment_id} n={22} /></td>
              <td className="px-4 py-2 text-xs text-gray-500 max-w-xs break-words">{JSON.stringify(ex.detail)}</td>
              <td className="px-4 py-2 text-xs">{ex.auto_action || '—'}</td>
              <td className="px-4 py-2 text-xs text-gray-500"><Time ts={ex.created_at} />{ex.resolved_at && <div className="text-green-700" title={ex.resolved_note}>resolved</div>}</td>
              <td className="px-4 py-2 whitespace-nowrap text-right space-x-1">
                {!ex.resolved_at && can(role, 'owner') && ex.contribution_id && !['duplicate_payment', 'org_deleted'].includes(ex.kind) && (
                  <RBtn small variant="danger" onClick={() => openRefund(ex)}>Refund…</RBtn>
                )}
                {!ex.resolved_at && <RBtn small onClick={() => setResolve(ex)}>Resolve…</RBtn>}
              </td>
            </tr>
          ))}
        </Table>
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />
      {resolve && <ResolveModal adminApi={adminApi} ex={resolve} onClose={() => setResolve(null)} onDone={done} />}
      {refund && <RefundModal adminApi={adminApi} payment={refund} onClose={() => setRefund(null)} onDone={done} />}
    </div>
  );
}

function WebhooksTab({ adminApi }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('stuck');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const limit = 50;
  useEffect(() => { setPage(1); }, [status]);
  useEffect(() => {
    setLoading(true);
    adminApi.billingWebhooks({ status, page, limit }).then(({ data, error }) => {
      setLoading(false);
      setError(error);
      if (data) { setRows(data.events || []); setTotal(data.total || 0); }
    });
  }, [adminApi, status, page]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="bg-white border border-gray-300 rounded text-sm px-2 py-1.5">
          <option value="stuck">Stuck (unprocessed &gt;10 min)</option>
          <option value="failed">With an error</option>
          <option value="unprocessed">Unprocessed</option>
          <option value="all">All</option>
        </select>
        <span className="text-xs text-gray-500">Stuck events usually mean the handler threw; Stripe retries them. A reconcile run repairs missed credits.</span>
        <span className="text-sm text-gray-500 ml-auto">{total.toLocaleString()} events</span>
      </div>
      <div className="border border-gray-200 bg-white rounded-lg shadow-sm overflow-hidden">
        <Table cols={['Received', 'Type', 'Event id', 'Mode', 'Attempts', 'Processed', 'Last error']} loading={loading} error={error} empty="No events.">
          {rows.map((e) => (
            <tr key={e.event_id} className="border-b border-gray-100 align-top">
              <td className="px-4 py-2 text-xs text-gray-500"><Time ts={e.received_at} /></td>
              <td className="px-4 py-2 text-sm">{e.type}</td>
              <td className="px-4 py-2"><Code v={e.event_id} n={24} /></td>
              <td className="px-4 py-2"><Badge tone={e.livemode ? 'red' : 'amber'}>{e.livemode ? 'live' : 'test'}</Badge></td>
              <td className="px-4 py-2 text-sm text-center">{e.attempts}</td>
              <td className="px-4 py-2 text-xs text-gray-500">{e.processed_at ? <Time ts={e.processed_at} /> : <Badge tone="red">no</Badge>}</td>
              <td className="px-4 py-2 text-xs text-red-600 max-w-xs break-words">{e.last_error || '—'}</td>
            </tr>
          ))}
        </Table>
      </div>
      <Pagination page={page} limit={limit} total={total} onPage={setPage} />
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'overview',   label: 'Overview',   role: 'viewer' },
  { id: 'orgs',       label: 'Servers',    role: 'operator' },
  { id: 'payments',   label: 'Payments',   role: 'operator' },
  { id: 'exceptions', label: 'Exceptions', role: 'operator' },
  { id: 'webhooks',   label: 'Webhooks',   role: 'operator' },
];

export default function AdminBillingSection({ adminApi, role }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState('overview');
  const [openOrg, setOpenOrg] = useState(null);

  const load = useCallback(() => {
    adminApi.billingOverview().then(({ data, error }) => { setError(error); if (data) setOverview(data); });
  }, [adminApi]);
  useEffect(() => { load(); }, [load]);

  const tabs = TABS.filter((t) => can(role, t.role));
  if (error && !overview) return <Alert>Could not load billing: {error} <button className="underline ml-2" onClick={load}>Retry</button></Alert>;
  if (!overview) return <div className="text-gray-400 text-sm p-8 text-center">Loading billing…</div>;
  const exTotal = Object.values(overview.open_exceptions || {}).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ModeBadge payments={overview.payments} />
        {overview.payments.provider && <span className="text-sm text-gray-500">provider {overview.payments.provider}</span>}
        <div className="flex gap-1 ml-auto flex-wrap">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded border ${tab === t.id ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
              {t.label}
              {t.id === 'exceptions' && exTotal > 0 && <span className="ml-1 text-amber-500">({exTotal})</span>}
              {t.id === 'webhooks' && overview.stuck_webhooks > 0 && <span className="ml-1 text-red-500">({overview.stuck_webhooks})</span>}
            </button>
          ))}
          <RBtn small onClick={load}>Refresh</RBtn>
        </div>
      </div>
      {overview.payments.mode === 'live' && <Alert type="warn">LIVE mode: refunds and adjustments move real money.</Alert>}
      {msg && <Alert type="success" onDismiss={() => setMsg(null)}>{msg}</Alert>}

      {tab === 'overview'   && <OverviewTab adminApi={adminApi} role={role} overview={overview} reload={load} onOpenOrg={setOpenOrg} setMsg={setMsg} />}
      {tab === 'orgs'       && <OrgsTab adminApi={adminApi} onOpenOrg={setOpenOrg} />}
      {tab === 'payments'   && <PaymentsTab adminApi={adminApi} role={role} setMsg={setMsg} />}
      {tab === 'exceptions' && <ExceptionsTab adminApi={adminApi} role={role} setMsg={setMsg} reload={load} onOpenOrg={setOpenOrg} />}
      {tab === 'webhooks'   && <WebhooksTab adminApi={adminApi} />}

      {openOrg && <OrgDetailModal adminApi={adminApi} role={role} orgId={openOrg} config={overview.config} onClose={() => { setOpenOrg(null); load(); }} />}
    </div>
  );
}
