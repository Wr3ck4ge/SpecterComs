import { Router } from 'express';
import { createRole, getRoles, updateRole, deleteRole } from '../controllers/roleController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';

const router = Router({ mergeParams: true });

// Protect all routes
router.use(authenticateTokenStrict);

router.post('/', createRole);
router.get('/', getRoles);
router.put('/:roleId', updateRole);
router.delete('/:roleId', deleteRole);

export default router;
