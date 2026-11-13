import { describe, it, expect, vi } from 'vitest';
import {
  newVerifyToken, hashVerifyToken, tokenIsValid, resendWaitMs,
  VERIFY_TOKEN_TTL_MS, RESEND_COOLDOWN_MS,
} from '../../src/utils/emailVerification.js';
import { createRateLimiter } from '../../src/middleware/rateLimit.js';
import { sendVerificationEmail, isMailerConfigured } from '../../src/utils/emailService.js';

describe('verification tokens', () => {
  it('stores only a hash and expires in 24h', () => {
    const now = 1_000_000;
    const t = newVerifyToken(now);
    expect(t.token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.hash).toBe(hashVerifyToken(t.token));
    expect(t.hash).not.toBe(t.token);
    expect(t.expires.getTime()).toBe(now + VERIFY_TOKEN_TTL_MS);
    expect(VERIFY_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('accepts a valid token, rejects expiry, wrong token and a consumed (cleared) row', () => {
    const now = 5_000_000;
    const t = newVerifyToken(now);
    const row = { email_verify_token_hash: t.hash, email_verify_expires: t.expires };
    expect(tokenIsValid(row, t.token, now + 1000)).toBe(true);
    expect(tokenIsValid(row, t.token, now + VERIFY_TOKEN_TTL_MS + 1)).toBe(false); // expired
    expect(tokenIsValid(row, newVerifyToken().token, now)).toBe(false);            // wrong token
    // Single use: consuming clears both columns, so the same link fails after.
    expect(tokenIsValid({ email_verify_token_hash: null, email_verify_expires: null }, t.token, now)).toBe(false);
    expect(tokenIsValid(undefined, t.token, now)).toBe(false);
  });
});

describe('resend cooldown and rate limit', () => {
  it('enforces the per-account cooldown', () => {
    const sent = new Date(10_000);
    expect(resendWaitMs(null, 10_000)).toBe(0);
    expect(resendWaitMs(sent, 10_000 + 1000)).toBe(RESEND_COOLDOWN_MS - 1000);
    expect(resendWaitMs(sent, 10_000 + RESEND_COOLDOWN_MS)).toBe(0);
  });

  it('IP limiter blocks the request after max hits', () => {
    const limiter = createRateLimiter(60_000, 2, 'slow down');
    const next = vi.fn();
    const mkRes = () => {
      const res: any = { statusCode: 200, body: null };
      res.status = (c: number) => { res.statusCode = c; return res; };
      res.json = (b: unknown) => { res.body = b; return res; };
      return res;
    };
    const req: any = { ip: '203.0.113.9' };
    limiter(req, mkRes(), next);
    limiter(req, mkRes(), next);
    const blocked = mkRes();
    limiter(req, blocked, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(blocked.statusCode).toBe(429);
  });
});

describe('mailer not configured', () => {
  it('fails gracefully without throwing', async () => {
    const prev = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isMailerConfigured()).toBe(false);
    await expect(sendVerificationEmail('a@example.com', 'x'.repeat(64))).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    if (prev !== undefined) process.env.SMTP_HOST = prev;
  });
});
