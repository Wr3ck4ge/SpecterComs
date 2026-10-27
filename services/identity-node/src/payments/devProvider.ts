import { PaymentProvider, CheckoutParams, CheckoutResult } from './PaymentProvider.js';
import { creditContribution } from '../utils/billingCredit.js';

/** Development provider: no external calls, payment succeeds instantly. */
export const devProvider: PaymentProvider = {
  name: 'dev',

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    const providerPaymentId = `dev_${params.contributionId}`;
    await creditContribution(params.contributionId, providerPaymentId);
    return { immediate: true, providerPaymentId };
  },
};
