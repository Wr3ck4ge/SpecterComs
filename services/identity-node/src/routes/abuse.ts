import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { createAbuseReport } from '../controllers/abuseController.js';

const router = Router();

router.post('/', authenticateTokenStrict, createAbuseReport as any);

export default router;
