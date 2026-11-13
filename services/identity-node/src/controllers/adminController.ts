import { Request, Response, NextFunction } from 'express';
import { coarseIp } from '../utils/coarseIp.js';
import * as argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { getJwtSecret } from '../config/jwtSecret.js';
import { isValidRegion, isValidNodeId, isPinnedImageRef, ProvisionError } from '../utils/doProvisioning.js';
import { provisionMediaNode, migrateOrg, teardownNode, findOrphanDroplets, LifecycleError } from '../utils/nodeLifecycle.js';
import { liveSql } from '../config/nodeLiveness.js';
import { DROPLET_TIERS } from '../config/dropletTiers.js';
import { getNodesWithStatus } from '../utils/nodeStatus.js';
import { decryptEmail } from '../utils/encryption.js';
import { decryptReportBuffer } from '../utils/reportEncryption.js';
import {
  signChallenge, verifyChallenge, createUsedChallengeSet, requireTwoFactorForPrivileged,
  CHALLENGE_TTL_SECONDS, TWO_FACTOR_INVALID,
} from '../utils/twoFactor.js';
import * as twoFactorStore from '../utils/twoFactorStore.js';
import { checkSecondFactor } from './twoFactorController.js';
import {
  AdminRole,
  isAdminRole,
  effectiveAdminRole,
  roleAtLeast,
  adminIdleTimeoutMinutes,
  adminSessionMaxHours,
  adminReauthWindowMinutes,
  assessHwid,
  shortHwid,
  hashEmailForLookup,
  maskEmail,
  safeErr,
  isUuid,
  escapeLike,
  parseListParams,
  confirmationMatches,
  cleanReason,
  redactExportRow,
  createKeyedLimiter,
} from '../utils/adminPolicy.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface AdminContext {
  id: string;
  username: string;
  role: AdminRole;
  sessionId: string;
  reauthFresh: boolean;
}

export interface AdminRequest extends Request {
  user?: any;
  admin?: AdminContext;
}

type Db = PoolClient | typeof pool;

/** Thrown inside a transaction to roll back and answer with a specific status. */
class HttpError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body.message ?? 'error'));
  }
}

/** Rate-limit key only (in memory): the full address. */
const clientIp = (req: Request): string | null => (req.ip ? String(req.ip).slice(0, 64) : null);

/** Never logs request bodies, params or pg error details — see safeErr. */
function fail(res: Response, label: string, err: unknown) {
  if (err instanceof HttpError) return res.status(err.status).json(err.body);
  console.error(`[admin] ${label} error:`, safeErr(err));
  return res.status(500).json({ message: 'Internal server error' });
}

async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
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

interface AuditEntry {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary?: Record<string, unknown>;
  reason?: string | null;
}

/**
 * Appends one row to admin_audit_log. Call with the SAME client as the action
 * it describes so both commit or neither does. `summary` is a before/after
 * digest: ids, flags and counts — never an email address, password, token or
 * free-text PII.
 */
