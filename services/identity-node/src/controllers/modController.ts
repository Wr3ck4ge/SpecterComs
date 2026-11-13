import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { publishEvent } from '../config/nats.js';
import { bulkMoveUsers } from './channelController.js';
import { getRequesterInfo } from './roleController.js';
import { channelPresence } from './channelController.js';
import { getOrgAuthority, has, outranks, canViewRoster, canSeeOrgChannel, memberStatus, ORG_PERMISSION_KEYS } from '../utils/orgAuthority.js';
import { isUserOnline } from '../utils/onlineUsers.js';
import { watchAudience } from '../utils/audienceNarrowing.js'; // B3

// permissions is stored as a JSONB object with named boolean flags (see
// ADMIN_PERMISSIONS/OFFICER_PERMISSIONS/MEMBER_PERMISSIONS in orgController.ts),
// not a bitmask — a required permission is checked by key, e.g. 'can_kick'.
const checkModerationPermission = async (userId: string, orgId: string, requiredPerm: string) => {
    const ownerQuery = `SELECT owner_id FROM organizations WHERE id = $1`;
    const ownerResult = await pool.query(ownerQuery, [orgId]);
    const ownerId: string | null = ownerResult.rows.length > 0 ? ownerResult.rows[0].owner_id : null;

    if (ownerId === userId) {
        return { allowed: true, ownerId };
    }

    const checkPermsQuery = `
        SELECT r.permissions
        FROM org_members m
        JOIN org_roles r ON r.id = m.role_id
        WHERE m.org_id = $1 AND m.user_id = $2
    `;
    const permResult = await pool.query(checkPermsQuery, [orgId, userId]);

    for (const row of permResult.rows) {
        if (row.permissions?.[requiredPerm] === true) {
            return { allowed: true, ownerId };
        }
    }

    return { allowed: false, ownerId };
}

// A moderator may not act on someone who outranks them. Role levels come from
// org_roles.level (the owner outranks everyone and is checked separately).
// Strictly higher only: levels default to 0, so "at or above" would stop every
// existing level-0 moderator from acting on anyone.
const outranksModerator = async (orgId: string, adminId: string, targetUserId: string): Promise<boolean> => {
    const requester = await getRequesterInfo(orgId, adminId);
    if (requester.isOwner) return false;
    const t = await pool.query(
        `SELECT COALESCE(MAX(r.level), 0) AS level
         FROM org_members m JOIN org_roles r ON r.id = m.role_id
         WHERE m.org_id = $1 AND m.user_id = $2`,
        [orgId, targetUserId]
    );
    return Number(t.rows[0]?.level ?? 0) > requester.level;
};

export const banMember = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const targetUserId = req.params.userId as string;
    const { reason, expiresAt } = req.body; // expiresAt as ISO timestamp or null
    const adminId = req.user?.id;

    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });

    if (targetUserId === adminId) return res.status(400).json({ message: 'Cannot ban yourself' });

    const client = await pool.connect();

    try {
        const { allowed, ownerId } = await checkModerationPermission(adminId, orgId, 'can_ban');
        if (!allowed) return res.status(403).json({ message: 'Forbidden: Missing ban permission' });
        if (targetUserId === ownerId) return res.status(403).json({ message: 'Cannot ban the organization owner' });
        if (await outranksModerator(orgId, adminId, targetUserId)) return res.status(403).json({ message: 'Forbidden: That member outranks you' });

        // B3: every channel they were on loses them → re-key those groups (after COMMIT).
        const narrowing = await watchAudience(orgId, { includeOpen: true });
        await client.query('BEGIN');

        // Delete from org_members
        await client.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, targetUserId]);

        // Also remove any channel subscriptions — same as kickMember, since a
        // ban is a strictly stronger action and must drop the user from voice too.
        await client.query(`DELETE FROM channel_subscriptions WHERE user_id = $1 AND org_id = $2`, [targetUserId, orgId]);

        // Add to org_bans
        await client.query(
            `INSERT INTO org_bans (org_id, user_id, reason, expires_at) VALUES ($1, $2, $3, $4)`,
            [orgId, targetUserId, reason || 'No reason provided', expiresAt || null]
        );

        await client.query('COMMIT');
        await narrowing();

        // Publish NATS audit event
        await publishEvent('specter.moderation.ban', {
            org_id: orgId,
            user_id: targetUserId,
            admin_id: adminId,
            reason: reason,
            action: 'BAN'
        });

        // Publish SFU kick command so the banned user is dropped from voice
        await publishEvent(`specter.cmd.kick.${targetUserId}`, {
            org_id: orgId,
            user_id: targetUserId,
            admin_id: adminId,
            action: 'BAN_KICK',
        });

        // SSE: notify org members and the banned user
        await publishEvent(`specter.event.org.${orgId}`, { type: 'member_removed', userId: targetUserId, reason: 'ban' });
        await publishEvent(`specter.event.user.${targetUserId}`, { type: 'orgs_changed' });

        res.status(200).json({ message: 'User banned successfully' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ban Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    } finally {
        client.release();
    }
};

