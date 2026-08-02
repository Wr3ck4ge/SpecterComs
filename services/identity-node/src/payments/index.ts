import { PaymentProvider } from './PaymentProvider.js';
import { devProvider } from './devProvider.js';

export function paymentsEnabled(): boolean {
  return process.env.PAYMENTS_PROVIDER === 'stripe'
    ? Boolean(process.env.STRIPE_SECRET_KEY)
    : process.env.PAYMENTS_PROVIDER === 'dev';
}

export async function getPaymentProvider(): Promise<PaymentProvider> {
  if (process.env.PAYMENTS_PROVIDER === 'stripe' && process.env.STRIPE_SECRET_KEY) {
    // Lazy import so the stripe package is never loaded in dev mode
    const { stripeProvider } = await import('./stripeProvider.js');
    return stripeProvider;
  }
  return devProvider;
}