export async function writeAudit(db: Db, req: AdminRequest, e: AuditEntry, actor?: { id: string | null; username: string | null }) {
  const a = actor ?? { id: req.admin?.id ?? null, username: req.admin?.username ?? null };
  await db.query(
    `INSERT INTO admin_audit_log (admin_id, admin_username, action, target_type, target_id, summary, reason, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      a.id,
      a.username ? a.username.slice(0, 32) : null,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      JSON.stringify(e.summary ?? {}),
      e.reason ?? null,
      coarseIp(clientIp(req)),
    ],
  );
}

const requireUuidParam = (res: Response, value: unknown, label = 'id'): value is string => {
  if (isUuid(value)) return true;
  res.status(400).json({ message: `Invalid ${label}` });
  return false;
};

// ─── Rate limits (per admin, in-process) ──────────────────────────────────────

const generalLimiter = createKeyedLimiter(5 * 60_000, 600);
const limiters = {
  reauth:      createKeyedLimiter(15 * 60_000, 5),
  revealEmail: createKeyedLimiter(60 * 60_000, 30),
  export:      createKeyedLimiter(60 * 60_000, 10),
  destructive: createKeyedLimiter(10 * 60_000, 20),
  audio:       createKeyedLimiter(60 * 60_000, 60),
  // Refund / adjust / settle / repair / invoice: per admin.
  money:       createKeyedLimiter(10 * 60_000, 20),
  // Reconcile pages through the provider's payment list.
  reconcile:   createKeyedLimiter(10 * 60_000, 10),
};

export const adminRateLimit = (req: AdminRequest, res: Response, next: NextFunction) => {
  const key = req.admin?.id ?? clientIp(req) ?? 'unknown';
  if (!generalLimiter.take(key)) return res.status(429).json({ message: 'Too many admin requests. Slow down.' });
  next();
};

export const sensitiveRateLimit = (bucket: keyof typeof limiters) =>
  (req: AdminRequest, res: Response, next: NextFunction) => {
    if (!limiters[bucket].take(req.admin?.id ?? 'unknown')) {
      return res.status(429).json({ message: 'Rate limit reached for this action. Try again later.' });
    }
    next();
  };

// ─── Session / authorization middleware ──────────────────────────────────────

/**
 * Runs after authenticateTokenStrict. The JWT only proves "this was issued by
 * us"; the admin_sessions row decides whether it is still valid (not logged
 * out, not idle, not past its absolute lifetime) and platform_admins decides
 * the CURRENT role — so revocations and demotions apply on the next request.
 */
export const requireAdminSession = async (req: AdminRequest, res: Response, next: NextFunction) => {
  const claims = req.user;
  if (claims?.role !== 'platform_admin') {
    return res.status(403).json({ message: 'Forbidden. Platform Admins only.' });
  }
  if (!isUuid(claims.sid) || !isUuid(claims.id)) {
    // Pre-session-table admin token: force a fresh login.
    return res.status(401).json({ message: 'Admin session invalid. Please sign in again.', code: 'ADMIN_SESSION_EXPIRED' });
  }
  try {
    const r = await pool.query(
      `SELECT a.id, a.username, a.role, a.permissions,
              (s.revoked_at IS NULL AND s.expires_at > NOW()
                 AND s.last_seen_at > NOW() - make_interval(mins => $3::int)) AS active,
              (s.reauth_at IS NOT NULL AND s.reauth_at > NOW() - make_interval(mins => $4::int)) AS reauth_fresh,
              (s.last_seen_at < NOW() - INTERVAL '30 seconds') AS needs_touch,
              (s.revoked_at IS NULL) AS not_revoked
       FROM admin_sessions s
       JOIN platform_admins a ON a.id = s.admin_id
       WHERE s.id = $1 AND s.admin_id = $2`,
      [claims.sid, claims.id, adminIdleTimeoutMinutes(), adminReauthWindowMinutes()],
    );
    const row = r.rows[0];
    if (!row || !row.active) {
      if (row?.not_revoked) {
        await pool.query('UPDATE admin_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [claims.sid]);
      }
      return res.status(401).json({ message: 'Admin session expired. Please sign in again.', code: 'ADMIN_SESSION_EXPIRED' });
    }
    const role = effectiveAdminRole(row);
    if (!role) return res.status(403).json({ message: 'Forbidden. This admin account has no role assigned.' });
    if (row.needs_touch) {
      await pool.query('UPDATE admin_sessions SET last_seen_at = NOW() WHERE id = $1', [claims.sid]);
    }
    req.admin = { id: row.id, username: row.username, role, sessionId: claims.sid, reauthFresh: !!row.reauth_fresh };
    next();
  } catch (err) {
    return fail(res, 'session check', err);
  }
};

export const requireRole = (role: AdminRole) => (req: AdminRequest, res: Response, next: NextFunction) => {
  if (!roleAtLeast(req.admin?.role, role)) {
    return res.status(403).json({ message: `Forbidden. Requires the ${role} admin role.`, code: 'ROLE_REQUIRED', required_role: role });
  }
  next();
};

/** Destructive owner actions need a password re-entry within the last few minutes. */
export const requireReauth = (req: AdminRequest, res: Response, next: NextFunction) => {
  if (!req.admin?.reauthFresh) {
    return res.status(403).json({
      message: 'Please re-enter your password to confirm this action.',
      code: 'REAUTH_REQUIRED',
      window_minutes: adminReauthWindowMinutes(),
    });
  }
  next();
};

// ─── Auth endpoints ──────────────────────────────────────────────────────────

// Equalises response time between "no such admin" and "wrong password" so the
// login endpoint can't be used to enumerate admin usernames by timing.
let dummyHashPromise: Promise<string> | null = null;
const getDummyHash = () => (dummyHashPromise ??= argon2.hash(crypto.randomBytes(24).toString('hex')));

export const adminLogin = async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password
      || username.length > 255 || password.length > 1024) {
    return res.status(400).json({ message: 'Username and password required' });
  }

  try {
    const adminRes = await pool.query(
      'SELECT id, username, password_hash, role, permissions FROM platform_admins WHERE username = $1 OR email = $1',
      [username],
    );
    const admin = adminRes.rows[0];
    let isValid = false;
    if (admin) {
      isValid = await argon2.verify(admin.password_hash, password).catch(() => false);
    } else {
      await argon2.verify(await getDummyHash(), password).catch(() => false);
    }

    if (!admin || !isValid) {
      // Unknown usernames are not recorded (a typo'd password pasted into the
      // username field must never land in the audit table).
      if (admin) {
        await writeAudit(pool, req, { action: 'admin.login_failed', targetType: 'admin', targetId: admin.id },
          { id: admin.id, username: admin.username });
      }
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const role = effectiveAdminRole(admin);
    if (!role) {
      await writeAudit(pool, req, { action: 'admin.login_denied_no_role', targetType: 'admin', targetId: admin.id },
        { id: admin.id, username: admin.username });
      return res.status(403).json({ message: 'This admin account has no role assigned.' });
    }

    // L3: 2FA on -> challenge first, session only after POST /admin/login/2fa.
    const subject = { type: 'admin' as const, id: String(admin.id) };
    if (await twoFactorStore.isEnabled(subject)) {
      const { challenge } = signChallenge(subject, getJwtSecret());
      return res.json({ two_factor_required: true, challenge, expires_in: CHALLENGE_TTL_SECONDS });
    }

    return await openAdminSession(req, res, admin, role);
  } catch (error) {
    return fail(res, 'login', error);
  }
};

const usedAdminChallenges = createUsedChallengeSet();

/** POST /admin/login/2fa { challenge, code | recovery_code } -> same answer as /admin/login. */
export const adminLoginTwoFactor = async (req: Request, res: Response) => {
  const { challenge, code, recovery_code } = req.body ?? {};
  try {
    const claims = verifyChallenge(challenge, getJwtSecret(), 'admin');
    if (!claims || usedAdminChallenges.has(claims.jti) || !twoFactorStore.takeChallengeAttempt(claims.jti)) {
      return res.status(401).json({ code: 'TWO_FACTOR_CHALLENGE_EXPIRED', message: 'Sign-in timed out. Enter your password again.' });
    }
    const subject = { type: 'admin' as const, id: claims.sub };
    if (!twoFactorStore.takeAccountAttempt(subject)) {
      return res.status(429).json({ message: 'Too many code attempts. Try again in an hour.' });
    }
    const adminRes = await pool.query('SELECT id, username, role, permissions FROM platform_admins WHERE id = $1', [claims.sub]);
    const admin = adminRes.rows[0];
    if (!admin) return res.status(401).json({ message: 'Invalid credentials' });
    const r = await twoFactorStore.verifyFactor(subject, { code, recovery_code });
    if (!r.ok) {
      await writeAudit(pool, req, { action: 'admin.2fa_failed', targetType: 'admin', targetId: admin.id },
        { id: admin.id, username: admin.username });
      return res.status(401).json({ code: TWO_FACTOR_INVALID, message: 'That code is not valid. Codes can only be used once.' });
    }
    usedAdminChallenges.add(claims.jti, claims.exp);
    if (r.method === 'recovery') {
      await writeAudit(pool, req, { action: 'admin.2fa_recovery_used', targetType: 'admin', targetId: admin.id, summary: { remaining: r.recovery_remaining } },
        { id: admin.id, username: admin.username });
    }
    const role = effectiveAdminRole(admin);
    if (!role) return res.status(403).json({ message: 'This admin account has no role assigned.' });
    return await openAdminSession(req, res, admin, role);
  } catch (error) {
    return fail(res, 'login 2fa', error);
  }
};

async function openAdminSession(req: Request, res: Response, admin: { id: string; username: string }, role: AdminRole) {
  {
    const maxHours = adminSessionMaxHours();
    const session = await withTx(async (c) => {
      const s = await c.query(
        `INSERT INTO admin_sessions (admin_id, expires_at, reauth_at, ip, user_agent)
         VALUES ($1, NOW() + make_interval(hours => $2::int), NOW(), $3, $4)
         RETURNING id, expires_at`,
        [admin.id, maxHours, coarseIp(clientIp(req)), (req.get('user-agent') ?? '').slice(0, 256)],
      );
      await c.query('UPDATE platform_admins SET last_login = NOW() WHERE id = $1', [admin.id]);
      // Housekeeping: dead sessions are only useful for a while (the audit
      // log is the long-term record).
      await c.query(
        `DELETE FROM admin_sessions WHERE admin_id = $1 AND expires_at < NOW() - INTERVAL '30 days'`,
        [admin.id],
      );
      await writeAudit(c, req, { action: 'admin.login', targetType: 'admin', targetId: admin.id, summary: { role } },
        { id: admin.id, username: admin.username });
      return s.rows[0];
    });

    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: 'platform_admin', admin_role: role, sid: session.id },
      getJwtSecret(),
      { expiresIn: `${maxHours}h` },
    );

    res.json({
      message: 'Admin login successful',
      token,
      admin: { id: admin.id, username: admin.username, role },
      session: { expires_at: session.expires_at, idle_timeout_minutes: adminIdleTimeoutMinutes() },
    });
  }
}

export const adminLogout = async (req: AdminRequest, res: Response) => {
  try {
    await withTx(async (c) => {
      await c.query('UPDATE admin_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [req.admin!.sessionId]);
      await writeAudit(c, req, { action: 'admin.logout', targetType: 'admin', targetId: req.admin!.id });
    });
    res.json({ message: 'Logged out' });
  } catch (err) {
    return fail(res, 'logout', err);
  }
};

export const adminReauth = async (req: AdminRequest, res: Response) => {
  const { password } = req.body ?? {};
  if (typeof password !== 'string' || !password || password.length > 1024) {
    return res.status(400).json({ message: 'Password required' });
  }
  try {
    const r = await pool.query('SELECT password_hash FROM platform_admins WHERE id = $1', [req.admin!.id]);
    const ok = r.rows[0] ? await argon2.verify(r.rows[0].password_hash, password).catch(() => false) : false;
    if (!ok) {
      await writeAudit(pool, req, { action: 'admin.reauth_failed', targetType: 'admin', targetId: req.admin!.id });
      return res.status(401).json({ message: 'Incorrect password', code: 'REAUTH_FAILED' });
    }
    // L3: with 2FA on, re-auth also needs a fresh code (checkSecondFactor answers 401/429 itself).
    if (!(await checkSecondFactor({ type: 'admin', id: req.admin!.id }, req.body, res,
      { id: req.admin!.id, username: req.admin!.username }))) {
      await writeAudit(pool, req, { action: 'admin.reauth_failed', targetType: 'admin', targetId: req.admin!.id, summary: { second_factor: true } });
      return;
    }
    await withTx(async (c) => {
      await c.query('UPDATE admin_sessions SET reauth_at = NOW(), last_seen_at = NOW() WHERE id = $1', [req.admin!.sessionId]);
      await writeAudit(c, req, { action: 'admin.reauth', targetType: 'admin', targetId: req.admin!.id });
    });
    res.json({ message: 'Re-authenticated', window_minutes: adminReauthWindowMinutes() });
  } catch (err) {
    return fail(res, 'reauth', err);
  }
};

export const getAdminMe = async (req: AdminRequest, res: Response) => {
  let enabled = false;
  try { enabled = await twoFactorStore.isEnabled({ type: 'admin', id: req.admin!.id }); } catch (err) { console.error('[admin] 2fa state:', safeErr(err)); }
  res.json({
    admin: { id: req.admin!.id, username: req.admin!.username, role: req.admin!.role },
    session: {
      reauth_fresh: req.admin!.reauthFresh,
      idle_timeout_minutes: adminIdleTimeoutMinutes(),
      reauth_window_minutes: adminReauthWindowMinutes(),
    },
    two_factor: { enabled, required: requireTwoFactorForPrivileged() },
  });
};

// ─── Admin accounts (owner) ──────────────────────────────────────────────────

export const listAdmins = async (_req: AdminRequest, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT id, username, role, permissions, last_login, created_at
       FROM platform_admins ORDER BY username ASC LIMIT 500`,
    );
    res.json({
      admins: r.rows.map((a) => ({
        id: a.id,
        username: a.username,
        role: effectiveAdminRole(a),
        role_is_legacy: a.role == null,
        last_login: a.last_login,
        created_at: a.created_at,
      })),
    });
  } catch (err) {
    return fail(res, 'list admins', err);
  }
};

export const setAdminRole = async (req: AdminRequest, res: Response) => {
  const { adminId } = req.params;
  if (!requireUuidParam(res, adminId, 'admin id')) return;
  const { role } = req.body ?? {};
  if (!isAdminRole(role)) return res.status(400).json({ message: 'role must be viewer, operator or owner' });
  if (adminId === req.admin!.id) return res.status(400).json({ message: 'You cannot change your own role.' });

  try {
    const result = await withTx(async (c) => {
      // Lock every admin row: the "at least one owner remains" check must not
      // race a concurrent demotion.
      const all = await c.query('SELECT id, username, role, permissions FROM platform_admins FOR UPDATE');
      const target = all.rows.find((a) => a.id === adminId);
      if (!target) throw new HttpError(404, { message: 'Admin not found' });
      const before = effectiveAdminRole(target);
      const ownersAfter = all.rows.filter((a) => (a.id === adminId ? role : effectiveAdminRole(a)) === 'owner').length;
      if (ownersAfter === 0) throw new HttpError(409, { message: 'At least one owner must remain.' });
      await c.query('UPDATE platform_admins SET role = $2 WHERE id = $1', [adminId, role]);
      // Drop any fresh re-auth the target holds so a demotion can't ride on it.
      await c.query('UPDATE admin_sessions SET reauth_at = NULL WHERE admin_id = $1', [adminId]);
      await writeAudit(c, req, {
        action: 'admin.role_changed', targetType: 'admin', targetId: adminId,
        summary: { username: target.username, before, after: role },
      });
      return { before };
    });
    res.json({ message: 'Role updated', before: result.before, after: role });
  } catch (err) {
    return fail(res, 'set admin role', err);
  }
};

// ─── Dashboard ───────────────────────────────────────────────────────────────

export const getSystemStats = async (_req: AdminRequest, res: Response) => {
  try {
    const [userCount, orgCount] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM users WHERE erased_at IS NULL'),
      pool.query('SELECT COUNT(*)::int AS n FROM organizations'),
    ]);
    res.json({ users: userCount.rows[0].n, organizations: orgCount.rows[0].n, status: 'operational' });
  } catch (error) {
    return fail(res, 'stats', error);
  }
};

