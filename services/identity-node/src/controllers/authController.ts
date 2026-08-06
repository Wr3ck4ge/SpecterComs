import { Request, Response } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pool } from '../config/db.js';
import { RegisterInput, LoginInput } from '../utils/validation.js';
import { publishEvent } from '../config/nats.js';
import { encryptEmail, decryptEmail } from '../utils/encryption.js';
import { sendPasswordResetEmail } from '../utils/emailService.js';
import { getJwtSecret } from '../config/jwtSecret.js';

// Read latest client version from the updates directory (written by release workflow)
function getLatestClientVersion(): string | null {
  try {
    const versionFile = process.env.LATEST_VERSION_FILE || '/updates/LATEST_VERSION';
    return fs.readFileSync(versionFile, 'utf-8').trim() || null;
  } catch { return null; }
}

// Helper to hash email deterministically for lookup
const hashEmail = (email: string): string => {
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
};

// Reset tokens are 256 bits of crypto.randomBytes entropy, not a low-entropy
// user-chosen secret — a plain SHA-256 over the raw token is enough to keep
// the stored value useless to anyone who reads the row directly (DB dump,
// backup, admin query), while the raw token only ever exists in the emailed
// link and the requester's browser.
const hashResetToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

// Same reasoning as hashResetToken — refresh tokens are 256 bits of
// crypto.randomBytes entropy, so a plain SHA-256 is enough to keep the stored
// value useless if the refresh_tokens table is ever dumped.
const hashRefreshToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const ACCESS_TOKEN_TTL = '30m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Issues a short-lived access JWT (unchanged shape/claims from before) plus a
// long-lived, revocable refresh token row. Called on register/login and again
// on every successful /auth/refresh (rotation).
async function issueTokenPair(userId: string, callsign: string): Promise<{ accessToken: string; refreshToken: string; refreshTokenId: string }> {
  const accessToken = jwt.sign({ id: userId, callsign }, getJwtSecret(), { expiresIn: ACCESS_TOKEN_TTL });

  const refreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const inserted = await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
    [userId, hashRefreshToken(refreshToken), expiresAt]
  );

  return { accessToken, refreshToken, refreshTokenId: inserted.rows[0].id };
}

