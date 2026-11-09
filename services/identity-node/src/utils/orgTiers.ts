// Organization tier definitions.
// A "voice server" is an organization — tier governs its capacity, media quality,
// and per-cycle data consumption limit/price. member-hours is intentionally NOT
// tracked/billed (explicit product decision overriding docs/PRICING_MODEL_2026_05_28.md).
//
// The tier table itself is config, not code: see config/billingConfig.ts
// (BILLING_CONFIG_JSON / BILLING_CONFIG_PATH). The shipped defaults are the
// 4-plan table from the pricing doc.

import { getBillingConfig, BillingTier } from '../config/billingConfig.js';

export type OrgTierConfig = BillingTier;

export function getOrgTiers(): BillingTier[] {
  return getBillingConfig().tiers;
}

/** Unknown tier ids fall back to tier 0, as before. */
export function getOrgTierConfig(tier: number): BillingTier {
  const tiers = getBillingConfig().tiers;
  return tiers.find(t => t.id === Number(tier)) ?? tiers.find(t => t.id === 0)!;
}

export function isValidTier(tier: number): boolean {
  return getBillingConfig().tiers.some(t => t.id === tier);
}