export const getSystemOverview = async (_req: AdminRequest, res: Response) => {
  try {
    const [users, orgs, bans, hwidBans, channels, erased, pendingReports, admins, recentUsers, recentOrgs] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE erased_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int AS n FROM organizations`),
      pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE is_banned = true AND erased_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int AS n FROM hardware_bans`),
      pool.query(`SELECT COUNT(*)::int AS n FROM channels`),
      pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE erased_at IS NOT NULL`),
      pool.query(`SELECT COUNT(*)::int AS n FROM voice_misconduct_reports WHERE status = 'pending'`),
      pool.query(`SELECT username, last_login FROM platform_admins ORDER BY last_login DESC NULLS LAST LIMIT 50`),
      pool.query(`SELECT id, callsign, created_at FROM users WHERE erased_at IS NULL ORDER BY created_at DESC LIMIT 5`),
      pool.query(`SELECT id, callsign, created_at FROM organizations ORDER BY created_at DESC LIMIT 5`),
    ]);

    res.json({
      stats: {
        users:          users.rows[0].n,
        orgs:           orgs.rows[0].n,
        banned:         bans.rows[0].n,
        hwidBans:       hwidBans.rows[0].n,
        channels:       channels.rows[0].n,
        erased:         erased.rows[0].n,
        pendingReports: pendingReports.rows[0].n,
      },
      admins: admins.rows,
      recentUsers: recentUsers.rows,
      recentOrgs:  recentOrgs.rows,
      status: 'operational',
    });
  } catch (err) {
    return fail(res, 'overview', err);
  }
};

// ─── Users ───────────────────────────────────────────────────────────────────

const USER_SORTS = {
  created_at: 'u.created_at',
  callsign:   'lower(u.callsign)',
  tier:       'u.subscription_tier',
};

/** Kept for backwards compatibility with any caller of the old export name. */
export const listUsers = (req: AdminRequest, res: Response) => listUsersExtended(req, res);

/**
 * GET /admin/users?q=&email=&status=all|active|banned|erased&sort=&dir=&page=&limit=
 * Server-side filter/sort/paginate. `email` is an exact lookup through the
 * email_hash index (emails are never stored in clear, so substring search is
 * impossible by design); such a lookup is audited without recording the email.
 */
export const listUsersExtended = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, USER_SORTS, 'created_at');
  const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status : 'all';

  if (email && (email.length > 254 || !email.includes('@'))) {
    return res.status(400).json({ message: 'email must be a full email address' });
  }

  const conds: string[] = [];
  const params: any[] = [];
  if (p.q) {
    params.push(`%${escapeLike(p.q)}%`);
    conds.push(`(u.callsign ILIKE $${params.length} OR u.global_tag ILIKE $${params.length})`);
  }
  if (email) {
    params.push(hashEmailForLookup(email));
    conds.push(`u.email_hash = $${params.length}`);
  }
  if (status === 'active') conds.push('COALESCE(u.is_banned, false) = false AND u.erased_at IS NULL');
  else if (status === 'banned') conds.push('u.is_banned = true AND u.erased_at IS NULL');
  else if (status === 'erased') conds.push('u.erased_at IS NOT NULL');

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM users u ${where}`, params);
    const rowsRes = await pool.query(
      `SELECT u.id, u.callsign, u.global_tag, u.subscription_tier, u.created_at,
              COALESCE(u.is_banned, false) AS is_banned, u.erased_at, u.hwid
       FROM users u
       ${where}
       ORDER BY ${p.sortSql} ${p.dir} NULLS LAST, u.id ${p.dir}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.limit, p.offset],
    );

    if (email) {
      await writeAudit(pool, req, {
        action: 'user.lookup_by_email', targetType: 'user',
        targetId: rowsRes.rows[0]?.id ?? null,
        summary: { matched: rowsRes.rows.length },
      });
    }

    res.json({
      users: rowsRes.rows.map((u) => {
        const hw = assessHwid(u.hwid);
        return {
          id: u.id,
          callsign: u.callsign,
          global_tag: u.global_tag,
          subscription_tier: u.subscription_tier,
          created_at: u.created_at,
          is_banned: u.is_banned,
          erased_at: u.erased_at,
          hwid_present: hw.present,
          hwid_bannable: hw.bannable,
        };
      }),
      total: countRes.rows[0].n,
      page: p.page,
      limit: p.limit,
      sort: p.sort,
      dir: p.dir,
    });
  } catch (err) {
    return fail(res, 'list users', err);
  }
};

async function hwidContext(db: Db, userId: string, hwid: string | null) {
  const hw = assessHwid(hwid);
  if (!hwid) return { ...hw, short: null, shared_accounts: 0, is_banned: false };
  const [shared, banned] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS n FROM users WHERE hwid = $1 AND id <> $2 AND erased_at IS NULL', [hwid, userId]),
    db.query('SELECT 1 FROM hardware_bans WHERE hwid = $1', [hwid]),
  ]);
  return { ...hw, short: shortHwid(hwid), shared_accounts: shared.rows[0].n as number, is_banned: (banned.rowCount ?? 0) > 0 };
}

export const getUserDetail = async (req: AdminRequest, res: Response) => {
  const { userId } = req.params;
  if (!requireUuidParam(res, userId, 'user id')) return;
  try {
    const userRes = await pool.query(
      `SELECT id, callsign, global_tag, subscription_tier, timezone, created_at, updated_at,
              COALESCE(is_banned, false) AS is_banned, banned_at, ban_reason, erased_at, hwid,
              email_encrypted, (profile_image_path IS NOT NULL) AS has_avatar
       FROM users WHERE id = $1`,
      [userId],
    );
    if (userRes.rowCount === 0) return res.status(404).json({ message: 'User not found' });
    const u = userRes.rows[0];

    let emailMasked: string | null = null;
    let emailStatus: 'present' | 'none' | 'unavailable' = 'none';
    if (u.email_encrypted) {
      try {
        emailMasked = maskEmail(decryptEmail(u.email_encrypted));
        emailStatus = 'present';
      } catch {
        emailStatus = 'unavailable';
      }
    }

    const [hw, orgsRes, orgTotal, ownedRes, devices, sessions, audit] = await Promise.all([
      hwidContext(pool, userId, u.hwid),
      pool.query(
        `SELECT o.id, o.callsign, r.name AS role_name, om.joined_at, (o.owner_id = om.user_id) AS is_owner
         FROM org_members om
         JOIN organizations o ON o.id = om.org_id
         LEFT JOIN org_roles r ON r.id = om.role_id
         WHERE om.user_id = $1
         ORDER BY om.joined_at DESC NULLS LAST
         LIMIT 100`,
        [userId],
      ),
      pool.query('SELECT COUNT(*)::int AS n FROM org_members WHERE user_id = $1', [userId]),
      pool.query('SELECT id, callsign FROM organizations WHERE owner_id = $1 ORDER BY callsign LIMIT 50', [userId]),
      pool.query('SELECT COUNT(*)::int AS n FROM user_devices WHERE user_id = $1 AND revoked_at IS NULL', [userId]),
      pool.query('SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()', [userId]),
      pool.query(
        `SELECT id, admin_username, action, summary, reason, created_at
         FROM admin_audit_log WHERE target_type = 'user' AND target_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [userId],
      ),
    ]);

    res.json({
      user: {
        id: u.id,
        callsign: u.callsign,
        global_tag: u.global_tag,
        subscription_tier: u.subscription_tier,
        timezone: u.timezone,
        created_at: u.created_at,
        updated_at: u.updated_at,
        is_banned: u.is_banned,
        banned_at: u.banned_at,
        ban_reason: u.ban_reason,
        erased_at: u.erased_at,
        has_avatar: u.has_avatar,
        email_masked: emailMasked,
        email_status: emailStatus,
        // Back-compat field used by older panel builds.
        is_hwid_banned: hw.is_banned,
      },
      hwid: hw,
      orgs: orgsRes.rows,
      orgs_total: orgTotal.rows[0].n,
      owned_orgs: ownedRes.rows,
      stats: { active_devices: devices.rows[0].n, active_sessions: sessions.rows[0].n },
      audit: audit.rows,
    });
  } catch (err) {
    return fail(res, 'user detail', err);
  }
};

/** POST /admin/users/:userId/reveal-email { reason } — one email, audited. */
export const revealUserEmail = async (req: AdminRequest, res: Response) => {
  const { userId } = req.params;
  if (!requireUuidParam(res, userId, 'user id')) return;
  const reason = cleanReason(req.body?.reason);
  if (!reason || reason.length < 5) {
    return res.status(400).json({ message: 'A reason (at least 5 characters) is required to reveal an email address.' });
  }
  try {
    const email = await withTx(async (c) => {
      const r = await c.query('SELECT email_encrypted FROM users WHERE id = $1', [userId]);
      if (r.rowCount === 0) throw new HttpError(404, { message: 'User not found' });
      if (!r.rows[0].email_encrypted) throw new HttpError(404, { message: 'No recoverable email on file for this account.' });
      let plain: string;
      try {
        plain = decryptEmail(r.rows[0].email_encrypted);
      } catch {
        throw new HttpError(422, { message: 'Stored email could not be decrypted.' });
      }
      await writeAudit(c, req, { action: 'user.email_revealed', targetType: 'user', targetId: userId, reason });
      return plain;
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ email });
  } catch (err) {
    return fail(res, 'reveal email', err);
  }
};

/**
 * POST /admin/users/:userId/ban
 * Body: { ban: boolean, reason?: string, confirm_callsign: string,
 *         hwid_ban?: boolean, acknowledge_shared_hwid?: boolean, hwid_unban?: boolean }
 *
 * Account ban and hardware ban are separate decisions now. A hardware ban is
 * refused for anything that is not a real desktop-client fingerprint (e.g.
 * the shared 'browser-fallback-hwid' placeholder, which would lock out every
 * web sign-in), and needs explicit acknowledgement when other accounts share
 * the device.
 */
