// Provider-neutral billing events. The webhook route translates provider
// payloads (Stripe today) into these; utils/billingEvents.ts applies them.
// Keeping the translation pure makes it testable from fixture payloads with
// no network or signature involved.

export type BillingEvent =
  /** Money is confirmed. Authoritative: credits from pending, failed or canceled. */
  | { kind: 'payment_succeeded'; contributionId: string | null; paymentId: string; amountCents: number | null }
  /** Checkout finished but the money is still in flight (ACH: ~4 business days). */
  | { kind: 'payment_processing'; contributionId: string | null; paymentId: string | null }
  /** One attempt failed (e.g. a declined card) — the checkout may still be retried. Not final. */
  | { kind: 'payment_attempt_failed'; contributionId: string | null; paymentId: string; message: string | null }
  /** Final failure (e.g. ACH debit returned before success). */
  | { kind: 'payment_failed'; contributionId: string | null; paymentId: string | null }
  | { kind: 'checkout_expired'; contributionId: string | null; sessionId: string }
  /** Cumulative refunded amount on a payment changed. */
  | { kind: 'refund_updated'; paymentId: string; chargeAmountCents: number; amountRefundedCents: number }
  /** An issued refund failed or was canceled — its amount is no longer refunded. */
  | { kind: 'refund_failed'; paymentId: string; refundId: string; amountCents: number; status: string }
  | { kind: 'dispute_opened'; paymentId: string; disputeId: string; amountCents: number }
  | { kind: 'dispute_closed'; paymentId: string; disputeId: string; outcome: 'won' | 'lost' }
  | { kind: 'ignored'; reason: string };
