// OperationPlanner.jsx — Create / edit / plan operations with groups (squads) and leaders
import React, { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import useEventStream from '../useEventStream';
import { api } from '../api';
import { GAME_OPTIONS } from '../games';
import MissionMap from './MissionMap';
import ShipCompositionPicker from './ShipCompositionPicker';

// Mirrors PILOT_ROLE_NAMES in eventsController.ts — which role names
// identify "the person providing this hull," so their JOIN button can be
// replaced with the ship-slot-claim flow instead (see ShipSlotClaims below).
// The backend is authoritative; this only drives client-side UI framing.
const PILOT_ROLE_NAMES = new Set(['Pilot', 'Captain']);

// MissionMap isn't feature-complete yet (route/movement recording still to
// come) — gate the entry points until it's ready for org use rather than
// removing them, so re-enabling is a one-line flip back to `true`.
const MISSION_MAP_ENABLED = false;

const S = {
  body: { flex: 1, overflow: 'auto', padding: '16px 20px' },
  label: { fontSize: 11, color: '#0e7490', letterSpacing: '0.25em', marginBottom: 4, display: 'block' },
  input: {
    width: '100%', background: '#041018', border: '1px solid #0e2233', borderRadius: 3,
    padding: '6px 10px', fontSize: 12, color: '#e5e7eb', outline: 'none', fontFamily: 'monospace',
    colorScheme: 'dark',
  },
  btnCyan: {
    fontSize: 11, padding: '6px 14px', borderRadius: 3, letterSpacing: '0.15em',
    background: 'rgba(4, 30, 46, 0.85)', border: '1px solid rgba(8,145,178,0.72)',
    color: '#22d3ee', cursor: 'pointer',
    boxShadow: '0 0 10px rgba(6,182,212,0.18)',
  },
  btnDim: {
    fontSize: 11, padding: '6px 14px', borderRadius: 3, letterSpacing: '0.15em',
    background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', cursor: 'pointer',
  },
  btnDanger: {
    fontSize: 11, padding: '6px 14px', borderRadius: 3, letterSpacing: '0.15em',
    background: '#1c0a0a', border: '1px solid #450a0a', color: '#ef4444', cursor: 'pointer',
  },
  btnLaunch: {
    fontSize: 12, padding: '10px 24px', borderRadius: 3, letterSpacing: '0.2em',
    background: '#0c3a4a', border: '1px solid #06b6d4', color: '#22d3ee', cursor: 'pointer',
    fontWeight: 'bold', fontFamily: 'monospace',
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
    borderBottom: '1px solid #0a131c',
  },
  sectionLabel: {
    fontSize: 11, color: '#0e7490', letterSpacing: '0.3em', marginBottom: 8, marginTop: 16,
  },
  groupCard: {
    background: 'rgba(4, 16, 24, 0.68)',
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    border: '1px solid rgba(6,182,212,0.13)', borderRadius: 4,
    padding: 12, marginBottom: 10,
  },
};

// ── Create / Edit Event Form ────────────────────────────────────────────────
// GAME_OPTIONS is shared (see games.js) with SettingsUI's per-user "my games"
// picker. Extensible on purpose — mirrors the backend's SUPPORTED_GAMES set
// in eventsController.ts. Adding a game there + here is the only change
// needed to offer it; the ship picker below only activates for
// 'star_citizen' specifically, so a new game added here won't show a picker
// until its own game_ships sync + picker UI are wired up.
function EventForm({ orgId, event, members, onSaved, onCancel }) {
  const [name, setName] = useState(event?.name || '');
  const isEdit = !!event?.id;
  const [startNow, setStartNow] = useState(!isEdit);
  const [startTime, setStartTime] = useState(event?.start_time ? event.start_time.slice(0, 16) : '');
  const [endTime, setEndTime] = useState(event?.end_time ? event.end_time.slice(0, 16) : '');
  const [accessMode, setAccessMode] = useState(event?.access_mode || 'open');
  const [game, setGame] = useState(event?.game || 'none');
  const [plannerIds, setPlannerIds] = useState(() => (event?.planners || []).map(p => p.user_id));
  const [hasMeetupLocation, setHasMeetupLocation] = useState(!!event?.meetup_location);
  const [meetupLocation, setMeetupLocation] = useState(event?.meetup_location || '');
  const [showConfigure, setShowConfigure] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const togglePlanner = (uid) => {
    setPlannerIds(prev => prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (!startNow && !startTime) return;
    setSaving(true); setErr(null);
    const body = {
      name: name.trim(),
      start_time: startNow ? new Date().toISOString() : new Date(startTime).toISOString(),
      end_time: endTime ? new Date(endTime).toISOString() : null,
      access_mode: accessMode,
      game,
      planner_ids: plannerIds,
      meetup_location: hasMeetupLocation ? (meetupLocation.trim() || null) : null,
    };
    if (event?.id) {
      const { error } = await api.updateOrgEvent(orgId, event.id, body);
      if (!error) await api.setEventPlanners(orgId, event.id, plannerIds);
      setSaving(false);
      if (error) setErr(error);
      else onSaved?.();
    } else {
      const { data, error } = await api.createOrgEvent(orgId, body);
      setSaving(false);
      if (error) { setErr(error); return; }
      // Server response doesn't join planner callsigns back in — synthesize
      // them from what this form already knows locally rather than an extra
      // round-trip, so the detail view we're about to switch into shows the
      // right planner list immediately instead of waiting for a refetch.
      const createdEvent = {
        ...data.event,
        planners: plannerIds.map(uid => {
          const m = members.find(mm => mm.user_id === uid);
          return { user_id: uid, callsign: m?.callsign || uid };
        }),
      };
      onSaved?.(createdEvent);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: 420 }}>
      <div style={{ marginBottom: 12 }}>
        <label style={S.label}>OPERATION NAME</label>
        <input value={name} onChange={e => setName(e.target.value)} style={S.input} maxLength={64} placeholder="Operation Thunderstrike" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={S.label}>START TIME</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setStartNow(true)}
            style={{
              fontSize: 11, padding: '5px 12px', borderRadius: 3, cursor: 'pointer', letterSpacing: '0.1em',
              background: startNow ? '#041e2e' : 'transparent',
              border: `1px solid ${startNow ? '#0891b2' : '#0e2233'}`,
              color: startNow ? '#22d3ee' : '#9ca3af',
            }}
          >START NOW</button>
          <button
            type="button"
            onClick={() => setStartNow(false)}
            style={{
              fontSize: 11, padding: '5px 12px', borderRadius: 3, cursor: 'pointer', letterSpacing: '0.1em',
              background: !startNow ? '#041e2e' : 'transparent',
              border: `1px solid ${!startNow ? '#0891b2' : '#0e2233'}`,
              color: !startNow ? '#22d3ee' : '#9ca3af',
            }}
          >SCHEDULE</button>
          {!startNow && (
            <input type="datetime-local" value={startTime} onChange={e => setStartTime(e.target.value)} style={{ ...S.input, flex: 1, minWidth: 160 }} />
          )}
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={S.label}>END TIME <span style={{ color: '#0e7490', fontWeight: 'normal' }}>(optional)</span></label>
        <input type="datetime-local" value={endTime} onChange={e => setEndTime(e.target.value)} style={S.input} />
        {endTime && (
          <button type="button" onClick={() => setEndTime('')} style={{ ...S.btnDim, fontSize: 10, marginTop: 4, padding: '2px 8px' }}>
            CLEAR END TIME
          </button>
        )}
      </div>
      <div style={{ marginBottom: 12 }}>
        {/* Configure toggle */}
        <button
          type="button"
          onClick={() => setShowConfigure(c => !c)}
          style={{
            width: '100%', fontSize: 11, padding: '7px 14px', borderRadius: 3, cursor: 'pointer',
            letterSpacing: '0.15em', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 8,
            background: showConfigure ? '#041e2e' : '#020c14',
            border: `1px solid ${showConfigure ? '#0891b2' : '#0e2233'}`,
            color: showConfigure ? '#22d3ee' : '#9ca3af',
            transition: 'all 0.15s',
          }}
        >
          <span>{showConfigure ? '▼' : '▶'}</span>
          <span>CONFIGURE</span>
          <span style={{ fontSize: 10, color: '#0e7490', marginLeft: 4 }}>planners · access mode</span>
        </button>

        {showConfigure && (
          <div style={{ marginTop: 8, padding: '12px', background: '#020c14', border: '1px solid #0e2233', borderRadius: 3 }}>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>ACCESS MODE</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {[{ v: 'open', l: 'OPEN — anyone can join' }, { v: 'restricted', l: 'RESTRICTED — planners assign' }].map(opt => (
                  <button
                    key={opt.v} type="button" onClick={() => setAccessMode(opt.v)}
                    style={{
                      flex: 1, fontSize: 11, padding: '6px 4px', borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace',
                      background: accessMode === opt.v ? '#041e2e' : 'transparent',
                      border: `1px solid ${accessMode === opt.v ? '#0891b2' : '#0e2233'}`,
                      color: accessMode === opt.v ? '#22d3ee' : '#9ca3af',
                      transition: 'all 0.15s',
                    }}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={S.label}>GAME <span style={{ color: '#0e7490', fontWeight: 'normal' }}>(optional — enables a ship picker per group)</span></label>
              <div style={{ display: 'flex', gap: 6 }}>
                {GAME_OPTIONS.map(opt => (
                  <button
                    key={opt.v} type="button" onClick={() => setGame(opt.v)}
                    style={{
                      flex: 1, fontSize: 11, padding: '6px 4px', borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace',
                      background: game === opt.v ? '#041e2e' : 'transparent',
                      border: `1px solid ${game === opt.v ? '#0891b2' : '#0e2233'}`,
                      color: game === opt.v ? '#22d3ee' : '#9ca3af',
                      transition: 'all 0.15s',
                    }}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label style={S.label}>CO-PLANNERS <span style={{ color: '#0e7490', fontWeight: 'normal' }}>(can edit event &amp; assign roles)</span></label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 100, overflowY: 'auto' }}>
                {members.map(m => {
                  const selected = plannerIds.includes(m.user_id);
                  return (
                    <button
                      key={m.user_id} type="button" onClick={() => togglePlanner(m.user_id)}
                      style={{
                        fontSize: 11, padding: '3px 8px', borderRadius: 3, cursor: 'pointer',
                        background: selected ? '#041e2e' : 'transparent',
                        border: `1px solid ${selected ? '#0891b2' : '#0e2233'}`,
                        color: selected ? '#22d3ee' : '#9ca3af',
                        transition: 'all 0.15s', fontFamily: 'monospace',
                      }}
                    >
                      {m.callsign}
                    </button>
                  );
                })}
                {members.length === 0 && <span style={{ fontSize: 11, color: '#0e7490' }}>No members loaded</span>}
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Meetup location */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={hasMeetupLocation}
            onChange={e => setHasMeetupLocation(e.target.checked)}
            style={{ accentColor: '#0891b2', width: 14, height: 14 }}
          />
          <span style={{ ...S.label, margin: 0 }}>MEETUP LOCATION</span>
          <span style={{ fontSize: 10, color: '#0e7490' }}>(optional)</span>
        </label>
        {hasMeetupLocation && (
          <input
            value={meetupLocation}
            onChange={e => setMeetupLocation(e.target.value)}
            style={{ ...S.input, marginTop: 6 }}
            maxLength={500}
            placeholder="e.g. Discord Stage, Grid 4-7, Staging Area Bravo…"
          />
        )}
      </div>
      {err && <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" disabled={saving} style={{ ...S.btnCyan, opacity: saving ? 0.5 : 1 }}>
          {saving ? '...' : event?.id ? 'UPDATE' : 'CREATE OPERATION'}
        </button>
        {onCancel && <button type="button" onClick={onCancel} style={S.btnDim}>CANCEL</button>}
      </div>
    </form>
  );
}

// ── Org-chart tree helpers ───────────────────────────────────────────────────
function buildGroupTree(groups) {
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

const LINK_PALETTE = ['#06b6d4', '#a855f7', '#f59e0b', '#10b981', '#f43f5e', '#6366f1', '#ec4899'];

// Returns true if making dragIdx a child of targetIdx would create a cycle
function wouldCreateCycle(targetIdx, dragIdx, groups) {
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
function computeDepth(idx, groups, memo = {}) {
  if (idx in memo) return memo[idx];
  const pi = groups[idx]?.parent_index;
  const d = (pi !== null && pi !== undefined) ? computeDepth(pi, groups, memo) + 1 : 1;
  memo[idx] = d;
  return d;
}

// Map userId → count of groups they appear in (for multi-channel indicators)
function computeMultiChannelUsers(groups) {
  const counts = {};
  groups.forEach(g => {
    g.member_user_ids.forEach(uid => { counts[uid] = (counts[uid] || 0) + 1; });
  });
  return counts;
}

function computeLinkColors(groups) {
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

// Renders nothing if no ship is selected for this group. If one is selected,
// shows the fleetyards.net icon; if that image fails to load (or the group
// only has a label with no icon), falls back to a colored initials badge
// derived from the label so the node still communicates *something* was
// picked without depending on any extra denormalized fields.
// label/url are the composition's first (primary) ship; count is the total
// quantity across every ship in the composition — shown as a small "×N"
// badge when a group holds more than one vehicle (matches the cluster
// badge style already used for map tokens in MissionMap/GroupToken.jsx).
function ShipIcon({ label, url, count }) {
  const [failed, setFailed] = useState(false);
  if (!label) return null;
  const badge = count > 1 ? (
    <span style={{
      position: 'absolute', bottom: -2, right: -2, fontSize: 9, fontWeight: 'bold',
      background: '#0891b2', color: '#04101a', borderRadius: 8, padding: '1px 4px', lineHeight: 1.3,
    }}>×{count}</span>
  ) : null;

  if (url && !failed) {
    return (
      <div style={{ position: 'relative', marginBottom: 2 }}>
        <img
          src={url}
          alt={label}
          onError={() => setFailed(true)}
          style={{ width: 40, height: 40, objectFit: 'contain', borderRadius: 4, display: 'block' }}
        />
        {badge}
      </div>
    );
  }
  const initials = label.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 3).join('').toUpperCase();
  const hash = Array.from(label).reduce((h, c) => h + c.charCodeAt(0), 0);
  const badgeColor = LINK_PALETTE[hash % LINK_PALETTE.length];
  return (
    <div style={{ position: 'relative', marginBottom: 2 }}>
      <div
        title={label}
        style={{
          width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${badgeColor}22`, border: `1px solid ${badgeColor}88`, color: badgeColor,
          fontSize: 11, fontWeight: 'bold', fontFamily: 'monospace', flexShrink: 0,
        }}
      >
        {initials || '?'}
      </div>
      {badge}
    </div>
  );
}

function OrgChartRow({
  indices, groups, childrenMap, linkColors,
  selectedIdx, onSelect, canEdit, isLaunched,
  onAddChild, onRemove, members, myUserId, isOpen,
  handleJoinGroup, handleLeaveGroup, handleLeaveRole,
  // drag-drop
  dragIdx, onDragStart, onDragEnd, onDrop,
  dragOver, onDragEnterZone, onDragLeaveZone, justDropped,
  // multi-channel
  multiChannelUsers,
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      {indices.map((idx, pos) => {
        const isFirst = pos === 0;
        const isLast = pos === indices.length - 1;
        const isOnly = indices.length === 1;
        const childIndices = childrenMap[idx] || [];
        const g = groups[idx];
        const color = linkColors[idx];
        const isSelected = selectedIdx === idx;
        const userInGroup = g.member_user_ids.includes(myUserId);
        const openRoles = (g.roles || []).filter(r => r.assignment_mode === 'open');
        const openRoleCount = openRoles.length;
        const totalOpenSlots = openRoles.reduce((sum, r) => sum + Math.max(1, Number(r.max_slots) || 1), 0);
        const filledOpenSlots = openRoles.reduce((sum, r) => sum + Math.max(0, Number(r.filled_slots) || 0), 0);
        const reservedOpenSlots = openRoles.reduce((sum, r) => sum + Math.max(0, Number(r.reserved_slots) || 0), 0);
        const isBeingDragged = dragIdx === idx;
        const canBeDropTarget = dragIdx !== null && dragIdx !== idx && !wouldCreateCycle(idx, dragIdx, groups);
        const isDropZoneActive = dragOver === idx;
        return (
          <div
            key={idx}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              minWidth: 128, flex: 1, position: 'relative',
              animation: justDropped === idx ? 'planner-node-in 0.3s ease' : undefined,
            }}
          >
            {/* Top horizontal connector segment */}
            {!isOnly && (
              <div style={{
                position: 'absolute', top: 0,
                left: isFirst ? '50%' : 0,
                right: isLast ? '50%' : 0,
                height: 2,
                background: '#06b6d4',
                boxShadow: '0 0 8px #06b6d4, 0 0 18px rgba(6,182,212,0.45)',
              }} />
            )}
            {/* Vertical connector from parent */}
            <div style={{ width: 2, height: 14, background: '#06b6d4', boxShadow: '0 0 8px #06b6d4, 0 0 18px rgba(6,182,212,0.45)' }} />
            {/* Node box */}
            <div
              draggable={canEdit && !isLaunched}
              onDragStart={e => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', idx.toString());
                onDragStart(idx);
              }}
              onDragEnd={() => onDragEnd()}
              onClick={() => onSelect(idx)}
              style={{
                background: isSelected
                  ? 'linear-gradient(145deg, rgba(255,215,0,0.16) 0%, rgba(4,10,22,0.97) 55%)'
                  : color
                    ? `linear-gradient(145deg, ${color}1a 0%, rgba(3,8,18,0.97) 55%)`
                    : 'linear-gradient(145deg, rgba(6,182,212,0.11) 0%, rgba(3,8,18,0.97) 55%)',
                border: `${isSelected ? '2px' : '1px'} solid ${isSelected ? 'rgba(255,215,0,0.80)' : (color ? `${color}99` : 'rgba(6,182,212,0.50)')}`,
                borderRadius: 4, padding: '8px 10px', cursor: canEdit && !isLaunched ? 'grab' : 'pointer',
                minWidth: 110, maxWidth: 160, textAlign: 'center',
                position: 'relative',
                boxShadow: isSelected
                  ? '0 0 22px rgba(255,215,0,0.45), 0 0 44px rgba(255,215,0,0.12), 0 4px 20px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,215,0,0.20)'
                  : color
                    ? `0 0 16px ${color}44, 0 4px 16px rgba(0,0,0,0.6), inset 0 1px 0 ${color}22`
                    : '0 0 12px rgba(6,182,212,0.20), 0 4px 16px rgba(0,0,0,0.6), inset 0 1px 0 rgba(6,182,212,0.12)',
                transition: 'border-color 0.2s, box-shadow 0.2s, opacity 0.15s',
                opacity: isBeingDragged ? 0.35 : 1,
              }}
            >
              {color && (
                <div style={{
                  position: 'absolute', top: -2, left: -2, right: -2, height: 3,
                  background: color, borderRadius: '3px 3px 0 0',
                  boxShadow: `0 0 8px ${color}, 0 0 18px ${color}88`,
                }} />
              )}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: color ? 4 : 0 }}>
                <ShipIcon
                  label={g.ships?.[0]?.ship_name}
                  url={g.ships?.[0]?.ship_icon_url}
                  count={(g.ships || []).reduce((sum, s) => sum + (s.quantity || 1), 0)}
                />
              </div>
              <div style={{
                fontSize: 11, fontWeight: 'bold', fontFamily: 'monospace',
                color: isSelected ? '#ffd700' : '#e5e7eb',
                textShadow: isSelected ? '0 0 8px rgba(255,215,0,0.5)' : undefined,
                wordBreak: 'break-word',
              }}>
                {g.name}
              </div>
              {/* Priority tier badge */}
              {(() => {
                const depth = computeDepth(idx, groups, {});
                const tierC = ['', '#06b6d4', '#22d3ee', '#ffd700', '#f59e0b', '#ef4444'][Math.min(depth, 5)] || '#06b6d4';
                return (
                  <div style={{ fontSize: 9, color: tierC, letterSpacing: '0.2em', marginTop: 1, textShadow: `0 0 6px ${tierC}99` }}>
                    TIER {depth}
                  </div>
                );
              })()}
              {/* Role summary */}
              {(g.roles || []).length > 0 ? (
                <div style={{ fontSize: 9, color: '#0e7490', marginTop: 2, lineHeight: 1.5 }}>
                  <div>{(g.roles || []).length} role{(g.roles || []).length !== 1 ? 's' : ''}</div>
                  {openRoleCount > 0 && (
                    <div style={{ color: '#0891b2' }}>
                      {filledOpenSlots + reservedOpenSlots}/{totalOpenSlots} open slots
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 10, color: '#0e7490', marginTop: 1 }}>
                  {g.member_user_ids.length}{g.max_members ? `/${g.max_members}` : ''} mbr
                </div>
              )}
              {canEdit && !isLaunched && (
                <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginTop: 5 }}>
                  <button
                    onClick={e => { e.stopPropagation(); onAddChild(idx); }}
                    title="Add child group"
                    style={{ fontSize: 9, padding: '2px 6px', background: 'rgba(0,20,30,0.75)', border: '1px solid rgba(8,145,178,0.65)', color: '#22d3ee', borderRadius: 3, cursor: 'pointer', boxShadow: '0 0 6px rgba(6,182,212,0.12)' }}
                  >+</button>
                  <button
                    onClick={e => { e.stopPropagation(); onRemove(idx); }}
                    title="Remove group"
                    style={{ fontSize: 9, padding: '2px 6px', background: 'rgba(22,4,4,0.75)', border: '1px solid rgba(69,10,10,0.85)', color: '#ef4444', borderRadius: 3, cursor: 'pointer' }}
                  >✕</button>
                </div>
              )}
              {isOpen && !isLaunched && (() => {
                const openRoles = (g.roles || []).filter(r => r.assignment_mode === 'open');
                if (openRoles.length > 0) {
                  const myRoleId = g.member_role_ids?.[myUserId];
                  const myStatus = g.member_statuses?.[myUserId];
                  const amAccepted = !!myRoleId && myStatus === 'accepted';
                  const amPending = !!myRoleId && myStatus === 'pending';
                  if (amAccepted) {
                    return (
                      <button
                        onClick={e => { e.stopPropagation(); g.id && myRoleId && handleLeaveRole?.(g.id, myRoleId); }}
                        style={{ marginTop: 6, fontSize: 9, padding: '3px 6px', background: 'rgba(22,4,4,0.65)', border: '1px solid rgba(69,10,10,0.85)', color: '#ef4444', borderRadius: 3, cursor: 'pointer', display: 'block', width: '100%', letterSpacing: '0.1em' }}
                      >LEAVE</button>
                    );
                  }
                  if (amPending) {
                    return (
                      <div style={{ marginTop: 6, fontSize: 9, padding: '3px 6px', color: '#f59e0b', border: '1px solid #92400e', borderRadius: 3, textAlign: 'center', letterSpacing: '0.1em' }}>PENDING</div>
                    );
                  }
                  return (
                    <button
                      onClick={e => { e.stopPropagation(); onSelect(idx); }}
                      style={{ marginTop: 6, fontSize: 9, padding: '3px 6px', background: 'rgba(0,145,178,0.14)', border: '1px solid rgba(8,145,178,0.72)', color: '#22d3ee', borderRadius: 3, cursor: 'pointer', display: 'block', width: '100%', letterSpacing: '0.1em', boxShadow: '0 0 8px rgba(6,182,212,0.18)' }}
                    >VIEW SLOTS</button>
                  );
                }
                return userInGroup
                  ? (
                    <button
                      onClick={e => { e.stopPropagation(); g.id && handleLeaveGroup(g.id); }}
                      style={{ marginTop: 6, fontSize: 9, padding: '3px 6px', background: 'rgba(22,4,4,0.65)', border: '1px solid rgba(69,10,10,0.85)', color: '#ef4444', borderRadius: 3, cursor: 'pointer', display: 'block', width: '100%', letterSpacing: '0.1em' }}
                    >LEAVE</button>
                  ) : (
                    <button
                      onClick={e => { e.stopPropagation(); g.id && handleJoinGroup(g.id); }}
                      style={{ marginTop: 6, fontSize: 9, padding: '3px 6px', background: 'rgba(0,145,178,0.14)', border: '1px solid rgba(8,145,178,0.72)', color: '#22d3ee', borderRadius: 3, cursor: 'pointer', display: 'block', width: '100%', letterSpacing: '0.1em', boxShadow: '0 0 8px rgba(6,182,212,0.18)' }}
                    >JOIN</button>
                  );
              })()}
            </div>

            {/* Drop zone — visible during drag when this node can receive a drop */}
            {canEdit && !isLaunched && canBeDropTarget && (
              <div
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDragEnter={e => { e.preventDefault(); onDragEnterZone(idx); }}
                onDragLeave={() => onDragLeaveZone()}
                onDrop={e => { e.preventDefault(); e.stopPropagation(); onDragLeaveZone(); onDrop(idx); }}
                style={{
                  marginTop: 4,
                  width: '80%', height: 22,
                  border: `2px dashed ${isDropZoneActive ? '#22d3ee' : '#0e4a5a'}`,
                  borderRadius: 3,
                  background: isDropZoneActive ? '#020e1e' : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, color: isDropZoneActive ? '#22d3ee' : '#0e4a5a',
                  letterSpacing: '0.15em', cursor: 'copy', transition: 'all 0.1s',
                  userSelect: 'none',
                }}
              >
                <div style={{ pointerEvents: 'none' }}>
                  {childIndices.length > 0 ? '→ SIBLING' : '↓ CHILD'}
                </div>
              </div>
            )}

            {/* Children subtree */}
            {childIndices.length > 0 && (
              <>
                <div style={{ width: 2, height: 14, background: '#06b6d4', boxShadow: '0 0 8px #06b6d4, 0 0 18px rgba(6,182,212,0.45)' }} />
                <OrgChartRow
                  indices={childIndices} groups={groups} childrenMap={childrenMap}
                  linkColors={linkColors} selectedIdx={selectedIdx} onSelect={onSelect}
                  canEdit={canEdit} isLaunched={isLaunched} onAddChild={onAddChild}
                  onRemove={onRemove} members={members} myUserId={myUserId}
                  isOpen={isOpen} handleJoinGroup={handleJoinGroup} handleLeaveGroup={handleLeaveGroup}
                  handleLeaveRole={handleLeaveRole}
                  dragIdx={dragIdx} onDragStart={onDragStart} onDragEnd={onDragEnd} onDrop={onDrop}
                  dragOver={dragOver} onDragEnterZone={onDragEnterZone} onDragLeaveZone={onDragLeaveZone}
                  justDropped={justDropped} multiChannelUsers={multiChannelUsers}
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Maps a scunpacked-derived crew-role group onto the same role shape
// NodeEditorPanel's addRole() produces, so generated roles are editable like
// any manually-added one.
function shipRoleToGroupRole(r) {
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

// Group ship composition editor (Star Citizen only for now — see
// GAME_OPTIONS). A group can hold zero, one, or many ships (e.g. a 3-fighter
// wing) — g.ships is the composition, persisted via event_group_ships.
//
// Crew data (turrets, bridge stations, pilot/co-pilot — see
// scunpackedSync.ts) is fetched for every ship in the composition and
// summed (role counts scaled by each ship's quantity) to auto-fill the
// group's ROLES list if it's currently empty, or offers an explicit import
// button if it's not — generated roles never silently overwrite manual work.
function ShipPicker({ group, idx, setGroups }) {
  const [shipRoles, setShipRoles] = useState([]);
  const [autoFillMsg, setAutoFillMsg] = useState('');
  const composition = group.ships || [];
  const compositionKey = composition.map(s => `${s.ship_slug}:${s.quantity || 1}`).join(',');

  useEffect(() => {
    setShipRoles([]);
    setAutoFillMsg('');
    if (composition.length === 0) return;
    let cancelled = false;
    (async () => {
      const perShip = await Promise.all(
        composition.map(s => api.getShipCrewRoles('star_citizen', s.ship_slug).then(({ data }) => ({ quantity: s.quantity || 1, roles: data?.roles || [] })))
      );
      if (cancelled) return;

      // Sum role counts across every ship in the composition, scaled by
      // quantity, merging by display_name (e.g. 3x fighter -> Pilot x3).
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
      const roles = Array.from(summed.values()).map(r => ({ ...r, seat_labels: r.seat_labels.slice(0, 12) }));
      setShipRoles(roles);
      if (roles.length > 0 && (group.roles || []).length === 0) {
        setGroups(prev => prev.map((gp, gi) => gi !== idx ? gp : { ...gp, roles: roles.map(shipRoleToGroupRole) }));
        setAutoFillMsg(`Auto-filled ${roles.length} role${roles.length === 1 ? '' : 's'} from ship data`);
      }
    })();
    return () => { cancelled = true; };
    // Only re-run when the composition itself changes — deliberately not
    // depending on group.roles, or the auto-fill above would retrigger itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositionKey]);

  useEffect(() => {
    if (!autoFillMsg) return;
    const t = setTimeout(() => setAutoFillMsg(''), 4000);
    return () => clearTimeout(t);
  }, [autoFillMsg]);

  const importShipRoles = () => {
    setGroups(prev => prev.map((gp, gi) => gi !== idx ? gp : { ...gp, roles: [...(gp.roles || []), ...shipRoles.map(shipRoleToGroupRole)] }));
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <label style={S.label}>SHIP COMPOSITION <span style={{ color: '#0e7490', fontWeight: 'normal' }}>(optional)</span></label>
      <ShipCompositionPicker composition={composition} onChange={ships => setGroups(prev => prev.map((gp, gi) => gi !== idx ? gp : { ...gp, ships }))} />
      {autoFillMsg && <div style={{ fontSize: 10, color: '#4ade80', marginTop: 4 }}>{autoFillMsg}</div>}
      {!autoFillMsg && shipRoles.length > 0 && (group.roles || []).length > 0 && (
        <button type="button" onClick={importShipRoles} style={{ ...S.btnCyan, fontSize: 10, padding: '3px 10px', marginTop: 6 }}>
          + IMPORT SHIP ROLES
        </button>
      )}
    </div>
  );
}

// Live DPS readout for a group's ship composition — only counts weapons
// whose seat is actually crewed by an accepted member (see getGroupDpsEstimate
// in eventsController.ts), not the whole stock loadout unconditionally.
// Re-fetches whenever the composition or who's-crewed-what changes, so it
// stays live as people join/leave seats.
function GroupDpsPanel({ groupId, roles, ships, getGroupDps }) {
  const [dps, setDps] = useState(null);
  const [loading, setLoading] = useState(false);
  const rosterFingerprint = JSON.stringify((roles || []).map(r => [r.filled_slots, r.reserved_slots, (r.taken_seats || []).map(t => t.seat_label)]));
  const compositionFingerprint = (ships || []).map(s => `${s.ship_slug}:${s.quantity || 1}`).join(',');

  useEffect(() => {
    if (!groupId || !getGroupDps || !compositionFingerprint) { setDps(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data } = await getGroupDps(groupId);
      if (!cancelled) { setDps(data || null); setLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, rosterFingerprint, compositionFingerprint]);

  if (!compositionFingerprint) return null;
  if (loading && !dps) return <div style={{ fontSize: 10, color: '#0e7490', marginBottom: 10, letterSpacing: '0.1em' }}>CALCULATING GROUP DPS…</div>;
  if (!dps) return null;

  const eng = dps.engagement_range;
  const hasRange = eng && (eng.min != null || eng.missile_lock_max != null);

  return (
    <div style={{
      background: '#020c14', border: '1px solid #0e2233', borderRadius: 4,
      padding: '8px 10px', marginBottom: 10, fontSize: 11, fontFamily: 'monospace',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ color: '#0e7490', letterSpacing: '0.15em' }}>GROUP DPS{dps.approximate ? ' · APPROX' : ''}</span>
        <span style={{ color: '#22d3ee', fontWeight: 'bold' }}>
          {dps.total_sustained_dps.toLocaleString()}
          {dps.total_burst_dps > dps.total_sustained_dps && (
            <span style={{ color: '#475569', fontWeight: 'normal' }}> ({dps.total_burst_dps.toLocaleString()} burst)</span>
          )}
        </span>
      </div>
      {dps.missile_payload && (
        <div style={{ color: '#94a3b8', marginBottom: 2 }}>
          Missile payload: {dps.missile_payload.count} × ordnance, {dps.missile_payload.total_alpha.toLocaleString()} dmg
        </div>
      )}
      {hasRange && (
        <div style={{ color: '#94a3b8', marginBottom: 2 }}>
          Engagement range: {eng.min != null ? `${Math.round(eng.min)}–${Math.round(eng.max)}m` : '—'}
          {eng.missile_lock_max != null && ` · missile lock ${Math.round(eng.missile_lock_min || 0)}–${Math.round(eng.missile_lock_max)}m`}
        </div>
      )}
      {eng?.caveat && <div style={{ color: '#475569', fontSize: 10 }}>{eng.caveat}</div>}
      {dps.warnings?.length > 0 && dps.warnings.map((w, i) => (
        <div key={i} style={{ color: '#f59e0b', fontSize: 10, marginTop: 2 }}>{w}</div>
      ))}
    </div>
  );
}

// Per-composition-entry ship slot claiming — a slot needs an owner of a
// matching or approved-similar hangar ship (see shipRolesMatch in
// eventsController.ts) claiming it before that hull's crew seats unlock
// (see the blockedByUnclaimedShip check in NodeEditorPanel below). Claiming
// is one unified action with becoming that hull's Pilot/Captain — there's no
// separate "join Pilot role" step.
function ShipSlotClaims({ groupId, ships, myUserId, getClaimableShips, claimShipSlot, releaseShipSlot }) {
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);
  const compositionFingerprint = (ships || []).map(s => `${s.ship_slug}:${s.quantity || 1}`).join(',');
  const claimsFingerprint = (ships || []).map(s => (s.claims || []).map(c => `${c.slot_index}:${c.user_id}`).join(',')).join('|');

  const load = useCallback(async () => {
    const { data } = await getClaimableShips(groupId);
    setEntries(data?.entries || []);
  }, [groupId, getClaimableShips]);

  useEffect(() => {
    if (!compositionFingerprint) { setEntries(null); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositionFingerprint, claimsFingerprint]);

  if (!compositionFingerprint || !entries) return null;

  const doClaim = async (shipSlug, slotIndex, userShipId) => {
    setBusy(true);
    const { error } = await claimShipSlot(groupId, shipSlug, slotIndex, userShipId);
    setBusy(false);
    if (!error) load();
  };
  const doRelease = async (shipSlug) => {
    setBusy(true);
    const { error } = await releaseShipSlot(groupId, shipSlug);
    setBusy(false);
    if (!error) load();
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.15em', marginBottom: 4 }}>SHIP SLOTS</div>
      {entries.map(entry => (
        <div key={entry.ship_slug} style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: '#e5e7eb', fontFamily: 'monospace', marginBottom: 2 }}>{entry.ship_name}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {entry.slots.map(slot => {
              if (slot.user_id) {
                const isMine = slot.user_id === myUserId;
                const viaSubstitute = slot.claimed_ship_slug && slot.claimed_ship_slug !== entry.ship_slug;
                return (
                  <div key={slot.slot_index} style={{
                    fontSize: 10, padding: '3px 8px', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 6,
                    background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.4)', color: '#4ade80',
                  }}>
                    <span>{slot.callsign}{viaSubstitute ? ` (${slot.claimed_ship_slug})` : ''}</span>
                    {isMine && (
                      <button disabled={busy} onClick={() => doRelease(entry.ship_slug)}
                        style={{ fontSize: 9, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        RELEASE
                      </button>
                    )}
                  </div>
                );
              }
              if (entry.eligible_user_ships.length === 0) {
                return (
                  <div key={slot.slot_index} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 3, border: '1px dashed #334155', color: '#64748b' }}>
                    Slot {slot.slot_index + 1}: needs a matching hangar ship
                  </div>
                );
              }
              return (
                <div key={slot.slot_index} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {entry.eligible_user_ships.map(es => (
                    <button
                      key={es.user_ship_id}
                      disabled={busy}
                      onClick={() => doClaim(entry.ship_slug, slot.slot_index, es.user_ship_id)}
                      style={{ fontSize: 10, padding: '3px 8px', background: 'rgba(0,145,178,0.14)', border: '1px solid rgba(8,145,178,0.72)', color: '#22d3ee', borderRadius: 3, cursor: 'pointer' }}
                    >
                      CLAIM w/ {es.ship_name}{!es.exact ? ' (similar)' : ''}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeEditorPanel({ idx, groups, members, updateGroup, setGroups, linkColors, accessMode, game, frequencies, setFrequencies, canEdit, isLaunched, myUserId, handleJoinRole, handleLeaveRole, handleApproveJoin, handleApproveAllPending, handleRemoveMember, getGroupDps, getClaimableShips, claimShipSlot, releaseShipSlot }) {
  const g = groups[idx];
  const color = linkColors[idx];
  const tier = computeDepth(idx, groups, {});
  // Roles with more than one individually-named seat (e.g. specific turret
  // positions) need the joiner to pick which one — this tracks which role's
  // picker is currently expanded (by role id).
  const [pickingSeatForRole, setPickingSeatForRole] = useState(null);

  const PRIORITY_COLORS = ['', '#475569', '#0891b2', '#22d3ee', '#f59e0b', '#ef4444'];
  const PRIORITY_LABELS = ['', 'LOW', 'MED-LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

  const addRole = () => {
    setGroups(prev => prev.map((gp, gi) => gi !== idx ? gp : {
      ...gp,
      roles: [...(gp.roles || []), { name: '', priority: 3, channel_group_index: null, assignment_mode: 'open', assigned_user_id: '', max_slots: 1, is_commander: false }],
    }));
  };

  const updateRole = (ri, field, value) => {
    setGroups(prev => prev.map((gp, gi) => gi !== idx ? gp : {
      ...gp,
      roles: gp.roles.map((r, rIdx) => rIdx === ri ? { ...r, [field]: value } : r),
    }));
  };

  const removeRole = (ri) => {
    setGroups(prev => prev.map((gp, gi) => gi !== idx ? gp : {
      ...gp,
      roles: gp.roles.filter((_, rIdx) => rIdx !== ri),
    }));
  };

  const roles = g.roles || [];

  if (!canEdit) {
    // ── View-only panel: show role slots with join/leave ──────────────────────
    return (
      <div style={{
        marginTop: 12, background: '#040d15',
        border: `1px solid ${color || '#143346'}`,
        borderTop: color ? `3px solid ${color}` : undefined,
        borderRadius: 5, padding: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: '#0e7490', letterSpacing: '0.2em' }}>
            <span style={{ color: color || '#22d3ee', fontFamily: 'monospace', fontWeight: 'bold' }}>{g.name}</span>
          </div>
          <div style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, letterSpacing: '0.2em', background: '#020c14', border: '1px solid #0e4a5a', color: '#0891b2' }}>
            TIER {tier}
          </div>
        </div>
        {game === 'star_citizen' && <GroupDpsPanel groupId={g.id} roles={roles} ships={g.ships} getGroupDps={getGroupDps} />}
        {game === 'star_citizen' && (g.ships || []).length > 0 && (
          <ShipSlotClaims
            groupId={g.id}
            ships={g.ships}
            myUserId={myUserId}
            getClaimableShips={getClaimableShips}
            claimShipSlot={claimShipSlot}
            releaseShipSlot={releaseShipSlot}
          />
        )}
        {roles.length === 0 ? (
          <div style={{ fontSize: 11, color: '#0e7490', letterSpacing: '0.1em' }}>No roles configured for this group.</div>
        ) : (
          <div style={{ borderTop: '1px solid #0a1e2e', paddingTop: 10 }}>
            {roles.map((role, ri) => {
              const pColor = PRIORITY_COLORS[role.priority] || '#475569';
              const myRoleId = g.member_role_ids?.[myUserId];
              const myStatus = g.member_statuses?.[myUserId];
              const amAcceptedInRole = myRoleId === role.id && myStatus === 'accepted';
              const amPendingInRole = myRoleId === role.id && myStatus === 'pending';
              const mySeatLabel = g.member_seat_labels?.[myUserId];
              const filledSlots = Number(role.filled_slots) || 0;
              const reservedSlots = Number(role.reserved_slots) || 0;
              const maxSlots = Number(role.max_slots) || 1;
              const hasSlot = filledSlots + reservedSlots < maxSlots;
              const alreadyInAGroup = !!myRoleId || (g.member_user_ids.includes(myUserId) && !myRoleId);
              const seatLabels = Array.isArray(role.seat_labels) ? role.seat_labels : [];
              const takenSeats = role.taken_seats || [];
              const takenSeatSet = new Set(takenSeats.map(t => t.seat_label));
              const availableSeats = seatLabels.filter(s => !takenSeatSet.has(s));
              const needsSeatChoice = seatLabels.length > 1;
              const isPickingSeat = pickingSeatForRole === role.id;
              // Ship-composed groups gate crew joins on a ship slot being
              // claimed first (see ShipSlotClaims/claimShipSlot) — Pilot/
              // Captain can ONLY be reached by claiming, so its JOIN button
              // is replaced entirely; other roles just need *some* hull
              // claimed (a client-side approximation of the backend's
              // per-slug check in joinEventRole, which is authoritative —
              // this only pre-empts the obvious all-unclaimed case).
              const isShipComposed = (g.ships || []).length > 0;
              const isPilotRole = PILOT_ROLE_NAMES.has(role.name);
              const anyShipClaimed = (g.ships || []).some(s => (s.claims || []).length > 0);
              const blockedByUnclaimedShip = isShipComposed && !isPilotRole && !anyShipClaimed;
              return (
                <div key={ri} style={{
                  background: '#020c14', borderRadius: 4, marginBottom: 8, padding: '8px 10px',
                  border: `1px solid ${amAcceptedInRole || amPendingInRole ? '#0e4a5a' : '#0e2233'}`,
                  borderLeft: `3px solid ${pColor}`,
                  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                }}>
                  {role.is_commander && <span title="Operation Commander" style={{ color: '#4ade80', fontSize: 13 }}>★</span>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: '#e5e7eb', fontFamily: 'monospace' }}>{role.name || '—'}</div>
                    {(amAcceptedInRole || amPendingInRole) && mySeatLabel && (
                      <div style={{ fontSize: 9, color: '#4ade80', marginTop: 1 }}>Your seat: {mySeatLabel}</div>
                    )}
                    {needsSeatChoice && !amAcceptedInRole && !amPendingInRole && (
                      <div style={{ fontSize: 9, color: '#0e7490', marginTop: 1 }}>
                        {takenSeats.length > 0 && `${takenSeats.map(t => `${t.seat_label} (${t.callsign})`).join(', ')} claimed · `}
                        {availableSeats.length} seat{availableSeats.length === 1 ? '' : 's'} open
                      </div>
                    )}
                  </div>
                  {role.assignment_mode === 'open' ? (
                    <>
                      <span style={{ fontSize: 10, color: hasSlot ? '#0891b2' : '#374151', letterSpacing: '0.1em' }}>
                        {filledSlots}/{maxSlots} filled{reservedSlots > 0 ? ` (${reservedSlots} reserved)` : ''}
                      </span>
                      {!isLaunched && (() => {
                        if (amAcceptedInRole) {
                          return (
                            <button
                              onClick={() => role.id && handleLeaveRole?.(g.id, role.id)}
                              style={{ fontSize: 10, padding: '3px 8px', background: 'rgba(22,4,4,0.65)', border: '1px solid rgba(69,10,10,0.85)', color: '#ef4444', borderRadius: 3, cursor: 'pointer' }}
                            >LEAVE</button>
                          );
                        }
                        if (amPendingInRole) {
                          return (
                            <span style={{ fontSize: 10, color: '#f59e0b', border: '1px solid #92400e', borderRadius: 3, padding: '3px 8px', letterSpacing: '0.1em' }}>PENDING</span>
                          );
                        }
                        if (isShipComposed && isPilotRole) {
                          // Claiming a ship slot (below, in ShipSlotClaims)
                          // is what assigns this role — there's nothing to
                          // click here.
                          return (
                            <span style={{ fontSize: 10, color: '#374151', letterSpacing: '0.1em' }}>CLAIM A SHIP TO JOIN</span>
                          );
                        }
                        if (!alreadyInAGroup) {
                          if (blockedByUnclaimedShip) {
                            return (
                              <span title="No ship has been claimed for this group yet" style={{ fontSize: 10, padding: '3px 8px', color: '#374151', border: '1px solid #1e293b', borderRadius: 3, letterSpacing: '0.1em' }}>
                                AWAITING SHIP
                              </span>
                            );
                          }
                          // A full role still lets you into the group's channel —
                          // roles only gate frequency/priority within the group,
                          // not group membership — so the button stays clickable
                          // and the server falls back to plain group membership.
                          return (
                            <button
                              onClick={() => {
                                if (!role.id) return;
                                if (hasSlot && needsSeatChoice) setPickingSeatForRole(role.id);
                                else handleJoinRole?.(g.id, role.id);
                              }}
                              title={hasSlot ? undefined : 'Role is full — joins the group without this frequency/priority assignment'}
                              style={{ fontSize: 10, padding: '3px 8px', background: 'rgba(0,145,178,0.14)', border: '1px solid rgba(8,145,178,0.72)', color: '#22d3ee', borderRadius: 3, cursor: 'pointer' }}
                            >{hasSlot ? 'JOIN' : 'JOIN (FULL)'}</button>
                          );
                        }
                        return null;
                      })()}
                    </>
                  ) : (
                    <span style={{ fontSize: 10, color: role.assigned_callsign ? '#22d3ee' : '#374151', letterSpacing: '0.1em', fontFamily: 'monospace' }}>
                      {role.assigned_callsign || 'TBD'}
                    </span>
                  )}
                  {isPickingSeat && (
                    <div style={{ width: '100%', marginTop: 6, padding: 8, background: '#010810', border: '1px solid #0e2233', borderRadius: 3 }}>
                      <div style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.15em', marginBottom: 6 }}>PICK YOUR SEAT</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {availableSeats.length === 0 && (
                          <span style={{ fontSize: 10, color: '#374151' }}>No seats available.</span>
                        )}
                        {availableSeats.map(seat => (
                          <button
                            key={seat}
                            onClick={() => { setPickingSeatForRole(null); handleJoinRole?.(g.id, role.id, seat); }}
                            style={{ fontSize: 10, padding: '3px 8px', background: 'rgba(0,145,178,0.14)', border: '1px solid rgba(8,145,178,0.72)', color: '#22d3ee', borderRadius: 3, cursor: 'pointer' }}
                          >{seat}</button>
                        ))}
                      </div>
                      <button
                        onClick={() => setPickingSeatForRole(null)}
                        style={{ marginTop: 6, fontSize: 9, color: '#64748b', background: 'none', border: 'none', cursor: 'pointer', letterSpacing: '0.1em' }}
                      >CANCEL</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{
      marginTop: 12, background: '#040d15',
      border: `1px solid ${color || '#143346'}`,
      borderTop: color ? `3px solid ${color}` : undefined,
      borderRadius: 5, padding: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: '#0e7490', letterSpacing: '0.2em' }}>
          EDITING: <span style={{ color: color || '#22d3ee', fontFamily: 'monospace', fontWeight: 'bold' }}>{g.name}</span>
        </div>
        <div style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, letterSpacing: '0.2em', background: '#020c14', border: '1px solid #0e4a5a', color: '#0891b2' }}>
          PRIORITY TIER {tier}
        </div>
      </div>

      {/* Group fields */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '2 1 140px' }}>
          <label style={S.label}>NAME</label>
          <input value={g.name} onChange={e => updateGroup(idx, 'name', e.target.value)} style={S.input} maxLength={64} />
        </div>
        <div style={{ flex: '1 1 80px' }}>
          <label style={S.label}>MAX SIZE</label>
          <input type="number" min="0" value={g.max_members || ''} onChange={e => updateGroup(idx, 'max_members', parseInt(e.target.value) || 0)} style={S.input} placeholder="∞" />
        </div>
      </div>
      {game === 'star_citizen' && <ShipPicker group={g} idx={idx} setGroups={setGroups} />}
      {/* Roles */}
      <div style={{ borderTop: '1px solid #0a1e2e', paddingTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <label style={{ ...S.label, margin: 0 }}>ROLES</label>
          <button onClick={addRole} style={{ ...S.btnCyan, padding: '3px 10px', fontSize: 10 }}>+ ADD ROLE</button>
        </div>

        {roles.length === 0 && (
          <div style={{ fontSize: 11, color: '#0e7490', padding: '8px 0', letterSpacing: '0.1em' }}>
            No roles defined — add roles to assign personnel and channels.
          </div>
        )}

        {roles.map((role, ri) => {
          const pColor = PRIORITY_COLORS[role.priority] || '#475569';
          return (
            <div key={ri} style={{
              background: '#020c14', borderRadius: 4, marginBottom: 8, padding: '8px 10px',
              border: '1px solid #0e2233', borderLeft: `3px solid ${pColor}`,
            }}>
              {/* Row 1: CMD toggle + name + priority + remove */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                {/* Commander role toggle */}
                <button
                  onClick={() => {
                    const turningOn = !role.is_commander;
                    // Clear is_commander from all roles across all groups, then set this one
                    setGroups(prev => prev.map(gp => ({
                      ...gp,
                      roles: (gp.roles || []).map(r => ({ ...r, is_commander: false })),
                    })));
                    if (turningOn) updateRole(ri, 'is_commander', true);
                  }}
                  title={role.is_commander ? 'Operation Commander role — click to unset' : 'Designate as Operation Commander role'}
                  style={{
                    fontSize: 12, width: 26, height: 26, borderRadius: 3, cursor: 'pointer', flexShrink: 0,
                    background: role.is_commander ? '#1a3a0e' : 'transparent',
                    border: `1px solid ${role.is_commander ? '#4ade80' : '#0e2233'}`,
                    color: role.is_commander ? '#4ade80' : '#334155',
                    transition: 'all 0.1s',
                  }}
                >★</button>
                <input
                  value={role.name}
                  onChange={e => updateRole(ri, 'name', e.target.value)}
                  placeholder="Role name…"
                  maxLength={64}
                  style={{ ...S.input, flex: '2 1 120px', padding: '4px 8px', fontSize: 11 }}
                />
                {/* Priority 1-5 picker */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                  <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.1em', marginRight: 2 }}>PRI</span>
                  {[1, 2, 3, 4, 5].map(p => (
                    <button
                      key={p}
                      onClick={() => updateRole(ri, 'priority', p)}
                      title={`Priority ${p} — ${PRIORITY_LABELS[p]}`}
                      style={{
                        width: 22, height: 22, borderRadius: 3, fontSize: 11, fontWeight: 'bold',
                        cursor: 'pointer', border: 'none', transition: 'all 0.1s',
                        background: role.priority === p ? PRIORITY_COLORS[p] : '#0a1a2a',
                        color: role.priority === p ? '#fff' : '#334155',
                      }}
                    >{p}</button>
                  ))}
                </div>
                <button
                  onClick={() => removeRole(ri)}
                  style={{ fontSize: 10, color: '#7f1d1d', background: 'none', border: '1px solid #450a0a', borderRadius: 3, cursor: 'pointer', padding: '3px 8px', marginLeft: 'auto', flexShrink: 0 }}
                >✕</button>
              </div>

              {Array.isArray(role.seat_labels) && role.seat_labels.length > 0 && (
                <div style={{ fontSize: 9, color: '#0e7490', marginTop: -4, marginBottom: 8, paddingLeft: 34 }}>
                  {role.seat_labels.join(', ')}
                  {role.seat_labels.length > 1 && <span style={{ color: '#4ade80' }}> · joiners pick a specific seat</span>}
                </div>
              )}

              {/* Row 2: frequency + assignment mode + direct user or slot count */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                {/* Liaison channels for this role — multi-select via role_refs */}
                {canEdit && !isLaunched && (frequencies || []).length > 0 && (
                  <div style={{ flex: '2 1 140px' }}>
                    <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.15em', display: 'block', marginBottom: 3 }}>LIAISON CHANNELS</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                      {frequencies.map((f, fi) => {
                        const isOn = (f.role_refs || []).some(ref => ref.group_index === idx && ref.role_index === ri);
                        return (
                          <button
                            key={fi}
                            onClick={() => setFrequencies(prev => prev.map((ff, ffi) => {
                              if (ffi !== fi) return ff;
                              const has = (ff.role_refs || []).some(ref => ref.group_index === idx && ref.role_index === ri);
                              const refs = has
                                ? (ff.role_refs || []).filter(ref => !(ref.group_index === idx && ref.role_index === ri))
                                : [...(ff.role_refs || []), { group_index: idx, role_index: ri }];
                              return { ...ff, role_refs: refs };
                            }))}
                            style={{
                              fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace',
                              letterSpacing: '0.1em',
                              background: isOn ? '#0c2a1a' : 'transparent',
                              border: `1px solid ${isOn ? '#16a34a' : '#0e2233'}`,
                              color: isOn ? '#4ade80' : '#6b7280',
                            }}
                          >{f.name}</button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Assignment mode toggle */}
                <div style={{ flex: '1 1 110px' }}>
                  <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.15em', display: 'block', marginBottom: 3 }}>ASSIGNMENT</span>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {['open', 'direct'].map(mode => (
                      <button
                        key={mode}
                        onClick={() => updateRole(ri, 'assignment_mode', mode)}
                        style={{
                          flex: 1, fontSize: 10, padding: '4px', borderRadius: 3, cursor: 'pointer',
                          letterSpacing: '0.1em', transition: 'all 0.1s',
                          background: role.assignment_mode === mode ? '#041e2e' : 'transparent',
                          border: `1px solid ${role.assignment_mode === mode ? '#0891b2' : '#0e2233'}`,
                          color: role.assignment_mode === mode ? '#22d3ee' : '#64748b',
                        }}
                      >{mode === 'open' ? 'OPEN' : 'DIRECT'}</button>
                    ))}
                  </div>
                </div>

                {/* DIRECT: user picker */}
                {role.assignment_mode === 'direct' && (
                  <div style={{ flex: '2 1 130px' }}>
                    <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.15em', display: 'block', marginBottom: 3 }}>ASSIGN TO</span>
                    <select
                      value={role.assigned_user_id || ''}
                      onChange={e => updateRole(ri, 'assigned_user_id', e.target.value)}
                      style={{ ...S.input, padding: '4px 6px', fontSize: 10 }}
                    >
                      <option value="">— Select member —</option>
                      {members.map(m => <option key={m.user_id} value={m.user_id}>{m.callsign}</option>)}
                    </select>
                  </div>
                )}

                {/* OPEN: slot count */}
                {role.assignment_mode === 'open' && (
                  <div style={{ flex: '0 0 60px' }}>
                    <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.15em', display: 'block', marginBottom: 3 }}>SLOTS</span>
                    <input
                      type="number" min="1" max="99"
                      value={role.max_slots || 1}
                      onChange={e => updateRole(ri, 'max_slots', Math.max(1, parseInt(e.target.value) || 1))}
                      style={{ ...S.input, padding: '4px 6px', fontSize: 10 }}
                    />
                  </div>
                )}

                {/* OPEN: auto-approve toggle */}
                {role.assignment_mode === 'open' && (
                  <div style={{ flex: '0 0 auto' }}>
                    <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.15em', display: 'block', marginBottom: 3 }}>APPROVAL</span>
                    <button
                      onClick={() => updateRole(ri, 'auto_approve', !role.auto_approve)}
                      style={{
                        fontSize: 9, padding: '4px 8px', borderRadius: 3, cursor: 'pointer',
                        background: role.auto_approve ? 'rgba(21,128,61,0.18)' : 'rgba(120,53,15,0.18)',
                        border: `1px solid ${role.auto_approve ? '#16a34a' : '#92400e'}`,
                        color: role.auto_approve ? '#4ade80' : '#f59e0b',
                        letterSpacing: '0.1em', whiteSpace: 'nowrap',
                      }}
                    >{role.auto_approve ? 'AUTO' : 'MANUAL'}</button>
                  </div>
                )}
              </div>

              {/* Assigned status (if direct and user picked) */}
              {role.assignment_mode === 'direct' && role.assigned_user_id && (
                <div style={{ fontSize: 10, color: '#0e7490', marginTop: 6, letterSpacing: '0.1em' }}>
                  Personnel will receive a pending assignment notification when saved.
                </div>
              )}

              {/* Pending join requests for this open role */}
              {role.assignment_mode === 'open' && (() => {
                const pending = Object.entries(g.member_statuses || {})
                  .filter(([uid, st]) => st === 'pending' && g.member_role_ids?.[uid] === role.id)
                  .map(([uid]) => ({ userId: uid, callsign: g.member_callsigns?.[uid] || uid }));
                if (pending.length === 0) return null;
                return (
                  <div style={{ marginTop: 6, borderTop: '1px solid #0a1e2e', paddingTop: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ fontSize: 9, color: '#f59e0b', letterSpacing: '0.15em' }}>PENDING APPROVAL</div>
                      <button
                        onClick={() => handleApproveAllPending?.(g.id)}
                        style={{ fontSize: 9, padding: '2px 7px', background: 'rgba(21,128,61,0.18)', border: '1px solid #16a34a', color: '#4ade80', borderRadius: 3, cursor: 'pointer' }}
                      >APPROVE ALL</button>
                    </div>
                    {pending.map(({ userId, callsign }) => (
                      <div key={userId} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 10, color: '#e5e7eb', fontFamily: 'monospace', flex: 1 }}>{callsign}</span>
                        <button
                          onClick={() => handleApproveJoin?.(g.id, userId)}
                          style={{ fontSize: 9, padding: '2px 7px', background: 'rgba(21,128,61,0.18)', border: '1px solid #16a34a', color: '#4ade80', borderRadius: 3, cursor: 'pointer' }}
                        >APPROVE</button>
                        <button
                          onClick={() => handleRemoveMember?.(g.id, userId)}
                          style={{ fontSize: 9, padding: '2px 7px', background: 'rgba(22,4,4,0.5)', border: '1px solid #450a0a', color: '#ef4444', borderRadius: 3, cursor: 'pointer' }}
                        >DENY</button>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Group Planner (squads + leaders) ────────────────────────────────────────
// Exported (not just used internally by OperationPlanner) so WarRoom's
// join-only group-comp modal can render the exact same tree layout instead
// of a separate flat-list view that drifts from what the editor shows.
export const GroupPlanner = forwardRef(function GroupPlanner({ orgId, eventId, members, isLaunched, canEdit, user, accessMode, game }, ref) {
  const [groups, setGroups] = useState([]);
  const [frequencies, setFrequencies] = useState([]); // [{name, role_refs:[{group_index,role_index}]}]
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [presets, setPresets] = useState([]);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetSaveName, setPresetSaveName] = useState('');
  const [presetSaving, setPresetSaving] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [commanderUserId, _setCommanderUserId] = useState(''); // kept for isEventCommander compat; derived from commander role on save
  const [myAssignment, setMyAssignment] = useState(null);
  // Pending hangar-ship seat-claim confirmation, shown before a role join
  // that would also reserve locked seats on a ship-matched role — see
  // handleJoinRole/confirmShipJoin below.
  const [shipConfirm, setShipConfirm] = useState(null);
  const [showMap, setShowMap] = useState(false);
  // Drag-drop state
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [justDropped, setJustDropped] = useState(null);

  const loadPresets = useCallback(async () => {
    const { data } = await api.getEventPresets(orgId);
    setPresets(data?.presets || []);
  }, [orgId]);

  useEffect(() => { if (canEdit) loadPresets(); }, [loadPresets, canEdit]);

  const applyPreset = (preset) => {
    const layout = preset.layout || [];
    setGroups(layout.map((g, i) => ({
      name: g.name || `Group ${i + 1}`,
      max_members: g.max_members || 0,
      parent_index: g.parent_index ?? null,
      linked_index: g.linked_index ?? null,
      roles: [],
      member_user_ids: [],
      member_roles: {},
      member_statuses: {},
    })));
    setPresetsOpen(false);
    setMsg({ type: 'ok', text: `Preset "${preset.name}" loaded — assign members and save.` });
  };

  const handleSavePreset = async () => {
    if (!presetSaveName.trim()) return;
    setPresetSaving(true);
    const layout = groups.map(g => ({
      name: g.name,
      max_members: g.max_members || 0,
      parent_index: g.parent_index ?? null,
      linked_index: g.linked_index ?? null,
    }));
    const { error } = await api.saveEventPreset(orgId, presetSaveName.trim(), layout);
    setPresetSaving(false);
    if (error) setMsg({ type: 'error', text: error });
    else { setPresetSaveName(''); loadPresets(); setMsg({ type: 'ok', text: 'Preset saved.' }); }
  };

  const handleDeletePreset = async (presetId) => {
    const { error } = await api.deleteEventPreset(orgId, presetId);
    if (error) setMsg({ type: 'error', text: error });
    else loadPresets();
  };

  const load = useCallback(async () => {
    const [{ data }, assignmentRes] = await Promise.all([
      api.getEventGroups(orgId, eventId),
      api.getMyEventAssignment(orgId, eventId),
    ]);
    const rawGroups = data?.groups || [];
    const groupIdToIndex = {};
    rawGroups.forEach((g, i) => { groupIdToIndex[g.id] = i; });
    setGroups(rawGroups.map(g => ({
      id: g.id,
      name: g.name,
      max_members: g.max_members || 0,
      // Not editable anywhere in this planner (leadership is handled via the
      // is_commander role flag below instead) — carried through unchanged so
      // a save doesn't silently null out legacy data on older events that
      // still have it set.
      leader_user_id: g.leader_user_id || null,
      parent_index: g.parent_group_id ? (groupIdToIndex[g.parent_group_id] ?? null) : null,
      linked_index: g.linked_group_id ? (groupIdToIndex[g.linked_group_id] ?? null) : null,
      ships: (g.ships || []).map(s => ({
        ship_slug: s.ship_slug, ship_name: s.ship_name, ship_icon_url: s.ship_icon_url || null, quantity: s.quantity || 1,
      })),
      roles: (g.roles || []).map(r => ({
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
    })));
    // commander_user_id is auto-derived by backend from is_commander role; no local state needed
    // Load frequencies (role_refs use group_index / role_index relative to rawGroups order)
    const rawFreqs = data?.frequencies || [];
    setFrequencies(rawFreqs.map(f => ({
      id: f.id,
      name: f.name || '',
      role_refs: (f.role_refs || []).map(r => ({ group_index: r.gi ?? r.group_index, role_index: r.ri ?? r.role_index })),
    })));
    setMyAssignment(assignmentRes?.data?.assignment || null);
    setLoading(false);
  }, [orgId, eventId]);

  useEffect(() => { load(); }, [load]);

  // `Group ${prev.length + 1}` collided with existing names after any group
  // had been removed (array length no longer matches the highest number used
  // so far) — e.g. remove "Group 2" from [1,2,3], add a new one: length is 2,
  // so it's named "Group 3", colliding with the group already holding that
  // name. Scan existing names for the highest "Group N" actually in use instead.
  const nextGroupName = (currentGroups) => {
    let maxN = 0;
    for (const g of currentGroups) {
      const m = /^Group (\d+)$/.exec(g.name || '');
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    return `Group ${maxN + 1}`;
  };

  const addGroup = () => setGroups(prev => [...prev, { name: nextGroupName(prev), max_members: 0, parent_index: null, linked_index: null, roles: [], member_user_ids: [], member_roles: {}, member_statuses: {}, member_role_ids: {}, member_callsigns: {} }]);

  const addChildGroup = (parentIdx) => {
    const newIdx = groups.length;
    setGroups(prev => [...prev, {
      name: nextGroupName(prev),
      max_members: 0,
      parent_index: parentIdx ?? null,
      linked_index: null,
      roles: [],
      member_user_ids: [],
      member_roles: {},
      member_statuses: {},
      member_role_ids: {},
      member_callsigns: {},
    }]);
    setSelectedIdx(newIdx);
  };

  const removeGroup = (i) => setGroups(prev => {
    const filtered = prev.filter((_, idx) => idx !== i);
    return filtered.map(g => {
      let updated = { ...g };
      if (updated.parent_index === i) updated.parent_index = null;
      else if (updated.parent_index > i) updated.parent_index = updated.parent_index - 1;
      if (updated.linked_index === i) updated.linked_index = null;
      else if (updated.linked_index !== null && updated.linked_index !== undefined && updated.linked_index > i) updated.linked_index = updated.linked_index - 1;
      return updated;
    });
  });

  const updateGroup = (i, field, value) => {
    setGroups(prev => prev.map((g, idx) => idx === i ? { ...g, [field]: value } : g));
  };

  const toggleMember = (groupIdx, userId) => {
    setGroups(prev => prev.map((g, idx) => {
      if (idx !== groupIdx) return g;
      const has = g.member_user_ids.includes(userId);
      return { ...g, member_user_ids: has ? g.member_user_ids.filter(id => id !== userId) : [...g.member_user_ids, userId] };
    }));
  };

  const handleSave = async () => {
    setSaving(true); setMsg(null);

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

    const payload = {
      groups: sortedIndices.map(oldIdx => {
        const g = groups[oldIdx];
        return {
          // Real DB id when this group already exists (from load()) so the backend
          // can update it in place instead of destroying and recreating it, which
          // would wipe every member row (including self-signups) on every save.
          id: g.id || null,
          name: g.name,
          max_members: g.max_members || 0,
          // Round-tripped from load() unchanged — see the field's comment
          // there. Previously omitted here entirely, so the server's UPDATE
          // silently nulled it out on every single save regardless of what
          // was actually set.
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
      frequencies: frequencies.map(f => ({
        id: f.id || null,
        name: f.name,
        role_refs: (f.role_refs || []).map(ref => ({
          group_index: (ref.group_index !== null && ref.group_index !== undefined) ? (oldToNew[ref.group_index] ?? ref.group_index) : null,
          role_index: ref.role_index,
        })).filter(r => r.group_index !== null && r.group_index !== undefined),
      })),
    };
    const { error } = await api.saveEventGroups(orgId, eventId, payload);
    setSaving(false);
    if (error) setMsg({ type: 'error', text: error });
    else { setMsg({ type: 'ok', text: 'Groups saved' }); load(); }
  };

  // ── Self-join / leave (open events) ──────────────────────────────
  const handleJoinGroup = async (groupId) => {
    const { error } = await api.joinEventGroup(orgId, eventId, groupId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const handleLeaveGroup = async (groupId) => {
    const { error } = await api.leaveEventGroup(orgId, eventId, groupId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const handleJoinRole = async (groupId, roleId, seatLabel = null) => {
    // If the caller has a hangar ship matching this group's selected ship
    // and it has locked seats, confirm before the join also reserves them.
    const { data } = await api.getGroupShipMatch(orgId, eventId, groupId);
    const match = data?.match;
    if (match && (match.locked_seats || []).length > 0) {
      setShipConfirm({ groupId, roleId, shipId: match.ship_id, shipName: match.ship_name, seatLabels: match.locked_seat_labels || [], joinSeatLabel: seatLabel });
      return;
    }
    const { error } = await api.joinEventRole(orgId, eventId, groupId, roleId, match?.ship_id || null, seatLabel);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const confirmShipJoin = async (withShip) => {
    if (!shipConfirm) return;
    const { groupId, roleId, shipId, joinSeatLabel } = shipConfirm;
    setShipConfirm(null);
    const { error } = await api.joinEventRole(orgId, eventId, groupId, roleId, withShip ? shipId : null, joinSeatLabel);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const handleLeaveRole = async (groupId, roleId) => {
    const { error } = await api.leaveEventRole(orgId, eventId, groupId, roleId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const handleApproveJoin = async (groupId, userId) => {
    const { error } = await api.approveGroupMember(orgId, eventId, groupId, userId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const handleRemoveMember = async (groupId, userId) => {
    const { error } = await api.removeGroupMember(orgId, eventId, groupId, userId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const handleApproveAllPending = async (groupId) => {
    const { error } = await api.approveAllGroupMembers(orgId, eventId, groupId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const getGroupDps = useCallback((groupId) => api.getGroupDpsEstimate(orgId, eventId, groupId), [orgId, eventId]);
  const getClaimableShips = useCallback((groupId) => api.getClaimableShips(orgId, eventId, groupId), [orgId, eventId]);
  const claimShipSlot = useCallback(async (groupId, shipSlug, slotIndex, userShipId) => {
    const result = await api.claimShipSlot(orgId, eventId, groupId, shipSlug, slotIndex, userShipId);
    if (result.error) setMsg({ type: 'error', text: result.error });
    else load();
    return result;
  }, [orgId, eventId]);
  const releaseShipSlot = useCallback(async (groupId, shipSlug) => {
    const result = await api.releaseShipSlot(orgId, eventId, groupId, shipSlug);
    if (result.error) setMsg({ type: 'error', text: result.error });
    else load();
    return result;
  }, [orgId, eventId]);

  const handleQuickJoin = async () => {
    const { error } = await api.quickJoinEvent(orgId, eventId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  const handleQuickLeave = async () => {
    const { error } = await api.leaveMyEventSignup(orgId, eventId);
    if (error) setMsg({ type: 'error', text: error });
    else load();
  };

  // ── Accept / Decline assignment (restricted events) ──────────────
  const handleRespond = async (accept) => {
    const { error } = await api.respondEventAssignment(orgId, eventId, accept);
    if (error) setMsg({ type: 'error', text: error });
    else { setMsg({ type: 'ok', text: accept ? 'Assignment accepted' : 'Assignment declined' }); load(); }
  };

  // ── Drag-drop handlers ────────────────────────────────────────────
  const handleDragStart = (idx) => setDragIdx(idx);
  const handleDragEnd = () => { setDragIdx(null); setDragOver(null); };
  const handleDragEnterZone = (id) => setDragOver(id);
  const handleDragLeaveZone = () => setDragOver(null);

  const handleDrop = (targetIdx) => {
    if (dragIdx === null || dragIdx === targetIdx) { setDragIdx(null); setDragOver(null); return; }
    if (wouldCreateCycle(targetIdx, dragIdx, groups)) { setDragIdx(null); setDragOver(null); return; }
    setGroups(prev => prev.map((g, i) => i === dragIdx ? { ...g, parent_index: targetIdx } : g));
    const dropped = dragIdx;
    setDragIdx(null); setDragOver(null);
    setJustDropped(dropped);
    setTimeout(() => setJustDropped(null), 400);
  };

  const handleDropOnCommand = () => {
    if (dragIdx === null) return;
    setGroups(prev => prev.map((g, i) => i === dragIdx ? { ...g, parent_index: null } : g));
    const dropped = dragIdx;
    setDragIdx(null); setDragOver(null);
    setJustDropped(dropped);
    setTimeout(() => setJustDropped(null), 400);
  };

  // Expose save() for parent to call on close
  useImperativeHandle(ref, () => ({
    save: handleSave,
  }));

  if (loading) return <div style={{ color: '#0e7490', fontSize: 12 }}>Loading groups...</div>;

  // Build a set of all assigned user IDs — from loaded member records + pending direct role assignments
  const assignedIds = new Set([
    ...groups.flatMap(g => g.member_user_ids || []),
    ...groups.flatMap(g => (g.roles || []).filter(r => r.assigned_user_id).map(r => r.assigned_user_id)),
  ].filter(Boolean));
  const unassigned = members.filter(m => !assignedIds.has(m.user_id));

  // Determine current user's assignment status across all groups
  const myUserId = user?.id;
  const myAssignedGroup = groups.find(g => g.member_user_ids.includes(myUserId));
  const assignmentGroupName = myAssignment?.group_name || myAssignedGroup?.name;
  const assignmentStatus = myAssignment?.status || myAssignedGroup?.member_statuses?.[myUserId];
  const assignmentRole = myAssignment?.role || myAssignedGroup?.member_roles?.[myUserId] || '';
  const assignmentIsCommander = myAssignment?.is_op_commander === true;
  const isOpen = accessMode === 'open';
  const { roots, childrenMap } = buildGroupTree(groups);
  const linkColors = computeLinkColors(groups);

  return (
    <div>
      <style>{`
        @keyframes planner-node-in {
          from { opacity: 0; transform: translateX(-14px) scale(0.96); }
          to   { opacity: 1; transform: translateX(0) scale(1); }
        }
      `}</style>
      {/* Access mode badge */}
      <div style={{ marginBottom: 8 }}>
        <span style={{
          fontSize: 11, letterSpacing: '0.15em', padding: '3px 10px', borderRadius: 3,
          border: `1px solid ${isOpen ? '#0891b2' : '#ca8a04'}`,
          color: isOpen ? '#22d3ee' : '#fde047',
          background: isOpen ? '#041e2e' : '#1c1300',
        }}>
          {isOpen ? 'OPEN — anyone can join' : 'RESTRICTED — planners assign'}
        </span>
      </div>

      {/* Accept / Decline bar for restricted events (current user assigned but pending) */}
      {!isOpen && assignmentGroupName && assignmentStatus === 'pending' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 12,
          background: '#0c1a26', border: '1px solid #0891b2', borderRadius: 4,
        }}>
          <span style={{ fontSize: 12, color: '#e5e7eb', flex: 1 }}>
            You've been assigned to <strong style={{ color: '#22d3ee' }}>{assignmentGroupName}</strong>
            {assignmentRole && <span style={{ color: '#67e8f9' }}> as {assignmentRole}</span>}
            {assignmentIsCommander && <span style={{ color: '#4ade80' }}> (OP COMMANDER)</span>}
          </span>
          <button onClick={() => handleRespond(true)} style={S.btnCyan}>ACCEPT</button>
          <button onClick={() => handleRespond(false)} style={S.btnDanger}>DECLINE</button>
        </div>
      )}
      {!isOpen && assignmentGroupName && assignmentStatus === 'accepted' && (
        <div style={{ fontSize: 11, color: '#4ade80', marginBottom: 8, letterSpacing: '0.1em' }}>
          ✓ You accepted your assignment to {assignmentGroupName}
          {assignmentRole ? ` as ${assignmentRole}` : ''}
          {assignmentIsCommander ? ' (OP COMMANDER)' : ''}
        </div>
      )}
      {!isOpen && assignmentGroupName && assignmentStatus === 'declined' && (
        <div style={{ fontSize: 11, color: '#ef4444', marginBottom: 8, letterSpacing: '0.1em' }}>
          ✕ You declined your assignment to {assignmentGroupName}
        </div>
      )}

      {isOpen && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', marginBottom: 12,
          background: '#0c1a26', border: '1px solid #0891b2', borderRadius: 4,
        }}>
          <span style={{ fontSize: 12, color: '#e5e7eb', flex: 1 }}>
            Quick signup for this operation
          </span>
          <button onClick={handleQuickJoin} style={S.btnCyan}>ONE-CLICK JOIN</button>
          <button onClick={handleQuickLeave} style={S.btnDanger}>LEAVE SIGNUP</button>
        </div>
      )}

      {canEdit && !isLaunched && (
        <div style={{ marginBottom: 10, padding: '8px 12px', background: '#020c14', border: '1px solid #0e2233', borderRadius: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: '#0e7490', letterSpacing: '0.2em' }}>PRESETS</span>
            <button onClick={() => setPresetsOpen(o => !o)} style={S.btnDim}>
              {presetsOpen ? 'HIDE' : `LOAD PRESET ${presets.length > 0 ? `(${presets.length})` : ''}`}
            </button>
            <div style={{ flex: 1 }} />
            <input
              value={presetSaveName}
              onChange={e => setPresetSaveName(e.target.value)}
              placeholder="Save current as preset..."
              style={{ ...S.input, width: 180, padding: '4px 8px', fontSize: 11 }}
              maxLength={64}
            />
            <button onClick={handleSavePreset} disabled={presetSaving || !presetSaveName.trim()} style={{ ...S.btnCyan, opacity: (!presetSaveName.trim() || presetSaving) ? 0.4 : 1 }}>
              SAVE
            </button>
          </div>
          {presetsOpen && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {presets.length === 0 && <span style={{ fontSize: 11, color: '#0e7490' }}>No presets saved yet.</span>}
              {presets.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#0a131c', border: '1px solid #0e2233', borderRadius: 3, padding: '3px 8px' }}>
                  <span style={{ fontSize: 11, color: '#e5e7eb' }}>{p.name}</span>
                  <button onClick={() => applyPreset(p)} style={{ ...S.btnCyan, padding: '2px 6px', fontSize: 10 }}>LOAD</button>
                  <button onClick={() => handleDeletePreset(p.id)} style={{ ...S.btnDanger, padding: '2px 6px', fontSize: 10 }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Commander selector */}
      {canEdit && !isLaunched && (() => {
        const cmdRole = groups.flatMap((g, gi) =>
          (g.roles || []).map((r, ri) => ({ ...r, groupName: g.name, gi, ri }))
        ).find(r => r.is_commander);
        return cmdRole ? (
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#0e7490' }}>
            <span style={{ letterSpacing: '0.15em' }}>COMMANDER ROLE</span>
            <span style={{ color: '#4ade80', fontFamily: 'monospace', letterSpacing: '0.12em' }}>
              ★ {cmdRole.groupName} › {cmdRole.name}
              {cmdRole.assignment_mode === 'direct' && cmdRole.assigned_user_id && (
                <> — {members.find(m => m.user_id === cmdRole.assigned_user_id)?.callsign || '—'}</>
              )}
            </span>
          </div>
        ) : (
          <div style={{ marginBottom: 12, fontSize: 11, color: '#334155', letterSpacing: '0.12em' }}>
            ★ No commander role set — toggle ★ on a role to designate the operation commander
          </div>
        );
      })()}

      {/* ─── FREQUENCIES section ─────────────────────────────────── */}
      {(canEdit || frequencies.length > 0) && (
        <div style={{ marginBottom: 16, background: '#020c18', border: '1px solid #0e2233', borderRadius: 4, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ ...S.sectionLabel, marginBottom: 0, marginTop: 0 }}>LIAISON FREQUENCIES ({frequencies.length})</span>
            {canEdit && !isLaunched && (
              <button
                onClick={() => setFrequencies(prev => [...prev, { name: `FREQ ${String.fromCharCode(65 + prev.length)}`, role_refs: [] }])}
                style={{ ...S.btnCyan, padding: '3px 10px', fontSize: 10 }}
              >+ ADD</button>
            )}
          </div>
          {frequencies.length === 0 && (
            <div style={{ fontSize: 11, color: '#0e4a5a', fontFamily: 'monospace' }}>No frequencies defined. Add one to create a liaison channel accessible via keybind during the operation.</div>
          )}
          {frequencies.map((freq, fi) => (
            <div key={fi} style={{ background: '#041018', border: '1px solid #0e2233', borderRadius: 3, padding: '8px 10px', marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.2em', minWidth: 32 }}>#{fi + 1}</span>
                {canEdit && !isLaunched ? (
                  <input
                    value={freq.name}
                    onChange={e => setFrequencies(prev => prev.map((f, i) => i === fi ? { ...f, name: e.target.value.toUpperCase().slice(0, 32) } : f))}
                    style={{ ...S.input, width: 140, padding: '4px 8px', fontSize: 12, letterSpacing: '0.12em', color: '#f59e0b' }}
                    maxLength={32}
                  />
                ) : (
                  <span style={{ fontSize: 12, color: '#f59e0b', fontFamily: 'monospace', letterSpacing: '0.15em' }}>{freq.name}</span>
                )}
                {canEdit && !isLaunched && (
                  <button onClick={() => setFrequencies(prev => prev.filter((_, i) => i !== fi))} style={{ ...S.btnDanger, padding: '2px 8px', fontSize: 10 }}>✕</button>
                )}
              </div>

              {/* Role access list — toggle which roles grant access to this frequency */}
              <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.15em', marginBottom: 4 }}>
                AUTHORIZED ROLES
                <span style={{ color: '#0e4a5a', fontWeight: 'normal', letterSpacing: 0, marginLeft: 6 }}>
                  — personnel assigned to these roles will have access
                </span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {groups.map((g, gi) =>
                  (g.roles || []).map((r, ri) => {
                    const isOn = (freq.role_refs || []).some(ref => ref.group_index === gi && ref.role_index === ri);
                    return canEdit && !isLaunched ? (
                      <button
                        key={`${gi}-${ri}`}
                        onClick={() => setFrequencies(prev => prev.map((f, i) => {
                          if (i !== fi) return f;
                          const has = (f.role_refs || []).some(ref => ref.group_index === gi && ref.role_index === ri);
                          const refs = has
                            ? (f.role_refs || []).filter(ref => !(ref.group_index === gi && ref.role_index === ri))
                            : [...(f.role_refs || []), { group_index: gi, role_index: ri }];
                          return { ...f, role_refs: refs };
                        }))}
                        style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace',
                          letterSpacing: '0.1em',
                          background: isOn ? '#0c2a1a' : 'transparent',
                          border: `1px solid ${isOn ? '#16a34a' : '#0e2233'}`,
                          color: isOn ? '#4ade80' : '#6b7280',
                        }}
                      >
                        {g.name} › {r.name}
                      </button>
                    ) : isOn ? (
                      <span key={`${gi}-${ri}`} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, fontFamily: 'monospace', background: '#0c2a1a', border: '1px solid #16a34a', color: '#4ade80' }}>
                        {g.name} › {r.name}
                      </span>
                    ) : null;
                  })
                )}
                {groups.flatMap(g => g.roles || []).length === 0 && (
                  <span style={{ fontSize: 10, color: '#0e4a5a' }}>Define roles in groups first.</span>
                )}
              </div>
              {/* Personnel with access — derived from direct role assignments */}
              {(() => {
                const assigned = (freq.role_refs || []).flatMap(ref => {
                  const g = groups[ref.group_index];
                  const r = g?.roles?.[ref.role_index];
                  if (!r) return [];
                  if (r.assignment_mode === 'direct' && r.assigned_user_id) {
                    const cs = r.assigned_callsign ||
                      (members || []).find(m => m.user_id === r.assigned_user_id)?.callsign ||
                      r.assigned_user_id;
                    return [{ callsign: cs, via: `${g.name} › ${r.name}` }];
                  }
                  return [];
                });
                if (assigned.length === 0) return null;
                return (
                  <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                    <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.12em', flexShrink: 0 }}>PERSONNEL:</span>
                    {assigned.map((a, ai) => (
                      <span key={ai} title={`via ${a.via}`} style={{
                        fontSize: 10, padding: '1px 7px', borderRadius: 3, fontFamily: 'monospace',
                        background: '#041e2e', border: '1px solid #0891b2', color: '#22d3ee',
                        letterSpacing: '0.1em', cursor: 'default',
                      }}>
                        {a.callsign}
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      )}

      {/* Tree header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={S.sectionLabel}>GROUP TREE ({groups.length} groups)</span>
        {canEdit && !isLaunched && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {msg && <span style={{ fontSize: 11, color: msg.type === 'error' ? '#ef4444' : '#4ade80' }}>{msg.text}</span>}
            {groups.length > 0 && (
              MISSION_MAP_ENABLED ? (
                <button onClick={() => setShowMap(true)} style={{ ...S.btnDim, padding: '4px 12px', fontSize: 10 }}>MAP</button>
              ) : (
                <button disabled title="Mission map — coming soon" style={{ ...S.btnDim, padding: '4px 12px', fontSize: 10, opacity: 0.4, cursor: 'not-allowed' }}>MAP</button>
              )
            )}
            <button onClick={() => addChildGroup(null)} style={{ ...S.btnCyan, padding: '4px 12px', fontSize: 10 }}>+ ADD GROUP</button>
            <button onClick={handleSave} disabled={saving} style={{ ...S.btnCyan, opacity: saving ? 0.5 : 1 }}>
              {saving ? 'SAVING...' : 'SAVE'}
            </button>
          </div>
        )}
        {!canEdit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {msg && <span style={{ fontSize: 11, color: msg.type === 'error' ? '#ef4444' : '#4ade80' }}>{msg.text}</span>}
            {groups.length > 0 && (
              MISSION_MAP_ENABLED ? (
                <button onClick={() => setShowMap(true)} style={{ ...S.btnDim, padding: '4px 12px', fontSize: 10 }}>VIEW MAP</button>
              ) : (
                <button disabled title="Mission map — coming soon" style={{ ...S.btnDim, padding: '4px 12px', fontSize: 10, opacity: 0.4, cursor: 'not-allowed' }}>VIEW MAP</button>
              )
            )}
          </div>
        )}
      </div>

      {/* Side-by-side layout: org chart left, node editor right */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Org chart tree */}
        <div style={{ flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'visible', paddingBottom: 8,
          background: 'repeating-linear-gradient(0deg, transparent, transparent 39px, rgba(6,182,212,0.035) 40px), repeating-linear-gradient(90deg, transparent, transparent 39px, rgba(6,182,212,0.035) 40px), rgba(2,6,14,0.55)',
          borderRadius: 4, padding: 10, border: '1px solid rgba(6,182,212,0.12)' }}>
        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', minWidth: '100%', paddingBottom: 4 }}>
          {/* Make-root drop zone — appears during a drag */}
          {canEdit && !isLaunched && dragIdx !== null && (
            <div
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDragEnter={e => { e.preventDefault(); handleDragEnterZone('command'); }}
              onDragLeave={() => handleDragLeaveZone()}
              onDrop={e => { e.preventDefault(); handleDragLeaveZone(); handleDropOnCommand(); }}
              style={{
                width: '100%', marginBottom: 8, padding: '5px 14px',
                border: `2px dashed ${dragOver === 'command' ? '#22d3ee' : '#0e4a5a'}`,
                borderRadius: 4, fontSize: 9,
                color: dragOver === 'command' ? '#22d3ee' : '#0e4a5a',
                background: dragOver === 'command' ? '#020e1e' : 'transparent',
                letterSpacing: '0.15em', cursor: 'copy', transition: 'all 0.1s', textAlign: 'center',
              }}
            >
              <div style={{ pointerEvents: 'none' }}>↑ DROP HERE TO MAKE TIER 1 (ROOT)</div>
            </div>
          )}

          {/* Root-level groups */}
          {roots.length > 0 && (
            <>
              <OrgChartRow
                indices={roots}
                groups={groups}
                childrenMap={childrenMap}
                linkColors={linkColors}
                selectedIdx={selectedIdx}
                onSelect={i => setSelectedIdx(i === selectedIdx ? null : i)}
                canEdit={canEdit}
                isLaunched={isLaunched}
                onAddChild={addChildGroup}
                onRemove={i => {
                  if (selectedIdx === i) setSelectedIdx(null);
                  else if (selectedIdx !== null && selectedIdx > i) setSelectedIdx(s => s - 1);
                  removeGroup(i);
                }}
                members={members}
                myUserId={myUserId}
                isOpen={isOpen}
                handleJoinGroup={handleJoinGroup}
                handleLeaveGroup={handleLeaveGroup}
                handleLeaveRole={handleLeaveRole}
                dragIdx={dragIdx}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop}
                dragOver={dragOver}
                onDragEnterZone={handleDragEnterZone}
                onDragLeaveZone={handleDragLeaveZone}
                justDropped={justDropped}
                multiChannelUsers={computeMultiChannelUsers(groups)}
              />
            </>
          )}

          {groups.length === 0 && (
            <div style={{ fontSize: 11, color: '#0e7490', marginTop: 10, letterSpacing: '0.1em' }}>
              {canEdit ? 'Click + ADD GROUP to begin building the group tree.' : 'No groups configured.'}
            </div>
          )}
        </div>
        </div>

        {/* Node editor — right column, scrollable */}
        {selectedIdx !== null && groups[selectedIdx] && (
          <div style={{ width: 360, flexShrink: 0, maxHeight: '60vh', overflowY: 'auto', borderLeft: '1px solid #0e2233', paddingLeft: 16 }}>
            <NodeEditorPanel
              idx={selectedIdx}
              groups={groups}
              members={members}
              updateGroup={updateGroup}
              setGroups={setGroups}
              linkColors={linkColors}
              accessMode={accessMode}
              game={game}
              frequencies={frequencies}
              setFrequencies={setFrequencies}
              canEdit={canEdit && !isLaunched}
              isLaunched={isLaunched}
              myUserId={myUserId}
              handleJoinRole={handleJoinRole}
              handleLeaveRole={handleLeaveRole}
              handleApproveJoin={handleApproveJoin}
              handleApproveAllPending={handleApproveAllPending}
              handleRemoveMember={handleRemoveMember}
              getGroupDps={getGroupDps}
              getClaimableShips={getClaimableShips}
              claimShipSlot={claimShipSlot}
              releaseShipSlot={releaseShipSlot}
            />
          </div>
        )}
      </div>

      {/* Unassigned members */}
      {canEdit && unassigned.length > 0 && groups.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <span style={{ ...S.sectionLabel, marginTop: 0 }}>UNASSIGNED ({unassigned.length})</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {unassigned.map(m => (
              <span key={m.user_id} style={{ fontSize: 11, color: '#9ca3af', padding: '2px 6px', background: '#0a131c', borderRadius: 3, fontFamily: 'monospace' }}>
                {m.callsign}
              </span>
            ))}
          </div>
        </div>
      )}

      {shipConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ background: '#040d15', border: '1px solid #0891b2', borderRadius: 6, padding: 20, maxWidth: 380, fontFamily: 'monospace' }}>
            <div style={{ fontSize: 13, color: '#e5e7eb', marginBottom: 10 }}>
              Joining with your <span style={{ color: '#22d3ee' }}>{shipConfirm.shipName}</span> will also reserve {shipConfirm.seatLabels.length} locked seat{shipConfirm.seatLabels.length === 1 ? '' : 's'}:
            </div>
            <div style={{ fontSize: 11, color: '#0e7490', marginBottom: 16 }}>{shipConfirm.seatLabels.join(', ')}</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => confirmShipJoin(false)} style={S.btnDim}>JOIN WITHOUT SHIP</button>
              <button onClick={() => confirmShipJoin(true)} style={S.btnCyan}>CONFIRM</button>
            </div>
          </div>
        </div>
      )}

      {showMap && (
        <MissionMap
          orgId={orgId}
          eventId={eventId}
          groups={groups}
          canEdit={canEdit && !isLaunched}
          onClose={() => setShowMap(false)}
        />
      )}
    </div>
  );
});

// ── Channel Tree (post-launch visualization) ───────────────────────────────
function ChannelTree({ orgId, eventId }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await api.getEventChannelTree(orgId, eventId);
      setChannels(data?.channels || []);
      setLoading(false);
    })();
  }, [orgId, eventId]);

  if (loading) return <div style={{ color: '#0e7490', fontSize: 12, marginTop: 16 }}>Loading channel tree...</div>;
  if (channels.length === 0) return null;

  // Build child map
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

  const renderNode = (ch, depth = 0) => (
    <div key={ch.id}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px',
        marginLeft: depth * 20, fontSize: 11, color: ch.is_command ? '#22d3ee' : '#e5e7eb',
        fontFamily: 'monospace',
      }}>
        {depth > 0 && <span style={{ color: '#0891b2' }}>└─</span>}
        <span style={{
          padding: '2px 6px', borderRadius: 3,
          background: ch.is_command ? '#041e2e' : '#0a131c',
          border: `1px solid ${ch.is_command ? '#0891b2' : '#0e2233'}`,
        }}>
          {ch.is_command ? '📡' : '🔊'} {ch.name}
        </span>
        <span style={{ fontSize: 10, color: '#0e7490' }}>T{ch.tier}</span>
        {ch.leader_callsign && (
          <span style={{ fontSize: 10, color: '#067a8a' }}>Lead: {ch.leader_callsign}</span>
        )}
      </div>
      {(childMap[ch.id] || []).map(child => renderNode(child, depth + 1))}
    </div>
  );

  return (
    <div style={{ marginTop: 16 }}>
      <div style={S.sectionLabel}>CHANNEL HIERARCHY</div>
      <div style={{ ...S.groupCard, padding: 8 }}>
        {roots.map(ch => renderNode(ch))}
      </div>
    </div>
  );
}

// ── Main OperationPlanner ───────────────────────────────────────────────────
export default function OperationPlanner({ org, event: eventProp, members, user, onClose, onRefreshEvents }) {
  const [view, setView] = useState(eventProp ? 'detail' : 'create');
  const [editing, setEditing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [editors, setEditors] = useState([]);
  const groupPlannerRef = useRef(null);
  // Local copy of the event so that, once creation succeeds below, this same
  // modal instance can switch straight into the group/tier planner for the
  // event it just created, instead of closing the whole modal and forcing a
  // close-and-reopen before groups/tiers could be set up. Kept in sync with
  // the prop for the normal case (parent passes a different/updated event
  // into an already-mounted instance).
  const [event, setEvent] = useState(eventProp);
  useEffect(() => { setEvent(eventProp); }, [eventProp]);

  // Determine if current user can edit this event
  const isCreator = event?.creator_id === user?.id;
  const isPlanner = (event?.planners || []).some(p => p.user_id === user?.id);
  const isOwner = org?.owner_id === user?.id;
  const canEdit = isOwner || isCreator || isPlanner;

  // ── Presence heartbeat ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!event?.id) return;
    api.pingPresence(org.id, event.id).then(({ data }) => {
      if (data?.editors) setEditors(data.editors);
    });
    if (!canEdit) return;
    const interval = setInterval(() => api.pingPresence(org.id, event.id), 25_000);
    return () => {
      clearInterval(interval);
      api.clearPresence(org.id, event.id);
    };
  }, [event?.id, org?.id, canEdit]);

  // ── Real-time presence via SSE ─────────────────────────────────────────────
  useEventStream({
    planner_presence: (p) => {
      if (p.event_id === event?.id) setEditors(p.editors || []);
    },
    // Roster changed elsewhere (self-signup, approval, leave, another planner's
    // save) — refetch so this view doesn't go stale until a manual reload.
    event_roster_changed: (p) => {
      if (p.event_id === event?.id) load();
    },
  });

  const handleClose = async () => {
    if (view === 'detail' && canEdit && !event?.launched && groupPlannerRef.current) {
      await groupPlannerRef.current.save();
    }
    onClose();
  };

  const handleDelete = async () => {
    if (!confirm(`Delete operation "${event.name}"?`)) return;
    await api.deleteOrgEvent(org.id, event.id);
    onRefreshEvents?.();
    handleClose();
  };

  const handleLaunch = async () => {
    if (!event?.id || event?.launched) return;
    setLaunching(true);
    const { error } = await api.launchEvent(org.id, event.id);
    setLaunching(false);
    if (!error) onRefreshEvents?.();
  };

  const otherEditors = editors.filter(e => e.userId !== user?.id);

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full bg-specter-bg-surface font-mono">
      <div className="flex items-center justify-between px-6 py-4 border-b border-specter-primary-dim/40 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={handleClose} className="px-4 py-1.5 text-xs font-mono uppercase tracking-wider border border-specter-primary-dim rounded text-specter-text-muted hover:text-specter-text-main flex-shrink-0">
            ← Back
          </button>
          <span className="text-specter-primary-cyan uppercase tracking-widest text-sm truncate">
            {view === 'create' ? '+ New Operation' : `⚔ ${event?.name?.toUpperCase()}`}
          </span>
        </div>
        {view === 'detail' && canEdit && !event?.launched && (
          <button
            onClick={() => groupPlannerRef.current?.save()}
            style={{ ...S.btnCyan, padding: '4px 14px', fontSize: 10 }}
          >SAVE</button>
        )}
      </div>

      {otherEditors.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '6px 14px', background: '#010d18', borderBottom: '1px solid #0e2233',
            fontSize: 11, color: '#0e7490',
          }}>
            <span style={{ letterSpacing: '0.15em' }}>EDITING NOW:</span>
            {otherEditors.map(e => (
              <span key={e.userId} style={{
                color: '#22d3ee', background: '#041e2e', border: '1px solid #0891b2',
                borderRadius: 3, padding: '1px 7px', fontFamily: 'monospace',
              }}>
                {e.callsign}
              </span>
            ))}
          </div>
        )}

        <div style={S.body}>
          {view === 'create' && (
            <EventForm
              orgId={org.id}
              members={members}
              onSaved={(newEvent) => {
                onRefreshEvents?.();
                // Go straight into the group/tier planner for the event just
                // created instead of closing — no close-and-reopen required.
                setEvent(newEvent);
                setView('detail');
              }}
              onCancel={onClose}
            />
          )}

          {view === 'detail' && event && !editing && (
            <>
              {/* Event info */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#e5e7eb', fontWeight: 'bold' }}>{event.name}</div>
                    <div style={{ fontSize: 11, color: '#0891b2', marginTop: 2 }}>
                      {new Date(event.start_time).toLocaleString()}
                      {event.end_time && <> — {new Date(event.end_time).toLocaleString()}</>}
                    </div>
                  </div>
                  <div style={{ flex: 1 }} />
                  {event.launched && (
                    <span style={{ fontSize: 11, color: '#22c55e', border: '1px solid #16a34a', padding: '3px 10px', borderRadius: 3, letterSpacing: '0.15em' }}>
                      LAUNCHED
                    </span>
                  )}
                </div>

                {/* Planners list */}
                {(event.planners || []).length > 0 && (
                  <div style={{ marginBottom: 8, fontSize: 11, color: '#0e7490' }}>
                    Planners: {event.planners.map(p => (
                      <span key={p.user_id} style={{ color: '#67e8f9', marginRight: 6 }}>{p.callsign}</span>
                    ))}
                  </div>
                )}

                {/* Meetup location */}
                {event.meetup_location && (
                  <div style={{ marginBottom: 8, fontSize: 11, color: '#0e7490' }}>
                    <span style={{ letterSpacing: '0.15em' }}>MEETUP: </span>
                    <span style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>{event.meetup_location}</span>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  {canEdit && !event.launched && (
                    <button onClick={handleLaunch} disabled={launching} style={{ ...S.btnLaunch, padding: '6px 14px', opacity: launching ? 0.6 : 1 }}>
                      {launching ? 'LAUNCHING...' : 'LAUNCH'}
                    </button>
                  )}
                  {canEdit && !event.launched && (
                    <button onClick={() => setEditing(true)} style={S.btnCyan}>EDIT</button>
                  )}
                  {canEdit && <button onClick={handleDelete} style={S.btnDanger}>DELETE</button>}
                </div>
              </div>

              {/* Group planner */}
              <GroupPlanner
                ref={groupPlannerRef}
                orgId={org.id}
                eventId={event.id}
                members={members}
                isLaunched={!!event.launched}
                canEdit={canEdit}
                user={user}
                accessMode={event.access_mode || 'open'}
                game={event.game || 'none'}
              />

              {/* Channel tree (post-launch) */}
              {event.launched && (
                <ChannelTree orgId={org.id} eventId={event.id} />
              )}
            </>
          )}

          {view === 'detail' && event && editing && (
            <EventForm
              orgId={org.id}
              event={event}
              members={members}
              onSaved={() => { setEditing(false); onRefreshEvents?.(); }}
              onCancel={() => setEditing(false)}
            />
          )}
        </div>
    </div>
  );
}
