// Operation group-plan data helpers, shared by the full OperationPlanner and
// the tray strip's planner. Plain functions over the planner's local `groups`
// shape (index-linked: parent_index / linked_index point into the array), so
// both surfaces load, edit and save a plan the same way. Moved out of
// OperationPlanner.jsx unchanged; the server stays authoritative for every
// permission and slot rule these only mirror for UI framing.

// Mirrors PILOT_ROLE_NAMES in eventsController.ts — which role names
// identify "the person providing this hull," so their JOIN button can be
// replaced with the ship-slot-claim flow instead (see ShipSlotClaims).
// The backend is authoritative; this only drives client-side UI framing.
export const PILOT_ROLE_NAMES = new Set(['Pilot', 'Captain']);

// Roots and a parent index → child indices map for the index-linked groups.
export function buildGroupTree(groups) {
  const roots = [];
  const childrenMap = {};
  groups.forEach((g, i) => {
    const pi = g.parent_index;
    if (pi === null || pi === undefined) {
      roots.push(i);
    } else {
      if (!childrenMap[pi]) childrenMap[pi] = [];
      childrenMap[pi].push(i);
    }
  });
  return { roots, childrenMap };
}

// Returns true if making dragIdx a child of targetIdx would create a cycle
export function wouldCreateCycle(targetIdx, dragIdx, groups) {
  if (targetIdx === dragIdx) return true;
  const visited = new Set();
  const queue = [dragIdx];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === targetIdx) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    groups.forEach((g, i) => { if (g.parent_index === cur) queue.push(i); });
  }
  return false;
}

// Depth in the hierarchy tree (roots = 1) for priority-tier labeling
export function computeDepth(idx, groups, memo = {}) {
  if (idx in memo) return memo[idx];
  const pi = groups[idx]?.parent_index;
  const d = (pi !== null && pi !== undefined) ? computeDepth(pi, groups, memo) + 1 : 1;
  memo[idx] = d;
  return d;
}

// `Group ${prev.length + 1}` collided with existing names after any group
// had been removed (array length no longer matches the highest number used
// so far) — e.g. remove "Group 2" from [1,2,3], add a new one: length is 2,
// so it's named "Group 3", colliding with the group already holding that
// name. Scan existing names for the highest "Group N" actually in use instead.
export function nextGroupName(currentGroups) {
  let maxN = 0;
  for (const g of currentGroups) {
    const m = /^Group (\d+)$/.exec(g.name || '');
    if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
  }
  return `Group ${maxN + 1}`;
}

// A fresh, unsaved group (no id yet — the server creates it on save).
export function newGroup(name, parentIndex = null) {
  return {
    name,
    max_members: 0,
    parent_index: parentIndex ?? null,
    linked_index: null,
    roles: [],
    member_user_ids: [],
    member_roles: {},
    member_statuses: {},
    member_role_ids: {},
    member_callsigns: {},
  };
}

// A fresh, unsaved role with the planner's defaults.
export function newRole(name = '') {
  return { name, priority: 3, channel_group_index: null, assignment_mode: 'open', assigned_user_id: '', max_slots: 1, is_commander: false };
}

// Removes group i and re-points parent/linked indices past it. Children of
// the removed group become roots.
export function removeGroupAt(groups, i) {
  const filtered = groups.filter((_, idx) => idx !== i);
  return filtered.map(g => {
    const updated = { ...g };
    if (updated.parent_index === i) updated.parent_index = null;
    else if (updated.parent_index > i) updated.parent_index = updated.parent_index - 1;
    if (updated.linked_index === i) updated.linked_index = null;
    else if (updated.linked_index !== null && updated.linked_index !== undefined && updated.linked_index > i) updated.linked_index = updated.linked_index - 1;
    return updated;
  });
}

