import { Router } from 'express';
import { getStatus } from '../controllers/statusController.js';

// L7: public, cached status (no login). Mounted at /status.
const router = Router();
router.get('/', getStatus);
export default router;
