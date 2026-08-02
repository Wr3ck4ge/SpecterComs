import { Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

const registerDeviceSchema = z.object({
  device_id: z.string().uuid(),
  key_package: z.string().max(20000), // base64-encoded MLS KeyPackage bytes
  credential: z.string().max(2000),   // base64-encoded MLS Credential bytes
});

/**
 * POST /devices
 * Registers (or re-registers, replacing the stored KeyPackage) this
 * device's current MLS KeyPackage — called once on first run, and again
 * whenever a fresh KeyPackage is generated to replenish one consumed by an
 * add. An MLS "member" is one device, not one user account (see
 * mls-crypto's generate_identity) — a user with several logged-in devices
 * has a row here for each.
 */
export const registerDevice = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = registerDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }
  const { device_id, key_package, credential } = parsed.data;

  // The credential is a BasicCredential — MLS's own protocol only checks
  // that a leaf's messages are signed by that leaf's key, never that the
  // credential's *content* is honest. Membership reconciliation elsewhere
  // (mlsSession.js's ensureChannelGroup) parses that content as
  // "userId:deviceId" to know which account a group member belongs to, so
  // without this check a client could self-assert *someone else's* userId
  // in its credential — not to impersonate them cryptographically (the
  // server-authoritative user_devices.user_id below can't be spoofed), but
  // to make every other client's reconciliation logic believe that other
  // user is "already represented" in the group and silently never add
  // their real device.
  let decodedCredential: string;
  try {
    decodedCredential = Buffer.from(credential, 'base64').toString('utf8');
  } catch {
    return res.status(400).json({ message: 'credential is not valid base64' });
  }
  if (decodedCredential !== `${userId}:${device_id}`) {
    return res.status(400).json({ message: 'credential must match this account and device_id exactly' });
  }

  try {
    // WHERE user_devices.user_id = $2 on the conflict update means a
    // device_id collision belonging to a *different* user's row (shouldn't
    // happen with a fresh client-generated UUID, but this is the boundary
    // that matters) silently leaves that row untouched rather than
    // overwriting someone else's device registration.
    await pool.query(
      `INSERT INTO user_devices (id, user_id, key_package, credential, last_seen_at, revoked_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, NULL)
       ON CONFLICT (id) DO UPDATE SET
         key_package = EXCLUDED.key_package,
         credential = EXCLUDED.credential,
         last_seen_at = CURRENT_TIMESTAMP,
         revoked_at = NULL
       WHERE user_devices.user_id = $2`,
      [device_id, userId, Buffer.from(key_package, 'base64'), Buffer.from(credential, 'base64')],
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('registerDevice error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /devices/:userId/key-packages
 * Every active (non-revoked) device's current KeyPackage for the given
 * user — needed before adding them to an MLS group, since a user with N
 * devices needs all N added as separate leaves. KeyPackages are public key
 * material by design (the same trust model as a Signal prekey bundle), so
 * this has no extra membership gate beyond being authenticated — the real
 * security boundary is which groups a device actually ends up added to,
 * enforced at the group-commit step, not at key-package lookup.
 */
export const getUserDeviceKeyPackages = async (req: AuthRequest, res: Response) => {
  const requesterId = req.user?.id;
  const { userId } = req.params;
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const result = await pool.query(
      `SELECT id, key_package FROM user_devices
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY created_at ASC`,
      [userId],
    );
    res.json({
      devices: result.rows.map(row => ({
        device_id: row.id,
        key_package: (row.key_package as Buffer).toString('base64'),
      })),
    });
  } catch (err) {
    console.error('getUserDeviceKeyPackages error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
