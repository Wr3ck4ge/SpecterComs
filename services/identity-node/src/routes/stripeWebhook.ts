import { Router, Request, Response } from 'express';
import { pool } from '../config/db.js';
import { processBillingEvent } from '../utils/billingEvents.js';

const router = Router();

/**
 * POST /webhooks/stripe
 * Must be mounted with express.raw() BEFORE the global JSON body parser —
 * Stripe signature verification requires the untouched raw body.
 *
 * Layers of replay/duplicate protection:
 *  1. Signature + 300 s timestamp tolerance (constructWebhookEvent) — a captured
 *     payload can't be re-sent later.
 *  2. billing_webhook_events: an event id that was fully processed is
 *     acknowledged without being processed again.
 *  3. Every handler is idempotent on its own (row locks, status guards, ledger
 *     idempotency keys), which covers two deliveries racing each other.
 *
 * Accepted whenever STRIPE_WEBHOOK_SECRET is set — even with new checkouts
 * disabled — because refunds and disputes keep arriving for months.
 */
router.post('/stripe', async (req: Request, res: Response) => {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ message: 'Stripe webhooks are not configured' });
  }
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    return res.status(400).json({ message: 'Missing stripe-signature header' });
  }
  if (!Buffer.isBuffer(req.body)) {
    // A body parser ran first (mount order regression) — verification would
    // fail on re-serialized JSON anyway; make the cause obvious.
    return res.status(400).json({ message: 'Webhook body must be raw' });
  }

  let event;
  let stripeMod;
  try {
    stripeMod = await import('../payments/stripeProvider.js');
    event = stripeMod.constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('[billing] webhook signature verification failed:', (err as Error).message);
    return res.status(400).json({ message: 'Invalid signature' });
  }

  // Payload shapes follow the ENDPOINT's API version, not the SDK's. Create
  // the endpoint (and run `stripe listen`) on the SDK's pinned version.
  stripeMod.warnOnApiVersionMismatch(event);

  // A test-mode event must never touch a live ledger (or vice versa).
  if (!stripeMod.eventModeMatchesKey(event)) {
    console.warn(`[billing] ignoring ${event.livemode ? 'live' : 'test'} event ${event.id} — key is the other mode`);
    return res.json({ received: true, ignored: 'mode_mismatch' });
  }

  try {
    const claim = await pool.query(
      `INSERT INTO billing_webhook_events (event_id, provider, type, livemode)
       VALUES ($1, 'stripe', $2, $3)
       ON CONFLICT (event_id) DO UPDATE SET attempts = billing_webhook_events.attempts + 1
       RETURNING processed_at`,
      [event.id, event.type, event.livemode]
    );
    if (claim.rows[0]?.processed_at) {
      return res.json({ received: true, duplicate: true });
    }
  } catch (err) {
    console.error('[billing] webhook event log unavailable:', err);
    return res.status(500).json({ message: 'Webhook handler error' });
  }

  try {
    const normalized = stripeMod.normalizeStripeEvent(event);
    const outcome = await processBillingEvent(normalized, 'stripe');
    await pool.query(
      `UPDATE billing_webhook_events SET processed_at = NOW(), last_error = NULL WHERE event_id = $1`,
      [event.id]
    );
    console.log(`[billing] ${event.type} ${event.id} → ${outcome.kind}:${outcome.result}`);
    res.json({ received: true });
  } catch (err) {
    const permanent = isPermanentError(err);
    console.error(`[billing] webhook handler ${permanent ? 'PERMANENT ' : ''}error for ${event.type} ${event.id}:`, err);
    await pool.query(
      `UPDATE billing_webhook_events SET last_error = $2 WHERE event_id = $1`,
      [event.id, `${permanent ? '[permanent] ' : ''}${String((err as Error)?.message ?? err)}`.slice(0, 500)]
    ).catch(() => {});
    if (permanent) {
      // Retrying can't fix bad data, and 3 days of 500s gets the endpoint
      // disabled by Stripe — taking every OTHER event down with it. Ack it;
      // the row stays unprocessed (processed_at NULL, last_error set), so it
      // shows as stuck in the admin overview for a human.
      return res.json({ received: true, error: 'permanent' });
    }
    // Transient (DB down, lock timeout, provider blip): 500 so Stripe retries —
    // every handler is idempotent.
    res.status(500).json({ message: 'Webhook handler error' });
  }
});

/**
 * Errors that will fail identically on every retry: Postgres data exceptions
 * (class 22, e.g. a malformed id) and integrity violations (class 23), and
 * programming errors on an unexpected payload shape (TypeError).
 * Everything else — connection errors, serialization failures (40xxx),
 * lock timeouts (55P03), etc. — is treated as transient.
 */
export function isPermanentError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^(22|23)/.test(code)) return true;
  return err instanceof TypeError;
}

export default router;
