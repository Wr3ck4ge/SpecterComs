import { Request, Response } from 'express';
import { pool } from '../config/db.js';
import { createTrafficRecorder, parseTrafficDays, trafficReport } from '../utils/siteTraffic.js';
import { safeErr } from '../utils/adminPolicy.js';

// One recorder (and so one in-memory daily salt) per process.
const recorder = createTrafficRecorder(pool);

// Log a failing counter at most once a minute: the counter must never be the
// reason the logs fill up.
let lastLogged = 0;
const quietly = (label: string) => (err: unknown) => {
  const now = Date.now();
  if (now - lastLogged < 60_000) return;
  lastLogged = now;
  console.warn(`[traffic] ${label} not recorded:`, safeErr(err));
};

const ctxOf = (req: Request) => ({ ip: req.ip, ua: req.get('user-agent') });

/**
 * POST /metrics/pageview  body: { path, ref? }  (JSON or text/plain JSON —
 * navigator.sendBeacon sends a string as text/plain). Always answers 204
 * immediately; the write happens after the response and never surfaces.
 */
export const recordPageview = (req: Request, res: Response) => {
  let body: any = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  res.status(204).end();
  if (!body || typeof body !== 'object') return;
  recorder.pageview(body.path, body.ref, ctxOf(req)).catch(quietly('pageview'));
};

/** Called from the download controller just before an installer is streamed. */
export const recordDownload = (req: Request, platform: string) => {
  recorder.download(platform, ctxOf(req)).catch(quietly('download'));
};

/** GET /admin/traffic?days=30 (viewer). Aggregates only — no per-visitor data. */
export const getTrafficStats = async (req: Request, res: Response) => {
  try {
    res.json(await trafficReport(pool, parseTrafficDays(req.query.days)));
  } catch (err) {
    console.error('[admin] traffic error:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
};
