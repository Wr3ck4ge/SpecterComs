import crypto from 'crypto';

// L2: pure helpers for email verification tokens (kept free of DB/env so the
// contract tests can exercise them). Same pattern as password reset: 256 bits
// of randomness, stored only as a SHA-256 hash.

export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
export const RESEND_COOLDOWN_MS = 60 * 1000;            // per-account resend spacing

export function hashVerifyToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newVerifyToken(now = Date.now()): { token: string; hash: string; expires: Date } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashVerifyToken(token), expires: new Date(now + VERIFY_TOKEN_TTL_MS) };
}

export interface VerifyRow {
  email_verify_token_hash: string | null;
  email_verify_expires: Date | string | null;
}

/** True only when the stored hash matches and the token has not expired. */
export function tokenIsValid(row: VerifyRow | undefined | null, token: string, now = Date.now()): boolean {
  if (!row || !row.email_verify_token_hash || !row.email_verify_expires) return false;
  const a = Buffer.from(row.email_verify_token_hash);
  const b = Buffer.from(hashVerifyToken(token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return new Date(row.email_verify_expires).getTime() > now;
}

/** Milliseconds the caller must still wait before another send (0 = allowed). */
export function resendWaitMs(sentAt: Date | string | null | undefined, now = Date.now()): number {
  if (!sentAt) return 0;
  return Math.max(0, new Date(sentAt).getTime() + RESEND_COOLDOWN_MS - now);
}

// ---- Required verification for new signups (REQUIRE_EMAIL_VERIFICATION) ----

/** Server switch, read at call time. Default off so a deploy without working SMTP can't block signups. */
export function requireEmailVerification(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.REQUIRE_EMAIL_VERIFICATION ?? '').trim());
}

/** True when this account must verify its email before it may sign in / refresh. */
export function isBlockedUnverified(row: { email_verification_required?: boolean | null; email_verified_at?: unknown } | undefined | null): boolean {
  return !!row && row.email_verification_required === true && !row.email_verified_at;
}

/** "jane@example.com" -> "j***@example.com" */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