export const banGlobalUser = async (req: AdminRequest, res: Response) => {
  const { userId } = req.params;
  if (!requireUuidParam(res, userId, 'user id')) return;
  const body = req.body ?? {};
  if (typeof body.ban !== 'boolean') return res.status(400).json({ message: 'ban must be true or false' });
  const ban: boolean = body.ban;
  const reason = cleanReason(body.reason);
  if (ban && !reason) return res.status(400).json({ message: 'A reason is required to ban an account.' });
  const wantHwidBan = ban && body.hwid_ban === true;
  const wantHwidUnban = !ban && body.hwid_unban !== false;

  try {
    const result = await withTx(async (c) => {
      const ur = await c.query(
        'SELECT id, callsign, COALESCE(is_banned, false) AS is_banned, hwid, erased_at FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (ur.rowCount === 0) throw new HttpError(404, { message: 'User not found' });
      const user = ur.rows[0];
      if (user.erased_at) throw new HttpError(409, { message: 'This account has been erased.' });
      if (!confirmationMatches(user.callsign, body.confirm_callsign)) {
        throw new HttpError(400, { message: 'Type the account callsign to confirm.', code: 'CONFIRMATION_REQUIRED' });
      }

      const hw = await hwidContext(c, userId, user.hwid);
      let sessionsRevoked = 0;
      let hwidBanApplied = false;
      let hwidBanRemoved = false;

      if (ban) {
        await c.query('UPDATE users SET is_banned = TRUE, banned_at = NOW(), ban_reason = $2 WHERE id = $1', [userId, reason]);
        // Kill every long-lived credential now; an already-issued access JWT
        // lives at most its 30-minute TTL.
        const rv = await c.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
        sessionsRevoked = rv.rowCount ?? 0;

        if (wantHwidBan) {
          if (!hw.bannable) {
            throw new HttpError(422, { message: `Hardware ban refused: ${hw.reason}`, code: 'HWID_NOT_BANNABLE' });
          }
          if (hw.shared_accounts > 0 && body.acknowledge_shared_hwid !== true) {
            throw new HttpError(409, {
              message: `This device ID is also used by ${hw.shared_accounts} other account(s); a hardware ban blocks all of them from signing in or registering.`,
              code: 'HWID_SHARED',
              shared_accounts: hw.shared_accounts,
            });
          }
          const ins = await c.query(
            `INSERT INTO hardware_bans (hwid, reason, source_user_id, banned_by_admin_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT (hwid) DO NOTHING`,
            [user.hwid, reason, userId, req.admin!.id],
          );
          hwidBanApplied = (ins.rowCount ?? 0) > 0;
        }
      } else {
        await c.query('UPDATE users SET is_banned = FALSE, banned_at = NULL, ban_reason = NULL WHERE id = $1', [userId]);
        if (wantHwidUnban && user.hwid) {
          const del = await c.query('DELETE FROM hardware_bans WHERE hwid = $1', [user.hwid]);
          hwidBanRemoved = (del.rowCount ?? 0) > 0;
        }
      }

      await writeAudit(c, req, {
        action: ban ? 'user.banned' : 'user.unbanned',
        targetType: 'user',
        targetId: userId,
        reason,
        summary: {
          callsign: user.callsign,
          before: { is_banned: user.is_banned, hwid_banned: hw.is_banned },
          after: {
            is_banned: ban,
            hwid_banned: hwidBanApplied || (hw.is_banned && !hwidBanRemoved),
          },
          refresh_tokens_revoked: sessionsRevoked,
          hwid_shared_accounts: hw.shared_accounts,
          // L12: a CSAM-related ban can't be appealed (utils/banAppeals.ts)
          ...(ban && body.csam === true ? { csam: true } : {}),
        },
      });
      return { sessionsRevoked, hwidBanApplied, hwidBanRemoved };
    });

    res.json({
      message: `User ${ban ? 'banned' : 'unbanned'} successfully`,
      sessions_revoked: result.sessionsRevoked,
      hwid_ban_applied: result.hwidBanApplied,
      hwid_ban_removed: result.hwidBanRemoved,
    });
  } catch (err) {
    return fail(res, 'ban', err);
  }
};

// ─── Data-subject requests (export / erasure) ────────────────────────────────

interface UserFk {
  table: string;     // regclass text, already safely quoted by Postgres
  column: string;    // quote_ident'ed
  rawColumn: string;
  onDelete: string;  // pg confdeltype: a=no action r=restrict c=cascade n=set null d=set default
  nullable: boolean;
}

/**
 * Every single-column FK that references users(id), discovered from the
 * catalog rather than hand-listed — a table added by a future migration is
 * covered by export and erasure automatically.
 */
async function discoverUserFks(db: Db): Promise<UserFk[]> {
  const r = await db.query(
    `SELECT c.conrelid::regclass::text AS tbl,
            quote_ident(a.attname) AS col,
            a.attname AS raw_col,
            c.confdeltype AS on_delete,
            NOT a.attnotnull AS nullable
     FROM pg_constraint c
     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.contype = 'f'
       AND c.confrelid = 'users'::regclass
       AND array_length(c.conkey, 1) = 1
     ORDER BY 1, 2`,
  );
  return r.rows
    .filter((row) => row.tbl !== 'users' && !String(row.tbl).startsWith('admin_'))
    .map((row) => ({ table: row.tbl, column: row.col, rawColumn: row.raw_col, onDelete: row.on_delete, nullable: row.nullable }));
}

// Rows kept (still pointing at the anonymous tombstone) on erasure:
// financial records with a statutory retention period. They no longer link
// to any identifying data once the users row is anonymised.
const ERASURE_RETAIN_TABLES = new Set(['billing_contributions']);
// NO ACTION FKs whose rows are purely the subject's own artefacts.
const ERASURE_DELETE_TABLES = new Set(['org_invites']);

type ErasurePlan = 'delete' | 'nullify' | 'default' | 'retain';

function erasurePlanFor(fk: UserFk): ErasurePlan {
  if (ERASURE_RETAIN_TABLES.has(fk.table)) return 'retain';
  if (ERASURE_DELETE_TABLES.has(fk.table)) return 'delete';
  switch (fk.onDelete) {
    case 'c': return 'delete';
    case 'n': return fk.nullable ? 'nullify' : 'retain';
    case 'd': return 'default';
    default:  return fk.nullable ? 'nullify' : 'retain';
  }
}

async function erasureBlockers(db: Db, userId: string) {
  const [owned, holds] = await Promise.all([
    db.query(
      `SELECT o.id, o.callsign, (SELECT COUNT(*)::int FROM org_members m WHERE m.org_id = o.id) AS member_count
       FROM organizations o WHERE o.owner_id = $1 ORDER BY o.callsign LIMIT 50`,
      [userId],
    ),
    db.query(
      `SELECT COUNT(*)::int AS n FROM voice_misconduct_reports WHERE accused_id = $1 AND status = 'pending'`,
      [userId],
    ),
  ]);
  return { owned_orgs: owned.rows, pending_reports_as_accused: holds.rows[0].n as number };
}

/** GET /admin/users/:userId/erasure-preview */
export const getErasurePreview = async (req: AdminRequest, res: Response) => {
  const { userId } = req.params;
  if (!requireUuidParam(res, userId, 'user id')) return;
  try {
    const u = await pool.query('SELECT id, callsign, erased_at FROM users WHERE id = $1', [userId]);
    if (u.rowCount === 0) return res.status(404).json({ message: 'User not found' });
    const fks = await discoverUserFks(pool);
    const tables: Array<{ table: string; column: string; rows: number; plan: ErasurePlan }> = [];
    for (const fk of fks) {
      const n = await pool.query(`SELECT COUNT(*)::int AS n FROM ${fk.table} WHERE ${fk.column} = $1`, [userId]);
      if (n.rows[0].n > 0) tables.push({ table: fk.table, column: fk.rawColumn, rows: n.rows[0].n, plan: erasurePlanFor(fk) });
    }
    const blockers = await erasureBlockers(pool, userId);
    res.json({
      user: { id: u.rows[0].id, callsign: u.rows[0].callsign, erased_at: u.rows[0].erased_at },
      tables,
      blockers,
      notes: [
        'The users row is kept as an anonymous tombstone: callsign replaced, email/password/hwid/profile cleared, sign-in disabled.',
        'Billing contributions are retained (statutory bookkeeping) but no longer linked to identifying data.',
        'End-to-end encrypted content is never stored readably on the server; MLS device rows hold public key material only and are deleted.',
        'Uploaded avatar / intro-sound files are deleted from disk after commit (best effort).',
        'Already-issued access tokens expire within 30 minutes; all refresh tokens are deleted immediately.',
      ],
    });
  } catch (err) {
    return fail(res, 'erasure preview', err);
  }
};

/** POST /admin/users/:userId/export { reason, confirm_callsign } — GDPR Art. 15 / CCPA access. */
export const exportUserData = async (req: AdminRequest, res: Response) => {
  const { userId } = req.params;
  if (!requireUuidParam(res, userId, 'user id')) return;
  const reason = cleanReason(req.body?.reason);
  if (!reason) return res.status(400).json({ message: 'A reason / request reference is required.' });
  const ROW_CAP = 1000;

  try {
    const payload = await withTx(async (c) => {
      const ur = await c.query(
        `SELECT id, callsign, global_tag, subscription_tier, timezone, created_at, updated_at,
                is_banned, banned_at, ban_reason, erased_at, hwid, email_encrypted,
                profile_image_path, intro_sound_path
         FROM users WHERE id = $1`,
        [userId],
      );
      if (ur.rowCount === 0) throw new HttpError(404, { message: 'User not found' });
      const u = ur.rows[0];
      if (!confirmationMatches(u.callsign, req.body?.confirm_callsign)) {
        throw new HttpError(400, { message: 'Type the account callsign to confirm.', code: 'CONFIRMATION_REQUIRED' });
      }
      let email: string | null = null;
      if (u.email_encrypted) {
        try { email = decryptEmail(u.email_encrypted); } catch { email = null; }
      }
      const { email_encrypted: _omit, ...profile } = u;

      const related: Record<string, { rows: unknown[]; truncated: boolean }> = {};
      const counts: Record<string, number> = {};
      for (const fk of await discoverUserFks(c)) {
        const r = await c.query(
          `SELECT to_jsonb(t) AS row FROM ${fk.table} t WHERE t.${fk.column} = $1 LIMIT ${ROW_CAP + 1}`,
          [userId],
        );
        if (r.rows.length === 0) continue;
        const key = `${fk.table}.${fk.rawColumn}`;
        related[key] = {
          rows: r.rows.slice(0, ROW_CAP).map((x) => redactExportRow(fk.rawColumn, x.row)),
          truncated: r.rows.length > ROW_CAP,
        };
        counts[key] = Math.min(r.rows.length, ROW_CAP);
      }

      await writeAudit(c, req, {
        action: 'user.data_exported', targetType: 'user', targetId: userId, reason,
        summary: { tables: counts },
      });

      return {
        export_format: 'spectercoms-account-export/1',
        generated_at: new Date().toISOString(),
        subject: { ...profile, email },
        related,
        not_included: [
          'Message and voice content: end-to-end encrypted and relayed, not stored readably by the server.',
          'Credential material (password hashes, refresh/reset token hashes) and MLS private keys (never leave the device).',
          'Identity of people who reported this account, and their statements (third-party data).',
        ],
      };
    });

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="account-export-${userId}.json"`);
    res.json(payload);
  } catch (err) {
    return fail(res, 'export user', err);
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_BASE = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'));

function unlinkUpload(rel: string | null) {
  if (!rel || typeof rel !== 'string') return;
  const abs = path.resolve(UPLOADS_BASE, rel.replace(/^\/?uploads\//, ''));
  if (!abs.startsWith(UPLOADS_BASE + path.sep)) return; // never outside the uploads dir
  fs.promises.unlink(abs).catch(() => {});
}

/**
 * POST /admin/users/:userId/erase  (also DELETE /admin/users/:userId)
 * Body: { reason, confirm_callsign, override_legal_hold? }
 *
 * Right-to-erasure: deletes or de-links every row that references the user
 * (catalog-driven, see discoverUserFks), then anonymises the users row into a
 * tombstone rather than deleting it — a hard DELETE would either fail (orgs
 * they own) or CASCADE-destroy billing records that must be retained.
 */
export const eraseUser = async (req: AdminRequest, res: Response) => {
  const { userId } = req.params;
  if (!requireUuidParam(res, userId, 'user id')) return;
  const body = req.body ?? {};
  const reason = cleanReason(body.reason);
  if (!reason) return res.status(400).json({ message: 'A reason / request reference is required.' });

  try {
    // Unusable-but-valid password hash so a login attempt fails cleanly
    // (argon2.verify throws on a malformed hash, which would surface as 500).
    const deadHash = await argon2.hash(crypto.randomBytes(32).toString('hex'));

    const result = await withTx(async (c) => {
      const ur = await c.query(
        'SELECT id, callsign, erased_at, profile_image_path, intro_sound_path FROM users WHERE id = $1 FOR UPDATE',
        [userId],
      );
      if (ur.rowCount === 0) throw new HttpError(404, { message: 'User not found' });
      const u = ur.rows[0];
      if (u.erased_at) throw new HttpError(409, { message: 'Account already erased.' });
      if (!confirmationMatches(u.callsign, body.confirm_callsign)) {
        throw new HttpError(400, { message: 'Type the account callsign to confirm.', code: 'CONFIRMATION_REQUIRED' });
      }

      const blockers = await erasureBlockers(c, userId);
      if (blockers.owned_orgs.length > 0) {
        throw new HttpError(409, {
          message: 'This user owns organizations. Transfer ownership or dissolve them first.',
          code: 'OWNS_ORGS',
          owned_orgs: blockers.owned_orgs,
        });
      }
      if (blockers.pending_reports_as_accused > 0 && body.override_legal_hold !== true) {
        throw new HttpError(409, {
          message: `This user is the accused party in ${blockers.pending_reports_as_accused} pending misconduct report(s). Resolve them, or explicitly override the hold.`,
          code: 'LEGAL_HOLD',
          pending_reports: blockers.pending_reports_as_accused,
        });
      }

      const affected: Record<string, { plan: ErasurePlan; rows: number }> = {};
      for (const fk of await discoverUserFks(c)) {
        const plan = erasurePlanFor(fk);
        if (plan === 'retain') continue;
        let r;
        if (plan === 'delete') r = await c.query(`DELETE FROM ${fk.table} WHERE ${fk.column} = $1`, [userId]);
        else if (plan === 'nullify') r = await c.query(`UPDATE ${fk.table} SET ${fk.column} = NULL WHERE ${fk.column} = $1`, [userId]);
        else r = await c.query(`UPDATE ${fk.table} SET ${fk.column} = DEFAULT WHERE ${fk.column} = $1`, [userId]);
        if ((r.rowCount ?? 0) > 0) affected[`${fk.table}.${fk.rawColumn}`] = { plan, rows: r.rowCount ?? 0 };
      }

      await twoFactorStore.deleteForSubject(c, { type: 'user', id: userId }); // L3

      const tomb = `deleted_${userId.replace(/-/g, '').slice(0, 16)}`;
      await c.query(
        `UPDATE users SET
           callsign = $2,
           email_hash = $3,
           email_encrypted = NULL,
           password_hash = $4,
           password_reset_token = NULL,
           password_reset_token_expires = NULL,
           global_tag = NULL,
           hwid = NULL,
           timezone = NULL,
           profile_image_path = NULL,
           intro_sound_path = NULL,
           ban_reason = NULL,
           is_banned = TRUE,
           erased_at = NOW(),
           updated_at = NOW()
         WHERE id = $1`,
        [userId, tomb, `erased:${userId}`, deadHash],
      );

      // No callsign in the audit summary: the erased identity must not
      // survive in the trail. The user id is a random UUID now pointing at
      // the anonymous tombstone.
      await writeAudit(c, req, {
        action: 'user.erased', targetType: 'user', targetId: userId, reason,
        summary: { affected, legal_hold_overridden: blockers.pending_reports_as_accused > 0 },
      });
      return { affected, files: [u.profile_image_path, u.intro_sound_path] };
    });

    for (const f of result.files) unlinkUpload(f);
    publishEvent(`specter.event.user.${userId}`, { type: 'orgs_changed' }).catch(() => {});

    res.json({ message: 'Account erased.', affected: result.affected });
  } catch (err) {
    return fail(res, 'erase user', err);
  }
};

/** Kept as the DELETE /admin/users/:userId handler — now an audited erasure. */
export const deleteUser = eraseUser;

// ─── Organizations ───────────────────────────────────────────────────────────

const ORG_SORTS = {
  created_at:   'o.created_at',
  callsign:     'lower(o.callsign)',
  member_count: 'member_count',
};

export const listOrgs = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, ORG_SORTS, 'created_at');
  const params: any[] = [];
  let where = '';
  if (p.q) {
    params.push(`%${escapeLike(p.q)}%`);
    where = `WHERE o.callsign ILIKE $1`;
  }

  try {
    const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM organizations o ${where}`, params);
    // Per-org counts are correlated subqueries (index lookups) instead of
    // the previous members x channels join + COUNT(DISTINCT), whose
    // intermediate row count grew with members*channels per org.
    const orgsRes = await pool.query(
      `SELECT o.id, o.callsign, o.is_public, o.join_method, o.created_at, o.owner_id,
              u.callsign AS owner_callsign,
              (SELECT COUNT(*)::int FROM org_members om WHERE om.org_id = o.id) AS member_count,
              (SELECT COUNT(*)::int FROM channels c WHERE c.org_id = o.id)      AS channel_count,
              mn.node_id AS assigned_node_id
       FROM organizations o
       LEFT JOIN users u ON u.id = o.owner_id
       LEFT JOIN org_node_assignments ona ON ona.org_id = o.id
       LEFT JOIN media_nodes mn ON mn.id = ona.node_id
       ${where}
       ORDER BY ${p.sortSql} ${p.dir} NULLS LAST, o.id ${p.dir}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.limit, p.offset],
    );

    res.json({ orgs: orgsRes.rows, total: countRes.rows[0].n, page: p.page, limit: p.limit, sort: p.sort, dir: p.dir });
  } catch (err) {
    return fail(res, 'list orgs', err);
  }
};

/**
 * DELETE /admin/orgs/:orgId  { confirm_callsign, reason, acknowledge_billing_loss? }
 * organizations -> org_billing / billing_contributions / billing_ledger are
 * ON DELETE CASCADE, so dissolving an org that has ever been paid destroys its
 * financial history; that needs an explicit acknowledgement.
 */
export const dissolveOrg = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  if (!requireUuidParam(res, orgId, 'organization id')) return;
  const body = req.body ?? {};
  const reason = cleanReason(body.reason);
  if (!reason) return res.status(400).json({ message: 'A reason is required to dissolve an organization.' });

  try {
    const result = await withTx(async (c) => {
      const or = await c.query('SELECT id, callsign, owner_id FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      if (or.rowCount === 0) throw new HttpError(404, { message: 'Organization not found' });
      const org = or.rows[0];
      if (!confirmationMatches(org.callsign, body.confirm_callsign)) {
        throw new HttpError(400, { message: 'Type the organization callsign to confirm.', code: 'CONFIRMATION_REQUIRED' });
      }
      const billing = await c.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents), 0)::bigint AS cents
         FROM billing_contributions WHERE org_id = $1 AND status = 'succeeded'`,
        [orgId],
      );
      const paid = billing.rows[0].n as number;
      if (paid > 0 && body.acknowledge_billing_loss !== true) {
        throw new HttpError(409, {
          message: `This organization has ${paid} completed payment record(s). Dissolving it deletes its billing history.`,
          code: 'BILLING_RECORDS_PRESENT',
          payments: paid,
        });
      }
      const members = await c.query('SELECT user_id FROM org_members WHERE org_id = $1', [orgId]);
      await c.query('DELETE FROM organizations WHERE id = $1', [orgId]);
      await writeAudit(c, req, {
        action: 'org.dissolved', targetType: 'org', targetId: orgId, reason,
        summary: {
          callsign: org.callsign,
          owner_id: org.owner_id,
          member_count: members.rowCount,
          billing_payments_deleted: paid,
          billing_cents_deleted: String(billing.rows[0].cents),
        },
      });
      return { callsign: org.callsign, memberIds: members.rows.map((r) => r.user_id as string) };
    });

    // Notify former members after commit, in bounded parallel batches.
    for (let i = 0; i < result.memberIds.length; i += 50) {
      await Promise.allSettled(
        result.memberIds.slice(i, i + 50).map((id) => publishEvent(`specter.event.user.${id}`, { type: 'orgs_changed' })),
      );
    }

    res.json({ message: `Organization "${result.callsign}" dissolved.` });
  } catch (err) {
    return fail(res, 'dissolve org', err);
  }
};

