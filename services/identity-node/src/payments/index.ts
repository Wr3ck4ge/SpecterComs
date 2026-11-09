import { PaymentProvider } from './PaymentProvider.js';
import { devProvider } from './devProvider.js';

export type PaymentsMode = 'disabled' | 'dev' | 'test' | 'live';

export interface PaymentsStatus {
  enabled: boolean;
  provider: 'stripe' | 'dev' | null;
  mode: PaymentsMode;
  /** Why payments are disabled (operator-facing; logged, not shown to members). */
  reason?: string;
}

/** 'test' | 'live' from a Stripe key prefix, or null when the key is unrecognised. */
export function stripeKeyMode(key: string | undefined): 'test' | 'live' | null {
  if (!key) return null;
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  return null;
}

/**
 * Single source of truth for "can this server take money right now".
 *
 * - Unset PAYMENTS_PROVIDER → disabled (contribute/pay return 503). This is the
 *   shipped default: billing stays dormant until someone deliberately turns it on.
 * - `dev` credits pools for free, so it refuses to run with NODE_ENV=production
 *   unless BILLING_ALLOW_DEV_PROVIDER=true is set as well.
 * - `stripe` needs BOTH the secret key and the webhook secret. Without the
 *   webhook secret, checkouts would succeed and take money but no pool would
 *   ever be credited.
 * - A live key (sk_live_/rk_live_) additionally needs BILLING_ALLOW_LIVE=true,
 *   so a pasted live key can never start charging real cards by accident.
 */
export function paymentsStatus(): PaymentsStatus {
  const provider = process.env.PAYMENTS_PROVIDER;

  if (provider === 'dev') {
    if (process.env.NODE_ENV === 'production' && process.env.BILLING_ALLOW_DEV_PROVIDER !== 'true') {
      return { enabled: false, provider: null, mode: 'disabled', reason: 'dev provider refused in production (set BILLING_ALLOW_DEV_PROVIDER=true to override)' };
    }
    return { enabled: true, provider: 'dev', mode: 'dev' };
  }

  if (provider === 'stripe') {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return { enabled: false, provider: null, mode: 'disabled', reason: 'STRIPE_SECRET_KEY is not set' };
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return { enabled: false, provider: null, mode: 'disabled', reason: 'STRIPE_WEBHOOK_SECRET is not set' };
    }
    const mode = stripeKeyMode(key);
    if (!mode) return { enabled: false, provider: null, mode: 'disabled', reason: 'STRIPE_SECRET_KEY is not a recognised sk_/rk_ key' };
    if (mode === 'live' && process.env.BILLING_ALLOW_LIVE !== 'true') {
      return { enabled: false, provider: null, mode: 'disabled', reason: 'live Stripe key present but BILLING_ALLOW_LIVE is not true' };
    }
    return { enabled: true, provider: 'stripe', mode };
  }

  return { enabled: false, provider: null, mode: 'disabled', reason: 'PAYMENTS_PROVIDER is not set' };
}

export function paymentsEnabled(): boolean {
  return paymentsStatus().enabled;
}

let providerOverride: PaymentProvider | null = null;

/** Tests only: route all provider calls to a fake. Pass null to restore. */
export function setPaymentProviderForTests(p: PaymentProvider | null): void {
  providerOverride = p;
}

/**
 * The active provider. Throws when payments are disabled — callers gate on
 * paymentsEnabled() first. (It used to fall back to the dev provider, which
 * credits pools for free, whenever Stripe was half-configured.)
 */
export async function getPaymentProvider(): Promise<PaymentProvider> {
  if (providerOverride) return providerOverride;
  const status = paymentsStatus();
  if (!status.enabled) throw new Error(`Payments are disabled: ${status.reason}`);
  if (status.provider === 'stripe') {
    // Lazy import so the stripe package is never loaded in dev mode
    const { stripeProvider } = await import('./stripeProvider.js');
    return stripeProvider;
  }
  return devProvider;
}

/**
 * The provider for after-the-fact operations on an existing payment (refunds,
 * reconciliation). Unlike getPaymentProvider this doesn't care whether NEW
 * checkouts are enabled — a refund must still be possible after payments are
 * switched off — only that the provider the payment went through is usable.
 */
export async function getProviderByName(name: string): Promise<PaymentProvider | null> {
  if (providerOverride) return providerOverride;
  if (name === 'stripe') {
    if (!process.env.STRIPE_SECRET_KEY) return null;
    const { stripeProvider } = await import('./stripeProvider.js');
    return stripeProvider;
  }
  if (name === 'dev') return devProvider;
  return null;
}
