import Stripe from 'stripe';
import { PaymentProvider, CheckoutParams, CheckoutResult } from './PaymentProvider.js';

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
    stripeClient = new Stripe(key);
  }
  return stripeClient;
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
          product_data: { name: `${params.orgName} — pool contribution` },
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
      metadata: { contribution_id: params.contributionId, org_id: params.orgId, user_id: params.userId },
      payment_intent_data: {
        metadata: { contribution_id: params.contributionId, org_id: params.orgId, user_id: params.userId },
      },
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });

    return {
      immediate: false,
      redirectUrl: session.url ?? undefined,
      providerSessionId: session.id,
      providerPaymentId: typeof session.payment_intent === 'string' ? session.payment_intent : undefined,
    };
  },
};

export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}