// ─── Billing (read/issue — logic owned by the billing workstream) ────────────

/**
 * GET /admin/billing/contributions?since=&limit=&offset=
 * Admin-wide, cross-org contribution feed for external consumers (e.g. EES Ledger's
 * billing sync) to mirror as bookkeeping records — SpecterComs stays the only place
 * money actually moves; this is a read-only reflection of what already happened.
 * Only `succeeded` contributions are returned — pending/failed must never be booked
 * as revenue. `credited_at` (not `created_at`) is the incremental-sync cursor since
 * it's set exactly once, only when a payment is actually confirmed.
 */
export const listBillingContributions = async (req: AdminRequest, res: Response) => {
  const since  = (req.query.since as string) || null;
  if (since && Number.isNaN(Date.parse(since))) return res.status(400).json({ message: 'Invalid since timestamp' });
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit as string || '50', 10) || 50));
  const offset = Math.min(100_000, Math.max(0, parseInt(req.query.offset as string || '0', 10) || 0));

  try {
    const result = await pool.query(
      `SELECT bc.id, bc.org_id, o.callsign AS org_callsign,
              bc.user_id, u.callsign AS contributor_callsign,
              bc.amount_cents, bc.fee_cents, bc.payment_method, bc.provider,
              bc.status, bc.created_at, bc.credited_at,
              bc.source, bc.invoice_reason, bc.external_invoice_ref,
              bc.charge_cents, bc.reversed_cents, bc.dispute_status
       FROM billing_contributions bc
       -- LEFT: money records outlive dissolved orgs / deleted accounts (migration 000069)
       LEFT JOIN organizations o ON o.id = bc.org_id
       LEFT JOIN users u ON u.id = bc.user_id
       WHERE bc.status = 'succeeded'
         AND ($3::timestamptz IS NULL OR bc.credited_at > $3::timestamptz)
       ORDER BY bc.credited_at ASC
       LIMIT $1 OFFSET $2`,
      [limit + 1, offset, since]
    );

    const hasMore = result.rows.length > limit;
    res.json({ contributions: result.rows.slice(0, limit), has_more: hasMore });
  } catch (err) {
    return fail(res, 'list billing contributions', err);
  }
};

