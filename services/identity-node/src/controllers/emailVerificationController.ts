import { Request, Response } from 'express';
import argon2 from 'argon2';
import crypto from 'crypto';
import { pool } from '../config/db.js';
import { encryptEmail, decryptEmail } from '../utils/encryption.js';
import { sendVerificationEmail, sendEmailChangeNotice, isMailerConfigured } from '../utils/emailService.js';
import { newVerifyToken, hashVerifyToken, tokenIsValid, resendWaitMs, isBlockedUnverified } from '../utils/emailVerification.js';
import type { AuthRequest } from '../middleware/authMiddleware.js';
import { checkSecondFactor } from './twoFactorController.js';

const hashEmail = (email: string): string =>
  crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');

/**
 * Stores a fresh hashed token for the user and mails the link to `toEmail`.
 * Returns whether the mail went out; never throws on mail problems so callers
 * (signup especially) are unaffected by a missing/broken mailer.
 */
export async function issueVerification(userId: string, toEmail: string): Promise<boolean> {
  try {
    const { token, hash, expires } = newVerifyToken();
    await pool.query(
      `UPDATE users SET email_verify_token_hash = $1, email_verify_expires = $2, email_verify_sent_at = NOW()
       WHERE id = $3`,
      [hash, expires, userId]
    );
    return await sendVerificationEmail(toEmail, token);
  } catch (err) {
    console.warn('[email-verify] issue failed:', (err as Error)?.message);
    return false;
  }
}

// GET /auth/verify-email?token=...  Redirects to the web page, which POSTs the
// token. A GET never consumes it, so mail-scanner link prefetch can't burn it.
export const verifyEmailRedirect = (req: Request, res: Response) => {
  const frontendUrl = process.env.FRONTEND_URL || 'https://spectercoms.net';
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  res.redirect(302, `${frontendUrl}/verify-email?token=${encodeURIComponent(token)}`);
};