// Makes group `idx` report to `parentIdx` (null = top tier). Returns the
// groups unchanged when that would create a cycle or is a no-op — the
// drag-and-drop re-parent of both planners.
export function reparentGroup(groups, idx, parentIdx) {
  if (idx === null || idx === undefined || !groups[idx]) return groups;
  const target = parentIdx ?? null;
  if (target !== null && (target === idx || wouldCreateCycle(target, idx, groups))) return groups;
  if ((groups[idx].parent_index ?? null) === target) return groups;
  return groups.map((g, i) => (i === idx ? { ...g, parent_index: target } : g));
}

// ── Linked groups ──────────────────────────────────────────────────────────
// A group may be linked to one other (linked_index); each linked pair gets a
// colour from this palette in the tree.
export const LINK_PALETTE = ['#06b6d4', '#a855f7', '#f59e0b', '#10b981', '#f43f5e', '#6366f1', '#ec4899'];

export function computeLinkColors(groups) {
  const colors = {};
  let ci = 0;
  for (let i = 0; i < groups.length; i++) {
    const li = groups[i].linked_index;
    if (li !== null && li !== undefined && !colors[i]) {
      const c = LINK_PALETTE[ci % LINK_PALETTE.length];
      colors[i] = c;
      colors[li] = c;
      ci++;
    }
  }
  return colors;
}

// ── Ship composition ───────────────────────────────────────────────────────
// Maps a scunpacked-derived crew-role group onto the same role shape the
// planner's addRole() produces, so generated roles are editable like any
// manually-added one.
export function shipRoleToGroupRole(r) {
  return {
    name: r.display_name,
    priority: 3,
    channel_group_index: null,
    assignment_mode: 'open',
    assigned_user_id: '',
    max_slots: r.count,
    is_commander: false,
    seat_labels: r.seat_labels || [],
  };
}

// Per-ship crew roles ([{ quantity, roles }]) → one summed list: role counts
// scaled by each ship's quantity and merged by display_name (e.g. 3x fighter
// → Pilot x3); seat labels concatenated, capped at 12.
export function sumShipCrewRoles(perShip) {
  const summed = new Map();
  for (const { quantity, roles } of perShip) {
    for (const role of roles) {
      const key = role.display_name;
      const entry = summed.get(key) || { display_name: key, count: 0, seat_labels: [] };
      entry.count += (role.count || 0) * quantity;
      entry.seat_labels = entry.seat_labels.concat(role.seat_labels || []);
      summed.set(key, entry);
    }
  }
  return Array.from(summed.values()).map(r => ({ ...r, seat_labels: r.seat_labels.slice(0, 12) }));
}

// ── Presets ────────────────────────────────────────────────────────────────
// A preset stores only the group skeleton (names, sizes, tree, links).
export function presetLayoutFromGroups(groups) {
  return groups.map(g => ({
    name: g.name,
    max_members: g.max_members || 0,
    parent_index: g.parent_index ?? null,
    linked_index: g.linked_index ?? null,
  }));
}

// A preset's layout → fresh planner groups (no ids, roles or members), which
// replace the current plan when loaded.
export function groupsFromPresetLayout(layout) {
  return (layout || []).map((g, i) => ({
    name: g.name || `Group ${i + 1}`,
    max_members: g.max_members || 0,
    parent_index: g.parent_index ?? null,
    linked_index: g.linked_index ?? null,
    roles: [],
    member_user_ids: [],
    member_roles: {},
    member_statuses: {},
  }));
}

// ── Frequencies ────────────────────────────────────────────────────────────
// Frequencies are op-wide liaison channels; role_refs ({ group_index,
// role_index }) say which roles can reach each one.
export function newFrequency(existing) {
  return { name: `FREQ ${String.fromCharCode(65 + existing.length)}`, role_refs: [] };
}

const hasRef = (f, gi, ri) => (f.role_refs || []).some(ref => ref.group_index === gi && ref.role_index === ri);

export function frequencyHasRole(freq, gi, ri) {
  return hasRef(freq, gi, ri);
}

// Adds or removes role (gi, ri) on frequency fi.
export function toggleFrequencyRole(frequencies, fi, gi, ri) {
  return frequencies.map((f, i) => {
    if (i !== fi) return f;
    const refs = hasRef(f, gi, ri)
      ? (f.role_refs || []).filter(ref => !(ref.group_index === gi && ref.role_index === ri))
      : [...(f.role_refs || []), { group_index: gi, role_index: ri }];
    return { ...f, role_refs: refs };
  });
}