/**
 * GET /admin/node-alerts
 * History of node-health alerts (offline / overloaded / scaling_warning),
 * persisted independent of push delivery -- see jobs/pushWatcher.ts.
 */
export const listNodeAlertEvents = async (req: AdminRequest, res: Response) => {
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit as string || '50') || 50));
  const offset = Math.max(0, parseInt(req.query.offset as string || '0') || 0);

  try {
    const result = await pool.query(
      `SELECT id, event_type, node_id, message, created_at
       FROM node_alert_events
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit + 1, offset]
    );

    const hasMore = result.rows.length > limit;
    res.json({ events: result.rows.slice(0, limit), has_more: hasMore });
  } catch (err) {
    return fail(res, 'list node alerts', err);
  }
};

/**
 * GET /admin/orgs/:orgId/billing-info
 * What an external invoicing tool (EES Ledger) polls to build/refresh a customer
 * record. Returns nulls rather than 404 if the org owner hasn't filled it in yet.
 */
export const getOrgBillingInfo = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  if (!requireUuidParam(res, orgId, 'organization id')) return;
  try {
    const result = await pool.query(`SELECT * FROM org_billing_info WHERE org_id = $1`, [orgId]);
    res.json(result.rows[0] ?? { org_id: orgId });
  } catch (err) {
    return fail(res, 'get org billing info', err);
  }
};

/**
 * POST /admin/orgs/:orgId/billing/invoices
 * Body: { amount_cents: number, reason: string, external_invoice_ref: string }
 *
 * Issues a formal invoice on an org's behalf — inserts a `pending`
 * billing_contributions row the org owner later pays via POST
 * /orgs/:id/billing/invoices/:cid/pay, reusing the exact same Stripe checkout/
 * webhook/credit machinery as self-serve funding. user_id is set to the org's
 * owner_id as a placeholder (billing_contributions.user_id is NOT NULL and three
 * existing queries assume it's always set) — overwritten with the real payer's
 * id once someone actually pays.
 *
 * No Stripe session is created here (see external_invoice_ref uniqueness note
 * below) — Checkout Sessions expire in ~24h and this invoice may sit unpaid for
 * days, so the session is created lazily at pay-time instead.
 */
export const createOrgInvoice = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  const { amount_cents, reason, external_invoice_ref } = req.body as {
    amount_cents?: number;
    reason?: string;
    external_invoice_ref?: string;
  };

  if (!requireUuidParam(res, orgId, 'organization id')) return;
  if (!amount_cents || typeof amount_cents !== 'number' || !Number.isInteger(amount_cents) || amount_cents <= 0
      || amount_cents > 1_000_000) {
    return res.status(400).json({ message: 'amount_cents must be a whole number between 1 and 1000000' });
  }
  if (external_invoice_ref !== undefined && external_invoice_ref !== null
      && (typeof external_invoice_ref !== 'string' || external_invoice_ref.length > 64)) {
    return res.status(400).json({ message: 'external_invoice_ref must be a string of at most 64 characters' });
  }
  const cleanInvoiceReason = cleanReason(reason, 500);

  try {
    const id = await withTx(async (c) => {
      const orgRes = await c.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
      if (orgRes.rows.length === 0) throw new HttpError(404, { message: 'Organization not found' });
      const result = await c.query(
        `INSERT INTO billing_contributions
           (org_id, user_id, amount_cents, fee_cents, payment_method, provider, status,
            source, invoice_reason, issued_by_admin_id, external_invoice_ref)
         VALUES ($1, $2, $3, 0, 'dev', 'dev', 'pending', 'admin_invoice', $4, $5, $6)
         RETURNING id`,
        [orgId, orgRes.rows[0].owner_id, amount_cents, cleanInvoiceReason, req.admin?.id ?? null, external_invoice_ref ?? null]
      );
      await writeAudit(c, req, {
        action: 'billing.invoice_issued', targetType: 'org', targetId: orgId, reason: cleanInvoiceReason,
        summary: { contribution_id: result.rows[0].id, amount_cents, external_invoice_ref: external_invoice_ref ?? null },
      });
      return result.rows[0].id as string;
    });
    res.status(201).json({ contribution_id: id });
  } catch (err: any) {
    // uq_contrib_external_ref — this exact invoice was already pushed. 409, not a
    // raw 500, so a caller (e.g. Ledger's push flow) can tell "already pushed"
    // from a real error and not retry indefinitely.
    if (err?.code === '23505') {
      return res.status(409).json({ message: 'An invoice with this external_invoice_ref already exists for this org' });
    }
    return fail(res, 'create org invoice', err);
  }
};

// ─── Hardware bans ───────────────────────────────────────────────────────────

/** GET /admin/hwid-bans?q=&page=&limit= */
export const listHwidBans = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, { created_at: 'hb.created_at' }, 'created_at');
  const params: any[] = [];
  let where = '';
  if (p.q) {
    params.push(`${escapeLike(p.q.toLowerCase())}%`, `%${escapeLike(p.q)}%`);
    where = `WHERE hb.hwid LIKE $1
              OR EXISTS (SELECT 1 FROM users lu WHERE lu.hwid = hb.hwid AND lu.callsign ILIKE $2)`;
  }
  try {
    const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM hardware_bans hb ${where}`, params);
    const result = await pool.query(
      `SELECT hb.hwid, hb.reason, hb.created_at, hb.source_user_id,
              su.callsign AS source_callsign,
              (SELECT COUNT(*)::int FROM users lu WHERE lu.hwid = hb.hwid) AS linked_accounts,
              (SELECT lu.callsign FROM users lu WHERE lu.hwid = hb.hwid ORDER BY lu.created_at LIMIT 1) AS first_linked_callsign
       FROM hardware_bans hb
       LEFT JOIN users su ON su.id = hb.source_user_id
       ${where}
       ORDER BY ${p.sortSql} ${p.dir}, hb.hwid
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, p.limit, p.offset],
    );
    res.json({
      bans: result.rows.map((b) => {
        const hw = assessHwid(b.hwid);
        return {
          ...b,
          // `callsign` kept for older panel builds.
          callsign: b.source_callsign ?? b.first_linked_callsign ?? null,
          hwid_short: shortHwid(b.hwid),
          valid_hardware_id: hw.bannable,
          validity_note: hw.reason,
        };
      }),
      total: countRes.rows[0].n,
      page: p.page,
      limit: p.limit,
    });
  } catch (err) {
    return fail(res, 'list hwid bans', err);
  }
};

export const removeHwidBan = async (req: AdminRequest, res: Response) => {
  const { hwid } = req.params;
  if (typeof hwid !== 'string' || hwid.length > 255) return res.status(400).json({ message: 'Invalid hwid' });
  const reason = cleanReason(req.body?.reason);
  try {
    await withTx(async (c) => {
      const del = await c.query('DELETE FROM hardware_bans WHERE hwid = $1 RETURNING reason, source_user_id', [hwid]);
      if (del.rowCount === 0) throw new HttpError(404, { message: 'No ban for that hardware ID' });
      const linked = await c.query('SELECT COUNT(*)::int AS n FROM users WHERE hwid = $1', [hwid]);
      await writeAudit(c, req, {
        action: 'hwid_ban.removed', targetType: 'hwid', targetId: shortHwid(hwid), reason,
        summary: { source_user_id: del.rows[0].source_user_id, linked_accounts: linked.rows[0].n, valid_hardware_id: assessHwid(hwid).bannable },
      });
    });
    res.json({ message: 'HWID ban removed.' });
  } catch (err) {
    return fail(res, 'remove hwid ban', err);
  }
};

// ─── Audit log ───────────────────────────────────────────────────────────────

/** GET /admin/audit?action=&admin_id=&target_type=&target_id=&from=&to=&page=&limit= */
export const listAuditLog = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, { created_at: 'created_at' }, 'created_at');
  const q = req.query as Record<string, unknown>;
  const conds: string[] = [];
  const params: any[] = [];
  const str = (v: unknown, max = 128) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  const action = str(q.action, 64);
  if (action) { params.push(`${escapeLike(action)}%`); conds.push(`action LIKE $${params.length}`); }
  const adminId = str(q.admin_id);
  if (adminId) {
    if (!isUuid(adminId)) return res.status(400).json({ message: 'Invalid admin_id' });
    params.push(adminId); conds.push(`admin_id = $${params.length}`);
  }
  const targetType = str(q.target_type, 32);
  if (targetType) { params.push(targetType); conds.push(`target_type = $${params.length}`); }
  const targetId = str(q.target_id);
  if (targetId) { params.push(targetId); conds.push(`target_id = $${params.length}`); }
  for (const [key, op] of [['from', '>='], ['to', '<']] as const) {
    const v = str(q[key], 40);
    if (!v) continue;
    if (Number.isNaN(Date.parse(v))) return res.status(400).json({ message: `Invalid ${key} timestamp` });
    params.push(new Date(v).toISOString()); conds.push(`created_at ${op} $${params.length}::timestamptz`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  try {
    const [countRes, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM admin_audit_log ${where}`, params),
      pool.query(
        `SELECT id, admin_id, admin_username, action, target_type, target_id, summary, reason, ip, created_at
         FROM admin_audit_log ${where}
         ORDER BY created_at ${p.dir}, id ${p.dir}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      ),
    ]);
    res.json({ entries: rows.rows, total: countRes.rows[0].n, page: p.page, limit: p.limit });
  } catch (err) {
    return fail(res, 'list audit', err);
  }
};

// ─── Voice misconduct reports (admin side) ───────────────────────────────────

const VOICE_REPORT_STATUSES = ['pending', 'reviewed', 'dismissed', 'actioned'];

/** GET /admin/voice-reports?status=&page=&limit= — metadata only, never audio. */
export const listVoiceReportsAdmin = async (req: AdminRequest, res: Response) => {
  const p = parseListParams(req.query as any, { created_at: 'vr.created_at' }, 'created_at');
  const status = typeof req.query.status === 'string' && VOICE_REPORT_STATUSES.includes(req.query.status) ? req.query.status : null;
  const params: any[] = status ? [status] : [];
  const where = status ? 'WHERE vr.status = $1' : '';
  try {
    const [countRes, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS n FROM voice_misconduct_reports vr ${where}`, params),
      pool.query(
        `SELECT vr.id, vr.reporter_id, ru.callsign AS reporter_callsign,
                vr.accused_id, au.callsign AS accused_callsign,
                vr.org_id, vr.channel_id, vr.reported_at, vr.reporter_note,
                vr.speaking_history, vr.speaker_map, vr.status, vr.admin_notes, vr.created_at
         FROM voice_misconduct_reports vr
         LEFT JOIN users ru ON ru.id = vr.reporter_id
         LEFT JOIN users au ON au.id = vr.accused_id
         ${where}
         ORDER BY ${p.sortSql} ${p.dir}, vr.id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, p.limit, p.offset],
      ),
    ]);
    res.json({ reports: rows.rows, total: countRes.rows[0].n, page: p.page, limit: p.limit });
  } catch (err) {
    return fail(res, 'list voice reports', err);
  }
};

/** GET /admin/voice-reports/:id/audio — decrypts one clip; the access is audited first. */
export const getVoiceReportAudioAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!requireUuidParam(res, id, 'report id')) return;
  try {
    const clip = await withTx(async (c) => {
      const r = await c.query('SELECT audio_clip, accused_id FROM voice_misconduct_reports WHERE id = $1', [id]);
      if (r.rowCount === 0) throw new HttpError(404, { message: 'Report not found' });
      await writeAudit(c, req, {
        action: 'voice_report.audio_accessed', targetType: 'voice_report', targetId: id,
        summary: { accused_id: r.rows[0].accused_id },
      });
      return r.rows[0].audio_clip as Buffer;
    });
    const decrypted = decryptReportBuffer(clip);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.send(decrypted);
  } catch (err) {
    return fail(res, 'voice report audio', err);
  }
};

/** PATCH /admin/voice-reports/:id { status, admin_notes? } */
export const updateVoiceReportAdmin = async (req: AdminRequest, res: Response) => {
  const { id } = req.params;
  if (!requireUuidParam(res, id, 'report id')) return;
  const { status, admin_notes } = req.body ?? {};
  if (!VOICE_REPORT_STATUSES.includes(status)) return res.status(400).json({ message: 'Invalid status' });
  if (admin_notes != null && (typeof admin_notes !== 'string' || admin_notes.length > 4000)) {
    return res.status(400).json({ message: 'admin_notes must be a string of at most 4000 characters' });
  }
  try {
    await withTx(async (c) => {
      const before = await c.query('SELECT status, admin_notes FROM voice_misconduct_reports WHERE id = $1 FOR UPDATE', [id]);
      if (before.rowCount === 0) throw new HttpError(404, { message: 'Report not found' });
      await c.query('UPDATE voice_misconduct_reports SET status = $2, admin_notes = $3 WHERE id = $1', [id, status, admin_notes ?? null]);
      await writeAudit(c, req, {
        action: 'voice_report.status_changed', targetType: 'voice_report', targetId: id,
        summary: {
          before: before.rows[0].status,
          after: status,
          notes_changed: (before.rows[0].admin_notes ?? null) !== (admin_notes ?? null),
        },
      });
    });
    res.json({ ok: true });
  } catch (err) {
    return fail(res, 'update voice report', err);
  }
};

// ─── Media Nodes (Phase A of multi-tenant infra) ────────────────────────────────

export const listMediaNodes = async (_req: AdminRequest, res: Response) => {
  try {
    const { nodes, scalingWarning, thresholds } = await getNodesWithStatus();
    res.json({
      nodes,
      scaling_warning: scalingWarning,
      thresholds,
      tier_catalog: DROPLET_TIERS,
    });
  } catch (err) {
    return fail(res, 'list media nodes', err);
  }
};

export const updateMediaNode = async (req: AdminRequest, res: Response) => {
  const { nodeId } = req.params; // human node_id, e.g. "node-1", not the UUID PK
  const { region, tenancy_mode, plan_tier, in_service } = req.body as {
    region?: string;
    tenancy_mode?: string;
    plan_tier?: string;
    in_service?: boolean;
  };

  if (tenancy_mode && !['shared', 'dedicated'].includes(tenancy_mode)) {
    return res.status(400).json({ message: 'tenancy_mode must be shared or dedicated' });
  }
  if (plan_tier && !DROPLET_TIERS.some((t) => t.id === plan_tier)) {
    return res.status(400).json({ message: 'plan_tier must be a known tier id' });
  }
  if (region !== undefined && (typeof region !== 'string' || region.length > 50)) {
    return res.status(400).json({ message: 'Invalid region' });
  }
  if (in_service !== undefined && typeof in_service !== 'boolean') {
    return res.status(400).json({ message: 'in_service must be a boolean' });
  }

  try {
    await withTx(async (c) => {
      const before = await c.query(
        'SELECT region, tenancy_mode, plan_tier, in_service FROM media_nodes WHERE node_id = $1 FOR UPDATE',
        [nodeId],
      );
      if (before.rowCount === 0) throw new HttpError(404, { message: 'Node not found' });
      const after = await c.query(
        `UPDATE media_nodes
         SET region       = COALESCE($2, region),
             tenancy_mode = COALESCE($3, tenancy_mode),
             plan_tier    = COALESCE($4, plan_tier),
             in_service   = COALESCE($5, in_service),
             updated_at   = NOW()
         WHERE node_id = $1
         RETURNING region, tenancy_mode, plan_tier, in_service`,
        [nodeId, region ?? null, tenancy_mode ?? null, plan_tier ?? null, in_service ?? null]
      );
      await writeAudit(c, req, {
        action: 'node.updated', targetType: 'node', targetId: String(nodeId),
        summary: { before: before.rows[0], after: after.rows[0] },
      });
    });
    res.json({ message: 'Node updated.' });
  } catch (err) {
    return fail(res, 'update media node', err);
  }
};

export const getNodeMetricsHistory = async (req: AdminRequest, res: Response) => {
  const { nodeId } = req.params; // human node_id, e.g. "node-1", not the UUID PK
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);

  try {
    const result = await pool.query(
      `SELECT h.cpu_pct, h.mem_pct, h.net_rx_mbps, h.net_tx_mbps, h.recorded_at
       FROM media_node_metrics_history h
       JOIN media_nodes mn ON mn.id = h.node_id
       WHERE mn.node_id = $1
         AND h.recorded_at > NOW() - make_interval(hours => $2::int)
       ORDER BY h.recorded_at ASC
       LIMIT 5000`,
      [nodeId, Math.floor(hours)]
    );
    res.json({ history: result.rows });
  } catch (err) {
    return fail(res, 'node metrics history', err);
  }
};

export const assignOrgToNode = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  if (!requireUuidParam(res, orgId, 'organization id')) return;
  const { node_id } = req.body as { node_id?: string };
  if (!node_id || typeof node_id !== 'string') return res.status(400).json({ message: 'node_id is required' });

  try {
    await withTx(async (c) => {
      const nodeRes = await c.query('SELECT id FROM media_nodes WHERE node_id = $1', [node_id]);
      if (nodeRes.rowCount === 0) throw new HttpError(404, { message: 'Node not found' });
      const nodeUuid = nodeRes.rows[0].id;

      const orgRes = await c.query('SELECT id FROM organizations WHERE id = $1', [orgId]);
      if (orgRes.rowCount === 0) throw new HttpError(404, { message: 'Organization not found' });

      const prev = await c.query(
        `SELECT mn.node_id FROM org_node_assignments ona JOIN media_nodes mn ON mn.id = ona.node_id WHERE ona.org_id = $1`,
        [orgId],
      );
      await c.query(
        // An explicit pin replaces any automatic placement or pending move.
        // (Moving live users needs a drain too — POST /admin/orgs/:id/migrate does both.)
        `INSERT INTO org_node_assignments (org_id, node_id, placement)
         VALUES ($1, $2, 'pinned')
         ON CONFLICT (org_id) DO UPDATE SET
           node_id        = EXCLUDED.node_id,
           placement      = 'pinned',
           state          = 'active',
           target_node_id = NULL,
           epoch          = org_node_assignments.epoch + 1,
           updated_at     = NOW()`,
        [orgId, nodeUuid]
      );
      await writeAudit(c, req, {
        action: 'org.node_assigned', targetType: 'org', targetId: orgId,
        summary: { before: prev.rows[0]?.node_id ?? null, after: node_id },
      });
    });
    res.json({ message: 'Org assigned to node.' });
  } catch (err) {
    return fail(res, 'assign org to node', err);
  }
};

export const unassignOrgFromNode = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  if (!requireUuidParam(res, orgId, 'organization id')) return;
  try {
    await withTx(async (c) => {
      const result = await c.query(
        `DELETE FROM org_node_assignments ona USING media_nodes mn
         WHERE ona.org_id = $1 AND mn.id = ona.node_id RETURNING mn.node_id`,
        [orgId],
      );
      if (result.rowCount === 0) throw new HttpError(404, { message: 'No assignment for this org' });
      await writeAudit(c, req, {
        action: 'org.node_unassigned', targetType: 'org', targetId: orgId,
        summary: { before: result.rows[0].node_id, after: null },
      });
    });
    res.json({ message: 'Org unassigned — routes to shared default capacity.' });
  } catch (err) {
    return fail(res, 'unassign org from node', err);
  }
};

// Force-closes every active session for one org across whatever node(s) currently
// host it, without affecting other orgs sharing the same node — e.g. as the last
// step of a node migration, or to temporarily suspend an org's voice/video. Kept
// deliberately separate from assign/unassignOrgFromNode: reassigning routing and
// hard-closing live sessions are two independent operations, and callers may want
// either one without the other.
export const drainOrg = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  if (!requireUuidParam(res, orgId, 'organization id')) return;
  try {
    await withTx(async (c) => {
      const orgRes = await c.query('SELECT id FROM organizations WHERE id = $1', [orgId]);
      if (orgRes.rowCount === 0) throw new HttpError(404, { message: 'Organization not found' });
      await writeAudit(c, req, { action: 'org.drained', targetType: 'org', targetId: orgId, reason: cleanReason(req.body?.reason) });
    });
    await publishEvent(`specter.cmd.drain_org.${orgId}`, {});
    res.json({ message: 'Drain command sent.' });
  } catch (err) {
    return fail(res, 'drain org', err);
  }
};

// ─── Node Provisioning (Phase B of multi-tenant infra) ──────────────────────────

export const provisionNode = async (req: AdminRequest, res: Response) => {
  const { region, node_id } = req.body as { region?: string; node_id?: string };
  if (!region) return res.status(400).json({ message: 'region is required' });
  if (!isValidRegion(region)) return res.status(400).json({ message: 'Unsupported region' });
  if (node_id && !isValidNodeId(node_id)) {
    return res.status(400).json({ message: 'node_id must be 3-20 lowercase letters, digits, or hyphens' });
  }

  try {
    if (node_id) {
      // Fail before ever calling the DO API — a collision discovered only after
      // the droplet already exists (e.g. at DNS record creation) would leave an
      // orphaned billable droplet with no automated cleanup (see Phase B plan's
      // "no auto-rollback" risk note).
      const [existingNode, existingRequest] = await Promise.all([
        pool.query('SELECT 1 FROM media_nodes WHERE node_id = $1', [node_id]),
        pool.query(`SELECT 1 FROM node_provision_requests WHERE node_id = $1 AND status = 'provisioning'`, [node_id]),
      ]);
      if ((existingNode.rowCount ?? 0) > 0 || (existingRequest.rowCount ?? 0) > 0) {
        return res.status(409).json({ message: `node_id "${node_id}" is already in use or currently provisioning` });
      }
    }

    // A remote node needs: NATS reachable over the VPC with per-node users
    // (NATS_AUTH_MODE=callout — never the shared token), a pinned image it can
    // pull, and ES256 media tickets (checked in provisionMediaNode). It never
    // gets JWT_SECRET or any DigitalOcean credential.
    const natsPrivateHost = process.env.NATS_PRIVATE_HOST;
    if (!natsPrivateHost || process.env.NATS_AUTH_MODE !== 'callout') {
      return res.status(503).json({ message: 'Central NATS is not reachable beyond this droplet with per-node auth (NATS_PRIVATE_HOST + NATS_AUTH_MODE=callout) — cannot provision a node that could not reach it.' });
    }
    const mediaImageRef = process.env.MEDIA_IMAGE_REF ?? '';
    const ghcrPullToken = process.env.GHCR_PULL_TOKEN ?? '';
    if (!isPinnedImageRef(mediaImageRef) || !ghcrPullToken) {
      return res.status(503).json({ message: 'MEDIA_IMAGE_REF (a pinned ghcr.io tag or digest, not :latest) and GHCR_PULL_TOKEN (read:packages) must be set to provision a node.' });
    }

    // Audit the intent before the billable external call: if the request
    // dies mid-flight there is still a record of who started it.
    await writeAudit(pool, req, { action: 'node.provision_requested', targetType: 'node', targetId: node_id ?? null, summary: { region } });

    const result = await provisionMediaNode({
      region,
      nodeId: node_id,
      requestedBy: req.admin?.id ?? null,
      natsUrl: `nats://${natsPrivateHost}:4223`,
      mediaImageRef,
      ghcrPullToken,
      ghcrPullUser: process.env.GHCR_PULL_USER || 'owner',
      vpcUuid: process.env.DO_VPC_UUID,
    });

    await writeAudit(pool, req, {
      action: 'node.provisioned', targetType: 'node', targetId: result.nodeId,
      summary: { region, droplet_id: result.dropletId, image: mediaImageRef },
    });
    res.status(202).json({ node_id: result.nodeId, droplet_id: result.dropletId, region, status: 'provisioning', in_service: false });
  } catch (err: any) {
    if (err instanceof LifecycleError) return res.status(err.status).json({ message: err.message });
    if (err instanceof ProvisionError) {
      return res.status(502).json({ message: err.message, droplet_id: err.dropletId, cleaned_up: err.cleanedUp });
    }
    if (err.message?.includes('DO_API_TOKEN')) {
      return res.status(503).json({ message: 'Provisioning not configured on this server.' });
    }
    return fail(res, 'provision node', err);
  }
};

