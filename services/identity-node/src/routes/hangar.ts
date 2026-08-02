import { Router } from 'express';
import { getHangar, addHangarShip, updateHangarShip, removeHangarShip } from '../controllers/hangarController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/', authenticateTokenStrict, getHangar as any);
router.post('/', authenticateTokenStrict, addHangarShip as any);
router.patch('/:id', authenticateTokenStrict, updateHangarShip as any);
router.delete('/:id', authenticateTokenStrict, removeHangarShip as any);

export default router;
