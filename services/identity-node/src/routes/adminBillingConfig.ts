import { Router } from 'express';
import {
  requireAdminSession, requireRole, requireReauth, adminRateLimit, sensitiveRateLimit,
} from '../controllers/adminController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import {
  getBillingConfigAdmin, getBillingConfigVersionAdmin, putBillingConfigAdmin,
} from '../controllers/adminBillingConfigController.js';

// Mounted at /admin/billing/config in index.ts, BEFORE the /admin router
// (each /admin/billing route now sets its own role, so the early mount is
// just ordering, not a workaround). Same chain as
// routes/admin.ts: JWT → live admin session → current role → rate limit.
const router = Router();

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});
router.use(authenticateTokenStrict, requireAdminSession, adminRateLimit);

// Reads: the billing-read role (same as /admin/billing/contributions).
router.get('/',                  requireRole('operator'), getBillingConfigAdmin);
router.get('/versions/:version', requireRole('operator'), getBillingConfigVersionAdmin);
// Changing prices moves money: owner (the highest admin role) + a fresh
// password re-entry, same as refunds/adjustments in routes/adminBilling.ts.
router.put('/',                  requireRole('owner'), requireReauth, sensitiveRateLimit('destructive'), putBillingConfigAdmin);

export default router;
