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
}

export interface CheckoutResult {
  /** true = payment settled synchronously (dev provider); no redirect needed */
  immediate: boolean;
  redirectUrl?: string;
  providerSessionId?: string;
  providerPaymentId?: string;
}

export interface PaymentProvider {
  name: 'dev' | 'stripe';
  createCheckout(params: CheckoutParams): Promise<CheckoutResult>;
}
