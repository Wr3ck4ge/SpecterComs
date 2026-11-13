import { Response } from 'express';
import { pool } from '../config/db.js';
import { AdminRequest, writeAudit } from './adminController.js';
import { isUuid, parseListParams, safeErr } from '../utils/adminPolicy.js';
import { BUG_REPORT_STATUSES, OWNER_NOTE_MAX, RESOLUTION_MAX, cleanResolution, validateReportKey } from '../utils/bugReport.js';

// D1: bug reports, admin side (owner only). The server hands out sealed
// descriptions and the wrapped key as opaque blobs; opening them happens in
// the owner's browser (website/src/components/admin/BugReportsSection.jsx).

function fail(res: Response, label: string, err: unknown) {
  console.error(`[admin] ${label} error:`, safeErr(err));
  return res.status(500).json({ message: 'Internal server error' });
}

/** GET /admin/bug-reports/keys — every key (active first), wrapped. */
export const listBugReportKeys = async (_req: AdminRequest, res: Response) => {
  try {
    const r = await pool.query('SELECT key_id, public_key, wrapped, active, created_at FROM bug_report_keys ORDER BY active DESC, created_at DESC');
    res.json({ keys: r.rows });
  } catch (err) {
    return fail(res, 'list bug report keys', err);
  }
};

/** PUT /admin/bug-reports/key { keyId, publicKey, wrapped } — becomes the active key (reauth). */
export const setBugReportKey = async (req: AdminRequest, res: Response) => {
  const v = validateReportKey(req.body);
  if (!v.ok) return res.status(400).json({ message: v.message });
  const { keyId, publicKey, wrapped } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE bug_report_keys SET active = FALSE WHERE active');
    await client.query(
      `INSERT INTO bug_report_keys (key_id, public_key, wrapped, active) VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (key_id) DO UPDATE SET active = TRUE`,
      [keyId, JSON.stringify({ kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y }), JSON.stringify(wrapped)],
    );
    await writeAudit(client, req, { action: 'bug_report.key_set', targetType: 'bug_report_key', targetId: keyId, summary: {} });
    await client.query('COMMIT');
    res.json({ ok: true, keyId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return fail(res, 'set bug report key', err);
  } finally {
    client.release();
  }
};

/** GET /admin/bug-reports?status=&page=&limit= — sealed descriptions included (opened in the browser). */
export const listBugReportsAdmin = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, { created_at: 'created_at' }, 'created_at');
  const status = typeof req.query.status === 'string' && (BUG_REPORT_STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : null;
  const params: any[] = status ? [status] : [];
  const where = status ? 'WHERE status = $1' : '';
  try {
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM bug_reports ${where}`, params),
      pool.query(
        `SELECT id, user_id, callsign, category, app_version, key_id, sealed, desc_chars, redactions,
                diagnostics, status, owner_note, resolution, resolved_at, reply_seen_at, created_at, updated_at
         FROM bug_reports ${where}
         ORDER BY ${p.sortSql} ${p.dir}, id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      ),
    ]);
    res.json({ reports: rows.rows, total: count.rows[0].n, page: p.page, limit: p.limit });
  } catch (err) {
    return fail(res, 'list bug reports', err);
  }
};

/** PATCH /admin/bug-reports/:id { status, owner_note?, resolution? } — resolution omitted = unchanged. */
export const updateBugReportAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid report id' });
  const { status, owner_note } = req.body ?? {};
  if (!(BUG_REPORT_STATUSES as readonly string[]).includes(status)) return res.status(400).json({ message: 'Invalid status' });
  if (owner_note != null && (typeof owner_note !== 'string' || owner_note.length > OWNER_NOTE_MAX)) {
    return res.status(400).json({ message: `owner_note must be a string of at most ${OWNER_NOTE_MAX} characters` });
  }
  const hasResolution = req.body && Object.prototype.hasOwnProperty.call(req.body, 'resolution');
  const resolution = hasResolution ? cleanResolution(req.body.resolution) : null;
  if (resolution === undefined) {
    return res.status(400).json({ message: `The reply must be text of at most ${RESOLUTION_MAX} characters` });
  }
  try {
    // A changed reply is stamped and shown to the reporter as new again;
    // the same text re-saved leaves it as it was.
    const r = await pool.query(
      `UPDATE bug_reports SET status = $2, owner_note = $3, updated_at = NOW(),
              resolution    = CASE WHEN $4::boolean THEN $5 ELSE resolution END,
              resolved_at   = CASE WHEN $4::boolean AND $5 IS DISTINCT FROM resolution
                                   THEN (CASE WHEN $5 IS NULL THEN NULL ELSE NOW() END) ELSE resolved_at END,
              reply_seen_at = CASE WHEN $4::boolean AND $5 IS DISTINCT FROM resolution THEN NULL ELSE reply_seen_at END
       WHERE id = $1`,
      [id, status, owner_note || null, hasResolution, resolution],
    );
    if (!r.rowCount) return res.status(404).json({ message: 'Report not found' });
    await writeAudit(pool, req, {
      action: 'bug_report.updated', targetType: 'bug_report', targetId: id,
      summary: { status, ...(hasResolution ? { reply: resolution ? 'set' : 'cleared' } : {}) },
    });
    res.json({ ok: true });
  } catch (err) {
    return fail(res, 'update bug report', err);
  }
};

/** DELETE /admin/bug-reports/:id — handled; gone for good. */
export const deleteBugReportAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid report id' });
  try {
    const r = await pool.query('DELETE FROM bug_reports WHERE id = $1', [id]);
    if (!r.rowCount) return res.status(404).json({ message: 'Report not found' });
    await writeAudit(pool, req, { action: 'bug_report.deleted', targetType: 'bug_report', targetId: id, summary: {} });
    res.json({ ok: true });
  } catch (err) {
    return fail(res, 'delete bug report', err);
  }
};
