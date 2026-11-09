import { Router } from 'express';
import {
  searchGameShips, getShipCrewRoles, getShipSeats, getShipLoadout, getShipComponents,
  getShipComponentDetails, getShipCombatStats, getShipDimensions, getDamageEstimate,
} from '../controllers/gameShipsController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';

const router = Router();

router.get('/', authenticateTokenStrict, searchGameShips as any);
router.get('/crew-roles', authenticateTokenStrict, getShipCrewRoles as any);
router.get('/seats', authenticateTokenStrict, getShipSeats as any);
router.get('/loadout', authenticateTokenStrict, getShipLoadout as any);
router.get('/components', authenticateTokenStrict, getShipComponents as any);
router.get('/component-details', authenticateTokenStrict, getShipComponentDetails as any);
router.get('/combat-stats', authenticateTokenStrict, getShipCombatStats as any);
router.get('/dimensions', authenticateTokenStrict, getShipDimensions as any);
router.post('/damage-estimate', authenticateTokenStrict, getDamageEstimate as any);

export default router;
