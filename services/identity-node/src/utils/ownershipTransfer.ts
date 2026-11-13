/**
 * L13: server ownership transfer (signed hand-off) and the abandonment rule.
 *
 * Transfer: owner picks an existing member; the member accepts; both prove it
 * with their password (+ the second factor once it exists, see
 * assertSecondFactor). Pending for 7 days; the owner may cancel. Accepting
 * swaps organizations.owner_id atomically; the old owner becomes the highest
 * non-owner rank. The wallet is keyed by org id, so billing stays with the
 * server.
 *
 * Abandonment: owner account erased, or no sign-in for 12 months. The
 * highest-rank member may claim; the claim row is a 30-day notice shown to
 * members; the owner returning (sign-in) cancels it; the sweep completes it.
 * Inactivity = newest refresh_tokens.created_at (login and every token
 * refresh insert one); users.created_at when none.
 */
import * as argon2 from 'argon2';
import { pool } from '../config/db.js';
import { publishEvent } from '../config/nats.js';
import { isEnabled, takeAccountAttempt, verifyFactor } from './twoFactorStore.js';

export const TRANSFER_TTL_DAYS = 7;
export const CLAIM_NOTICE_DAYS = 30;
export const INACTIVITY_MONTHS = 12;

export class OwnershipError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

type Q = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

/** Pure: a transfer row is live only while pending and unexpired. */
export const transferIsLive = (t: { status: string; expires_at: string | Date }, now = new Date()): boolean =>
  t.status === 'pending' && new Date(t.expires_at).getTime() > now.getTime();

/** Pure: the 12-month inactivity rule. */
export const isInactive = (lastSeen: string | Date | null, now = new Date()): boolean => {
  if (!lastSeen) return true;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - INACTIVITY_MONTHS);
  return new Date(lastSeen).getTime() < cutoff.getTime();
};

/**
 * L3 hook: when the user has two-factor on, the hand-off also needs a current
 * authenticator code (or a recovery code). Same rate limit and replay
 * protection as sign-in (twoFactorStore.verifyFactor). Users without 2FA
 * are unaffected.
 */
export async function assertSecondFactor(_db: Q, userId: string, code: unknown): Promise<void> {
  const subject = { type: 'user' as const, id: userId };
  if (!(await isEnabled(subject))) return;
  if (typeof code !== 'string' || !code.trim()) {
    throw new OwnershipError(401, 'Enter the code from your authenticator app', 'SECOND_FACTOR_REQUIRED');
  }
  if (!takeAccountAttempt(subject)) {
    throw new OwnershipError(429, 'Too many code attempts. Try again later', 'SECOND_FACTOR_RATE_LIMITED');
  }
  const value = code.trim();
  const asTotp = /^\d{6}$/.test(value.replace(/\s/g, ''));
  const result = await verifyFactor(subject, asTotp ? { code: value.replace(/\s/g, '') } : { recovery_code: value });
  if (!result.ok) throw new OwnershipError(401, 'That code is not valid', 'SECOND_FACTOR_FAILED');
}

/** Re-authentication: password (+ second factor). */
export async function reauth(db: Q, userId: string, password: unknown, code?: unknown): Promise<void> {
  if (typeof password !== 'string' || !password || password.length > 1024) {
    throw new OwnershipError(400, 'Password required', 'REAUTH_REQUIRED');
  }
  const r = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const hash = r.rows[0]?.password_hash;
  const ok = hash ? await argon2.verify(hash, password).catch(() => false) : false;
  if (!ok) throw new OwnershipError(401, 'Incorrect password', 'REAUTH_FAILED');
  await assertSecondFactor(db, userId, code);
}

async function audit(db: Q, orgId: string, actor: string | null, action: string, detail: Record<string, unknown>) {
  await db.query(`INSERT INTO org_audit_log (org_id, actor_id, action, detail) VALUES ($1, $2, $3, $4)`,
    [orgId, actor, action, JSON.stringify(detail)]);
}