export const kickMember = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const targetUserId = req.params.userId as string;
    const { reason } = req.body;
    const adminId = req.user?.id;

    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });
    if (targetUserId === adminId) return res.status(400).json({ message: 'Cannot kick yourself' });

    try {
        const { allowed, ownerId } = await checkModerationPermission(adminId, orgId, 'can_kick');
        if (!allowed) return res.status(403).json({ message: 'Forbidden: Missing kick permission' });
        if (targetUserId === ownerId) return res.status(403).json({ message: 'Cannot kick the organization owner' });
        if (await outranksModerator(orgId, adminId, targetUserId)) return res.status(403).json({ message: 'Forbidden: That member outranks you' });

        // B3: every channel they were on loses them → re-key those groups.
        const narrowing = await watchAudience(orgId, { includeOpen: true });
        // Delete from org_members (removes from server entirely)
        const result = await pool.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2 RETURNING *`, [orgId, targetUserId]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Member not found' });
        await narrowing();

        // Also remove any channel subscriptions so voice is dropped immediately
        await pool.query(`DELETE FROM channel_subscriptions WHERE user_id = $1 AND org_id = $2`, [targetUserId, orgId]);

        await publishEvent(`specter.cmd.kick.${targetUserId}`, {
            org_id: orgId,
            user_id: targetUserId,
            admin_id: adminId,
            reason: reason,
            action: 'KICK',
        });

        // SSE: notify org members and the kicked user
        await publishEvent(`specter.event.org.${orgId}`, { type: 'member_removed', userId: targetUserId, reason: 'kick' });
        await publishEvent(`specter.event.user.${targetUserId}`, { type: 'orgs_changed' });

        res.status(200).json({ message: 'User kicked from server' });
    } catch (err) {
        console.error('Kick Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const kickFromChannel = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const targetUserId = req.params.userId as string;
    const { channel_id } = req.body; // optional — if omitted, uses current subscription
    const adminId = req.user?.id;

    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });
    if (targetUserId === adminId) return res.status(400).json({ message: 'Cannot kick yourself' });

    try {
        const { allowed, ownerId } = await checkModerationPermission(adminId, orgId, 'can_kick');
        if (!allowed) return res.status(403).json({ message: 'Forbidden: Missing kick permission' });
        if (targetUserId === ownerId) return res.status(403).json({ message: 'Cannot kick the organization owner' });
        if (await outranksModerator(orgId, adminId, targetUserId)) return res.status(403).json({ message: 'Forbidden: That member outranks you' });

        // Resolve the channel to kick from
        let targetChannelId = channel_id;
        if (!targetChannelId) {
            const subRes = await pool.query(
                `SELECT channel_id FROM channel_subscriptions WHERE user_id = $1 AND org_id = $2 LIMIT 1`,
                [targetUserId, orgId]
            );
            if (subRes.rows.length === 0) return res.status(404).json({ message: 'User is not in any channel' });
            targetChannelId = subRes.rows[0].channel_id;
        }

        // Remove channel subscription
        await pool.query(
            `DELETE FROM channel_subscriptions WHERE user_id = $1 AND org_id = $2 AND channel_id = $3`,
            [targetUserId, orgId, targetChannelId]
        );

        // Signal media-rust to drop the user from this voice channel
        await publishEvent(`specter.cmd.kick.${targetUserId}`, {
            org_id: orgId,
            user_id: targetUserId,
            admin_id: adminId,
            channel_id: targetChannelId,
            action: 'CHANNEL_KICK',
        });

        // SSE: notify channel presence changed + tell the target they were kicked out
        await publishEvent(`specter.event.org.${orgId}`, { type: 'presence_changed', channelId: targetChannelId });
        await publishEvent(`specter.event.user.${targetUserId}`, { type: 'channel_kicked', channelId: targetChannelId });

        res.status(200).json({ message: 'User kicked from channel' });
    } catch (err) {
        console.error('Kick from channel error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const muteMember = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const targetUserId = req.params.userId as string;
    const { mute, duration_minutes } = req.body; // mute: boolean, duration_minutes: optional
    const adminId = req.user?.id;

    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });
    if (targetUserId === adminId) return res.status(400).json({ message: 'Cannot mute yourself' });

    try {
        const { allowed, ownerId } = await checkModerationPermission(adminId, orgId, 'can_mute');
        if (!allowed) return res.status(403).json({ message: 'Forbidden: Missing mute permission' });
        if (targetUserId === ownerId) return res.status(403).json({ message: 'Cannot mute the organization owner' });
        if (await outranksModerator(orgId, adminId, targetUserId)) return res.status(403).json({ message: 'Forbidden: That member outranks you' });

        if (mute) {
            const mutedUntil = duration_minutes
                ? new Date(Date.now() + duration_minutes * 60 * 1000).toISOString()
                : null; // null = indefinite mute

            const result = await pool.query(
                `UPDATE org_members SET muted_until = $1 WHERE org_id = $2 AND user_id = $3 RETURNING *`,
                [mutedUntil, orgId, targetUserId]
            );
            if (result.rows.length === 0) return res.status(404).json({ message: 'Member not found' });

            await publishEvent(`specter.cmd.mute.${targetUserId}`, {
                org_id: orgId,
                user_id: targetUserId,
                admin_id: adminId,
                muted: true,
                action: 'MUTE',
            });
        } else {
            const result = await pool.query(
                `UPDATE org_members SET muted_until = NULL WHERE org_id = $1 AND user_id = $2 RETURNING *`,
                [orgId, targetUserId]
            );
            if (result.rows.length === 0) return res.status(404).json({ message: 'Member not found' });

            await publishEvent(`specter.cmd.unmute.${targetUserId}`, {
                org_id: orgId,
                user_id: targetUserId,
                admin_id: adminId,
                muted: false,
                action: 'UNMUTE',
            });
        }

        res.status(200).json({ message: `User ${mute ? 'muted' : 'unmuted'} successfully` });
    } catch (err) {
        console.error('Mute Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const unmuteMember = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const targetUserId = req.params.userId as string;
    const adminId = req.user?.id;

    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const { allowed } = await checkModerationPermission(adminId, orgId, 'can_mute');
        if (!allowed) return res.status(403).json({ message: 'Forbidden: Missing mute permission' });

        const result = await pool.query(
            `UPDATE org_members SET muted_until = NULL WHERE org_id = $1 AND user_id = $2 RETURNING *`,
            [orgId, targetUserId]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Member not found' });

        await publishEvent(`specter.cmd.unmute.${targetUserId}`, {
            org_id: orgId,
            user_id: targetUserId,
            admin_id: adminId,
            action: 'UNMUTE',
        });

        res.status(200).json({ message: 'User unmuted successfully' });
    } catch (err) {
        console.error('Unmute Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const moveMember = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const targetUserId = req.params.userId as string;
    const { channel_id } = req.body;
    const adminId = req.user?.id;

    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });
    if (!channel_id) return res.status(400).json({ message: 'channel_id required' });

    try {
        const { allowed } = await checkModerationPermission(adminId, orgId, 'can_manage_channels');
        if (!allowed) return res.status(403).json({ message: 'Forbidden: Missing permission' });

        const chanCheck = await pool.query(
            'SELECT 1 FROM channels WHERE id = $1 AND org_id = $2',
            [channel_id, orgId]
        );
        if (chanCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Target channel not found' });
        }

        // Persist the subscription change immediately so the move is durable
        // regardless of whether the user has an active WebTransport session.
        // bulkMoveUsers handles: DB upsert, in-memory map, NATS presence broadcast.
        const currentSub = await pool.query(
            `SELECT channel_id FROM channel_subscriptions WHERE user_id = $1 AND org_id = $2`,
            [targetUserId, orgId]
        );
        const fromChannels: string[] = currentSub.rowCount
            ? [currentSub.rows[0].channel_id]
            : [];
        await bulkMoveUsers(orgId, fromChannels, channel_id, '');

        // Also signal media-rust so a live WebTransport session reconnects immediately.
        await publishEvent(`specter.cmd.move.${targetUserId}.${channel_id}`, {
            org_id: orgId,
            user_id: targetUserId,
            channel_id,
            admin_id: adminId,
            action: 'MOVE',
        });

        res.status(200).json({ message: 'Move command sent' });
    } catch (err) {
        console.error('Move Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const getOrgMembers = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const memberCheck = await pool.query(
            `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`,
            [orgId, userId]
        );
        if (memberCheck.rows.length === 0) {
            return res.status(403).json({ message: 'Not a member of this organization' });
        }

        const result = await pool.query(
            `SELECT om.user_id, u.callsign, u.profile_image_path, r.id as role_id, r.name as role_name, r.permissions, om.joined_at
             FROM org_members om
             JOIN users u ON om.user_id = u.id
             LEFT JOIN org_roles r ON om.role_id = r.id
             WHERE om.org_id = $1
             ORDER BY om.joined_at ASC`,
            [orgId]
        );

        const members = result.rows.map((row: any) => ({
            ...row,
            avatar_url: row.profile_image_path ? `/uploads/${row.profile_image_path}` : null,
        }));

        res.json({ members });
    } catch (err) {
        console.error('Get Members Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const assignMemberRole = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const targetUserId = req.params.userId as string;
    const { role_id } = req.body;
    const actingUserId = req.user?.id;

    if (!actingUserId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const actor = await getOrgAuthority(orgId, actingUserId);
        if (!has(actor, 'can_manage_roles')) {
            return res.status(403).json({ message: 'Forbidden: Cannot manage roles' });
        }

        const target = await pool.query(
            `SELECT m.user_id, (o.owner_id = m.user_id) AS is_owner, COALESCE(r.level, 0) AS level
             FROM org_members m JOIN organizations o ON o.id = m.org_id
             LEFT JOIN org_roles r ON r.id = m.role_id
             WHERE m.org_id = $1 AND m.user_id = $2`,
            [orgId, targetUserId]
        );
        if (target.rows.length === 0) return res.status(404).json({ message: 'Member not found' });
        // The owner's rank is fixed; and nobody below the owner may re-rank
        // someone at or above their own rank (that used to be allowed: any
        // can_manage_roles member could demote a Commander).
        if (target.rows[0].is_owner) return res.status(403).json({ message: 'Forbidden: The owner cannot be re-ranked' });
        if (!outranks(actor, Number(target.rows[0].level))) {
            return res.status(403).json({ message: 'Forbidden: That member is at or above your rank' });
        }

        if (role_id) {
            const roleCheck = await pool.query(
                `SELECT COALESCE(level, 0) AS level FROM org_roles WHERE id = $1 AND org_id = $2`, [role_id, orgId]
            );
            if (roleCheck.rows.length === 0) return res.status(404).json({ message: 'Role not found in this organization' });

            // A non-owner can only assign roles ranked strictly below their own,
            // so a member with can_manage_roles can't hand out (or hand
            // themselves) the org's top-level role.
            if (!outranks(actor, Number(roleCheck.rows[0].level))) {
                return res.status(403).json({ message: 'Forbidden: Cannot assign a role at or above your own rank' });
            }
        }

        // B3: a demotion can drop them from rank-restricted / op channels → re-key those.
        const narrowing = await watchAudience(orgId);
        await pool.query(
            `UPDATE org_members SET role_id = $1 WHERE org_id = $2 AND user_id = $3`,
            [role_id || null, orgId, targetUserId]
        );
        await narrowing();

        // SSE: notify org so member list refreshes with new role
        await publishEvent(`specter.event.org.${orgId}`, { type: 'member_updated', userId: targetUserId });

        res.json({ message: 'Role assigned successfully' });
    } catch (err) {
        console.error('Assign Role Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

/**
 * GET /orgs/:orgId/members/roster — the server admin Members pane (owner,
 * 2026-11-08): every member with their rank and online status, the server's
 * ranks, and what the viewer may do. Owner, or a rank with can_view_members /
 * can_manage_roles. Online = the app is connected (utils/onlineUsers); voice =
 * in one of this server's channels right now.
 */
export const getMemberRoster = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const actor = await getOrgAuthority(orgId, userId);
        if (!actor.isMember) return res.status(403).json({ message: 'Not a member of this organization' });
        if (!canViewRoster(actor)) return res.status(403).json({ message: 'Forbidden: Cannot view the member list' });

        const [membersRes, rolesRes, chansRes] = await Promise.all([
            pool.query(
                `SELECT m.user_id, u.callsign, u.profile_image_path, m.joined_at,
                        r.id AS role_id, r.name AS role_name, COALESCE(r.level, 0) AS level,
                        (o.owner_id = m.user_id) AS is_owner
                 FROM org_members m
                 JOIN users u ON u.id = m.user_id
                 JOIN organizations o ON o.id = m.org_id
                 LEFT JOIN org_roles r ON r.id = m.role_id
                 WHERE m.org_id = $1`,
                [orgId]
            ),
            pool.query(`SELECT id, name, permissions, COALESCE(level, 0) AS level FROM org_roles WHERE org_id = $1 ORDER BY level DESC, name ASC`, [orgId]),
            pool.query(`SELECT id, name, COALESCE(visible_min_level, 0) AS visible_min_level FROM channels WHERE org_id = $1`, [orgId]),
        ]);

        // Where each member is in voice in this server (in-memory presence). A
        // channel above the viewer's rank is only "a restricted channel".
        const voiceOf = new Map<string, { id: string | null; name: string }>();
        for (const ch of chansRes.rows) {
            const visible = canSeeOrgChannel(actor, ch.visible_min_level);
            for (const uid of channelPresence.get(ch.id)?.keys() ?? []) {
                voiceOf.set(uid, visible ? { id: ch.id, name: ch.name } : { id: null, name: 'Restricted channel' });
            }
        }

        const order: Record<string, number> = { voice: 0, online: 1, away: 2, busy: 3, offline: 4 };
        const members = membersRes.rows.map((m: any) => {
            const voice = voiceOf.get(m.user_id) || null;
            // No away/busy/invisible: users has no presence column on prod (updatePresence is dead code).
            const status = memberStatus({ online: isUserOnline(m.user_id), inVoice: Boolean(voice) });
            return {
                user_id: m.user_id,
                callsign: m.callsign,
                avatar_url: m.profile_image_path ? `/uploads/${m.profile_image_path}` : null,
                joined_at: m.joined_at,
                is_owner: Boolean(m.is_owner),
                role_id: m.role_id,
                role_name: m.is_owner ? 'Owner' : m.role_name,
                level: m.is_owner ? null : Number(m.level),
                status,
                voice_channel: status === 'voice' ? voice : null,
                // What the viewer may do to this member (the server re-checks).
                manageable: !m.is_owner && m.user_id !== userId && outranks(actor, Number(m.level)),
            };
        }).sort((a: any, b: any) =>
            (order[a.status] - order[b.status])
            || (Number(b.is_owner) - Number(a.is_owner))
            || ((b.level ?? 0) - (a.level ?? 0))
            || String(a.callsign).localeCompare(String(b.callsign)));

        res.json({
            members,
            roles: rolesRes.rows.map((r: any) => ({
                ...r,
                level: Number(r.level),
                editable: has(actor, 'can_manage_roles') && outranks(actor, Number(r.level)),
            })),
            me: {
                user_id: userId,
                is_owner: actor.isOwner,
                level: actor.isOwner ? null : actor.level,
                permissions: actor.permissions,
            },
            permission_keys: ORG_PERMISSION_KEYS,
        });
    } catch (err) {
        console.error('Get Roster Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const getOrgBans = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const { allowed } = await checkModerationPermission(userId, orgId, 'can_ban');
        if (!allowed) return res.status(403).json({ message: 'Forbidden' });

        const result = await pool.query(
            `SELECT ob.user_id, u.callsign, ob.reason, ob.expires_at, ob.created_at
             FROM org_bans ob
             LEFT JOIN users u ON ob.user_id = u.id
             WHERE ob.org_id = $1
             ORDER BY ob.created_at DESC`,
            [orgId]
        );
        res.json({ bans: result.rows });
    } catch (err) {
        console.error('Get Bans Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const unbanMember = async (req: AuthRequest, res: Response) => {
    const orgId = req.params.orgId as string;
    const targetUserId = req.params.userId as string;
    const adminId = req.user?.id;
    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const { allowed } = await checkModerationPermission(adminId, orgId, 'can_ban');
        if (!allowed) return res.status(403).json({ message: 'Forbidden' });

        const result = await pool.query(
            `DELETE FROM org_bans WHERE org_id = $1 AND user_id = $2 RETURNING *`,
            [orgId, targetUserId]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Ban not found' });

        res.json({ message: 'User unbanned successfully' });
    } catch (err) {
        console.error('Unban Error:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
