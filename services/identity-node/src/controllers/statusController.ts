import { Request, Response } from 'express';
import { pool } from '../config/db.js';
import { isNatsConnected } from '../config/nats.js';
import { liveSql } from '../config/nodeLiveness.js';
import { AdminRequest, writeAudit } from './adminController.js';
import { safeErr } from '../utils/adminPolicy.js';
import { ComponentState, StatusNotice, computeOverall, validateNotice } from '../utils/status.js';

// L7: GET /status is public and cached; it returns only coarse component
// states and the admin-written notice (no users, IPs or hostnames).

const CACHE_MS = 30_000;
let cache: { at: number; body: any } | null = null;
export const resetStatusCache = () => { cache = null; };

const noticeRow = (r: any): StatusNotice => ({
  id: Number(r.id), severity: r.severity, message: r.message,
  eta: r.eta ? new Date(r.eta).toISOString() : null, since: new Date(r.created_at).toISOString(),
});

async function activeNotice(): Promise<StatusNotice | null> {
  const r = await pool.query('SELECT id, severity, message, eta, created_at FROM status_notices WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1');
  return r.rows[0] ? noticeRow(r.rows[0]) : null;
}

async function checkComponents(): Promise<Record<string, ComponentState>> {
  const components: Record<string, ComponentState> = {};
  try {
    await Promise.race([pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    components.database = 'ok';
  } catch { components.database = 'outage'; }
  components.messaging = isNatsConnected() ? 'ok' : 'degraded';
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE ${liveSql('last_heartbeat_at')})::int AS live
                                FROM media_nodes WHERE NOT COALESCE(draining, FALSE)`);
    const { total, live } = r.rows[0] || { total: 0, live: 0 };
    if (total > 0) components.voice_video = live === 0 ? 'outage' : 'ok';
  } catch { /* unreachable table: the database check already says so */ }
  return components;
}

export const getStatus = async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (cache && Date.now() - cache.at < CACHE_MS) return res.json(cache.body);
  const components = await checkComponents();
  let notice: StatusNotice | null = null;
  if (components.database === 'ok') { try { notice = await activeNotice(); } catch { /* ignore */ } }
  const body = { state: computeOverall(components, notice), components, notice, checkedAt: new Date().toISOString() };
  cache = { at: Date.now(), body };
  res.json(body);
};

/** GET /admin/status-notice */
export const getNoticeAdmin = async (_req: AdminRequest, res: Response) => {
  try { res.json({ notice: await activeNotice() }); }
  catch (err) { console.error('[admin] status notice get:', safeErr(err)); res.status(500).json({ message: 'Internal server error' }); }
};

/** PUT /admin/status-notice { severity, message, eta? } - replaces any active notice. */
export const setNotice = async (req: AdminRequest, res: Response) => {
  const v = validateNotice(req.body);
  if (!v.ok) return res.status(400).json({ message: v.message });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE status_notices SET cleared_at = NOW() WHERE cleared_at IS NULL');
    const r = await client.query(
      `INSERT INTO status_notices (severity, message, eta, created_by) VALUES ($1, $2, $3, $4)
       RETURNING id, severity, message, eta, created_at`,
      [v.value.severity, v.value.message, v.value.eta, req.admin?.id ?? null],
    );
    await writeAudit(client, req, { action: 'status.notice_set', targetType: 'status_notice', targetId: String(r.rows[0].id), summary: { severity: v.value.severity, chars: v.value.message.length } });
    await client.query('COMMIT');
    resetStatusCache();
    res.json({ notice: noticeRow(r.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin] status notice set:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  } finally { client.release(); }
};

/** DELETE /admin/status-notice */
export const clearNotice = async (req: AdminRequest, res: Response) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('UPDATE status_notices SET cleared_at = NOW() WHERE cleared_at IS NULL RETURNING id');
    await writeAudit(client, req, { action: 'status.notice_clear', targetType: 'status_notice', targetId: r.rows[0] ? String(r.rows[0].id) : null, summary: {} });
    await client.query('COMMIT');
    resetStatusCache();
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin] status notice clear:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  } finally { client.release(); }
};
