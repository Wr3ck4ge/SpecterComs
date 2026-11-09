import { describe, it, expect } from 'vitest';
import {
  dollarsToCents, gbToBytes, bytesToGbInput, formatCycleRange, deriveCycle, cycleHistory, addMonthsUtc,
  configToForm, formToConfig, mapServerErrors, diffConfigs, nextTierId,
} from '../src/components/admin/billingFormat.js';

const CONFIG = {
  currency: 'usd',
  tiers: [
    { id: 0, name: 'Free Trial', maxVideoBitrateKbps: 1280, maxResolutionLabel: '720p', cycleDataLimitBytes: 30_000_000_000, priceCents: 0, overageCentsPerGb: null, selectable: true },
    { id: 1, name: 'Ops Starter', maxVideoBitrateKbps: 4000, maxResolutionLabel: '1080p', cycleDataLimitBytes: 1_000_000_000_000, priceCents: 1900, overageCentsPerGb: 2.5, selectable: true },
  ],
  runDryTier: 0, minContributionCents: 100, maxContributionCents: 50_000, cardMinContributionCents: 500,
  cardFeeMode: 'absorb', cardFeePercent: 2.9, cardFeeFixedCents: 30, graceDays: 7, lowBalanceCycles: 1,
  maxPendingPerUserPerHour: 5, autoRefundDuplicatePayments: true, autoRefundOrphanPayments: true,
};

describe('money and units', () => {
  it('parses dollars to exact integer cents', () => {
    expect(dollarsToCents('19.99')).toBe(1999);
    expect(dollarsToCents('0.1')).toBe(10);
    expect(dollarsToCents('$5')).toBe(500);
    expect(dollarsToCents('1.005')).toBeNull();
    expect(dollarsToCents('-5')).toBeNull();
    expect(dollarsToCents('-5.25', { allowNegative: true })).toBe(-525);
    expect(dollarsToCents('abc')).toBeNull();
  });
  it('round-trips GB and bytes', () => {
    expect(gbToBytes('1000')).toBe(1_000_000_000_000);
    expect(bytesToGbInput(30_000_000_000)).toBe('30');
    expect(gbToBytes('-1')).toBeNull();
  });
});

describe('billing cycles', () => {
  it('shows the inclusive last day and days left (end is exclusive, UTC)', () => {
    expect(formatCycleRange('2026-11-03T00:00:00Z', '2026-12-03T00:00:00Z', new Date('2026-11-21T00:00:00Z')))
      .toBe('Nov 3 – Dec 2 (12 days left)');
  });
  it('adds months like the server (clamped to month end)', () => {
    expect(addMonthsUtc('2026-01-31T00:00:00Z', 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });
  it('prefers the server cycle object and degrades without it', () => {
    const withCycle = deriveCycle({ cycle: { start: 'a', end: '2026-12-03T00:00:00Z', priceCents: 1900, nextCycle: { priceCents: 2500 }, enforced: false, state: 'ok' } }, CONFIG);
    expect(withCycle).toMatchObject({ priceCents: 1900, nextPriceCents: 2500, enforced: false, derived: false });
    const legacy = deriveCycle({ org: { tier: 1, tier_name: 'Ops Starter' }, billing: { cycle_start_at: '2026-11-03T00:00:00Z', balance_cents: 4000 }, enforced: false, state: 'active' }, CONFIG);
    expect(legacy).toMatchObject({ end: '2026-12-03T00:00:00.000Z', priceCents: 1900, coversCycles: 2, derived: true });
    expect(deriveCycle({ org: {}, billing: null }, CONFIG)).toBeNull();
  });
  it('reads cycle history from either shape', () => {
    expect(cycleHistory({ cycles: [{ start: 's', end: 'e', chargeCents: 5, applied: true, configVersion: 3 }] })[0])
      .toMatchObject({ chargeCents: 5, configVersion: 3 });
    expect(cycleHistory({ cycle_charges: [{ cycle_start: 's', cycle_end: 'e', total_cents: 7, applied: false }] })[0])
      .toMatchObject({ chargeCents: 7, applied: false });
  });
});

describe('plans & pricing form', () => {
  it('round-trips a config through the form unchanged', () => {
    const { config, errors } = formToConfig(configToForm(CONFIG));
    expect(errors).toEqual({});
    expect(diffConfigs(CONFIG, config)).toEqual([]);
  });
  it('mirrors the server validator', () => {
    const form = configToForm(CONFIG);
    form.tiers[1].priceUsd = '19.999';
    form.policy.minContributionCents = '0.20';
    form.policy.maxContributionCents = '0.60';
    form.policy.runDryTier = '9';
    form.policy.cardFeePercent = '12';
    const { errors } = formToConfig(form);
    expect(Object.keys(errors).sort()).toEqual(['cardFeePercent', 'minContributionCents', 'runDryTier', 'tiers.1.priceCents']);
    form.tiers = form.tiers.slice(1);
    expect(formToConfig(form).errors.tiers).toMatch(/Plan 0/);
  });
  it('maps server error paths onto fields', () => {
    expect(mapServerErrors([{ path: ['tiers', 1, 'priceCents'], message: 'bad' }, { path: 'tiers[0].name', message: 'x' }]))
      .toEqual({ 'tiers.1.priceCents': 'bad', 'tiers.0.name': 'x' });
  });
  it('diffs prices, removed plans and policy', () => {
    const next = { ...CONFIG, graceDays: 3, tiers: [{ ...CONFIG.tiers[0] }, { ...CONFIG.tiers[1], priceCents: 2500 }].slice(0, 2) };
    const rows = diffConfigs(CONFIG, next);
    expect(rows.map((r) => [r.label, r.from, r.to])).toEqual([
      ['Plan 1 (Ops Starter) · price', '$19.00', '$25.00'],
      ['Grace period', '7', '3'],
    ]);
    expect(diffConfigs(CONFIG, { ...CONFIG, tiers: [CONFIG.tiers[0]] })[0].kind).toBe('removed');
    expect(nextTierId(configToForm(CONFIG))).toBe(2);
  });
});
