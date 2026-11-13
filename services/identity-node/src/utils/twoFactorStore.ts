import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { createKeyedLimiter } from './adminPolicy.js';
import {
  Subject, ACCOUNT_MAX_ATTEMPTS_PER_HOUR, CHALLENGE_MAX_ATTEMPTS, CHALLENGE_TTL_SECONDS,
  matchTotp, decryptTotpSecret, encryptTotpSecret, generateTotpSecret, generateRecoveryCodes,
  normalizeRecoveryCode, hashRecoveryCode, otpauthUri,
} from './twoFactor.js';

// L3: DB side of two-factor auth. Every code check goes through verifyFactor,
// which is rate limited per account and replay-safe (the accepted step is
// written with a conditional UPDATE, a recovery code is spent the same way).

type Db = PoolClient | typeof pool;

const accountLimiter = createKeyedLimiter(60 * 60_000, ACCOUNT_MAX_ATTEMPTS_PER_HOUR);
const challengeLimiter = createKeyedLimiter(CHALLENGE_TTL_SECONDS * 1000, CHALLENGE_MAX_ATTEMPTS);

const key = (s: Subject) => `${s.type}:${s.id}`;

/** Counts one code attempt. False = over the per-account hourly budget. */
export const takeAccountAttempt = (s: Subject) => accountLimiter.take(key(s));
/** Counts one attempt against a login challenge. False = challenge used up. */
export const takeChallengeAttempt = (jti: string) => challengeLimiter.take(jti);

export interface TwoFactorState { enabled: boolean; pending: boolean; recovery_remaining: number }

/** Missing table (migration not yet applied) reads as "not enrolled"; any other error throws. */
const isMissingTable = (err: any) => err?.code === '42P01';

export async function getState(s: Subject, db: Db = pool): Promise<TwoFactorState> {
  try {
    const r = await db.query(
      `SELECT (t.enabled_at IS NOT NULL) AS enabled,
              (SELECT COUNT(*)::int FROM two_factor_recovery_codes c
                WHERE c.subject_type = t.subject_type AND c.subject_id = t.subject_id AND c.used_at IS NULL) AS remaining
       FROM two_factor t WHERE t.subject_type = $1 AND t.subject_id = $2`,
      [s.type, s.id],
    );
    const row = r.rows[0];
    if (!row) return { enabled: false, pending: false, recovery_remaining: 0 };
    return { enabled: !!row.enabled, pending: !row.enabled, recovery_remaining: row.remaining ?? 0 };
  } catch (err) {
    if (isMissingTable(err)) return { enabled: false, pending: false, recovery_remaining: 0 };
    throw err;
  }
}

export async function isEnabled(s: Subject, db: Db = pool): Promise<boolean> {
  return (await getState(s, db)).enabled;
}

/** Starts (or restarts) enrolment. Null when 2FA is already on. */
export async function startEnrollment(s: Subject, accountLabel: string): Promise<{ secret: string; otpauth_uri: string } | null> {
  const secret = generateTotpSecret();
  const r = await pool.query(
    `INSERT INTO two_factor (subject_type, subject_id, secret_encrypted)
     VALUES ($1, $2, $3)
     ON CONFLICT (subject_type, subject_id) DO UPDATE
       SET secret_encrypted = EXCLUDED.secret_encrypted, last_used_step = NULL, updated_at = NOW()
       WHERE two_factor.enabled_at IS NULL
     RETURNING subject_id`,
    [s.type, s.id, encryptTotpSecret(secret, s)],
  );
  if (!r.rowCount) return null;
  return { secret, otpauth_uri: otpauthUri(secret, accountLabel) };
}

async function insertRecoveryCodes(c: PoolClient, s: Subject): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await c.query('DELETE FROM two_factor_recovery_codes WHERE subject_type = $1 AND subject_id = $2', [s.type, s.id]);
  for (const code of codes) {
    await c.query(
      'INSERT INTO two_factor_recovery_codes (subject_type, subject_id, code_hash) VALUES ($1, $2, $3)',
      [s.type, s.id, hashRecoveryCode(normalizeRecoveryCode(code)!)],
    );
  }
  return codes;
}

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

export type ConfirmResult = { ok: true; recovery_codes: string[] } | { ok: false; reason: 'no_pending' | 'invalid' };

