import { Router } from 'express';
import { banMember, kickMember, kickFromChannel, muteMember, unmuteMember, moveMember, getOrgMembers, assignMemberRole, getOrgBans, unbanMember } from '../controllers/modController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';

const router = Router({ mergeParams: true });

// Protect all routes
router.use(authenticateTokenStrict);

router.get('/', getOrgMembers);
router.put('/:userId/role', assignMemberRole);
router.post('/:userId/ban', banMember);
router.post('/:userId/kick', kickMember);
router.post('/:userId/kick-channel', kickFromChannel);
router.post('/:userId/mute', muteMember);
router.post('/:userId/unmute', unmuteMember);
router.post('/:userId/move', moveMember);

export default router;
