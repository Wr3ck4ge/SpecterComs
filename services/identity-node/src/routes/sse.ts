import { Router } from 'express';
import { authenticateSseToken, authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { eventStream, issueSseTicket } from '../controllers/sseController.js';

const router = Router();

router.post('/ticket', authenticateTokenStrict, issueSseTicket);
router.get('/stream', authenticateSseToken, eventStream);

export default router;
