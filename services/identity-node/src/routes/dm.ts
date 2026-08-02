import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { sendDirectMessage, requestDmSync, respondDmSync } from '../controllers/dmController.js';
import { submitDmCommit } from '../controllers/mlsGroupController.js';

const router = Router();

router.post('/:userId/messages', authenticateTokenStrict, sendDirectMessage as any);
router.post('/:userId/sync-request', authenticateTokenStrict, requestDmSync as any);
router.post('/:userId/sync-response', authenticateTokenStrict, respondDmSync as any);
router.post('/:userId/mls/commit', authenticateTokenStrict, submitDmCommit as any);

export default router;
