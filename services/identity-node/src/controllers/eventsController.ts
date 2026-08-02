import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import multer from 'multer';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { publishEvent } from '../config/nats.js';
import { bulkMoveUsers } from './channelController.js';
import { roleDisplayName, ensureShipDataFresh } from '../utils/scunpackedSync.js';
import { deriveComponentDetail } from '../utils/componentDetail.js';
import { collectWeaponGroups, LoadoutNode, LoadoutOverride } from '../utils/loadoutMath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_BASE = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
const MAP_MODELS_DIR = path.join(UPLOADS_BASE, 'map-models');
fs.mkdirSync(MAP_MODELS_DIR, { recursive: true });

// ── Mission map 3D model upload (multer config) ───────────────────────────────
// glTF/GLB browsers report inconsistently (often generic
// application/octet-stream), so filtering is extension-based, not mimetype.
const mapModelStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MAP_MODELS_DIR),
  filename: (req, file, cb) => {
    const eventId = String(Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId) || 'event';
    const ext = file.originalname.toLowerCase().endsWith('.gltf') ? 'gltf' : 'glb';
    cb(null, `${eventId}-${crypto.randomUUID()}.${ext}`);
  },
});

const mapModelFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.glb') || name.endsWith('.gltf')) {
    cb(null, true);
  } else {
    cb(new Error('Only .glb or .gltf model files are allowed'));
  }
};

export const mapModelUpload = multer({
  storage: mapModelStorage,
  fileFilter: mapModelFilter,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB max
});

// Extensible on purpose — 'none' plus one game for now, more can be added
// here (and a matching sync function in fleetyardsSync.ts-style util) without
// a schema change, since events.game is just a VARCHAR.
const SUPPORTED_GAMES = new Set(['none', 'star_citizen']);

// ── In-memory presence store ──────────────────────────────────────────────────
// eventId → Map<userId, { callsign: string; ts: number }>
const presenceMap = new Map<string, Map<string, { callsign: string; ts: number }>>();
const PRESENCE_TTL = 60_000; // 60 s

function getActiveEditors(eventId: string): { userId: string; callsign: string }[] {
  const map = presenceMap.get(eventId);
  if (!map) return [];
  const now = Date.now();
  for (const [uid, entry] of map.entries()) {
    if (now - entry.ts > PRESENCE_TTL) map.delete(uid);
  }
  return Array.from(map.entries()).map(([userId, e]) => ({ userId, callsign: e.callsign }));
}

export const pingPresence = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  const callsign = req.user?.callsign || 'Unknown';
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const oid = String(Array.isArray(orgId) ? orgId[0] : orgId);
  const eid = String(Array.isArray(eventId) ? eventId[0] : eventId);

  if (!presenceMap.has(eid)) presenceMap.set(eid, new Map());
  presenceMap.get(eid)!.set(userId, { callsign, ts: Date.now() });

  const editors = getActiveEditors(eid);
  await publishEvent(`specter.event.org.${oid}`, { type: 'planner_presence', event_id: eid, editors });
  res.json({ editors });
};

export const clearPresence = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const oid = String(Array.isArray(orgId) ? orgId[0] : orgId);
  const eid = String(Array.isArray(eventId) ? eventId[0] : eventId);

  presenceMap.get(eid)?.delete(userId);
  const editors = getActiveEditors(eid);
  await publishEvent(`specter.event.org.${oid}`, { type: 'planner_presence', event_id: eid, editors });
  res.json({ ok: true });
};

