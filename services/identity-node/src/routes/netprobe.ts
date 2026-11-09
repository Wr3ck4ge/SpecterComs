import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { makeGetNetprobe, makeStartNetprobe } from '../controllers/netprobeController.js';

// Server-assisted network diagnosis (desktop Repair panel). Mounted at /diag/netprobe.
const router = Router();

router.post('/', authenticateTokenStrict as any, makeStartNetprobe() as any);
router.get('/:token', authenticateTokenStrict as any, makeGetNetprobe() as any);

export default router;
