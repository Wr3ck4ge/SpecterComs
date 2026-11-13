import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { pool } from '../config/db.js';
import { createKeyedLimiter, safeErr } from '../utils/adminPolicy.js';
import { TS_REPORT_PURGE_SQL, retentionDays, dismissedRetentionDays, validateTsReport } from '../utils/tsReport.js';

// T3: trust & safety report intake (docs/TRUST_SAFETY_REPORTING_PLAN_2026_11_09.md).
//   GET  /ts-reports/key   the active T&S public key, to seal the report file to
//   POST /ts-reports       { category, subject, clientVersion, manifestSha256, keyId, sealed }
// The report file is sealed on the client; the server stores ciphertext only.
// Logs carry the report id and size, never metadata or contents. The reported
// person is never notified.

const router = Router();

const hourly = createKeyedLimiter(60 * 60 * 1000, 5);       // 5 reports / hour / user
const daily = createKeyedLimiter(24 * 60 * 60 * 1000, 20);  // 20 reports / day / user

export async function pruneClosedTsReports(days = retentionDays(), dismissedDays = dismissedRetentionDays()): Promise<number> {
  const r = await pool.query(TS_REPORT_PURGE_SQL, [days, dismissedDays]);
  return r.rowCount ?? 0;
}
if (process.env.NODE_ENV !== 'test') {
  const sweep = setInterval(() => {
    pruneClosedTsReports()
      .then((n) => { if (n) console.log(`[ts-report] retention purged ${n} closed report(s)`); })
      .catch((err) => console.error('[ts-report] retention sweep failed:', safeErr(err)));
  }, 60 * 60 * 1000);
  sweep.unref?.();
}

router.get('/key', authenticateTokenStrict as any, async (_req, res) => {
  try {
    const r = await pool.query('SELECT key_id, public_key FROM ts_report_keys WHERE active LIMIT 1');
    if (!r.rowCount) return res.status(503).json({ code: 'NO_REPORT_KEY', message: 'Reporting isn’t available right now. Please try again later.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ keyId: r.rows[0].key_id, publicKey: r.rows[0].public_key });
  } catch (err) {
    console.error('[ts-report] key lookup failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/', authenticateTokenStrict as any, async (req: any, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Sign in to send a report' });
  const v = validateTsReport(req.body);
  if (!v.ok) return res.status(400).json({ message: v.message });
  const k = String(userId);
  if (!hourly.take(k)) return res.status(429).json({ message: 'Too many reports. Please try again in an hour.' });
  if (!daily.take(k)) return res.status(429).json({ message: 'Too many reports today. Please try again tomorrow.' });
  const r = v.value;
  try {
    const key = await pool.query('SELECT 1 FROM ts_report_keys WHERE key_id = $1 AND active', [r.keyId]);
    if (!key.rowCount) return res.status(409).json({ code: 'REPORT_KEY_CHANGED', message: 'The report key changed. Please send it again.' });
    const ins = await pool.query(
      `INSERT INTO ts_reports (reporter_id, category, priority, subject_user_ids, subject_org_id, subject_channel_id,
                               client_version, manifest_sha256, key_id, sealed_header, ciphertext, blob_sha256, blob_bytes)
       VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [userId, r.category, r.priority, r.subjectUserIds, r.subjectOrgId, r.subjectChannelId, r.clientVersion,
        r.manifestSha256, r.keyId, JSON.stringify(r.sealedHeader), r.ciphertext, r.blobSha256, r.ciphertext.length],
    );
    console.log(`[ts-report] received ${ins.rows[0].id} (${r.ciphertext.length} bytes)`);
    res.status(201).json({ ok: true, id: ins.rows[0].id });
  } catch (err) {
    console.error('[ts-report] insert failed:', safeErr(err));
    res.status(500).json({ message: 'Couldn’t save the report' });
  }
});

export default router;