// Moves one org to another node: draining → new tickets go to the target →
// drain_org → the target becomes the org's node (utils/nodeLifecycle.migrateOrg).
export const migrateOrgToNode = async (req: AdminRequest, res: Response) => {
  const { orgId } = req.params;
  if (!requireUuidParam(res, orgId, 'organization id')) return;
  const { node_id } = req.body as { node_id?: string };
  if (!node_id || typeof node_id !== 'string') return res.status(400).json({ message: 'node_id is required' });
  try {
    const orgRes = await pool.query('SELECT id FROM organizations WHERE id = $1', [orgId]);
    if (orgRes.rowCount === 0) return res.status(404).json({ message: 'Organization not found' });
    const result = await migrateOrg(String(orgId), node_id, { settleMs: 3000 });
    await writeAudit(pool, req, {
      action: 'org.migrated', targetType: 'org', targetId: String(orgId),
      summary: { before: result.from, after: result.to, epoch: result.epoch }, reason: cleanReason(req.body?.reason),
    });
    res.json({ message: 'Org migrated.', ...result });
  } catch (err: any) {
    if (err instanceof LifecycleError) return res.status(err.status).json({ message: err.message });
    return fail(res, 'migrate org', err);
  }
};

// Retires a provisioned node: orgs migrated away, NATS credential revoked,
// A record + droplet deleted, row removed (utils/nodeLifecycle.teardownNode).
export const teardownMediaNode = async (req: AdminRequest, res: Response) => {
  const { nodeId } = req.params;
  if (typeof nodeId !== 'string' || !isValidNodeId(nodeId)) return res.status(400).json({ message: 'Invalid node id' });
  try {
    await writeAudit(pool, req, { action: 'node.teardown_requested', targetType: 'node', targetId: nodeId, reason: cleanReason(req.body?.reason) });
    const result = await teardownNode(nodeId, { force: req.body?.force === true, settleMs: 3000 });
    await writeAudit(pool, req, { action: 'node.torn_down', targetType: 'node', targetId: nodeId, summary: result as any });
    res.status(result.dropletDeleted ? 200 : 502).json(result);
  } catch (err: any) {
    if (err instanceof LifecycleError) return res.status(err.status).json({ message: err.message });
    if (err.message?.includes('DO_API_TOKEN')) return res.status(503).json({ message: 'Provisioning not configured on this server.' });
    return fail(res, 'teardown node', err);
  }
};

