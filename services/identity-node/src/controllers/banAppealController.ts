import { Request, Response } from 'express';
import argon2 from 'argon2';
import { pool } from '../config/db.js';
import { AdminRequest, writeAudit } from './adminController.js';
import { createKeyedLimiter, effectiveAdminRole, hashEmailForLookup, isUuid, roleAtLeast, safeErr } from '../utils/adminPolicy.js';
import { decryptEmail } from '../utils/encryption.js';
import { sendAppealDecisionEmail } from '../utils/emailService.js';
import {
  APPEAL_ANSWER_DAYS, APPEAL_NOTE_MAX, APPEAL_RETENTION_DAYS, addDays, checkDecider, checkEligibility, validateAppealText,
} from '../utils/banAppeals.js';

// L12: platform ban appeals. A banned account has no tokens, so the user proves
// who they are the same way sign-in does (callsign or email + password) on
// every appeal call; nothing is revealed before the password checks out, so it
// can't be used to probe which accounts are banned. Scope: Specter platform
// actions only; a server's own kicks/bans are the server's business.

const limiter = createKeyedLimiter(60 * 60 * 1000, 20); // per IP, counted before the password check

const appealView = (a: any) => a && ({
  state: a.state, created_at: a.created_at, due_by: addDays(a.created_at, APPEAL_ANSWER_DAYS),
  decided_at: a.decided_at, decision_note: a.decision_note, text: a.text,
});

/** Password-verified lookup of a banned (not erased) account. Sends the response itself on failure. */
async function authenticateBanned(req: Request, res: Response): Promise<{ id: string; callsign: string } | null> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!limiter.take(String(req.ip ?? 'unknown'))) { res.status(429).json({ message: 'Too many attempts. Try again later.' }); return null; }
  const password = typeof b.password === 'string' ? b.password : '';
  const callsign = typeof b.callsign === 'string' ? b.callsign.trim() : '';
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (!password || password.length > 1024 || (!callsign && !email)) {
    res.status(400).json({ message: 'Callsign or email, and password, required' }); return null;
  }
  const cols = 'id, callsign, password_hash, COALESCE(is_banned,false) AS is_banned, erased_at';
  const q = callsign
    ? await pool.query(`SELECT ${cols} FROM users WHERE lower(callsign) = lower($1)`, [callsign])
    : await pool.query(`SELECT ${cols} FROM users WHERE email_hash = $1`, [hashEmailForLookup(email)]);
  const u = q.rows[0];
  const ok = u && !u.erased_at && u.password_hash ? await argon2.verify(u.password_hash, password).catch(() => false) : false;
  if (!ok) { res.status(401).json({ message: 'Invalid credentials' }); return null; }
  if (!u.is_banned) { res.status(409).json({ code: 'NOT_RESTRICTED', message: 'This account is not suspended. You can sign in normally.' }); return null; }
  return { id: u.id, callsign: u.callsign };
}

/** The ban the user is appealing: the newest user.banned audit entry, plus whether it is CSAM-related. */
async function currentAction(userId: string) {
  const a = await pool.query(
    `SELECT id, admin_id, created_at, reason, COALESCE((summary->>'csam')::boolean, false) AS csam
     FROM admin_audit_log WHERE action = 'user.banned' AND target_type = 'user' AND target_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 1`, [userId]);
  const row = a.rows[0];
  if (!row) return null;
  // A CSAM report naming this account that wasn't dismissed counts too.
  const ts = await pool.query(
    `SELECT 1 FROM ts_reports WHERE category = 'csam' AND state <> 'dismissed' AND $1::uuid = ANY(subject_user_ids) LIMIT 1`, [userId]);
  const ap = await pool.query(
    `SELECT state, created_at, decided_at, decision_note, text FROM ban_appeals WHERE action_audit_id = $1`, [row.id]);
  return { ...row, csam: row.csam || (ts.rowCount ?? 0) > 0, appeal: ap.rows[0] ?? null };
}