export const register = async (req: Request, res: Response) => {
  const { callsign, email, password, global_tag, hwid, timezone } = req.body as RegisterInput;

  try {
    const emailHash = hashEmail(email);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check HWID Ban
      if (hwid) {
        const banCheck = await client.query('SELECT reason FROM hardware_bans WHERE hwid = $1', [hwid]);
        if (banCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(403).json({ message: 'Device is banned from the network', reason: banCheck.rows[0].reason });
        }
      }

      // Check if user exists
      const existingUser = await client.query(
        'SELECT id FROM users WHERE callsign = $1 OR email_hash = $2',
        [callsign, emailHash]
      );

      if (existingUser.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'User already exists' });
      }

      // Hashing is deliberately expensive (that's the point of argon2) — do it
      // only once we know this isn't a duplicate-registration probe, so a
      // flood of already-taken callsigns/emails can't be used to cheaply
      // amplify CPU cost against this rate-limited endpoint.
      const passwordHash = await argon2.hash(password);

      // Create User — store email_hash for lookup and email_encrypted for password reset
      const emailEncrypted = encryptEmail(email);
      const newUser = await client.query(
        `INSERT INTO users (callsign, email_hash, email_encrypted, password_hash, global_tag, hwid, timezone)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, callsign, global_tag, timezone, created_at`,
        [callsign, emailHash, emailEncrypted, passwordHash, global_tag || null, hwid || null, timezone || null]
      );

      await client.query('COMMIT');

      const user = newUser.rows[0];
      const { accessToken, refreshToken } = await issueTokenPair(user.id, user.callsign);

      res.status(201).json({
        message: 'User registered successfully',
        token: accessToken,
        refresh_token: refreshToken,
        user: { id: user.id, callsign: user.callsign, global_tag: user.global_tag, timezone: user.timezone }
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

export const login = async (req: Request, res: Response) => {
  const { callsign, email, password, hwid } = req.body as LoginInput;

  try {
    // Check HWID Ban Before DB lookup
    if (hwid) {
      const banCheck = await pool.query('SELECT reason FROM hardware_bans WHERE hwid = $1', [hwid]);
      if (banCheck.rows.length > 0) {
        return res.status(403).json({ message: 'Device is banned from the network', reason: banCheck.rows[0].reason });
      }
    }

    let queryText = 'SELECT id, callsign, password_hash, global_tag, profile_image_path, timezone, subscription_tier FROM users WHERE ';
    let queryParams: any[] = [];

    if (callsign) {
      queryText += 'callsign = $1';
      queryParams = [callsign];
    } else if (email) {
      queryText += 'email_hash = $1';
      queryParams = [hashEmail(email)];
    } else {
      return res.status(400).json({ message: 'Callsign or Email required' });
    }

    const result = await pool.query(queryText, queryParams);

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await argon2.verify(user.password_hash, password);

    if (!validPassword) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Update HWID if provided
    if (hwid) {
      await pool.query('UPDATE users SET hwid = $1 WHERE id = $2', [hwid, user.id]);
    }

    const { accessToken, refreshToken } = await issueTokenPair(user.id, user.callsign);

    // Publish NATS event
    try {
        await publishEvent('specter.user.login', { user_id: user.id, callsign: user.callsign });
    } catch (natsErr) {
        console.error('Failed to notify NATS of login', natsErr);
    }

    res.json({
      message: 'Login successful',
      token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: user.id,
        callsign: user.callsign,
        global_tag: user.global_tag,
        timezone: user.timezone,
        subscription_tier: user.subscription_tier,
        profile_image_path: user.profile_image_path,
        avatar_url: user.profile_image_path ? `/uploads/${user.profile_image_path}` : null,
      },
      latest_version: getLatestClientVersion(),
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /auth/forgot-password
export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };

  // Always return the same response to prevent user enumeration
  const genericResponse = () =>
    res.json({ message: 'If an account with that email exists and supports reset, a link has been sent.' });

  try {
    const emailHash = hashEmail(email);
    const result = await pool.query(
      'SELECT id, email_encrypted FROM users WHERE email_hash = $1',
      [emailHash]
    );

    if (result.rows.length === 0 || !result.rows[0].email_encrypted) {
      return genericResponse();
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'UPDATE users SET password_reset_token = $1, password_reset_token_expires = $2 WHERE id = $3',
      [hashResetToken(resetToken), expires, user.id]
    );

    const actualEmail = decryptEmail(user.email_encrypted);
    await sendPasswordResetEmail(actualEmail, resetToken);

    return genericResponse();
  } catch (error) {
    console.error('Forgot password error:', error);
    // Still return generic response — do not leak errors
    return genericResponse();
  }
};

// POST /auth/reset-password
export const resetPassword = async (req: Request, res: Response) => {
  const { token, password } = req.body as { token: string; password: string };

  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE password_reset_token = $1 AND password_reset_token_expires > NOW()',
      [hashResetToken(token)]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Reset token is invalid or has expired.' });
    }

    const newHash = await argon2.hash(password);

    await pool.query(
      'UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_token_expires = NULL WHERE id = $2',
      [newHash, result.rows[0].id]
    );

    res.json({ message: 'Password reset successfully. You may now log in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /auth/refresh — trades a valid refresh token for a new access token,
// rotating the refresh token in the same call (old one revoked, replaced_by
// set to the new row). A client should never need to prompt for a password
// again as long as it keeps redeeming the refresh token before it goes stale.
export const refresh = async (req: Request, res: Response) => {
  const { refresh_token } = req.body as { refresh_token: string };
  const tokenHash = hashRefreshToken(refresh_token);

  try {
    const result = await pool.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.replaced_by, u.callsign
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    const row = result.rows[0];

    // A revoked-and-rotated token being redeemed again means either two
    // clients raced on the same rotation (harmless) or the token leaked and
    // both the legitimate holder and an attacker are using it (not harmless).
    // Can't distinguish those cases from a single presentation, so treat it as
    // theft: kill every refresh token this user has, forcing a real re-login
    // everywhere rather than silently trusting a token that's already been
    // superseded once.
    if (row.revoked_at) {
      if (row.replaced_by) {
        await pool.query(
          'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
          [row.user_id]
        );
      }
      return res.status(401).json({ message: 'Refresh token has already been used' });
    }

    if (new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ message: 'Refresh token expired' });
    }

    const { accessToken, refreshToken, refreshTokenId } = await issueTokenPair(row.user_id, row.callsign);

    // Mark the presented token as rotated away, chained to the new row.
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $1 WHERE id = $2',
      [refreshTokenId, row.id]
    );

    res.json({ token: accessToken, refresh_token: refreshToken });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// POST /auth/logout — revokes one refresh token (the device logging out).
// Best-effort from the client's perspective (logout proceeds locally either
// way), but this is what actually invalidates the long-lived credential
// instead of just discarding the client's local copy of it.
export const logout = async (req: Request, res: Response) => {
  const { refresh_token } = req.body as { refresh_token?: string };
  if (!refresh_token) return res.json({ message: 'Logged out' });

  try {
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashRefreshToken(refresh_token)]
    );
    res.json({ message: 'Logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    // Still succeed — the client clears its local session regardless.
    res.json({ message: 'Logged out' });
  }
};