export function addFrequencyRole(frequencies, fi, gi, ri) {
  return frequencies.map((f, i) => (i !== fi ? f : { ...f, role_refs: [...(f.role_refs || []), { group_index: gi, role_index: ri }] }));
}

export function removeFrequencyRole(frequencies, fi, gi, ri) {
  return frequencies.map((f, i) => (i !== fi ? f : {
    ...f, role_refs: (f.role_refs || []).filter(ref => !(ref.group_index === gi && ref.role_index === ri)),
  }));
}

export function renameFrequency(frequencies, fi, name) {
  return frequencies.map((f, i) => (i === fi ? { ...f, name: name.toUpperCase().slice(0, 32) } : f));
}

// ── LEADFREQ: the Leadership net ───────────────────────────────────────────
// Every new event starts with a Leadership frequency (the server seeds it at
// creation, marked is_leadership, first in the list). With end-to-end voice
// a group leader can't also sit in the parent channel (each channel has its
// own key), so leaders talk on this event frequency alongside their group.
// Planners assign it to roles like any frequency; leader-named roles get it
// by default when added from a template.
export const LEADERSHIP_FREQ_NAME = 'LEADERSHIP';

// Role names that mean "leads people": Commander / Op Commander / Cmdr,
// Leader / Squad Lead / Flight Lead / Wing Lead / Team Lead / Lead, Captain, XO.
const LEADER_ROLE_RE = /\b(commander|cmdr|leader|lead|captain|xo)\b/i;

export function isLeadershipRoleName(name) {
  return LEADER_ROLE_RE.test(String(name || ''));
}

export function newLeadershipFrequency() {
  return { name: LEADERSHIP_FREQ_NAME, is_leadership: true, role_refs: [] };
}

/** Index of the Leadership net, or -1. */
export function leadershipFrequencyIndex(frequencies) {
  return (frequencies || []).findIndex((f) => f?.is_leadership === true);
}

/** The frequencies with a Leadership net first (unchanged if one exists). */
export function ensureLeadershipFrequency(frequencies) {
  const list = frequencies || [];
  return leadershipFrequencyIndex(list) >= 0 ? list : [newLeadershipFrequency(), ...list];
}

/** Puts role (gi, ri) on the Leadership net or takes it off. No-op without one. */
export function toggleLeadershipRole(frequencies, gi, ri) {
  const li = leadershipFrequencyIndex(frequencies);
  return li < 0 ? frequencies : toggleFrequencyRole(frequencies, li, gi, ri);
}

/** Default for a role just added as (gi, ri): leader-named roles join the Leadership net. */
export function assignLeadershipDefault(frequencies, gi, ri, roleName) {
  const li = leadershipFrequencyIndex(frequencies);
  if (li < 0 || !isLeadershipRoleName(roleName) || hasRef(frequencies[li], gi, ri)) return frequencies;
  return addFrequencyRole(frequencies, li, gi, ri);
}

/** Every leader-named role of the plan onto the Leadership net (keeps the others). */
export function assignAllLeaderRoles(frequencies, groups) {
  let next = frequencies;
  (groups || []).forEach((g, gi) => (g.roles || []).forEach((r, ri) => {
    next = assignLeadershipDefault(next, gi, ri, r.name);
  }));
  return next;
}

/**
 * Role (gi, ri) was removed from its group: drop every frequency's ref to it
 * and shift the refs to the roles after it, so role_refs (index-based) keep
 * pointing at the same roles.
 */
export function removeRoleFromFrequencies(frequencies, gi, ri) {
  return (frequencies || []).map((f) => ({
    ...f,
    role_refs: (f.role_refs || [])
      .filter((ref) => !(ref.group_index === gi && ref.role_index === ri))
      .map((ref) => (ref.group_index === gi && ref.role_index > ri ? { ...ref, role_index: ref.role_index - 1 } : ref)),
  }));
}

