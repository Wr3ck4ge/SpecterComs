import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

// Personal hangar — global per-user (not per-org), so a person's ships follow
// them across every org's events. Only Star Citizen for now, same as the
// rest of the game-ships stack.
const GAME = 'star_citizen';

// ── GET /hangar ────────────────────────────────────────────────────────────
export const getHangar = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const result = await pool.query(
      `SELECT id, game, ship_slug, ship_name, ship_icon_url, nickname, locked_seats, loadout_overrides, created_at
       FROM user_ships WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ ships: result.rows });
  } catch (err) {
    console.error('getHangar error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── POST /hangar ──────────────────────────────────────────────────────────
export const addHangarShip = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const shipSlug = String(req.body?.ship_slug || '').trim();
  if (!shipSlug) return res.status(400).json({ message: 'Missing ship_slug' });

  try {
    const shipRes = await pool.query(`SELECT name, icon_url FROM game_ships WHERE game = $1 AND slug = $2`, [GAME, shipSlug]);
    if (shipRes.rowCount === 0) return res.status(404).json({ message: 'Unknown ship' });
    const ship = shipRes.rows[0];

    const result = await pool.query(
      `INSERT INTO user_ships (user_id, game, ship_slug, ship_name, ship_icon_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, GAME, shipSlug, ship.name, ship.icon_url]
    );
    res.status(201).json({ ship: result.rows[0] });
  } catch (err) {
    console.error('addHangarShip error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── PATCH /hangar/:id ─────────────────────────────────────────────────────
export const updateHangarShip = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  const { id } = req.params;
  const { nickname, locked_seats, loadout_overrides } = req.body || {};

  try {
    const result = await pool.query(
      `UPDATE user_ships
       SET nickname = COALESCE($1, nickname),
           locked_seats = COALESCE($2::jsonb, locked_seats),
           loadout_overrides = COALESCE($3::jsonb, loadout_overrides),
           updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING *`,
      [
        nickname !== undefined ? String(nickname).slice(0, 64) : null,
        Array.isArray(locked_seats) ? JSON.stringify(locked_seats) : null,
        Array.isArray(loadout_overrides) ? JSON.stringify(loadout_overrides) : null,
        id,
        userId,
      ]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: 'Ship not found' });
    res.json({ ship: result.rows[0] });
  } catch (err) {
    console.error('updateHangarShip error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── DELETE /hangar/:id ─────────────────────────────────────────────────────
export const removeHangarShip = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  const { id } = req.params;

  try {
    const result = await pool.query(`DELETE FROM user_ships WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Ship not found' });
    res.json({ message: 'Removed' });
  } catch (err) {
    console.error('removeHangarShip error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};
