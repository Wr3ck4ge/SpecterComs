import crypto from 'crypto';
import Stripe from 'stripe';
import {
  PaymentProvider, CheckoutParams, CheckoutResult, ExpireCheckoutResult, ProviderPayment,
} from './PaymentProvider.js';
import type { BillingEvent } from './events.js';
import { stripeKeyMode } from './index.js';

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

/** Tests only: inject a stub client (or null to reset). */
export function setStripeClientForTests(client: Stripe | null): void {
  stripeClient = client;
}

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

export const stripeProvider: PaymentProvider = {
  name: 'stripe',

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    const stripe = getStripe();

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: params.netCents,
          product_data: { name: `${params.orgName} — server credit` },
        },
      },
    ];
    if (params.method === 'card' && params.feeCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: params.feeCents,
          product_data: { name: 'Card processing fee' },
        },
      });
    }

    const metadata = { contribution_id: params.contributionId, org_id: params.orgId, user_id: params.userId };
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: params.method === 'card' ? ['card'] : ['us_bank_account'],
      ...(params.method === 'ach' && {
        payment_method_options: {
          us_bank_account: {
            financial_connections: { permissions: ['payment_method'] },
          },
        },
      }),
      line_items: lineItems,
      // client_reference_id shows in the dashboard and in reconciliation exports
      client_reference_id: params.contributionId,
      metadata,
      payment_intent_data: { metadata },
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    }, {
      // A retried request (network blip) must not open a second session.
      idempotencyKey: `checkout:${params.contributionId}:${params.attempt ?? 0}`,
    });

    return {
      immediate: false,
      redirectUrl: session.url ?? undefined,
      providerSessionId: session.id,
      providerPaymentId: idOf(session.payment_intent) ?? undefined,
    };
  },

  async expireCheckout(sessionId: string): Promise<ExpireCheckoutResult> {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === 'complete') return 'completed';
    if (session.status === 'expired') return 'already_closed';
    try {
      await stripe.checkout.sessions.expire(sessionId);
      return 'expired';
    } catch (err) {
      // Lost a race with the payer finishing it.
      const again = await stripe.checkout.sessions.retrieve(sessionId);
      if (again.status === 'complete') return 'completed';
      if (again.status === 'expired') return 'already_closed';
      throw err;
    }
  },

  async refund(paymentId: string, amountCents?: number, reason?: string, idempotencyKey?: string) {
    const refund = await getStripe().refunds.create({
      payment_intent: paymentId,
      ...(amountCents !== undefined && { amount: amountCents }),
      metadata: reason ? { reason } : undefined,
    }, {
      // Keyed on the request, never on the amount: an amount-based key merges
      // two deliberate identical partial refunds within Stripe's 24 h
      // idempotency window into one. Without an explicit key the reason
      // stands in (the admin endpoint passes `admin:<request_id>`, which
      // keeps a double-click to one refund), else a fresh key.
      idempotencyKey: `refund:${paymentId}:${idempotencyKey ?? reason ?? crypto.randomUUID()}`,
    });
    return { refundId: refund.id };
  },

  async listPayments(since: Date, until: Date): Promise<ProviderPayment[]> {
    const out: ProviderPayment[] = [];
    const list = getStripe().paymentIntents.list({
      created: { gte: Math.floor(since.getTime() / 1000), lt: Math.floor(until.getTime() / 1000) },
      limit: 100,
      expand: ['data.latest_charge'],
    });
    for await (const pi of list) {
      const charge = (pi.latest_charge && typeof pi.latest_charge !== 'string') ? pi.latest_charge : null;
      out.push({
        paymentId: pi.id,
        contributionId: pi.metadata?.contribution_id ?? null,
        status: pi.status === 'succeeded' ? 'succeeded'
          : pi.status === 'processing' ? 'processing'
          : pi.status === 'canceled' ? 'canceled'
          : pi.status === 'requires_payment_method' && pi.last_payment_error ? 'failed'
          : 'other',
        amountCents: pi.amount_received || pi.amount,
        amountRefundedCents: charge?.amount_refunded ?? 0,
        disputed: charge?.disputed ?? false,
        livemode: pi.livemode,
        createdAt: new Date(pi.created * 1000),
      });
    }
    return out;
  },
};

/**
 * Verify a webhook payload. Uses the static verifier, so it works even when new
 * checkouts are disabled — refunds and disputes keep arriving for weeks after.
 * constructEvent also enforces Stripe's default 300 s timestamp tolerance, so
 * a captured payload can't be replayed later.
 */
export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/** The API version this SDK build is typed against (and sends on API calls). */
export const STRIPE_API_VERSION: string = Stripe.API_VERSION;

const warnedApiVersions = new Set<string>();

/**
 * Webhook payloads are rendered in the endpoint's API version, which can
 * differ from the SDK's; field shapes may then not match the types this code
 * was written against. Logged once per version.
 */
export function warnOnApiVersionMismatch(event: Pick<Stripe.Event, 'api_version' | 'id'>): boolean {
  const v = event.api_version;
  if (!v || v === STRIPE_API_VERSION) return false;
  if (!warnedApiVersions.has(v)) {
    warnedApiVersions.add(v);
    console.warn(`[billing] webhook ${event.id} uses Stripe API version ${v}, but the SDK is pinned to ${STRIPE_API_VERSION} — create the webhook endpoint with api_version ${STRIPE_API_VERSION}`);
  }
  return true;
}

