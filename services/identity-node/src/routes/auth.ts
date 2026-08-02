import { Router } from 'express';
import { register, login, forgotPassword, resetPassword } from '../controllers/authController.js';
import { validate } from '../middleware/validationMiddleware.js';
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from '../utils/validation.js';
import { loginRateLimiter, registerRateLimiter, forgotPasswordRateLimiter } from '../middleware/rateLimit.js';

const router = Router();

router.post('/register', registerRateLimiter, validate(registerSchema), register);
router.post('/login', loginRateLimiter, validate(loginSchema), login);
router.post('/forgot-password', forgotPasswordRateLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', forgotPasswordRateLimiter, validate(resetPasswordSchema), resetPassword);

export default router;
