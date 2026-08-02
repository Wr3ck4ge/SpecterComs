import { Router } from 'express';
import { authenticateToken } from '../middleware/authMiddleware.js';
import { eventStream } from '../controllers/sseController.js';

const router = Router();

router.get('/stream', authenticateToken, eventStream);

export default router;
