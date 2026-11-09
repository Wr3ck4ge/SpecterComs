// Dev-only gallery for the tray strip — loaded by /strip-preview.html, which
// is not a production build input. Renders the presentational StripView with
// canned props (no Tauri runtime: StripApp's invoke/listen calls are what the
// real window adds on top). Each frame is the bar column (420 CSS px) or, for
// the Channels frames, a slice of the full-work-area window (P2A) over a fake desktop; the dashed outlines are the window
// region strip.rs would clip to (the [data-strip-region] rects + 6px).
/* eslint-disable react-refresh/only-export-components -- entry module, not a component library */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../strip.css';
import StripView from '../components/strip/StripView';
import ChannelsCabinet, { UnreadPill, VoiceChannelPanel } from '../components/strip/ChannelsCabinet';
// P2A
import { StripFrame, MAIN_WIDTH } from '../components/strip/StripSidePanel';
import StripChat from '../components/strip/StripChat';
import { SharePicker } from '../components/strip/StripVoiceControls';
import { voiceSlots } from '../components/strip/voiceSlots'; // BAR2
import useFluidExpand, { fluidSlotStyle } from '../components/strip/useFluidExpand';
import { CMD, EMPTY_STATE, totalUnread } from '../engine/bridge';
import { cmdKey } from '../components/strip/useEngine';
import OpView from '../components/strip/OpView';
import OpPlanner from '../components/strip/OpPlanner';
import { getOpsBadge, getOpsNotifications } from '../utils/opsEvents';
import { opCloseDelay, PLANNER_MAP_ENABLED } from '../components/strip/stripOpsLayout';

const noop = () => {};
const preventing = (e) => e?.preventDefault?.();

const ORGS = [
  { id: 'o1', name: 'Ghost Fleet', member_count: 42, logo_url: null },
  { id: 'o2', name: 'Red Dawn Logistics', member_count: 17, logo_url: null },
  { id: 'o3', name: 'Night Owls Mining Co.', member_count: 1, logo_url: null },
];

const login = (over = {}) => ({
  email: 'ghost@example.com', password: 'hunter22', onEmailChange: noop, onPasswordChange: noop,
  onSubmit: preventing, loading: false, error: null, notice: null, onForgotPassword: noop, onCreateAccount: noop, ...over,
});
const forgot = (over = {}) => ({
  email: 'ghost@example.com', onEmailChange: noop, onSubmit: preventing, loading: false, error: null, success: null, onBack: noop, ...over,
});

// ── S10 mocks: operations, a plan, notifications ───────────────────────────
const ME = { id: 'u-me', callsign: 'Ghost' };
const at = (mins) => new Date(Date.now() + mins * 60000).toISOString();
const MEMBERS = ['Ghost', 'Viper', 'Nomad', 'Raven', 'Havoc', 'Echo', 'Saber', 'Wraith'].map((c, i) => ({ user_id: i ? `u${i}` : 'u-me', callsign: c }));
const EVENTS = [
  { id: 'e1', name: 'Operation Thunderstrike', start_time: at(-25), end_time: at(95), launched: true, access_mode: 'open', game: 'star_citizen', total_slots: 12, filled_slots: 9, creator_id: 'u1', planners: [] },
  { id: 'e2', name: 'Convoy Escort — Hurston', start_time: at(18), end_time: at(138), launched: false, access_mode: 'open', game: 'star_citizen', total_slots: 8, filled_slots: 5, creator_id: 'u-me', planners: [], meetup_location: 'Lorville, Teasa Spaceport pad 04' },
  { id: 'e3', name: 'Mining run: Aaron Halo', start_time: at(60 * 5), end_time: null, launched: false, access_mode: 'restricted', game: 'star_citizen', total_slots: 6, filled_slots: 2, creator_id: 'u2', planners: [] },
  { id: 'e4', name: 'Fleet training night', start_time: at(60 * 24 * 2 + 30), end_time: at(60 * 24 * 2 + 150), launched: false, access_mode: 'open', game: 'none', total_slots: 20, filled_slots: 4, creator_id: 'u3', planners: [] },
  { id: 'e5', name: 'Bounty sweep', start_time: at(60 * 24 * 6), end_time: null, launched: false, access_mode: 'open', game: 'none', total_slots: 0, filled_slots: 0, creator_id: 'u3', planners: [] },
];
const MINE = [
  { id: 'e2', name: 'Convoy Escort — Hurston', org_id: 'o1', org_callsign: 'Ghost Fleet', start_time: EVENTS[1].start_time, end_time: EVENTS[1].end_time, launched: false },
  { id: 'x9', name: 'Joint patrol', org_id: 'o2', org_callsign: 'Red Dawn Logistics', start_time: at(-5), end_time: at(60), launched: true },
];
const OPEN_SOON = { id: 'e6', name: 'Salvage pickup', start_time: at(40), end_time: null, launched: false, access_mode: 'open', total_slots: 4, filled_slots: 1, creator_id: 'u4', planners: [] };

const role = (id, name, o = {}) => ({ id, name, priority: 3, assignment_mode: 'open', assigned_user_id: '', max_slots: 1, filled_slots: 0, reserved_slots: 0, is_commander: false, auto_approve: true, seat_labels: null, ...o });
const grp = (id, name, parent, roles, members = {}) => ({
  id, name, max_members: 0, parent_index: parent, linked_index: null, ships: [], roles,
  member_user_ids: Object.keys(members),
  member_statuses: Object.fromEntries(Object.entries(members).map(([u, m]) => [u, m.status || 'accepted'])),
  member_role_ids: Object.fromEntries(Object.entries(members).map(([u, m]) => [u, m.role])),
  member_roles: {}, member_callsigns: Object.fromEntries(Object.entries(members).map(([u, m]) => [u, m.callsign || u])), member_seat_labels: {},
});
const PLAN_GROUPS = [
  grp('g0', 'Command', null, [role('r0', 'Op Lead', { is_commander: true, assignment_mode: 'direct', assigned_user_id: 'u1', assigned_callsign: 'Viper', priority: 5 })], { u1: { role: 'r0' } }),
  grp('g1', 'Escort Wing', 0, [role('r1', 'Wing Lead', { priority: 4, filled_slots: 1 }), role('r2', 'Fighter', { max_slots: 4, filled_slots: 2 })], { 'u-me': { role: 'r2' }, u5: { role: 'r2' }, u2: { role: 'r1' } }),
  grp('g2', 'Cargo', 0, [role('r3', 'Hauler', { max_slots: 2, filled_slots: 1, auto_approve: false }), role('r4', 'Turret', { max_slots: 3, seat_labels: ['Top', 'Belly', 'Rear'] })], { u3: { role: 'r3' }, u6: { role: 'r3', status: 'pending', callsign: 'Echo' } }),
  grp('g3', 'Red flight', 1, [role('r5', 'Fighter', { max_slots: 2 })]),
  grp('g4', 'Blue flight', 1, [role('r6', 'Fighter', { max_slots: 2, filled_slots: 2 })]),
  grp('g5', 'Scouts', 2, [role('r7', 'Scout', { max_slots: 2 })]),
];

function mockOps({ events = EVENTS, mine = MINE, canSchedule = true, unread = true } = {}) {
  const notifications = getOpsNotifications({ mine, events, orgId: 'o1' });
  return {
    user: ME, visible: true, pickerBusy: false, events, eventsLoading: false, eventsError: null, mine,
    badge: getOpsBadge(events), notifications, unreadCount: unread ? notifications.length : 0, readKeys: new Set(), markRead: noop,
    planVersion: 0, editors: {}, canSchedule, canLaunch: (ev) => canSchedule && !ev.launched, canEdit: () => canSchedule,
    refresh: noop, launch: async () => ({}), quickJoin: async () => ({ data: { message: 'Signed up' } }),
  };
}

