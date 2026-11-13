import { Response } from 'express';
import { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { AdminRequest, writeAudit } from './adminController.js';
import { isUuid, parseListParams, safeErr } from '../utils/adminPolicy.js';
import { validateReportKey } from '../utils/bugReport.js';
import {
  TS_REPORT_CATEGORIES, TS_REPORT_STATES, canTransition, csamReviewerAllowed, isClosedState, parseReason,
} from '../utils/tsReport.js';

// T3: trust & safety queue, admin side (owner role, like the D1 bug reports:
// only the reviewer's browser holds the T&S private key). The server hands out
// sealed report files as opaque blobs; decrypting and verifying happens in the
// review tool (T4). Every per-report action writes an append-only custody row
// (ts_report_custody) and an admin_audit_log row, in one transaction.

function fail(res: Response, label: string, err: unknown) {
  console.error(`[admin] ${label} error:`, safeErr(err));
  return res.status(500).json({ message: 'Internal server error' });
}

class NotFound extends Error {}

async function custody(db: PoolClient, req: AdminRequest, reportId: string, action: string, detail: Record<string, unknown>) {
  await db.query(
    `INSERT INTO ts_report_custody (report_id, admin_id, admin_username, action, detail) VALUES ($1, $2, $3, $4, $5)`,
    [reportId, req.admin?.id ?? null, req.admin?.username ? req.admin.username.slice(0, 32) : null, action, JSON.stringify(detail)],
  );
  await writeAudit(db, req, { action: `ts_report.${action}`, targetType: 'ts_report', targetId: reportId, summary: detail });
}

/** Runs fn in a transaction; fn throws NotFound for a 404. */
async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** GET /admin/ts-reports/keys — every key (active first), wrapped. */
export const listTsReportKeys = async (_req: AdminRequest, res: Response) => {
  try {
    const r = await pool.query('SELECT key_id, public_key, wrapped, active, created_at FROM ts_report_keys ORDER BY active DESC, created_at DESC');
    res.json({ keys: r.rows });
  } catch (err) {
    return fail(res, 'list ts report keys', err);
  }
};

/** PUT /admin/ts-reports/key { keyId, publicKey, wrapped } — becomes the active key (reauth). */
export const setTsReportKey = async (req: AdminRequest, res: Response) => {
  const v = validateReportKey(req.body);
  if (!v.ok) return res.status(400).json({ message: v.message });
  const { keyId, publicKey, wrapped } = req.body;
  try {
    await tx(async (c) => {
      await c.query('UPDATE ts_report_keys SET active = FALSE WHERE active');
      await c.query(
        `INSERT INTO ts_report_keys (key_id, public_key, wrapped, active) VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (key_id) DO UPDATE SET active = TRUE`,
        [keyId, JSON.stringify({ kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y }), JSON.stringify(wrapped)],
      );
      await writeAudit(c, req, { action: 'ts_report.key_set', targetType: 'ts_report_key', targetId: keyId, summary: {} });
    });
    res.json({ ok: true, keyId });
  } catch (err) {
    return fail(res, 'set ts report key', err);
  }
};

const META_COLS = `id, reporter_id, category, priority, subject_user_ids, subject_org_id, subject_channel_id,
  client_version, manifest_sha256, key_id, blob_sha256, blob_bytes, state, legal_hold, created_at, updated_at, closed_at`;

/** GET /admin/ts-reports?state=&category=&hold=&page=&limit= — metadata only, priority first. */
export const listTsReportsAdmin = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, { created_at: 'created_at' }, 'created_at', 'asc');
  const q = req.query as Record<string, unknown>;
  const where: string[] = [];
  const params: any[] = [];
  if (typeof q.state === 'string' && (TS_REPORT_STATES as readonly string[]).includes(q.state)) {
    params.push(q.state); where.push(`state = $${params.length}`);
  } else if (q.state === 'open') {
    where.push(`state IN ('received', 'in_review')`);
  }
  if (typeof q.category === 'string' && (TS_REPORT_CATEGORIES as readonly string[]).includes(q.category)) {
    params.push(q.category); where.push(`category = $${params.length}`);
  }
  if (q.hold === 'true' || q.hold === 'false') where.push(q.hold === 'true' ? 'legal_hold' : 'NOT legal_hold');
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM ts_reports ${w}`, params),
      pool.query(
        `SELECT ${META_COLS} FROM ts_reports ${w}
         ORDER BY priority ASC, ${p.sortSql} ${p.dir}, id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      ),
    ]);
    res.json({ reports: rows.rows, total: count.rows[0].n, page: p.page, limit: p.limit });
  } catch (err) {
    return fail(res, 'list ts reports', err);
  }
};