// POST /auth/verify-email { token }
export const verifyEmail = async (req: Request, res: Response) => {
  const { token } = req.body as { token: string };
  const invalid = () => res.status(400).json({ message: 'Verification link is invalid or has expired.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE serialises concurrent uses of one link: the loser sees the
    // cleared token and fails (single use).
    const found = await client.query(
      `SELECT id, email_verify_token_hash, email_verify_expires, pending_email_hash, pending_email_encrypted
       FROM users WHERE email_verify_token_hash = $1 FOR UPDATE`,
      [hashVerifyToken(token)]
    );
    const row = found.rows[0];
    if (!tokenIsValid(row, token)) {
      await client.query('ROLLBACK');
      return invalid();
    }
    if (row.pending_email_hash) {
      const clash = await client.query('SELECT 1 FROM users WHERE email_hash = $1 AND id <> $2', [row.pending_email_hash, row.id]);
      if (clash.rows.length > 0) {
        await client.query(
          `UPDATE users SET pending_email_hash = NULL, pending_email_encrypted = NULL,
                  email_verify_token_hash = NULL, email_verify_expires = NULL WHERE id = $1`, [row.id]);
        await client.query('COMMIT');
        return res.status(409).json({ message: 'That email address is already in use.' });
      }
      await client.query(
        `UPDATE users SET email_hash = pending_email_hash, email_encrypted = pending_email_encrypted,
                pending_email_hash = NULL, pending_email_encrypted = NULL,
                email_verified_at = NOW(), email_verify_token_hash = NULL, email_verify_expires = NULL
         WHERE id = $1`, [row.id]);
    } else {
      await client.query(
        `UPDATE users SET email_verified_at = NOW(), email_verify_token_hash = NULL, email_verify_expires = NULL
         WHERE id = $1`, [row.id]);
    }
    await client.query('COMMIT');
    res.json({ message: 'Email verified.', email_verified: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Verify email error:', err);
    res.status(500).json({ message: 'Internal server error' });
  } finally {
    client.release();
  }
};

// POST /auth/resend-verification (authenticated)
export const resendVerification = async (req: AuthRequest, res: Response) => {
  try {
    const r = await pool.query(
      `SELECT email_verified_at, email_verify_sent_at, email_encrypted, pending_email_encrypted FROM users WHERE id = $1`,
      [req.user!.id]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ message: 'User not found' });
    if (u.email_verified_at && !u.pending_email_encrypted) {
      return res.json({ message: 'Email already verified.', already_verified: true });
    }
    const wait = resendWaitMs(u.email_verify_sent_at);
    if (wait > 0) {
      const secs = Math.ceil(wait / 1000);
      res.setHeader('Retry-After', String(secs));
      return res.status(429).json({ message: `Please wait ${secs}s before requesting another email.`, retry_after: secs });
    }
    const target = u.pending_email_encrypted || u.email_encrypted;
    if (!isMailerConfigured() || !target) {
      return res.status(503).json({ message: 'Email delivery is not available right now. Try again later.' });
    }
    const sent = await issueVerification(req.user!.id, decryptEmail(target));
    if (!sent) return res.status(503).json({ message: 'Email delivery is not available right now. Try again later.' });
    res.json({ message: 'Verification email sent.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /users/email { email, password } (authenticated). The new address is
// stored as PENDING and only replaces the current one when its link is used.
export const requestEmailChange = async (req: AuthRequest, res: Response) => {
  const { email, password } = req.body as { email: string; password: string };
  try {
    if (!isMailerConfigured()) {
      return res.status(503).json({ message: 'Email delivery is not available right now. Try again later.' });
    }
    const r = await pool.query(
      `SELECT password_hash, email_hash, email_encrypted, email_verify_sent_at FROM users WHERE id = $1`,
      [req.user!.id]
    );
    const u = r.rows[0];
    if (!u) return res.status(404).json({ message: 'User not found' });
    if (!(await argon2.verify(u.password_hash, password))) {
      return res.status(403).json({ message: 'Password is incorrect.' });
    }
    // L3: with 2FA on, changing the email also needs a code (answers 401/429 itself).
    if (!(await checkSecondFactor({ type: 'user', id: String(req.user!.id) }, req.body, res))) return;
    const newHash = hashEmail(email);
    if (newHash === u.email_hash) return res.status(400).json({ message: 'That is already your email address.' });
    const wait = resendWaitMs(u.email_verify_sent_at);
    if (wait > 0) return res.status(429).json({ message: 'Please wait a minute before changing your email again.', retry_after: Math.ceil(wait / 1000) });
    const clash = await pool.query('SELECT 1 FROM users WHERE email_hash = $1 AND id <> $2', [newHash, req.user!.id]);
    if (clash.rows.length > 0) return res.status(409).json({ message: 'That email address cannot be used.' });

    await pool.query(
      'UPDATE users SET pending_email_hash = $1, pending_email_encrypted = $2 WHERE id = $3',
      [newHash, encryptEmail(email), req.user!.id]
    );
    const sent = await issueVerification(req.user!.id, email.toLowerCase().trim());
    if (!sent) {
      await pool.query('UPDATE users SET pending_email_hash = NULL, pending_email_encrypted = NULL WHERE id = $1', [req.user!.id]);
      return res.status(503).json({ message: 'Email delivery is not available right now. Try again later.' });
    }
    if (u.email_encrypted) void sendEmailChangeNotice(decryptEmail(u.email_encrypted));
    res.json({ message: 'Check your new inbox for a verification link. Your email changes once it is verified.' });
  } catch (err) {
    console.error('Request email change error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Same answer whether or not the account exists / the password matched /
// the cooldown applies, so this can't be used to enumerate accounts.
export const PUBLIC_RESEND_MESSAGE = 'If those details match an account awaiting verification, a new email has been sent.';
let dummyHash: Promise<string> | null = null;

// POST /auth/resend-verification-public { callsign | email, password } (no session)
export const resendVerificationPublic = async (req: Request, res: Response) => {
  const { callsign, email, password } = req.body as { callsign?: string; email?: string; password: string };
  const generic = () => res.json({ message: PUBLIC_RESEND_MESSAGE });
  try {
    const r = callsign
      ? await pool.query(
          `SELECT id, password_hash, email_verified_at, email_verification_required, email_verify_sent_at, email_encrypted, pending_email_encrypted
           FROM users WHERE lower(callsign) = lower($1)`, [callsign])
      : await pool.query(
          `SELECT id, password_hash, email_verified_at, email_verification_required, email_verify_sent_at, email_encrypted, pending_email_encrypted
           FROM users WHERE email_hash = $1`, [hashEmail(email as string)]);
    const u = r.rows[0];
    // Burn comparable CPU for unknown accounts so timing doesn't leak existence.
    if (!u || !u.password_hash) {
      dummyHash ??= argon2.hash('specter-dummy-password');
      await argon2.verify(await dummyHash, password).catch(() => false);
      return generic();
    }
    if (!(await argon2.verify(u.password_hash, password))) return generic();
    if (!isBlockedUnverified(u) || !u.email_encrypted) return generic();
    if (resendWaitMs(u.email_verify_sent_at) > 0 || !isMailerConfigured()) return generic();
    await issueVerification(u.id, decryptEmail(u.pending_email_encrypted || u.email_encrypted));
    return generic();
  } catch (err) {
    console.error('Public resend verification error:', err);
    return generic();
  }
};