// One frequency against the plan: which roles are authorised, which could be
// added, and the directly-assigned personnel that reach it.
export function describeFrequency(freq, groups, members = []) {
  const allRoles = groups.flatMap((g, gi) => (g.roles || []).map((r, ri) => ({ gi, ri, g, r })));
  const authorized = (freq.role_refs || [])
    .map(ref => allRoles.find(x => x.gi === ref.group_index && x.ri === ref.role_index))
    .filter(Boolean);
  const available = allRoles.filter(x => !authorized.some(a => a.gi === x.gi && a.ri === x.ri));
  const assigned = authorized.flatMap(({ g, r }) => {
    if (r.assignment_mode === 'direct' && r.assigned_user_id) {
      const cs = r.assigned_callsign ||
        (members || []).find(m => m.user_id === r.assigned_user_id)?.callsign ||
        r.assigned_user_id;
      return [{ callsign: cs, via: `${g.name} › ${r.name}` }];
    }
    return [];
  });
  return { allRoles, authorized, available, assigned };
}

// ── Post-launch channel tree ───────────────────────────────────────────────
// GET /events/:id/channel-tree rows → { roots, childMap } by parent_channel_id.
export function buildChannelTree(channels) {
  const childMap = {};
  const roots = [];
  for (const ch of channels) {
    if (!ch.parent_channel_id) {
      roots.push(ch);
    } else {
      if (!childMap[ch.parent_channel_id]) childMap[ch.parent_channel_id] = [];
      childMap[ch.parent_channel_id].push(ch);
    }
  }
  return { roots, childMap };
}

// GET /events/:id/groups response → the planner's local { groups, frequencies }.
export function mapEventGroups(data) {
  const rawGroups = data?.groups || [];
  const groupIdToIndex = {};
  rawGroups.forEach((g, i) => { groupIdToIndex[g.id] = i; });
  const groups = rawGroups.map(g => ({
    id: g.id,
    name: g.name,
    max_members: g.max_members || 0,
    // Not editable anywhere in the planner (leadership is handled via the
    // is_commander role flag below instead) — carried through unchanged so
    // a save doesn't silently null out legacy data on older events that
    // still have it set.
    leader_user_id: g.leader_user_id || null,
    parent_index: g.parent_group_id ? (groupIdToIndex[g.parent_group_id] ?? null) : null,
    linked_index: g.linked_group_id ? (groupIdToIndex[g.linked_group_id] ?? null) : null,
    // EVVIEW: `claims` (who is bringing which hull) and each role's
    // `taken_seats` are read-only server state that getRoleJoinState and
    // useShipSlotClaims already read; they were dropped here, so a crew role
    // in a ship group always looked 'awaiting-ship' and taken seats were
    // still offered. buildEventGroupsPayload never sends them back.
    ships: (g.ships || []).map(s => ({
      ship_slug: s.ship_slug, ship_name: s.ship_name, ship_icon_url: s.ship_icon_url || null, quantity: s.quantity || 1,
      claims: s.claims || [],
    })),
    roles: (g.roles || []).map(r => ({
      taken_seats: r.taken_seats || [],
      id: r.id,
      name: r.name || '',
      priority: r.priority || 3,
      assignment_mode: r.assignment_mode || 'open',
      assigned_user_id: r.assigned_user_id || '',
      assigned_callsign: r.assigned_callsign || '',
      assigned_status: r.assigned_status || null,
      max_slots: r.max_slots || 1,
      filled_slots: r.filled_slots || 0,
      reserved_slots: r.reserved_slots || 0,
      is_commander: r.is_commander || false,
      auto_approve: r.auto_approve !== false,
      seat_labels: r.seat_labels || null,
    })),
    // Keep member_user_ids for org-chart node display + multi-channel indicator
    member_user_ids: (g.members || []).map(m => m.user_id),
    member_statuses: (g.members || []).reduce((acc, m) => { acc[m.user_id] = m.status || 'pending'; return acc; }, {}),
    member_roles: (g.members || []).reduce((acc, m) => { acc[m.user_id] = m.role || ''; return acc; }, {}),
    member_role_ids: (g.members || []).reduce((acc, m) => { acc[m.user_id] = m.role_id || null; return acc; }, {}),
    member_callsigns: (g.members || []).reduce((acc, m) => { acc[m.user_id] = m.callsign || m.user_id; return acc; }, {}),
    member_seat_labels: (g.members || []).reduce((acc, m) => { acc[m.user_id] = m.seat_label || null; return acc; }, {}),
  }));
  // Frequencies' role_refs use group_index / role_index relative to rawGroups order.
  const frequencies = (data?.frequencies || []).map(f => ({
    id: f.id,
    name: f.name || '',
    is_leadership: f.is_leadership === true, // LEADFREQ
    role_refs: (f.role_refs || []).map(r => ({ group_index: r.gi ?? r.group_index, role_index: r.ri ?? r.role_index })),
  }));
  return { groups, frequencies };
}