const SHIP_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M32 6 L40 30 L58 40 L40 42 L36 58 L32 50 L28 58 L24 42 L6 40 L24 30 Z" fill="#9fb4c8" stroke="#67daf5" stroke-width="2"/></svg>');
// P2B: ships, frequencies, presets, claims and a channel tree for the wide planner.
const SHIP_GROUPS = PLAN_GROUPS.map((g, i) => (i === 1 ? {
  // A loading icon (data: URI stands in for the Fleetyards image) …
  ...g, linked_index: 2, ships: [{ ship_slug: 'anvil-hornet-f7c', ship_name: 'Hornet F7C', ship_icon_url: SHIP_ICON, quantity: 3 }],
} : i === 2 ? {
  // … and a failing one (falls back to the initials badge).
  ...g, linked_index: 1, ships: [{ ship_slug: 'drake-caterpillar', ship_name: 'Caterpillar', ship_icon_url: 'https://invalid.example/caterpillar.png', quantity: 1 }, { ship_slug: 'aegis-hammerhead', ship_name: 'Hammerhead', ship_icon_url: null, quantity: 1 }],
} : g));
// OPGROW: a two-group tree and a 4-tier, 15-group tree.
const SMALL_GROUPS = [
  { ...SHIP_GROUPS[0] },
  { ...SHIP_GROUPS[1], parent_index: 0, linked_index: null },
];
const LARGE_GROUPS = [
  ...SHIP_GROUPS,
  ...['Gold', 'Green', 'Black', 'White'].map((n, i) => grp(`gx${i}`, `${n} flight`, i < 2 ? 3 : 4, [role(`rx${i}`, 'Fighter', { max_slots: 2 })])),
  ...['Salvage', 'Medevac', 'Refuel'].map((n, i) => grp(`gy${i}`, n, 2, [role(`ry${i}`, 'Crew', { max_slots: 3 })])),
  ...['Tug', 'Relay'].map((n, i) => grp(`gz${i}`, n, 8 + i, [role(`rz${i}`, 'Pilot')])),
];
const FREQUENCIES = [
  { name: 'FREQ A', role_refs: [{ group_index: 0, role_index: 0 }, { group_index: 1, role_index: 0 }, { group_index: 2, role_index: 0 }] },
  { name: 'MEDEVAC', role_refs: [{ group_index: 2, role_index: 1 }] },
  { name: 'LOGI', role_refs: [] },
];
const PRESETS = [
  { id: 'p1', name: 'Escort convoy', layout: [{ name: 'Command' }, { name: 'Escort', parent_index: 0 }, { name: 'Cargo', parent_index: 0 }] },
  { id: 'p2', name: 'Mining fleet (6 groups)', layout: [{}, {}, {}, {}, {}, {}] },
];
const mockPresets = { presets: PRESETS, saving: false, load: noop, save: async () => ({}), remove: async () => ({}) };
const CLAIM_ENTRIES = {
  g1: [{ ship_slug: 'anvil-hornet-f7c', ship_name: 'Hornet F7C', eligible_user_ships: [{ user_ship_id: 's1', ship_name: 'Hornet F7C Mk II', exact: false }],
    slots: [{ slot_index: 0, user_id: 'u2', callsign: 'Nomad' }, { slot_index: 1, user_id: 'u-me', callsign: 'Ghost' }, { slot_index: 2 }] }],
};
const CHANNEL_ROWS = [
  { id: 'c0', name: 'Command', tier: 1, is_command: true, leader_callsign: 'Viper', parent_channel_id: null },
  { id: 'c1', name: 'Escort Wing', tier: 2, parent_channel_id: 'c0', leader_callsign: 'Nomad' },
  { id: 'c2', name: 'Red flight', tier: 3, parent_channel_id: 'c1' },
  { id: 'c3', name: 'Cargo', tier: 2, parent_channel_id: 'c0' },
];

// EVVIEW: a Star Citizen ship group you're not in yet (Hornets: one hull
// claimed by Nomad, two open), a hangar with an exact match, an approved-
// similar ship and a non-match, and plan states for pending / joined.
const EV_SC_GROUPS = SHIP_GROUPS.map((g, i) => (i === 1 ? {
  ...grp('g1', 'Escort Wing', 0, [
    role('rp', 'Pilot', { max_slots: 3, filled_slots: 1 }),
    role('rt', 'Turret gunner', { max_slots: 3, filled_slots: 1, seat_labels: ['Turret 1', 'Turret 2', 'Turret 3'], taken_seats: [{ seat_label: 'Turret 1', callsign: 'Havoc', status: 'accepted' }] }),
  ], { u2: { role: 'rp', callsign: 'Nomad' }, u4: { role: 'rt', callsign: 'Havoc' } }),
  linked_index: 2,
  member_seat_labels: { u4: 'Turret 1' },
  ships: [{ ship_slug: 'anvil-hornet-f7c', ship_name: 'Hornet F7C', ship_icon_url: SHIP_ICON, quantity: 3, claims: [{ slot_index: 0, user_id: 'u2', callsign: 'Nomad', claimed_ship_slug: 'anvil-hornet-f7c' }] }],
} : g));
const EV_CLAIMS = {
  g1: [{ ship_slug: 'anvil-hornet-f7c', ship_name: 'Hornet F7C', quantity: 3,
    eligible_user_ships: [{ user_ship_id: 's2', ship_slug: 'anvil-hornet-f7c', ship_name: 'Lucky Strike', exact: true }, { user_ship_id: 's1', ship_slug: 'anvil-arrow', ship_name: 'Arrow', exact: false }],
    slots: [{ slot_index: 0, user_id: 'u2', callsign: 'Nomad', claimed_ship_slug: 'anvil-hornet-f7c' }, { slot_index: 1, user_id: null }, { slot_index: 2, user_id: null }] }],
};
const EV_HANGAR = {
  ships: [
    { id: 's3', ship_slug: 'drake-cutlass-black', ship_name: 'Cutlass Black', ship_icon_url: null, nickname: null },
    { id: 's1', ship_slug: 'anvil-arrow', ship_name: 'Arrow', ship_icon_url: SHIP_ICON, nickname: null },
    { id: 's2', ship_slug: 'anvil-hornet-f7c', ship_name: 'Hornet F7C', ship_icon_url: SHIP_ICON, nickname: 'Lucky Strike' },
  ],
  error: null, load: noop, add: async () => ({ error: null }), search: async () => [],
};
// You're waiting for approval as a Hauler in Cargo.
const EV_PENDING_GROUPS = SHIP_GROUPS.map((g, i) => (i === 1 ? grp('g1', 'Escort Wing', 0, g.roles, { u2: { role: 'r1' }, u5: { role: 'r2' } })
  : i === 2 ? { ...grp('g2', 'Cargo', 0, [role('r3', 'Hauler', { max_slots: 2, filled_slots: 2, auto_approve: false }), role('r4', 'Turret', { max_slots: 3, seat_labels: ['Top', 'Belly', 'Rear'] })],
    { u3: { role: 'r3', callsign: 'Raven' }, 'u-me': { role: 'r3', status: 'pending', callsign: 'Ghost' } }), ships: [] } : g));
// Seat picker: Cargo's Turret role (Belly taken).
const EV_SEAT_GROUPS = PLAN_GROUPS.map((g, i) => (i === 2 ? {
  ...g, roles: g.roles.map((r) => (r.id === 'r4' ? { ...r, filled_slots: 1, taken_seats: [{ seat_label: 'Belly', callsign: 'Wraith', status: 'accepted' }] } : r)),
  member_user_ids: [...g.member_user_ids, 'u7'], member_role_ids: { ...g.member_role_ids, u7: 'r4' }, member_callsigns: { ...g.member_callsigns, u7: 'Wraith' },
  member_statuses: { ...g.member_statuses, u7: 'accepted' }, member_seat_labels: { u7: 'Belly' },
} : i === 1 ? grp('g1', 'Escort Wing', 0, g.roles, { u2: { role: 'r1' }, u5: { role: 'r2' } }) : g));