// Reconciler: specter-managed droplets with no node row or live provision record. Read-only.
export const listOrphanDroplets = async (_req: AdminRequest, res: Response) => {
  try {
    res.json({ orphans: await findOrphanDroplets() });
  } catch (err: any) {
    if (err.message?.includes('DO_API_TOKEN')) return res.status(503).json({ message: 'Provisioning not configured on this server.' });
    return fail(res, 'list orphan droplets', err);
  }
};

export const listProvisioningRequests = async (_req: AdminRequest, res: Response) => {
  try {
    // Reconciled lazily at read time, same pattern as "online" being computed
    // from last_heartbeat_at elsewhere rather than written by a sweep task.
    await pool.query(
      `UPDATE node_provision_requests npr SET status = 'ready', updated_at = NOW()
       WHERE npr.status = 'provisioning'
         AND EXISTS (
           SELECT 1 FROM media_nodes mn
           WHERE mn.node_id = npr.node_id AND ${liveSql('mn.last_heartbeat_at')}
         )`
    );
    await pool.query(
      `UPDATE node_provision_requests SET status = 'timed_out', updated_at = NOW()
       WHERE status = 'provisioning' AND created_at < NOW() - INTERVAL '10 minutes'`
    );
    const result = await pool.query(
      `SELECT * FROM node_provision_requests ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ requests: result.rows });
  } catch (err) {
    return fail(res, 'list provisioning requests', err);
  }
};
