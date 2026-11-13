import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { pool } from '../config/db.js';
import { createKeyedLimiter, isUuid, safeErr } from '../utils/adminPolicy.js';
import { validateBugReport } from '../utils/bugReport.js';

// D1: "Report and describe a bug" (Settings → About & diagnostics).
//   GET  /bug-reports/key   the owner's active public key, to seal to
//   POST /bug-reports       { category, appVersion, keyId, sealed, descChars, redactions, diagnostics }
//   GET  /bug-reports/mine  the caller's own reports + the owner's replies
//   POST /bug-reports/:id/seen  the caller has seen the current reply
// The description is sealed on the client; logs carry only the id and length.

const router = Router();

const limiter = createKeyedLimiter(60 * 60 * 1000, 5); // 5 reports / hour / user

/** BUG_REPORT_RETENTION_DAYS (legacy BUG_REPORT_TTL_DAYS), default 30, never below 1. */
export const bugReportRetentionDays = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.BUG_REPORT_RETENTION_DAYS ?? env.BUG_REPORT_TTL_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
};
export const BUG_REPORT_PURGE_SQL = `DELETE FROM bug_reports WHERE created_at < NOW() - make_interval(days => $1::int)`;

export async function pruneOldBugReports(days = bugReportRetentionDays()): Promise<number> {
  const r = await pool.query(BUG_REPORT_PURGE_SQL, [days]);
  return r.rowCount ?? 0;
}
const sweep = setInterval(() => { pruneOldBugReports().catch(() => {}); }, 60 * 60 * 1000);
sweep.unref?.();

router.get('/key', authenticateTokenStrict as any, async (_req, res) => {
  try {
    const r = await pool.query('SELECT key_id, public_key FROM bug_report_keys WHERE active LIMIT 1');
    if (!r.rowCount) return res.status(503).json({ code: 'NO_REPORT_KEY', message: 'Bug reports aren’t set up yet. Please try again later.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ keyId: r.rows[0].key_id, publicKey: r.rows[0].public_key });
  } catch (err) {
    console.error('[bug-report] key lookup failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
});

// The reporter's own reports, with the owner's reply. Never the sealed
// description (the reporter's client can't open it, and it isn't theirs to
// re-read from the server).
router.get('/mine', authenticateTokenStrict as any, async (req: any, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Sign in first' });
  try {
    const r = await pool.query(
      `SELECT id, category, app_version, status, created_at, resolution, resolved_at,
              (resolution IS NOT NULL AND reply_seen_at IS NULL) AS unread
       FROM bug_reports WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [userId],
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ reports: r.rows, unread: r.rows.filter((x) => x.unread).length });
  } catch (err) {
    console.error('[bug-report] list mine failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/:id/seen', authenticateTokenStrict as any, async (req: any, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Sign in first' });
  if (!isUuid(req.params.id)) return res.status(400).json({ message: 'Invalid report id' });
  try {
    await pool.query(
      'UPDATE bug_reports SET reply_seen_at = NOW() WHERE id = $1 AND user_id = $2 AND resolution IS NOT NULL AND reply_seen_at IS NULL',
      [req.params.id, userId],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[bug-report] mark seen failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/', authenticateTokenStrict as any, async (req: any, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Sign in to send a report' });
  const v = validateBugReport(req.body);
  if (!v.ok) return res.status(400).json({ message: v.message });
  if (!limiter.take(String(userId))) return res.status(429).json({ message: 'Too many reports. Please try again in an hour.' });
  const r = v.value;
  try {
    const key = await pool.query('SELECT 1 FROM bug_report_keys WHERE key_id = $1 AND active', [r.keyId]);
    if (!key.rowCount) return res.status(409).json({ code: 'REPORT_KEY_CHANGED', message: 'The report key changed. Please send it again.' });
    const ins = await pool.query(
      `INSERT INTO bug_reports (user_id, callsign, category, app_version, key_id, sealed, desc_chars, redactions, diagnostics)
       VALUES ($1, (SELECT callsign FROM users WHERE id = $1), $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [userId, r.category, r.appVersion, r.keyId, JSON.stringify(r.sealed), r.descChars, r.redactions, r.diagnostics],
    );
    console.log(`[bug-report] received ${ins.rows[0].id} (${r.descChars} chars)`);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (err) {
    console.error('[bug-report] insert failed:', safeErr(err));
    res.status(500).json({ message: 'Couldn’t save the report' });
  }
});

export default router;
