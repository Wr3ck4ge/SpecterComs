import { Router, Response, NextFunction } from 'express';
import {
  getBillingOverview,
  listBillingOrgs,
  getBillingOrgDetail,
  listOrgLedger,
  listPayments,
  listWebhookEvents,
  runReconciliation,
  listExceptions,
  resolveException,
  refundContribution,
  adjustOrgBalance,
  runSettlement,
} from '../controllers/adminBillingController.js';
import { AdminRequest, requireRole, requireReauth, sensitiveRateLimit } from '../controllers/adminController.js';

// Mounted at /admin/billing by routes/admin.ts, AFTER its
// authenticateTokenStrict + requireAdminSession + adminRateLimit chain, so
// every route here already has a live admin session. Roles (server-side;
// the panel's hiding of buttons is cosmetic):
//
//   viewer   — payments health only (mode, totals, stuck webhook count)
//   operator — every billing read (orgs, ledger, payments, webhooks,
//              exceptions), a read-only reconcile, resolving an exception
//   owner    — everything that moves money: refund, adjust, settle and a
//              reconcile with repair:true — each also needs a fresh password
//              re-entry (requireReauth) and a typed confirmation in the body
const router = Router();

const viewer   = requireRole('viewer');
const operator = requireRole('operator');
const owner    = requireRole('owner');
const money    = [owner, requireReauth, sensitiveRateLimit('money')];

/** reconcile is read-only for operators; repair:true escalates to the money chain. */
const repairNeedsOwner = (req: AdminRequest, res: Response, next: NextFunction) => {
  if (req.body?.repair !== true) return next();
  const chain = money.slice();
  const step = (i: number): void => {
    if (i >= chain.length) return next();
    chain[i](req, res, () => step(i + 1));
  };
  step(0);
};

// Reads
router.get('/overview',               viewer,   getBillingOverview);
router.get('/orgs',                   operator, listBillingOrgs);
router.get('/orgs/:orgId',            operator, getBillingOrgDetail);
router.get('/orgs/:orgId/ledger',     operator, listOrgLedger);
router.get('/payments',               operator, listPayments);
router.get('/webhooks',               operator, listWebhookEvents);
router.get('/exceptions',             operator, listExceptions);

// Writes
router.post('/reconcile',               operator, sensitiveRateLimit('reconcile'), repairNeedsOwner, runReconciliation);
router.post('/exceptions/:id/resolve',  operator, resolveException);
router.post('/contributions/:id/refund', ...money, refundContribution);
router.post('/orgs/:orgId/adjust',       ...money, adjustOrgBalance);
router.post('/settle',                   ...money, runSettlement);

export default router;
