import type { BillingEvent } from '../payments/events.js';
import { getProviderByName } from '../payments/index.js';
import { getBillingConfig } from '../config/billingConfig.js';
import { pool } from '../config/db.js';
import {
  creditContribution, markContributionFailed, markContributionProcessing, noteAttemptFailed,
  applyRefund, applyRefundFailure, openDispute, closeDispute, recordException,
} from './billingCredit.js';

export interface ProcessOutcome {
  kind: BillingEvent['kind'];
  result: string;
}

/**
 * Apply one provider-neutral billing event. Every branch is idempotent, so
 * the same event may be delivered any number of times, concurrently, or out
 * of order. Throws only on infrastructure errors (DB down) — the webhook
 * then answers 500 and the provider retries.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function processBillingEvent(input: BillingEvent, providerName = 'stripe'): Promise<ProcessOutcome> {
  const cfg = getBillingConfig();

  // contribution_id comes from provider metadata, which anyone with dashboard
  // access (or a Payment Link) can set. A malformed one used to reach the
  // uuid column and raise 22P02 on every retry; treat it as "no match".
  let ev = input;
  let badContributionId: string | null = null;
  if ('contributionId' in ev && ev.contributionId != null && !UUID_RE.test(ev.contributionId)) {
    badContributionId = String(ev.contributionId).slice(0, 100);
    ev = { ...ev, contributionId: null };
  }

  switch (ev.kind) {
    case 'payment_succeeded': {
      if (!ev.contributionId) {
        await recordException({
          kind: 'unmatched_payment', provider: providerName, providerPaymentId: ev.paymentId,
          detail: {
            amount_cents: ev.amountCents,
            note: badContributionId ? 'payment carries a malformed contribution_id' : 'payment carries no contribution_id metadata',
            ...(badContributionId && { contribution_id: badContributionId }),
          },
        });
        return { kind: ev.kind, result: 'unmatched' };
      }
      const r = await creditContribution(ev.contributionId, ev.paymentId, { chargedCents: ev.amountCents });
      switch (r.result) {
        case 'credited':
          if (r.amountMismatch) {
            await recordException({
              kind: 'amount_mismatch', provider: providerName, providerPaymentId: ev.paymentId,
              contributionId: ev.contributionId, orgId: r.orgId,
              detail: { charged_cents: ev.amountCents, expected_charge_cents: r.expectedChargeCents },
            });
          }
          return { kind: ev.kind, result: 'credited' };
        case 'already_credited':
          return { kind: ev.kind, result: 'already_credited' };
        case 'not_found':
          await recordException({
            kind: 'unmatched_payment', provider: providerName, providerPaymentId: ev.paymentId,
            contributionId: ev.contributionId, detail: { amount_cents: ev.amountCents },
          });
          return { kind: ev.kind, result: 'unmatched' };
        case 'duplicate': {
          const refund = cfg.autoRefundDuplicatePayments;
          const isNew = await recordException({
            kind: 'duplicate_payment', provider: providerName, providerPaymentId: ev.paymentId,
            contributionId: ev.contributionId, orgId: r.orgId,
            detail: { amount_cents: ev.amountCents, credited_payment_id: r.existingPaymentId },
            autoAction: refund ? 'refund_requested' : null,
          });
          if (refund && isNew) await refundQuietly(providerName, ev.paymentId, 'duplicate_payment');
          return { kind: ev.kind, result: 'duplicate' };
        }
        case 'org_deleted': {
          const refund = cfg.autoRefundOrphanPayments;
          const isNew = await recordException({
            kind: 'org_deleted', provider: providerName, providerPaymentId: ev.paymentId,
            contributionId: ev.contributionId, orgId: r.orgId, detail: { amount_cents: ev.amountCents },
            autoAction: refund ? 'refund_requested' : null,
          });
          if (refund && isNew) await refundQuietly(providerName, ev.paymentId, 'org_deleted');
          return { kind: ev.kind, result: 'org_deleted' };
        }
      }
      return { kind: ev.kind, result: 'unknown' };
    }

    case 'payment_processing':
      if (ev.contributionId) await markContributionProcessing(ev.contributionId, ev.paymentId);
      return { kind: ev.kind, result: 'processing' };

    case 'payment_attempt_failed':
      if (ev.contributionId) await noteAttemptFailed(ev.contributionId, ev.message);
      return { kind: ev.kind, result: 'noted' };

    case 'payment_failed':
      if (ev.contributionId) await markContributionFailed(ev.contributionId, 'failed', ev.paymentId);
      return { kind: ev.kind, result: 'failed' };

    case 'checkout_expired':
      if (ev.contributionId) await markContributionFailed(ev.contributionId, 'canceled', null, ev.sessionId);
      return { kind: ev.kind, result: 'expired' };

    case 'refund_updated':
      return { kind: ev.kind, result: await applyRefund(ev.paymentId, ev.chargeAmountCents, ev.amountRefundedCents) };

    case 'refund_failed':
      return { kind: ev.kind, result: await applyRefundFailure(ev.paymentId, ev.refundId, ev.amountCents, ev.status) };

    case 'dispute_opened':
      return { kind: ev.kind, result: await openDispute(ev.paymentId, ev.disputeId) };

    case 'dispute_closed':
      return { kind: ev.kind, result: await closeDispute(ev.paymentId, ev.disputeId, ev.outcome) };

    case 'ignored':
      return { kind: ev.kind, result: ev.reason };
  }
}

/**
 * Auto-refund for duplicate/orphan payments. A failure here must not fail the
 * webhook (the exception row is already recorded for a human to finish).
 */
async function refundQuietly(providerName: string, paymentId: string, reason: 'duplicate_payment' | 'org_deleted'): Promise<void> {
  let action = 'refunded';
  try {
    const provider = await getProviderByName(providerName);
    if (!provider) throw new Error(`provider ${providerName} unavailable`);
    // One automatic full refund per payment, ever.
    await provider.refund(paymentId, undefined, reason, `auto_refund:${reason}:${paymentId}`);
    console.log(`[billing] auto-refunded ${paymentId} (${reason})`);
  } catch (err) {
    action = 'refund_failed';
    console.error(`[billing] auto-refund of ${paymentId} failed — resolve from the exceptions queue:`, err);
  }
  await pool.query(
    `UPDATE billing_payment_exceptions SET auto_action = $3
     WHERE kind = $1 AND provider_payment_id = $2 AND resolved_at IS NULL`,
    [reason, paymentId, action]
  );
}
