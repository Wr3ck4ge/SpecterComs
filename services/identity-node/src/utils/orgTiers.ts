// Organization tier definitions.
// A "voice server" is an organization — tier governs its capacity, media quality,
// and per-cycle data consumption limit/price. Matches docs/PRICING_MODEL_2026_05_28.md's
// 4-plan table; member-hours is intentionally NOT tracked/billed (explicit product
// decision overriding that doc's own recommendation to keep it).

export const ORG_TIERS = {
  0: {
    name: 'Free Trial',
    maxVideoBitrateKbps: 1280,
    maxResolutionLabel: '720p',
    cycleDataLimitBytes: 30_000_000_000,       // 30 GB per billing cycle
    priceCents: 0,
    overageCentsPerGb: null,                    // null = throttle at cap, no overage billing
  },
  1: {
    name: 'Ops Starter',
    maxVideoBitrateKbps: 4000,
    maxResolutionLabel: '1080p',
    cycleDataLimitBytes: 1_000_000_000_000,    // 1,000 GB per billing cycle
    priceCents: 1900,
    overageCentsPerGb: 2.5,                     // $0.025 / GB
  },
  2: {
    name: 'Ops Growth',
    maxVideoBitrateKbps: 8000,
    maxResolutionLabel: '1440p',
    cycleDataLimitBytes: 5_000_000_000_000,    // 5,000 GB per billing cycle
    priceCents: 4900,
    overageCentsPerGb: 1.8,                     // $0.018 / GB
  },
  3: {
    name: 'Ops Command',
    maxVideoBitrateKbps: 20000,
    maxResolutionLabel: '1440p60',
    cycleDataLimitBytes: 20_000_000_000_000,   // 20,000 GB per billing cycle
    priceCents: 14900,
    overageCentsPerGb: 1.2,                     // $0.012 / GB
  },
} as const;

export type OrgTier = keyof typeof ORG_TIERS;

export function getOrgTierConfig(tier: number) {
  return ORG_TIERS[tier as OrgTier] ?? ORG_TIERS[0];
}
