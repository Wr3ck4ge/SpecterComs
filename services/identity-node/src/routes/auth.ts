import { Router } from 'express';
import { register, login, forgotPassword, resetPassword, refresh, logout, verifyTwoFactorLogin } from '../controllers/authController.js';
import { userTwoFactor } from '../controllers/twoFactorController.js';
import { verifyEmail, verifyEmailRedirect, resendVerification, resendVerificationPublic } from '../controllers/emailVerificationController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, refreshSchema, verifyEmailSchema } from '../utils/validation.js';
import { loginRateLimiter, registerRateLimiter, forgotPasswordRateLimiter, refreshRateLimiter, verifyEmailRateLimiter, resendVerificationRateLimiter } from '../middleware/rateLimit.js';

import { appealStatus, fileAppeal } from '../controllers/banAppealController.js';

const router = Router();

// L12: a banned account has no tokens; these verify callsign/email + password themselves.
router.post('/appeal/status', loginRateLimiter, appealStatus);
router.post('/appeal', loginRateLimiter, fileAppeal);

router.post('/register', registerRateLimiter, validate(registerSchema), register);
router.post('/login', loginRateLimiter, validate(loginSchema), login);
router.post('/forgot-password', forgotPasswordRateLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', forgotPasswordRateLimiter, validate(resetPasswordSchema), resetPassword);
router.get('/verify-email', verifyEmailRateLimiter, verifyEmailRedirect);
router.post('/verify-email', verifyEmailRateLimiter, validate(verifyEmailSchema), verifyEmail);
router.post('/resend-verification', resendVerificationRateLimiter, authenticateTokenStrict as any, resendVerification as any);
router.post('/resend-verification-public', resendVerificationRateLimiter, validate(loginSchema), resendVerificationPublic);
router.post('/refresh', refreshRateLimiter, validate(refreshSchema), refresh);
router.post('/logout', logout);

// L3: two-factor authentication. verify = the login's second step (no session
// yet: challenge from /login). The rest manage the signed-in user's own 2FA.
router.post('/2fa/verify', loginRateLimiter, verifyTwoFactorLogin);
router.get('/2fa', authenticateTokenStrict as any, userTwoFactor.status);
router.post('/2fa/enroll', authenticateTokenStrict as any, userTwoFactor.enroll);
router.post('/2fa/confirm', authenticateTokenStrict as any, userTwoFactor.confirm);
router.post('/2fa/disable', authenticateTokenStrict as any, userTwoFactor.disable);
router.post('/2fa/recovery-codes', authenticateTokenStrict as any, userTwoFactor.regenerate);

export default router;
