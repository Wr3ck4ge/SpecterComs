import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import * as channelController from '../controllers/channelController.js';

const router = Router({ mergeParams: true });

router.post('/', authenticateTokenStrict, channelController.createChannel as any);
router.get('/', authenticateTokenStrict, channelController.listChannels as any);
router.delete('/:channelId', authenticateTokenStrict, channelController.deleteChannel as any);
router.post('/:channelId/presence', authenticateTokenStrict, channelController.joinChannelPresence as any);
router.post('/:channelId/presence/ping', authenticateTokenStrict, channelController.pingChannelPresence as any);
router.delete('/:channelId/presence', authenticateTokenStrict, channelController.leaveChannelPresence as any);

export default router;