function useMockPlan(initialGroups, initialFrequencies = [], claimEntries = CLAIM_ENTRIES, myAssignment = null, initialMsg = null) {
  const [groups, setGroupsState] = useState(initialGroups);
  const [frequencies, setFrequenciesState] = useState(initialFrequencies);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(initialMsg);
  const act = async () => ({});
  // EVVIEW: these actions log what they'd send (checked by a CDP click-through).
  const logged = (name) => async (...args) => { console.log(`plan.${name}`, JSON.stringify(args)); return {}; };
  return {
    groups, frequencies, myAssignment, loading: false, saving: false, dirty, msg, shipConfirm: null,
    setGroups: (fn) => { setGroupsState(fn); setDirty(true); }, setMsg, load: act,
    setFrequencies: (fn) => { setFrequenciesState(fn); setDirty(true); },
    getClaimableShips: async (gid) => ({ data: { entries: claimEntries[gid] || [] } }), claimShipSlot: logged('claimShipSlot'), releaseShipSlot: logged('releaseShipSlot'),
    save: async () => { setDirty(false); return {}; },
    joinRole: logged('joinRole'), confirmShipJoin: act, cancelShipJoin: noop, leaveRole: logged('leaveRole'), approve: act, deny: act, approveAll: act, respond: act, quickJoin: act,
  };
}

function MockOpView({ layout, event, canEdit, groups = PLAN_GROUPS, claims = CLAIM_ENTRIES, myAssignment = null, onClose = noop, initialMsg = null, ...ev }) {
  const plan = useMockPlan(groups, [], claims, myAssignment, initialMsg);
  return (
    <OpView event={event} user={ME} plan={plan} canEdit={canEdit} canLaunch={canEdit && !event.launched} onLaunch={noop} onEdit={noop} onClose={onClose}
      layout={layout} orgId="o1" channels={event.launched ? CHANNEL_ROWS : undefined} hangar={EV_HANGAR} {...ev} />
  );
}
// EVVIEW scenarios: read-only op view (not a planner).
const evPanel = (event, extra = {}) => panel({ eventId: event.id }, (lf, onClose) => (
  <MockOpView layout={lf('view')} event={event} canEdit={false} groups={SHIP_GROUPS} onClose={onClose} {...extra} />
));
const evProps = (event, extra) => opsProps('operations', { ops: mockOps({ canSchedule: false }), opPanel: evPanel(event, extra) });
function MockPlanner({ layout, event, step, groups, frequencies = [], selected = null, popover = null, mapOpen = false, onClose = noop }) {
  const plan = useMockPlan(groups, frequencies);
  return (
    <OpPlanner event={event} orgId="o1" plan={plan} presets={mockPresets} members={MEMBERS} user={ME} canLaunch editors={[{ userId: 'u2', callsign: 'Nomad' }]}
      onSaveDetails={async () => ({})} onLaunch={noop} onDelete={noop} onDone={noop} onClose={onClose}
      layout={layout} initialStep={step} initialSelected={selected} initialPopover={popover} initialMapOpen={mapOpen} />
  );
}
const panel = (target, render) => ({ target: { seq: 1, ...target }, open: noop, schedule: noop, render });
const opsProps = (cabinet, extra = {}) => ({ auth: 'in', orgs: ORGS, activeOrgId: 'o1', cabinet, ops: mockOps(), viewportHeight: 900, ...extra });
const SC_EVENT = EVENTS[1];
const planPanel = (step, extra = {}) => panel({ eventId: 'e2', mode: 'plan' }, (lf, onClose) => (
  <MockPlanner layout={lf('plan')} event={SC_EVENT} step={step} groups={SHIP_GROUPS} frequencies={FREQUENCIES} onClose={onClose} {...extra} />
));

