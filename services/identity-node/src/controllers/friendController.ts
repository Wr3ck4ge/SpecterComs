import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';

// ── In-process rate limit: 20 friend requests per user per hour ──────────────
// Mirrors abuseController.ts's per-user limiter pattern — unlike login/register,
// this is post-auth, so keying by user_id (a naturally bounded set) is simpler
// and more precise than the IP-keyed limiters in middleware/rateLimit.ts.
const requestCounts = new Map<string, { count: number; resetAt: number }>();

const checkRateLimit = (userId: string): boolean => {
  const now = Date.now();
  const entry = requestCounts.get(userId);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(userId, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (entry.count >= 20) return false;
  entry.count += 1;
  return true;
};

export const sendFriendRequest = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { target_id } = req.body;

  if (!userId || !target_id) return res.status(400).json({ message: 'Missing parameters' });
  if (userId === target_id) return res.status(400).json({ message: 'Cannot add yourself' });

  if (!checkRateLimit(userId)) {
    return res.status(429).json({ message: 'Too many friend requests. Try again later.' });
  }

  try {
    // Sort IDs to maintain a consistent composite key structure (smaller ID first)
    const userA = userId < target_id ? userId : target_id;
    const userB = userId < target_id ? target_id : userId;
    
    // Status 0 represents "Pending"; record who initiated so the UI can distinguish direction
    await pool.query(
      `INSERT INTO friendships (user_a_id, user_b_id, status, initiated_by)
       VALUES ($1, $2, 0, $3)
       ON CONFLICT (user_a_id, user_b_id) DO NOTHING`,
      [userA, userB, userId]
    );

    res.status(200).json({ message: 'Friend request sent' });
  } catch (error) {
    console.error('Send friend request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const acceptFriendRequest = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { target_id } = req.body;

  if (!userId || !target_id) return res.status(400).json({ message: 'Missing parameters' });

  try {
    const userA = userId < target_id ? userId : target_id;
    const userB = userId < target_id ? target_id : userId;

    // Status 1 represents "Accepted"; only the recipient (non-initiator) may accept
    const result = await pool.query(
      `UPDATE friendships 
       SET status = 1 
       WHERE user_a_id = $1 AND user_b_id = $2 AND status = 0
         AND (initiated_by IS NULL OR initiated_by != $3)
       RETURNING *`,
      [userA, userB, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Pending request not found or you are the initiator' });
    }

    res.status(200).json({ message: 'Friend request accepted' });
  } catch (error) {
    console.error('Accept friend request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getFriends = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const result = await pool.query(
      `SELECT u.id, u.callsign, u.global_tag, f.status, f.initiated_by, f.created_at
       FROM friendships f
       JOIN users u ON (u.id = f.user_a_id OR u.id = f.user_b_id)
       WHERE (f.user_a_id = $1 OR f.user_b_id = $1)
       AND u.id != $1`,
      [userId]
    );

    res.status(200).json({ friends: result.rows });
  } catch (error) {
    console.error('Get friends error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const declineFriendRequest = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { target_id } = req.body;
  if (!userId || !target_id) return res.status(400).json({ message: 'Missing parameters' });

  try {
    const userA = userId < target_id ? userId : target_id;
    const userB = userId < target_id ? target_id : userId;

    // Only delete if pending (status=0) and the current user is NOT the initiator
    const result = await pool.query(
      `DELETE FROM friendships
       WHERE user_a_id = $1 AND user_b_id = $2 AND status = 0
         AND (initiated_by IS NULL OR initiated_by != $3)
       RETURNING *`,
      [userA, userB, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Pending request not found or you are the initiator' });
    }
    res.json({ message: 'Friend request declined' });
  } catch (error) {
    console.error('Decline friend request error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const removeFriend = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { target_id } = req.body;
  if (!userId || !target_id) return res.status(400).json({ message: 'Missing parameters' });

  try {
    const userA = userId < target_id ? userId : target_id;
    const userB = userId < target_id ? target_id : userId;

    // Delete friendship regardless of status (accepted or pending)
    const result = await pool.query(
      `DELETE FROM friendships WHERE user_a_id = $1 AND user_b_id = $2 RETURNING *`,
      [userA, userB]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Friendship not found' });
    }
    res.json({ message: 'Friend removed' });
  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};
