import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { sendDirectMessage } from '../controllers/dmController.js';

const router = Router();

router.post('/:userId/messages', authenticateTokenStrict, sendDirectMessage as any);

export default router;
