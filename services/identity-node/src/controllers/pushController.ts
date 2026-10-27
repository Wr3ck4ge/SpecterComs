import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

/**
 * POST /admin/push/register
 * Body: { fcm_token: string, device_label?: string }
 * Called by the SpecterAdmin module on login/token-refresh. Upserts on
 * fcm_token so a reinstalled app (fresh token, same physical device) doesn't
 * accumulate dead duplicate rows.
 */
export const registerPushToken = async (req: AuthRequest, res: Response) => {
  const adminId = req.user?.id;
  const { fcm_token, device_label } = req.body as { fcm_token?: string; device_label?: string };

  if (!adminId) return res.status(401).json({ message: 'Unauthorized' });
  if (!fcm_token || typeof fcm_token !== 'string') {
    return res.status(400).json({ message: 'fcm_token is required' });
  }

  try {
    await pool.query(
      `INSERT INTO admin_push_tokens (admin_id, fcm_token, device_label)
       VALUES ($1, $2, $3)
       ON CONFLICT (fcm_token) DO UPDATE SET
         admin_id     = EXCLUDED.admin_id,
         device_label = EXCLUDED.device_label,
         last_seen_at = NOW()`,
      [adminId, fcm_token, device_label ?? null]
    );
    console.log(`[push] token registered for admin ${adminId} (${device_label ?? 'no label'})`);
    res.json({ message: 'Push token registered.' });
  } catch (err) {
    console.error('Register push token error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * DELETE /admin/push/register
 * Body: { fcm_token: string }
 * Called on logout so a signed-out device stops receiving alerts for an
 * account it's no longer authenticated as.
 */
export const unregisterPushToken = async (req: AuthRequest, res: Response) => {
  const { fcm_token } = req.body as { fcm_token?: string };
  if (!fcm_token || typeof fcm_token !== 'string') {
    return res.status(400).json({ message: 'fcm_token is required' });
  }

  try {
    await pool.query(`DELETE FROM admin_push_tokens WHERE fcm_token = $1`, [fcm_token]);
    res.json({ message: 'Push token unregistered.' });
  } catch (err) {
    console.error('Unregister push token error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