/** POST /auth/appeal/status { callsign|email, password } */
export const appealStatus = async (req: Request, res: Response) => {
  try {
    const u = await authenticateBanned(req, res);
    if (!u) return;
    const act = await currentAction(u.id);
    const el = checkEligibility({ hasAction: !!act, actionAt: act?.created_at, csam: act?.csam, alreadyAppealed: !!act?.appeal });
    if (!el.ok && el.code === 'CSAM') return res.json({ callsign: u.callsign, can_appeal: false, code: el.code, message: el.message });
    res.json({
      callsign: u.callsign,
      can_appeal: el.ok,
      ...(el.ok ? {} : { code: el.code, message: el.message }),
      action: act ? { at: act.created_at, reason: act.reason ?? null } : null,
      appeal: appealView(act?.appeal),
    });
  } catch (err) {
    console.error('[appeal] status failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
};

/** POST /auth/appeal { callsign|email, password, text } */
export const fileAppeal = async (req: Request, res: Response) => {
  const v = validateAppealText(req.body?.text);
  if (!v.ok) return res.status(400).json({ message: v.message });
  try {
    const u = await authenticateBanned(req, res);
    if (!u) return;
    const act = await currentAction(u.id);
    const el = checkEligibility({ hasAction: !!act, actionAt: act?.created_at, csam: act?.csam, alreadyAppealed: !!act?.appeal });
    if (!el.ok) return res.status(el.code === 'ALREADY_APPEALED' ? 409 : 403).json({ code: el.code, message: el.message });
    const ins = await pool.query(
      `INSERT INTO ban_appeals (user_id, action_audit_id, action_admin_id, action_at, text)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (action_audit_id) DO NOTHING
       RETURNING state, created_at, decided_at, decision_note, text`,
      [u.id, act.id, act.admin_id ?? null, act.created_at, v.text]);
    if (!ins.rowCount) return res.status(409).json({ code: 'ALREADY_APPEALED', message: 'This action has already been appealed. Each action can be appealed once.' });
    console.log('[appeal] filed');
    res.status(201).json({ appeal: appealView(ins.rows[0]) });
  } catch (err) {
    console.error('[appeal] file failed:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
};

/** GET /admin/appeals?state=open|upheld|overturned|all */
export const listAppealsAdmin = async (req: AdminRequest, res: Response) => {
  const s = typeof req.query.state === 'string' ? req.query.state : 'open';
  const state = ['open', 'upheld', 'overturned'].includes(s) ? s : null;
  try {
    const r = await pool.query(
      `SELECT a.id, a.user_id, u.callsign, a.text, a.state, a.created_at, a.action_at, a.action_admin_id,
              a.decided_by_username, a.decided_at, a.decision_note,
              l.admin_username AS action_admin_username, l.reason AS action_reason
       FROM ban_appeals a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN admin_audit_log l ON l.id = a.action_audit_id
       ${state ? 'WHERE a.state = $1' : ''} ORDER BY a.created_at ASC LIMIT 200`,
      state ? [state] : []);
    res.json({
      appeals: r.rows.map((x) => ({
        ...x, due_by: addDays(x.created_at, APPEAL_ANSWER_DAYS),
        is_own_action: !!x.action_admin_id && x.action_admin_id === req.admin?.id,
      })),
    });
  } catch (err) {
    console.error('[admin] list appeals error:', safeErr(err));
    res.status(500).json({ message: 'Internal server error' });
  }
};

/** POST /admin/appeals/:id/decide { decision: 'upheld'|'overturned', note? } */
export const decideAppealAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!isUuid(id)) return res.status(400).json({ message: 'Invalid appeal id' });
  const decision = req.body?.decision;
  if (decision !== 'upheld' && decision !== 'overturned') return res.status(400).json({ message: 'decision must be "upheld" or "overturned"' });
  const note = req.body?.note;
  if (note != null && (typeof note !== 'string' || note.length > APPEAL_NOTE_MAX)) {
    return res.status(400).json({ message: `note must be at most ${APPEAL_NOTE_MAX} characters` });
  }
  const c = await pool.connect();
  let email: string | null = null;
  let soleAdmin = false;
  try {
    await c.query('BEGIN');
    const ar = await c.query('SELECT id, user_id, action_admin_id, state FROM ban_appeals WHERE id = $1 FOR UPDATE', [id]);
    const ap = ar.rows[0];
    if (!ap) { await c.query('ROLLBACK'); return res.status(404).json({ message: 'Appeal not found.' }); }
    if (ap.state !== 'open') { await c.query('ROLLBACK'); return res.status(409).json({ message: 'This appeal has already been decided.' }); }
    const admins = await c.query('SELECT role, permissions FROM platform_admins');
    const deciderCount = admins.rows.filter((r) => roleAtLeast(effectiveAdminRole(r), 'operator')).length;
    const d = checkDecider({ actionAdminId: ap.action_admin_id, deciderId: req.admin!.id, deciderCount });
    if (!d.ok) { await c.query('ROLLBACK'); return res.status(403).json({ code: 'SAME_ADMIN', message: d.message }); }
    soleAdmin = d.soleAdmin;

    await c.query(
      `UPDATE ban_appeals SET state = $2, decided_by = $3, decided_by_username = $4, decided_at = NOW(), decision_note = $5 WHERE id = $1`,
      [id, decision, req.admin!.id, (req.admin!.username ?? '').slice(0, 32) || null, note || null]);

    let hwidRemoved = false;
    const ur = await c.query('SELECT hwid, email_encrypted FROM users WHERE id = $1 FOR UPDATE', [ap.user_id]);
    if (decision === 'overturned') {
      await c.query('UPDATE users SET is_banned = FALSE, banned_at = NULL, ban_reason = NULL WHERE id = $1', [ap.user_id]);
      if (ur.rows[0]?.hwid) hwidRemoved = ((await c.query('DELETE FROM hardware_bans WHERE hwid = $1', [ur.rows[0].hwid])).rowCount ?? 0) > 0;
    }
    await writeAudit(c, req, {
      action: decision === 'overturned' ? 'appeal.overturned' : 'appeal.upheld',
      targetType: 'user', targetId: ap.user_id,
      summary: { appeal_id: id, sole_admin: d.soleAdmin, hwid_ban_removed: hwidRemoved },
      reason: note || null,
    });
    await c.query('COMMIT');
    try { if (ur.rows[0]?.email_encrypted) email = decryptEmail(ur.rows[0].email_encrypted); } catch { /* no email */ }
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[admin] decide appeal error:', safeErr(err));
    return res.status(500).json({ message: 'Internal server error' });
  } finally {
    c.release();
  }
  // Best effort; when mail isn't configured the appeal page shows the decision.
  const emailed = email ? await sendAppealDecisionEmail(email, decision === 'overturned', note || null) : false;
  res.json({ message: `Appeal ${decision}.`, sole_admin_decision: soleAdmin, emailed });
};

/** Deletes decided appeals (the user's text with them) 30 days after the decision; the audit log keeps the outcome. */
export async function pruneDecidedAppeals(days = APPEAL_RETENTION_DAYS): Promise<number> {
  const r = await pool.query(`DELETE FROM ban_appeals WHERE decided_at IS NOT NULL AND decided_at < NOW() - make_interval(days => $1::int)`, [days]);
  return r.rowCount ?? 0;
}
if (process.env.NODE_ENV !== 'test') {
  const t = setInterval(() => {
    pruneDecidedAppeals().catch((err) => console.error('[appeal] sweep failed:', safeErr(err)));
  }, 60 * 60 * 1000);
  t.unref?.();
}
