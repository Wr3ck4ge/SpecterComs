import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { sendDirectMessage, requestDmSync, respondDmSync } from '../controllers/dmController.js';
import {
  submitDmCommit, getDmMlsCatchUp, getDmGroupInfo, putDmGroupInfo, submitDmExternalCommit,
} from '../controllers/mlsGroupController.js';

const router = Router();

router.post('/:userId/messages', authenticateTokenStrict, sendDirectMessage as any);
router.post('/:userId/sync-request', authenticateTokenStrict, requestDmSync as any);
router.post('/:userId/sync-response', authenticateTokenStrict, respondDmSync as any);
router.post('/:userId/mls/commit', authenticateTokenStrict, submitDmCommit as any);
router.get('/:userId/mls/catch-up', authenticateTokenStrict, getDmMlsCatchUp as any);
router.get('/:userId/mls/group-info', authenticateTokenStrict, getDmGroupInfo as any); // MR1
router.put('/:userId/mls/group-info', authenticateTokenStrict, putDmGroupInfo as any); // MR1
router.post('/:userId/mls/external-commit', authenticateTokenStrict, submitDmExternalCommit as any); // MR1

export default router;