// The planner's local { groups, frequencies } → PUT /events/:id/groups body.
export function buildEventGroupsPayload(groups, frequencies) {
  // Topological sort: parents must always precede children in the payload so
  // the backend can resolve parent_group_id by sequential index.
  const sortedIndices = [];
  const visited = new Set();
  const visit = (idx) => {
    if (visited.has(idx)) return;
    visited.add(idx);
    const pi = groups[idx].parent_index;
    if (pi !== null && pi !== undefined) visit(pi);
    sortedIndices.push(idx);
  };
  groups.forEach((_, i) => visit(i));
  const oldToNew = {};
  sortedIndices.forEach((oldIdx, newIdx) => { oldToNew[oldIdx] = newIdx; });

  return {
    groups: sortedIndices.map(oldIdx => {
      const g = groups[oldIdx];
      return {
        // Real DB id when this group already exists (from load()) so the backend
        // can update it in place instead of destroying and recreating it, which
        // would wipe every member row (including self-signups) on every save.
        id: g.id || null,
        name: g.name,
        max_members: g.max_members || 0,
        // Round-tripped from load() unchanged — see mapEventGroups. Previously
        // omitted here entirely, so the server's UPDATE silently nulled it out
        // on every single save regardless of what was actually set.
        leader_user_id: g.leader_user_id || null,
        parent_index: (g.parent_index !== null && g.parent_index !== undefined) ? oldToNew[g.parent_index] : null,
        linked_index: (g.linked_index !== null && g.linked_index !== undefined) ? oldToNew[g.linked_index] : null,
        ships: (g.ships || []).map(s => ({
          ship_slug: s.ship_slug, ship_name: s.ship_name, ship_icon_url: s.ship_icon_url || null, quantity: s.quantity || 1,
        })),
        roles: (g.roles || []).map(r => ({
          id: r.id || null,
          name: r.name,
          priority: r.priority || 3,
          assignment_mode: r.assignment_mode || 'open',
          assigned_user_id: r.assigned_user_id || null,
          max_slots: r.max_slots || 1,
          is_commander: r.is_commander === true,
          auto_approve: r.auto_approve !== false,
          seat_labels: r.seat_labels || null,
        })),
      };
    }),
    frequencies: (frequencies || []).map(f => ({
      id: f.id || null,
      name: f.name,
      is_leadership: f.is_leadership === true, // LEADFREQ
      role_refs: (f.role_refs || []).map(ref => ({
        group_index: (ref.group_index !== null && ref.group_index !== undefined) ? (oldToNew[ref.group_index] ?? ref.group_index) : null,
        role_index: ref.role_index,
      })).filter(r => r.group_index !== null && r.group_index !== undefined),
    })),
  };
}

// The event form → POST/PUT /events body (OperationPlanner's EventHeader).
// `startNow` stamps the current time; times are datetime-local strings.
export function buildEventBody({ name, startNow, startTime, endTime, accessMode, game, plannerIds, meetupLocation }) {
  return {
    name: name.trim(),
    start_time: startNow ? new Date().toISOString() : new Date(startTime).toISOString(),
    end_time: endTime ? new Date(endTime).toISOString() : null,
    access_mode: accessMode,
    game,
    planner_ids: plannerIds,
    meetup_location: meetupLocation ? (meetupLocation.trim() || null) : null,
  };
}

