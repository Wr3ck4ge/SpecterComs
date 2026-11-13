import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// L3: two-factor authentication, pure helpers (no DB) so the contract tests
// can exercise them. TOTP is RFC 6238 over HMAC-SHA1, 30 s steps, 6 digits,
// accepting the previous / current / next step (clock drift), implemented on
// node:crypto: no new dependency.

export type SubjectType = 'user' | 'admin';
export interface Subject { type: SubjectType; id: string }

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;
export const CHALLENGE_TTL_SECONDS = 300;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const ACCOUNT_MAX_ATTEMPTS_PER_HOUR = 20;
export const ISSUER = 'SpecterComs';

/** Stable machine codes the clients key on. */
export const TWO_FACTOR_REQUIRED = 'TWO_FACTOR_REQUIRED';           // privileged action, not enrolled
export const TWO_FACTOR_CODE_REQUIRED = 'TWO_FACTOR_CODE_REQUIRED'; // re-auth: send a code too
export const TWO_FACTOR_INVALID = 'TWO_FACTOR_INVALID';

/** Server switch, read at call time. Default off (flipped after owners have had notice). */
export function requireTwoFactorForPrivileged(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.REQUIRE_2FA_FOR_PRIVILEGED ?? '').trim());
}

// ---- Base32 (RFC 4648, no padding) -----------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret (RFC 4226 recommendation), base32. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

// ---- HOTP / TOTP ------------------------------------------------------------

export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS, algo: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algo, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

export function totp(secretB32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretB32), timeStep(nowMs));
}

/** Accepts "123 456" / "123-456". Returns the 6 digits or null. */
export function normalizeTotpCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(c) ? c : null;
}

const safeEq = (a: string, b: string) => {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/**
 * Checks a code against steps now-1..now+1 that are strictly AFTER
 * lastUsedStep (a step already used, or an earlier one, is a replay).
 * Returns the matched step, or null.
 */
export function matchTotp(secretB32: string, code: unknown, lastUsedStep: number | string | null | undefined, nowMs = Date.now()): number | null {
  const c = normalizeTotpCode(code);
  if (!c) return null;
  const key = base32Decode(secretB32);
  const now = timeStep(nowMs);
  const floor = lastUsedStep === null || lastUsedStep === undefined ? -Infinity : Number(lastUsedStep);
  let matched: number | null = null;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    // Compare every candidate (no early exit) to keep timing flat.
    if (safeEq(hotp(key, s), c) && s > floor && matched === null) matched = s;
  }
  return matched;
}

export function otpauthUri(secretB32: string, accountLabel: string, issuer = ISSUER): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const q = new URLSearchParams({
    secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ---- Keys derived from existing secrets (no new env var) ---------------------

function encryptionMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env.EMAIL_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('EMAIL_ENCRYPTION_KEY must be set to a 64-char hex string (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

const derive = (master: Buffer, info: string) =>
  Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(info), 32));

const subjectAad = (s: Subject) => Buffer.from(`specter/2fa/${s.type}/${s.id}`);

/** AES-256-GCM, key = HKDF(EMAIL_ENCRYPTION_KEY), bound to the subject via AAD. */
export function encryptTotpSecret(secretB32: string, subject: Subject, env: NodeJS.ProcessEnv = process.env): string {
  const key = derive(encryptionMasterKey(env), 'specter/totp-secret/v1');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(subjectAad(subject));
  const ct = Buffer.concat([cipher.update(secretB32, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}

export function decryptTotpSecret(stored: string, subject: Subject, env: NodeJS.ProcessEnv = process.env): string {
  const [v, ivH, tagH, ctH] = stored.split(':');
  if (v !== 'v1' || !ivH || !tagH || ctH === undefined) throw new Error('Invalid 2FA secret format');
  const key = derive(encryptionMasterKey(env), 'specter/totp-secret/v1');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivH, 'hex'));
  d.setAAD(subjectAad(subject));
  d.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([d.update(Buffer.from(ctH, 'hex')), d.final()]).toString('utf8');
}

// ---- Recovery codes ----------------------------------------------------------

// No 0/O/1/I: easy to read off paper. 32 symbols -> 5 bits each, 12 = 60 bits.
const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = crypto.randomBytes(12);
    const raw = Array.from(bytes, (b) => RC_ALPHABET[b & 31]).join('');
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 12 && [...c].every((ch) => RC_ALPHABET.includes(ch)) ? c : null;
}

/** Keyed hash: a dumped table is useless without EMAIL_ENCRYPTION_KEY. */
export function hashRecoveryCode(normalized: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = derive(encryptionMasterKey(env), 'specter/2fa-recovery/v1');
  return crypto.createHmac('sha256', key).update(normalized).digest('hex');
}

// ---- Login challenge ---------------------------------------------------------
// Signed with a key DERIVED from JWT_SECRET (domain-separated), so a challenge
// can never pass authenticateToken as an access token and vice versa.

function challengeKey(jwtSecret: string): Buffer {
  return crypto.createHmac('sha256', jwtSecret).update('specter/2fa-challenge/v1').digest();
}

export interface ChallengeClaims { st: SubjectType; sub: string; jti: string; hw?: string; exp?: number }

export function signChallenge(subject: Subject, jwtSecret: string, extra: { hwid?: string | null } = {}, ttlSeconds = CHALLENGE_TTL_SECONDS): { challenge: string; jti: string } {
  const jti = crypto.randomBytes(16).toString('hex');
  const payload: Record<string, unknown> = { st: subject.type, jti };
  if (extra.hwid) payload.hw = extra.hwid;
  const challenge = jwt.sign(payload, challengeKey(jwtSecret), {
    algorithm: 'HS256', subject: subject.id, audience: 'specter-2fa', expiresIn: ttlSeconds,
  });
  return { challenge, jti };
}

/** Claims of a valid, unexpired challenge for the expected subject type, else null. */
export function verifyChallenge(challenge: unknown, jwtSecret: string, expectedType: SubjectType): ChallengeClaims | null {
  if (typeof challenge !== 'string' || challenge.length > 2048) return null;
  try {
    const c = jwt.verify(challenge, challengeKey(jwtSecret), { algorithms: ['HS256'], audience: 'specter-2fa' }) as any;
    if (c?.st !== expectedType || typeof c.sub !== 'string' || typeof c.jti !== 'string') return null;
    return { st: c.st, sub: c.sub, jti: c.jti, hw: typeof c.hw === 'string' ? c.hw : undefined, exp: c.exp };
  } catch {
    return null;
  }
}

/** One-shot challenge ids: a challenge that already issued tokens can't again. */
export function createUsedChallengeSet() {
  const used = new Map<string, number>(); // jti -> exp (ms)
  return {
    has(jti: string, now = Date.now()) {
      const exp = used.get(jti);
      return exp !== undefined && exp > now;
    },
    add(jti: string, expSeconds: number | undefined, now = Date.now()) {
      used.set(jti, expSeconds ? expSeconds * 1000 : now + CHALLENGE_TTL_SECONDS * 1000);
      if (used.size > 5000) for (const [k, v] of used) if (v <= now) used.delete(k);
    },
  };
}
