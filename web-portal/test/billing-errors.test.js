// BillingPanel error text: matches the messages billingController.ts sends.
import { describe, it, expect } from 'vitest';
import { billingErrorMessage } from '../src/components/billingErrors.js';

describe('billingErrorMessage', () => {
  it('maps the 503 for payments off / org outside the beta', () => {
    expect(billingErrorMessage('Payments are not enabled on this server')).toMatch(/isn't open for this server/);
  });
  it('maps 403, 429 and 500', () => {
    expect(billingErrorMessage('Forbidden')).toMatch(/not a member/);
    expect(billingErrorMessage('Too many unfinished payments — complete or wait for the open checkout first')).toMatch(/unfinished checkouts/);
    expect(billingErrorMessage('Internal server error')).toMatch(/couldn't start a checkout/);
    expect(billingErrorMessage('HTTP 402: Payment Required')).toMatch(/needs more funds/);
  });
  it('turns amount validation into dollars', () => {
    expect(billingErrorMessage('card payments must be at least 500 cents — use a bank transfer for smaller amounts'))
      .toBe('Card payments start at $5.00. Use a bank transfer for smaller amounts.');
    expect(billingErrorMessage('amount_cents must be at least 100')).toBe('The minimum is $1.00.');
    expect(billingErrorMessage('amount_cents must be at most 50000')).toBe('The maximum is $500.00 per payment.');
  });
  it('passes unknown messages through and handles empty input', () => {
    expect(billingErrorMessage('A payment for this invoice is already in progress — it will show as paid once it clears'))
      .toMatch(/already in progress/);
    expect(billingErrorMessage('')).toMatch(/could not be started/);
  });
});
