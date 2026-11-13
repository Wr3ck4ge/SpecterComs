import { Router } from 'express';
import {
  adminLogin,
  adminLogout,
  adminReauth,
  getAdminMe,
  listAdmins,
  setAdminRole,
  getSystemStats,
  banGlobalUser,
  listUsersExtended,
  getUserDetail,
  revealUserEmail,
  exportUserData,
  getErasurePreview,
  eraseUser,
  listOrgs,
  listBillingContributions,
  getOrgBillingInfo,
  createOrgInvoice,
  listNodeAlertEvents,
  dissolveOrg,
  listHwidBans,
  removeHwidBan,
  listAuditLog,
  getSystemOverview,
  listMediaNodes,
  updateMediaNode,
  getNodeMetricsHistory,
  assignOrgToNode,
  unassignOrgFromNode,
  drainOrg,
  provisionNode,
  listProvisioningRequests,
  migrateOrgToNode,
  teardownMediaNode,
  listOrphanDroplets,
  listVoiceReportsAdmin,
  getVoiceReportAudioAdmin,
  updateVoiceReportAdmin,
  requireAdminSession,
  requireRole,
  requireReauth,
  adminRateLimit,
  sensitiveRateLimit,
} from '../controllers/adminController.js';
import { registerPushToken, unregisterPushToken } from '../controllers/pushController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { loginRateLimiter } from '../middleware/rateLimit.js';
import adminBillingRoutes from './adminBilling.js';
import { getTrafficStats } from '../controllers/trafficController.js';
import {
  listBugReportKeys, setBugReportKey, listBugReportsAdmin, updateBugReportAdmin, deleteBugReportAdmin,
} from '../controllers/bugReportAdminController.js';
import { listDataRequestsAdmin, completeDataRequestAdmin } from '../controllers/dataRequestController.js';
import { listAppealsAdmin, decideAppealAdmin } from '../controllers/banAppealController.js';
import {
  listTsReportKeys, setTsReportKey, listTsReportsAdmin, getTsReportBlobAdmin, getTsReportCustodyAdmin,
  setTsReportStateAdmin, setTsReportHoldAdmin,
} from '../controllers/tsReportAdminController.js';
import { getNoticeAdmin, setNotice, clearNotice } from '../controllers/statusController.js';
import { adminLoginTwoFactor } from '../controllers/adminController.js';
import { adminTwoFactor, requireAdminTwoFactor } from '../controllers/twoFactorController.js';

const router = Router();

// Every admin response may carry personal data â€” never cache it anywhere.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

router.post('/login', loginRateLimiter, adminLogin);
router.post('/login/2fa', loginRateLimiter, adminLoginTwoFactor); // L3: second step

// Everything below: valid JWT -> live, non-idle admin_sessions row -> current
// role from platform_admins -> per-admin rate limit. Authorization is entirely
// server-side; the panel's role-based hiding is cosmetic.
//
// Exported under its historical name for anything that imported it.
export const requirePlatformAdmin = [authenticateTokenStrict, requireAdminSession, adminRateLimit];
router.use(...requirePlatformAdmin);

const viewer   = requireRole('viewer');
const operator = requireRole('operator');
const owner    = requireRole('owner');

// Session
router.get('/me',      viewer, getAdminMe);
router.post('/logout', viewer, adminLogout);
router.post('/reauth', viewer, sensitiveRateLimit('reauth'), adminReauth);

// L3: the admin's own two-factor setup. Registered BEFORE requireAdminTwoFactor
// so an admin who still has to enrol can reach it (and /me, /logout, /reauth).
router.get('/2fa',                 viewer, adminTwoFactor.status);
router.post('/2fa/enroll',         viewer, adminTwoFactor.enroll);
router.post('/2fa/confirm',        viewer, adminTwoFactor.confirm);
router.post('/2fa/disable',        viewer, adminTwoFactor.disable);
router.post('/2fa/recovery-codes', viewer, adminTwoFactor.regenerate);

// Everything below: 403 TWO_FACTOR_REQUIRED for an admin without 2FA while
// REQUIRE_2FA_FOR_PRIVILEGED is on (a no-op while it is off).
router.use(requireAdminTwoFactor);

// Admin accounts
router.get('/admins',                owner, listAdmins);
router.put('/admins/:adminId/role',  owner, requireReauth, sensitiveRateLimit('destructive'), setAdminRole);

// Stats / System
router.get('/stats',    viewer, getSystemStats);
router.get('/overview', viewer, getSystemOverview);
// Website traffic counter: daily aggregates only (utils/siteTraffic.ts)
router.get('/traffic',  viewer, getTrafficStats);

// Audit trail
router.get('/audit', operator, listAuditLog);

