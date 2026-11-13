import { Router } from 'express';
import { createRole, getRoles, updateRole, deleteRole } from '../controllers/roleController.js';
import { requireOwnerTwoFactor } from '../controllers/twoFactorController.js'; // L3
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';

const router = Router({ mergeParams: true });

// Protect all routes
router.use(authenticateTokenStrict);

// L3: owner-only rank admin needs 2FA while REQUIRE_2FA_FOR_PRIVILEGED is on.
router.post('/', requireOwnerTwoFactor, createRole);
router.get('/', getRoles);
router.put('/:roleId', requireOwnerTwoFactor, updateRole);
router.delete('/:roleId', requireOwnerTwoFactor, deleteRole);

export default router;
