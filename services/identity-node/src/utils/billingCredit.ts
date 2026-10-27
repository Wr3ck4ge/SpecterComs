import { pool } from '../config/db.js';

/**
 * Idempotently credit a pending contribution to its org's pool.
 * Safe against webhook retries: the status flip from 'pending' is the guard —
 * if another call already succeeded it, zero rows return and nothing is credited.
 * Returns true if this call performed the credit.
 */
export async function creditContribution(
  contributionId: string,
  providerPaymentId?: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const upd = await client.query(
      `UPDATE billing_contributions
       SET status = 'succeeded',
           credited_at = NOW(),
           provider_payment_id = COALESCE($2, provider_payment_id)
       WHERE id = $1 AND status = 'pending'
       RETURNING org_id, user_id, amount_cents, payment_method`,
      [contributionId, providerPaymentId ?? null]
    );
    if (upd.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const { org_id, amount_cents, payment_method } = upd.rows[0];

    await client.query(
      `INSERT INTO org_billing (org_id, balance_cents)
       VALUES ($1, $2)
       ON CONFLICT (org_id) DO UPDATE SET
         balance_cents = org_billing.balance_cents + EXCLUDED.balance_cents,
         updated_at    = NOW()`,
      [org_id, amount_cents]
    );

    const note = process.env.BILLING_ENFORCE === 'true'
      ? `Member contribution (${payment_method})`
      : `Member contribution (${payment_method}) (enforcement inactive — testing mode)`;
    await client.query(
      `INSERT INTO billing_ledger (org_id, delta_cents, description)
       VALUES ($1, $2, $3)`,
      [org_id, amount_cents, note]
    );

    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function markContributionFailed(
  contributionId: string,
  status: 'failed' | 'canceled',
  providerPaymentId?: string
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE billing_contributions
     SET status = $2,
         provider_payment_id = COALESCE($3, provider_payment_id)
     WHERE id = $1 AND status = 'pending'`,
    [contributionId, status, providerPaymentId ?? null]
  );
  return (res.rowCount ?? 0) > 0;
}