// P2B: these render in a full-work-area frame (WideFrame), as the strip window
// will once it covers the monitor's work area.
const WIDE_SCENARIOS = [
  { id: 'ops-tab-calendar', title: 'P2B — Operations: Calendar tab (month grid only)', props: opsProps('operations', { opsCabinetInitial: { initialTab: 'calendar' } }) },
  { id: 'ops-tab-day', title: 'P2B — Operations: Calendar → day drill-in', props: opsProps('operations', { opsCabinetInitial: { initialTab: 'calendar', initialDay: new Date(SC_EVENT.start_time).getDate() } }) },
  { id: 'ops-tab-now', title: 'P2B — Operations: Now & soon tab', props: opsProps('operations', { opsCabinetInitial: { initialTab: 'now' } }) },
  { id: 'ops-tab-history', title: 'P2B — Operations: History tab', props: opsProps('operations', { opsCabinetInitial: { initialTab: 'history' } }) },
  { id: 'op-view', title: 'P2B — Read-only op view (wide)', props: opsProps('operations', {
    ops: mockOps({ canSchedule: false }),
    opPanel: panel({ eventId: 'e2' }, (lf) => <MockOpView layout={lf('view')} event={SC_EVENT} canEdit={false} groups={SHIP_GROUPS} />),
  }) },
  { id: 'op-view-launched', title: 'P2B — Launched op view: ship slots + op channels', props: opsProps('operations', {
    ops: mockOps({ canSchedule: false }),
    opPanel: panel({ eventId: 'e1' }, (lf) => <MockOpView layout={lf('view')} event={{ ...EVENTS[0], id: 'e1x' }} canEdit={false} groups={SHIP_GROUPS} />),
  }) },
  { id: 'planner-details', title: 'P2B — Planner: Details (new op)', props: opsProps('operations', {
    opPanel: panel({ eventId: null, mode: 'plan' }, (lf) => <MockPlanner layout={lf('plan')} event={null} step="details" groups={[]} />),
  }) },
  { id: 'planner-groups', title: 'P2B — Planner: Groups (tree grows upward, linked colours)', props: opsProps('operations', { opPanel: planPanel('groups', { selected: 1 }) }) },
  { id: 'planner-drag', title: 'P2B — Planner: dragging Scouts onto Escort Wing', drag: { from: 'Scouts', to: 'Escort Wing' }, props: opsProps('operations', { opPanel: planPanel('groups', { selected: 5 }) }) },
  { id: 'planner-drag-drop', title: 'P2B — Planner: after dropping Scouts on Escort Wing', drag: { from: 'Scouts', to: 'Escort Wing', drop: true }, props: opsProps('operations', { opPanel: planPanel('groups', { selected: 5 }) }) },
  { id: 'planner-presets', title: 'P2B — Planner: presets popover from the secondary bar', props: opsProps('operations', { opPanel: planPanel('groups', { selected: 1, popover: 'presets' }) }) },
  { id: 'planner-link', title: 'P2B — Planner: link group popover', props: opsProps('operations', { opPanel: planPanel('groups', { selected: 3, popover: 'link' }) }) },
  { id: 'planner-roles', title: 'P2B — Planner: Roles (with frequency chips)', props: opsProps('operations', { opPanel: planPanel('roles', { selected: 2 }) }) },
  { id: 'planner-ships', title: 'P2B — Planner: Ships (composition)', props: opsProps('operations', { opPanel: planPanel('ships', { selected: 2 }) }) },
  { id: 'planner-comms', title: 'P2B — Planner: Comms (frequencies)', props: opsProps('operations', { opPanel: planPanel('comms') }) },
  // EVT2: the Map step is gated off (PLANNER_MAP_ENABLED); its frames only show when it's on.
  ...(PLANNER_MAP_ENABLED ? [
    { id: 'planner-map', title: 'P2B — Planner: Map (lazy-loaded preview)', props: opsProps('operations', { opPanel: planPanel('map') }) },
    { id: 'planner-map-open', title: 'P2B — Planner: Map opened', props: opsProps('operations', { opPanel: planPanel('map', { mapOpen: true }) }) },
  ] : []),
  { id: 'planner-review', title: 'P2B — Planner: Review', props: opsProps('operations', { opPanel: planPanel('review') }) },
  // OPGROW: the panel grows out of the secondary bar to fit each page.
  { id: 'opgrow-bar-only', title: 'OPGROW — opening: secondary bar only (panel not grown yet)', props: opsProps('operations', {
    opPanel: panel({ eventId: 'e2', mode: 'plan' }, (lf) => (
      <MockPlanner layout={{ ...lf('plan'), devPhase: 'bar' }} event={SC_EVENT} step="groups" groups={SHIP_GROUPS} frequencies={FREQUENCIES} />
    )),
  }) },
  { id: 'opgrow-details', title: 'OPGROW — Details (compact width)', props: opsProps('operations', {
    opPanel: panel({ eventId: null, mode: 'plan' }, (lf) => <MockPlanner layout={lf('plan')} event={null} step="details" groups={[]} />),
  }) },
  { id: 'opgrow-groups-small', title: 'OPGROW — Groups, small tree', props: opsProps('operations', { opPanel: planPanel('groups', { selected: 0, groups: SMALL_GROUPS }) }) },
  { id: 'opgrow-groups-large', title: 'OPGROW — Groups, large tree (grown)', props: opsProps('operations', { opPanel: planPanel('groups', { selected: 1, groups: LARGE_GROUPS }) }) },
  ...(PLANNER_MAP_ENABLED ? [{ id: 'opgrow-map', title: 'OPGROW — Map opened (max size)', props: opsProps('operations', { opPanel: planPanel('map', { mapOpen: true }) }) }] : []),
  { id: 'opgrow-review', title: 'OPGROW — Review (compact width)', props: opsProps('operations', { opPanel: planPanel('review') }) },
  { id: 'opgrow-view', title: 'OPGROW — read-only op view', props: opsProps('operations', {
    ops: mockOps({ canSchedule: false }),
    opPanel: panel({ eventId: 'e2' }, (lf) => <MockOpView layout={lf('view')} event={SC_EVENT} canEdit={false} groups={SHIP_GROUPS} />),
  }) },
  { id: 'opgrow-down', title: 'OPGROW — taskbar at top (grows down), Groups', props: opsProps('operations', { grow: 'down', opPanel: planPanel('groups', { selected: 1 }) }) },
  // EVVIEW: tree-first op view.
  { id: 'ev-small', title: 'EVVIEW — small tree: panel sized to the tree', props: evProps(SC_EVENT, { groups: SMALL_GROUPS }) },
  { id: 'ev-large', title: 'EVVIEW — large tree: max panel, fitted (pan / zoom inside)', props: evProps(SC_EVENT, { groups: LARGE_GROUPS }) },
  { id: 'ev-details', title: 'EVVIEW — details drawer open (slides out left)', props: evProps(SC_EVENT, { initialDetails: true }) },
  { id: 'ev-select-right', title: 'EVVIEW — group selected: zoomed, roles cabinet on the right', props: evProps(SC_EVENT, { groups: EV_SEAT_GROUPS, initialSelected: 3 }) },
  { id: 'ev-select-left', title: 'EVVIEW — group selected: roles cabinet on the left', props: evProps(SC_EVENT, { groups: EV_SEAT_GROUPS, initialSelected: 5 }) },
  { id: 'ev-seat-picker', title: 'EVVIEW — seat picker (Turret: Belly taken)', click: 'Join seat', props: evProps(SC_EVENT, { groups: EV_SEAT_GROUPS, initialSelected: 2 }) },
  { id: 'ev-ship-hangar', title: 'EVVIEW — SC ship sign-up 1: assign a hangar ship', props: evProps(SC_EVENT, { groups: EV_SC_GROUPS, claims: EV_CLAIMS, initialSelected: 1, initialFlow: { step: 'ship' } }) },
  { id: 'ev-ship-role', title: 'EVVIEW — SC ship sign-up 2: select your role', props: evProps(SC_EVENT, { groups: EV_SC_GROUPS, claims: EV_CLAIMS, initialSelected: 1, initialFlow: { step: 'role', shipId: 's2', roleId: 'rt', seat: 'Turret 2' } }) },
  { id: 'ev-ship-confirm', title: 'EVVIEW — SC ship sign-up 3: confirm', props: evProps(SC_EVENT, { groups: EV_SC_GROUPS, claims: EV_CLAIMS, initialSelected: 1, initialFlow: { step: 'confirm', shipId: 's2', roleId: 'pilot' } }) },
  { id: 'ev-ship-roles', title: 'EVVIEW — SC ship group roles (Bring a ship / slots)', props: evProps(SC_EVENT, { groups: EV_SC_GROUPS, claims: EV_CLAIMS, initialSelected: 1 }) },
  { id: 'ev-pending', title: 'EVVIEW — your sign-up pending approval', props: evProps(SC_EVENT, { groups: EV_PENDING_GROUPS, initialSelected: 2 }) },
  { id: 'ev-joined', title: 'EVVIEW — already joined (Leave)', props: evProps(SC_EVENT, { initialSelected: 1, groups: PLAN_GROUPS }) },
  { id: 'ev-restricted', title: 'EVVIEW — restricted op: assignment to accept (details)', props: evProps(EVENTS[2], { groups: EV_PENDING_GROUPS, initialDetails: true, myAssignment: { group_name: 'Cargo', status: 'pending', role: 'Hauler' } }) },
  { id: 'ev-launched', title: 'EVVIEW — launched op: details with channel tree', props: evProps({ ...EVENTS[0], id: 'e1x' }, { initialDetails: true }) },
  { id: 'ev-down', title: 'EVVIEW — taskbar at top (grows down), selected + details', props: { ...evProps(SC_EVENT, { groups: EV_SEAT_GROUPS, initialSelected: 2, initialDetails: true }), grow: 'down' } },
  // EVT2: square group cards, the bar's tools sub-row, no Map step.
  { id: 'evt2-ev-small', title: 'EVT2 — event viewer, small tree (square cards)', props: evProps(SC_EVENT, { groups: SMALL_GROUPS }) },
  { id: 'evt2-ev-large', title: 'EVT2 — event viewer, large tree (fitted)', props: evProps(SC_EVENT, { groups: LARGE_GROUPS }) },
  { id: 'evt2-ev-selected', title: 'EVT2 — event viewer, group selected (125%, roles cabinet)', props: evProps(SC_EVENT, { groups: EV_SEAT_GROUPS, initialSelected: 1 }) },
  { id: 'evt2-groups', title: 'EVT2 — planner Groups: tools in the sub-row', props: opsProps('operations', { opPanel: planPanel('groups', { selected: 1 }) }) },
  { id: 'evt2-groups-presets', title: 'EVT2 — planner Groups: presets popover from the sub-row', props: opsProps('operations', { opPanel: planPanel('groups', { selected: 1, popover: 'presets' }) }) },
  { id: 'evt2-groups-down', title: 'EVT2 — planner Groups, taskbar at top (sub-row above the main row)', props: opsProps('operations', { grow: 'down', opPanel: planPanel('groups', { selected: 1 }) }) },
  { id: 'evt2-comms', title: 'EVT2 — planner Comms: frequency tool in the sub-row', props: opsProps('operations', { opPanel: planPanel('comms') }) },
  { id: 'evt2-details', title: 'EVT2 — planner Details: no sub-row', props: opsProps('operations', { opPanel: planPanel('details') }) },
  { id: 'evt2-review', title: 'EVT2 — planner Review: no sub-row', props: opsProps('operations', { opPanel: planPanel('review') }) },
  // POLISH: floating event tree, right-anchored bar actions, hide → show round trip.
  { id: 'float-ev-small', title: 'POLISH — floating tree, small', props: evProps(SC_EVENT, { groups: SMALL_GROUPS }) },
  { id: 'float-ev-large', title: 'POLISH — floating tree, large (fitted)', props: evProps(SC_EVENT, { groups: LARGE_GROUPS }) },
  { id: 'float-ev-selected', title: 'POLISH — floating tree, group selected + roles cabinet', props: evProps(SC_EVENT, { groups: EV_SEAT_GROUPS, initialSelected: 1 }) },
  { id: 'float-ev-drawer', title: 'POLISH — floating tree, details drawer open', props: evProps(SC_EVENT, { groups: LARGE_GROUPS, initialDetails: true }) },
  { id: 'float-ev-msg', title: 'POLISH — floating tree, message overlay', props: evProps(SC_EVENT, { groups: SHIP_GROUPS, initialMsg: { type: 'ok', text: 'Signed up as Fighter in Escort Wing.' } }) },
  { id: 'bar-planner-details', title: 'POLISH — planner Details (compact bar, actions right)', props: opsProps('operations', { opPanel: planPanel('details') }) },
  { id: 'bar-planner-review', title: 'POLISH — planner Review (compact bar, actions right)', props: opsProps('operations', { opPanel: planPanel('review') }) },
  { id: 'bar-planner-groups-large', title: 'POLISH — planner Groups, large tree (full bar when ≥1120px)', props: opsProps('operations', { opPanel: planPanel('groups', { selected: 1, groups: LARGE_GROUPS }) }) },
  { id: 'bar-planner-new', title: 'POLISH — planner new op Details (few actions, still right)', props: opsProps('operations', {
    opPanel: panel({ eventId: null, mode: 'plan' }, (lf) => <MockPlanner layout={lf('plan')} event={null} step="details" groups={[]} />),
  }) },
  { id: 'roundtrip-ev', title: 'POLISH — hide → show round trip (select Cargo, open Details, hide, show)', roundTrip: { group: 'Cargo' }, props: evProps(SC_EVENT, { groups: SHIP_GROUPS }) },
];

