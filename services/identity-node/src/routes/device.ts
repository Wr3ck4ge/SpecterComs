import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { registerDevice, getUserDeviceKeyPackages } from '../controllers/deviceController.js';

const router = Router();

router.post('/', authenticateTokenStrict, registerDevice as any);
router.get('/:userId/key-packages', authenticateTokenStrict, getUserDeviceKeyPackages as any);

export default router;