// Users
router.get('/users',                          viewer,   listUsersExtended);
router.get('/users/:userId',                  viewer,   getUserDetail);
router.post('/users/:userId/reveal-email',    operator, sensitiveRateLimit('revealEmail'), revealUserEmail);
router.post('/users/:userId/ban',             operator, sensitiveRateLimit('destructive'), banGlobalUser);
router.get('/users/:userId/erasure-preview',  owner,    getErasurePreview);
router.post('/users/:userId/export',          owner,    requireReauth, sensitiveRateLimit('export'), exportUserData);
router.post('/users/:userId/erase',           owner,    requireReauth, sensitiveRateLimit('destructive'), eraseUser);
// Legacy verb for the same audited erasure (requires the same body).
router.delete('/users/:userId',               owner,    requireReauth, sensitiveRateLimit('destructive'), eraseUser);

// Organizations
router.get('/orgs',                 viewer,   listOrgs);
router.delete('/orgs/:orgId',       owner,    requireReauth, sensitiveRateLimit('destructive'), dissolveOrg);
router.post('/orgs/:orgId/node',    operator, assignOrgToNode);
router.delete('/orgs/:orgId/node',  operator, unassignOrgFromNode);
router.post('/orgs/:orgId/drain',   operator, drainOrg);
router.post('/orgs/:orgId/migrate', operator, migrateOrgToNode);

// Billing (read feed + contact info are financial/PII: operator; issuing money: owner)
router.get('/billing/contributions',          operator, listBillingContributions);
router.get('/orgs/:orgId/billing-info',       operator, getOrgBillingInfo);
router.post('/orgs/:orgId/billing/invoices',  owner,    createOrgInvoice); // no reauth: EES Ledger pushes these
// Overview, orgs, ledger, payments, webhooks, reconciliation, exceptions,
// refunds, adjustments, settlement (routes/adminBilling.ts). Each route there
// carries its own role: reads operator (overview viewer), money owner + reauth.
router.use('/billing', adminBillingRoutes);

// HWID Bans
router.get('/hwid-bans',          viewer,   listHwidBans);
router.delete('/hwid-bans/:hwid', operator, removeHwidBan);

// Media Nodes (Phase A of multi-tenant infra)
router.get('/nodes',                         viewer,   listMediaNodes);
router.put('/nodes/:nodeId',                 operator, updateMediaNode);
router.get('/nodes/:nodeId/metrics-history', viewer,   getNodeMetricsHistory);

// Node Provisioning (Phase B of multi-tenant infra) â€” creates billable droplets
router.post('/nodes/provision',   owner,  requireReauth, provisionNode);
router.get('/nodes/provisioning', viewer, listProvisioningRequests);
router.get('/nodes/orphans',      owner,  listOrphanDroplets);
router.post('/nodes/:nodeId/teardown', owner, requireReauth, sensitiveRateLimit('destructive'), teardownMediaNode);

// Push Notifications
router.post('/push/register',   viewer, registerPushToken);
router.delete('/push/register', viewer, unregisterPushToken);
router.get('/node-alerts',      viewer, listNodeAlertEvents);

// Voice misconduct reports (evidence: operator; audio access is audited)
router.get('/voice-reports',            operator, listVoiceReportsAdmin);
router.get('/voice-reports/:id/audio',  operator, sensitiveRateLimit('audio'), getVoiceReportAudioAdmin);
router.patch('/voice-reports/:id',      operator, updateVoiceReportAdmin);

// D1: bug reports â€” owner only (only the owner's browser can open them).
router.get('/bug-reports/keys',      owner, listBugReportKeys);
router.put('/bug-reports/key',       owner, requireReauth, sensitiveRateLimit('destructive'), setBugReportKey);
router.get('/bug-reports',           owner, listBugReportsAdmin);
router.patch('/bug-reports/:id',     owner, updateBugReportAdmin);
router.delete('/bug-reports/:id',    owner, deleteBugReportAdmin);
// L7: status page incident notice.
router.get('/status-notice',         operator, getNoticeAdmin);
router.put('/status-notice',         operator, setNotice);
router.delete('/status-notice',      operator, clearNotice);

// L6: user data requests â€” owner only (the export / erasure they trigger are owner actions).
// L12: platform ban appeals (operators decide; a different admin than the one who acted)
router.get('/appeals',                     operator, listAppealsAdmin);
router.post('/appeals/:id/decide',         operator, sensitiveRateLimit('destructive'), decideAppealAdmin);

router.get('/data-requests',              owner, listDataRequestsAdmin);
router.post('/data-requests/:id/complete', owner, completeDataRequestAdmin);

// T3: trust & safety queue â€” owner only, like bug reports (the reviewer's
// browser holds the T&S key). Every per-report action writes a custody row.
router.get('/ts-reports/keys',            owner, listTsReportKeys);
router.put('/ts-reports/key',             owner, requireReauth, sensitiveRateLimit('destructive'), setTsReportKey);
router.get('/ts-reports',                 owner, listTsReportsAdmin);
router.get('/ts-reports/:id/blob',        owner, getTsReportBlobAdmin);
router.get('/ts-reports/:id/custody',     owner, getTsReportCustodyAdmin);
router.patch('/ts-reports/:id/state',     owner, setTsReportStateAdmin);
router.put('/ts-reports/:id/legal-hold',  owner, requireReauth, setTsReportHoldAdmin);

export default router;
