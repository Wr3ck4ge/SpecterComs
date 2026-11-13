import { Response } from 'express';
import argon2 from 'argon2';
import { pool } from '../config/db.js';
import { AdminRequest, writeAudit } from './adminController.js';
import { checkSecondFactor } from './twoFactorController.js';
import { createKeyedLimiter, isUuid, safeErr } from '../utils/adminPolicy.js';
import {
  DATA_REQUEST_NOTE_MAX, DATA_REQUEST_STATUSES, dueDate, validateDataRequestBody,
} from '../utils/dataRequests.js';

// L6: account data requests. User side (/users/me/data-requests) creates,
// lists and cancels; admin side (/admin/data-requests) lists and marks done
// after the owner has run the existing audited export / erasure.

const COLS = 'id, type, status, created_at, resolved_at';

// 5 attempts / hour / user; counted before the password is evaluated, so this
// also bounds password guessing through this endpoint.
const createLimiter = createKeyedLimiter(60 * 60 * 1000, 5);
const readLimiter = createKeyedLimiter(60 * 1000, 30);

const present = (r: any) => ({
  id: r.id, type: r.type, status: r.status, created_at: r.created_at, resolved_at: r.resolved_at,
  due_by: r.status === 'open' ? dueDate(r.created_at) : null,
});

/** POST /users/me/data-requests { type, password } */
export const createMyDataRequest = async (req: any, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Sign in first' });
  const v = validateDataRequestBody(req.body);
  if (!v.ok) return res.status(400).json({ message: v.message });
  if (!createLimiter.take(String(userId))) return res.status(429).json({ message: 'Too many attempts. Please try again in an hour.' });
  try {
    const u = await pool.query('SELECT callsign, password_hash, erased_at FROM users WHERE id = $1', [userId]);
    const row = u.rows[0];
    const ok = row && !row.erased_at && row.password_hash
      ? await argon2.verify(row.password_hash, v.password).catch(() => false) : false;
    if (!ok) return res.status(401).json({ code: 'PASSWORD_INCORRECT', message: 'Incorrect password.' });
    // L3: with 2FA on, this re-auth also needs a code (answers 401/429 itself).
    if (!(await checkSecondFactor({ type: 'user', id: String(userId) }, req.body, res))) return;
    const ins = await pool.query(
      `INSERT INTO data_requests (user_id, callsign, type) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, type) WHERE status = 'open' DO NOTHING
       RETURNING ${COLS}`,
      [userId, row.callsign, v.type],
    );
    if (!ins.rowCount) return res.status(409).json({ code: 'ALREADY_OPEN', message: 'You already have an open request of this kind.' });
    console.log(`[data-request] ${v.type} request ${ins.rows[0].id}`);
    res.status(201).json({ request: present(ins.rows[0]) });
  } catch (err) {
    console.error('[data-request] create failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
};

/** GET /users/me/data-requests — the caller's own, newest first. */
export const listMyDataRequests = async (req: any, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Sign in first' });
  if (!readLimiter.take(String(userId))) return res.status(429).json({ message: 'Slow down.' });
  try {
    const r = await pool.query(`SELECT ${COLS} FROM data_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]);
    res.json({ requests: r.rows.map(present) });
  } catch (err) {
    console.error('[data-request] list failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
};

/** DELETE /users/me/data-requests/:id — cancel an open delete request. */
export const cancelMyDataRequest = async (req: any, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Sign in first' });
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid request id' });
  try {
    const r = await pool.query(
      `UPDATE data_requests SET status = 'cancelled', resolved_at = NOW()
       WHERE id = $1 AND user_id = $2 AND type = 'delete' AND status = 'open'`,
      [id, userId],
    );
    if (!r.rowCount) return res.status(404).json({ message: 'No open deletion request to cancel.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[data-request] cancel failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
};

/** GET /admin/data-requests?status=open|done|cancelled|all */
export const listDataRequestsAdmin = async (req: AdminRequest, res: Response) => {
  const s = typeof req.query.status === 'string' ? req.query.status : 'open';
  const status = (DATA_REQUEST_STATUSES as readonly string[]).includes(s) ? s : null;
  try {
    const r = await pool.query(
      `SELECT id, user_id, callsign, type, status, created_at, resolved_at, resolved_by, note
       FROM data_requests ${status ? 'WHERE status = $1' : ''}
       ORDER BY created_at ASC LIMIT 200`,
      status ? [status] : [],
    );
    res.json({ requests: r.rows.map((x) => ({ ...x, due_by: dueDate(x.created_at) })) });
  } catch (err) {
    console.error('[admin] list data requests error:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
};

/** POST /admin/data-requests/:id/complete { note? } — after the export / erasure was run. */
export const completeDataRequestAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid request id' });
  const note = req.body?.note;
  if (note != null && (typeof note !== 'string' || note.length > DATA_REQUEST_NOTE_MAX)) {
    return res.status(400).json({ message: `note must be at most ${DATA_REQUEST_NOTE_MAX} characters` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE data_requests SET status = 'done', resolved_at = NOW(), resolved_by = $2, note = $3
       WHERE id = $1 AND status = 'open' RETURNING type, user_id`,
      [id, (req.admin?.username ?? '').slice(0, 32) || null, note || null],
    );
    if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'No open request with that id.' }); }
    await writeAudit(client, req, {
      action: 'data_request.completed', targetType: 'user', targetId: r.rows[0].user_id ?? null,
      summary: { request_id: id, type: r.rows[0].type },
    });
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin] complete data request error:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
};
