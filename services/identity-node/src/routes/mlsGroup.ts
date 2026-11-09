import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import {
  submitChannelCommit, getChannelMlsCatchUp, getChannelMlsMembers,
  getChannelGroupInfo, putChannelGroupInfo, submitChannelExternalCommit,
} from '../controllers/mlsGroupController.js';

const router = Router({ mergeParams: true });

router.use(authenticateTokenStrict);

router.post('/commit', submitChannelCommit as any);
router.get('/catch-up', getChannelMlsCatchUp as any);
router.get('/members', getChannelMlsMembers as any); // EVMLS
router.get('/group-info', getChannelGroupInfo as any); // MR1
router.put('/group-info', putChannelGroupInfo as any); // MR1
router.post('/external-commit', submitChannelExternalCommit as any); // MR1

export default router;
