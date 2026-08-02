import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import {
  updatePresence,
  searchUsers,
  getMyProfile,
  updateProfile,
  getMyGames,
  updateMyGames,
  uploadIntroSound,
  deleteIntroSound,
  getIntroSoundByCallsign,
  introSoundUpload,
  uploadAvatar,
  avatarUpload,
} from '../controllers/userController.js';
import { getMyTransactions } from '../controllers/billingController.js';

const router = Router();

router.get('/me',                        authenticateTokenStrict as any, getMyProfile as any);
router.get('/me/transactions',           authenticateTokenStrict as any, getMyTransactions as any);
router.put('/profile',                   authenticateTokenStrict as any, updateProfile as any);
router.get('/games',                     authenticateTokenStrict as any, getMyGames as any);
router.put('/games',                     authenticateTokenStrict as any, updateMyGames as any);
router.put('/presence',                  authenticateTokenStrict as any, updatePresence as any);
router.get('/search',                    authenticateTokenStrict as any, searchUsers as any);
router.post('/intro-sound',              authenticateTokenStrict as any, introSoundUpload.single('audio'), uploadIntroSound as any);
router.delete('/intro-sound',            authenticateTokenStrict as any, deleteIntroSound as any);
router.get('/intro-sound/:callsign',     authenticateTokenStrict as any, getIntroSoundByCallsign as any);
router.post('/avatar',                   authenticateTokenStrict as any, avatarUpload.single('image'), uploadAvatar as any);

export default router;
