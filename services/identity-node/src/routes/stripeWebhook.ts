import { Router, Request, Response } from 'express';
import { creditContribution, markContributionFailed } from '../utils/billingCredit.js';

const router = Router();

/**
 * POST /webhooks/stripe
 * Must be mounted with express.raw() BEFORE the global JSON body parser —
 * Stripe signature verification requires the untouched raw body.
 */
router.post('/stripe', async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    return res.status(400).json({ message: 'Missing stripe-signature header' });
  }

  let event;
  try {
    const { constructWebhookEvent } = await import('../payments/stripeProvider.js');
    event = constructWebhookEvent(req.body as Buffer, signature);
  } catch (err) {
    console.error('[billing] webhook signature verification failed:', err);
    return res.status(400).json({ message: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object as any;
        const contributionId = pi.metadata?.contribution_id;
        if (contributionId) {
          const credited = await creditContribution(contributionId, pi.id);
          console.log(`[billing] payment_intent.succeeded contribution=${contributionId} credited=${credited}`);
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object as any;
        const contributionId = pi.metadata?.contribution_id;
        if (contributionId) {
          await markContributionFailed(contributionId, 'failed', pi.id);
          console.log(`[billing] payment_intent.payment_failed contribution=${contributionId}`);
        }
        break;
      }
      case 'checkout.session.expired': {
        const session = event.data.object as any;
        const contributionId = session.metadata?.contribution_id;
        if (contributionId) {
          await markContributionFailed(contributionId, 'canceled');
          console.log(`[billing] checkout.session.expired contribution=${contributionId}`);
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    // 500 so Stripe retries — creditContribution is idempotent
    console.error(`[billing] webhook handler error for ${event.type}:`, err);
    res.status(500).json({ message: 'Webhook handler error' });
  }
});

export default router;
