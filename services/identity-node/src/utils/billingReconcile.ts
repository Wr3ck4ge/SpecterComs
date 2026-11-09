import { pool } from '../config/db.js';
import type { PaymentProvider, ProviderPayment } from '../payments/PaymentProvider.js';
import { recordException, ExceptionKind } from './billingCredit.js';
import { processBillingEvent } from './billingEvents.js';

// Reconciliation: compare what the payment provider says happened with what
// our ledger says, and (optionally) repair the safe cases.
//
// Safe to repair automatically, because the repair is the same idempotent
// code path a late webhook would take:
//   - provider succeeded, row still pending/failed/canceled → credit
//   - provider refunded more than we recorded            → apply refund
// Everything else is recorded in billing_payment_exceptions for a human.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReconcileIssue {
  kind: ExceptionKind;
  contribution_id?: string | null;
  org_id?: string | null;
  provider_payment_id?: string | null;
  detail: Record<string, unknown>;
  repaired: boolean;
}

export interface ReconcileReport {
  since: string;
  until: string;
  provider: string | null;
  provider_payments_checked: number;
  contributions_checked: number;
  orgs_checked: number;
  issues: ReconcileIssue[];
  repaired: number;
}

export async function reconcileBilling(opts: {
  since: Date;
  until: Date;
  provider: PaymentProvider | null;
  repair: boolean;
}): Promise<ReconcileReport> {
  const { since, until, provider, repair } = opts;
  const issues: ReconcileIssue[] = [];
  const note = async (issue: ReconcileIssue, providerName: string | null) => {
    issues.push(issue);
    await recordException({
      kind: issue.kind,
      provider: providerName,
      providerPaymentId: issue.provider_payment_id ?? null,
      contributionId: issue.contribution_id ?? null,
      orgId: issue.org_id ?? null,
      detail: { ...issue.detail, source: 'reconcile' },
      autoAction: issue.repaired ? 'repaired_by_reconcile' : null,
    });
  };

  // ── 1. Ledger integrity: balance must equal the sum of its ledger ─────────
  const drift = await pool.query(
    `SELECT ob.org_id, ob.balance_cents, COALESCE(l.total, 0) AS ledger_total
     FROM org_billing ob
     LEFT JOIN (SELECT org_id, SUM(delta_cents) AS total FROM billing_ledger GROUP BY org_id) l
       ON l.org_id = ob.org_id
     WHERE ob.balance_cents <> COALESCE(l.total, 0)`
  );
  const orgCount = await pool.query(`SELECT COUNT(*)::int AS n FROM org_billing`);
  for (const r of drift.rows) {
    await note({
      kind: 'balance_drift', org_id: r.org_id, repaired: false,
      detail: { balance_cents: Number(r.balance_cents), ledger_total_cents: Number(r.ledger_total) },
    }, null);
  }

  // ── 2. Provider ↔ contributions ───────────────────────────────────────────
  let providerPayments: ProviderPayment[] = [];
  const providerName = provider?.name ?? null;
  if (provider && provider.name !== 'dev') {
    // Checkout creates the PaymentIntent when the payer confirms, which can be
    // up to a day after the contribution row — look 48 h past the window so
    // late-confirmed payments aren't reported as missing.
    providerPayments = await provider.listPayments(since, new Date(until.getTime() + 2 * 86_400_000));
  }

  const seen = new Set<string>();
  for (const p of providerPayments) {
    if (!p.contributionId) continue; // not ours (shared Stripe account) — nothing to compare
    seen.add(p.paymentId);
    if (!UUID_RE.test(p.contributionId)) {
      // Malformed metadata would raise 22P02 and abort the whole run.
      await note({ kind: 'unmatched_payment', provider_payment_id: p.paymentId, repaired: false,
        detail: { provider_status: p.status, amount_cents: p.amountCents, contribution_id: p.contributionId.slice(0, 100) } }, providerName);
      continue;
    }
    const rowRes = await pool.query(
      `SELECT id, org_id, status, charge_cents, amount_cents, fee_cents, provider_payment_id,
              refunded_charge_cents, dispute_status
       FROM billing_contributions WHERE id = $1`,
      [p.contributionId]
    );
    const row = rowRes.rows[0];
    if (!row) {
      await note({ kind: 'unmatched_payment', contribution_id: p.contributionId, provider_payment_id: p.paymentId,
        repaired: false, detail: { provider_status: p.status, amount_cents: p.amountCents } }, providerName);
      continue;
    }

    if (p.status === 'succeeded') {
      if (['pending', 'failed', 'canceled'].includes(row.status)) {
        let repaired = false;
        if (repair) {
          const out = await processBillingEvent(
            { kind: 'payment_succeeded', contributionId: p.contributionId, paymentId: p.paymentId, amountCents: p.amountCents },
            providerName ?? 'stripe'
          );
          repaired = out.result === 'credited';
        }
        await note({ kind: 'status_mismatch', contribution_id: row.id, org_id: row.org_id, provider_payment_id: p.paymentId,
          repaired, detail: { provider_status: p.status, ledger_status: row.status } }, providerName);
        continue;
      }
      if (row.provider_payment_id && row.provider_payment_id !== p.paymentId) {
        await note({ kind: 'duplicate_payment', contribution_id: row.id, org_id: row.org_id, provider_payment_id: p.paymentId,
          repaired: false, detail: { credited_payment_id: row.provider_payment_id, amount_cents: p.amountCents } }, providerName);
        continue;
      }
      const expected = Number(row.charge_cents ?? Number(row.amount_cents) + Number(row.fee_cents));
      if (p.amountCents !== expected) {
        await note({ kind: 'amount_mismatch', contribution_id: row.id, org_id: row.org_id, provider_payment_id: p.paymentId,
          repaired: false, detail: { provider_amount_cents: p.amountCents, expected_charge_cents: expected } }, providerName);
      }
      if (p.amountRefundedCents !== Number(row.refunded_charge_cents)) {
        let repaired = false;
        if (repair && p.amountRefundedCents > Number(row.refunded_charge_cents)) {
          const out = await processBillingEvent(
            { kind: 'refund_updated', paymentId: p.paymentId, chargeAmountCents: p.amountCents, amountRefundedCents: p.amountRefundedCents },
            providerName ?? 'stripe'
          );
          repaired = out.result === 'applied';
        }
        await note({ kind: 'refund_mismatch', contribution_id: row.id, org_id: row.org_id, provider_payment_id: p.paymentId,
          repaired, detail: { provider_refunded_cents: p.amountRefundedCents, ledger_refunded_cents: Number(row.refunded_charge_cents) } }, providerName);
      }
      if (p.disputed && !row.dispute_status) {
        await note({ kind: 'status_mismatch', contribution_id: row.id, org_id: row.org_id, provider_payment_id: p.paymentId,
          repaired: false, detail: { note: 'disputed at provider, no dispute recorded' } }, providerName);
      }
    } else if (row.status === 'succeeded' && row.provider_payment_id === p.paymentId) {
      await note({ kind: 'status_mismatch', contribution_id: row.id, org_id: row.org_id, provider_payment_id: p.paymentId,
        repaired: false, detail: { provider_status: p.status, ledger_status: row.status } }, providerName);
    }
  }

  // ── 3. Credited here but unknown to the provider ──────────────────────────
  let contributionsChecked = 0;
  if (provider && provider.name !== 'dev') {
    const ours = await pool.query(
      `SELECT id, org_id, provider_payment_id FROM billing_contributions
       WHERE provider = $1 AND status IN ('succeeded', 'refunded')
         AND created_at >= $2 AND created_at < $3`,
      [provider.name, since, until]
    );
    contributionsChecked = ours.rows.length;
    for (const r of ours.rows) {
      if (!r.provider_payment_id || !seen.has(r.provider_payment_id)) {
        await note({ kind: 'missing_at_provider', contribution_id: r.id, org_id: r.org_id, provider_payment_id: r.provider_payment_id,
          repaired: false, detail: { note: 'credited in ledger, no matching provider payment in window' } }, providerName);
      }
    }
  }

  return {
    since: since.toISOString(),
    until: until.toISOString(),
    provider: providerName,
    provider_payments_checked: providerPayments.length,
    contributions_checked: contributionsChecked,
    orgs_checked: Number(orgCount.rows[0].n),
    issues,
    repaired: issues.filter(i => i.repaired).length,
  };
}
