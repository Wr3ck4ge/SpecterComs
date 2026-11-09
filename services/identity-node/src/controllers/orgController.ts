import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { altMediaUrlFor } from '../utils/mediaAltPort.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { CreateOrgInput, TEXT_LIMITS, textLength, tooLong } from '../utils/validation.js';
import { resolveMediaUrlForOrg } from '../utils/discovery.js';
import { getOrgTiers } from '../utils/orgTiers.js';
import { getEffectiveTierConfig } from '../utils/billingCycle.js';
import { billingEnforced } from '../config/billingConfig.js';
import { publishEvent } from '../config/nats.js';
import { getJwtSecret } from '../config/jwtSecret.js';
import { signMediaTicket } from '../config/mediaTicketKey.js';
import { meetsVoiceMinimum, upgradeRequiredBody } from '../utils/voiceClientGate.js'; // E2EV
import { getChannelScope, canUseChannel, loadEventAudience, missionWideAccess, resolveFrequencyShare } from '../utils/eventChannelAccess.js'; // EVMLS / OPTREE / Mission Wide / op-wide share
import { RELAY_LEVEL_COMMANDER, RELAY_LEVEL_NONE, eventTicketPriorityLevel, rolePriorityToRelayLevel } from '../utils/rolePriority.js';

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
  can_view_members: true,
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
              o.landing_description, o.banner_url, o.show_calendar_on_landing, o.logo_path,
              o.welcome_updated_at -- the strip shows the welcome pane once per value
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

    // 1. Find the invite code. FOR UPDATE OF i serializes concurrent redeems
    // of the same code (a double-fired request, or two users racing for the
    // last use), so the membership check and uses_left below are consistent.
    const inviteRes = await client.query(
      `SELECT i.org_id, i.assigned_role_id, i.uses_left, i.expires_at, o.callsign as org_callsign
       FROM org_invites i
       JOIN organizations o ON i.org_id = o.id
       WHERE i.code = $1
       FOR UPDATE OF i`,
      [code]
    );

    if (inviteRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Invalid invite code' });
    }

    const invite = inviteRes.rows[0];

    // 2. Already a member → idempotent success. Checked before expiry/uses so
    // a retried or double-fired redeem (e.g. the website's /join/:code page
    // under StrictMode, or a lost response) answers the same way the first
    // one did, and never consumes a second use.
    const memberCheck = await client.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [invite.org_id, userId]
    );
    if (memberCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({
        message: 'Already a member of this organization',
        already_member: true,
        org: { id: invite.org_id, callsign: invite.org_callsign },
      });
    }

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

    const banCheck = await client.query(
      `SELECT 1 FROM org_bans WHERE org_id = $1 AND user_id = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
      [invite.org_id, userId]
    );
    if (banCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'You are banned from this organization' });
    }

    // 3. Add member (no member cap — tier no longer gates member count).
    // ON CONFLICT covers a concurrent join through another path (a different
    // invite code, or /join) that the invite row lock doesn't serialize: if
    // the row already exists, this redeem added nobody and uses no invite.
    const added = await client.query(
      `INSERT INTO org_members (org_id, user_id, role_id, joined_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [invite.org_id, userId, invite.assigned_role_id]
    );
    if (added.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({
        message: 'Already a member of this organization',
        already_member: true,
        org: { id: invite.org_id, callsign: invite.org_callsign },
      });
    }

    // 4. Decrement uses_left if not infinite
    if (invite.uses_left !== null) {
      await client.query(
        `UPDATE org_invites SET uses_left = uses_left - 1 WHERE code = $1 AND uses_left > 0`,
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
  const orgId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { channel_id } = req.body as { channel_id?: string };

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }

  try {
    const ctx = await getOrgChannelAccessContext({
      userId,
      orgId,
      channelId: channel_id,
    });

    // 5-minute media token consumed by media-rust.
    const callsign = req.user?.callsign || '';
    // Bind channel_id to prevent cross-channel token replay.
    const token = jwt.sign(
      {
        sub: userId,
        org_id: orgId,
        role: ctx.roleName,
        permissions: ctx.permissions,
        callsign,
        max_video_bitrate_kbps: ctx.tierConfig.maxVideoBitrateKbps,
        is_priority_channel: ctx.isPriorityChannel,
        priority_level: ctx.priorityLevel,
        voice_relay: ctx.voiceRelay,
        channel_id: channel_id || null,
      },
      getJwtSecret(),
      { expiresIn: '5m' }
    );

    // Prefer org-assigned media node; otherwise choose healthiest shared node.
    const mediaUrl = ctx.mediaUrl;
    // E2EV: this legacy token carries no `purpose`, so media-rust never
    // accepts it for voice (voice needs a media-ticket, which is where the
    // client-version gate lives). voice_relay is always true now.
    res.json({ token, expires_in: 300, media_url: mediaUrl, voice_relay: ctx.voiceRelay });

  } catch (error) {
    console.error('Get Org Token Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

const getOrgChannelAccessContext = async ({
  userId,
  orgId,
  channelId,
}: {
  userId: string;
  orgId?: string;
  channelId?: string;
}) => {
  if (!orgId) {
    throw new Error('Missing organization id');
  }

  const orgRes = await pool.query(
    `SELECT r.name, r.permissions, o.tier
     FROM org_members om
     JOIN org_roles r ON om.role_id = r.id
     JOIN organizations o ON om.org_id = o.id
     WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId]
  );

  if (orgRes.rows.length === 0) {
    const err = new Error('Not a member of this organization') as Error & { status?: number };
    err.status = 403;
    throw err;
  }

  const { name: roleName, permissions, tier } = orgRes.rows[0];
  // Effective tier: the org's own, or the run-dry fallback when BILLING_ENFORCE
  // is on and its pool has been negative past the grace period. Applied only
  // to newly issued tokens — live sessions are never cut or downgraded mid-op,
  // and voice itself is never gated.
  const tierConfig = await getEffectiveTierConfig(orgId, tier);

  let isPriorityChannel = false;
  let priorityLevel = RELAY_LEVEL_NONE; // media-rust's scale: see utils/rolePriority
  // E2EV: end-to-end encrypted relay voice is the only voice mode from 2.0.0
  // on — every voice room is a relay room, whatever channels.voice_relay_mode
  // says (migration 000064 sets it TRUE everywhere; the column is kept only so
  // a server rollback still finds it). media-rust rejects non-relay joins.
  const voiceRelay = true;
  let channelEventId: string | null = null;
  // Mission Wide (phase 3): set when channelId is an EVENT id — that event's
  // one-way commander broadcast room. listenOnly = receive-only ticket.
  let missionWide: { eventId: string; listenOnly: boolean } | null = null;
  // Op-wide share: the event channel's kind, and whether its op is live.
  let channelKind: string | null = null;
  let opLive = false;

  if (channelId) {
    const chanRes = await pool.query(
      `SELECT event_id FROM channels WHERE id = $1 AND org_id = $2`,
      [channelId, orgId]
    );
    if (chanRes.rows.length === 0) {
      // Not a channel of this org. If it is an event id, this is a Mission
      // Wide ticket request. Without this check an event id fell through as
      // an unchecked "org channel" and got a two-way ticket for the room.
      const evRes = await pool.query(
        `SELECT org_id, launched, ended_at FROM events WHERE id::text = $1`,
        [channelId]
      );
      if (evRes.rows.length > 0) {
        const ev = evRes.rows[0];
        const deny = (message: string) => {
          const err = new Error(message) as Error & { status?: number };
          err.status = 403;
          return err;
        };
        if (ev.org_id !== orgId) throw deny('Not assigned to this operation');
        if (!ev.launched || ev.ended_at) throw deny('Mission Wide is only available while the operation is live');
        const access = missionWideAccess(await loadEventAudience(channelId), userId);
        if (!access.rx) throw deny('Not assigned to this operation');
        missionWide = { eventId: channelId, listenOnly: !access.tx };
        channelEventId = channelId;
      }
    }
    const eventId = chanRes.rows.length > 0 ? chanRes.rows[0].event_id : null;
    channelEventId = eventId ?? channelEventId; // Mission Wide set it above
    isPriorityChannel = eventId != null;

    // Rank-restricted org channel (channels.visible_min_level): same rule as
    // the channel list, presence and its MLS key (utils/orgAuthority).
    if (!eventId && chanRes.rows.length > 0) {
      const scope = await getChannelScope(channelId, orgId);
      if (scope && !(await canUseChannel(scope, userId))) {
        const err = new Error('This channel is restricted to higher ranks') as Error & { status?: number };
        err.status = 403;
        throw err;
      }
    }

    if (eventId) {
      // EVMLS: one access rule for every event channel (utils/eventChannelAccess):
      // signed-up (accepted) members with access to THIS channel, plus the
      // event's staff on command/frequency channels — whatever access_mode
      // says. The same list is the channel's MLS membership, so a ticket is
      // never issued to someone the channel's key is withheld from.
      const scope = await getChannelScope(channelId, orgId);
      if (scope && scope.scope === 'event') {
        channelKind = scope.kind;
        const live = await pool.query(`SELECT launched, ended_at FROM events WHERE id = $1`, [eventId]);
        opLive = Boolean(live.rows[0]?.launched && !live.rows[0]?.ended_at);
      }
      if (scope && scope.scope === 'event' && !(await canUseChannel(scope, userId))) {
        const message = scope.kind === 'group' ? 'Only members of this group can join its channel'
          : scope.kind === 'frequency' ? 'Not authorised for this frequency'
          : 'Not assigned to this operation';
        const err = new Error(message) as Error & { status?: number };
        err.status = 403;
        throw err;
      }

      // Role priority dictates ducking WITHIN a channel: media-rust's relay
      // keeps priority_levels per room and, while a priority speaker talks,
      // sends a Duck to that room's listeners only. Frequency overlay phase 2
      // retired the cross-channel cascade (publishEventTree sends a flat
      // tree), so the old "only commanders are priority speakers in the
      // command channel" special case is gone — every event channel (a legacy
      // command channel included) uses the same rule below.
      // FREQPRIO: a frequency channel uses ONLY the member's own priority on
      // that frequency (default if unset) — never their group role priority,
      // and the commander is not raised automatically there.
      if (scope && scope.scope === 'event' && scope.kind === 'frequency') {
        let frequencyPriority: number | null = null;
        if (scope.frequencyId) {
          const fp = await pool.query(
            `SELECT priority FROM event_frequency_members WHERE frequency_id = $1 AND user_id = $2`,
            [scope.frequencyId, userId]
          );
          frequencyPriority = fp.rows[0]?.priority ?? null;
        }
        priorityLevel = eventTicketPriorityLevel({ kind: 'frequency', isEventCommander: false, groupRolePriority: null, frequencyPriority });
      } else {
        const cmdRes = await pool.query(
          `SELECT 1 FROM events WHERE id = $1 AND commander_user_id = $2`,
          [eventId, userId]
        );
        if (cmdRes.rowCount && cmdRes.rowCount > 0) {
          priorityLevel = RELAY_LEVEL_COMMANDER;
        } else {
          const roleRes = await pool.query(
            `SELECT COALESCE(egr.priority, 3) AS priority
             FROM event_group_members egm
             JOIN event_groups eg ON egm.group_id = eg.id
             LEFT JOIN event_group_roles egr ON egr.id = egm.role_id
             WHERE eg.event_id = $1 AND egm.user_id = $2 AND egm.status = 'accepted'
             ORDER BY COALESCE(egr.priority, 3) DESC
             LIMIT 1`,
            [eventId, userId]
          );
          if (roleRes.rows.length > 0) {
            // The member's highest role: on the planner's scale 5 outranks 1.
            priorityLevel = rolePriorityToRelayLevel(roleRes.rows[0].priority);
          }
        }
      }
    }
  }

  const mediaUrl = await resolveMediaUrlForOrg(orgId as string);

  return {
    roleName,
    permissions,
    tierConfig,
    isPriorityChannel,
    priorityLevel,
    voiceRelay,
    eventId: channelEventId,
    missionWide,
    channelKind,
    opLive,
    mediaUrl,
  };
};

/** POST /orgs/:id/media-ticket — mint short-lived, scoped media tickets. */
export const issueOrgMediaTicket = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id;
  const orgId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const { channel_id, kind, sharer, client_version } = req.body as {
    channel_id?: string;
    kind?: 'voice' | 'video_publish' | 'video_subscribe' | 'video_subscribe_overlay';
    sharer?: string;
    client_version?: string;
  };

  if (!userId) {
    return res.status(401).json({ message: 'User not authenticated' });
  }
  if (!channel_id) {
    return res.status(400).json({ message: 'channel_id is required' });
  }

  const allowedKinds = new Set(['voice', 'video_publish', 'video_subscribe', 'video_subscribe_overlay']);
  if (!kind || !allowedKinds.has(kind)) {
    return res.status(400).json({ message: 'Invalid media ticket kind' });
  }
  if ((kind === 'video_subscribe' || kind === 'video_subscribe_overlay') && !sharer) {
    return res.status(400).json({ message: 'sharer is required for subscribe tickets' });
  }
  // E2EV: voice is relay-only (end-to-end encrypted) from 2.0.0; older
  // clients (which never send client_version) can't speak or play it. 426
  // with a message old clients display as-is. Video tickets are unaffected.
  if (kind === 'voice' && !meetsVoiceMinimum(client_version)) {
    return res.status(426).json(upgradeRequiredBody());
  }

  try {
    const ctx = await getOrgChannelAccessContext({
      userId,
      orgId,
      channelId: channel_id,
    });

    // Mission Wide is voice-only: no screen share / video in that room.
    if (ctx.missionWide && kind !== 'voice') {
      return res.status(403).json({ message: 'Mission Wide is voice only' });
    }

    // Op-wide share: a video_subscribe against a FREQUENCY channel (the
    // viewer is on it — checked above) asks for a sharer's stream in that
    // sharer's group channel. Minted for that group channel, pinned to that
    // sharer, subscribe only (eventChannelAccess.frequencyShareAccess).
    let ticketChannelId = channel_id;
    if (ctx.channelKind === 'frequency' && kind === 'video_subscribe' && ctx.eventId) {
      const share = await resolveFrequencyShare(orgId as string, ctx.eventId, userId, String(sharer), kind);
      if (!share.ok) return res.status(403).json({ message: share.reason });
      ticketChannelId = share.groupChannelId;
    }
    // A share in a live op's group channel (or via a frequency) uses the
    // op-wide key (event MLS group, label 'video-op'), not the channel's.
    const opVideo = ctx.opLive && ctx.eventId
      && (ctx.channelKind === 'group' || ticketChannelId !== channel_id);

    const expiresInSeconds = 90;
    const purpose = kind === 'voice' ? 'media_voice' : 'media_video';
    const mediaRole = kind === 'voice'
      ? 'voice'
      : (kind === 'video_publish' ? 'publish' : kind === 'video_subscribe' ? 'subscribe' : 'subscribe_overlay');

    // ES256 with MEDIA_TICKET_PRIVATE_KEY (nodes hold only the public key), or
    // legacy HS256 over JWT_SECRET while that key is unset (config/mediaTicketKey.ts).
    const ticket = signMediaTicket(
      {
        sub: userId,
        org_id: orgId,
        channel_id: ticketChannelId,
        callsign: req.user?.callsign || '',
        purpose,
        media_role: mediaRole,
        sharer: sharer || null,
        role: ctx.roleName,
        permissions: ctx.permissions,
        is_priority_channel: ctx.isPriorityChannel,
        priority_level: ctx.priorityLevel,
        voice_relay: ctx.voiceRelay,
        // E2EV: signed proof the version gate above passed — media-rust
        // refuses a voice join whose ticket lacks it (or is below its own
        // minimum), so tickets minted by a pre-gate server are useless.
        ...(kind === 'voice' ? { client_version: String(client_version).trim() } : {}),
        // Mission Wide: non-commanders join receive-only; media-rust drops
        // every audio datagram from a listen_only session.
        ...(ctx.missionWide ? { listen_only: ctx.missionWide.listenOnly } : {}),
        max_video_bitrate_kbps: ctx.tierConfig.maxVideoBitrateKbps,
        jti: crypto.randomUUID(),
      },
      expiresInSeconds,
    );

    return res.json({
      ticket,
      expires_in_seconds: expiresInSeconds,
      media_url: ctx.mediaUrl,
      // Same relay on its alternate UDP port (WEBTRANSPORT_ALT_PORT), or null.
      alt_media_url: altMediaUrlFor(ctx.mediaUrl),
      voice_relay: ctx.voiceRelay,
      // The channel's event (if any) — a relay-mode client needs it to derive
      // the event-scoped 'audio-cascade' key for is_global_broadcast frames
      // (useMonitorChannel's channel objects don't otherwise carry it).
      event_id: ctx.eventId,
      // Mission Wide room only: whether this ticket may transmit.
      ...(ctx.missionWide ? { mission_wide: true, listen_only: ctx.missionWide.listenOnly } : {}),
      // Op-wide share: the room the ticket is for (the sharer's group channel
      // when asked via a frequency) and which video key this room's shares use.
      channel_id: ticketChannelId,
      video_key_scope: opVideo ? 'op' : 'channel',
    });
  } catch (error: any) {
    if (error?.status) {
      return res.status(error.status).json({ message: error.message });
    }
    console.error('Issue Media Ticket Error:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
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

    if (callsign !== undefined) {
      // Same rule as createOrgSchema: 3–64 characters, not blank.
      const n = typeof callsign === 'string' ? textLength(callsign.trim()) : 0;
      if (n < 3 || n > TEXT_LIMITS.orgCallsign) {
        return res.status(400).json({ message: `Server name must be 3–${TEXT_LIMITS.orgCallsign} characters` });
      }
      updates.push(`callsign = $${idx++}`); values.push(callsign.trim());
    }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (is_public !== undefined) { updates.push(`is_public = $${idx++}`); values.push(is_public); }
    if (join_method !== undefined) { updates.push(`join_method = $${idx++}`); values.push(join_method); }
    // tier: ids/prices come from billing config (config/billingConfig.ts). Free to
    // change while BILLING_ENFORCE is off; with it on, a paid tier needs one
    // cycle's price already in the pool (billing gate — see utils/billingCycle.ts).
    if (tier !== undefined) {
      const t = Number(tier);
      const tierCfg = Number.isInteger(t) ? getOrgTiers().find(x => x.id === t) : undefined;
      if (!tierCfg || !tierCfg.selectable) return res.status(400).json({ message: 'Invalid tier value' });
      if (billingEnforced(String(orgId)) && tierCfg.priceCents > 0) {
        const balRes = await pool.query(`SELECT balance_cents FROM org_billing WHERE org_id = $1`, [orgId]);
        const balance = Number(balRes.rows[0]?.balance_cents ?? 0);
        if (balance < tierCfg.priceCents) {
          return res.status(402).json({
            message: `${tierCfg.name} needs at least one month (${(tierCfg.priceCents / 100).toFixed(2)}) in the server wallet first`,
          });
        }
      }
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
  const { description, landing_description, banner_url, show_calendar_on_landing } = req.body;

  if (!userId) return res.status(401).json({ message: 'User not authenticated' });
  if (description !== undefined && (typeof description !== 'string' || description.trim().length > 500)) {
    return res.status(400).json({ message: 'Description must be at most 500 characters' });
  }

  try {
    const orgRes = await pool.query('SELECT owner_id FROM organizations WHERE id = $1', [orgId]);
    if (!orgRes.rows[0] || orgRes.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    // Only the fields actually sent change: the website's landing form never
    // sends banner_url, which used to wipe the banner on every save.
    const updates: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => { values.push(val); updates.push(`${col} = $${values.length}`); };
    if (description !== undefined) set('description', description.trim());
    if (landing_description !== undefined) set('landing_description', landing_description ?? null);
    if (banner_url !== undefined) set('banner_url', banner_url ?? null);
    if (show_calendar_on_landing !== undefined) set('show_calendar_on_landing', show_calendar_on_landing !== false);
    if (updates.length > 0) {
      values.push(orgId);
      await pool.query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
    }
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
  const profileLimitErr = tooLong('Alias', alias_callsign, TEXT_LIMITS.memberAlias)
    ?? tooLong('Tag', org_tag_override, TEXT_LIMITS.memberTag);
  if (profileLimitErr) return res.status(400).json({ message: profileLimitErr });

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

        // Optional name search (case-insensitive substring; LIKE wildcards escaped).
        const rawQ = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : '';
        const likeQ = rawQ ? `%${rawQ.replace(/[\\%_]/g, '\\$&')}%` : null;

        const query = `
            SELECT o.id, o.callsign, o.description, o.join_method, o.tier, o.logo_path,
                   COUNT(m.user_id) as member_count
            FROM organizations o
            LEFT JOIN org_members m ON o.id = m.org_id
            WHERE o.is_public = true
              AND ($4::text IS NULL OR o.callsign ILIKE $4)
              AND NOT EXISTS (
                  SELECT 1 FROM org_bans b
                  WHERE b.org_id = o.id AND b.user_id = $3
                    AND (b.expires_at IS NULL OR b.expires_at > NOW())
              )
            GROUP BY o.id
            ORDER BY member_count DESC
            LIMIT $1 OFFSET $2
        `;
        const result = await pool.query(query, [limit, offset, requesterId, likeQ]);

        const countQuery = `
            SELECT COUNT(*) FROM organizations o
            WHERE o.is_public = true
              AND ($2::text IS NULL OR o.callsign ILIKE $2)
              AND NOT EXISTS (
                  SELECT 1 FROM org_bans b
                  WHERE b.org_id = o.id AND b.user_id = $1
                    AND (b.expires_at IS NULL OR b.expires_at > NOW())
              )
        `;
        const countResult = await pool.query(countQuery, [requesterId, likeQ]);
        const total = parseInt(countResult.rows[0].count);

        res.status(200).json({
            servers: result.rows.map((r: any) => {
                const { logo_path, ...rest } = r;
                return { ...rest, logo_url: logo_path ? `/uploads/${logo_path}` : null };
            }),
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

// Owner, or a member whose role has can_invite. Returns the org row (for the
// default role) on success, or sends the error response and returns null.
async function requireInviteManager(orgId: string, userId: string, res: Response) {
  const ownerRes = await pool.query(
    `SELECT owner_id, default_role_id FROM organizations WHERE id = $1`,
    [orgId]
  );
  if (ownerRes.rows.length === 0) {
    res.status(404).json({ message: 'Organization not found' });
    return null;
  }
  if (ownerRes.rows[0].owner_id !== userId) {
    const permRes = await pool.query(
      `SELECT r.permissions FROM org_members om
       JOIN org_roles r ON om.role_id = r.id
       WHERE om.org_id = $1 AND om.user_id = $2`,
      [orgId, userId]
    );
    const canInvite = permRes.rows.some((r: any) => r.permissions?.can_invite === true);
    if (!canInvite) {
      res.status(403).json({ message: 'Forbidden: Cannot manage invites' });
      return null;
    }
  }
  return ownerRes.rows[0];
}

export const createInvite = async (req: AuthRequest, res: Response) => {
  const orgId = String(req.params.id);
  const userId = req.user?.id;
  const { uses_left, expires_in_hours } = req.body || {};

  if (!userId) return res.status(401).json({ message: 'User not authenticated' });

  // Optional limits: max uses (1-1000) and lifetime in hours (1 hour - 1 year).
  // Omitted/null = unlimited / never expires (the previous behaviour).
  let uses: number | null = null;
  if (uses_left !== undefined && uses_left !== null) {
    uses = Number(uses_left);
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) {
      return res.status(400).json({ message: 'uses_left must be a whole number from 1 to 1000' });
    }
  }
  let expiresAt: Date | null = null;
  if (expires_in_hours !== undefined && expires_in_hours !== null) {
    const hours = Number(expires_in_hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 365) {
      return res.status(400).json({ message: 'expires_in_hours must be between 1 and 8760' });
    }
    expiresAt = new Date(Date.now() + hours * 3600_000);
  }

  try {
    const org = await requireInviteManager(orgId, userId, res);
    if (!org) return;

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    await pool.query(
      `INSERT INTO org_invites (code, org_id, created_by, assigned_role_id, uses_left, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code, orgId, userId, org.default_role_id || null, uses, expiresAt]
    );

    res.status(201).json({ code, uses_left: uses, expires_at: expiresAt });
  } catch (error) {
    console.error('Create Invite Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

// Live invites of a server (not expired, uses remaining) for the people who
// may create them. Codes are only shown to managers.
export const listInvites = async (req: AuthRequest, res: Response) => {
  const orgId = String(req.params.id);
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'User not authenticated' });
  try {
    if (!(await requireInviteManager(orgId, userId, res))) return;
    const result = await pool.query(
      `SELECT i.code, i.uses_left, i.expires_at, i.created_at,
              i.created_by, u.callsign AS created_by_callsign
       FROM org_invites i
       LEFT JOIN users u ON u.id = i.created_by
       WHERE i.org_id = $1
         AND (i.expires_at IS NULL OR i.expires_at > NOW())
         AND (i.uses_left IS NULL OR i.uses_left > 0)
       ORDER BY i.created_at DESC
       LIMIT 200`,
      [orgId]
    );
    res.json({ invites: result.rows });
  } catch (error) {
    console.error('List Invites Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};

// Kill an invite link: it stops working immediately. Anyone who already
// joined with it stays a member.
export const revokeInvite = async (req: AuthRequest, res: Response) => {
  const orgId = String(req.params.id);
  const code = String(req.params.code || '').toUpperCase();
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'User not authenticated' });
  try {
    if (!(await requireInviteManager(orgId, userId, res))) return;
    const del = await pool.query(
      `DELETE FROM org_invites WHERE code = $1 AND org_id = $2`,
      [code, orgId]
    );
    if (del.rowCount === 0) return res.status(404).json({ message: 'Invite not found' });
    res.json({ revoked: true });
  } catch (error) {
    console.error('Revoke Invite Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
};
