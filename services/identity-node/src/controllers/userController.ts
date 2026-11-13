import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_BASE = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const INTRO_SOUNDS_DIR = path.join(UPLOADS_BASE, 'intro-sounds');
const AVATARS_DIR = path.join(UPLOADS_BASE, 'avatars');
fs.mkdirSync(INTRO_SOUNDS_DIR, { recursive: true });
fs.mkdirSync(AVATARS_DIR, { recursive: true });

/**
 * A stored upload path ("avatars/<name>") → its absolute path, but ONLY if it
 * resolves to a file directly inside `dir`. Anything else ("../", another
 * folder, absolute paths) → null. Every fs operation on a stored path goes
 * through this.
 */
export function resolveUpload(rel: unknown, dir: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return null;
  const abs = path.resolve(UPLOADS_BASE, rel);
  return path.dirname(abs) === path.resolve(dir) ? abs : null;
}

function removeUpload(rel: unknown, dir: string): void {
  const abs = resolveUpload(rel, dir);
  if (abs) fs.unlink(abs, () => {});
}

/**
 * E1: uploads used to be named `<userId>.<ext>` under the public /uploads
 * path, so anyone who knew a user's id could fetch their avatar or intro
 * sound. New uploads get random names; this renames the old id-named files
 * once at startup (idempotent: it only touches paths that still embed the
 * owner's id).
 */
export async function randomizeLegacyUploadNames(): Promise<number> {
  let renamed = 0;
  for (const [col, dir, sub] of [
    ['profile_image_path', AVATARS_DIR, 'avatars'],
    ['intro_sound_path', INTRO_SOUNDS_DIR, 'intro-sounds'],
  ] as const) {
    const { rows } = await pool.query(
      `SELECT id, ${col} AS p FROM users WHERE ${col} LIKE '${sub}/' || id::text || '.%'`
    );
    for (const r of rows) {
      const from = resolveUpload(r.p, dir);
      if (!from) continue;
      const rel = `${sub}/${randomUUID()}${path.extname(from)}`;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, path.resolve(UPLOADS_BASE, rel));
        await pool.query(`UPDATE users SET ${col} = $1 WHERE id = $2 AND ${col} = $3`, [fs.existsSync(path.resolve(UPLOADS_BASE, rel)) ? rel : null, r.id, r.p]);
        renamed++;
      } catch (err) {
        console.error(`[uploads] rename of ${col} for ${r.id} failed:`, err);
      }
    }
  }
  return renamed;
}

// ── Avatar upload multer config ───────────────────────────────────────────────
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATARS_DIR),
  // Random, not the user id (E1): a public /uploads URL must not be derivable.
  filename: (_req, file, cb) => {
    const ext = file.mimetype === 'image/png' ? 'png'
      : file.mimetype === 'image/gif' ? 'gif'
      : file.mimetype === 'image/webp' ? 'webp'
      : 'jpg';
    cb(null, `${randomUUID()}.${ext}`);
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
  filename: (_req, _file, cb) => {
    cb(null, `${randomUUID()}.mp3`); // random, not the user id (E1)
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
      'SELECT id, callsign, global_tag, timezone, profile_image_path, intro_sound_path, subscription_tier, (email_verified_at IS NOT NULL) AS email_verified, (pending_email_hash IS NOT NULL) AS email_change_pending FROM users WHERE id = $1',
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

  // File paths are only ever set by the upload routes. This endpoint may
  // CLEAR them (null / ''), never set them: it used to store any string, and
  // the upload routes later passed that string to fs.unlink, so a client
  // could delete arbitrary files ("../../…") or point at another user's file.
  // A non-empty value is ignored (the legacy SettingsUI echoes its current
  // path back), not rejected.
  const clearAvatar = profile_image_path === null || profile_image_path === '';
  const clearIntro = intro_sound_path === null || intro_sound_path === '';
  let oldFiles: { profile_image_path: string | null; intro_sound_path: string | null } | null = null;
  if (clearAvatar || clearIntro) {
    const r = await pool.query('SELECT profile_image_path, intro_sound_path FROM users WHERE id = $1', [userId]);
    oldFiles = r.rows[0] ?? null;
  }
  if (clearAvatar) updates.push('profile_image_path = NULL');
  if (clearIntro) updates.push('intro_sound_path = NULL');

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
    if (clearAvatar) removeUpload(oldFiles?.profile_image_path, AVATARS_DIR);
    if (clearIntro) removeUpload(oldFiles?.intro_sound_path, INTRO_SOUNDS_DIR);
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('updateProfile error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// E2: per-user search rate limit (in memory, like friendController's).
const searchCounts = new Map<string, { count: number; resetAt: number }>();
function checkSearchRate(userId: string): boolean {
  const now = Date.now();
  const e = searchCounts.get(userId);
  if (!e || now > e.resetAt) { searchCounts.set(userId, { count: 1, resetAt: now + 60_000 }); return true; }
  if (e.count >= 30) return false;
  e.count += 1;
  return true;
}

export const searchUsers = async (req: AuthRequest, res: Response): Promise<void> => {
  const q = (req.query.q as string || '').trim();
  if (!q || q.length < 2) {
    res.status(400).json({ message: 'Query too short' });
    return;
  }
  // E2: search used to prefix-match EVERY account, so anyone could list the
  // whole user base two letters at a time. Now:
  //   - prefix matches only among people who share a server with you;
  //   - anyone, by their EXACT callsign (case-insensitive) — how you add a
  //     friend you already know;
  //   - rate-limited per user.
  // (A per-user "discoverable" setting can widen/narrow this later.)
  const userId = req.user!.id;
  if (!checkSearchRate(userId)) {
    res.status(429).json({ message: 'Too many searches. Try again in a minute.' });
    return;
  }
  if (q.length > 64) { res.status(400).json({ message: 'Query too long' }); return; }
  try {
    const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const result = await pool.query(
      `SELECT u.id, u.callsign, u.global_tag
         FROM users u
        WHERE u.id <> $3
          AND (
            lower(u.callsign) = lower($1)
            OR (u.callsign ILIKE $2 AND EXISTS (
                  SELECT 1 FROM org_members a
                    JOIN org_members b ON b.org_id = a.org_id
                   WHERE a.user_id = $3 AND b.user_id = u.id))
          )
        ORDER BY (lower(u.callsign) = lower($1)) DESC, u.callsign
        LIMIT 20`,
      [q, like, userId]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Search users error:', err);
    res.status(500).json({ message: 'Server error' });
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
    const old = await pool.query('SELECT intro_sound_path FROM users WHERE id = $1', [userId]);
    const oldPath = old.rows[0]?.intro_sound_path;
    if (oldPath && oldPath !== relativePath) removeUpload(oldPath, INTRO_SOUNDS_DIR);
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
    // Read the old path BEFORE clearing it (RETURNING gives the new value,
    // NULL, so the file was never deleted).
    const old = await pool.query('SELECT intro_sound_path FROM users WHERE id = $1', [userId]);
    await pool.query('UPDATE users SET intro_sound_path = NULL, updated_at = NOW() WHERE id = $1', [userId]);
    removeUpload(old.rows[0]?.intro_sound_path, INTRO_SOUNDS_DIR);
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
    if (oldPath && oldPath !== `avatars/${file.filename}`) removeUpload(oldPath, AVATARS_DIR);
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