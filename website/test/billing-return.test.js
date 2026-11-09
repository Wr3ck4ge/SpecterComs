import { describe, it, expect } from 'vitest';
import { parseReturnParams, nextPollDelay, describeContribution } from '../src/components/billing/returnState.js';

const ORG = '11111111-2222-4333-8444-555555555555';
const CID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('parseReturnParams', () => {
  it('accepts the URL billingController builds', () => {
    expect(parseReturnParams(`?org=${ORG}&contribution=${CID}&result=success`))
      .toEqual({ ok: true, orgId: ORG, contributionId: CID, result: 'success' });
    expect(parseReturnParams(`?org=${ORG}&contribution=${CID}&result=cancel`).result).toBe('cancel');
  });
  it('flags a missing query as missing, a damaged one as invalid', () => {
    expect(parseReturnParams('')).toEqual({ ok: false, reason: 'missing' });
    expect(parseReturnParams(`?org=${ORG}&result=success`)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseReturnParams(`?org=x&contribution=${CID}&result=success`)).toEqual({ ok: false, reason: 'invalid' });
    expect(parseReturnParams(`?org=${ORG}&contribution=${CID}&result=paid`)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('nextPollDelay', () => {
  it('stops on a terminal status', () => {
    for (const status of ['succeeded', 'failed', 'canceled', 'refunded']) {
      expect(nextPollDelay(0, { status, payment_method: 'card' })).toBeNull();
    }
  });
  it('gives up on ACH quickly and on cards after a few minutes', () => {
    expect(nextPollDelay(4, { status: 'pending', payment_method: 'ach' })).toBe(3000);
    expect(nextPollDelay(5, { status: 'pending', payment_method: 'ach' })).toBeNull();
    expect(nextPollDelay(25, { status: 'pending', payment_method: 'card' })).toBe(10000);
    expect(nextPollDelay(38, { status: 'pending', payment_method: 'card' })).toBeNull();
    expect(nextPollDelay(0, null)).toBe(3000);
  });
});

describe('describeContribution', () => {
  it('never reports success for a pending row', () => {
    expect(describeContribution({ status: 'pending', payment_method: 'card' }).kind).toBe('confirming');
    expect(describeContribution({ status: 'pending', payment_method: 'card' }, { timedOut: true }).kind).toBe('slow');
    expect(describeContribution({ status: 'pending', payment_method: 'ach' }).kind).toBe('processing');
  });
  it('maps settled statuses', () => {
    expect(describeContribution({ status: 'succeeded' })).toEqual({ kind: 'confirmed', disputed: false });
    expect(describeContribution({ status: 'succeeded', dispute_status: 'open' }).disputed).toBe(true);
    expect(describeContribution({ status: 'failed', last_error: 'declined' })).toEqual({ kind: 'failed', message: 'declined' });
    expect(describeContribution({ status: 'canceled' }).kind).toBe('canceled');
    expect(describeContribution({ status: 'refunded' }).kind).toBe('refunded');
  });
});
