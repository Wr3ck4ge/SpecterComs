import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { sendFriendRequest, acceptFriendRequest, getFriends, declineFriendRequest, removeFriend } from '../controllers/friendController.js';

const router = Router();

router.get('/', authenticateTokenStrict, getFriends);
router.post('/request', authenticateTokenStrict, sendFriendRequest);
router.post('/accept', authenticateTokenStrict, acceptFriendRequest);
router.post('/decline', authenticateTokenStrict, declineFriendRequest);
router.post('/remove', authenticateTokenStrict, removeFriend);

export default router;
