import { Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import { pool } from '../config/db.js';
import { isUuid } from '../utils/adminPolicy.js';
import {
  Subject, SubjectType, requireTwoFactorForPrivileged,
  TWO_FACTOR_REQUIRED, TWO_FACTOR_CODE_REQUIRED, TWO_FACTOR_INVALID,
} from '../utils/twoFactor.js';
import * as store from '../utils/twoFactorStore.js';

// L3: two-factor authentication endpoints, shared by users (/auth/2fa/*) and
// platform admins (/admin/2fa/*), plus the "required for privileged
// accounts" enforcement middleware (REQUIRE_2FA_FOR_PRIVILEGED).

type Kind = {
  type: SubjectType;
  subject(req: any): Subject | null;
  /** argon2 hash + a label for the authenticator entry, or null. */
  account(id: string): Promise<{ password_hash: string | null; label: string } | null>;
  actor(req: any): { id: string; username: string } | undefined;
};

const userKind: Kind = {
  type: 'user',
  subject: (req) => (req.user?.id && !req.user?.role ? { type: 'user', id: String(req.user.id) } : null),
  async account(id) {
    const r = await pool.query('SELECT callsign, password_hash, erased_at FROM users WHERE id = $1', [id]);
    const u = r.rows[0];
    return u && !u.erased_at ? { password_hash: u.password_hash, label: u.callsign } : null;
  },
  actor: () => undefined,
};

const adminKind: Kind = {
  type: 'admin',
  subject: (req) => (req.admin?.id ? { type: 'admin', id: String(req.admin.id) } : null),
  async account(id) {
    const r = await pool.query('SELECT username, password_hash FROM platform_admins WHERE id = $1', [id]);
    const a = r.rows[0];
    return a ? { password_hash: a.password_hash, label: `admin:${a.username}` } : null;
  },
  actor: (req) => (req.admin ? { id: req.admin.id, username: req.admin.username } : undefined),
};

async function passwordOk(kind: Kind, s: Subject, password: unknown): Promise<boolean> {
  if (typeof password !== 'string' || !password || password.length > 1024) return false;
  const acct = await kind.account(s.id);
  if (!acct?.password_hash) return false;
  return argon2.verify(acct.password_hash, password).catch(() => false);
}

const fail500 = (res: Response, label: string, err: unknown) => {
  console.error(`[2fa] ${label} failed:`, (err as any)?.code || (err as any)?.message);
  return res.status(500).json({ message: 'Internal server error' });
};

/**
 * Re-auth second step: when the account has 2FA on, the body must carry a
 * valid `code` (or `recovery_code`). Returns true when the caller may go on;
 * otherwise it has already answered.
 */
export async function checkSecondFactor(s: Subject, body: any, res: Response, actor?: { id: string; username: string }): Promise<boolean> {
  if (!(await store.isEnabled(s))) return true;
  const code = body?.code, recovery = body?.recovery_code;
  if (!code && !recovery) {
    res.status(403).json({ code: TWO_FACTOR_CODE_REQUIRED, message: 'Enter the code from your authenticator app.' });
    return false;
  }
  if (!store.takeAccountAttempt(s)) {
    res.status(429).json({ message: 'Too many code attempts. Try again in an hour.' });
    return false;
  }
  const r = await store.verifyFactor(s, { code, recovery_code: recovery });
  if (!r.ok) {
    res.status(403).json({ code: TWO_FACTOR_INVALID, message: 'That code is not valid. Codes can only be used once.' });
    return false;
  }
  if (r.method === 'recovery') await store.auditTwoFactor(s, '2fa.recovery_used', { remaining: r.recovery_remaining }, actor);
  return true;
}

async function isPrivilegedUser(userId: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM organizations WHERE owner_id = $1 LIMIT 1', [userId]);
  return (r.rowCount ?? 0) > 0;
}

function handlers(kind: Kind) {
  const subj = (req: any, res: Response): Subject | null => {
    const s = kind.subject(req);
    if (!s) res.status(401).json({ message: 'Sign in first' });
    return s;
  };

  return {
    /** GET: { enabled, pending, recovery_remaining, required } */
    status: async (req: Request, res: Response) => {
      const s = subj(req, res); if (!s) return;
      try {
        const st = await store.getState(s);
        const privileged = kind.type === 'admin' ? true : await isPrivilegedUser(s.id);
        res.json({ ...st, required: privileged && requireTwoFactorForPrivileged(), privileged });
      } catch (err) { return fail500(res, 'status', err); }
    },

    /** POST { password } -> { secret, otpauth_uri } (shown once; not active until confirmed) */
    enroll: async (req: Request, res: Response) => {
      const s = subj(req, res); if (!s) return;
      try {
        if (!store.takeAccountAttempt(s)) return res.status(429).json({ message: 'Too many attempts. Try again in an hour.' });
        if (!(await passwordOk(kind, s, req.body?.password))) {
          return res.status(403).json({ code: 'PASSWORD_INCORRECT', message: 'Incorrect password.' });
        }
        const acct = await kind.account(s.id);
        const out = await store.startEnrollment(s, acct?.label || s.id);
        if (!out) return res.status(409).json({ message: 'Two-factor authentication is already on.' });
        res.setHeader('Cache-Control', 'no-store');
        res.json(out);
      } catch (err) { return fail500(res, 'enroll', err); }
    },

    /** POST { code } -> { recovery_codes } (shown once) */
    confirm: async (req: Request, res: Response) => {
      const s = subj(req, res); if (!s) return;
      try {
        if (!store.takeAccountAttempt(s)) return res.status(429).json({ message: 'Too many code attempts. Try again in an hour.' });
        const r = await store.confirmEnrollment(s, req.body?.code);
        if (!r.ok && r.reason === 'no_pending') return res.status(409).json({ message: 'Start setup first.' });
        if (!r.ok) return res.status(403).json({ code: TWO_FACTOR_INVALID, message: 'That code is not valid. Check the time on your device and try the next code.' });
        await store.auditTwoFactor(s, '2fa.enabled', {}, kind.actor(req));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ message: 'Two-factor authentication is on.', recovery_codes: r.recovery_codes });
      } catch (err) { return fail500(res, 'confirm', err); }
    },

    /** POST { password, code | recovery_code } */
    disable: async (req: Request, res: Response) => {
      const s = subj(req, res); if (!s) return;
      try {
        if (!(await store.isEnabled(s))) {
          await store.disable(s); // drop a pending enrolment, if any
          return res.json({ message: 'Two-factor authentication is off.' });
        }
        if (!(await passwordOk(kind, s, req.body?.password))) {
          return res.status(403).json({ code: 'PASSWORD_INCORRECT', message: 'Incorrect password.' });
        }
        if (!(await checkSecondFactor(s, req.body, res, kind.actor(req)))) return;
        await store.disable(s);
        await store.auditTwoFactor(s, '2fa.disabled', {}, kind.actor(req));
        res.json({ message: 'Two-factor authentication is off.' });
      } catch (err) { return fail500(res, 'disable', err); }
    },

    /** POST { password, code } -> { recovery_codes } (old ones stop working) */
    regenerate: async (req: Request, res: Response) => {
      const s = subj(req, res); if (!s) return;
      try {
        if (!(await store.isEnabled(s))) return res.status(409).json({ message: 'Two-factor authentication is not on.' });
        if (!(await passwordOk(kind, s, req.body?.password))) {
          return res.status(403).json({ code: 'PASSWORD_INCORRECT', message: 'Incorrect password.' });
        }
        if (!(await checkSecondFactor(s, req.body, res, kind.actor(req)))) return;
        const codes = await store.regenerateRecoveryCodes(s);
        await store.auditTwoFactor(s, '2fa.recovery_regenerated', {}, kind.actor(req));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ recovery_codes: codes });
      } catch (err) { return fail500(res, 'regenerate', err); }
    },
  };
}