/** Whether a verified event belongs to the mode of the configured key. */
export function eventModeMatchesKey(event: Pick<Stripe.Event, 'livemode'>): boolean {
  const mode = stripeKeyMode(process.env.STRIPE_SECRET_KEY);
  if (!mode) return true; // no key to compare against; the signature already proved origin
  return event.livemode === (mode === 'live');
}

/**
 * Translate a verified Stripe event into a BillingEvent.
 *
 * Checkout-based flow (what createCheckout uses), per Stripe's guidance:
 *  - checkout.session.completed + payment_status 'paid'  → card money is in
 *  - checkout.session.completed + 'unpaid'                → ACH in flight
 *  - checkout.session.async_payment_succeeded / _failed   → ACH outcome
 *  - checkout.session.expired                             → abandoned
 * payment_intent.succeeded is kept as a second, authoritative success signal.
 * payment_intent.payment_failed is NOT final inside Checkout: a declined card
 * leaves the session open for another card. Treating it as final (as the old
 * handler did) marked the contribution failed, and the retry's success was
 * then never credited.
 */
export function normalizeStripeEvent(event: Stripe.Event): BillingEvent {
  const obj = event.data.object as any;
  switch (event.type) {
    case 'checkout.session.completed': {
      const s = obj as Stripe.Checkout.Session;
      const contributionId = s.metadata?.contribution_id ?? null;
      const paymentId = idOf(s.payment_intent);
      if (s.payment_status === 'paid' && paymentId) {
        return { kind: 'payment_succeeded', contributionId, paymentId, amountCents: s.amount_total };
      }
      return { kind: 'payment_processing', contributionId, paymentId };
    }
    case 'checkout.session.async_payment_succeeded': {
      const s = obj as Stripe.Checkout.Session;
      const paymentId = idOf(s.payment_intent);
      if (!paymentId) return { kind: 'ignored', reason: 'async success without payment_intent' };
      return { kind: 'payment_succeeded', contributionId: s.metadata?.contribution_id ?? null, paymentId, amountCents: s.amount_total };
    }
    case 'checkout.session.async_payment_failed': {
      const s = obj as Stripe.Checkout.Session;
      return { kind: 'payment_failed', contributionId: s.metadata?.contribution_id ?? null, paymentId: idOf(s.payment_intent) };
    }
    case 'checkout.session.expired': {
      const s = obj as Stripe.Checkout.Session;
      return { kind: 'checkout_expired', contributionId: s.metadata?.contribution_id ?? null, sessionId: s.id };
    }
    case 'payment_intent.succeeded': {
      const pi = obj as Stripe.PaymentIntent;
      return { kind: 'payment_succeeded', contributionId: pi.metadata?.contribution_id ?? null, paymentId: pi.id, amountCents: pi.amount_received };
    }
    case 'payment_intent.payment_failed': {
      const pi = obj as Stripe.PaymentIntent;
      return {
        kind: 'payment_attempt_failed',
        contributionId: pi.metadata?.contribution_id ?? null,
        paymentId: pi.id,
        message: pi.last_payment_error?.message ?? null,
      };
    }
    case 'charge.refunded': {
      const ch = obj as Stripe.Charge;
      const paymentId = idOf(ch.payment_intent);
      if (!paymentId) return { kind: 'ignored', reason: 'refund on charge without payment_intent' };
      return { kind: 'refund_updated', paymentId, chargeAmountCents: ch.amount, amountRefundedCents: ch.amount_refunded };
    }
    case 'charge.refund.updated': {
      // Only a failure/cancellation changes money: Stripe lowers the charge's
      // amount_refunded, which charge.refunded (cumulative, never lowered by
      // us) would otherwise never undo.
      const r = obj as Stripe.Refund;
      if (r.status !== 'failed' && r.status !== 'canceled') return { kind: 'ignored', reason: `refund ${r.status}` };
      const paymentId = idOf(r.payment_intent);
      if (!paymentId) return { kind: 'ignored', reason: 'refund without payment_intent' };
      return { kind: 'refund_failed', paymentId, refundId: r.id, amountCents: r.amount, status: r.status };
    }
    case 'charge.dispute.created': {
      const d = obj as Stripe.Dispute;
      const paymentId = idOf(d.payment_intent);
      if (!paymentId) return { kind: 'ignored', reason: 'dispute without payment_intent' };
      // Inquiries (warning_*) don't withdraw funds — nothing to hold. Nor does
      // a 'prevented' one (resolved by a prevention network, typically with a
      // refund that arrives as charge.refunded).
      if (d.status.startsWith('warning')) return { kind: 'ignored', reason: `inquiry ${d.status}` };
      if (d.status === 'prevented') return { kind: 'ignored', reason: 'dispute prevented' };
      return { kind: 'dispute_opened', paymentId, disputeId: d.id, amountCents: d.amount };
    }
    case 'charge.dispute.closed': {
      const d = obj as Stripe.Dispute;
      const paymentId = idOf(d.payment_intent);
      if (!paymentId) return { kind: 'ignored', reason: 'dispute without payment_intent' };
      if (d.status === 'warning_closed') return { kind: 'ignored', reason: 'inquiry closed' };
      return { kind: 'dispute_closed', paymentId, disputeId: d.id, outcome: d.status === 'lost' ? 'lost' : 'won' };
    }
    default:
      return { kind: 'ignored', reason: `unhandled event type ${event.type}` };
  }
}

/** Every event type normalizeStripeEvent acts on — register exactly these on the endpoint. */
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.refund.updated',
  'charge.dispute.created',
  'charge.dispute.closed',
] as const;
