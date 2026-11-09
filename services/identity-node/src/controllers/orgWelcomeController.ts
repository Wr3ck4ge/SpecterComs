// Server welcome panel — GET/PUT /orgs/:id/welcome (routes/org.ts).
//
// Members-facing "Welcome to <server>" content shown in the tray strip:
// subtitle + ordered markdown sections, with the org's logo and banner_url.
// Separate from the PUBLIC website landing fields (updateOrgLanding).
//
// NOT end-to-end encrypted: this is server-side org metadata, like the
// server name — the server stores and serves it in the clear to members.
import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { publishEvent } from '../config/nats.js';
import { canEditWelcome, parseWelcomeUpdate, readSections } from '../utils/orgWelcome.js';

/** The caller's membership row with the org's welcome columns, or null. */
async function loadForMember(orgId: string, userId: string) {
  const r = await pool.query(
    `SELECT o.id, o.callsign, o.owner_id, o.logo_path, o.banner_url, o.landing_description,
            o.welcome_subtitle, o.welcome_sections, o.welcome_updated_at,
            r.name AS role_name, r.permissions AS role_permissions
       FROM org_members om
       JOIN organizations o ON o.id = om.org_id
       LEFT JOIN org_roles r ON r.id = om.role_id
      WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId],
  );
  return r.rows[0] || null;
}

function welcomeBody(row: any, userId: string) {
  const canEdit = canEditWelcome(userId, row, { name: row.role_name, permissions: row.role_permissions });
  const updated = row.welcome_updated_at ? new Date(row.welcome_updated_at).toISOString() : null;
  return {
    org_id: row.id,
    name: row.callsign,
    logo_url: row.logo_path ? `/uploads/${row.logo_path}` : null,
    banner_url: row.banner_url || null,
    subtitle: row.welcome_subtitle || null,
    sections: readSections(row.welcome_sections),
    updated_at: updated,
    can_edit: canEdit,
    // Editors only: prefill for the editor's "Copy from public page".
    ...(canEdit ? { landing_description: row.landing_description || null } : {}),
  };
}

const isUuid = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export const getOrgWelcome = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const orgId = String(req.params.id);
  if (!userId) return res.status(401).json({ message: 'User not authenticated' });
  if (!isUuid(orgId)) return res.status(403).json({ message: 'Not a member of this server' });
  try {
    const row = await loadForMember(orgId, userId);
    if (!row) return res.status(403).json({ message: 'Not a member of this server' });
    return res.json(welcomeBody(row, userId));
  } catch (error) {
    console.error('Get Org Welcome Error:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
};

export const updateOrgWelcome = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const orgId = String(req.params.id);
  if (!userId) return res.status(401).json({ message: 'User not authenticated' });
  if (!isUuid(orgId)) return res.status(403).json({ message: 'Not a member of this server' });
  try {
    const row = await loadForMember(orgId, userId);
    if (!row) return res.status(403).json({ message: 'Not a member of this server' });
    if (!canEditWelcome(userId, row, { name: row.role_name, permissions: row.role_permissions })) {
      return res.status(403).json({ message: 'Only the owner and server admins can edit the welcome page' });
    }
    const parsed = parseWelcomeUpdate(req.body);
    if (!parsed.ok) return res.status(400).json({ message: parsed.error });

    const values: unknown[] = [];
    const sets: string[] = [];
    const set = (col: string, val: unknown, cast = '') => { values.push(val); sets.push(`${col} = $${values.length}${cast}`); };
    if (parsed.subtitle !== undefined) set('welcome_subtitle', parsed.subtitle);
    if (parsed.sections !== undefined) set('welcome_sections', JSON.stringify(parsed.sections), '::jsonb');
    values.push(orgId);
    const upd = await pool.query(
      `UPDATE organizations SET ${sets.join(', ')}, welcome_updated_at = clock_timestamp()
        WHERE id = $${values.length} RETURNING welcome_updated_at`,
      values,
    );
    const updatedAt = new Date(upd.rows[0].welcome_updated_at).toISOString();

    // Open clients refetch (the strip's useStripOps → StripApp).
    await publishEvent(`specter.event.org.${orgId}`, {
      type: 'welcome_updated', org_id: orgId, updated_at: updatedAt,
    });

    const fresh = await loadForMember(orgId, userId);
    return res.json(welcomeBody(fresh, userId));
  } catch (error) {
    console.error('Update Org Welcome Error:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
};
