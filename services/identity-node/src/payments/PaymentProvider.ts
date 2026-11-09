export type PaymentMethod = 'card' | 'ach';

export interface CheckoutParams {
  contributionId: string;
  orgId: string;
  orgName: string;
  userId: string;
  netCents: number;
  feeCents: number;
  chargeCents: number;
  method: PaymentMethod;
  successUrl: string;
  cancelUrl: string;
  /** Distinguishes repeat checkouts for the same contribution (invoice re-pay). */
  attempt?: number;
}

export interface CheckoutResult {
  /** true = payment settled synchronously (dev provider); no redirect needed */
  immediate: boolean;
  redirectUrl?: string;
  providerSessionId?: string;
  providerPaymentId?: string;
}

/** Outcome of trying to close an earlier checkout before opening a new one. */
export type ExpireCheckoutResult =
  | 'expired'         // closed; it can no longer take money
  | 'already_closed'  // was already expired/never existed
  | 'completed';      // the payer already finished it — money is (or will be) in flight

/** Provider-side view of one payment, normalized for reconciliation. */
export interface ProviderPayment {
  paymentId: string;
  contributionId: string | null;
  status: 'succeeded' | 'processing' | 'failed' | 'canceled' | 'other';
  amountCents: number;
  amountRefundedCents: number;
  disputed: boolean;
  livemode: boolean;
  createdAt: Date;
}

export interface PaymentProvider {
  name: 'dev' | 'stripe';
  createCheckout(params: CheckoutParams): Promise<CheckoutResult>;
  expireCheckout(sessionId: string): Promise<ExpireCheckoutResult>;
  /**
   * Issues a refund at the provider. The ledger reversal happens when the
   * provider confirms it. `idempotencyKey` must identify the refund REQUEST
   * (e.g. the admin's request_id), never its amount: two deliberate refunds
   * of the same amount are two refunds. Omitted = keyed on `reason`, or a
   * fresh key when there is none.
   */
  refund(paymentId: string, amountCents?: number, reason?: string, idempotencyKey?: string): Promise<{ refundId: string }>;
  /** Payments created in [since, until), for reconciliation. */
  listPayments(since: Date, until: Date): Promise<ProviderPayment[]>;
}
