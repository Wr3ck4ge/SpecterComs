import { Router } from 'express';
import { register, login, forgotPassword, resetPassword, refresh, logout } from '../controllers/authController.js';
import { validate } from '../middleware/validationMiddleware.js';
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema, refreshSchema } from '../utils/validation.js';
import { loginRateLimiter, registerRateLimiter, forgotPasswordRateLimiter, refreshRateLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.post('/register', registerRateLimiter, validate(registerSchema), register);
router.post('/login', loginRateLimiter, validate(loginSchema), login);
router.post('/forgot-password', forgotPasswordRateLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', forgotPasswordRateLimiter, validate(resetPasswordSchema), resetPassword);
router.post('/refresh', refreshRateLimiter, validate(refreshSchema), refresh);
router.post('/logout', logout);

export default router;
