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
      const token = jwt.sign({ id: user.id, callsign: user.callsign }, getJwtSecret(), { expiresIn: '24h' });

      res.status(201).json({
        message: 'User registered successfully',
        token,
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

    const token = jwt.sign({ id: user.id, callsign: user.callsign }, getJwtSecret(), { expiresIn: '24h' });
    
    // Publish NATS event
    try {
        await publishEvent('specter.user.login', { user_id: user.id, callsign: user.callsign });
    } catch (natsErr) {
        console.error('Failed to notify NATS of login', natsErr);
    }

    res.json({
      message: 'Login successful',
      token,
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
      [resetToken, expires, user.id]
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
      [token]
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
