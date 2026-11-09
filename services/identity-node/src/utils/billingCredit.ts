import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { billingEnforced } from '../config/billingConfig.js';

// Every movement of an org pool goes through applyPoolDelta: one ledger row
// with a unique idempotency key, then the balance update, in the caller's
// transaction. A replayed webhook or a re-run job hits the unique key and
// changes nothing, so double credits/debits are structurally impossible
// rather than prevented by status checks alone.

export type LedgerKind = 'contribution' | 'refund' | 'dispute_hold' | 'dispute_release' | 'cycle_charge' | 'adjustment';

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface PoolDelta {
  orgId: string;
  deltaCents: number;
  kind: LedgerKind;
  description: string;
  idempotencyKey: string;
  contributionId?: string | null;
  /** Timestamp the balance change is effective (cycle end for settlement); default now. */
  at?: Date;
}

/**
 * Apply one ledger entry + balance change. Returns the new balance, or null
 * if this idempotency key was already applied. Maintains the grace clock:
 * it starts the moment the balance first goes negative and clears as soon as
 * the balance is back at or above zero.
 */
export async function applyPoolDelta(client: PoolClient, d: PoolDelta): Promise<number | null> {
  await client.query(`INSERT INTO org_billing (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, [d.orgId]);

  const ins = await client.query(
    `INSERT INTO billing_ledger (org_id, delta_cents, description, kind, contribution_id, idempotency_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [d.orgId, d.deltaCents, d.description, d.kind, d.contributionId ?? null, d.idempotencyKey, d.at ?? null]
  );
  if (ins.rows.length === 0) return null;

  const upd = await client.query(
    `UPDATE org_billing
     SET balance_cents    = balance_cents + $2,
         grace_started_at = CASE
                              WHEN balance_cents + $2 >= 0 THEN NULL
                              WHEN grace_started_at IS NULL THEN COALESCE($3::timestamptz, NOW())
                              ELSE grace_started_at
                            END,
         updated_at       = NOW()
     WHERE org_id = $1
     RETURNING balance_cents`,
    [d.orgId, d.deltaCents, d.at ?? null]
  );
  const balance = Number(upd.rows[0].balance_cents);
  await client.query(`UPDATE billing_ledger SET balance_after_cents = $2 WHERE id = $1`, [ins.rows[0].id, balance]);
  return balance;
}

export type ExceptionKind =
  | 'duplicate_payment' | 'unmatched_payment' | 'amount_mismatch' | 'status_mismatch'
  | 'refund_mismatch' | 'missing_at_provider' | 'org_deleted' | 'balance_drift' | 'dispute_lost';

export interface ExceptionRecord {
  kind: ExceptionKind;
  provider?: string | null;
  providerPaymentId?: string | null;
  contributionId?: string | null;
  orgId?: string | null;
  detail?: Record<string, unknown>;
  autoAction?: string | null;
}

/** Record an anomaly for the admin queue. One open row per (kind, payment, org). Returns true if new. */
export async function recordException(e: ExceptionRecord, client?: PoolClient): Promise<boolean> {
  const q = client ?? pool;
  const res = await q.query(
    `INSERT INTO billing_payment_exceptions
       (kind, provider, provider_payment_id, contribution_id, org_id, detail, auto_action)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT DO NOTHING`,
    [e.kind, e.provider ?? null, e.providerPaymentId ?? null, e.contributionId ?? null, e.orgId ?? null,
     JSON.stringify(e.detail ?? {}), e.autoAction ?? null]
  );
  return (res.rowCount ?? 0) > 0;
}

export type CreditResult =
  | { result: 'credited'; orgId: string; amountMismatch: boolean; expectedChargeCents: number }
  | { result: 'already_credited' }
  | { result: 'duplicate'; orgId: string; existingPaymentId: string }
  | { result: 'org_deleted'; orgId: string }
  | { result: 'not_found' };

/**
 * Credit a contribution to its org's pool once its payment is confirmed.
 *
 * Success is authoritative: it credits from 'pending', and also from 'failed'
 * or 'canceled' (events can arrive out of order, and a declined first card
 * attempt must not block the second card's success). The row lock plus the
 * ledger idempotency key make concurrent/replayed deliveries credit once.
 *
 * A *different* successful payment for an already-credited contribution (an
 * invoice paid twice in two tabs) is reported as 'duplicate' — never credited
 * twice; the caller refunds or flags it.
 */
export async function creditContribution(
  contributionId: string,
  providerPaymentId?: string | null,
  opts: { chargedCents?: number | null } = {}
): Promise<CreditResult> {
  return withTransaction(async (client) => {
    const rowRes = await client.query(
      `SELECT c.id, c.org_id, c.amount_cents, c.fee_cents, c.charge_cents, c.status, c.payment_method,
              c.provider_payment_id, c.credited_at,
              EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.org_id) AS org_exists
       FROM billing_contributions c
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [contributionId]
    );
    if (rowRes.rows.length === 0) return { result: 'not_found' } as const;
    const row = rowRes.rows[0];

    if (row.status === 'succeeded' || row.status === 'refunded') {
      if (providerPaymentId && row.provider_payment_id && row.provider_payment_id !== providerPaymentId) {
        return { result: 'duplicate', orgId: row.org_id, existingPaymentId: row.provider_payment_id } as const;
      }
      return { result: 'already_credited' } as const;
    }

    if (!row.org_exists) {
      await client.query(
        `UPDATE billing_contributions
         SET status = 'succeeded', provider_payment_id = COALESCE($2, provider_payment_id),
             last_error = 'organization dissolved before payment confirmed — not credited', updated_at = NOW()
         WHERE id = $1`,
        [contributionId, providerPaymentId ?? null]
      );
      return { result: 'org_deleted', orgId: row.org_id } as const;
    }

    await client.query(
      `UPDATE billing_contributions
       SET status = 'succeeded', credited_at = NOW(), last_error = NULL, updated_at = NOW(),
           provider_payment_id = COALESCE($2, provider_payment_id)
       WHERE id = $1`,
      [contributionId, providerPaymentId ?? null]
    );

    const note = billingEnforced(row.org_id)
      ? `Member contribution (${row.payment_method})`
      : `Member contribution (${row.payment_method}) (enforcement inactive — testing mode)`;
    await applyPoolDelta(client, {
      orgId: row.org_id,
      deltaCents: Number(row.amount_cents),
      kind: 'contribution',
      description: note,
      contributionId,
      idempotencyKey: `contribution:${contributionId}`,
    });

    const expectedCharge = Number(row.charge_cents ?? Number(row.amount_cents) + Number(row.fee_cents));
    const amountMismatch = opts.chargedCents != null && Number(opts.chargedCents) !== expectedCharge;
    return { result: 'credited', orgId: row.org_id, amountMismatch, expectedChargeCents: expectedCharge } as const;
  });
}

/**
 * Final failure / abandonment. Only moves a still-pending row. For checkout
 * expiry, sessionId must match the row's current session — expiring an older
 * session (invoice re-pay) must not cancel the contribution — and admin
 * invoices are never canceled by expiry: the invoice stays payable.
 */
export async function markContributionFailed(
  contributionId: string,
  status: 'failed' | 'canceled',
  providerPaymentId?: string | null,
  sessionId?: string | null
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE billing_contributions
     SET status = $2::varchar,
         provider_payment_id = COALESCE($3, provider_payment_id),
         updated_at = NOW()
     WHERE id = $1 AND status = 'pending'
       AND ($4::text IS NULL OR provider_session_id IS NULL OR provider_session_id = $4)
       AND NOT ($2::varchar = 'canceled' AND source = 'admin_invoice')`,
    [contributionId, status, providerPaymentId ?? null, sessionId ?? null]
  );
  return (res.rowCount ?? 0) > 0;
}

/** ACH in flight: remember the payment id so refunds/disputes/reconciliation can find the row. */
export async function markContributionProcessing(contributionId: string, providerPaymentId: string | null): Promise<void> {
  if (!providerPaymentId) return;
  await pool.query(
    `UPDATE billing_contributions
     SET provider_payment_id = COALESCE(provider_payment_id, $2), updated_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [contributionId, providerPaymentId]
  );
}

export async function noteAttemptFailed(contributionId: string, message: string | null): Promise<void> {
  await pool.query(
    `UPDATE billing_contributions SET last_error = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [contributionId, message ?? 'payment attempt failed']
  );
}

/** Pool reversal owed for a cumulative refund — proportional to the gross charge. */
export function reversalForRefund(amountCents: number, chargeCents: number, refundedChargeCents: number): number {
  if (chargeCents <= 0 || refundedChargeCents <= 0) return 0;
  if (refundedChargeCents >= chargeCents) return amountCents;
  return Math.min(amountCents, Math.round(amountCents * refundedChargeCents / chargeCents));
}

export type RefundResult = 'applied' | 'stale' | 'not_found';

/**
 * Ledger key for a refund reversal. charge.refunded carries only the
 * cumulative refunded total (in this API version the payload doesn't include
 * the refund objects), so the key is the cumulative target. That total only
 * ever grows — except when a refund fails, which lowers it; a later refund
 * reaching the same total must debit again, so each failure starts a new
 * "generation" (count of billing_refund_failures rows) in the key.
 */
async function refundKey(client: PoolClient, contributionId: string, target: number): Promise<string> {
  const g = await client.query(
    `SELECT COUNT(*)::int AS n FROM billing_refund_failures WHERE contribution_id = $1`, [contributionId]
  );
  const gen = Number(g.rows[0].n);
  return gen === 0 ? `refund:${contributionId}:${target}` : `refund:${contributionId}:g${gen}:${target}`;
}

/**
 * A refund failed or was canceled after charge.refunded already reversed its
 * share: give the org back what that refund took. Idempotent per refund id
 * (billing_refund_failures primary key).
 */
export async function applyRefundFailure(
  paymentId: string, refundId: string, refundAmountCents: number, status: string
): Promise<RefundResult> {
  return withTransaction(async (client) => {
    const rowRes = await client.query(
      `SELECT c.id, c.org_id, c.amount_cents, c.fee_cents, c.charge_cents, c.refunded_charge_cents,
              c.reversed_cents, c.dispute_held_cents, c.credited_at, c.status,
              EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.org_id) AS org_exists
       FROM billing_contributions c
       WHERE c.provider_payment_id = $1
       FOR UPDATE OF c`,
      [paymentId]
    );
    if (rowRes.rows.length === 0) return 'not_found';
    const row = rowRes.rows[0];

    const ins = await client.query(
      `INSERT INTO billing_refund_failures (refund_id, contribution_id, amount_cents, status)
       VALUES ($1, $2, $3, $4) ON CONFLICT (refund_id) DO NOTHING RETURNING refund_id`,
      [refundId, row.id, refundAmountCents, status]
    );
    if (ins.rows.length === 0) return 'stale';

    const amount = Number(row.amount_cents);
    const charge = Number(row.charge_cents ?? amount + Number(row.fee_cents));
    const refunded = Math.max(0, Number(row.refunded_charge_cents) - refundAmountCents);
    const target = row.credited_at
      ? Math.min(reversalForRefund(amount, charge, refunded), amount - Number(row.dispute_held_cents))
      : 0;
    const restore = Number(row.reversed_cents) - Math.max(target, 0);

    if (restore > 0 && row.org_exists) {
      await applyPoolDelta(client, {
        orgId: row.org_id,
        deltaCents: restore,
        kind: 'refund',
        description: `Refund ${status} — credit restored`,
        contributionId: row.id,
        idempotencyKey: `refund_failed:${refundId}`,
      });
    }
    await client.query(
      `UPDATE billing_contributions
       SET refunded_charge_cents = $2::int,
           reversed_cents        = LEAST(reversed_cents, $3::int),
           status                = CASE WHEN status = 'refunded' AND $2::int < $4::int THEN 'succeeded' ELSE status END,
           updated_at            = NOW()
       WHERE id = $1`,
      [row.id, refunded, Math.max(target, 0), charge]
    );
    return 'applied';
  });
}

/**
 * Apply a provider-reported cumulative refund total (full or partial).
 * Takes back the proportional share of the credit from the org pool — this
 * can drive the pool negative, which starts the grace clock. Out-of-order or
 * replayed events carrying an equal/older total are no-ops.
 */
export async function applyRefund(paymentId: string, chargeAmountCents: number, amountRefundedCents: number): Promise<RefundResult> {
  return withTransaction(async (client) => {
    const rowRes = await client.query(
      `SELECT c.id, c.org_id, c.amount_cents, c.fee_cents, c.charge_cents, c.refunded_charge_cents,
              c.reversed_cents, c.dispute_held_cents, c.credited_at,
              EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.org_id) AS org_exists
       FROM billing_contributions c
       WHERE c.provider_payment_id = $1
       FOR UPDATE OF c`,
      [paymentId]
    );
    if (rowRes.rows.length === 0) return 'not_found';
    const row = rowRes.rows[0];
    if (amountRefundedCents <= Number(row.refunded_charge_cents)) return 'stale';

    const amount = Number(row.amount_cents);
    const charge = Number(row.charge_cents ?? chargeAmountCents);
    // Nothing reaches the pool twice: what's already held for a dispute or
    // already reversed is excluded.
    const target = row.credited_at
      ? Math.min(reversalForRefund(amount, charge, amountRefundedCents), amount - Number(row.dispute_held_cents))
      : 0;
    const delta = target - Number(row.reversed_cents);

    if (delta > 0 && row.org_exists) {
      await applyPoolDelta(client, {
        orgId: row.org_id,
        deltaCents: -delta,
        kind: 'refund',
        description: amountRefundedCents >= charge ? 'Contribution refunded' : 'Contribution partially refunded',
        contributionId: row.id,
        idempotencyKey: await refundKey(client, row.id, target),
      });
    }

    await client.query(
      `UPDATE billing_contributions
       SET refunded_charge_cents = $2::int,
           reversed_cents        = GREATEST(reversed_cents, $3::int),
           status                = CASE WHEN $2::int >= $4::int THEN 'refunded' ELSE status END,
           updated_at            = NOW()
       WHERE id = $1`,
      [row.id, amountRefundedCents, Math.max(target, 0), charge]
    );
    return 'applied';
  });
}

/**
 * A chargeback withdraws the funds from us immediately, so the credited
 * amount (minus anything already refunded) is held out of the pool until the
 * dispute closes. Inquiries never reach here (see normalizeStripeEvent).
 */
export async function openDispute(paymentId: string, disputeId: string): Promise<'applied' | 'stale' | 'not_found'> {
  return withTransaction(async (client) => {
    const rowRes = await client.query(
      `SELECT c.id, c.org_id, c.amount_cents, c.reversed_cents, c.dispute_id, c.dispute_status, c.credited_at,
              EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.org_id) AS org_exists
       FROM billing_contributions c
       WHERE c.provider_payment_id = $1
       FOR UPDATE OF c`,
      [paymentId]
    );
    if (rowRes.rows.length === 0) return 'not_found';
    const row = rowRes.rows[0];
    if (row.dispute_id === disputeId) return 'stale';

    const hold = row.credited_at && row.org_exists
      ? Math.max(0, Number(row.amount_cents) - Number(row.reversed_cents))
      : 0;
    if (hold > 0) {
      await applyPoolDelta(client, {
        orgId: row.org_id,
        deltaCents: -hold,
        kind: 'dispute_hold',
        description: 'Payment disputed — credit held pending outcome',
        contributionId: row.id,
        idempotencyKey: `dispute_hold:${disputeId}`,
      });
    }
    await client.query(
      `UPDATE billing_contributions
       SET dispute_id = $2, dispute_status = 'open', dispute_held_cents = $3, updated_at = NOW()
       WHERE id = $1`,
      [row.id, disputeId, hold]
    );
    return 'applied';
  });
}

export async function closeDispute(
  paymentId: string,
  disputeId: string,
  outcome: 'won' | 'lost'
): Promise<'applied' | 'stale' | 'not_found'> {
  return withTransaction(async (client) => {
    const rowRes = await client.query(
      `SELECT c.id, c.org_id, c.dispute_id, c.dispute_status, c.dispute_held_cents,
              c.amount_cents, c.fee_cents, c.charge_cents, c.refunded_charge_cents, c.reversed_cents, c.credited_at,
              c.provider_payment_id,
              EXISTS (SELECT 1 FROM organizations o WHERE o.id = c.org_id) AS org_exists
       FROM billing_contributions c
       WHERE c.provider_payment_id = $1
       FOR UPDATE OF c`,
      [paymentId]
    );
    if (rowRes.rows.length === 0) return 'not_found';
    const row = rowRes.rows[0];

    // Closed before (or without) created: Stripe doesn't guarantee order.
    // Record the outcome as final, so a late created sees this dispute id
    // and holds nothing (openDispute's dispute_id check). A lost dispute
    // still takes the credit — the network kept the money — under the same
    // key the hold would have used.
    if (!row.dispute_id) {
      let taken = 0;
      if (outcome === 'lost' && row.credited_at && row.org_exists) {
        taken = Math.max(0, Number(row.amount_cents) - Number(row.reversed_cents));
        if (taken > 0) {
          await applyPoolDelta(client, {
            orgId: row.org_id,
            deltaCents: -taken,
            kind: 'dispute_hold',
            description: 'Dispute lost — credit withdrawn',
            contributionId: row.id,
            idempotencyKey: `dispute_hold:${disputeId}`,
          });
        }
      }
      await client.query(
        `UPDATE billing_contributions
         SET dispute_id = $2, dispute_status = $3::varchar, dispute_held_cents = $4, updated_at = NOW()
         WHERE id = $1`,
        [row.id, disputeId, outcome, taken]
      );
      if (outcome === 'lost') {
        await recordException({
          kind: 'dispute_lost', provider: 'stripe', providerPaymentId: paymentId,
          contributionId: row.id, orgId: row.org_id, detail: { disputeId, held_cents: taken, closed_before_created: true },
        }, client);
      }
      return 'applied';
    }
    if (row.dispute_status !== 'open' || row.dispute_id !== disputeId) return 'stale';

    const held = Number(row.dispute_held_cents);
    if (outcome === 'won' && held > 0 && row.org_exists) {
      await applyPoolDelta(client, {
        orgId: row.org_id,
        deltaCents: held,
        kind: 'dispute_release',
        description: 'Dispute won — held credit restored',
        contributionId: row.id,
        idempotencyKey: `dispute_release:${disputeId}`,
      });
    }
    // A refund that landed while the credit was held reversed nothing (the
    // held part is excluded in applyRefund), so releasing the whole hold
    // would hand the refunded money back to the pool. Take the refund's
    // share now that it is no longer held.
    let reversed = Number(row.reversed_cents);
    if (outcome === 'won' && row.credited_at && row.org_exists && Number(row.refunded_charge_cents) > 0) {
      const amount = Number(row.amount_cents);
      const charge = Number(row.charge_cents ?? amount + Number(row.fee_cents));
      const target = reversalForRefund(amount, charge, Number(row.refunded_charge_cents));
      if (target > reversed) {
        await applyPoolDelta(client, {
          orgId: row.org_id,
          deltaCents: -(target - reversed),
          kind: 'refund',
          description: 'Refund applied after dispute hold released',
          contributionId: row.id,
          idempotencyKey: await refundKey(client, row.id, target),
        });
        reversed = target;
      }
    }
    await client.query(
      `UPDATE billing_contributions
       SET dispute_status = $2::varchar,
           dispute_held_cents = CASE WHEN $2::varchar = 'won' THEN 0 ELSE dispute_held_cents END,
           reversed_cents = $3::int,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, outcome, reversed]
    );
    if (outcome === 'lost') {
      await recordException({
        kind: 'dispute_lost', provider: 'stripe', providerPaymentId: paymentId,
        contributionId: row.id, orgId: row.org_id, detail: { disputeId, held_cents: held },
      }, client);
    }
    return 'applied';
  });
}