async function withTx<T>(fn: (c: Q) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function notify(orgId: string, userIds: string[]) {
  for (const u of userIds) await publishEvent(`specter.event.user.${u}`, { type: 'orgs_changed' }).catch(() => {});
  await publishEvent(`specter.event.org.${orgId}`, { type: 'orgs_changed' }).catch(() => {});
}

/** Atomic owner swap. Caller holds a transaction. */
export async function swapOwner(c: Q, orgId: string, fromId: string, toId: string, action: string, actor: string | null) {
  // TODO(billing): once billing is on, refuse when the new owner is under 18.
  const upd = await c.query(
    `UPDATE organizations SET owner_id = $3 WHERE id = $1 AND owner_id = $2 RETURNING id`, [orgId, fromId, toId]);
  if (upd.rows.length === 0) throw new OwnershipError(409, 'Ownership changed; refresh and try again', 'OWNER_CHANGED');
  // Highest non-owner rank = the top-level role of the server.
  const top = await c.query(
    `SELECT id FROM org_roles WHERE org_id = $1 ORDER BY level DESC, id ASC LIMIT 1`, [orgId]);
  const topRole = top.rows[0]?.id ?? null;
  if (topRole) {
    // The old owner may already have left; only re-rank an existing membership.
    await c.query(`UPDATE org_members SET role_id = $3 WHERE org_id = $1 AND user_id = $2`, [orgId, fromId, topRole]);
  }
  await audit(c, orgId, actor, action, { from: fromId, to: toId, oldOwnerRole: topRole });
}

// ── Transfer ────────────────────────────────────────────────────────────────

export async function initiateTransfer(orgId: string, ownerId: string, toUserId: unknown, password: unknown, code?: unknown) {
  if (typeof toUserId !== 'string' || !toUserId) throw new OwnershipError(400, 'to_user_id required');
  const org = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
  if (!org.rows[0]) throw new OwnershipError(404, 'Server not found');
  if (org.rows[0].owner_id !== ownerId) throw new OwnershipError(403, 'Only the owner can transfer ownership');
  if (toUserId === ownerId) throw new OwnershipError(400, 'You already own this server');
  await reauth(pool, ownerId, password, code);
  const mem = await pool.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, toUserId]);
  if (mem.rows.length === 0) throw new OwnershipError(400, 'The new owner must be a member of the server');
  const tgt = await pool.query('SELECT 1 FROM users WHERE id = $1 AND erased_at IS NULL', [toUserId]);
  if (tgt.rows.length === 0) throw new OwnershipError(400, 'That account is not available');
  const row = await withTx(async (c) => {
    await c.query(`UPDATE org_ownership_transfers SET status = 'expired', resolved_at = NOW()
                   WHERE org_id = $1 AND status = 'pending' AND expires_at <= NOW()`, [orgId]);
    let ins;
    try {
      ins = await c.query(
        `INSERT INTO org_ownership_transfers (org_id, from_user_id, to_user_id, expires_at)
         VALUES ($1, $2, $3, NOW() + make_interval(days => $4::int)) RETURNING id, expires_at`,
        [orgId, ownerId, toUserId, TRANSFER_TTL_DAYS]);
    } catch (e: any) {
      if (e?.code === '23505') throw new OwnershipError(409, 'A transfer is already pending; cancel it first', 'TRANSFER_PENDING');
      throw e;
    }
    await audit(c, orgId, ownerId, 'ownership.transfer_initiated', { to: toUserId, transferId: ins.rows[0].id });
    return ins.rows[0];
  });
  await notify(orgId, [ownerId, toUserId]);
  return row;
}

export async function cancelTransfer(orgId: string, ownerId: string) {
  const r = await withTx(async (c) => {
    const u = await c.query(
      `UPDATE org_ownership_transfers SET status = 'cancelled', resolved_at = NOW()
       WHERE org_id = $1 AND from_user_id = $2 AND status = 'pending' RETURNING id, to_user_id`, [orgId, ownerId]);
    if (u.rows.length === 0) throw new OwnershipError(404, 'No pending transfer');
    await audit(c, orgId, ownerId, 'ownership.transfer_cancelled', { transferId: u.rows[0].id });
    return u.rows[0];
  });
  await notify(orgId, [ownerId, r.to_user_id]);
}

export async function declineTransfer(orgId: string, userId: string) {
  const r = await withTx(async (c) => {
    const u = await c.query(
      `UPDATE org_ownership_transfers SET status = 'declined', resolved_at = NOW()
       WHERE org_id = $1 AND to_user_id = $2 AND status = 'pending' RETURNING id, from_user_id`, [orgId, userId]);
    if (u.rows.length === 0) throw new OwnershipError(404, 'No pending transfer');
    await audit(c, orgId, userId, 'ownership.transfer_declined', { transferId: u.rows[0].id });
    return u.rows[0];
  });
  await notify(orgId, [userId, r.from_user_id]);
}

