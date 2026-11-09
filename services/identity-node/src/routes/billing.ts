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
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';

const router = Router({ mergeParams: true });

router.use(authenticateTokenStrict);

router.get('/',                   getBillingStatus);
router.get('/transactions',       getOrgTransactions);
router.post('/contribute',        contributeToOrg);
router.get('/contributions/:cid', getContributionStatus);
router.get('/usage-daily',        getUsageDaily);
router.get('/info',               getBillingInfo);
router.put('/info',               updateBillingInfo);
router.get('/invoices',           listOrgInvoices);
router.post('/invoices/:cid/pay', payOrgInvoice);

export default router;
