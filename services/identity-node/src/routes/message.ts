import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { sendMessage, requestChannelSync, respondChannelSync } from '../controllers/messageController.js';

const router = Router({ mergeParams: true });

router.use(authenticateTokenStrict);

router.post('/', sendMessage as any);
router.post('/sync-request', requestChannelSync as any);
router.post('/sync-response', respondChannelSync as any);

export default router;
