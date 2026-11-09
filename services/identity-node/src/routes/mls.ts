import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { reportDeviceStatus } from '../controllers/mlsGroupController.js';

// Account-wide MLS endpoints (group-scoped ones live under the channel /
// event / DM routers). MR1: device epoch diagnostics.
const router = Router();

router.post('/device-status', authenticateTokenStrict, reportDeviceStatus as any);

export default router;