/**
 * What the current user can do with one OPEN role of a group, before launch —
 * the same decision OperationPlanner's view-only panel makes per role.
 * Returns { action, hasSlot, filled, reserved, max, needsSeatChoice,
 * availableSeats, takenSeats, mySeatLabel } where action is one of:
 *   'leave'        accepted in this role
 *   'pending'      join request awaiting approval
 *   'claim-ship'   pilot/captain of a ship-composed group (claim a hull instead)
 *   'awaiting-ship' no hull claimed in this ship-composed group yet
 *   'join'         a slot is free
 *   'join-full'    role is full; joining still adds you to the group
 *   null           nothing to do (already in another role of this group)
 * A full role still lets you into the group's channel — roles only gate
 * frequency/priority within the group, not group membership — so the server
 * falls back to plain group membership on a full role.
 */
export function getRoleJoinState(group, role, myUserId) {
  const myRoleId = group.member_role_ids?.[myUserId];
  const myStatus = group.member_statuses?.[myUserId];
  const amAcceptedInRole = myRoleId === role.id && myStatus === 'accepted';
  const amPendingInRole = myRoleId === role.id && myStatus === 'pending';
  const filled = Number(role.filled_slots) || 0;
  const reserved = Number(role.reserved_slots) || 0;
  const max = Number(role.max_slots) || 1;
  const hasSlot = filled + reserved < max;
  const alreadyInAGroup = !!myRoleId || ((group.member_user_ids || []).includes(myUserId) && !myRoleId);
  const seatLabels = Array.isArray(role.seat_labels) ? role.seat_labels : [];
  const takenSeats = role.taken_seats || [];
  const takenSeatSet = new Set(takenSeats.map(t => t.seat_label));
  const availableSeats = seatLabels.filter(s => !takenSeatSet.has(s));
  const needsSeatChoice = seatLabels.length > 1;
  // Ship-composed groups gate crew joins on a ship slot being claimed first
  // (see ShipSlotClaims/claimShipSlot) — Pilot/Captain can ONLY be reached by
  // claiming; other roles just need *some* hull claimed (a client-side
  // approximation of the backend's per-slug check in joinEventRole, which is
  // authoritative — this only pre-empts the obvious all-unclaimed case).
  const isShipComposed = (group.ships || []).length > 0;
  const isPilotRole = PILOT_ROLE_NAMES.has(role.name);
  const anyShipClaimed = (group.ships || []).some(s => (s.claims || []).length > 0);

  let action = null;
  if (amAcceptedInRole) action = 'leave';
  else if (amPendingInRole) action = 'pending';
  else if (isShipComposed && isPilotRole) action = 'claim-ship';
  else if (!alreadyInAGroup) {
    if (isShipComposed && !isPilotRole && !anyShipClaimed) action = 'awaiting-ship';
    else action = hasSlot ? 'join' : 'join-full';
  }
  return {
    action, hasSlot, filled, reserved, max, needsSeatChoice, availableSeats, takenSeats,
    mySeatLabel: (amAcceptedInRole || amPendingInRole) ? (group.member_seat_labels?.[myUserId] || null) : null,
    amAcceptedInRole, amPendingInRole,
  };
}

// The current user's own place in a loaded plan: the group they're in (if
// any) and their role/status there, preferring the server's my-assignment.
export function getMyPlacement(groups, myAssignment, myUserId) {
  const myGroup = groups.find(g => (g.member_user_ids || []).includes(myUserId)) || null;
  return {
    group: myGroup,
    groupName: myAssignment?.group_name || myGroup?.name || null,
    status: myAssignment?.status || myGroup?.member_statuses?.[myUserId] || null,
    role: myAssignment?.role || myGroup?.member_roles?.[myUserId] || '',
    isCommander: myAssignment?.is_op_commander === true,
  };
}
