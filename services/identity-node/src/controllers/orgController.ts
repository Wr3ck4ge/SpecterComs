import { Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { CreateOrgInput } from '../utils/validation.js';
import { getActiveMediaUrl, getNodeForOrg, getBestSharedNode } from '../utils/discovery.js';
import { getOrgTierConfig } from '../utils/orgTiers.js';
import { publishEvent } from '../config/nats.js';
import { getJwtSecret } from '../config/jwtSecret.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_BASE = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const ORG_LOGOS_DIR = path.join(UPLOADS_BASE, 'org-logos');
fs.mkdirSync(ORG_LOGOS_DIR, { recursive: true });

const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ORG_LOGOS_DIR),
  filename: (req, file, cb) => {
    const orgId = req.params.id ?? 'unknown';
    const ext = file.mimetype === 'image/png' ? 'png'
      : file.mimetype === 'image/gif' ? 'gif'
      : file.mimetype === 'image/webp' ? 'webp'
      : 'jpg';
    cb(null, `${orgId}.${ext}`);
  },
});

const imageFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only image files are allowed (jpg, png, gif, webp)'));
};

export const orgLogoUpload = multer({
  storage: logoStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Default permissions for roles
const ADMIN_PERMISSIONS = {
  can_kick: true,
  can_ban: true,
  can_mute: true,
  can_manage_roles: true,
  can_manage_channels: true,
  can_invite: true,
  can_view_calendar: true,
  can_create_events: true,
  can_view_billing: true,
};

const MEMBER_PERMISSIONS = {
  can_view_calendar: true,
  can_invite: true
};

const OFFICER_PERMISSIONS = {
  can_view_calendar: true,
  can_create_events: true,
  can_manage_channels: true,
  can_manage_roles: false,
  can_invite: true,
  can_view_billing: true
};

export const createOrg = async (req: AuthRequest, res: Response) => {
  const { callsign, description, is_public, join_method } = req.body as CreateOrgInput;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Create Organization
    const createOrgRes = await client.query(
      `INSERT INTO organizations (callsign, owner_id, description, is_public, join_method)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, callsign`,
      [callsign, userId, description || '', is_public || false, join_method || 0]
    );
    const org = createOrgRes.rows[0];

    // 2. Create Default Roles
    // Admin Role
    const adminRoleRes = await client.query(
      `INSERT INTO org_roles (org_id, name, permissions, level)
       VALUES ($1, 'Commander', $2, 100)
       RETURNING id`,
      [org.id, JSON.stringify(ADMIN_PERMISSIONS)]
    );
    const adminRoleId = adminRoleRes.rows[0].id;

    // Guest Role (lowest tier — can be renamed by owner)
    await client.query(
      `INSERT INTO org_roles (org_id, name, permissions, level)
       VALUES ($1, 'Guest', $2, 0)
       RETURNING id`,
      [org.id, JSON.stringify({})]
    );

    // Default Member Role
    const memberRoleRes = await client.query(
      `INSERT INTO org_roles (org_id, name, permissions, level)
       VALUES ($1, 'Operative', $2, 10)
       RETURNING id`,
      [org.id, JSON.stringify(MEMBER_PERMISSIONS)]
    );
    const memberRoleId = memberRoleRes.rows[0].id;

    // Officer Role
    await client.query(
      `INSERT INTO org_roles (org_id, name, permissions, level)
       VALUES ($1, 'Officer', $2, 50)
       RETURNING id`,
      [org.id, JSON.stringify(OFFICER_PERMISSIONS)]
    );

    await client.query(
      `INSERT INTO org_members (org_id, user_id, role_id, joined_at)
       VALUES ($1, $2, $3, NOW())`,
      [org.id, userId, adminRoleId]
    );

    // 4. Update Organization with Default Role
    await client.query(
      `UPDATE organizations SET default_role_id = $1 WHERE id = $2`,
      [memberRoleId, org.id]
    );

    await client.query('COMMIT');

    // Notify the creator's SSE stream so their org list updates
    await publishEvent(`specter.event.user.${userId}`, {
      type: 'org_created', org: { id: org.id, callsign: org.callsign },
    });

    res.status(201).json({
      message: 'Organization created successfully',
      org: {
        id: org.id,
        callsign: org.callsign
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create Org Error:', error);
    if ((error as any).code === '23505') { // unique_violation
        return res.status(409).json({ message: 'Organization callsign already taken' });
    }
    res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    client.release();
  }
};

export const getMyOrgs = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  try {
    const result = await pool.query(
      `SELECT o.id, o.callsign, o.description, o.is_public, o.join_method, o.owner_id, r.name as role_name,
              r.permissions, r.id as role_id, COALESCE(r.level, 0) as role_level,
              om.alias_callsign, om.org_tag_override, o.tier,
              o.landing_description, o.banner_url, o.show_calendar_on_landing, o.logo_path
       FROM org_members om
       JOIN organizations o ON om.org_id = o.id
       LEFT JOIN org_roles r ON om.role_id = r.id
       WHERE om.user_id = $1`,
      [userId]
    );

    const orgs = result.rows.map((row: any) => ({
      ...row,
      logo_url: row.logo_path ? `/uploads/${row.logo_path}` : null,
    }));

    res.json({ orgs });
  } catch (error) {
    console.error('Get My Orgs Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

export const joinOrg = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const orgId = req.params.id;
  const { message } = req.body;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  const client = await pool.connect();
  try {
    // Check if org exists and get join details
    const orgRes = await client.query(
      `SELECT id, join_method, default_role_id, tier FROM organizations WHERE id = $1`,
      [orgId]
    );

    if (orgRes.rows.length === 0) {
      return res.status(404).json({ message: 'Organization not found' });
    }
    const org = orgRes.rows[0];

    // Check existing membership
    const memberRes = await client.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId]
    );
    if (memberRes.rows.length > 0) {
      return res.status(409).json({ message: 'Already a member' });
    }

    const banRes = await client.query(
      `SELECT 1 FROM org_bans WHERE org_id = $1 AND user_id = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
      [orgId, userId]
    );
    if (banRes.rows.length > 0) {
      return res.status(403).json({ message: 'You are banned from this organization' });
    }

    if (org.join_method === 0) {
      // Open Join — no member cap (tier no longer gates member count)
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role_id, joined_at)
         VALUES ($1, $2, $3, NOW())`,
        [orgId, userId, org.default_role_id]
      );

      // Notify org members that someone joined
      await publishEvent(`specter.event.org.${orgId}`, {
        type: 'member_joined', userId, orgId,
      });
      // Notify the joiner so their org list updates
      await publishEvent(`specter.event.user.${userId}`, {
        type: 'orgs_changed',
      });

      res.status(200).json({ message: 'Joined organization successfully' });

    } else if (org.join_method === 1) {
      // Application Required
      const appRes = await client.query(
        `SELECT 1 FROM org_applications WHERE org_id = $1 AND user_id = $2 AND status = 0`,
        [orgId, userId]
      );
      if (appRes.rows.length > 0) {
        return res.status(409).json({ message: 'Application already pending' });
      }

      await client.query(
        `INSERT INTO org_applications (org_id, user_id, message, status)
         VALUES ($1, $2, $3, 0)`,
        [orgId, userId, message || '']
      );
      res.status(202).json({ message: 'Application submitted' });

    } else {
      // Invite Only (2)
      res.status(403).json({ message: 'This organization is invite-only' });
    }

  } catch (error) {
    console.error('Join Org Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    client.release();
  }
};

export const redeemInvite = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const { code } = req.params;

  if (!userId) return res.status(401).json({ message: 'User not authenticated' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Find and validate invite code
    const inviteRes = await client.query(
      `SELECT i.org_id, i.assigned_role_id, i.uses_left, i.expires_at, o.callsign as org_callsign
       FROM org_invites i
       JOIN organizations o ON i.org_id = o.id
       WHERE i.code = $1`,
      [code]
    );

    if (inviteRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Invalid invite code' });
    }

    const invite = inviteRes.rows[0];

    // Check expiry
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ message: 'Invite code has expired' });
    }

    // Check uses
    if (invite.uses_left !== null && invite.uses_left <= 0) {
      await client.query('ROLLBACK');
      return res.status(410).json({ message: 'Invite code has no uses remaining' });
    }

    // 2. Check not already a member
    const memberCheck = await client.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [invite.org_id, userId]
    );
    if (memberCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Already a member of this organization' });
    }

    const banCheck = await client.query(
      `SELECT 1 FROM org_bans WHERE org_id = $1 AND user_id = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
      [invite.org_id, userId]
    );
    if (banCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You are banned from this organization' });
    }

    // 3. Add member (no member cap — tier no longer gates member count)
    await client.query(
      `INSERT INTO org_members (org_id, user_id, role_id, joined_at) VALUES ($1, $2, $3, NOW())`,
      [invite.org_id, userId, invite.assigned_role_id]
    );

    // 4. Decrement uses_left if not infinite
    if (invite.uses_left !== null) {
      await client.query(
        `UPDATE org_invites SET uses_left = uses_left - 1 WHERE code = $1`,
        [code]
      );
    }

    await client.query('COMMIT');

    // SSE: notify org members and the new member
    await publishEvent(`specter.event.org.${invite.org_id}`, { type: 'member_joined', userId, orgId: invite.org_id });
    await publishEvent(`specter.event.user.${userId}`, { type: 'orgs_changed' });

    res.status(200).json({
      message: 'Joined organization successfully',
      org: { id: invite.org_id, callsign: invite.org_callsign },
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Redeem Invite Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  } finally {
    client.release();
  }
};

export const getOrgToken = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const orgId = req.params.id;
  const { channel_id } = req.body as { channel_id?: string };

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  try {
    const orgRes = await pool.query(
      `SELECT r.name, r.permissions, o.tier
       FROM org_members om
       JOIN org_roles r ON om.role_id = r.id
       JOIN organizations o ON om.org_id = o.id
       WHERE om.org_id = $1 AND om.user_id = $2`,
      [orgId, userId]
    );

    if (orgRes.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }

    const { name: roleName, permissions, tier } = orgRes.rows[0];
    const tierConfig = getOrgTierConfig(tier);

    // Determine if this is an event-launched channel (has event_id set).
    // Priority ducking only activates in event channels; the priority level
    // comes from the user's event_group_roles.priority assignment (1=highest, 5=lowest).
    // Org commander (event commander) gets priority level 1 by default.
    let is_priority_channel = false;
    let priority_level = 5; // default: lowest priority (no ducking)
    // E2E voice relay cutover flag (see migration 000059) — decided once per
    // channel, defaults to false (today's server-mixed TLS-only voice) until a
    // channel is explicitly flipped for pilot. media-rust rejects a joiner
    // whose token disagrees with whatever mode the room already established at
    // first-join, the same defensive pattern as the channel_id binding below.
    let voice_relay = false;
    if (channel_id) {
      const chanRes = await pool.query(
        `SELECT event_id, COALESCE(is_frequency, false) AS is_frequency,
                COALESCE(voice_relay_mode, false) AS voice_relay_mode
         FROM channels WHERE id = $1 AND org_id = $2`,
        [channel_id, orgId]
      );
      const eventId = chanRes.rows.length > 0 ? chanRes.rows[0].event_id : null;
      const isFrequencyChannel: boolean = chanRes.rows.length > 0 ? chanRes.rows[0].is_frequency : false;
      voice_relay = chanRes.rows.length > 0 ? chanRes.rows[0].voice_relay_mode : false;
      is_priority_channel = eventId != null;

      if (eventId) {
        const evAccessRes = await pool.query(
          `SELECT access_mode, commander_user_id, command_channel_id
           FROM events WHERE id = $1`,
          [eventId]
        );

        const commandChannelId = evAccessRes.rows.length > 0 ? evAccessRes.rows[0].command_channel_id : null;
        const isCommandChannel = channel_id === commandChannelId;
        const isGroupChannel = !isFrequencyChannel && !isCommandChannel;

        // Group channels are always assignment-locked: only accepted members of
        // the specific group channel can obtain a token.
        if (isGroupChannel) {
          const grpRes = await pool.query(
            `SELECT 1 FROM event_group_members egm
             JOIN event_groups eg ON egm.group_id = eg.id
             WHERE eg.channel_id = $1 AND egm.user_id = $2 AND egm.status = 'accepted'
             LIMIT 1`,
            [channel_id, userId]
          );
          if ((grpRes.rowCount ?? 0) === 0)
            return res.status(403).json({ message: 'Not assigned to this group channel' });
        }

        // ── Event channel access enforcement ─────────────────────────────────
        // Restricted mode keeps elevated checks for command/frequency channels.
        if (evAccessRes.rows.length > 0) {
          const { access_mode, commander_user_id, command_channel_id } = evAccessRes.rows[0];
          if (access_mode === 'restricted') {
            const isCommander  = commander_user_id === userId;
            const canManageEvt = permissions?.can_manage_events === true ||
                                 permissions?.can_manage_channels === true;
            if (!isCommander && !canManageEvt) {
              if (channel_id === command_channel_id) {
                // Command channel — require any accepted membership in this event.
                const acceptedRes = await pool.query(
                  `SELECT 1 FROM event_group_members egm
                   JOIN event_groups eg ON egm.group_id = eg.id
                   WHERE eg.event_id = $1 AND egm.user_id = $2 AND egm.status = 'accepted'
                   LIMIT 1`,
                  [eventId, userId]
                );
                if ((acceptedRes.rowCount ?? 0) === 0)
                  return res.status(403).json({ message: 'Not assigned to this operation' });
              } else if (isFrequencyChannel) {
                // Liaison frequency — require the user's role to have access.
                const freqRes = await pool.query(
                  `SELECT 1 FROM event_frequency_roles efr
                   JOIN event_frequencies ef ON efr.frequency_id = ef.id
                   JOIN event_group_members egm ON egm.role_id = efr.role_id
                   JOIN event_groups eg ON egm.group_id = eg.id
                   WHERE ef.channel_id = $1 AND eg.event_id = $2
                     AND egm.user_id = $3 AND egm.status = 'accepted'
                   LIMIT 1`,
                  [channel_id, eventId, userId]
                );
                if ((freqRes.rowCount ?? 0) === 0)
                  return res.status(403).json({ message: 'Not authorised for this frequency' });
              }
            }
          }
        }

        // Check if user is the event commander → priority 1
        const cmdRes = await pool.query(
          `SELECT 1 FROM events WHERE id = $1 AND commander_user_id = $2`,
          [eventId, userId]
        );
        if (cmdRes.rowCount && cmdRes.rowCount > 0) {
          priority_level = 1;
        } else {
          // Check user's assigned role priority in their event group
          const roleRes = await pool.query(
            `SELECT COALESCE(egr.priority, 3) AS priority
             FROM event_group_members egm
             JOIN event_groups eg ON egm.group_id = eg.id
             LEFT JOIN event_group_roles egr ON egr.id = egm.role_id
             WHERE eg.event_id = $1 AND egm.user_id = $2 AND egm.status = 'accepted'
             ORDER BY COALESCE(egr.priority, 3) ASC
             LIMIT 1`,
            [eventId, userId]
          );
          if (roleRes.rows.length > 0) {
            priority_level = roleRes.rows[0].priority;
          }
        }
      }
    }

    // Generate Short-Lived Token (5 minutes)
    // max_video_bitrate_kbps is read by the media server to cap screenshare/video resolution
    // Include callsign so the media server can display it in roster
    const callsign = req.user?.callsign || '';
    // channel_id is bound into the token so the media relay can verify a
    // connection actually requests the same channel this token was authorized
    // for above — without this, a token minted for one (authorized) channel
    // could be replayed to connect to a different (unauthorized) one, since
    // the relay otherwise takes the connection's channel_id at face value.
    const token = jwt.sign(
      {
        sub: userId,
        org_id: orgId,
        role: roleName,
        permissions,
        callsign,
        max_video_bitrate_kbps: tierConfig.maxVideoBitrateKbps,
        is_priority_channel,
        priority_level,
        voice_relay,
        channel_id: channel_id || null,
      },
      getJwtSecret(),
      { expiresIn: '5m' }
    );

    // Phase A of multi-tenant infra: route to this org's assigned node if it has
    // one (and that node's heartbeat is live). Otherwise, the shared-node load
    // balancer picks whichever in-service node has the most headroom, so unpinned
    // orgs spread across the pool instead of all landing on one node. Falls back
    // to the legacy single-node cache only if literally no shared node is
    // in-service/online — an outage scenario, not the normal path.
    const assignedMediaUrl = await getNodeForOrg(orgId as string);
    const mediaUrl = assignedMediaUrl || (await getBestSharedNode()) || getActiveMediaUrl();
    // Surfaced alongside the token (rather than requiring the client to decode
    // its own JWT) so CommLink knows whether to actually encrypt/decrypt audio
    // before it starts sending — encrypting into a still-mixed-mode room would
    // break voice for everyone in it (the server mixer expects real Opus, not
    // SFrame ciphertext).
    res.json({ token, expires_in: 300, media_url: mediaUrl, voice_relay });

  } catch (error) {
    console.error('Get Org Token Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

export const updateOrgSettings = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const orgId = req.params.id;
  const { callsign, description, is_public, join_method, tier } = req.body;

  if (!userId) return res.status(401).json({ message: 'User not authenticated' });

  try {
    const orgRes = await pool.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
    if (orgRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });
    if (orgRes.rows[0].owner_id !== userId) return res.status(403).json({ message: 'Only the owner can update server settings' });

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (callsign !== undefined) { updates.push(`callsign = $${idx++}`); values.push(callsign); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (is_public !== undefined) { updates.push(`is_public = $${idx++}`); values.push(is_public); }
    if (join_method !== undefined) { updates.push(`join_method = $${idx++}`); values.push(join_method); }
    // tier: 0=Free Trial, 1=Ops Starter, 2=Ops Growth, 3=Ops Command — owner-settable for now; add billing gate here later
    if (tier !== undefined) {
      const t = Number(tier);
      if (!Number.isInteger(t) || t < 0 || t > 3) return res.status(400).json({ message: 'Invalid tier value' });
      updates.push(`tier = $${idx++}`); values.push(t);
    }

    if (updates.length === 0) return res.status(400).json({ message: 'No fields to update' });

    values.push(orgId);
    await pool.query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = $${idx}`, values);

    res.json({ message: 'Server settings updated' });
  } catch (error) {
    console.error('Update Org Settings Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

export const updateOrgLanding = async (req: AuthRequest, res: Response) => {
  const { id: orgId } = req.params;
  const userId = req.user?.id;
  const { landing_description, banner_url, show_calendar_on_landing } = req.body;

  if (!userId) return res.status(401).json({ message: 'User not authenticated' });

  try {
    const orgRes = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
    if (!orgRes.rows[0] || orgRes.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query(
      'UPDATE organizations SET landing_description=$1, banner_url=$2, show_calendar_on_landing=$3 WHERE id=$4',
      [landing_description ?? null, banner_url ?? null, show_calendar_on_landing ?? true, orgId]
    );
    return res.json({ ok: true });
  } catch (error) {
    console.error('Update Org Landing Error:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
};

export const updateMemberProfile = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const orgId = req.params.id;
  const { alias_callsign, org_tag_override } = req.body;

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  try {
    const memberCheck = await pool.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Not a member of this organization' });
    }

    await pool.query(
      `UPDATE org_members
       SET alias_callsign = $1, org_tag_override = $2
       WHERE org_id = $3 AND user_id = $4`,
      [alias_callsign || null, org_tag_override || null, orgId, userId]
    );

    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Update Member Profile Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

export const getPublicServers = async (req: AuthRequest, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        const offset = (page - 1) * limit;

        // This route isn't behind authenticateToken (anonymous discovery is allowed),
        // so a token here is optional — decode it if present just to exclude orgs the
        // caller is banned from; ignore silently if missing/invalid.
        let requesterId: string | null = null;
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (token) {
            try {
                const decoded: any = jwt.verify(token, getJwtSecret());
                requesterId = decoded?.id || null;
            } catch {
                // Not authenticated — treat as anonymous, still show all public servers.
            }
        }

        const query = `
            SELECT o.id, o.callsign, o.description, o.join_method, o.tier,
                   COUNT(m.user_id) as member_count
            FROM organizations o
            LEFT JOIN org_members m ON o.id = m.org_id
            WHERE o.is_public = true
              AND NOT EXISTS (
                  SELECT 1 FROM org_bans b
                  WHERE b.org_id = o.id AND b.user_id = $3
                    AND (b.expires_at IS NULL OR b.expires_at > NOW())
              )
            GROUP BY o.id
            ORDER BY member_count DESC
            LIMIT $1 OFFSET $2
        `;
        const result = await pool.query(query, [limit, offset, requesterId]);

        const countQuery = `
            SELECT COUNT(*) FROM organizations o
            WHERE o.is_public = true
              AND NOT EXISTS (
                  SELECT 1 FROM org_bans b
                  WHERE b.org_id = o.id AND b.user_id = $1
                    AND (b.expires_at IS NULL OR b.expires_at > NOW())
              )
        `;
        const countResult = await pool.query(countQuery, [requesterId]);
        const total = parseInt(countResult.rows[0].count);

        res.status(200).json({
            servers: result.rows,
            pagination: {
                total,
                page,
                limit,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('Error fetching public servers:', err);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

export const uploadOrgLogo = async (req: AuthRequest, res: Response): Promise<void> => {
  const orgId = req.params.id;
  const userId = req.user?.id;
  if (!userId) { res.status(401).json({ message: 'Unauthorized' }); return; }

  const orgRes = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
  if (!orgRes.rows[0]) { res.status(404).json({ message: 'Organization not found' }); return; }
  if (orgRes.rows[0].owner_id !== userId) { res.status(403).json({ message: 'Only the owner can set the server logo' }); return; }

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) { res.status(400).json({ message: 'No image file provided' }); return; }

  try {
    const old = await pool.query('SELECT logo_path FROM organizations WHERE id = $1', [orgId]);
    const oldPath = old.rows[0]?.logo_path as string | null;
    if (oldPath && oldPath !== `org-logos/${file.filename}`) {
      fs.unlink(path.join(UPLOADS_BASE, oldPath), () => {});
    }
  } catch {}

  const relativePath = `org-logos/${file.filename}`;
  try {
    await pool.query('UPDATE organizations SET logo_path = $1 WHERE id = $2', [relativePath, orgId]);
    res.json({ logo_url: `/uploads/${relativePath}` });
  } catch (err) {
    console.error('uploadOrgLogo error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createInvite = async (req: AuthRequest, res: Response) => {
  const orgId = req.params.id;
  const userId = req.user?.id;
  const { uses_left } = req.body;

  if (!userId) return res.status(401).json({ message: 'User not authenticated' });

  try {
    const ownerRes = await pool.query(
      `SELECT owner_id, default_role_id FROM organizations WHERE id = $1`,
      [orgId]
    );
    if (ownerRes.rows.length === 0) return res.status(404).json({ message: 'Organization not found' });

    const isOwner = ownerRes.rows[0].owner_id === userId;
    if (!isOwner) {
      const permRes = await pool.query(
        `SELECT r.permissions FROM org_members om
         JOIN org_roles r ON om.role_id = r.id
         WHERE om.org_id = $1 AND om.user_id = $2`,
        [orgId, userId]
      );
      const canInvite = permRes.rows.some((r: any) => r.permissions?.can_invite === true);
      if (!canInvite) return res.status(403).json({ message: 'Forbidden: Cannot create invites' });
    }

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await pool.query(
      `INSERT INTO org_invites (code, org_id, created_by, assigned_role_id, uses_left)
       VALUES ($1, $2, $3, $4, $5)`,
      [code, orgId, userId, ownerRes.rows[0].default_role_id || null, uses_left ?? null]
    );

    res.status(201).json({ code });
  } catch (error) {
    console.error('Create Invite Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