export const userTwoFactor = handlers(userKind);
export const adminTwoFactor = handlers(adminKind);

// ---- Enforcement (REQUIRE_2FA_FOR_PRIVILEGED) --------------------------------

const requiredBody = (who: string) => ({
  code: TWO_FACTOR_REQUIRED,
  message: `Turn on two-factor authentication to do this. ${who}`,
});

/** Admin routes (after requireAdminSession): an admin without 2FA gets 403 while the switch is on. */
export const requireAdminTwoFactor = async (req: any, res: Response, next: NextFunction) => {
  if (!requireTwoFactorForPrivileged()) return next();
  try {
    if (await store.isEnabled({ type: 'admin', id: String(req.admin?.id) })) return next();
    return res.status(403).json(requiredBody('Set it up under System → Two-factor authentication.'));
  } catch (err) { return fail500(res, 'admin enforcement', err); }
};

/**
 * Owner-only org actions: the org OWNER without 2FA gets 403 while the switch
 * is on. Anyone else passes through (the controller does its own permission
 * check), so this never widens or narrows non-owner access.
 */
export const requireOwnerTwoFactor = async (req: any, res: Response, next: NextFunction) => {
  if (!requireTwoFactorForPrivileged()) return next();
  const orgId = req.params?.orgId ?? req.params?.id;
  const userId = req.user?.id;
  if (!isUuid(orgId) || !userId) return next();
  try {
    const r = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
    if (r.rows[0]?.owner_id !== userId) return next();
    if (await store.isEnabled({ type: 'user', id: String(userId) })) return next();
    return res.status(403).json(requiredBody('Server owners need it: Settings → Account → Two-factor authentication.'));
  } catch (err) { return fail500(res, 'owner enforcement', err); }
};
