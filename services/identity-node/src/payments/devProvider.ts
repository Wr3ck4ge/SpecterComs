import { PaymentProvider, CheckoutParams, CheckoutResult } from './PaymentProvider.js';
import { pool } from '../config/db.js';

/**
 * Development provider: no external calls, payment succeeds instantly.
 * Refused in production unless BILLING_ALLOW_DEV_PROVIDER=true (payments/index.ts).
 * Credits go through the same processBillingEvent path a Stripe webhook uses,
 * so dev mode exercises the real ledger code.
 */
export const devProvider: PaymentProvider = {
  name: 'dev',

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    const providerPaymentId = `dev_${params.contributionId}_${params.attempt ?? 0}`;
    const { processBillingEvent } = await import('../utils/billingEvents.js');
    await processBillingEvent(
      { kind: 'payment_succeeded', contributionId: params.contributionId, paymentId: providerPaymentId, amountCents: params.chargeCents },
      'dev'
    );
    return { immediate: true, providerPaymentId };
  },

  async expireCheckout() {
    return 'already_closed';
  },

  /** Simulates the provider confirming the refund right away. */
  async refund(paymentId: string, amountCents?: number) {
    const res = await pool.query(
      `SELECT charge_cents, amount_cents, fee_cents, refunded_charge_cents
       FROM billing_contributions WHERE provider_payment_id = $1`,
      [paymentId]
    );
    if (res.rows.length === 0) throw new Error(`dev refund: unknown payment ${paymentId}`);
    const row = res.rows[0];
    const charge = Number(row.charge_cents ?? Number(row.amount_cents) + Number(row.fee_cents));
    const already = Number(row.refunded_charge_cents);
    const total = Math.min(charge, already + (amountCents ?? charge - already));
    const { processBillingEvent } = await import('../utils/billingEvents.js');
    await processBillingEvent({ kind: 'refund_updated', paymentId, chargeAmountCents: charge, amountRefundedCents: total }, 'dev');
    return { refundId: `dev_refund_${paymentId}_${total}` };
  },

  async listPayments() {
    return [];
  },
};
