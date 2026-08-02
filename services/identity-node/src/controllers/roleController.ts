import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { publishEvent } from '../config/nats.js';

interface RequesterInfo {
    isOwner: boolean;
    canManage: boolean;
    level: number;
}

/** Returns requester's ownership status, manage-roles permission, and role level */
export const getRequesterInfo = async (orgId: string, userId: string): Promise<RequesterInfo> => {
    const ownerResult = await pool.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
    if (ownerResult.rows.length > 0 && ownerResult.rows[0].owner_id === userId) {
        return { isOwner: true, canManage: true, level: Number.MAX_SAFE_INTEGER };
    }

    const permResult = await pool.query(
        `SELECT r.permissions, COALESCE(r.level, 0) AS level
         FROM org_members m
         JOIN org_roles r ON r.id = m.role_id
         WHERE m.org_id = $1 AND m.user_id = $2`,
        [orgId, userId]
    );

    let canManage = false;
    let level = 0;
    for (const row of permResult.rows) {
        const perms = typeof row.permissions === 'string' ? JSON.parse(row.permissions) : (row.permissions || {});
        if (perms.can_manage_roles) canManage = true;
        if (Number(row.level) > level) level = Number(row.level);
    }
    return { isOwner: false, canManage, level };
};

export const createRole = async (req: AuthRequest, res: Response) => {
    const orgId = String(req.params.orgId);
    const { name, permissions, level } = req.body;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
    }

    try {
        const requester = await getRequesterInfo(orgId, userId);
        if (!requester.canManage) {
            return res.status(403).json({ message: 'Forbidden: Cannot manage roles' });
        }

        const newLevel = typeof level === 'number' ? level : 0;
        if (!requester.isOwner && newLevel >= requester.level) {
            return res.status(403).json({ message: 'Forbidden: Cannot create a role at or above your own rank' });
        }

        const insertQuery = `
            INSERT INTO org_roles (id, org_id, name, permissions, level)
            VALUES (gen_random_uuid(), $1, $2, $3, $4)
            RETURNING *
        `;
        const result = await pool.query(insertQuery, [orgId, name, JSON.stringify(permissions || {}), newLevel]);
        await publishEvent(`specter.event.org.${orgId}`, { type: 'role_created', role: result.rows[0] });
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating role', err);
        res.status(500).json({ message: 'Server error creating role' });
    }
};

export const getRoles = async (req: AuthRequest, res: Response) => {
    const { orgId } = req.params;

    try {
        const query = `SELECT * FROM org_roles WHERE org_id = $1 ORDER BY level DESC, name ASC`;
        const result = await pool.query(query, [orgId]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('Error fetching roles', err);
        res.status(500).json({ message: 'Server error fetching roles' });
    }
};

export const updateRole = async (req: AuthRequest, res: Response) => {
    const orgId = String(req.params.orgId);
    const roleId = String(req.params.roleId);
    const { name, permissions, level } = req.body;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
    }

    try {
        const requester = await getRequesterInfo(orgId, userId);
        if (!requester.canManage) {
            return res.status(403).json({ message: 'Forbidden: Cannot manage roles' });
        }

        // Fetch target role's current level
        const targetRes = await pool.query(
            `SELECT COALESCE(level, 0) AS level FROM org_roles WHERE id = $1 AND org_id = $2`,
            [roleId, orgId]
        );
        if (targetRes.rows.length === 0) {
            return res.status(404).json({ message: 'Role not found' });
        }
        const targetLevel = Number(targetRes.rows[0].level);

        if (!requester.isOwner && targetLevel >= requester.level) {
            return res.status(403).json({ message: 'Forbidden: Cannot modify a role at or above your own rank' });
        }

        // If caller is trying to set a new level, enforce hierarchy on that too
        if (typeof level === 'number' && !requester.isOwner && level >= requester.level) {
            return res.status(403).json({ message: 'Forbidden: Cannot assign a level at or above your own rank' });
        }

        const updateQuery = `
            UPDATE org_roles 
            SET name = COALESCE($1, name), 
                permissions = COALESCE($2, permissions),
                level = COALESCE($3, level)
            WHERE id = $4 AND org_id = $5
            RETURNING *
        `;
        const result = await pool.query(updateQuery, [
            name,
            permissions != null ? JSON.stringify(permissions) : null,
            typeof level === 'number' ? level : null,
            roleId,
            orgId,
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Role not found' });
        }
        await publishEvent(`specter.event.org.${orgId}`, { type: 'role_updated', role: result.rows[0] });
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('Error updating role', err);
        res.status(500).json({ message: 'Server error updating role' });
    }
};

export const deleteRole = async (req: AuthRequest, res: Response) => {
    const orgId = String(req.params.orgId);
    const roleId = String(req.params.roleId);
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
    }

    try {
        const requester = await getRequesterInfo(orgId, userId);
        if (!requester.canManage) {
            return res.status(403).json({ message: 'Forbidden: Cannot manage roles' });
        }

        // Fetch target role's level before deleting
        const targetRes = await pool.query(
            `SELECT COALESCE(level, 0) AS level FROM org_roles WHERE id = $1 AND org_id = $2`,
            [roleId, orgId]
        );
        if (targetRes.rows.length === 0) {
            return res.status(404).json({ message: 'Role not found' });
        }
        const targetLevel = Number(targetRes.rows[0].level);

        if (!requester.isOwner && targetLevel >= requester.level) {
            return res.status(403).json({ message: 'Forbidden: Cannot delete a role at or above your own rank' });
        }

        const deleteQuery = `DELETE FROM org_roles WHERE id = $1 AND org_id = $2 RETURNING id`;
        const result = await pool.query(deleteQuery, [roleId, orgId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Role not found' });
        }
        await publishEvent(`specter.event.org.${orgId}`, { type: 'role_deleted', roleId });
        res.status(200).json({ message: 'Role deleted successfully' });
    } catch (err) {
        console.error('Error deleting role', err);
        res.status(500).json({ message: 'Server error deleting role' });
    }
};