const SCENARIOS = [
  { id: 'notifications', title: 'S10 — Notifications with items', props: opsProps('notifications', { ops: mockOps({ events: [...EVENTS, OPEN_SOON] }) }) },
  { id: 'notifications-empty', title: 'S10 — Notifications, empty', props: opsProps('notifications', { ops: mockOps({ events: EVENTS.slice(3), mine: [] }) }) },

  { id: 'logged-out', title: 'Logged out — compact login', props: { auth: 'out', login: login({ password: '' }) } },
  { id: 'logged-out-error', title: 'Logged out — login error', props: { auth: 'out', login: login({ error: 'Invalid email or password' }) } },
  { id: 'forgot', title: 'Forgot password cabinet', props: { auth: 'out', loggedOutView: 'forgot', forgot: forgot() } },
  { id: 'bar', title: 'Logged in — bar', props: { auth: 'in', orgs: ORGS, activeOrgId: 'o1' } },
  { id: 'server', title: 'Server cabinet open', props: { auth: 'in', orgs: ORGS, activeOrgId: 'o2', cabinet: 'server' } },
  { id: 'operations', title: 'Placeholder cabinet (Settings)', props: { auth: 'in', orgs: ORGS, activeOrgId: 'o1', cabinet: 'settings' } },
  { id: 'update', title: 'Update ready pill', props: { auth: 'in', orgs: ORGS, activeOrgId: 'o1', update: { version: '1.11.0' } } },
  { id: 'hint', title: 'First-run hint', props: { auth: 'in', orgs: ORGS, activeOrgId: 'o1', showHint: true } },
  { id: 'grow-down', title: 'Taskbar at top (grows down)', props: { auth: 'in', orgs: ORGS, activeOrgId: 'o3', cabinet: 'server', grow: 'down' } },
  { id: 'loading', title: 'Starting', props: { auth: 'loading' } },
];

