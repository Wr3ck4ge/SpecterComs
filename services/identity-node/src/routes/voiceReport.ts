import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { submitVoiceReport } from '../controllers/voiceReportController.js';

const router = Router();

router.post('/', authenticateTokenStrict, submitVoiceReport as any);

export default router;
