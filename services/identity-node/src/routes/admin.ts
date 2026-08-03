import { Router } from 'express';
import {
  adminLogin,
  getSystemStats,
  listUsers,
  banGlobalUser,
  listUsersExtended,
  getUserDetail,
  listOrgs,
  listBillingContributions,
  getOrgBillingInfo,
  createOrgInvoice,
  listNodeAlertEvents,
  dissolveOrg,
  listHwidBans,
  removeHwidBan,
  getSystemOverview,
  listMediaNodes,
  updateMediaNode,
  getNodeMetricsHistory,
  assignOrgToNode,
  unassignOrgFromNode,
  drainOrg,
  provisionNode,
  listProvisioningRequests,
} from '../controllers/adminController.js';
import { registerPushToken, unregisterPushToken } from '../controllers/pushController.js';
import { listVoiceReports, getVoiceReportAudio, updateVoiceReportStatus } from '../controllers/voiceReportController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { loginRateLimiter } from '../middleware/rateLimit.js';

const router = Router();

export const requirePlatformAdmin = (req: any, res: any, next: any) => {
  if (req.user?.role !== 'platform_admin') {
    return res.status(403).json({ message: 'Forbidden. Platform Admins only.' });
  }
  // The JWT's `permissions` claim (set from platform_admins.permissions at
  // login) was fetched but never actually consulted here — every admin route
  // was reachable by role alone. super_admin is the one flag every admin
  // creation path (seedAdminIfNeeded, create-root.ts) currently sets, so this
  // doesn't change behavior for existing admins; it makes the JWT's
  // permissions claim actually load-bearing for whenever a scoped admin is
  // introduced.
  if (req.user?.permissions?.super_admin !== true) {
    return res.status(403).json({ message: 'Forbidden. Missing super_admin permission.' });
  }
  next();
};

router.post('/login', loginRateLimiter, adminLogin);

// All routes below require a valid platform_admin JWT
router.use(authenticateTokenStrict);
router.use(requirePlatformAdmin);

// Stats / System
router.get('/stats',    getSystemStats);
router.get('/overview', getSystemOverview);

// Users
router.get('/users',              listUsersExtended);
router.get('/users/:userId',      getUserDetail);
router.post('/users/:userId/ban', banGlobalUser);

// Organizations
router.get('/orgs',           listOrgs);
router.delete('/orgs/:orgId', dissolveOrg);
router.post('/orgs/:orgId/node',   assignOrgToNode);
router.delete('/orgs/:orgId/node', unassignOrgFromNode);
router.post('/orgs/:orgId/drain',  drainOrg);
router.get('/billing/contributions', listBillingContributions);
router.get('/orgs/:orgId/billing-info', getOrgBillingInfo);
router.post('/orgs/:orgId/billing/invoices', createOrgInvoice);

// HWID Bans
router.get('/hwid-bans',          listHwidBans);
router.delete('/hwid-bans/:hwid', removeHwidBan);

// Media Nodes (Phase A of multi-tenant infra)
router.get('/nodes',                       listMediaNodes);
router.put('/nodes/:nodeId',               updateMediaNode);
router.get('/nodes/:nodeId/metrics-history', getNodeMetricsHistory);

// Node Provisioning (Phase B of multi-tenant infra)
router.post('/nodes/provision',   provisionNode);
router.get('/nodes/provisioning', listProvisioningRequests);

// Push Notifications
router.post('/push/register',   registerPushToken);
router.delete('/push/register', unregisterPushToken);
router.get('/node-alerts',      listNodeAlertEvents);

// Voice misconduct reports
router.get('/voice-reports',            listVoiceReports);
router.get('/voice-reports/:id/audio',  getVoiceReportAudio);
router.patch('/voice-reports/:id',      updateVoiceReportStatus);

export default router;
