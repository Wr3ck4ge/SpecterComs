import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { submitChannelCommit } from '../controllers/mlsGroupController.js';

const router = Router({ mergeParams: true });

router.use(authenticateTokenStrict);

router.post('/commit', submitChannelCommit as any);

export default router;
