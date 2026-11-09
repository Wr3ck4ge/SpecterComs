import express, { Router, Request, Response, NextFunction } from 'express';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { recordPageview } from '../controllers/trafficController.js';

const router = Router();

// A person clicking around the site sends a beacon per route change; 30 a
// minute per IP is far more than that and caps what a script can inflate.
export const pageviewRateLimiter = createRateLimiter(60_000, 30, 'Slow down.');

// Mounted ahead of the app-wide JSON parser (see index.ts) so this route has
// its own tiny body limit, and a malformed or oversized body never produces
// an error response or a stack trace in the logs.
router.post(
  '/pageview',
  pageviewRateLimiter,
  express.text({ type: () => true, limit: '2kb' }),
  recordPageview,
);

router.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (!res.headersSent) res.status(204).end();
});

export default router;