export async function acceptTransfer(orgId: string, userId: string, password: unknown, code?: unknown) {
  const cur = await pool.query(
    `SELECT id, from_user_id, to_user_id, status, expires_at FROM org_ownership_transfers
     WHERE org_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [orgId]);
  const t = cur.rows[0];
  if (!t || t.to_user_id !== userId) throw new OwnershipError(404, 'No pending transfer for you');
  if (!transferIsLive(t)) {
    await pool.query(`UPDATE org_ownership_transfers SET status = 'expired', resolved_at = NOW() WHERE id = $1 AND status = 'pending'`, [t.id]);
    throw new OwnershipError(410, 'This transfer has expired', 'TRANSFER_EXPIRED');
  }
  await reauth(pool, userId, password, code);
  await withTx(async (c) => {
    const lock = await c.query(
      `UPDATE org_ownership_transfers SET status = 'accepted', resolved_at = NOW()
       WHERE id = $1 AND status = 'pending' AND expires_at > NOW() RETURNING id`, [t.id]);
    if (lock.rows.length === 0) throw new OwnershipError(409, 'Transfer is no longer pending', 'TRANSFER_GONE');
    const mem = await c.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
    if (mem.rows.length === 0) throw new OwnershipError(409, 'You are no longer a member of this server');
    await swapOwner(c, orgId, t.from_user_id, userId, 'ownership.transferred', userId);
    // A pending abandonment claim is moot now.
    await c.query(`UPDATE org_abandonment_claims SET status = 'cancelled', resolved_at = NOW(), resolved_reason = 'transferred'
                   WHERE org_id = $1 AND status = 'pending'`, [orgId]);
  });
  await notify(orgId, [t.from_user_id, userId]);
}

// ── Abandonment ─────────────────────────────────────────────────────────────

/** Why the server counts as abandoned, or null if the owner is active. */
export async function abandonmentReason(db: Q, ownerId: string): Promise<'owner_deleted' | 'owner_inactive' | null> {
  const u = await db.query(
    `SELECT erased_at, created_at,
            (SELECT MAX(created_at) FROM refresh_tokens WHERE user_id = users.id) AS last_seen
     FROM users WHERE id = $1`, [ownerId]);
  const row = u.rows[0];
  if (!row || row.erased_at) return 'owner_deleted';
  return isInactive(row.last_seen ?? row.created_at) ? 'owner_inactive' : null;
}

/** The highest-ranked non-owner member (ties: longest-standing). */
export async function topAdmin(db: Q, orgId: string): Promise<string | null> {
  const r = await db.query(
    `SELECT m.user_id FROM org_members m
     JOIN organizations o ON o.id = m.org_id
     LEFT JOIN org_roles r ON r.id = m.role_id
     JOIN users u ON u.id = m.user_id AND u.erased_at IS NULL
     WHERE m.org_id = $1 AND m.user_id <> o.owner_id
     ORDER BY COALESCE(r.level, 0) DESC, m.joined_at ASC LIMIT 1`, [orgId]);
  return r.rows[0]?.user_id ?? null;
}

export async function startClaim(orgId: string, claimantId: string, password: unknown, code?: unknown) {
  const org = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
  if (!org.rows[0]) throw new OwnershipError(404, 'Server not found');
  const ownerId = org.rows[0].owner_id;
  if (ownerId === claimantId) throw new OwnershipError(400, 'You already own this server');
  const reason = await abandonmentReason(pool, ownerId);
  if (!reason) throw new OwnershipError(409, 'The owner is still active', 'OWNER_ACTIVE');
  if ((await topAdmin(pool, orgId)) !== claimantId) throw new OwnershipError(403, 'Only the highest-ranked admin can claim an abandoned server', 'NOT_TOP_ADMIN');
  await reauth(pool, claimantId, password, code);
  const row = await withTx(async (c) => {
    let ins;
    try {
      ins = await c.query(
        `INSERT INTO org_abandonment_claims (org_id, claimant_id, original_owner_id, reason, effective_at)
         VALUES ($1, $2, $3, $4, NOW() + make_interval(days => $5::int)) RETURNING id, effective_at`,
        [orgId, claimantId, ownerId, reason, CLAIM_NOTICE_DAYS]);
    } catch (e: any) {
      if (e?.code === '23505') throw new OwnershipError(409, 'A claim is already in its notice period', 'CLAIM_PENDING');
      throw e;
    }
    await audit(c, orgId, claimantId, 'ownership.claim_started', { reason, claimId: ins.rows[0].id });
    return ins.rows[0];
  });
  await notify(orgId, [claimantId]);
  return { ...row, reason };
}

/** The owner returned (signed in): cancel any pending claim against them. */
export async function cancelClaimsForReturningOwner(userId: string, db: Q = pool): Promise<number> {
  const r = await db.query(
    `UPDATE org_abandonment_claims SET status = 'cancelled', resolved_at = NOW(), resolved_reason = 'owner_returned'
     WHERE original_owner_id = $1 AND status = 'pending' RETURNING org_id, claimant_id`, [userId]);
  for (const row of r.rows) {
    await audit(db, row.org_id, userId, 'ownership.claim_cancelled', { reason: 'owner_returned' });
    await notify(row.org_id, [row.claimant_id, userId]);
  }
  return r.rows.length;
}

/** Sweep: expire transfers, finish due claims, drop claims whose owner is back. */
export async function sweepOwnership(): Promise<{ expired: number; completed: number; cancelled: number }> {
  const exp = await pool.query(
    `UPDATE org_ownership_transfers SET status = 'expired', resolved_at = NOW()
     WHERE status = 'pending' AND expires_at <= NOW() RETURNING org_id, from_user_id, to_user_id`);
  for (const e of exp.rows) await notify(e.org_id, [e.from_user_id, e.to_user_id]);
  let completed = 0, cancelled = 0;
  const due = await pool.query(`SELECT id, org_id, claimant_id, original_owner_id, effective_at FROM org_abandonment_claims WHERE status = 'pending'`);
  for (const cl of due.rows) {
    const org = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [cl.org_id]);
    const owner = org.rows[0]?.owner_id;
    const reason = owner ? await abandonmentReason(pool, owner) : null;
    const stillOk = owner && owner === cl.original_owner_id && reason !== null;
    if (!stillOk) {
      await pool.query(`UPDATE org_abandonment_claims SET status = 'cancelled', resolved_at = NOW(), resolved_reason = $2 WHERE id = $1`,
        [cl.id, owner === cl.original_owner_id ? 'owner_returned' : 'owner_changed']);
      cancelled++;
      continue;
    }
    if (new Date(cl.effective_at).getTime() > Date.now()) continue;
    try {
      await withTx(async (c) => {
        const u = await c.query(`UPDATE org_abandonment_claims SET status = 'completed', resolved_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING id`, [cl.id]);
        if (u.rows.length === 0) return;
        await swapOwner(c, cl.org_id, owner, cl.claimant_id, 'ownership.claimed', cl.claimant_id);
      });
      await notify(cl.org_id, [cl.claimant_id]);
      completed++;
    } catch (e) {
      console.error('[ownership] claim completion failed', cl.id, e);
    }
  }
  return { expired: exp.rows.length, completed, cancelled };
}

export function startOwnershipSweep(): void {
  const run = () => sweepOwnership().catch((e) => console.error('[ownership] sweep failed', e));
  setTimeout(run, 60_000).unref?.();
  setInterval(run, 60 * 60 * 1000).unref?.();
}

/** What the strip shows: the caller's view of ownership state for one server. */
export async function ownershipStatus(orgId: string, userId: string) {
  const org = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
  const mem = await pool.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  if (!org.rows[0] || mem.rows.length === 0) throw new OwnershipError(403, 'Not a member');
  const ownerId = org.rows[0].owner_id;
  const tr = await pool.query(
    `SELECT t.id, t.from_user_id, t.to_user_id, t.expires_at, u.callsign AS to_callsign, f.callsign AS from_callsign
     FROM org_ownership_transfers t JOIN users u ON u.id = t.to_user_id JOIN users f ON f.id = t.from_user_id
     WHERE t.org_id = $1 AND t.status = 'pending' AND t.expires_at > NOW()`, [orgId]);
  const t = tr.rows[0];
  const visibleTransfer = t && (t.from_user_id === userId || t.to_user_id === userId) ? t : null;
  const cl = await pool.query(
    `SELECT c.id, c.claimant_id, c.reason, c.started_at, c.effective_at, u.callsign AS claimant_callsign
     FROM org_abandonment_claims c JOIN users u ON u.id = c.claimant_id
     WHERE c.org_id = $1 AND c.status = 'pending'`, [orgId]);
  const claimEligible = ownerId !== userId && !cl.rows[0] && (await topAdmin(pool, orgId)) === userId
    && (await abandonmentReason(pool, ownerId)) !== null;
  return {
    is_owner: ownerId === userId,
    transfer: visibleTransfer,
    claim_notice: cl.rows[0] ?? null,   // visible to every member
    can_claim: claimEligible,
  };
}

export async function incomingTransfers(userId: string) {
  const r = await pool.query(
    `SELECT t.id, t.org_id, o.callsign AS org_callsign, f.callsign AS from_callsign, t.expires_at
     FROM org_ownership_transfers t JOIN organizations o ON o.id = t.org_id JOIN users f ON f.id = t.from_user_id
     WHERE t.to_user_id = $1 AND t.status = 'pending' AND t.expires_at > NOW()`, [userId]);
  return r.rows;
}
