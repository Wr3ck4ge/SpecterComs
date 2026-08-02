import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_BASE = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const INTRO_SOUNDS_DIR = path.join(UPLOADS_BASE, 'intro-sounds');
const AVATARS_DIR = path.join(UPLOADS_BASE, 'avatars');
fs.mkdirSync(INTRO_SOUNDS_DIR, { recursive: true });
fs.mkdirSync(AVATARS_DIR, { recursive: true });

// ── Avatar upload multer config ───────────────────────────────────────────────
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  filename: (req, file, cb) => {
    const userId = (req as AuthRequest).user?.id ?? 'unknown';
    const ext = file.mimetype === 'image/png' ? 'png'
      : file.mimetype === 'image/gif' ? 'gif'
      : file.mimetype === 'image/webp' ? 'webp'
      : 'jpg';
    cb(null, `${userId}.${ext}`);
  },
});

const imageFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed (jpg, png, gif, webp)'));
  }
};

export const avatarUpload = multer({
  storage: avatarStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

const introSoundStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, INTRO_SOUNDS_DIR),
  filename: (req, _file, cb) => {
    const userId = (req as AuthRequest).user?.id ?? 'unknown';
    cb(null, `${userId}.mp3`);
  },
});

const introSoundFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const allowed = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/webm'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only audio files are allowed (mp3, wav, ogg, webm)'));
  }
};

