import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { submitChannelCommit, getChannelMlsCatchUp } from '../controllers/mlsGroupController.js';

const router = Router({ mergeParams: true });

router.use(authenticateTokenStrict);

router.post('/commit', submitChannelCommit as any);
router.get('/catch-up', getChannelMlsCatchUp as any);

export default router;
