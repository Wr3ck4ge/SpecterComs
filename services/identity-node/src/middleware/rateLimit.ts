import { Request, Response, NextFunction } from 'express';

/**
 * Minimal in-process, IP-keyed rate limiter — no new dependency, mirrors the
 * existing per-user limiter pattern in abuseController.ts. Unlike that one
 * (keyed by authenticated user_id, a naturally bounded set), this is keyed by
 * client IP on PRE-auth endpoints (login/register/password-reset), so the hit
 * map is periodically swept to bound memory against IP-rotating abuse.
 *
 * Guards against unlimited online password brute-forcing and the CPU-exhaustion
 * DoS an attacker gets for free otherwise: every login attempt — valid or not —
 * forces an argon2.verify call before it can be rejected.
 */

interface Entry { count: number; resetAt: number; }

const SWEEP_INTERVAL_MS = 5 * 60_000;

export function createRateLimiter(windowMs: number, max: number, message = 'Too many requests. Try again later.') {
  const hits = new Map<string, Entry>();

  const sweep = () => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now > entry.resetAt) hits.delete(key);
    }
  };
  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      return res.status(429).json({ message });
    }
    entry.count += 1;
    next();
  };
}

// 10 attempts / 15 min per IP — generous enough for a legitimate user who fat-fingers
// a password a few times, tight enough to make online brute-forcing impractical.
export const loginRateLimiter = createRateLimiter(15 * 60_000, 10, 'Too many login attempts. Try again later.');
// Account creation doesn't need to be as tight, but unlimited registration enables
// automated spam-account creation.
export const registerRateLimiter = createRateLimiter(15 * 60_000, 10, 'Too many registration attempts. Try again later.');
// Forgot-password can be used to spam a victim's inbox — keep this tighter.
export const forgotPasswordRateLimiter = createRateLimiter(60 * 60_000, 5, 'Too many password reset requests. Try again later.');