/** First code from the authenticator turns 2FA on and returns the recovery codes (shown once). */
export async function confirmEnrollment(s: Subject, code: unknown, nowMs = Date.now()): Promise<ConfirmResult> {
  return tx(async (c) => {
    const r = await c.query(
      `SELECT secret_encrypted, last_used_step FROM two_factor
       WHERE subject_type = $1 AND subject_id = $2 AND enabled_at IS NULL FOR UPDATE`,
      [s.type, s.id],
    );
    if (!r.rows[0]) return { ok: false, reason: 'no_pending' } as const;
    const step = matchTotp(decryptTotpSecret(r.rows[0].secret_encrypted, s), code, r.rows[0].last_used_step, nowMs);
    if (step === null) return { ok: false, reason: 'invalid' } as const;
    await c.query(
      `UPDATE two_factor SET enabled_at = NOW(), last_used_step = $3, updated_at = NOW()
       WHERE subject_type = $1 AND subject_id = $2`,
      [s.type, s.id, step],
    );
    const recovery_codes = await insertRecoveryCodes(c, s);
    return { ok: true, recovery_codes } as const;
  });
}

export type FactorResult = { ok: true; method: 'totp' | 'recovery'; recovery_remaining?: number } | { ok: false };

/**
 * Checks a TOTP code or a recovery code for an ENABLED account and consumes
 * it (step recorded / recovery code spent). Callers count the attempt with
 * takeAccountAttempt first.
 */
export async function verifyFactor(s: Subject, input: { code?: unknown; recovery_code?: unknown }, nowMs = Date.now(), db: Db = pool): Promise<FactorResult> {
  if (input.recovery_code !== undefined && input.recovery_code !== null && input.recovery_code !== '') {
    const norm = normalizeRecoveryCode(input.recovery_code);
    if (!norm) return { ok: false };
    const r = await db.query(
      `UPDATE two_factor_recovery_codes rc SET used_at = NOW()
       FROM two_factor t
       WHERE rc.subject_type = $1 AND rc.subject_id = $2 AND rc.code_hash = $3 AND rc.used_at IS NULL
         AND t.subject_type = rc.subject_type AND t.subject_id = rc.subject_id AND t.enabled_at IS NOT NULL
       RETURNING rc.id`,
      [s.type, s.id, hashRecoveryCode(norm)],
    );
    if (!r.rowCount) return { ok: false };
    const left = await db.query(
      `SELECT COUNT(*)::int AS n FROM two_factor_recovery_codes WHERE subject_type = $1 AND subject_id = $2 AND used_at IS NULL`,
      [s.type, s.id],
    );
    return { ok: true, method: 'recovery', recovery_remaining: left.rows[0]?.n ?? 0 };
  }

  const r = await db.query(
    `SELECT secret_encrypted, last_used_step FROM two_factor
     WHERE subject_type = $1 AND subject_id = $2 AND enabled_at IS NOT NULL`,
    [s.type, s.id],
  );
  const row = r.rows[0];
  if (!row) return { ok: false };
  const step = matchTotp(decryptTotpSecret(row.secret_encrypted, s), input.code, row.last_used_step, nowMs);
  if (step === null) return { ok: false };
  // Conditional write: two concurrent requests with the same code -> one wins.
  const u = await db.query(
    `UPDATE two_factor SET last_used_step = $3, updated_at = NOW()
     WHERE subject_type = $1 AND subject_id = $2 AND enabled_at IS NOT NULL
       AND (last_used_step IS NULL OR last_used_step < $3)`,
    [s.type, s.id, step],
  );
  return u.rowCount === 1 ? { ok: true, method: 'totp' } : { ok: false };
}

export async function disable(s: Subject): Promise<void> {
  await pool.query('DELETE FROM two_factor WHERE subject_type = $1 AND subject_id = $2', [s.type, s.id]);
}

export async function regenerateRecoveryCodes(s: Subject): Promise<string[]> {
  return tx((c) => insertRecoveryCodes(c, s));
}

/** Erasure: drops a user's 2FA rows (no-op before the migration exists). */
export async function deleteForSubject(db: Db, s: Subject): Promise<void> {
  const t = await db.query(`SELECT to_regclass('two_factor') IS NOT NULL AS ok`);
  if (t.rows[0]?.ok) await db.query('DELETE FROM two_factor WHERE subject_type = $1 AND subject_id = $2', [s.type, s.id]);
}

/**
 * Self-service audit row in admin_audit_log (no actor admin, no IP: the
 * account holder did it). Summary is flags only.
 */
export async function auditTwoFactor(s: Subject, action: string, summary: Record<string, unknown> = {}, actor?: { id: string; username: string }): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, admin_username, action, target_type, target_id, summary)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actor?.id ?? null, actor?.username?.slice(0, 32) ?? null, action, s.type, s.id, JSON.stringify(summary)],
    );
  } catch (err: any) {
    console.error('[2fa] audit write failed:', err?.code || err?.message);
  }
}