export const introSoundUpload = multer({
  storage: introSoundStorage,
  fileFilter: introSoundFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

export const getMyProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const result = await pool.query(
      'SELECT id, callsign, global_tag, timezone, profile_image_path, intro_sound_path, subscription_tier FROM users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ message: 'User not found' });
      return;
    }
    const row = result.rows[0];
    res.json({
      user: {
        ...row,
        avatar_url: row.profile_image_path ? `/uploads/${row.profile_image_path}` : null,
      },
    });
  } catch (err) {
    console.error('getMyProfile error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Games a user has selected on their profile — gates per-game settings
// modules (e.g. the Hangar tab) separately from events.game, which just
// tags a single event.
const SUPPORTED_GAMES = new Set(['star_citizen']);

export const getMyGames = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const result = await pool.query('SELECT game FROM user_games WHERE user_id = $1', [userId]);
    res.json({ games: result.rows.map(r => r.game) });
  } catch (err) {
    console.error('getMyGames error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updateMyGames = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const games: unknown = req.body?.games;
  if (!Array.isArray(games)) {
    res.status(400).json({ message: 'games must be an array' });
    return;
  }
  const validGames = [...new Set(games.filter(g => SUPPORTED_GAMES.has(g)))];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_games WHERE user_id = $1', [userId]);
    for (const game of validGames) {
      await client.query('INSERT INTO user_games (user_id, game) VALUES ($1, $2)', [userId, game]);
    }
    await client.query('COMMIT');
    res.json({ games: validGames });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('updateMyGames error:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};

export const updateProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user!.id;
  const { timezone, profile_image_path, intro_sound_path } = req.body;

  const updates: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || timezone.length === 0 || timezone.length > 64) {
      res.status(400).json({ message: 'Invalid timezone value' });
      return;
    }
    updates.push(`timezone = $${idx++}`);
    values.push(timezone);
  }

  if (profile_image_path !== undefined) {
    if (typeof profile_image_path !== 'string' || profile_image_path.length > 512) {
      res.status(400).json({ message: 'Invalid profile image path' });
      return;
    }
    updates.push(`profile_image_path = $${idx++}`);
    values.push(profile_image_path || null);
  }

  if (intro_sound_path !== undefined) {
    if (intro_sound_path !== null && (typeof intro_sound_path !== 'string' || intro_sound_path.length > 512)) {
      res.status(400).json({ message: 'Invalid intro sound path' });
      return;
    }
    // Setting a real path is gated the same as the dedicated /intro-sound
    // upload route — this generic profile endpoint let any tier set it
    // directly, bypassing that check entirely. Clearing it (null) stays free.
    if (intro_sound_path) {
      const tierRes = await pool.query('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
      if (!tierRes.rows.length || tierRes.rows[0].subscription_tier < 1) {
        res.status(403).json({ message: 'Premium subscription required to set an intro sound' });
        return;
      }
    }
    updates.push(`intro_sound_path = $${idx++}`);
    values.push(intro_sound_path || null);
  }

  if (updates.length === 0) {
    res.status(400).json({ message: 'No fields to update' });
    return;
  }

  updates.push(`updated_at = NOW()`);
  values.push(userId);

  try {
    const result = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, callsign, global_tag, timezone, profile_image_path, intro_sound_path, subscription_tier`,
      values
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('updateProfile error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const searchUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  const q = (req.query.q as string || '').trim();
  if (!q || q.length < 2) {
    res.status(400).json({ message: 'Query too short' });
    return;
  }
  try {
    const result = await pool.query(
      `SELECT id, callsign, global_tag
       FROM users
       WHERE callsign ILIKE $1
       LIMIT 20`,
      [`${q}%`]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Search users error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const updatePresence = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user.id;
    const { status, gameActivity } = req.body;
    let presenceStatus = 0;
    if (status === 'Away') presenceStatus = 1;
    if (status === 'Busy') presenceStatus = 2;
    if (status === 'Invisible') presenceStatus = 3;
    
    await pool.query(
      'UPDATE users SET presence_status = $1, game_activity = $2 WHERE id = $3',
      [presenceStatus, gameActivity || '', userId]
    );
    
    await publishEvent(
      'UserPresenceUpdated',
      { userId, status, gameActivity }
    );
    
    res.status(200).json({ message: 'Presence updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ── POST /users/intro-sound  (premium users only) ────────────────────────────
export const uploadIntroSound = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  // Verify premium tier
  const tierRes = await pool.query('SELECT subscription_tier FROM users WHERE id = $1', [userId]);
  if (!tierRes.rows.length || tierRes.rows[0].subscription_tier < 1) {
    // Delete the uploaded file if present so it doesn't linger
    if ((req as any).file?.path) {
      fs.unlink((req as any).file.path, () => {});
    }
    res.status(403).json({ message: 'Premium subscription required to set an intro sound' });
    return;
  }

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) { res.status(400).json({ message: 'No audio file provided' }); return; }

  const relativePath = `intro-sounds/${path.basename(file.filename)}`;

  try {
    await pool.query(
      'UPDATE users SET intro_sound_path = $1, updated_at = NOW() WHERE id = $2',
      [relativePath, userId]
    );
    res.json({ intro_sound_path: relativePath });
  } catch (err) {
    console.error('uploadIntroSound error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── DELETE /users/intro-sound  (remove custom intro sound) ───────────────────
export const deleteIntroSound = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  try {
    const result = await pool.query(
      'UPDATE users SET intro_sound_path = NULL, updated_at = NOW() WHERE id = $1 RETURNING intro_sound_path',
      [userId]
    );
    // Clean up file if it exists
    const oldPath = result.rows[0]?.intro_sound_path;
    if (oldPath) {
      const abs = path.join(UPLOADS_BASE, oldPath);
      fs.unlink(abs, () => {});
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteIntroSound error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── POST /users/avatar  (upload or replace profile avatar) ───────────────────
export const uploadAvatar = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) { res.status(400).json({ message: 'No image file provided' }); return; }

  // Delete old avatar file if it exists and differs from the new one
  try {
    const old = await pool.query('SELECT profile_image_path FROM users WHERE id = $1', [userId]);
    const oldPath = old.rows[0]?.profile_image_path as string | null;
    if (oldPath && oldPath !== `avatars/${file.filename}`) {
      fs.unlink(path.join(UPLOADS_BASE, oldPath), () => {});
    }
  } catch {}

  const relativePath = `avatars/${file.filename}`;
  try {
    await pool.query(
      'UPDATE users SET profile_image_path = $1, updated_at = NOW() WHERE id = $2',
      [relativePath, userId]
    );
    res.json({ avatar_url: `/uploads/${relativePath}` });
  } catch (err) {
    console.error('uploadAvatar error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── GET /users/intro-sound/:callsign  (fetch another user's intro sound) ─────
export const getIntroSoundByCallsign = async (req: AuthRequest, res: Response): Promise<void> => {
  const { callsign } = req.params;
  if (!callsign) { res.status(400).json({ message: 'Callsign required' }); return; }

  try {
    const result = await pool.query(
      'SELECT intro_sound_path FROM users WHERE callsign = $1',
      [callsign]
    );
    if (!result.rows.length) { res.status(404).json({ message: 'User not found' }); return; }

    const soundPath = result.rows[0].intro_sound_path as string | null;
    res.json({ intro_sound_url: soundPath ? `/uploads/${soundPath}` : null });
  } catch (err: any) {
    // If the column doesn't exist yet (migration pending), return null gracefully.
    if (err?.code === '42703') { res.json({ intro_sound_url: null }); return; }
    console.error('getIntroSoundByCallsign error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};