/** Can this user view the operations calendar for this org? */
const canUserViewCalendar = async (orgId: string, userId: string): Promise<boolean> => {
  const ownerRes = await pool.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
  if (ownerRes.rows[0]?.owner_id === userId) return true;
  const permRes = await pool.query(
    `SELECT r.permissions FROM org_members om
     JOIN org_roles r ON om.role_id = r.id
     WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId]
  );
  if (permRes.rows.length === 0) return false;
  if (permRes.rows.some((r: any) => r.permissions?.can_view_calendar === true)) return true;
  // Also grant view access if user is the creator, commander, or a planner of any event
  // in this org — so assigned event commanders can always see their own calendar.
  const staffRes = await pool.query(
    `SELECT 1 FROM events e
     LEFT JOIN event_planners ep ON ep.event_id = e.id AND ep.user_id = $2
     WHERE e.org_id = $1
       AND (e.creator_id = $2 OR e.commander_user_id = $2 OR ep.user_id = $2)
     LIMIT 1`,
    [orgId, userId]
  );
  return (staffRes.rowCount ?? 0) > 0;
};

export const getOrgEvents = async (req: AuthRequest, res: Response) => {
  const { orgId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const memberCheck = await pool.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2
       UNION SELECT 1 FROM organizations WHERE id = $1 AND owner_id = $2`,
      [orgId, userId]
    );
    if (memberCheck.rowCount === 0) return res.status(403).json({ error: 'Not a member' });

    const result = await pool.query(
      `SELECT e.id, e.name, e.start_time, e.end_time, e.created_at,
              COALESCE(e.launched, false) AS launched,
              e.command_channel_id, e.commander_user_id,
              COALESCE(e.creator_id, (SELECT owner_id FROM organizations WHERE id = e.org_id)) AS creator_id,
              COALESCE(e.access_mode, 'open') AS access_mode,
              e.meetup_location,
              COALESCE(e.game, 'none') AS game,
              COUNT(er.user_id) AS rsvp_count,
              COALESCE(sc.total_slots, 0) AS total_slots,
              COALESCE(sc.filled_slots, 0) AS filled_slots
       FROM events e
       LEFT JOIN event_roster er ON er.event_id = e.id
       LEFT JOIN (
         SELECT eg.event_id,
                COALESCE(SUM(egr.max_slots), 0) AS total_slots,
                COUNT(DISTINCT egm.user_id)      AS filled_slots
         FROM event_groups eg
         LEFT JOIN event_group_roles    egr ON egr.group_id = eg.id
         LEFT JOIN event_group_members  egm ON egm.group_id = eg.id
         GROUP BY eg.event_id
       ) sc ON sc.event_id = e.id
       WHERE e.org_id = $1 AND e.ended_at IS NULL
       GROUP BY e.id, sc.total_slots, sc.filled_slots
       ORDER BY e.start_time ASC`,
      [orgId]
    );

    // Attach planners list to each event
    const eventIds = result.rows.map((e: any) => e.id);
    let plannersByEvent: Record<string, any[]> = {};
    if (eventIds.length > 0) {
      const plannerRes = await pool.query(
        `SELECT ep.event_id, ep.user_id, u.callsign
         FROM event_planners ep JOIN users u ON ep.user_id = u.id
         WHERE ep.event_id = ANY($1)`,
        [eventIds]
      );
      for (const p of plannerRes.rows) {
        if (!plannersByEvent[p.event_id]) plannersByEvent[p.event_id] = [];
        plannersByEvent[p.event_id].push({ user_id: p.user_id, callsign: p.callsign });
      }
    }

    const events = result.rows.map((e: any) => ({
      ...e,
      planners: plannersByEvent[e.id] || [],
    }));

    res.json({ events });
  } catch (err) {
    console.error('Get events error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Ended operations (ended_at IS NOT NULL — see migration 000034), most recent
// first. The frontend groups these by month; per-event attendance is fetched
// on demand via the existing GET /:eventId/groups endpoint when an entry is
// expanded, so this list stays cheap regardless of history length.
export const getOrgEventHistory = async (req: AuthRequest, res: Response) => {
  const { orgId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const memberCheck = await pool.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2
       UNION SELECT 1 FROM organizations WHERE id = $1 AND owner_id = $2`,
      [orgId, userId]
    );
    if (memberCheck.rowCount === 0) return res.status(403).json({ error: 'Not a member' });

    const result = await pool.query(
      `SELECT e.id, e.name, e.start_time, e.end_time, e.ended_at, e.commander_user_id,
              COUNT(DISTINCT egm.user_id) FILTER (WHERE egm.status = 'accepted') AS attendee_count
       FROM events e
       LEFT JOIN event_groups eg ON eg.event_id = e.id
       LEFT JOIN event_group_members egm ON egm.group_id = eg.id
       WHERE e.org_id = $1 AND e.ended_at IS NOT NULL
       GROUP BY e.id
       ORDER BY e.ended_at DESC`,
      [orgId]
    );

    res.json({ events: result.rows });
  } catch (err) {
    console.error('Get event history error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createOrgEvent = async (req: AuthRequest, res: Response) => {
  const { orgId } = req.params;
  const userId = req.user?.id;
  const { name, start_time, end_time, access_mode, planner_ids, meetup_location, game } = req.body;

  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!name || !start_time) return res.status(400).json({ message: 'name and start_time are required' });

  const mode = access_mode === 'restricted' ? 'restricted' : 'open';
  const gameTag = SUPPORTED_GAMES.has(game) ? game : 'none';

  try {
    // Only members can create events
    const memberCheck = await pool.query(
      `SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId]
    );
    if (memberCheck.rowCount === 0) return res.status(403).json({ message: 'Not a member' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO events (org_id, name, start_time, end_time, creator_id, access_mode, meetup_location, game)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [orgId, name, start_time, end_time || null, userId, mode, meetup_location || null, gameTag]
      );
      const event = result.rows[0];

      // Add co-planners
      if (Array.isArray(planner_ids)) {
        for (const pid of planner_ids) {
          await client.query(
            `INSERT INTO event_planners (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [event.id, pid]
          );
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ event });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const rsvpEvent = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const priority = req.body.priority ?? 0;
    await pool.query(
      `INSERT INTO event_roster (event_id, user_id, event_priority)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, user_id) DO UPDATE SET event_priority = $3`,
      [eventId, userId, priority]
    );
    res.json({ message: 'RSVP recorded' });
  } catch (err) {
    console.error('RSVP error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Permission helpers ────────────────────────────────────────────────────────

/** Can this user manage events at the org level (owner / role permission)? */
const canManageEvents = async (userId: string, orgId: string): Promise<boolean> => {
  const ownerRes = await pool.query(`SELECT owner_id FROM organizations WHERE id = $1`, [orgId]);
  if (ownerRes.rows.length > 0 && ownerRes.rows[0].owner_id === userId) return true;
  const permRes = await pool.query(
    `SELECT r.permissions FROM org_members om
     JOIN org_roles r ON om.role_id = r.id
     WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId]
  );
  return permRes.rows.some((r: any) => r.permissions?.can_create_events === true || r.permissions?.can_manage_channels === true);
};

/** Can this user manage a specific event (org-level permission OR event creator/commander/planner)? */
const canManageThisEvent = async (userId: string, orgId: any, eventId: any): Promise<boolean> => {
  const oid = String(Array.isArray(orgId) ? orgId[0] : orgId);
  const eid = String(Array.isArray(eventId) ? eventId[0] : eventId);
  if (await canManageEvents(userId, oid)) return true;
  // Check if user is the event creator or designated commander
  const eventRes = await pool.query(
    `SELECT creator_id, commander_user_id FROM events WHERE id = $1 AND org_id = $2`,
    [eid, oid]
  );
  if (eventRes.rows.length > 0) {
    const { creator_id, commander_user_id } = eventRes.rows[0];
    if (creator_id === userId || commander_user_id === userId) return true;
  }
  // Check if user is a planner
  const plannerRes = await pool.query(`SELECT 1 FROM event_planners WHERE event_id = $1 AND user_id = $2`, [eid, userId]);
  return (plannerRes.rowCount ?? 0) > 0;
};

// ── Update event ──────────────────────────────────────────────────────────────
export const updateOrgEvent = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  const { name, start_time, end_time, access_mode, meetup_location, game } = req.body;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (!(await canManageThisEvent(userId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    const mode = access_mode === 'restricted' ? 'restricted' : access_mode === 'open' ? 'open' : undefined;
    const gameTag = SUPPORTED_GAMES.has(game) ? game : undefined;

    const updateMeetup = meetup_location !== undefined;
    const result = await pool.query(
      `UPDATE events SET name = COALESCE($1, name), start_time = COALESCE($2, start_time), end_time = COALESCE($3, end_time),
              access_mode = COALESCE($6, access_mode),
              meetup_location = CASE WHEN $7 THEN $8 ELSE meetup_location END,
              game = COALESCE($9, game)
       WHERE id = $4 AND org_id = $5 RETURNING *`,
      [name, start_time, end_time, eventId, orgId, mode, updateMeetup, updateMeetup ? (meetup_location || null) : null, gameTag]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Event not found' });
    res.json({ event: result.rows[0] });
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Delete event ──────────────────────────────────────────────────────────────
export const deleteOrgEvent = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (!(await canManageThisEvent(userId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete all channels spawned for this event (they are not permanent channels)
      await client.query(`DELETE FROM channels WHERE event_id = $1`, [eventId]);

      const result = await client.query(
        `DELETE FROM events WHERE id = $1 AND org_id = $2 RETURNING *`,
        [eventId, orgId]
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ message: 'Event not found' });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Notify clients to refresh channels and events
    await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_deleted' });
    await publishEvent(`specter.event.org.${orgId}`, { type: 'orgs_changed' });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Get event groups ──────────────────────────────────────────────────────────
export const getEventGroups = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const groups = await pool.query(
      `SELECT eg.id, eg.name, eg.leader_user_id, eg.channel_id,
              eg.parent_group_id, eg.linked_group_id,
              COALESCE(eg.max_members, 0) AS max_members,
              u.callsign AS leader_callsign
       FROM event_groups eg
       LEFT JOIN users u ON eg.leader_user_id = u.id
       WHERE eg.event_id = $1
       ORDER BY eg.created_at ASC`,
      [eventId]
    );

    // For each group, get its members
    const groupIds = groups.rows.map((g: any) => g.id);
    let membersByGroup: Record<string, any[]> = {};
    let rolesByGroup: Record<string, any[]> = {};
    let shipsByGroup: Record<string, any[]> = {};
    let claimsByGroup: Record<string, any[]> = {};

    if (groupIds.length > 0) {
      const shipsRes = await pool.query(
        `SELECT id, group_id, ship_slug, ship_name, ship_icon_url, quantity, sort_order
         FROM event_group_ships WHERE group_id = ANY($1) ORDER BY sort_order, id`,
        [groupIds]
      );
      for (const s of shipsRes.rows) {
        if (!shipsByGroup[s.group_id]) shipsByGroup[s.group_id] = [];
        shipsByGroup[s.group_id].push(s);
      }

      const claimsRes = await pool.query(
        `SELECT egsc.group_id, egsc.ship_slug, egsc.slot_index, egsc.user_id, egsc.claimed_ship_slug, u.callsign
         FROM event_group_ship_claims egsc JOIN users u ON u.id = egsc.user_id
         WHERE egsc.group_id = ANY($1)`,
        [groupIds]
      );
      for (const c of claimsRes.rows) {
        if (!claimsByGroup[c.group_id]) claimsByGroup[c.group_id] = [];
        claimsByGroup[c.group_id].push(c);
      }

      const membersRes = await pool.query(
        `SELECT egm.group_id, egm.user_id, egm.role_id, egm.seat_label, u.callsign,
                COALESCE(egm.status, 'pending') AS status,
                COALESCE(egm.role, '') AS role
         FROM event_group_members egm
         JOIN users u ON egm.user_id = u.id
         WHERE egm.group_id = ANY($1)`,
        [groupIds]
      );
      for (const m of membersRes.rows) {
        if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = [];
        membersByGroup[m.group_id].push({ user_id: m.user_id, callsign: m.callsign, status: m.status, role: m.role, role_id: m.role_id, seat_label: m.seat_label });
      }

      const rolesRes = await pool.query(
        `SELECT id, group_id, name, priority,
                assignment_mode, max_slots, sort_order, seat_labels,
                COALESCE(is_commander, false) AS is_commander,
                COALESCE(auto_approve, true) AS auto_approve,
                COALESCE(reserved_slots, 0) AS reserved_slots
         FROM event_group_roles
         WHERE group_id = ANY($1)
         ORDER BY sort_order, priority DESC, created_at`,
        [groupIds]
      );
      for (const r of rolesRes.rows) {
        if (!rolesByGroup[r.group_id]) rolesByGroup[r.group_id] = [];
        rolesByGroup[r.group_id].push(r);
      }
    }

    const result = groups.rows.map((g: any) => {
      const groupMembers = membersByGroup[g.id] || [];
      const groupRoles = (rolesByGroup[g.id] || []).map((r: any) => ({
        ...r,
        assigned_user_id:  groupMembers.find((m: any) => m.role_id === r.id && r.assignment_mode === 'direct')?.user_id || null,
        assigned_callsign: groupMembers.find((m: any) => m.role_id === r.id && r.assignment_mode === 'direct')?.callsign || null,
        assigned_status:   groupMembers.find((m: any) => m.role_id === r.id && r.assignment_mode === 'direct')?.status || null,
        filled_slots: groupMembers.filter((m: any) => m.role_id === r.id).length,
        // Individually-claimed seats (from seat_labels, when a role has more
        // than one named seat — e.g. specific turret positions) so the UI
        // can show who's where and only offer unclaimed seats to new joiners.
        taken_seats: groupMembers
          .filter((m: any) => m.role_id === r.id && m.seat_label)
          .map((m: any) => ({ seat_label: m.seat_label, callsign: m.callsign, status: m.status })),
      }));
      const groupClaims = claimsByGroup[g.id] || [];
      const groupShips = (shipsByGroup[g.id] || []).map((s: any) => ({
        ...s,
        // Per-slot claim state (who's bringing which physical hull) — see
        // event_group_ship_claims / claimShipSlot.
        claims: groupClaims
          .filter((c: any) => c.ship_slug === s.ship_slug)
          .map((c: any) => ({ slot_index: c.slot_index, user_id: c.user_id, callsign: c.callsign, claimed_ship_slug: c.claimed_ship_slug })),
      }));
      return { ...g, members: groupMembers, roles: groupRoles, ships: groupShips };
    });

    // Also return event access_mode so the UI knows what to render
    const evRes = await pool.query(`SELECT COALESCE(access_mode, 'open') AS access_mode, commander_user_id FROM events WHERE id = $1`, [eventId]);
    const access_mode = evRes.rows[0]?.access_mode || 'open';
    const commander_user_id = evRes.rows[0]?.commander_user_id || null;

    // Return frequencies with their role refs (resolved back to [group_index, role_index] pairs)
    const freqRes = await pool.query(
      `SELECT ef.id, ef.name, ef.sort_order,
              COALESCE(json_agg(json_build_object('role_id', efr.role_id)) FILTER (WHERE efr.role_id IS NOT NULL), '[]') AS role_rows
       FROM event_frequencies ef
       LEFT JOIN event_frequency_roles efr ON efr.frequency_id = ef.id
       WHERE ef.event_id = $1
       GROUP BY ef.id ORDER BY ef.sort_order`,
      [eventId]
    );
    // Build role_id → [group_index, role_index] lookup
    const roleIdxMap: Record<string, { gi: number; ri: number }> = {};
    for (let gi = 0; gi < result.length; gi++) {
      const roles = result[gi].roles || [];
      for (let ri = 0; ri < roles.length; ri++) {
        roleIdxMap[roles[ri].id] = { gi, ri };
      }
    }
    const freqsWithRefs = freqRes.rows.map((f: any) => ({
      id: f.id,
      name: f.name,
      sort_order: f.sort_order,
      role_refs: (f.role_rows || []).map((r: any) => roleIdxMap[r.role_id]).filter(Boolean),
    }));

    res.json({ groups: result, access_mode, commander_user_id, frequencies: freqsWithRefs });
  } catch (err) {
    console.error('Get event groups error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Save event groups (update/insert/delete by id — NOT a full replace) ───────
// Previously this destroyed and recreated every group/role with brand-new UUIDs
// on every save. Because event_group_members FKs to those rows with ON DELETE
// CASCADE, that made it structurally impossible for any membership to survive a
// save — including self-signups from joinEventRole/quickJoinEvent, which were
// never part of the save payload to begin with. Since the planner UI also
// auto-saves on close with no dirty-check, this silently wiped rosters on every
// close. Groups/roles/frequencies now keep stable ids across saves (matched by
// the `id` the frontend already has from load()); only entities actually
// removed from the payload are deleted, so membership FKs stay valid and
// untouched for everything the planner didn't remove.
export const saveEventGroups = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  // groups: Array<{ id?, name, leader_user_id, member_user_ids, member_roles, parent_index?, linked_index?, max_members?, roles?: Array<{ id?, ... }> }>
  const { groups, frequencies } = req.body;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (!(await canManageThisEvent(userId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    const evCheck = await pool.query(`SELECT id, COALESCE(access_mode, 'open') AS access_mode FROM events WHERE id = $1 AND org_id = $2`, [eventId, orgId]);
    if (evCheck.rows.length === 0) return res.status(404).json({ message: 'Event not found' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingGroupsRes = await client.query(`SELECT id FROM event_groups WHERE event_id = $1`, [eventId]);
      const existingGroupIds = new Set<string>(existingGroupsRes.rows.map((r: any) => r.id));

      const createdGroupIds: string[] = [];
      // createdRoleIds[groupIdx][roleIdx] → role UUID (for frequency role_refs)
      const createdRoleIds: string[][] = [];
      if (Array.isArray(groups)) {
        // Pass 1: upsert groups with parent_group_id, max_members (payload is
        // pre-sorted parent-before-child by the frontend, so createdGroupIds
        // already holds the resolved id for any earlier index by the time a
        // later group references it as a parent).
        const keptGroupIds = new Set<string>();
        for (const g of groups) {
          const parentGroupId = (typeof g.parent_index === 'number' && g.parent_index >= 0 && g.parent_index < createdGroupIds.length)
            ? createdGroupIds[g.parent_index] : null;

          let groupId: string;
          if (g.id && existingGroupIds.has(g.id)) {
            await client.query(
              `UPDATE event_groups SET name = $1, leader_user_id = $2, parent_group_id = $3, max_members = $4
               WHERE id = $5 AND event_id = $6`,
              [g.name || 'Squad', g.leader_user_id || null, parentGroupId, g.max_members || 0, g.id, eventId]
            );
            groupId = g.id;
          } else {
            const gRes = await client.query(
              `INSERT INTO event_groups (event_id, name, leader_user_id, parent_group_id, max_members)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [eventId, g.name || 'Squad', g.leader_user_id || null, parentGroupId, g.max_members || 0]
            );
            groupId = gRes.rows[0].id;
          }
          createdGroupIds.push(groupId);
          keptGroupIds.add(groupId);

          // Ship composition — a group can be zero, one, or many vehicles
          // (e.g. a 3-fighter wing), so this is a full replace rather than a
          // diff/match-by-id: the list itself has no stable per-entry identity
          // worth preserving across saves, just "what's currently selected."
          await client.query(`DELETE FROM event_group_ships WHERE group_id = $1`, [groupId]);
          const newQuantityBySlug = new Map<string, number>();
          if (Array.isArray(g.ships)) {
            let sortOrder = 0;
            for (const s of g.ships) {
              const shipSlug = String(s.ship_slug || '').slice(0, 64);
              const shipName = String(s.ship_name || '').slice(0, 128);
              if (!shipSlug || !shipName) continue;
              const shipIconUrl = s.ship_icon_url ? String(s.ship_icon_url).slice(0, 2048) : null;
              const quantity = Math.max(1, parseInt(s.quantity, 10) || 1);
              await client.query(
                `INSERT INTO event_group_ships (group_id, ship_slug, ship_name, ship_icon_url, quantity, sort_order)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [groupId, shipSlug, shipName, shipIconUrl, quantity, sortOrder++]
              );
              newQuantityBySlug.set(shipSlug, quantity);
            }
          }
          // Prune claims the new composition no longer supports — a slug
          // removed entirely, or a slot index beyond the new (possibly
          // shrunk) quantity for a slug that's still present. A pruned
          // claim's owner also loses the group membership it auto-created
          // (they were piloting a hull that no longer exists in this
          // mission) — safe to drop the whole row since UNIQUE(group_id,
          // user_id) on both tables means a claimant holds exactly one
          // event_group_members row, the auto-joined Pilot one.
          const existingClaimsRes = await client.query(
            `SELECT id, user_id, ship_slug, slot_index FROM event_group_ship_claims WHERE group_id = $1`,
            [groupId]
          );
          const staleClaims = existingClaimsRes.rows.filter((c: any) => {
            const qty = newQuantityBySlug.get(c.ship_slug);
            return qty === undefined || c.slot_index >= qty;
          });
          if (staleClaims.length > 0) {
            await client.query(`DELETE FROM event_group_ship_claims WHERE id = ANY($1::uuid[])`, [staleClaims.map((c: any) => c.id)]);
            await client.query(
              `DELETE FROM event_group_members WHERE group_id = $1 AND user_id = ANY($2::uuid[])`,
              [groupId, staleClaims.map((c: any) => c.user_id)]
            );
          }
        }

        // Groups the planner removed from the UI — delete them (cascades their
        // roles/members, which is correct: the planner explicitly removed them).
        const removedGroupIds = [...existingGroupIds].filter(id => !keptGroupIds.has(id));
        if (removedGroupIds.length > 0) {
          await client.query(`DELETE FROM event_groups WHERE id = ANY($1::uuid[])`, [removedGroupIds]);
        }

        // Pass 2: set linked_group_id (cross-references need all IDs to exist first)
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          const linkedGroupId = (typeof g.linked_index === 'number' && g.linked_index >= 0 && g.linked_index < createdGroupIds.length && g.linked_index !== i)
            ? createdGroupIds[g.linked_index] : null;
          await client.query(`UPDATE event_groups SET linked_group_id = $1 WHERE id = $2`, [linkedGroupId, createdGroupIds[i]]);
        }

        // Pass 3: upsert roles + direct member assignments (backward-compat with legacy member_user_ids)
        const isRestricted = evCheck.rows[0].access_mode === 'restricted';
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          const groupId = createdGroupIds[i];
          createdRoleIds[i] = [];

          const existingRolesRes = await client.query(`SELECT id FROM event_group_roles WHERE group_id = $1`, [groupId]);
          const existingRoleIds = new Set<string>(existingRolesRes.rows.map((r: any) => r.id));
          const keptRoleIds = new Set<string>();

          if (Array.isArray(g.roles) && g.roles.length > 0) {
            // Role-based assignment (new format)
            for (let ri = 0; ri < g.roles.length; ri++) {
              const role = g.roles[ri];
              const assignmentMode = role.assignment_mode === 'direct' ? 'direct' : 'open';
              const maxSlots = Math.max(1, parseInt(role.max_slots) || 1);
              const priority = Math.min(5, Math.max(1, parseInt(role.priority) || 3));
              const name = String(role.name || 'Role').slice(0, 64);
              const isCommander = role.is_commander === true;
              const autoApprove = role.auto_approve !== false;
              // seat_labels is a JSONB array of individually-addressable seat
              // names (e.g. specific turret positions) — see shipRoleToGroupRole
              // in OperationPlanner.jsx for where these come from on auto-fill.
              const seatLabelsArr = Array.isArray(role.seat_labels)
                ? role.seat_labels.slice(0, 20).map((s: any) => String(s).slice(0, 80))
                : [];
              const seatLabels = JSON.stringify(seatLabelsArr);

              let roleId: string;
              if (role.id && existingRoleIds.has(role.id)) {
                await client.query(
                  `UPDATE event_group_roles
                   SET name = $1, priority = $2, assignment_mode = $3, max_slots = $4,
                       sort_order = $5, is_commander = $6, auto_approve = $7, seat_labels = $8
                   WHERE id = $9 AND group_id = $10`,
                  [name, priority, assignmentMode, maxSlots, ri, isCommander, autoApprove, seatLabels, role.id, groupId]
                );
                roleId = role.id;
              } else {
                const roleRes = await client.query(
                  `INSERT INTO event_group_roles (group_id, name, priority, assignment_mode, max_slots, sort_order, is_commander, auto_approve, seat_labels)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
                  [groupId, name, priority, assignmentMode, maxSlots, ri, isCommander, autoApprove, seatLabels]
                );
                roleId = roleRes.rows[0].id;
              }
              createdRoleIds[i][ri] = roleId;
              keptRoleIds.add(roleId);

              // Reconcile the direct-assignment slot for this role. A role is
              // either 'direct' or 'open' — joinEventRole rejects self-signups
              // for anything but 'open' roles, so any existing member row under
              // a 'direct' role's role_id is, by definition, a superseded/stale
              // direct assignment, safe to clear without touching real
              // self-signups (which can't exist on a direct role).
              if (assignmentMode === 'direct') {
                if (role.assigned_user_id) {
                  await client.query(
                    `DELETE FROM event_group_members WHERE role_id = $1 AND user_id != $2`,
                    [roleId, role.assigned_user_id]
                  );
                  await client.query(
                    `INSERT INTO event_group_members (group_id, user_id, role_id, status, role)
                     VALUES ($1, $2, $3, 'pending', $4)
                     ON CONFLICT (group_id, user_id) DO UPDATE SET role_id = $3, role = $4, status = 'pending'`,
                    [groupId, role.assigned_user_id, roleId, name]
                  );
                } else {
                  await client.query(`DELETE FROM event_group_members WHERE role_id = $1`, [roleId]);
                }
              }
            }
          } else if (Array.isArray(g.member_user_ids)) {
            // Backward-compat: legacy member_user_ids format
            for (const uid of g.member_user_ids) {
              const memberRole = (g.member_roles && g.member_roles[uid]) ? String(g.member_roles[uid]).slice(0, 64) : '';
              await client.query(
                `INSERT INTO event_group_members (group_id, user_id, status, role)
                 VALUES ($1, $2, $3, $4) ON CONFLICT (group_id, user_id) DO UPDATE SET role = $4`,
                [groupId, uid, isRestricted ? 'pending' : 'accepted', memberRole]
              );
            }
          }

          // Roles the planner removed from this group. event_group_members.role_id
          // is ON DELETE SET NULL (not CASCADE), so existing members — including
          // self-signups — simply lose their role reference rather than being deleted.
          const removedRoleIds = [...existingRoleIds].filter(id => !keptRoleIds.has(id));
          if (removedRoleIds.length > 0) {
            await client.query(`DELETE FROM event_group_roles WHERE id = ANY($1::uuid[])`, [removedRoleIds]);
          }
        }
      }

      // Auto-derive commander from the role flagged is_commander (direct-assigned)
      {
        let derivedCommanderId: string | null = null;
        outer: for (let i = 0; i < (Array.isArray(groups) ? groups.length : 0); i++) {
          const g = groups[i];
          if (Array.isArray(g.roles)) {
            for (const role of g.roles) {
              if (role.is_commander === true && role.assignment_mode === 'direct' && role.assigned_user_id) {
                derivedCommanderId = role.assigned_user_id;
                break outer;
              }
            }
          }
        }
        await client.query(
          `UPDATE events SET commander_user_id = $1 WHERE id = $2`,
          [derivedCommanderId, eventId]
        );
      }

      // Upsert liaison frequencies the same way. event_frequency_roles carries no
      // independent state beyond the link itself, so it's safe to fully replace
      // per kept frequency (unlike event_group_members, which carries status).
      const existingFreqsRes = await client.query(`SELECT id FROM event_frequencies WHERE event_id = $1`, [eventId]);
      const existingFreqIds = new Set<string>(existingFreqsRes.rows.map((r: any) => r.id));
      const keptFreqIds = new Set<string>();

      if (Array.isArray(frequencies)) {
        for (let fi = 0; fi < frequencies.length; fi++) {
          const freq: any = frequencies[fi];
          const name = String(freq.name || 'FREQ').slice(0, 32);

          let freqId: string;
          if (freq.id && existingFreqIds.has(freq.id)) {
            await client.query(`UPDATE event_frequencies SET name = $1, sort_order = $2 WHERE id = $3 AND event_id = $4`, [name, fi, freq.id, eventId]);
            freqId = freq.id;
          } else {
            const freqRes = await client.query(
              `INSERT INTO event_frequencies (event_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id`,
              [eventId, name, fi]
            );
            freqId = freqRes.rows[0].id;
          }
          keptFreqIds.add(freqId);

          await client.query(`DELETE FROM event_frequency_roles WHERE frequency_id = $1`, [freqId]);
          for (const ref of ((freq.role_refs || []) as any[])) {
            const gi = ref.group_index;
            const ri = ref.role_index;
            const roleId = createdRoleIds[gi]?.[ri];
            if (roleId) {
              await client.query(
                `INSERT INTO event_frequency_roles (frequency_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [freqId, roleId]
              );
            }
          }
        }
      }
      const removedFreqIds = [...existingFreqIds].filter(id => !keptFreqIds.has(id));
      if (removedFreqIds.length > 0) {
        await client.query(`DELETE FROM event_frequencies WHERE id = ANY($1::uuid[])`, [removedFreqIds]);
      }

      await client.query('COMMIT');
      await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
      res.json({ message: 'Groups saved' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Save event groups error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Get event frequencies (standalone endpoint) ───────────────────────────────
export const getEventFrequencies = async (req: AuthRequest, res: Response) => {
  const { eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const freqRes = await pool.query(
      `SELECT ef.id, ef.name, ef.sort_order, ef.channel_id,
              COALESCE(json_agg(json_build_object('role_id', efr.role_id)) FILTER (WHERE efr.role_id IS NOT NULL), '[]') AS role_rows
       FROM event_frequencies ef
       LEFT JOIN event_frequency_roles efr ON efr.frequency_id = ef.id
       WHERE ef.event_id = $1
       GROUP BY ef.id ORDER BY ef.sort_order`,
      [eventId]
    );
    res.json({ frequencies: freqRes.rows });
  } catch (err) {
    console.error('Get event frequencies error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Event channel presets ─────────────────────────────────────────────────────
export const getEventPresets = async (req: AuthRequest, res: Response) => {
  const orgId = String(Array.isArray(req.params.orgId) ? req.params.orgId[0] : req.params.orgId);
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const result = await pool.query(
      `SELECT id, name, layout, created_by, created_at FROM event_channel_presets WHERE org_id = $1 ORDER BY created_at DESC`,
      [orgId]
    );
    res.json({ presets: result.rows });
  } catch (err) {
    console.error('Get presets error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const saveEventPreset = async (req: AuthRequest, res: Response) => {
  const orgId = String(Array.isArray(req.params.orgId) ? req.params.orgId[0] : req.params.orgId);
  const userId = req.user?.id;
  const { name, layout } = req.body;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!name || !layout) return res.status(400).json({ message: 'name and layout required' });
  try {
    if (!(await canManageEvents(userId, orgId)))
      return res.status(403).json({ message: 'Forbidden' });
    const result = await pool.query(
      `INSERT INTO event_channel_presets (org_id, name, created_by, layout) VALUES ($1, $2, $3, $4) RETURNING *`,
      [orgId, String(name).slice(0, 64), userId, JSON.stringify(layout)]
    );
    res.status(201).json({ preset: result.rows[0] });
  } catch (err) {
    console.error('Save preset error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Mission map layout (objectives, structures, ship tokens) — one per event ──
export const getEventMapLayout = async (req: AuthRequest, res: Response) => {
  const { eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const result = await pool.query(
      `SELECT layout, updated_by, updated_at FROM event_map_layouts WHERE event_id = $1`,
      [eventId]
    );
    res.json({ layout: result.rows[0]?.layout || {} });
  } catch (err) {
    console.error('Get event map layout error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const saveEventMapLayout = async (req: AuthRequest, res: Response) => {
  const orgId = String(Array.isArray(req.params.orgId) ? req.params.orgId[0] : req.params.orgId);
  const { eventId } = req.params;
  const userId = req.user?.id;
  const { layout } = req.body;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!layout || typeof layout !== 'object') return res.status(400).json({ message: 'layout required' });
  try {
    if (!(await canManageEvents(userId, orgId)))
      return res.status(403).json({ message: 'Forbidden' });
    const result = await pool.query(
      `INSERT INTO event_map_layouts (event_id, org_id, layout, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (event_id) DO UPDATE SET layout = $3, updated_by = $4, updated_at = NOW()
       RETURNING layout, updated_at`,
      [eventId, orgId, JSON.stringify(layout), userId]
    );
    res.json({ layout: result.rows[0].layout, updated_at: result.rows[0].updated_at });
  } catch (err) {
    console.error('Save event map layout error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── POST /orgs/:orgId/events/:eventId/map-models  (upload a 3D model for MissionMap) ──
// The file itself is the only persisted record — its URL is embedded directly
// into a modelAssets entry in the event's layout JSONB by the client's next
// saveEventMapLayout call, the same way ship icon URLs live inline in
// groupTokens rather than a separate table.
export const uploadEventMapModel = async (req: AuthRequest, res: Response) => {
  const orgId = String(Array.isArray(req.params.orgId) ? req.params.orgId[0] : req.params.orgId);
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return res.status(400).json({ message: 'No model file provided' });

  try {
    if (!(await canManageEvents(userId, orgId))) {
      fs.unlink(file.path, () => {});
      return res.status(403).json({ message: 'Forbidden' });
    }
    const relativePath = `map-models/${file.filename}`;
    res.status(201).json({
      url: `/uploads/${relativePath}`,
      name: file.originalname.replace(/\.(glb|gltf)$/i, ''),
    });
  } catch (err) {
    console.error('Upload event map model error:', err);
    fs.unlink(file.path, () => {});
    res.status(500).json({ message: 'Server error' });
  }
};

export const deleteEventPreset = async (req: AuthRequest, res: Response) => {
  const orgId = String(Array.isArray(req.params.orgId) ? req.params.orgId[0] : req.params.orgId);
  const presetId = String(Array.isArray(req.params.presetId) ? req.params.presetId[0] : req.params.presetId);
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  try {
    if (!(await canManageEvents(userId, orgId)))
      return res.status(403).json({ message: 'Forbidden' });
    const result = await pool.query(
      `DELETE FROM event_channel_presets WHERE id = $1 AND org_id = $2 RETURNING id`,
      [presetId, orgId]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: 'Preset not found' });
    res.json({ message: 'Preset deleted' });
  } catch (err) {
    console.error('Delete preset error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Launch operation ──────────────────────────────────────────────────────────
// Creates voice channels for each group + a command channel, links them to the event
export const launchEvent = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (!(await canManageThisEvent(userId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    const evRes = await pool.query(
      `SELECT * FROM events WHERE id = $1 AND org_id = $2`,
      [eventId, orgId]
    );
    if (evRes.rows.length === 0) return res.status(404).json({ message: 'Event not found' });
    if (evRes.rows[0].launched) return res.status(409).json({ message: 'Event already launched' });

    const groups = await pool.query(
      `SELECT * FROM event_groups WHERE event_id = $1 ORDER BY created_at`,
      [eventId]
    );

    // Build group_id → parent_group_id map and compute tree order
    const groupRows = groups.rows as any[];
    const groupParentMap: Record<string, string | null> = {};
    for (const g of groupRows) {
      groupParentMap[g.id] = g.parent_group_id || null;
    }

    // Topological sort: parents before children
    const sorted: any[] = [];
    const visited = new Set<string>();
    const visit = (g: any) => {
      if (visited.has(g.id)) return;
      if (g.parent_group_id) {
        const parent = groupRows.find((p: any) => p.id === g.parent_group_id);
        if (parent && !visited.has(parent.id)) visit(parent);
      }
      visited.add(g.id);
      sorted.push(g);
    };
    for (const g of groupRows) visit(g);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create command channel (root of tree, tier 0)
      const cmdChanRes = await client.query(
        `INSERT INTO channels (org_id, event_id, name, type, channel_kind, ducking_level)
         VALUES ($1, $2, $3, 0, 0, 0) RETURNING id`,
        [orgId, eventId, `${evRes.rows[0].name} — COMMAND`]
      );
      const commandChannelId = cmdChanRes.rows[0].id;

      // Map group_id → channel_id for parent_channel_id resolution
      const groupToChannel: Record<string, string> = {};

      // Create a voice channel per group (tree order so parents exist first)
      for (const g of sorted) {
        const parentChannelId = g.parent_group_id
          ? (groupToChannel[g.parent_group_id] || commandChannelId)
          : commandChannelId;

        const chanRes = await client.query(
          `INSERT INTO channels (org_id, event_id, name, type, channel_kind, ducking_level, parent_channel_id)
           VALUES ($1, $2, $3, 0, 0, 0, $4) RETURNING id`,
          [orgId, eventId, g.name, parentChannelId]
        );
        const channelId = chanRes.rows[0].id;
        groupToChannel[g.id] = channelId;

        await client.query(
          `UPDATE event_groups SET channel_id = $1 WHERE id = $2`,
          [channelId, g.id]
        );
      }

      // Create hidden frequency channels (is_frequency = true)
      const freqRows = await client.query(
        `SELECT id, name FROM event_frequencies WHERE event_id = $1 ORDER BY sort_order`,
        [eventId]
      );
      const freqChannelEntries: any[] = [];
      for (const freq of freqRows.rows) {
        const freqChanRes = await client.query(
          `INSERT INTO channels (org_id, event_id, name, type, channel_kind, ducking_level, is_frequency, parent_channel_id)
           VALUES ($1, $2, $3, 0, 0, 0, true, $4) RETURNING id`,
          [orgId, eventId, freq.name, commandChannelId]
        );
        await client.query(
          `UPDATE event_frequencies SET channel_id = $1 WHERE id = $2`,
          [freqChanRes.rows[0].id, freq.id]
        );
        freqChannelEntries.push({ id: freqChanRes.rows[0].id, parent_id: commandChannelId, tier: 99, leader_user_id: null, is_frequency: true });
      }

      // Mark event as launched
      await client.query(
        `UPDATE events SET launched = true, command_channel_id = $1 WHERE id = $2`,
        [commandChannelId, eventId]
      );

      await client.query('COMMIT');

      // Build channel tree payload for NATS → media server
      const channelTree: any[] = [];
      // Command channel (tier 0)
      channelTree.push({ id: commandChannelId, parent_id: null, tier: 0, leader_user_id: null });
      // Compute tier (depth from command channel)
      const computeTier = (groupId: string): number => {
        const g = groupRows.find((x: any) => x.id === groupId);
        if (!g || !g.parent_group_id) return 1; // direct child of command = tier 1
        return computeTier(g.parent_group_id) + 1;
      };
      for (const g of sorted) {
        channelTree.push({
          id: groupToChannel[g.id],
          parent_id: g.parent_group_id ? (groupToChannel[g.parent_group_id] || commandChannelId) : commandChannelId,
          tier: computeTier(g.id),
          leader_user_id: g.leader_user_id || null,
        });
      }
      // Append frequency channels to tree (after commit, using pre-collected entries)
      for (const fe of freqChannelEntries) channelTree.push(fe);

      // SSE: notify org about new channels + launch
      await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_created' });
      await publishEvent(`specter.event.org.${orgId}`, { type: 'event_launched', eventId });
      // Publish channel tree for media server
      await publishEvent(`specter.event.tree.${orgId}`, { type: 'event_tree', event_id: eventId, channels: channelTree });

      // Deliberately no auto-move here: assigned members are prompted to accept
      // and join via the event_launched SSE above (WarRoom's join banner). An
      // earlier version force-moved online assigned users via bulkMoveUsers,
      // which moves everyone subscribed to their *current* channel — dragging
      // uninvolved bystanders sharing that channel into the event channel with
      // no notification, and skipping the accept prompt entirely for the
      // assignee. The prompt-driven join (channel-keyed CommLink remount +
      // the unique channel_subscriptions(user_id, org_id) index) already
      // handles this correctly without any server-initiated move.

      res.json({ message: 'Operation launched', command_channel_id: commandChannelId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Launch event error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Get / Set event planners ──────────────────────────────────────────────────
export const getEventPlanners = async (req: AuthRequest, res: Response) => {
  const { eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const result = await pool.query(
      `SELECT ep.user_id, u.callsign
       FROM event_planners ep JOIN users u ON ep.user_id = u.id
       WHERE ep.event_id = $1`,
      [eventId]
    );
    res.json({ planners: result.rows });
  } catch (err) {
    console.error('Get event planners error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

export const setEventPlanners = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  const { planner_ids } = req.body; // string[]
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (!(await canManageThisEvent(userId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM event_planners WHERE event_id = $1`, [eventId]);
      if (Array.isArray(planner_ids)) {
        for (const pid of planner_ids) {
          await client.query(
            `INSERT INTO event_planners (event_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [eventId, pid]
          );
        }
      }
      await client.query('COMMIT');
      res.json({ message: 'Planners updated' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Set event planners error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Self-join a group (open events) ───────────────────────────────────────────
export const joinEventGroup = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    // Verify open event
    const evRes = await pool.query(
      `SELECT COALESCE(access_mode, 'open') AS access_mode FROM events WHERE id = $1 AND org_id = $2`,
      [eventId, orgId]
    );
    if (evRes.rows.length === 0) return res.status(404).json({ message: 'Event not found' });
    if (evRes.rows[0].access_mode !== 'open')
      return res.status(403).json({ message: 'This event is restricted. Only planners can assign members.' });

    // Verify membership in the org
    const memRes = await pool.query(`SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    if (memRes.rowCount === 0) return res.status(403).json({ message: 'Not a member' });

    // Verify group belongs to this event
    const grpRes = await pool.query(`SELECT 1 FROM event_groups WHERE id = $1 AND event_id = $2`, [groupId, eventId]);
    if (grpRes.rowCount === 0) return res.status(404).json({ message: 'Group not found' });

    await pool.query(
      `INSERT INTO event_group_members (group_id, user_id, status) VALUES ($1, $2, 'accepted')
       ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'accepted'`,
      [groupId, userId]
    );
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Joined group' });
  } catch (err) {
    console.error('Join event group error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Leave a group ─────────────────────────────────────────────────────────────
export const leaveEventGroup = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const memberRes = await client.query(
      `SELECT reserved_seats_role_id, reserved_seats_count FROM event_group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (memberRes.rows.length > 0) {
      const { reserved_seats_role_id, reserved_seats_count } = memberRes.rows[0];
      if (reserved_seats_role_id && Number(reserved_seats_count) > 0) {
        await client.query(
          `UPDATE event_group_roles SET reserved_slots = GREATEST(0, reserved_slots - $1) WHERE id = $2`,
          [reserved_seats_count, reserved_seats_role_id]
        );
      }
    }

    // A leaving member also releases any ship slot they'd claimed in this
    // group — claiming and being the group's Pilot/Captain are one unified
    // action, so leaving should be symmetric regardless of which UI path
    // (leave group vs. leave role vs. explicit release) the user took.
    await client.query(`DELETE FROM event_group_ship_claims WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);

    await client.query(
      `DELETE FROM event_group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    await client.query('COMMIT');
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Left group' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Leave event group error:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};

// ── Self-join a specific open role slot ───────────────────────────────────────
export const joinEventRole = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId, roleId } = req.params;
  const userId = req.user?.id;
  const claimedShipId = req.body?.claimed_ship_id || null;
  const seatLabel = req.body?.seat_label ? String(req.body.seat_label).slice(0, 80) : null;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const evRes = await client.query(
      `SELECT COALESCE(access_mode, 'open') AS access_mode FROM events WHERE id = $1 AND org_id = $2`,
      [eventId, orgId]
    );
    if (evRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Event not found' });
    }
    if (evRes.rows[0].access_mode !== 'open') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'This event is restricted. Only planners can assign members.' });
    }

    const memRes = await client.query(`SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    if (memRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Not a member' });
    }

    const roleRes = await client.query(
      `SELECT egr.assignment_mode, egr.max_slots, egr.name AS role_name,
              COALESCE(egr.auto_approve, true) AS auto_approve,
              COALESCE(egr.reserved_slots, 0) AS reserved_slots,
              COALESCE(egr.seat_labels, '[]'::jsonb) AS seat_labels,
              COUNT(egm.user_id) FILTER (WHERE egm.status IN ('accepted','pending')) AS filled_slots
       FROM event_group_roles egr
       LEFT JOIN event_group_members egm ON egm.role_id = egr.id AND egm.group_id = $2
       WHERE egr.id = $1 AND egr.group_id = $2
       GROUP BY egr.id`,
      [roleId, groupId]
    );
    if (roleRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Role not found' });
    }
    const role = roleRes.rows[0];
    if (role.assignment_mode !== 'open') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'This role requires direct assignment.' });
    }

    // Ship-composed groups gate on ship-slot claims: Pilot/Captain can only
    // be reached via claimShipSlot (which auto-joins that role), and crew
    // roles need at least one hull of the relevant ship_slug claimed first.
    // Shipless (infantry) groups have no event_group_ships rows and skip
    // this entirely — no behavior change there.
    const compRes = await client.query(`SELECT ship_slug FROM event_group_ships WHERE group_id = $1`, [groupId]);
    const compSlugs: string[] = compRes.rows.map((r: any) => r.ship_slug);
    if (compSlugs.length > 0) {
      if (PILOT_ROLE_NAMES.has(role.role_name)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: 'Claim a ship for this group to join as Pilot/Captain.' });
      }
      // Which ship_slug this seat belongs to, when resolvable — roles are
      // summed across the whole composition (shipRoleToGroupRole in
      // OperationPlanner.jsx), so seat_labels alone don't carry a per-slug
      // tag; cross-reference against each composition slug's own raw_seats,
      // same approach getGroupDpsEstimate uses. Ambiguous or unresolvable
      // (0/1-seat roles, multi-slug label collisions) falls back to "any
      // claim in the group" — an accepted approximation already documented
      // for mixed compositions elsewhere in this file.
      const seatLabelsArr: string[] = Array.isArray(role.seat_labels) ? role.seat_labels : [];
      const effectiveSeatLabel = seatLabel || seatLabelsArr[0] || null;
      let requiredSlug: string | null = compSlugs.length === 1 ? compSlugs[0] : null;
      if (!requiredSlug && effectiveSeatLabel) {
        const gsRes = await client.query(
          `SELECT slug, raw_seats FROM game_ships WHERE game = 'star_citizen' AND slug = ANY($1::text[])`,
          [compSlugs]
        );
        const matches = gsRes.rows.filter((r: any) => (r.raw_seats || []).some((s: any) => s.seat_label === effectiveSeatLabel));
        if (matches.length === 1) requiredSlug = matches[0].slug;
      }
      const claimCheckRes = requiredSlug
        ? await client.query(`SELECT 1 FROM event_group_ship_claims WHERE group_id = $1 AND ship_slug = $2 LIMIT 1`, [groupId, requiredSlug])
        : await client.query(`SELECT 1 FROM event_group_ship_claims WHERE group_id = $1 LIMIT 1`, [groupId]);
      if (claimCheckRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ message: requiredSlug ? `No ${requiredSlug} has been claimed for this group yet.` : 'No ship has been claimed for this group yet.' });
      }
    }

    // Release any reservation this user's previous membership in this group
    // caused (e.g. switching roles) before evaluating/writing the new one.
    const prevRes = await client.query(
      `SELECT reserved_seats_role_id, reserved_seats_count FROM event_group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (prevRes.rows.length > 0 && prevRes.rows[0].reserved_seats_role_id && Number(prevRes.rows[0].reserved_seats_count) > 0) {
      await client.query(
        `UPDATE event_group_roles SET reserved_slots = GREATEST(0, reserved_slots - $1) WHERE id = $2`,
        [prevRes.rows[0].reserved_seats_count, prevRes.rows[0].reserved_seats_role_id]
      );
    }

    // Roles only control frequency assignment and voice priority within a
    // group — they don't gate access to the group's channel itself, which is
    // granted to anyone signed up for *a* role in the group. So a role at
    // capacity falls back to plain group membership (no frequency/priority
    // role) instead of rejecting the join outright, gated only by the
    // group's own member cap.
    const roleHasSlot = Number(role.filled_slots) + Number(role.reserved_slots) < Number(role.max_slots);
    if (!roleHasSlot) {
      const groupCapRes = await client.query(
        `SELECT COALESCE(max_members, 0) AS max_members,
                (SELECT COUNT(*) FROM event_group_members WHERE group_id = $1 AND status IN ('accepted','pending')) AS filled
         FROM event_groups WHERE id = $1`,
        [groupId]
      );
      const grp = groupCapRes.rows[0];
      if (grp && Number(grp.max_members) > 0 && Number(grp.filled) >= Number(grp.max_members)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'This group is full.' });
      }
      await client.query(
        `INSERT INTO event_group_members (group_id, user_id, status)
         VALUES ($1, $2, 'accepted')
         ON CONFLICT (group_id, user_id) DO UPDATE SET
           role_id = NULL, status = 'accepted', role = NULL, seat_label = NULL,
           claimed_ship_id = NULL, reserved_seats_role_id = NULL, reserved_seats_count = 0`,
        [groupId, userId]
      );
      await client.query('COMMIT');
      await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
      return res.json({ message: `${role.role_name || 'That role'} is full — joined the group without a specific role.` });
    }

    // Roles with more than one individually-named seat (e.g. specific turret
    // positions) require picking which one — a plain slot count isn't
    // enough. Roles with 0 or 1 named seats don't need a choice.
    const seatLabels: string[] = Array.isArray(role.seat_labels) ? role.seat_labels : [];
    if (seatLabels.length > 1) {
      if (!seatLabel) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Select a seat for this role.' });
      }
      if (!seatLabels.includes(seatLabel)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'Invalid seat for this role.' });
      }
      const seatTaken = await client.query(
        `SELECT 1 FROM event_group_members
         WHERE role_id = $1 AND seat_label = $2 AND status IN ('accepted','pending') AND user_id != $3`,
        [roleId, seatLabel, userId]
      );
      if ((seatTaken.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ message: 'That seat is already taken.' });
      }
    }
    const seatLabelToStore = seatLabels.length > 1 ? seatLabel : (seatLabels[0] || null);

    const status = role.auto_approve ? 'accepted' : 'pending';

    // If the caller is joining with a hangar ship that matches this group's
    // selected ship and has locked seats, reserve capacity on the matching
    // ship-generated role(s). Only the first reserved role is tracked for
    // later release (event_group_members has one reservation slot) — good
    // enough since locked seats are typically all the same seat type.
    let claimedShipIdToStore: string | null = null;
    let reservedRoleId: string | null = null;
    let reservedCount = 0;

    if (claimedShipId) {
      const shipRes = await client.query(
        `SELECT locked_seats, ship_slug FROM user_ships WHERE id = $1 AND user_id = $2`,
        [claimedShipId, userId]
      );
      if (shipRes.rows.length > 0) {
        const row = shipRes.rows[0];
        const lockedSeats: string[] = row.locked_seats || [];
        // A group can hold multiple ships now — the claimed ship just needs
        // to appear anywhere in the group's composition, not be "the" ship.
        const compRes = lockedSeats.length > 0
          ? await client.query(`SELECT 1 FROM event_group_ships WHERE group_id = $1 AND ship_slug = $2 LIMIT 1`, [groupId, row.ship_slug])
          : { rows: [] as any[] };
        if (compRes.rows.length > 0) {
          const gsRes = await client.query(
            `SELECT raw_seats FROM game_ships WHERE game = 'star_citizen' AND slug = $1`,
            [row.ship_slug]
          );
          const rawSeats: any[] = gsRes.rows[0]?.raw_seats || [];
          const countsByRoleName = new Map<string, number>();
          for (const hp of lockedSeats) {
            const seat = rawSeats.find((s: any) => s.hardpoint_name === hp);
            if (!seat) continue;
            const displayName = roleDisplayName(seat.role);
            countsByRoleName.set(displayName, (countsByRoleName.get(displayName) || 0) + 1);
          }
          for (const [displayName, count] of countsByRoleName) {
            const updateRes = await client.query(
              `UPDATE event_group_roles SET reserved_slots = reserved_slots + $1
               WHERE group_id = $2 AND name = $3 RETURNING id`,
              [count, groupId, displayName]
            );
            if (updateRes.rows.length > 0) {
              claimedShipIdToStore = claimedShipId;
              if (!reservedRoleId) {
                reservedRoleId = updateRes.rows[0].id;
                reservedCount = count;
              }
            }
          }
        }
      }
    }

    await client.query(
      `INSERT INTO event_group_members (group_id, user_id, role_id, status, role, claimed_ship_id, reserved_seats_role_id, reserved_seats_count, seat_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (group_id, user_id) DO UPDATE SET
         role_id = $3, status = $4, role = $5, claimed_ship_id = $6,
         reserved_seats_role_id = $7, reserved_seats_count = $8, seat_label = $9`,
      [groupId, userId, roleId, status, role.role_name, claimedShipIdToStore, reservedRoleId, reservedCount, seatLabelToStore]
    );

    await client.query('COMMIT');
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: status === 'accepted' ? 'Joined role' : 'Join request pending approval' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Join event role error:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};

// ── Quick self-signup for open events ─────────────────────────────────────────
// Picks the highest-priority open role with free slots; falls back to first group.
export const quickJoinEvent = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const evRes = await pool.query(
      `SELECT COALESCE(access_mode, 'open') AS access_mode FROM events WHERE id = $1 AND org_id = $2`,
      [eventId, orgId]
    );
    if (evRes.rows.length === 0) return res.status(404).json({ message: 'Event not found' });
    if (evRes.rows[0].access_mode !== 'open')
      return res.status(403).json({ message: 'This event is restricted. Wait for assignment approval.' });

    const already = await pool.query(
      `SELECT 1
       FROM event_group_members egm
       JOIN event_groups eg ON egm.group_id = eg.id
       WHERE eg.event_id = $1 AND egm.user_id = $2
       LIMIT 1`,
      [eventId, userId]
    );
    if (already.rowCount) return res.json({ message: 'Already signed up' });

    const roleRes = await pool.query(
      `SELECT
         egr.id AS role_id,
         egr.group_id,
         egr.name AS role_name,
         COALESCE(egr.priority, 3) AS priority,
         COALESCE(egr.sort_order, 0) AS sort_order,
         COALESCE(egr.max_slots, 1) AS max_slots,
         COALESCE(egr.auto_approve, true) AS auto_approve,
         COUNT(egm.user_id) FILTER (WHERE egm.status IN ('accepted','pending')) AS filled_slots
       FROM event_group_roles egr
       JOIN event_groups eg ON eg.id = egr.group_id
       LEFT JOIN event_group_members egm ON egm.role_id = egr.id
       WHERE eg.event_id = $1
         AND egr.assignment_mode = 'open'
       GROUP BY egr.id
       ORDER BY COALESCE(egr.priority, 3) DESC, COALESCE(egr.sort_order, 0) ASC, egr.created_at ASC`,
      [eventId]
    );

    const role = roleRes.rows.find((r: any) => Number(r.filled_slots) < Number(r.max_slots));
    if (role) {
      const status = role.auto_approve ? 'accepted' : 'pending';
      await pool.query(
        `INSERT INTO event_group_members (group_id, user_id, role_id, status, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (group_id, user_id) DO UPDATE SET role_id = $3, status = $4, role = $5`,
        [role.group_id, userId, role.role_id, status, role.role_name]
      );
      await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
      return res.json({ message: status === 'accepted' ? 'Signed up' : 'Signup request pending approval' });
    }

    const groupRes = await pool.query(
      `SELECT eg.id,
              COALESCE(eg.max_members, 0) AS max_members,
              COUNT(egm.user_id) FILTER (WHERE egm.status IN ('accepted','pending')) AS filled
       FROM event_groups eg
       LEFT JOIN event_group_members egm ON egm.group_id = eg.id
       WHERE eg.event_id = $1
       GROUP BY eg.id
       ORDER BY eg.created_at ASC`,
      [eventId]
    );
    const group = groupRes.rows.find((g: any) => Number(g.max_members) === 0 || Number(g.filled) < Number(g.max_members));
    if (!group) return res.status(409).json({ message: 'No open slots available right now.' });

    await pool.query(
      `INSERT INTO event_group_members (group_id, user_id, status)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'accepted'`,
      [group.id, userId]
    );
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Signed up' });
  } catch (err) {
    console.error('Quick join event error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Easy unenroll from event (all assigned groups/roles) ─────────────────────
export const leaveMyEventSignup = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Can match more than one row (a member row per group they're in within
    // this event) — release each reservation before deleting.
    const memberRes = await client.query(
      `SELECT reserved_seats_role_id, reserved_seats_count FROM event_group_members
       WHERE user_id = $1 AND group_id IN (SELECT id FROM event_groups WHERE event_id = $2)
         AND reserved_seats_role_id IS NOT NULL AND reserved_seats_count > 0`,
      [userId, eventId]
    );
    for (const row of memberRes.rows) {
      await client.query(
        `UPDATE event_group_roles SET reserved_slots = GREATEST(0, reserved_slots - $1) WHERE id = $2`,
        [row.reserved_seats_count, row.reserved_seats_role_id]
      );
    }

    await client.query(
      `DELETE FROM event_group_members
       WHERE user_id = $1
         AND group_id IN (SELECT id FROM event_groups WHERE event_id = $2)`,
      [userId, eventId]
    );

    await client.query('COMMIT');
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Signup removed' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Leave my event signup error:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};

// ── Leave a specific role slot ─────────────────────────────────────────────────
export const leaveEventRole = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId, roleId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const memberRes = await client.query(
      `SELECT reserved_seats_role_id, reserved_seats_count FROM event_group_members WHERE group_id = $1 AND user_id = $2 AND role_id = $3`,
      [groupId, userId, roleId]
    );
    if (memberRes.rows.length > 0) {
      const { reserved_seats_role_id, reserved_seats_count } = memberRes.rows[0];
      if (reserved_seats_role_id && Number(reserved_seats_count) > 0) {
        await client.query(
          `UPDATE event_group_roles SET reserved_slots = GREATEST(0, reserved_slots - $1) WHERE id = $2`,
          [reserved_seats_count, reserved_seats_role_id]
        );
      }
    }

    // Leaving the role a ship-slot claim auto-joined them into also releases
    // that claim — see the matching comment in leaveEventGroup.
    await client.query(`DELETE FROM event_group_ship_claims WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);

    await client.query(
      `DELETE FROM event_group_members WHERE group_id = $1 AND user_id = $2 AND role_id = $3`,
      [groupId, userId, roleId]
    );

    await client.query('COMMIT');
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Left role' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Leave event role error:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};

// ── GET /orgs/:orgId/events/:eventId/groups/:groupId/ship-match ──────────────
// Checks whether the caller has a hangar ship matching any ship in this
// group's composition, and if it has locked seats, resolves them to human
// labels — used by the frontend to show a confirm dialog before joining
// with a ship claim.
export const getGroupShipMatch = async (req: AuthRequest, res: Response) => {
  const { groupId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const groupShipsRes = await pool.query(`SELECT ship_slug FROM event_group_ships WHERE group_id = $1`, [groupId]);
    const groupShipSlugs: string[] = groupShipsRes.rows.map((r: any) => r.ship_slug);
    if (groupShipSlugs.length === 0) return res.json({ match: null });

    const shipRes = await pool.query(
      `SELECT id, ship_slug, ship_name, locked_seats FROM user_ships WHERE user_id = $1 AND ship_slug = ANY($2::text[]) LIMIT 1`,
      [userId, groupShipSlugs]
    );
    if (shipRes.rows.length === 0) return res.json({ match: null });
    const ship = shipRes.rows[0];
    const shipSlug = ship.ship_slug;
    const lockedSeats: string[] = ship.locked_seats || [];
    if (lockedSeats.length === 0) {
      return res.json({ match: { ship_id: ship.id, ship_name: ship.ship_name, locked_seats: [], locked_seat_labels: [] } });
    }

    const gsRes = await pool.query(`SELECT raw_seats FROM game_ships WHERE game = 'star_citizen' AND slug = $1`, [shipSlug]);
    const rawSeats: any[] = gsRes.rows[0]?.raw_seats || [];
    const seatLabels = lockedSeats.map(hp => {
      const seat = rawSeats.find((s: any) => s.hardpoint_name === hp);
      return seat ? seat.seat_label : hp;
    });

    res.json({ match: { ship_id: ship.id, ship_name: ship.ship_name, locked_seats: lockedSeats, locked_seat_labels: seatLabels } });
  } catch (err) {
    console.error('getGroupShipMatch error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Two ships are "approved similar" for slot-claim purposes when they share
// the same scunpacked Role taxonomy string (game_ships.combat_stats.role —
// e.g. "Light Fighter") — verified against real data: Aegis Gladius and
// Anvil Arrow are both role="Light Fighter" (interchangeable), while RSI
// Perseus is role="Heavy Gunship" (correctly excluded). Null/missing role on
// either side never matches — no fallback to size alone, to avoid pairing
// unrelated ships that just happen to share a hull-size number.
async function shipRolesMatch(slugA: string, slugB: string): Promise<boolean> {
  if (slugA === slugB) return true;
  const res = await pool.query(
    `SELECT slug, combat_stats->>'role' AS role FROM game_ships WHERE game = 'star_citizen' AND slug = ANY($1::text[])`,
    [[slugA, slugB]]
  );
  const roleBySlug = new Map(res.rows.map((r: any) => [r.slug, r.role]));
  const roleA = roleBySlug.get(slugA);
  const roleB = roleBySlug.get(slugB);
  return !!roleA && !!roleB && roleA === roleB;
}

// ── GET /orgs/:orgId/events/:eventId/groups/:groupId/claimable-ships ─────────
// Per composition entry: which slots are claimed (by whom, with what), and
// which of the CALLER's own hangar ships are eligible to claim an open one
// (exact ship_slug match, or an approved-similar one via shipRolesMatch).
export const getClaimableShips = async (req: AuthRequest, res: Response) => {
  const { groupId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const compRes = await pool.query(
      `SELECT ship_slug, ship_name, quantity FROM event_group_ships WHERE group_id = $1 ORDER BY sort_order`,
      [groupId]
    );
    if (compRes.rows.length === 0) return res.json({ entries: [] });

    const slugs: string[] = compRes.rows.map((r: any) => r.ship_slug);

    const claimsRes = await pool.query(
      `SELECT egsc.ship_slug, egsc.slot_index, egsc.user_id, egsc.claimed_ship_slug, u.callsign
       FROM event_group_ship_claims egsc JOIN users u ON u.id = egsc.user_id
       WHERE egsc.group_id = $1`,
      [groupId]
    );

    const roleRes = await pool.query(
      `SELECT slug, combat_stats->>'role' AS role FROM game_ships WHERE game = 'star_citizen' AND slug = ANY($1::text[])`,
      [slugs]
    );
    const roleBySlug = new Map<string, string | null>(roleRes.rows.map((r: any) => [r.slug, r.role]));

    const hangarRes = await pool.query(
      `SELECT us.id, us.ship_slug, us.ship_name, us.nickname, gs.combat_stats->>'role' AS role
       FROM user_ships us LEFT JOIN game_ships gs ON gs.game = 'star_citizen' AND gs.slug = us.ship_slug
       WHERE us.user_id = $1`,
      [userId]
    );

    const entries = compRes.rows.map((entry: any) => {
      const claimsForSlug = claimsRes.rows.filter((c: any) => c.ship_slug === entry.ship_slug);
      const slots = Array.from({ length: entry.quantity }, (_, i) => {
        const claim = claimsForSlug.find((c: any) => c.slot_index === i);
        return claim
          ? { slot_index: i, user_id: claim.user_id, callsign: claim.callsign, claimed_ship_slug: claim.claimed_ship_slug }
          : { slot_index: i, user_id: null, callsign: null, claimed_ship_slug: null };
      });
      const entryRole = roleBySlug.get(entry.ship_slug) || null;
      const eligible = hangarRes.rows
        .filter((h: any) => h.ship_slug === entry.ship_slug || (entryRole && h.role === entryRole))
        .map((h: any) => ({ user_ship_id: h.id, ship_slug: h.ship_slug, ship_name: h.nickname || h.ship_name, exact: h.ship_slug === entry.ship_slug }));
      return { ship_slug: entry.ship_slug, ship_name: entry.ship_name, quantity: entry.quantity, slots, eligible_user_ships: eligible };
    });

    res.json({ entries });
  } catch (err) {
    console.error('getClaimableShips error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── POST /orgs/:orgId/events/:eventId/groups/:groupId/ships/:shipSlug/claim ──
// Claims one slot of a composition entry with one of the caller's own hangar
// ships (exact match or approved-similar, see shipRolesMatch) and, as one
// unified action, best-effort auto-joins the caller into whichever role in
// the group is named "Captain" or "Pilot" (see PILOT_ROLE_NAMES) — the claim
// itself still succeeds even if no such role exists or it's full.
export const claimShipSlot = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId } = req.params;
  const shipSlug = String(req.params.shipSlug || '');
  const userId = req.user?.id;
  const userShipId = req.body?.user_ship_id;
  const slotIndex = parseInt(req.body?.slot_index, 10);
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });
  if (!userShipId || !Number.isInteger(slotIndex) || slotIndex < 0) {
    return res.status(400).json({ message: 'Missing or invalid user_ship_id/slot_index' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const evRes = await client.query(
      `SELECT COALESCE(access_mode, 'open') AS access_mode FROM events WHERE id = $1 AND org_id = $2`,
      [eventId, orgId]
    );
    if (evRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Event not found' }); }
    if (evRes.rows[0].access_mode !== 'open') {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'This event is restricted. Only planners can assign members.' });
    }
    const memRes = await client.query(`SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    if (memRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(403).json({ message: 'Not a member' }); }

    const shipRes = await client.query(`SELECT ship_slug FROM user_ships WHERE id = $1 AND user_id = $2`, [userShipId, userId]);
    if (shipRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Hangar ship not found' }); }
    const ownedSlug = shipRes.rows[0].ship_slug;
    if (!(await shipRolesMatch(ownedSlug, shipSlug))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'That ship is not an approved match for this slot.' });
    }

    const compRes = await client.query(
      `SELECT quantity FROM event_group_ships WHERE group_id = $1 AND ship_slug = $2`,
      [groupId, shipSlug]
    );
    if (compRes.rows.length === 0 || slotIndex >= compRes.rows[0].quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Invalid slot for this composition.' });
    }

    // Release any claim (and its reservation math below) this user already
    // holds in this group — switching which ship they're bringing.
    await client.query(`DELETE FROM event_group_ship_claims WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);

    const insertRes = await client.query(
      `INSERT INTO event_group_ship_claims (group_id, ship_slug, slot_index, user_id, user_ship_id, claimed_ship_slug)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (group_id, ship_slug, slot_index) DO NOTHING RETURNING id`,
      [groupId, shipSlug, slotIndex, userId, userShipId, ownedSlug]
    );
    if (insertRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'That slot was just claimed.' });
    }

    // Best-effort Pilot/Captain auto-join — release any prior reservation
    // this user's previous membership caused first, same as joinEventRole.
    const prevRes = await client.query(
      `SELECT reserved_seats_role_id, reserved_seats_count FROM event_group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (prevRes.rows.length > 0 && prevRes.rows[0].reserved_seats_role_id && Number(prevRes.rows[0].reserved_seats_count) > 0) {
      await client.query(
        `UPDATE event_group_roles SET reserved_slots = GREATEST(0, reserved_slots - $1) WHERE id = $2`,
        [prevRes.rows[0].reserved_seats_count, prevRes.rows[0].reserved_seats_role_id]
      );
    }

    const roleRes = await client.query(
      `SELECT egr.id, egr.name, egr.max_slots, egr.seat_labels, COALESCE(egr.auto_approve, true) AS auto_approve,
              COUNT(egm.user_id) FILTER (WHERE egm.status IN ('accepted','pending')) AS filled_slots
       FROM event_group_roles egr
       LEFT JOIN event_group_members egm ON egm.role_id = egr.id AND egm.group_id = $1
       WHERE egr.group_id = $1 AND egr.name = ANY($2::text[])
       GROUP BY egr.id`,
      [groupId, Array.from(PILOT_ROLE_NAMES)]
    );
    // Prefer Captain over Pilot when a ship generates both as distinct seats
    // (capital ships) — the slot claimant is the one providing/commanding
    // the hull.
    const pilotRole = roleRes.rows.find((r: any) => r.name === 'Captain') || roleRes.rows.find((r: any) => r.name === 'Pilot');
    if (pilotRole && Number(pilotRole.filled_slots) < Number(pilotRole.max_slots)) {
      const seatLabels: string[] = Array.isArray(pilotRole.seat_labels) ? pilotRole.seat_labels : [];
      const status = pilotRole.auto_approve ? 'accepted' : 'pending';
      await client.query(
        `INSERT INTO event_group_members (group_id, user_id, role_id, status, role, claimed_ship_id, seat_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (group_id, user_id) DO UPDATE SET
           role_id = $3, status = $4, role = $5, claimed_ship_id = $6, seat_label = $7,
           reserved_seats_role_id = NULL, reserved_seats_count = 0`,
        [groupId, userId, pilotRole.id, status, pilotRole.name, userShipId, seatLabels[0] || null]
      );
    }

    await client.query('COMMIT');
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Ship slot claimed' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('claimShipSlot error:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};

// ── DELETE /orgs/:orgId/events/:eventId/groups/:groupId/ships/:shipSlug/claim
export const releaseShipSlot = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claimRes = await client.query(
      `DELETE FROM event_group_ship_claims WHERE group_id = $1 AND user_id = $2 RETURNING ship_slug, slot_index`,
      [groupId, userId]
    );
    if (claimRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'No claim to release' });
    }

    // Only clear their membership if it's still the Pilot/Captain role the
    // claim auto-joined them into — if they'd since switched to a manually-
    // assigned different role, leave that alone.
    await client.query(
      `DELETE FROM event_group_members
       WHERE group_id = $1 AND user_id = $2
         AND role_id IN (SELECT id FROM event_group_roles WHERE group_id = $1 AND name = ANY($3::text[]))`,
      [groupId, userId, Array.from(PILOT_ROLE_NAMES)]
    );

    await client.query('COMMIT');
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Ship slot released' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('releaseShipSlot error:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};

const ENGAGEMENT_RANGE_CAVEAT = 'Actual engagement range may be limited by your radar/detection strength.';
// A joined-but-not-yet-approved member isn't combat-ready — deliberately
// stricter than getEventGroups' filled_slots/taken_seats, which count both
// so the roster UI shows pending requests too.
const DPS_MEMBER_STATUS = 'accepted';
// Which role names identify "the person providing this hull" — used to gate
// a ship's fixed/bare-mounted guns in the DPS estimate below, to auto-join a
// ship-slot claimant into the right role (claimShipSlot), and to block
// direct Pilot/Captain joins for ship-composed groups (joinEventRole) since
// that path now requires claiming a slot instead. Matched by name since
// event_group_roles.name is free text seeded from crew_roles.display_name
// (shipRoleToGroupRole in OperationPlanner.jsx) but editable by planners; if
// a planner renames "Pilot" this heuristic silently stops gating that role.
const PILOT_ROLE_NAMES = new Set(['Pilot', 'Captain']);

// ── GET /orgs/:orgId/events/:eventId/groups/:groupId/dps-estimate ────────────
// Seat-aware DPS for a mission group's ship composition: unlike
// getDamageEstimate (gameShipsController.ts), which sums a ship's entire
// stock+override loadout unconditionally, this only counts weapons whose
// controlling seat is actually crewed by an accepted member — a turret with
// nobody in it contributes nothing, a fixed nose gun fires whenever its ship
// is piloted. Missiles/torpedoes are reported as a separate one-time payload
// (see componentDetail.ts), not folded into sustained DPS.
//
// Known v1 approximations, surfaced via `approximate`/`warnings` rather than
// hidden: (1) a composition mixing multiple distinct ship_slugs can't
// exactly attribute which physical hull a crewed seat belongs to — each
// ship_slug's own weapon groups are matched against its own raw_seats
// independently, which is exact for single-ship-type compositions (including
// Nx identical copies) but approximate once slugs differ; (2) two identical
// ship copies sharing a seat_label (e.g. two Hornets each with an "Upper
// Turret") can only ever show ONE of those seats as claimable today — that's
// an existing constraint from event_group_members' seat_label uniqueness
// check in joinEventRole, not something new introduced here.
export const getGroupDpsEstimate = async (req: AuthRequest, res: Response) => {
  const { groupId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  const emptyResponse = (warnings: string[]) => ({
    total_sustained_dps: 0, total_burst_dps: 0,
    dps_by_type: {} as Record<string, number>, burst_dps_by_type: {} as Record<string, number>,
    by_ship_slug: [] as { ship_slug: string; ship_name: string; manned_count: number; dps: number }[],
    by_seat_role: [] as { role: string; dps: number }[],
    missile_payload: null as { count: number; total_alpha: number } | null,
    engagement_range: { min: null as number | null, max: null as number | null, missile_lock_min: null as number | null, missile_lock_max: null as number | null, caveat: ENGAGEMENT_RANGE_CAVEAT },
    approximate: false,
    warnings,
  });

  try {
    const shipsRes = await pool.query(
      `SELECT ship_slug, ship_name, quantity FROM event_group_ships WHERE group_id = $1 ORDER BY sort_order ASC`,
      [groupId]
    );
    const composition: { ship_slug: string; ship_name: string; quantity: number }[] = shipsRes.rows;
    if (composition.length === 0) return res.json(emptyResponse(['No ships in this group\'s composition']));

    const rolesRes = await pool.query(`SELECT id, name FROM event_group_roles WHERE group_id = $1`, [groupId]);
    const roleById = new Map<string, { id: string; name: string }>(rolesRes.rows.map((r: any) => [r.id, r]));

    const membersRes = await pool.query(
      `SELECT role_id, seat_label, claimed_ship_id FROM event_group_members WHERE group_id = $1 AND status = $2`,
      [groupId, DPS_MEMBER_STATUS]
    );
    const members: { role_id: string | null; seat_label: string | null; claimed_ship_id: string | null }[] = membersRes.rows;

    let pilotBudget = members.filter(m => {
      const role = m.role_id ? roleById.get(m.role_id) : null;
      return role && PILOT_ROLE_NAMES.has(role.name);
    }).length;

    // seat_label -> claiming member's hangar ship (or null if they joined
    // without one) — event_group_members already enforces at most one
    // accepted/pending member per (role_id, seat_label), so this is safe as
    // a flat map rather than a multi-map.
    const crewedSeatLabels = new Map<string, string | null>();
    for (const m of members) if (m.seat_label) crewedSeatLabels.set(m.seat_label, m.claimed_ship_id);

    const warnings: string[] = [];
    const uniqueSlugs = Array.from(new Set(composition.map(c => c.ship_slug)));
    const shipDataCache = new Map<string, { rawSeats: any[]; weaponGroups: ReturnType<typeof collectWeaponGroups> }>();
    for (const slug of uniqueSlugs) {
      const data = await ensureShipDataFresh('star_citizen', slug);
      if (!data) { warnings.push(`No cached ship data for "${slug}" yet — try again shortly.`); continue; }
      shipDataCache.set(slug, {
        rawSeats: data.raw_seats || [],
        weaponGroups: collectWeaponGroups((data.stock_loadout || []) as unknown as LoadoutNode[]),
      });
    }

    const claimedShipIds = Array.from(new Set(members.map(m => m.claimed_ship_id).filter((id): id is string => !!id)));
    const overridesByShipId = new Map<string, Record<string, LoadoutOverride>>();
    if (claimedShipIds.length > 0) {
      const usRes = await pool.query(`SELECT id, loadout_overrides FROM user_ships WHERE id = ANY($1::uuid[])`, [claimedShipIds]);
      for (const row of usRes.rows) {
        const map: Record<string, LoadoutOverride> = {};
        for (const ov of (row.loadout_overrides || [])) if (ov.port_id) map[ov.port_id] = ov;
        overridesByShipId.set(row.id, map);
      }
    }

    // Batch-resolve every class_name that could actually fire — stock guns,
    // plus whatever override a crewed seat's claimed ship swapped in — in
    // one query instead of one per weapon.
    const allClassNames = new Set<string>();
    for (const slug of uniqueSlugs) {
      const shipData = shipDataCache.get(slug);
      if (!shipData) continue;
      for (const group of shipData.weaponGroups) {
        const seat = !group.is_bare ? shipData.rawSeats.find((s: any) => s.hardpoint_name === group.hardpoint_name) : null;
        const claimedShipId = seat ? crewedSeatLabels.get(seat.seat_label) : undefined;
        for (const gun of group.guns) {
          const override = claimedShipId ? overridesByShipId.get(claimedShipId)?.[gun.port_id || ''] : null;
          const cn = override?.class_name || gun.class_name;
          if (cn) allClassNames.add(cn);
        }
      }
    }

    const componentDetails = new Map<string, ReturnType<typeof deriveComponentDetail>>();
    if (allClassNames.size > 0) {
      const compRes = await pool.query(
        `SELECT class_name, type, size, grade, manufacturer_name, item_type_label, item_class, stats
         FROM game_ship_components WHERE game = 'star_citizen' AND class_name = ANY($1::text[])`,
        [Array.from(allClassNames)]
      );
      for (const row of compRes.rows) componentDetails.set(row.class_name, deriveComponentDetail(row));
    }

    let totalDps = 0;
    let totalBurstDps = 0;
    const dpsByType: Record<string, number> = {};
    const burstDpsByType: Record<string, number> = {};
    let missileCount = 0;
    let missileAlphaTotal = 0;
    let minRange: number | null = null;
    let maxRange: number | null = null;
    let missileLockMin: number | null = null;
    let missileLockMax: number | null = null;
    const bySeatRole = new Map<string, number>();
    const byShipSlug: { ship_slug: string; ship_name: string; manned_count: number; dps: number }[] = [];

    const addAlphaSplit = (detail: ReturnType<typeof deriveComponentDetail>, mult: number) => {
      const alphaEntries = Object.entries(detail.alpha_by_type || {});
      const alphaTotal = alphaEntries.reduce((a, [, v]) => a + v, 0);
      for (const [t, v] of alphaEntries) {
        const share = alphaTotal > 0 ? v / alphaTotal : 0;
        dpsByType[t] = (dpsByType[t] || 0) + (detail.dps || 0) * share * mult;
        burstDpsByType[t] = (burstDpsByType[t] || 0) + (detail.burst_dps || 0) * share * mult;
      }
    };

    for (const entry of composition) {
      const shipData = shipDataCache.get(entry.ship_slug);
      if (!shipData) { byShipSlug.push({ ship_slug: entry.ship_slug, ship_name: entry.ship_name, manned_count: 0, dps: 0 }); continue; }

      const piloted = Math.max(0, Math.min(pilotBudget, entry.quantity));
      pilotBudget -= piloted;
      let shipDps = 0;

      for (const group of shipData.weaponGroups) {
        let multiplier = 0;
        let claimedShipId: string | null | undefined = null;
        let roleKey: string | null = null;
        if (group.is_bare) {
          multiplier = piloted;
        } else {
          const seat = shipData.rawSeats.find((s: any) => s.hardpoint_name === group.hardpoint_name);
          if (seat && crewedSeatLabels.has(seat.seat_label)) {
            multiplier = 1;
            claimedShipId = crewedSeatLabels.get(seat.seat_label);
            roleKey = seat.role_display || seat.role;
          }
        }
        if (multiplier <= 0) continue;

        let groupDps = 0;
        for (const gun of group.guns) {
          const override = claimedShipId ? overridesByShipId.get(claimedShipId)?.[gun.port_id || ''] : null;
          const cn = override?.class_name || gun.class_name;
          if (!cn) continue;
          const detail = componentDetails.get(cn);
          if (!detail) continue;

          if (gun.type === 'Missile') {
            if (detail.missile?.damage_total) {
              missileCount += multiplier;
              missileAlphaTotal += detail.missile.damage_total * multiplier;
              if (detail.missile.lock_range_min != null) missileLockMin = missileLockMin == null ? detail.missile.lock_range_min : Math.min(missileLockMin, detail.missile.lock_range_min);
              if (detail.missile.lock_range_max != null) missileLockMax = missileLockMax == null ? detail.missile.lock_range_max : Math.max(missileLockMax, detail.missile.lock_range_max);
            }
            continue;
          }

          if (detail.dps) {
            groupDps += detail.dps * multiplier;
            totalBurstDps += (detail.burst_dps || 0) * multiplier;
            addAlphaSplit(detail, multiplier);
            if (detail.effective_range != null) {
              minRange = minRange == null ? detail.effective_range : Math.min(minRange, detail.effective_range);
              maxRange = maxRange == null ? detail.effective_range : Math.max(maxRange, detail.effective_range);
            }
          }
        }

        shipDps += groupDps;
        if (roleKey) bySeatRole.set(roleKey, (bySeatRole.get(roleKey) || 0) + groupDps);
      }

      totalDps += shipDps;
      byShipSlug.push({ ship_slug: entry.ship_slug, ship_name: entry.ship_name, manned_count: piloted, dps: Math.round(shipDps) });
    }

    const mixedComposition = uniqueSlugs.length > 1;
    if (mixedComposition) {
      warnings.push('Composition includes multiple ship types — crewed-seat attribution is approximate across different hulls.');
    }

    res.json({
      total_sustained_dps: Math.round(totalDps),
      total_burst_dps: Math.round(totalBurstDps),
      dps_by_type: dpsByType,
      burst_dps_by_type: burstDpsByType,
      by_ship_slug: byShipSlug,
      by_seat_role: Array.from(bySeatRole.entries()).map(([role, dps]) => ({ role, dps: Math.round(dps) })),
      missile_payload: missileCount > 0 ? { count: missileCount, total_alpha: Math.round(missileAlphaTotal) } : null,
      engagement_range: {
        min: minRange, max: maxRange,
        missile_lock_min: missileLockMin, missile_lock_max: missileLockMax,
        caveat: ENGAGEMENT_RANGE_CAVEAT,
      },
      approximate: mixedComposition,
      warnings,
    });
  } catch (err) {
    console.error('getGroupDpsEstimate error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Planner: approve a pending join request ───────────────────────────────────
export const approveGroupMember = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId, userId } = req.params;
  const requesterId = req.user?.id;
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (!(await canManageThisEvent(requesterId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    const result = await pool.query(
      `UPDATE event_group_members SET status = 'accepted'
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ message: 'Member not found' });
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Approved' });
  } catch (err) {
    console.error('Approve group member error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Planner: approve all pending members in a group ──────────────────────────
export const approveAllGroupMembers = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId } = req.params;
  const requesterId = req.user?.id;
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (!(await canManageThisEvent(requesterId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    const result = await pool.query(
      `UPDATE event_group_members
       SET status = 'accepted'
       WHERE group_id = $1 AND status = 'pending'`,
      [groupId]
    );
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Approved pending members', updated: result.rowCount || 0 });
  } catch (err) {
    console.error('Approve all group members error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Planner: remove a member from a group ────────────────────────────────────
export const removeGroupMember = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId, groupId, userId } = req.params;
  const requesterId = req.user?.id;
  if (!requesterId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    if (!(await canManageThisEvent(requesterId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    // Release any hangar-ship seat reservation this member's row was holding
    // before deleting it — otherwise the capacity stays blocked forever
    // (mirrors the same release done in leaveEventRole/leaveMyEventSignup).
    const memberRes = await pool.query(
      `SELECT reserved_seats_role_id, reserved_seats_count FROM event_group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    if (memberRes.rows.length > 0) {
      const { reserved_seats_role_id, reserved_seats_count } = memberRes.rows[0];
      if (reserved_seats_role_id && Number(reserved_seats_count) > 0) {
        await pool.query(
          `UPDATE event_group_roles SET reserved_slots = GREATEST(0, reserved_slots - $1) WHERE id = $2`,
          [reserved_seats_count, reserved_seats_role_id]
        );
      }
    }

    await pool.query(
      `DELETE FROM event_group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: 'Removed' });
  } catch (err) {
    console.error('Remove group member error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Accept / Decline assignment (restricted events) ───────────────────────────
export const respondEventAssignment = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  const { accept } = req.body; // boolean
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const status = accept ? 'accepted' : 'declined';
    const result = await pool.query(
      `UPDATE event_group_members SET status = $1
       WHERE user_id = $2
         AND group_id IN (SELECT id FROM event_groups WHERE event_id = $3)
       RETURNING *`,
      [status, userId, eventId]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ message: 'No assignment found for this event' });

    // Declining releases any hangar-ship seat reservation this assignment was
    // holding — a decline never converts to an actual join, so the reserved
    // capacity would otherwise stay blocked forever (same leak as
    // removeGroupMember/leaveEventRole, just via the accept/decline path).
    if (!accept) {
      for (const row of result.rows) {
        if (row.reserved_seats_role_id && Number(row.reserved_seats_count) > 0) {
          await pool.query(
            `UPDATE event_group_roles SET reserved_slots = GREATEST(0, reserved_slots - $1) WHERE id = $2`,
            [row.reserved_seats_count, row.reserved_seats_role_id]
          );
        }
      }
    }

    await publishEvent(`specter.event.org.${orgId}`, { type: 'event_roster_changed', event_id: eventId });
    res.json({ message: `Assignment ${status}` });
  } catch (err) {
    console.error('Respond event assignment error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── Get event channel tree ────────────────────────────────────────────────────
export const getEventChannelTree = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const evRes = await pool.query(
      `SELECT id, launched, command_channel_id FROM events WHERE id = $1 AND org_id = $2`,
      [eventId, orgId]
    );
    if (evRes.rows.length === 0) return res.status(404).json({ message: 'Event not found' });
    if (!evRes.rows[0].launched) return res.status(400).json({ message: 'Event not launched yet' });

    const commandChannelId = evRes.rows[0].command_channel_id;

    // Get all event channels with their parent_channel_id
    const channels = await pool.query(
      `SELECT c.id, c.name, c.parent_channel_id,
              eg.leader_user_id, u.callsign AS leader_callsign
       FROM channels c
       LEFT JOIN event_groups eg ON eg.channel_id = c.id
       LEFT JOIN users u ON eg.leader_user_id = u.id
       WHERE c.event_id = $1
       ORDER BY c.created_at ASC`,
      [eventId]
    );

    // Compute tier for each channel
    const parentMap: Record<string, string | null> = {};
    for (const ch of channels.rows) {
      parentMap[ch.id] = ch.parent_channel_id || null;
    }
    const computeTier = (channelId: string): number => {
      const parent = parentMap[channelId];
      if (!parent) return 0; // command channel
      return computeTier(parent) + 1;
    };

    const tree = channels.rows.map((ch: any) => ({
      ...ch,
      tier: computeTier(ch.id),
      is_command: ch.id === commandChannelId,
    }));

    res.json({ command_channel_id: commandChannelId, channels: tree });
  } catch (err) {
    console.error('Get event channel tree error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── My assignment for an event ────────────────────────────────────────────────
// Returns the calling user's group and its channel for a specific event.
// Used by the frontend to auto-route users to their channel when an event starts.
export const getMyEventAssignment = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    const result = await pool.query(
      `SELECT
         eg.id AS group_id, eg.name AS group_name,
         egr.id AS role_id, egr.name AS role_name,
         COALESCE(egr.priority, 3) AS priority,
         eg.channel_id,
         (SELECT name FROM channels WHERE id = eg.channel_id) AS channel_name,
         egm.role AS role_text,
         egm.status,
         e.commander_user_id,
         u.callsign AS commander_callsign,
         e.launched,
         COALESCE(egr.is_commander, false) AS is_op_commander
       FROM event_group_members egm
       JOIN event_groups eg ON eg.id = egm.group_id
       JOIN events e ON e.id = eg.event_id
       LEFT JOIN event_group_roles egr ON egm.role_id = egr.id
       LEFT JOIN users u ON u.id = e.commander_user_id
       WHERE eg.event_id = $1 AND egm.user_id = $2
         AND egm.status = 'accepted'
       ORDER BY COALESCE(egr.priority, 3) DESC`,
      [eventId, userId]
    );

    if (result.rows.length === 0)
      return res.json({ assignment: null });

    // monitor_channels (a role monitoring extra *group* channels via
    // channel_group_ids) was never wired to any UI control and has been
    // removed — kept as an always-empty key for compatibility with any client
    // not redeployed atomically, rather than dropping it outright.
    const enriched = result.rows.map((row: any) => ({
      ...row,
      monitor_channels: [] as any[],
    }));

    // Resolve liaison frequencies accessible by the user's role IDs
    const roleIds = result.rows.map((r: any) => r.role_id).filter(Boolean);
    let frequencies: any[] = [];
    if (roleIds.length > 0) {
      const freqRes = await pool.query(
        `SELECT DISTINCT ef.id, ef.name, ef.channel_id, ch.name AS channel_name, ef.sort_order
         FROM event_frequencies ef
         JOIN event_frequency_roles efr ON efr.frequency_id = ef.id
         JOIN channels ch ON ch.id = ef.channel_id
         WHERE efr.role_id = ANY($1) AND ef.channel_id IS NOT NULL
         ORDER BY ef.sort_order`,
        [roleIds]
      );
      frequencies = freqRes.rows;
    }

    // First row = highest priority role = primary; rest are secondary roles = monitor
    const isOpCommander = enriched.some((r: any) => r.is_op_commander === true);
    res.json({ assignment: { ...enriched[0], frequencies, is_op_commander: isOpCommander }, assignments: enriched });
  } catch (err) {
    console.error('Get my event assignment error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── End operation ─────────────────────────────────────────────────────────────
// Commander or event manager ends the operation.
// mode='lobby'   → move all event-channel users to the first public channel, delete event channels
// mode='debrief' → auto-create a debrief channel, move all event-channel users there, delete event channels
export const endOperation = async (req: AuthRequest, res: Response) => {
  const { orgId, eventId } = req.params;
  const userId = req.user?.id;
  const { mode } = req.body; // mode: 'lobby' | 'debrief'
  if (!userId) return res.status(401).json({ message: 'Unauthorized' });

  try {
    // Verify the caller can manage this event
    if (!(await canManageThisEvent(userId, orgId, eventId)))
      return res.status(403).json({ message: 'Forbidden' });

    const evRes = await pool.query(
      `SELECT name, commander_user_id, launched FROM events WHERE id = $1 AND org_id = $2`,
      [eventId, orgId]
    );
    if (evRes.rows.length === 0) return res.status(404).json({ message: 'Event not found' });
    if (!evRes.rows[0].launched)
      return res.status(409).json({ message: 'Event is not currently launched' });

    const eventName: string = evRes.rows[0].name;

    // Get all event channel IDs for this operation
    const eventChannelsRes = await pool.query(
      `SELECT id FROM channels WHERE event_id = $1`,
      [eventId]
    );
    const eventChannelIds: string[] = eventChannelsRes.rows.map((r: any) => r.id);

    let targetChannelId: string | null = null;
    let targetChannelName: string = '';
    let debriefChannelId: string | null = null;

    if (mode === 'debrief') {
      // Auto-create a dedicated debrief channel for this event
      const debriefRes = await pool.query(
        `INSERT INTO channels (org_id, event_id, name, type, channel_kind, min_tier, ducking_level)
         VALUES ($1, $2, $3, 0, 0, 0, 0.0)
         RETURNING id, name`,
        [orgId, eventId, `DEBRIEF: ${eventName}`.substring(0, 32)]
      );
      targetChannelId   = debriefRes.rows[0].id;
      targetChannelName = debriefRes.rows[0].name;
      debriefChannelId = targetChannelId;

      // Broadcast the new channel to all clients before the move
      await publishEvent(`specter.event.org.${orgId}`, {
        type: 'channel_created',
        channel: debriefRes.rows[0],
      });
    } else {
      // Lobby mode: route everyone to the first public permanent channel
      const lobbyRes = await pool.query(
        `SELECT id, name FROM channels
         WHERE org_id = $1 AND event_id IS NULL AND type = 0
         ORDER BY created_at ASC
         LIMIT 1`,
        [orgId]
      );
      if (lobbyRes.rowCount) {
        targetChannelId   = lobbyRes.rows[0].id;
        targetChannelName = lobbyRes.rows[0].name;
      }
    }

    // Perform server-side subscription move (if a target exists)
    if (targetChannelId && eventChannelIds.length > 0) {
      await bulkMoveUsers(orgId as string, eventChannelIds, targetChannelId, targetChannelName);
    }

    // Mark event as ended. ended_at (distinct from launched/end_time) is what
    // drives "remove from calendar, show in history" — see migration 000034.
    await pool.query(
      `UPDATE events SET launched = false, end_time = COALESCE(end_time, NOW()), ended_at = NOW() WHERE id = $1`,
      [eventId]
    );

    // Notify all clients — include the destination so they can navigate
    await publishEvent(`specter.event.org.${orgId}`, {
      type: 'operation_ended',
      eventId,
      mode: mode === 'debrief' ? 'debrief' : 'lobby',
      target_channel_id:   targetChannelId,
      target_channel_name: targetChannelName,
    });

    // Schedule operation channel cleanup after a short grace period so clients
    // can receive the move signal and disconnect from the WebTransport first.
    if (eventChannelIds.length > 0) {
      setTimeout(async () => {
        try {
          await pool.query(`DELETE FROM channels WHERE id = ANY($1::uuid[])`, [eventChannelIds]);
          await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_deleted' });
        } catch (cleanupErr) {
          console.error('Operation channel cleanup error:', cleanupErr);
        }
      }, 8_000); // 8 s grace period
    }

    // Debrief channels are ephemeral and auto-expire.
    if (debriefChannelId) {
      setTimeout(async () => {
        try {
          await pool.query(`DELETE FROM channels WHERE id = $1`, [debriefChannelId]);
          await publishEvent(`specter.event.org.${orgId}`, { type: 'channel_deleted', channelId: debriefChannelId });
        } catch (cleanupErr) {
          console.error('Debrief channel cleanup error:', cleanupErr);
        }
      }, 45 * 60_000); // 45 minutes
    }

    res.json({ message: 'Operation ended', target_channel_id: targetChannelId, target_channel_name: targetChannelName });
  } catch (err) {
    console.error('End operation error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};
