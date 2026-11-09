// Card fee handling. Rates and the absorb/pass-through choice come from
// config/billingConfig.ts.
//
// pass_through: the org pool must net exactly the intended amount after the
// processor takes its cut, so the charge is solved from
// charge * (1 - PCT) - FIXED >= net rather than a flat percentage markup.
// absorb: the member is charged exactly the net amount; the platform eats the fee.

import { getBillingConfig } from '../config/billingConfig.js';
import type { PaymentMethod } from '../payments/PaymentProvider.js';

export function cardGrossUp(netCents: number, percent?: number, fixedCents?: number): { chargeCents: number; feeCents: number } {
  const cfg = getBillingConfig();
  const pct = percent ?? cfg.cardFeePercent;
  const fixed = fixedCents ?? cfg.cardFeeFixedCents;
  if (!Number.isInteger(netCents) || netCents <= 0) {
    throw new Error('netCents must be a positive whole number');
  }
  const chargeCents = Math.ceil((netCents + fixed) / (1 - pct / 100));
  return { chargeCents, feeCents: chargeCents - netCents };
}

/** What the payer is charged for a given net pool credit and method. */
export function quoteCharge(netCents: number, method: PaymentMethod): { chargeCents: number; feeCents: number } {
  if (method === 'card' && getBillingConfig().cardFeeMode === 'pass_through') {
    return cardGrossUp(netCents);
  }
  return { chargeCents: netCents, feeCents: 0 };
}

/** Processor cost estimate for a charge — used for reporting, never for crediting. */
export function estimateProcessorFeeCents(chargeCents: number, method: PaymentMethod): number {
  if (method === 'ach') return Math.min(500, Math.ceil(chargeCents * 0.008));
  const cfg = getBillingConfig();
  return Math.ceil(chargeCents * cfg.cardFeePercent / 100) + cfg.cardFeeFixedCents;
}

/**
 * Validate an amount for a method against the configured limits.
 * Returns an error message, or null when acceptable.
 */
export function validateContributionAmount(netCents: unknown, method: PaymentMethod): string | null {
  const cfg = getBillingConfig();
  if (typeof netCents !== 'number' || !Number.isInteger(netCents)) {
    return 'amount_cents must be a whole number of cents';
  }
  if (netCents < cfg.minContributionCents) {
    return `amount_cents must be at least ${cfg.minContributionCents}`;
  }
  if (netCents > cfg.maxContributionCents) {
    return `amount_cents must be at most ${cfg.maxContributionCents}`;
  }
  if (method === 'card' && netCents < cfg.cardMinContributionCents) {
    return `card payments must be at least ${cfg.cardMinContributionCents} cents — use a bank transfer for smaller amounts`;
  }
  return null;
}
