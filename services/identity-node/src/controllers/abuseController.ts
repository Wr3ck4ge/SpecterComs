import { Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

const abuseReportSchema = z.object({
  accused_id:        z.string().uuid(),
  channel_id:        z.string().uuid().optional(),
  reported_at:       z.string().datetime(),
  encrypted_content: z.string().max(8000),
  encrypted_context: z.string().max(40000).optional(),
  encryption_iv:     z.string().length(32),
  encryption_tag:    z.string().length(32),
});

// ── In-process rate limit: 5 reports per user per hour ───────────────────────
const reportCounts = new Map<string, { count: number; resetAt: number }>();

const checkRateLimit = (userId: string): boolean => {
  const now = Date.now();
  const entry = reportCounts.get(userId);
  if (!entry || now > entry.resetAt) {
    reportCounts.set(userId, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count += 1;
  return true;
};

// ── POST /abuse-reports ───────────────────────────────────────────────────────
export const createAbuseReport = async (req: AuthRequest, res: Response) => {
  const reporterId = req.user?.id;
  if (!reporterId) return res.status(401).json({ message: 'Unauthorized' });

  if (!checkRateLimit(reporterId)) {
    return res.status(429).json({ message: 'Too many reports. Try again later.' });
  }

  const parsed = abuseReportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  const {
    accused_id,
    channel_id,
    reported_at,
    encrypted_content,
    encrypted_context,
    encryption_iv,
    encryption_tag,
  } = parsed.data;

  if (reporterId === accused_id) {
    return res.status(400).json({ message: 'Cannot report yourself' });
  }

  try {
    // Validate accused_id is a real user
    const accusedCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [accused_id]);
    if (accusedCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Accused user not found' });
    }

    const result = await pool.query(
      `INSERT INTO abuse_reports
         (reporter_id, accused_id, channel_id, reported_at,
          encrypted_content, encrypted_context, encryption_iv, encryption_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        reporterId,
        accused_id,
        channel_id ?? null,
        reported_at,
        encrypted_content,
        encrypted_context ?? null,
        encryption_iv,
        encryption_tag,
      ]
    );

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error('createAbuseReport error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
