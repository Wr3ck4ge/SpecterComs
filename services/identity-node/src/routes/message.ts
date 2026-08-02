import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { sendMessage } from '../controllers/messageController.js';

const router = Router({ mergeParams: true });

router.use(authenticateTokenStrict);

router.post('/', sendMessage as any);

export default router;
