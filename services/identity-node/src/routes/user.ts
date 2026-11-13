import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import {
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
import { requestEmailChange } from '../controllers/emailVerificationController.js';
import { validate } from '../middleware/validationMiddleware.js';
import { changeEmailSchema } from '../utils/validation.js';
import { forgotPasswordRateLimiter } from '../middleware/rateLimit.js';
import { getMyTransactions } from '../controllers/billingController.js';
import { getMyUpcomingEvents } from '../controllers/eventsController.js';

import { createMyDataRequest, listMyDataRequests, cancelMyDataRequest } from '../controllers/dataRequestController.js';

const router = Router();

router.get('/me',                        authenticateTokenStrict as any, getMyProfile as any);
router.get('/me/transactions',           authenticateTokenStrict as any, getMyTransactions as any);
router.get('/me/upcoming-events',        authenticateTokenStrict as any, getMyUpcomingEvents as any);
// L6: account data requests (export / delete); a human admin runs them.
router.post('/me/data-requests',         authenticateTokenStrict as any, createMyDataRequest as any);
router.get('/me/data-requests',          authenticateTokenStrict as any, listMyDataRequests as any);
router.delete('/me/data-requests/:id',   authenticateTokenStrict as any, cancelMyDataRequest as any);
router.put('/profile',                   authenticateTokenStrict as any, updateProfile as any);
router.post('/email',                     authenticateTokenStrict as any, forgotPasswordRateLimiter, validate(changeEmailSchema), requestEmailChange as any);
router.get('/games',                     authenticateTokenStrict as any, getMyGames as any);
router.put('/games',                     authenticateTokenStrict as any, updateMyGames as any);
router.get('/search',                    authenticateTokenStrict as any, searchUsers as any);
router.post('/intro-sound',              authenticateTokenStrict as any, introSoundUpload.single('audio'), uploadIntroSound as any);
router.delete('/intro-sound',            authenticateTokenStrict as any, deleteIntroSound as any);
router.get('/intro-sound/:callsign',     authenticateTokenStrict as any, getIntroSoundByCallsign as any);
router.post('/avatar',                   authenticateTokenStrict as any, avatarUpload.single('image'), uploadAvatar as any);

export default router;
