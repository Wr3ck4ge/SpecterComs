import { Router } from 'express';
import {
  getBillingStatus,
  getOrgTransactions,
  contributeToOrg,
  getContributionStatus,
  getUsageDaily,
  getBillingInfo,
  updateBillingInfo,
  listOrgInvoices,
  payOrgInvoice,
} from '../controllers/billingController.js';
import { requireOwnerTwoFactor } from '../controllers/twoFactorController.js'; // L3
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';

const router = Router({ mergeParams: true });

router.use(authenticateTokenStrict);

router.get('/',                   getBillingStatus);
router.get('/transactions',       getOrgTransactions);
router.post('/contribute',        contributeToOrg);
router.get('/contributions/:cid', getContributionStatus);
router.get('/usage-daily',        getUsageDaily);
// L3: the owner's billing details / payments need 2FA while REQUIRE_2FA_FOR_PRIVILEGED is on.
router.get('/info',               requireOwnerTwoFactor, getBillingInfo);
router.put('/info',               requireOwnerTwoFactor, updateBillingInfo);
router.get('/invoices',           listOrgInvoices);
router.post('/invoices/:cid/pay', requireOwnerTwoFactor, payOrgInvoice);

export default router;
