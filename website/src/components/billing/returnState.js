// Pure logic for BillingReturnPage (kept out of the component so it can be
// unit-tested): parse the Stripe Checkout return URL and turn a contribution
// row from GET /orgs/:id/billing/contributions/:cid into what the page shows.
//
// The URL is built in services/identity-node/src/controllers/billingController.ts
// (portalUrls):  /billing/return?org=<uuid>&contribution=<uuid>&result=success|cancel
// `result=success` only means the payer finished the Stripe page. It is NOT
// proof of payment: the pool is credited only by the webhook, so the page
// confirms by polling the contribution's status.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses after which nothing changes without a human (refund/dispute aside). */
export const TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled', 'refunded'];

/** → { ok: true, orgId, contributionId, result } or { ok: false, reason } */
export function parseReturnParams(search) {
  let p;
  try { p = new URLSearchParams(search || ''); } catch { return { ok: false, reason: 'malformed' }; }
  const orgId = (p.get('org') || '').trim();
  const contributionId = (p.get('contribution') || '').trim();
  const result = (p.get('result') || '').trim().toLowerCase();
  if (!orgId && !contributionId && !result) return { ok: false, reason: 'missing' };
  if (!UUID_RE.test(orgId) || !UUID_RE.test(contributionId)) return { ok: false, reason: 'invalid' };
  if (result !== 'success' && result !== 'cancel') return { ok: false, reason: 'invalid' };
  return { ok: true, orgId, contributionId, result };
}

/**
 * Poll delay (ms) for the n-th poll (0-based), or null to stop.
 * Card payments normally confirm within seconds; ACH is "processing" for days,
 * so after the first confirmation window there's nothing to wait for.
 */
export function nextPollDelay(attempt, contribution) {
  if (contribution && TERMINAL_STATUSES.includes(contribution.status)) return null;
  const isAch = contribution?.payment_method === 'ach';
  if (isAch && attempt >= 5) return null;      // ~15 s: enough to see an instant failure
  if (attempt < 20) return 3000;               // first minute
  if (attempt < 38) return 10000;              // up to ~4 minutes
  return null;
}

/**
 * The view for a fetched contribution (or for a state without one).
 * kind: 'confirmed' | 'processing' | 'confirming' | 'slow' | 'failed' | 'canceled' | 'refunded'
 */
export function describeContribution(c, { timedOut = false } = {}) {
  if (!c) return { kind: 'confirming' };
  const isAch = c.payment_method === 'ach';
  switch (c.status) {
    case 'succeeded':
      return { kind: 'confirmed', disputed: c.dispute_status === 'open' || c.dispute_status === 'lost' };
    case 'refunded':
      return { kind: 'refunded' };
    case 'failed':
      return { kind: 'failed', message: c.last_error || null };
    case 'canceled':
      return { kind: 'canceled' };
    case 'pending':
    default:
      if (isAch) return { kind: 'processing', message: c.last_error || null };
      return { kind: timedOut ? 'slow' : 'confirming', message: c.last_error || null };
  }
}
