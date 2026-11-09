#!/usr/bin/env node
// Stripe webhook self-test: signs fixture events locally with
// stripe.webhooks.generateTestHeaderString and POSTs them to a running
// identity-node. No Stripe account or network access to Stripe is needed.
//
// Use it next to `stripe listen` to check the endpoint wiring (raw body,
// signature, event-id dedupe, mode guard) before clicking through Checkout.
//
//   cd services/identity-node
//   STRIPE_WEBHOOK_SECRET=whsec_... node scripts/stripe-webhook-selftest.mjs \
//       [--url http://localhost:3000/webhooks/stripe] [--contribution <uuid>] [--amount 1000]
//
// The secret must be the one the server runs with (`stripe listen` prints its
// own whsec_ — use that one when the server is fed by stripe listen).
//
// Checks, in order:
//   1. forged signature                → 400
//   2. unknown event type              → 200 (ignored)
//   3. live-mode event on a test key   → 200 { ignored: 'mode_mismatch' }
//   4. payment for --contribution      → 200, then the SAME event id → { duplicate: true }
//      (without --contribution: a random id → 200 and an `unmatched_payment`
//       row in the admin exceptions queue — that is expected)
//   5. malformed contribution_id       → 200 (recorded as unmatched, no retry loop)
// With --contribution, step 4 really credits that contribution if it is
// pending — only point it at a test database.

import Stripe from 'stripe';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const url = opt('url', process.env.WEBHOOK_URL || 'http://localhost:3000/webhooks/stripe');
const secret = process.env.STRIPE_WEBHOOK_SECRET;
const contributionId = opt('contribution', crypto.randomUUID());
const amount = Number(opt('amount', '1000'));

if (!secret) {
  console.error('STRIPE_WEBHOOK_SECRET is required (the whsec_ the server verifies with).');
  process.exit(2);
}

const runId = crypto.randomBytes(4).toString('hex');
const event = (type, object, extra = {}) => ({
  id: `evt_selftest_${runId}_${type.replace(/\W/g, '_')}${extra.idSuffix ?? ''}`,
  object: 'event',
  api_version: Stripe.API_VERSION,
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  type,
  data: { object },
  ...(extra.livemode !== undefined && { livemode: extra.livemode }),
});

async function post(ev, signWith = secret) {
  const payload = JSON.stringify(ev);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: signWith });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

let failures = 0;
function check(name, cond, got) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`);
  if (!cond) failures++;
}

const pi = `pi_selftest_${runId}`;
const paid = event('checkout.session.completed', {
  id: `cs_selftest_${runId}`, object: 'checkout.session', payment_status: 'paid', payment_intent: pi,
  amount_total: amount, client_reference_id: contributionId, metadata: { contribution_id: contributionId },
});

try {
  const forged = await post(event('payment_intent.succeeded', { id: pi, metadata: {} }), 'whsec_wrong');
  check('forged signature is rejected with 400', forged.status === 400, forged);

  const unknown = await post(event('customer.created', { id: 'cus_selftest' }));
  check('unknown event type is acknowledged with 200', unknown.status === 200, unknown);

  const live = await post(event('payment_intent.succeeded', { id: pi, amount_received: amount, metadata: { contribution_id: contributionId } }, { livemode: true }));
  check('live-mode event on a test key is ignored', live.status === 200 && live.body?.ignored === 'mode_mismatch', live);

  const first = await post(paid);
  check('signed checkout.session.completed is accepted', first.status === 200 && first.body?.received === true, first);
  const again = await post(paid);
  check('redelivery of the same event id is a duplicate', again.status === 200 && again.body?.duplicate === true, again);

  const bad = await post(event('payment_intent.succeeded', { id: `${pi}_bad`, amount_received: amount, metadata: { contribution_id: 'not-a-uuid' } }));
  check('malformed contribution_id is acknowledged (no retry loop)', bad.status === 200, bad);
} catch (err) {
  console.error(`Could not reach ${url}: ${err.message}`);
  process.exit(2);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
