import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import {
  sendMessage, requestChannelSync, respondChannelSync,
  requestOrgSync, respondOrgSync, // MR2
} from '../controllers/messageController.js';

// Mounted at /orgs/:orgId/channels/:chanId/messages
const router = Router({ mergeParams: true });

router.use(authenticateTokenStrict);

router.post('/', sendMessage as any);
router.post('/sync-request', requestChannelSync as any);
router.post('/sync-response', respondChannelSync as any);

export default router;

// MR2: org-wide catch-up, mounted at /orgs/:orgId/messages (see messageController).
export const orgMessageRoutes = Router({ mergeParams: true });

orgMessageRoutes.use(authenticateTokenStrict);

orgMessageRoutes.post('/sync-request', requestOrgSync as any);
orgMessageRoutes.post('/sync-response', respondOrgSync as any);