// ── Channels cabinet: a mocked engine bridge (EngineState + levels) ───────
// P2A: these frames are a slice of the full-work-area window: the bar column
// (MAIN_WIDTH) sits at the frame's right edge like barRect on a bottom
// taskbar, and the free side (left) is where the cabinet widens into.
const CHANNELS = [
  { id: 'v1', name: 'Bridge', kind: 'voice', eventId: null, parentId: null, occupants: ['Nova', 'Kestrel', 'Rook'] },
  { id: 'v2', name: 'Hangar bay', kind: 'voice', eventId: null, parentId: null, occupants: [] },
  { id: 'v3', name: 'Mining ops', kind: 'voice', eventId: null, parentId: null, occupants: ['Dune'] },
  { id: 'e1', name: 'Alpha wing', kind: 'voice', eventId: 'ev1', parentId: null, occupants: ['Vex', 'Halo'] },
  { id: 't1', name: 'general', kind: 'text', eventId: null, parentId: null, occupants: [] },
  { id: 't2', name: 'trade-board', kind: 'text', eventId: null, parentId: null, occupants: [] },
  { id: 't3', name: 'ops-briefing', kind: 'text', eventId: null, parentId: null, occupants: [] },
];
const engineState = (over = {}) => ({
  ...EMPTY_STATE,
  user: { callsign: 'Ghost' },
  org: { id: 'o1', callsign: 'Ghost Fleet', canManageChannels: true },
  channels: CHANNELS,
  caps: { deafen: false, overlay: true, share: true },
  ...over,
});
const JOINED = {
  voice: {
    channelId: 'v1', channelName: 'Bridge', status: 'connected', muted: false, sharing: false,
    roster: ['Ghost', 'Nova', 'Kestrel', 'Rook'], sharers: ['Kestrel'], watchTarget: null,
  },
  channels: CHANNELS.map((c) => (c.id === 'v1' ? { ...c, occupants: ['Ghost', 'Nova', 'Kestrel', 'Rook'] } : c)),
};
const LEVELS = { levels: { Ghost: 12, Nova: 64, Kestrel: 0, Rook: 30 }, speaking: ['Nova', 'Rook'] };
const UNREAD = { unread: { t2: 3, t3: 12 } };
const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
const CHAT_ROWS = [
  { id: 'm1', senderId: 'u1', callsign: 'Viper', timestamp: ago(60 * 26), text: 'Anyone up for a mining run tomorrow?', imageUrl: null, mine: false },
  { id: 'm2', senderId: 'u-me', callsign: 'Ghost', timestamp: ago(60 * 25), text: "I'm in. Prospector is fuelled.", imageUrl: null, mine: true },
  { id: 'm3', senderId: 'u2', callsign: 'Nomad', timestamp: ago(42), text: 'Convoy escort is at 20:00 — meet at Lorville pad 04.', imageUrl: null, mine: false },
  { id: 'm4', senderId: 'u3', callsign: 'Raven', timestamp: ago(30), text: null, imageUrl: null, mine: false },
  { id: 'm5', senderId: 'u2', callsign: 'Nomad', timestamp: ago(12), text: 'Loadout for tonight:', imageUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="135"><rect width="240" height="135" fill="#123"/><text x="20" y="72" fill="#6ee7f9" font-family="sans-serif" font-size="16">loadout.png</text></svg>'), mine: false },
  { id: 'm6', senderId: 'u-me', callsign: 'Ghost', timestamp: ago(3), text: 'Copy. Bringing the Cutlass.', imageUrl: null, mine: true },
];
const chatFor = (channelId, over = {}) => ({ channelId, loading: false, rows: CHAT_ROWS, ...over });
const engine = (over = {}) => ({ connected: true, state: engineState(), levels: { levels: {}, speaking: [] }, pending: {}, chat: null, ...over });

const SOURCE_THUMB = (label, hue) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,22%)"/><stop offset="1" stop-color="hsl(${hue + 40},45%,12%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><text x="16" y="96" fill="#cbd5e1" font-family="sans-serif" font-size="20">${label}</text></svg>`,
);
const SOURCES = [
  { id: 'monitor:0', name: 'Display 1 (2560×1440)', kind: 'monitor', thumb: SOURCE_THUMB('Display 1', 200) },
  { id: 'monitor:1', name: 'Display 2 (1920×1080)', kind: 'monitor', thumb: SOURCE_THUMB('Display 2', 260) },
  { id: 'window:1', name: 'Star Citizen', kind: 'window', thumb: SOURCE_THUMB('Star Citizen', 20) },
  { id: 'window:2', name: 'Discord', kind: 'window', thumb: null },
];

const voice = (id) => ({ kind: 'voice', id });
const text = (id) => ({ kind: 'text', id });

const CHANNEL_SCENARIOS = [
  { id: 'ch-collapsed', title: 'Channels — list (manager), unread badges on text + bar total', engine: engine({ state: engineState(UNREAD) }) },
  { id: 'ch-expanded', title: 'P2A — voice 1st click: cabinet widens left, members slide in', engine: engine(), focus: voice('v1') },
  {
    id: 'ch-joining', title: 'Channels — 2nd click: joining (pending ack)',
    engine: engine({ pending: { [cmdKey(CMD.VOICE_JOIN, { channelId: 'v3' })]: { status: 'pending' } } }), focus: voice('v3'),
  },
  {
    id: 'ch-joined', title: 'P2A — joined: bar shows Overlay + Screenshare; speaking + stream icon',
    engine: engine({ state: engineState(JOINED), levels: LEVELS }), focus: voice('v1'),
  },
  {
    id: 'ch-sharing', title: 'P2A — sharing + overlay open (bar buttons active), mute failed',
    engine: engine({
      state: engineState({ ...JOINED, voice: { ...JOINED.voice, muted: true, sharing: true, sharers: ['Kestrel', 'Ghost'], watchTarget: 'Kestrel' }, overlay: { open: true } }),
      levels: LEVELS,
      pending: { [cmdKey(CMD.VOICE_SET_MUTED, {})]: { status: 'error', error: "SpecterComs didn't answer. Try again." } },
    }),
  },
  {
    id: 'ch-picker', title: 'P2A — screenshare source picker (sources from the engine)',
    engine: engine({ state: engineState(JOINED) }), picker: { loading: false, error: null, sources: SOURCES },
  },
  {
    id: 'ch-picker-error', title: 'P2A — picker: start failed',
    engine: engine({ state: engineState(JOINED) }),
    picker: { loading: false, error: null, sources: SOURCES, startError: 'Screen capture failed: DXGI duplication unavailable' }, pickerTab: 'window',
  },
  { id: 'ch-picker-loading', title: 'P2A — picker: listing sources', engine: engine({ state: engineState(JOINED) }), picker: { loading: true, error: null, sources: [] } },
  {
    id: 'ch-text', title: 'P2A — text: chat slides in (history, image, undecryptable row)',
    engine: engine({ state: engineState(UNREAD), chat: chatFor('t1') }), focus: text('t1'),
  },
  {
    id: 'ch-text-sending', title: 'P2A — chat: sending (pending bubble)',
    engine: engine({ chat: chatFor('t1') }), focus: text('t1'), chatProps: { initialPending: [{ key: 'p1', text: 'On my way to the pad now.' }] },
  },
  {
    id: 'ch-text-error', title: 'P2A — chat: send failed (text restored, error shown)',
    engine: engine({ chat: chatFor('t1') }), focus: text('t1'),
    chatProps: { initialInput: 'On my way to the pad now.', initialError: 'MLS_EPOCH_CONFLICT: the channel key changed while sending. Try again.' },
  },
  { id: 'ch-text-loading', title: 'P2A — chat: loading history', engine: engine({ chat: null }), focus: text('t2') },
  { id: 'ch-text-right', title: 'P2A — expands right (strip docked at the left edge)', engine: engine({ chat: chatFor('t2', { rows: CHAT_ROWS.slice(2) }) }), focus: text('t2'), expand: 'right' },
  { id: 'ch-create', title: 'Channels — create form', engine: engine(), initialCreating: true },
  {
    id: 'ch-noperm', title: 'Channels — no manage permission',
    engine: engine({ state: engineState({ org: { id: 'o1', callsign: 'Ghost Fleet', canManageChannels: false } }) }),
  },
  { id: 'ch-offline', title: 'Channels — engine not connected yet', engine: engine({ connected: false, state: EMPTY_STATE }) },
];

// ── BAR2: the main bar — logo, slot row over the server name, cabinet icons ─
const LONG_ORGS = [{ id: 'o9', name: 'The Interstellar Mercantile Guild of Stanton', member_count: 318, logo_url: null }, ...ORGS];
const bar2Slots = (eng, over = {}) => voiceSlots({ engine: eng, pickerOpen: false, onOpenChannels: noop, onToggleOverlay: noop, onShareClick: noop, ...over });
const IDLE_ENGINE = engine();
const VOICE_IDLE = engine({ state: engineState(JOINED) });
const VOICE_SPEAKING = engine({ state: engineState(JOINED), levels: LEVELS });
const VOICE_ME = engine({ state: engineState(JOINED), levels: { levels: { Ghost: 55 }, speaking: ['Ghost'] } });
const VOICE_STREAM = engine({
  state: engineState({ ...JOINED, voice: { ...JOINED.voice, sharing: true, sharers: ['Kestrel', 'Ghost'] }, overlay: { open: true } }),
  levels: { levels: { Kestrel: 40 }, speaking: ['Kestrel'] },
});
const VOICE_MUTED = engine({ state: engineState({ ...JOINED, voice: { ...JOINED.voice, muted: true } }) });
const bar2 = (extra = {}) => ({ auth: 'in', orgs: ORGS, activeOrgId: 'o1', viewportHeight: 96, ...extra });
const BAR2_SCENARIOS = [
  { id: 'bar2-idle', title: 'BAR2 — idle, not in voice', props: bar2({ barSlots: bar2Slots(IDLE_ENGINE) }) },
  { id: 'bar2-no-engine', title: 'BAR2 — engine not connected yet (member count placeholder)', props: bar2() },
  { id: 'bar2-voice-idle', title: 'BAR2 — in voice, nobody talking (channel name)', props: bar2({ barSlots: bar2Slots(VOICE_IDLE) }) },
  { id: 'bar2-voice-muted', title: 'BAR2 — in voice, muted', props: bar2({ barSlots: bar2Slots(VOICE_MUTED) }) },
  { id: 'bar2-speaking', title: 'BAR2 — someone speaking (Nova +1)', props: bar2({ barSlots: bar2Slots(VOICE_SPEAKING), channelsBadge: { label: '15 unread', element: <UnreadPill count={15} className="pointer-events-none absolute -top-1 -right-1 !h-[17px] !min-w-[17px] !px-1 !text-[10px] border-2 border-[#0b1d2e]" /> } }) },
  { id: 'bar2-transmitting', title: 'BAR2 — you transmitting', props: bar2({ barSlots: bar2Slots(VOICE_ME) }) },
  { id: 'bar2-ptt', title: 'BAR2 — you transmitting via PTT (no level yet)', props: bar2({ barSlots: bar2Slots(VOICE_IDLE, { transmitting: true }) }) },
  { id: 'bar2-streaming', title: 'BAR2 — streaming active + overlay open', props: bar2({ barSlots: bar2Slots(VOICE_STREAM) }) },
  { id: 'bar2-picker', title: 'BAR2 — share picker open (Stream pressed)', props: bar2({ barSlots: bar2Slots(VOICE_IDLE, { pickerOpen: true }) }) },
  { id: 'bar2-live-op', title: 'BAR2 — live op chip (not in voice)', props: bar2({ barSlots: bar2Slots(IDLE_ENGINE), ops: mockOps() }) },
  { id: 'bar2-update', title: 'BAR2 — update ready', props: bar2({ barSlots: bar2Slots(IDLE_ENGINE), update: { version: '1.11.0' } }) },
  { id: 'bar2-update-error', title: 'BAR2 — update failed (retry)', props: bar2({ update: { version: '1.11.0' }, updateError: 'Signature mismatch' }) },
  { id: 'bar2-everything', title: 'BAR2 — voice + live op + update: lower-priority slots hide', props: bar2({ barSlots: bar2Slots(VOICE_SPEAKING), ops: mockOps(), update: { version: '1.11.0' } }) },
  { id: 'bar2-long-name', title: 'BAR2 — long server name', props: bar2({ orgs: LONG_ORGS, activeOrgId: 'o9', barSlots: bar2Slots(VOICE_SPEAKING) }) },
  { id: 'bar2-narrow', title: 'BAR2 — narrow work area (340px column)', width: 340, props: bar2({ orgs: LONG_ORGS, activeOrgId: 'o9', barSlots: bar2Slots(VOICE_STREAM), ops: mockOps() }) },
  { id: 'bar2-narrow-idle', title: 'BAR2 — narrow, not in voice, live op + update', width: 340, props: bar2({ barSlots: bar2Slots(IDLE_ENGINE), ops: mockOps(), update: { version: '1.11.0' } }) },
  { id: 'bar2-server-open', title: 'BAR2 — server switcher open', props: bar2({ barSlots: bar2Slots(VOICE_SPEAKING), cabinet: 'server', viewportHeight: 330 }) },
  { id: 'bar2-grow-down', title: 'BAR2 — taskbar at top (grows down), server switcher open', props: bar2({ barSlots: bar2Slots(VOICE_SPEAKING), cabinet: 'server', grow: 'down', viewportHeight: 330 }) },
];

const FRAME_W = MAIN_WIDTH + 470;
const FRAME_H = 760;

function ChannelsFrame({ scenario }) {
  const ref = useRef(null);
  const [rects, setRects] = useState([]);
  const [focus, setFocus] = useState(scenario.focus ?? null);
  const [picker, setPicker] = useState(scenario.picker ?? null);
  const [cabinet, setCabinet] = useState(scenario.picker ? null : 'channels');
  const [sendFails, setSendFails] = useState(false);
  const expand = scenario.expand || 'left';
  const eng = scenario.engine;
  const focusChannel = focus ? eng.state.channels.find((c) => c.id === focus.id && c.kind === focus.kind) : null;
  const paneTarget = cabinet === 'channels' && focusChannel ? (focusChannel.kind === 'text' ? 440 : 320) : 0;
  const measure = () => {
    const frame = ref.current?.getBoundingClientRect();
    if (!frame) return;
    setRects([...ref.current.querySelectorAll('[data-strip-region]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - frame.left - 6, y: r.top - frame.top - 6, w: r.width + 12, h: r.height + 12 };
    }));
  };
  const fluid = useFluidExpand(paneTarget, measure);
  const lastRef = useRef(null);
  if (focusChannel && paneTarget) lastRef.current = focusChannel;
  const paneChannel = focusChannel && paneTarget ? focusChannel : fluid.laid > 0 ? lastRef.current : null;
  useLayoutEffect(() => {
    measure();
    const t = setTimeout(measure, 450);
    return () => clearTimeout(t);
  }, [focus, cabinet, picker]);

  let pane = null;
  if (paneChannel) {
    pane = paneChannel.kind === 'text' ? (
      <StripChat key={paneChannel.id} channel={paneChannel} chat={eng.chat?.channelId === paneChannel.id ? eng.chat : null}
        onSend={() => new Promise((res, rej) => setTimeout(() => (sendFails ? rej(new Error('Network error: send failed')) : res()), 900))}
        onClose={() => setFocus(null)} {...scenario.chatProps} />
    ) : (
      <VoiceChannelPanel engine={eng} channel={paneChannel} onCommand={noop} onClose={() => setFocus(null)} />
    );
  }
  const total = totalUnread(eng.state);
  const main = (
    <StripView
      auth="in"
      orgs={ORGS}
      activeOrgId="o1"
      cabinet={cabinet}
      onSelectOrg={noop}
      onCloseCabinet={() => { setCabinet(null); setFocus(null); }}
      onToggleCabinet={(id) => { setCabinet((c) => (c === id ? null : id)); setFocus(null); setPicker(null); }}
      onInstallUpdate={noop}
      onDismissHint={noop}
      viewportHeight={FRAME_H}
      barSlots={voiceSlots({ // BAR2 (was VoiceBarButtons)
        engine: eng, pickerOpen: Boolean(picker), onOpenChannels: () => setCabinet('channels'), onToggleOverlay: noop,
        onShareClick: () => { setCabinet(null); setPicker((p) => (p ? null : { loading: false, error: null, sources: SOURCES })); },
      })}
      channelsBadge={total > 0 ? {
        label: `${total} unread`,
        element: <UnreadPill count={total} className="pointer-events-none absolute -top-1 -right-1 !h-[17px] !min-w-[17px] !px-1 !text-[10px] border-2 border-[#0b1d2e]" />,
      } : null}
      stackPanel={picker ? (
        <SharePicker list={picker} starting={false} startError={picker.startError} onRefresh={noop} onStart={noop}
          onClose={() => setPicker(null)} maxHeight={520} initialTab={scenario.pickerTab} />
      ) : null}
      cabinetSlotStyle={fluidSlotStyle(fluid, expand)}
      onCabinetSlotTransitionEnd={fluid.onTransitionEnd}
      renderCabinet={(id, { onClose }) => (id === 'channels' ? (
        <ChannelsCabinet
          engine={eng}
          onCommand={noop}
          focus={focus}
          onFocus={setFocus}
          onCreateChannel={async () => ({ error: null })}
          onDeleteChannel={async () => ({ error: null })}
          onClose={onClose}
          initialCreating={scenario.initialCreating ?? false}
          pane={pane}
          paneWidth={fluid.laid}
          expand={expand}
          maxHeight={Math.min(680, FRAME_H - 110)}
          paneMinHeight={paneChannel?.kind === 'text' ? 560 : 360}
        />
      ) : null)}
    />
  );
  const layout = {
    expand,
    barRect: expand === 'left'
      ? { x: FRAME_W - 8 - MAIN_WIDTH, y: 8, w: MAIN_WIDTH, h: FRAME_H - 16 }
      : { x: 8, y: 8, w: MAIN_WIDTH, h: FRAME_H - 16 },
  };
  return (
    <figure className="m-0 space-y-2" data-scenario={scenario.id}>
      <figcaption className="font-ui text-ui-sm text-slate-300">
        {scenario.title}
        {paneChannel?.kind === 'text' && (
          <label className="ml-3 text-ui-xs text-slate-400"><input type="checkbox" checked={sendFails} onChange={(e) => setSendFails(e.target.checked)} /> sends fail</label>
        )}
      </figcaption>
      <div ref={ref} className="relative overflow-hidden rounded-ui-sm" style={{ width: FRAME_W, height: FRAME_H, outline: '1px solid rgba(255,255,255,0.08)' }}>
        <StripFrame layout={layout}>{main}</StripFrame>
        {rects.map((r, i) => (
          <div key={i} className="pointer-events-none absolute border border-dashed border-amber-300/50"
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
        ))}
      </div>
    </figure>
  );
}

function Frame({ scenario }) {
  const ref = useRef(null);
  const [rects, setRects] = useState([]);
  const [cabinet, setCabinet] = useState(scenario.props.cabinet ?? null);

  // Outline the would-be window region once the entry animation has settled.
  useLayoutEffect(() => {
    const measure = () => {
      const frame = ref.current?.getBoundingClientRect();
      if (!frame) return;
      setRects([...ref.current.querySelectorAll('[data-strip-region]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - frame.left - 6, y: r.top - frame.top - 6, w: r.width + 12, h: r.height + 12 };
      }));
    };
    measure();
    const t = setTimeout(measure, 400);
    return () => clearTimeout(t);
  }, [cabinet]);

  return (
    <figure className="m-0 space-y-2" data-scenario={scenario.id}>
      <figcaption className="font-ui text-ui-sm text-slate-300">{scenario.title}</figcaption>
      <div ref={ref} className="relative overflow-hidden rounded-ui-sm" style={{ width: scenario.width || 420 /* BAR2 */, height: scenario.props.viewportHeight || 660, outline: '1px solid rgba(255,255,255,0.08)' }}>
        <StripView
          orgs={[]}
          onSelectOrg={noop}
          onCloseCabinet={() => setCabinet(null)}
          onToggleCabinet={(id) => setCabinet((c) => (c === id ? null : id))}
          onInstallUpdate={noop}
          onDismissHint={noop}
          {...scenario.props}
          cabinet={cabinet}
        />
        {rects.map((r, i) => (
          <div key={i} className="pointer-events-none absolute border border-dashed border-amber-300/50"
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
        ))}
      </div>
    </figure>
  );
}

// P2B: synthetic pointer drag on the tree (drag-and-drop re-parent check).
function simulateDrag(root, { from, to, drop }) {
  const node = (name) => [...root.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label').startsWith(`${name},`));
  const a = node(from);
  const b = node(to);
  if (!a || !b) return;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  fire(a, 'pointerdown', ra.left + ra.width / 2, ra.top + ra.height / 2);
  fire(a, 'pointermove', ra.left + ra.width / 2 + 20, ra.top + ra.height / 2 + 10);
  fire(a, 'pointermove', rb.left + rb.width / 2, rb.top + rb.height / 2);
  if (drop) fire(a, 'pointerup', rb.left + rb.width / 2, rb.top + rb.height / 2);
}

// P2B: a strip window covering a whole work area (w x h), the bar docked
// bottom-right. The transform makes the frame the containing block for the
// wide panel's position: fixed, as the window is in the app.
function WideFrame({ scenario, w, h, bare }) {
  const ref = useRef(null);
  const [rects, setRects] = useState([]);
  const [cabinet, setCabinet] = useState(scenario.props.cabinet ?? null);
  // OPGROW: the region outlines follow the op panel live (StripView calls
  // onRegionChange as StripApp's reportRegion would be called).
  const measure = () => {
    const frame = ref.current?.getBoundingClientRect();
    if (!frame) return;
    const next = [...ref.current.querySelectorAll('[data-strip-region]')].filter((el) => !el.closest('[data-region-off]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left - frame.left - 6), y: Math.round(r.top - frame.top - 6), w: Math.round(r.width + 12), h: Math.round(r.height + 12) };
    }).filter((r) => r.w > 12 && r.h > 12);
    // Bail out when unchanged (StripView reports after every render).
    setRects((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  };
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const [onRegion] = useState(() => () => measureRef.current());
  useLayoutEffect(() => {
    measure();
    const t = setTimeout(measure, 500);
    let t2;
    if (scenario.drag) t2 = setTimeout(() => { simulateDrag(ref.current, scenario.drag); setTimeout(measure, 100); }, 350);
    // POLISH: a hide → show round trip, as StripApp now handles strip-hidden /
    // strip-shown: the window just goes away (everything stays mounted) and
    // comes back. First change some state (select a group, open Details),
    // then hide, then show — the screenshot should still show that state.
    const rt = [];
    if (scenario.roundTrip) {
      const btn = (pred) => [...(ref.current?.querySelectorAll('button') || [])].find(pred);
      rt.push(setTimeout(() => { btn((b) => b.getAttribute('aria-label')?.startsWith(`${scenario.roundTrip.group},`))?.click(); }, 700));
      rt.push(setTimeout(() => { btn((b) => b.textContent.trim() === 'Details')?.click(); }, 1100));
      rt.push(setTimeout(() => { setHidden(true); window.dispatchEvent(new CustomEvent('preview-strip-hidden')); }, 1700));
      rt.push(setTimeout(() => { setHidden(false); setTrips((n) => n + 1); window.dispatchEvent(new CustomEvent('preview-strip-shown')); setTimeout(measure, 100); }, 2400));
    }
    // EVVIEW: press a button by its text once the panel is open.
    if (scenario.click) {
      t2 = setTimeout(() => {
        [...ref.current.querySelectorAll('button')].find((b) => b.textContent.trim() === scenario.click)?.click();
        setTimeout(measure, 100);
      }, 600);
    }
    return () => { clearTimeout(t); clearTimeout(t2); rt.forEach(clearTimeout); };
  }, [cabinet, scenario.drag, scenario.click]); // eslint-disable-line react-hooks/exhaustive-deps -- dev preview: once per scenario
  const [hidden, setHidden] = useState(false); // POLISH: round trip
  const [trips, setTrips] = useState(0);
  // OPGROW: the planner's close button plays the real close (collapse → bar
  // leaves → gone), as useOpPanelTarget does in the app.
  const [closeState, setCloseState] = useState('open');
  useEffect(() => {
    if (closeState !== 'closing') return undefined;
    const t = setTimeout(() => setCloseState('closed'), opCloseDelay());
    return () => clearTimeout(t);
  }, [closeState]);
  const basePanel = scenario.props.opPanel;
  const opPanel = !basePanel || closeState === 'closed' ? null : {
    ...basePanel,
    target: { ...basePanel.target, closing: closeState === 'closing' },
    render: (lf) => basePanel.render((k) => ({ ...lf(k), closing: closeState === 'closing' }), () => setCloseState('closing')),
  };
  const main = (
    <StripView
      orgs={[]}
      onSelectOrg={noop}
      onCloseCabinet={() => setCabinet(null)}
      onToggleCabinet={(id) => setCabinet((c) => (c === id ? null : id))}
      onInstallUpdate={noop}
      onDismissHint={noop}
      onRegionChange={onRegion}
      {...scenario.props}
      opPanel={opPanel}
      viewportWidth={w}
      viewportHeight={h}
      cabinet={cabinet}
    />
  );
  return (
    <figure className="m-0 space-y-2" data-scenario={scenario.id}>
      {!bare && <figcaption className="font-ui text-ui-sm text-slate-300">{scenario.title} · {w}×{h}</figcaption>}
      {scenario.roundTrip && (
        <div className="absolute left-3 top-3 z-50 px-2 py-1 rounded bg-black/70 font-ui text-ui-xs text-amber-200" data-roundtrip={trips}>
          {hidden ? 'strip hidden…' : trips ? `hidden → shown ×${trips} (state kept)` : 'before hide'}
        </div>
      )}
      <div ref={ref} className="relative overflow-hidden" style={{ width: w, height: h, transform: 'translateZ(0)', visibility: hidden ? 'hidden' : undefined, outline: bare ? undefined : '1px solid rgba(255,255,255,0.08)' }}>
        {/* OPGROW: StripColumns no longer exists — the bar column at the bottom-right, as strip.rs lays it out. */}
        <StripFrame layout={{ expand: 'left', barRect: { x: w - 8 - MAIN_WIDTH, y: 8, w: MAIN_WIDTH, h: h - 16 } }}>{main}</StripFrame>
        {rects.map((r, i) => (
          <div key={i} className="pointer-events-none absolute border border-dashed border-amber-300/50"
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
        ))}
      </div>
    </figure>
  );
}

function Preview() {
  const params = new URLSearchParams(window.location.search);
  const only = params.get('only');
  // ?bare=1 renders one wide scenario filling the page (for screenshots at a
  // given window size); ?w=&h= set the work area otherwise (default 1366x728).
  const bare = params.get('bare') === '1';
  const pick = (arr) => (only ? arr.filter((s) => s.id === only || (only === 'channels' && s.id.startsWith('ch-')) || (only === 'wide' && arr === WIDE_SCENARIOS)) : arr);
  const list = [...pick(SCENARIOS), ...(only === 'bar2' ? BAR2_SCENARIOS : pick(BAR2_SCENARIOS))]; // BAR2
  const chList = pick(CHANNEL_SCENARIOS);
  const wideList = pick(WIDE_SCENARIOS);
  // POLISH: ?bg=bright — a light "wallpaper" to check the floating tree's legibility.
  const bg = params.get('bg') === 'bright'
    ? { background: 'linear-gradient(160deg, #f4f1e8 0%, #cfe3f2 40%, #9cc7e6 70%, #f7d9a8 100%)' }
    : { background: 'radial-gradient(circle at 30% 20%, #3b4a63 0%, #1b2333 45%, #0d1018 100%)' };
  if (bare && wideList.length) {
    return (
      <div className="fixed inset-0 overflow-hidden" style={bg}>
        <WideFrame scenario={wideList[0]} w={Number(params.get('w')) || window.innerWidth} h={Number(params.get('h')) || window.innerHeight} bare />
      </div>
    );
  }
  const w = Number(params.get('w')) || 1366;
  const h = Number(params.get('h')) || 728;
  return (
    <div className="fixed inset-0 overflow-auto p-6" style={bg}>
      <div className="flex flex-wrap gap-6">
        {wideList.map((s) => <WideFrame key={s.id} scenario={s} w={w} h={h} />)}
        {list.map((s) => <Frame key={s.id} scenario={s} />)}
        {chList.map((s) => <ChannelsFrame key={s.id} scenario={s} />)}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />);