/** GET /admin/ts-reports/:id/blob — the sealed file (header + base64 ciphertext). Logged in custody. */
export const getTsReportBlobAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid report id' });
  try {
    const meta = await pool.query('SELECT category FROM ts_reports WHERE id = $1', [id]);
    if (!meta.rowCount) return res.status(404).json({ message: 'Report not found' });
    // CSAM (plan section 6): designated reviewer only, and a fresh password confirmation.
    if (meta.rows[0].category === 'csam') {
      if (!csamReviewerAllowed(req.admin?.id)) return res.status(403).json({ message: 'Only the designated reviewer can open this report.' });
      if (!req.admin?.reauthFresh) return res.status(403).json({ message: 'Please re-enter your password to confirm this action.', code: 'REAUTH_REQUIRED' });
    }
    const out = await tx(async (c) => {
      const r = await c.query('SELECT sealed_header, ciphertext, blob_sha256 FROM ts_reports WHERE id = $1', [id]);
      if (!r.rowCount) throw new NotFound();
      await custody(c, req, id, 'blob_accessed', {});
      return r.rows[0];
    });
    res.json({ sealed: { ...out.sealed_header, ct: (out.ciphertext as Buffer).toString('base64') }, blobSha256: out.blob_sha256 });
  } catch (err) {
    if (err instanceof NotFound) return res.status(404).json({ message: 'Report not found' });
    return fail(res, 'get ts report blob', err);
  }
};

/** PATCH /admin/ts-reports/:id/state { state, reason? } */
export const setTsReportStateAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid report id' });
  const { state, reason } = req.body ?? {};
  if (typeof state !== 'string' || !(TS_REPORT_STATES as readonly string[]).includes(state) || state === 'received') {
    return res.status(400).json({ message: 'Invalid state' });
  }
  const why = reason == null ? null : parseReason(reason);
  if (reason != null && !why) return res.status(400).json({ message: 'Invalid reason' });
  try {
    const result = await tx(async (c) => {
      const cur = await c.query('SELECT state FROM ts_reports WHERE id = $1 FOR UPDATE', [id]);
      if (!cur.rowCount) throw new NotFound();
      const from = cur.rows[0].state as string;
      if (!canTransition(from, state)) return { ok: false as const, from };
      await c.query(
        `UPDATE ts_reports SET state = $2, updated_at = NOW(),
                closed_at = CASE WHEN $3::boolean THEN COALESCE(closed_at, NOW()) ELSE NULL END
         WHERE id = $1`,
        [id, state, isClosedState(state)],
      );
      await custody(c, req, id, 'state_changed', { from, to: state, ...(why ? { reason: why } : {}) });
      return { ok: true as const, from };
    });
    if (!result.ok) return res.status(409).json({ message: `Can't move a report from ${result.from} to ${state}` });
    res.json({ ok: true, state });
  } catch (err) {
    if (err instanceof NotFound) return res.status(404).json({ message: 'Report not found' });
    return fail(res, 'set ts report state', err);
  }
};

/** PUT /admin/ts-reports/:id/legal-hold { hold: boolean, reason } (reauth) */
export const setTsReportHoldAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid report id' });
  const { hold, reason } = req.body ?? {};
  if (typeof hold !== 'boolean') return res.status(400).json({ message: 'hold must be true or false' });
  const why = parseReason(reason);
  if (!why) return res.status(400).json({ message: 'A reason is required' });
  try {
    const changed = await tx(async (c) => {
      const cur = await c.query('SELECT legal_hold FROM ts_reports WHERE id = $1 FOR UPDATE', [id]);
      if (!cur.rowCount) throw new NotFound();
      if (cur.rows[0].legal_hold === hold) return false;
      await c.query('UPDATE ts_reports SET legal_hold = $2, updated_at = NOW() WHERE id = $1', [id, hold]);
      await custody(c, req, id, hold ? 'hold_set' : 'hold_cleared', { reason: why });
      return true;
    });
    res.json({ ok: true, legalHold: hold, changed });
  } catch (err) {
    if (err instanceof NotFound) return res.status(404).json({ message: 'Report not found' });
    return fail(res, 'set ts report legal hold', err);
  }
};

/** GET /admin/ts-reports/:id/custody — the report's chain of custody, oldest first. */
export const getTsReportCustodyAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid report id' });
  try {
    const r = await pool.query(
      'SELECT id, admin_id, admin_username, action, detail, at FROM ts_report_custody WHERE report_id = $1 ORDER BY at, id',
      [id],
    );
    res.json({ custody: r.rows });
  } catch (err) {
    return fail(res, 'get ts report custody', err);
  }
};
