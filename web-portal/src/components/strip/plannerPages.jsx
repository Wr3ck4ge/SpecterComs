// Pages of the strip's wide op planner (OpPlanner.jsx): Details, Groups,
// Roles, Ships, Comms, Map and Review. Data operations are the full
// planner's, shared through utils/eventGroups (pure) and utils/plannerHooks
// (ship search / crew roles); the plan itself is useOpPlan's.
import { lazy, Suspense, useState } from 'react';
import { ArrowUp, Crown, Link2, Plane, Plus, Radio, Search, Star, Trash2, X } from 'lucide-react';
import { Alert, Button, IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { GAME_OPTIONS } from '../../gameOptions';
import {
  addFrequencyRole, buildGroupTree, computeDepth, describeFrequency, frequencyHasRole, newGroup, newRole, nextGroupName,
  removeFrequencyRole, removeGroupAt, renameFrequency, reparentGroup, shipRoleToGroupRole, toggleFrequencyRole, wouldCreateCycle,
  // LEADFREQ
  assignAllLeaderRoles, assignLeadershipDefault, ensureLeadershipFrequency, isLeadershipRoleName, leadershipFrequencyIndex,
  removeRoleFromFrequencies, toggleLeadershipRole,
} from '../../utils/eventGroups';
import { addShipToComposition, useShipCrewRoles, useShipSearch } from '../../utils/plannerHooks';
import StripGroupTree from './StripGroupTree';
import { Chip, Field, SectionLabel, Segmented, ShipBadge, Stepper } from './stripOpsUi';
import { inputClass, DURATIONS, PLANNER_MAP_ENABLED, toLocalInput } from './stripOpsLayout';

// EVT2: gated by PLANNER_MAP_ENABLED (stripOpsLayout) — while it's false the
// build drops the dynamic import below, so the strip bundle doesn't even
// reference the map chunk.
// The mission map pulls in three.js — loaded only when its page opens, so
// the strip's own bundle doesn't carry it.
const MissionMap = PLANNER_MAP_ENABLED ? lazy(() => import('../MissionMap')) : null;

// OPGROW: pages are laid out at their natural height (the op panel grows to
// fit them); scrolling parts cap themselves at the page body's maximum
// height, which OpPlanner sets as --op-body-max from the panel's max size.
const BODY_MAX = 'var(--op-body-max, 600px)';
const BODY_MAX_TREE = 'calc(var(--op-body-max, 600px) - 44px)'; // minus the hint under the tree

const ROLE_TEMPLATES =['Lead', 'Pilot', 'Gunner', 'Medic', 'Engineer', 'Scout'];
const PRIORITY_LABELS = ['', 'Low', 'Med-low', 'Medium', 'High', 'Critical'];
const gameLabel = (l) => l.charAt(0) + l.slice(1).toLowerCase().replace(/ (\w)/g, (_, c) => ` ${c.toUpperCase()}`);

function quickStart(kind) {
  const d = new Date();
  if (kind === 'hour') { d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); }
  if (kind === 'tonight') { d.setHours(20, 0, 0, 0); }
  if (kind === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(20, 0, 0, 0); }
  return toLocalInput(d.toISOString());
}

// ── Details ───────────────────────────────────────────────────────────────
export function DetailsPage({ form, setForm, members }) {
  const [query, setQuery] = useState('');
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const picked = members.filter((m) => form.plannerIds.includes(m.user_id));
  const q = query.trim().toLowerCase();
  const suggestions = q
    ? members.filter((m) => !form.plannerIds.includes(m.user_id) && (m.callsign || '').toLowerCase().includes(q)).slice(0, 8)
    : [];
  const quick = [['now', 'Now'], ['hour', 'Next hour'], ['tonight', 'Tonight 20:00'], ['tomorrow', 'Tomorrow 20:00']];

  return (
    <div className="mx-auto max-w-[920px] grid gap-x-8 gap-y-4 md:grid-cols-2">
      <div className="space-y-4">
        <Field label="Name">
          <input className={inputClass} value={form.name} maxLength={64} placeholder="Operation Thunderstrike"
            onChange={(e) => set({ name: e.target.value })} autoFocus />
        </Field>
        <div className="space-y-1.5">
          <SectionLabel>Starts</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {quick.map(([k, l]) => (
              <Chip key={k} selected={k === 'now' ? form.startNow : !form.startNow && form.startTime === quickStart(k)}
                onClick={() => (k === 'now' ? set({ startNow: true }) : set({ startNow: false, startTime: quickStart(k) }))}>
                {l}
              </Chip>
            ))}
          </div>
          {!form.startNow && (
            <input type="datetime-local" aria-label="Start time" className={inputClass} value={form.startTime}
              onChange={(e) => set({ startTime: e.target.value })} />
          )}
        </div>
        <div className="space-y-1.5">
          <SectionLabel>Runs for</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {DURATIONS.map((h) => (
              <Chip key={h} selected={form.duration === h} onClick={() => set({ duration: h })}>{h === 0 ? 'Open-ended' : `${h} h`}</Chip>
            ))}
            <Chip selected={form.duration === 'custom'} onClick={() => set({ duration: 'custom' })}>Until…</Chip>
          </div>
          {form.duration === 'custom' && (
            <input type="datetime-local" aria-label="End time" className={inputClass} value={form.customEnd}
              onChange={(e) => set({ customEnd: e.target.value })} />
          )}
        </div>
        <Field label="Meetup (optional)">
          <input className={inputClass} value={form.meetup} maxLength={500} placeholder="Staging Area Bravo"
            onChange={(e) => set({ meetup: e.target.value })} />
        </Field>
      </div>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <SectionLabel>Who can join</SectionLabel>
          <Segmented label="Access" value={form.accessMode} onChange={(v) => set({ accessMode: v })}
            options={[{ value: 'open', label: 'Anyone' }, { value: 'restricted', label: 'Planners assign' }]} />
        </div>
        <div className="space-y-1.5">
          <SectionLabel>Game</SectionLabel>
          <Segmented label="Game" value={form.game} onChange={(v) => set({ game: v })}
            options={GAME_OPTIONS.map((g) => ({ value: g.v, label: gameLabel(g.l) }))} />
          <p className="text-ui-xs text-specter-text-subtle">Star Citizen ops can plan ship compositions.</p>
        </div>
        <div className="space-y-1.5">
          <SectionLabel>Co-planners <span className="font-normal">· can edit the op and assign roles</span></SectionLabel>
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {picked.map((m) => (
                <Chip key={m.user_id} selected onClick={() => set({ plannerIds: form.plannerIds.filter((id) => id !== m.user_id) })}
                  title={`Remove ${m.callsign}`}>
                  {m.callsign} <X size={11} aria-hidden="true" />
                </Chip>
              ))}
            </div>
          )}
          <input className={inputClass} value={query} placeholder={members.length ? 'Add by callsign…' : 'Loading members…'}
            aria-label="Find a co-planner" onChange={(e) => setQuery(e.target.value)} />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((m) => (
                <Chip key={m.user_id} onClick={() => { set({ plannerIds: [...form.plannerIds, m.user_id] }); setQuery(''); }}>
                  <Plus size={11} aria-hidden="true" /> {m.callsign}
                </Chip>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Group list column (Roles / Ships) ─────────────────────────────────────
function GroupColumn({ groups, selectedIdx, onSelect, count, label = 'Groups' }) {
  return (
    <nav aria-label={label} className="strip-scroll min-h-0 flex flex-col gap-1 pr-1" style={{ maxHeight: BODY_MAX }}>
      {groups.map((g, i) => {
        const tier = computeDepth(i, groups);
        return (
          <button key={i} type="button" onClick={() => onSelect(i)} aria-current={i === selectedIdx || undefined}
            className={cx('flex items-center gap-2 px-2.5 py-2 rounded-ui-row text-left transition-colors', focusRing,
              i === selectedIdx ? 'bg-specter-primary-cyan/15 text-specter-text-main' : 'text-specter-text-muted hover:bg-white/5 hover:text-specter-text-main')}
            style={{ paddingLeft: 10 + Math.min(4, tier - 1) * 10 }}>
            <span className="flex-1 min-w-0 truncate text-ui-sm font-medium">{g.name || 'Unnamed'}</span>
            <span className="shrink-0 text-ui-xs tabular-nums text-specter-text-subtle">{count(g)}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ── Groups ────────────────────────────────────────────────────────────────
export function GroupsPage({ groups, setGroups, selectedIdx, setSelectedIdx, linkColors }) {
  const g = selectedIdx !== null ? groups[selectedIdx] : null;
  const update = (patch) => setGroups((prev) => prev.map((x, i) => (i === selectedIdx ? { ...x, ...patch } : x)));
  const addChild = () => {
    const idx = groups.length;
    setGroups((prev) => [...prev, newGroup(nextGroupName(prev), selectedIdx)]);
    setSelectedIdx(idx);
  };
  const addTop = () => {
    const idx = groups.length;
    setGroups((prev) => [...prev, newGroup(prev.length ? nextGroupName(prev) : 'Command')]);
    setSelectedIdx(idx);
  };
  const remove = () => {
    setGroups((prev) => removeGroupAt(prev, selectedIdx));
    setSelectedIdx(groups.length > 1 ? 0 : null);
  };

  if (!groups.length) {
    return (
      <div className="py-10 flex flex-col items-center justify-center gap-3 text-center">
        <p className="text-ui-base text-specter-text-muted">Start with the group that runs the op.</p>
        <Button icon={<Plus size={15} />} onClick={addTop}>Add command group</Button>
        <p className="text-ui-xs text-specter-text-subtle">Or load a preset from the bar below.</p>
      </div>
    );
  }
  const parentOptions = groups
    .map((x, i) => ({ i, name: x.name }))
    .filter(({ i }) => g && i !== selectedIdx && !wouldCreateCycle(i, selectedIdx, groups));
  const tier = g ? computeDepth(selectedIdx, groups) : null;
  const kids = g ? (buildGroupTree(groups).childrenMap[selectedIdx] || []).length : 0;
  const linked = g && g.linked_index !== null && g.linked_index !== undefined ? groups[g.linked_index] : null;

  return (
    <div className="grid gap-4 grid-cols-[minmax(0,1fr)_300px] items-start">
      <div className="min-h-0 flex flex-col gap-1.5">
        <div className="min-h-0 flex-1">
          <StripGroupTree variant="wide" maxHeight={BODY_MAX_TREE} groups={groups} selectedIdx={selectedIdx} onSelect={setSelectedIdx}
            linkColors={linkColors} onReparent={(idx, parent) => setGroups((prev) => reparentGroup(prev, idx, parent))} />
        </div>
        <p className="text-ui-xs text-specter-text-subtle">
          The top tier sits at the bottom; groups that report to it stack above. Drag a group onto another to move it under that group.
        </p>
      </div>
      <aside className="strip-scroll min-h-0" style={{ maxHeight: BODY_MAX }} aria-label="Selected group">
        {g ? (
          <div className="p-3 rounded-ui-md border border-specter-border bg-white/[0.03] space-y-3">
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <Field label={`Tier ${tier} group`}>
                  <input className={inputClass} value={g.name} maxLength={64} onChange={(e) => update({ name: e.target.value })} />
                </Field>
              </div>
              <IconButton variant="danger" icon={<Trash2 size={15} />} label={`Remove ${g.name}`} onClick={remove} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>Size limit</SectionLabel>
              <Stepper label="members" value={g.max_members || 0} min={0} max={99}
                format={(n) => (n === 0 ? '∞' : n)} onChange={(n) => update({ max_members: n })} />
            </div>
            <div className="space-y-1.5">
              <SectionLabel>Reports to</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                <Chip selected={g.parent_index === null || g.parent_index === undefined} onClick={() => update({ parent_index: null })}>Nobody (top tier)</Chip>
                {parentOptions.map(({ i, name }) => (
                  <Chip key={i} selected={g.parent_index === i} onClick={() => update({ parent_index: i })}>{name}</Chip>
                ))}
              </div>
            </div>
            <p className="flex items-center gap-1.5 text-ui-xs text-specter-text-subtle">
              <Link2 size={12} aria-hidden="true" />
              {linked ? <>Linked with <span className="font-semibold" style={{ color: linkColors[selectedIdx] }}>{linked.name}</span></> : 'Not linked — link it from the bar below.'}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="secondary" icon={<ArrowUp size={14} />} onClick={addChild}>
                Add group under {g.name.length > 14 ? 'this' : g.name}
              </Button>
            </div>
            {kids > 0 && <p className="text-ui-xs text-specter-text-subtle">{kids} group{kids > 1 ? 's' : ''} report{kids > 1 ? '' : 's'} to {g.name}.</p>}
          </div>
        ) : (
          <p className="text-ui-sm text-specter-text-subtle">Select a group in the tree to edit it.</p>
        )}
      </aside>
    </div>
  );
}

// ── Roles ─────────────────────────────────────────────────────────────────
function RoleCard({ role, gi, ri, onChange, onRemove, onCommander, members, frequencies, setFrequencies }) {
  const set = (patch) => onChange({ ...role, ...patch });
  const open = (role.assignment_mode || 'open') === 'open';
  // LEADFREQ
  const leadIdx = leadershipFrequencyIndex(frequencies);
  const onLeadership = leadIdx >= 0 && frequencyHasRole(frequencies[leadIdx], gi, ri);
  const otherFreqs = frequencies.map((f, fi) => ({ f, fi })).filter(({ fi }) => fi !== leadIdx);
  return (
    <li className={cx('p-3 rounded-ui-md border bg-specter-bg-deep/50 space-y-2.5', role.is_commander ? 'border-specter-state-success/50' : 'border-specter-border-divider')}>
      <div className="flex items-center gap-2">
        <input className={inputClass} value={role.name} maxLength={64} placeholder="Role name" aria-label="Role name"
          onChange={(e) => set({ name: e.target.value })} />
        <IconButton variant="danger" size="sm" icon={<Trash2 size={14} />} label="Remove role" onClick={onRemove} />
      </div>
      {Array.isArray(role.seat_labels) && role.seat_labels.length > 0 && (
        <p className="text-ui-xs text-specter-text-subtle">
          Seats: {role.seat_labels.join(', ')}{role.seat_labels.length > 1 && <span className="text-emerald-300"> · joiners pick a seat</span>}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Priority</SectionLabel>
        <div className="flex gap-1" role="radiogroup" aria-label="Priority">
          {[1, 2, 3, 4, 5].map((p) => (
            <Chip key={p} selected={role.priority === p} tone={p >= 4 ? 'amber' : 'cyan'} onClick={() => set({ priority: p })}
              title={PRIORITY_LABELS[p]} className="!px-2">{p}</Chip>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Filled by</SectionLabel>
        <Segmented label="Assignment" value={role.assignment_mode || 'open'} onChange={(v) => set({ assignment_mode: v })}
          options={[{ value: 'open', label: 'Sign-up' }, { value: 'direct', label: 'Assigned' }]} />
      </div>
      {open ? (
        <div className="flex items-center justify-between gap-2">
          <Stepper label="slots" value={role.max_slots || 1} min={1} max={99} onChange={(n) => set({ max_slots: n })} />
          <Chip selected tone={role.auto_approve !== false ? 'green' : 'amber'} onClick={() => set({ auto_approve: role.auto_approve === false })}>
            {role.auto_approve !== false ? 'Auto-approve' : 'Needs approval'}
          </Chip>
        </div>
      ) : (
        <select className={inputClass} aria-label="Assign to" value={role.assigned_user_id || ''}
          onChange={(e) => set({ assigned_user_id: e.target.value })}>
          <option value="">Pick a member…</option>
          {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.callsign}</option>)}
        </select>
      )}
      {/* LEADFREQ: the Leadership net gets its own toggle, ahead of the other frequencies. */}
      {leadIdx >= 0 && (
        <div className="flex items-center justify-between gap-2">
          <SectionLabel>Leadership net</SectionLabel>
          <Chip tone="amber" selected={onLeadership}
            title={onLeadership ? 'This role talks on the Leadership frequency during the op' : 'Give this role the Leadership frequency'}
            onClick={() => setFrequencies((prev) => toggleLeadershipRole(prev, gi, ri))}>
            <Crown size={11} aria-hidden="true" /> {onLeadership ? 'On Leadership' : 'Add to Leadership'}
          </Chip>
        </div>
      )}
      {otherFreqs.length > 0 && (
        <div className="space-y-1">
          <SectionLabel>Frequencies</SectionLabel>
          <div className="flex flex-wrap gap-1">
            {otherFreqs.map(({ f, fi }) => (
              <Chip key={fi} tone="green" selected={frequencyHasRole(f, gi, ri)} onClick={() => setFrequencies((prev) => toggleFrequencyRole(prev, fi, gi, ri))}>
                <Radio size={11} aria-hidden="true" /> {f.name}
              </Chip>
            ))}
          </div>
        </div>
      )}
      <Chip selected={!!role.is_commander} tone="green" onClick={onCommander}>
        <Star size={12} aria-hidden="true" /> {role.is_commander ? 'Op commander' : 'Make op commander'}
      </Chip>
    </li>
  );
}

export function RolesPage({ groups, setGroups, selectedIdx, setSelectedIdx, members, frequencies, setFrequencies }) {
  if (!groups.length) return <p className="text-ui-sm text-specter-text-subtle">Add a group first.</p>;
  const gi = selectedIdx ?? 0;
  const g = groups[gi];
  const roles = g?.roles || [];
  const setRoles = (fn) => setGroups((prev) => prev.map((x, i) => (i === gi ? { ...x, roles: fn(x.roles || []) } : x)));
  // One commander role across the whole op (same as the full planner).
  const toggleCommander = (ri) => {
    const turningOn = !roles[ri]?.is_commander;
    setGroups((prev) => prev.map((x, i) => ({
      ...x,
      roles: (x.roles || []).map((r, j) => ({ ...r, is_commander: turningOn && i === gi && j === ri })),
    })));
  };

  return (
    <div className="grid gap-4 grid-cols-[220px_minmax(0,1fr)] items-start">
      <GroupColumn groups={groups} selectedIdx={gi} onSelect={setSelectedIdx} count={(x) => (x.roles || []).length} />
      <div className="strip-scroll min-h-0 space-y-3 pr-1" style={{ maxHeight: BODY_MAX }}>
        <div className="flex items-center gap-2">
          <h3 className="flex-1 min-w-0 truncate text-ui-lg font-semibold">{g.name} <span className="text-ui-sm font-normal text-specter-text-subtle">· {roles.length} role{roles.length === 1 ? '' : 's'}</span></h3>
        </div>
        {roles.length === 0 && <p className="text-ui-sm text-specter-text-subtle">No roles in {g.name} yet. Pick one to add:</p>}
        <ul className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
          {roles.map((r, ri) => (
            <RoleCard key={ri} role={r} gi={gi} ri={ri} members={members} frequencies={frequencies} setFrequencies={setFrequencies}
              onChange={(next) => setRoles((rs) => rs.map((x, j) => (j === ri ? next : x)))}
              onRemove={() => {
                setRoles((rs) => rs.filter((_, j) => j !== ri));
                // LEADFREQ: keep index-based frequency refs on the same roles.
                setFrequencies((prev) => removeRoleFromFrequencies(prev, gi, ri));
              }}
              onCommander={() => toggleCommander(ri)} />
          ))}
        </ul>
        <div className="flex flex-wrap gap-1.5">
          {ROLE_TEMPLATES.map((t) => (
            <Chip key={t} onClick={() => {
              setRoles((rs) => [...rs, newRole(t)]);
              // LEADFREQ: leader templates (Lead, …) start on the Leadership net.
              setFrequencies((prev) => assignLeadershipDefault(prev, gi, roles.length, t));
            }}><Plus size={11} aria-hidden="true" /> {t}</Chip>
          ))}
          <Chip onClick={() => setRoles((rs) => [...rs, newRole('')])}><Plus size={11} aria-hidden="true" /> Custom</Chip>
        </div>
      </div>
    </div>
  );
}

// ── Ships ─────────────────────────────────────────────────────────────────
function ShipComposer({ group, idx, setGroups }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const { results, searching } = useShipSearch(open, query);
  const composition = group.ships || [];
  const setComposition = (ships) => setGroups((prev) => prev.map((gp, gi) => (gi !== idx ? gp : { ...gp, ships })));

  // Crew roles from the ships auto-fill an empty role list (as the full
  // planner does); otherwise they can be imported explicitly.
  const shipRoles = useShipCrewRoles(composition, (roles) => {
    if (roles.length > 0 && (group.roles || []).length === 0) {
      setGroups((prev) => prev.map((gp, gi) => (gi !== idx ? gp : { ...gp, roles: roles.map(shipRoleToGroupRole) })));
      setNote(`Added ${roles.length} crew role${roles.length === 1 ? '' : 's'} from the ships`);
    }
  });
  const addShip = async (ship) => {
    setOpen(false);
    setQuery('');
    setQty(1);
    setComposition(await addShipToComposition(composition, ship, qty));
  };
  const importRoles = () => {
    setGroups((prev) => prev.map((gp, gi) => (gi !== idx ? gp : { ...gp, roles: [...(gp.roles || []), ...shipRoles.map(shipRoleToGroupRole)] })));
    setNote(`Imported ${shipRoles.length} crew role${shipRoles.length === 1 ? '' : 's'}`);
  };

  return (
    <div className="space-y-3">
      {composition.length === 0 && <p className="text-ui-sm text-specter-text-subtle">No ships yet. A group can be one ship, a wing of several, or a mixed fleet.</p>}
      <ul className="space-y-1.5">
        {composition.map((c, i) => (
          <li key={c.ship_slug} className="flex items-center gap-2.5 px-2.5 py-2 rounded-ui-md border border-specter-border-divider bg-specter-bg-deep/50">
            <ShipBadge name={c.ship_name} url={c.ship_icon_url} size={28} />
            <span className="flex-1 min-w-0 truncate text-ui-sm text-specter-text-main">{c.ship_name}</span>
            <Stepper label={`${c.ship_name} count`} value={c.quantity || 1} min={1} max={99}
              onChange={(n) => setComposition(composition.map((x, j) => (j === i ? { ...x, quantity: n } : x)))} />
            <IconButton size="sm" variant="danger" icon={<X size={14} />} label={`Remove ${c.ship_name}`}
              onClick={() => setComposition(composition.filter((_, j) => j !== i))} />
          </li>
        ))}
      </ul>
      {open ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={14} aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-specter-text-subtle" />
              <input autoFocus className={cx(inputClass, 'pl-8')} value={query} placeholder="Search ships…" aria-label="Search ships"
                onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} />
            </div>
            <Stepper label="ships to add" value={qty} min={1} max={20} onChange={setQty} />
            <IconButton size="sm" icon={<X size={14} />} label="Stop adding" onClick={() => setOpen(false)} />
          </div>
          <div className="max-h-[220px] strip-scroll rounded-ui-md border border-specter-border-divider">
            {searching && <p className="px-3 py-2 text-ui-sm text-specter-text-subtle">Searching…</p>}
            {!searching && results.length === 0 && <p className="px-3 py-2 text-ui-sm text-specter-text-subtle">No ships found.</p>}
            {!searching && results.map((ship) => (
              <button key={ship.slug} type="button" onClick={() => addShip(ship)}
                className={cx('w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5', focusRing)}>
                <ShipBadge name={ship.name} url={ship.icon_url} code={ship.manufacturer_code} size={22} />
                <span className="text-ui-sm text-specter-text-main">{ship.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => setOpen(true)}>Add ship</Button>
      )}
      {note && <p className="text-ui-xs text-emerald-300" role="status">{note}</p>}
      {shipRoles.length > 0 && (
        <div className="p-2.5 rounded-ui-md border border-specter-border-divider space-y-2">
          <SectionLabel>Crew these ships need</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {shipRoles.map((r) => <span key={r.display_name} className="px-2 py-0.5 rounded-pill bg-white/5 text-ui-xs text-specter-text-muted">{r.display_name} ×{r.count}</span>)}
          </div>
          {(group.roles || []).length > 0 && (
            <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={importRoles}>Import as roles</Button>
          )}
        </div>
      )}
      <p className="text-ui-xs text-specter-text-subtle">
        Members claim ship slots with a matching hangar ship from the op view; claiming a hull unlocks its crew seats.
      </p>
    </div>
  );
}

export function ShipsPage({ game, groups, setGroups, selectedIdx, setSelectedIdx }) {
  if (game !== 'star_citizen') {
    return (
      <div className="py-10 flex flex-col items-center justify-center gap-2 text-center">
        <Plane size={28} aria-hidden="true" className="text-specter-text-subtle" />
        <p className="text-ui-base text-specter-text-muted">Ship composition is for Star Citizen operations.</p>
        <p className="text-ui-sm text-specter-text-subtle">Set the game in Details to plan ships.</p>
      </div>
    );
  }
  if (!groups.length) return <p className="text-ui-sm text-specter-text-subtle">Add a group first.</p>;
  const gi = selectedIdx ?? 0;
  const g = groups[gi];
  return (
    <div className="grid gap-4 grid-cols-[220px_minmax(0,1fr)] items-start">
      <GroupColumn groups={groups} selectedIdx={gi} onSelect={setSelectedIdx} label="Groups"
        count={(x) => (x.ships || []).reduce((n, s) => n + (s.quantity || 1), 0) || ''} />
      <div className="strip-scroll min-h-0 pr-1 space-y-3" style={{ maxHeight: BODY_MAX }}>
        <h3 className="text-ui-lg font-semibold">{g.name} <span className="text-ui-sm font-normal text-specter-text-subtle">· ships</span></h3>
        <div className="max-w-[640px]">
          <ShipComposer key={gi} group={g} idx={gi} setGroups={setGroups} />
        </div>
      </div>
    </div>
  );
}

// ── Comms (frequencies) ───────────────────────────────────────────────────
export function CommsPage({ groups, frequencies, setFrequencies, members }) {
  // LEADFREQ: new events come with a Leadership net (server-seeded). An older
  // event without one is offered it here — never added silently.
  const leadIdx = leadershipFrequencyIndex(frequencies);
  const leaderRoleCount = groups.reduce((n, g) => n + (g.roles || []).filter((r) => isLeadershipRoleName(r.name)).length, 0);
  const addLeadership = () => setFrequencies((prev) => assignAllLeaderRoles(ensureLeadershipFrequency(prev), groups));
  const leadershipOffer = leadIdx < 0 && (
    <div className="flex items-center gap-3 p-3 rounded-ui-md border border-specter-state-warning/50 bg-specter-state-warning/10">
      <Crown size={18} aria-hidden="true" className="shrink-0 text-amber-300" />
      <p className="flex-1 min-w-0 text-ui-sm text-specter-text-muted">
        No Leadership frequency. Group leaders use it to talk to each other while staying in their own group.
        {leaderRoleCount > 0 && ` Your ${leaderRoleCount} leader role${leaderRoleCount === 1 ? '' : 's'} will be put on it.`}
      </p>
      <Button size="sm" icon={<Plus size={14} />} onClick={addLeadership}>Add Leadership frequency</Button>
    </div>
  );
  if (!frequencies.length) {
    return (
      <div className="space-y-3">
        {leadershipOffer}
        <div className="py-10 flex flex-col items-center justify-center gap-2 text-center">
          <Radio size={28} aria-hidden="true" className="text-specter-text-subtle" />
          <p className="text-ui-base text-specter-text-muted">No frequencies yet.</p>
          <p className="max-w-[420px] text-ui-sm text-specter-text-subtle">
            A frequency is an op-wide channel the roles you pick can reach with a keybind during the operation. Add one from the bar below.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
    {leadershipOffer}
    <ul className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
      {frequencies.map((freq, fi) => {
        const { allRoles, authorized, available, assigned } = describeFrequency(freq, groups, members);
        const isLead = fi === leadIdx; // LEADFREQ
        const missingLeaders = isLead ? available.filter(({ r }) => isLeadershipRoleName(r.name)).length : 0;
        return (
          <li key={fi} className={cx('flex flex-col max-h-[340px] rounded-ui-md border bg-specter-bg-deep/50',
            isLead ? 'border-specter-state-warning/60' : 'border-specter-primary-cyan/40')}>
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-specter-border-divider">
              {isLead
                ? <Crown size={14} aria-hidden="true" className="shrink-0 text-amber-300" />
                : <Radio size={14} aria-hidden="true" className="shrink-0 text-amber-300" />}
              <input className={cx(inputClass, 'font-mono tracking-wider text-amber-200')} value={freq.name} maxLength={32} aria-label={`Frequency ${fi + 1} name`}
                onChange={(e) => setFrequencies((prev) => renameFrequency(prev, fi, e.target.value))} />
              <IconButton size="sm" variant="danger" icon={<Trash2 size={14} />} label={`Remove ${freq.name}`}
                onClick={() => setFrequencies((prev) => prev.filter((_, i) => i !== fi))} />
            </div>
            <div className="strip-scroll min-h-0 flex-1 p-2.5 space-y-2">
              {isLead && (
                <p className="text-ui-xs text-amber-200/80">
                  Leadership net — the roles below talk here alongside their own group.
                </p>
              )}
              {isLead && missingLeaders > 0 && (
                <Button size="sm" variant="secondary" icon={<Crown size={14} />}
                  onClick={() => setFrequencies((prev) => assignAllLeaderRoles(prev, groups))}>
                  Add {missingLeaders} leader role{missingLeaders === 1 ? '' : 's'}
                </Button>
              )}
              {authorized.length === 0 && <p className="text-ui-xs text-specter-text-subtle">No roles can reach it yet.</p>}
              <div className="flex flex-wrap gap-1">
                {authorized.map(({ gi, ri, g, r }) => (
                  <Chip key={`${gi}-${ri}`} tone="green" selected title="Remove this role"
                    onClick={() => setFrequencies((prev) => removeFrequencyRole(prev, fi, gi, ri))}>
                    {g.name} › {r.name || 'Unnamed'} <X size={11} aria-hidden="true" />
                  </Chip>
                ))}
              </div>
              {available.length > 0 ? (
                <select className={inputClass} value="" aria-label={`Add a role to ${freq.name}`}
                  onChange={(e) => {
                    const [gi, ri] = e.target.value.split('-').map(Number);
                    setFrequencies((prev) => addFrequencyRole(prev, fi, gi, ri));
                  }}>
                  <option value="">+ Add role…</option>
                  {available.map(({ gi, ri, g, r }) => <option key={`${gi}-${ri}`} value={`${gi}-${ri}`}>{g.name} › {r.name}</option>)}
                </select>
              ) : allRoles.length === 0 ? (
                <p className="text-ui-xs text-specter-text-subtle">Define roles in groups first.</p>
              ) : null}
              {assigned.length > 0 && (
                <div className="pt-2 border-t border-specter-border-divider">
                  <SectionLabel className="mb-1">Personnel</SectionLabel>
                  <div className="flex flex-wrap gap-1">
                    {assigned.map((a, ai) => (
                      <span key={ai} title={`via ${a.via}`} className="px-2 py-0.5 rounded-pill bg-specter-primary-cyan/10 text-ui-xs text-specter-primary-neon">{a.callsign}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
    </div>
  );
}

// ── Map ───────────────────────────────────────────────────────────────────
// MissionMap renders as a full-screen fixed overlay; the transform on this
// container makes it the containing block, so the map fills the page instead
// of the window. The full planner still gates the map (MISSION_MAP_ENABLED);
// here it's an explicit preview the planner opens on purpose.
// OPGROW: `opened` / `onOpen` are owned by OpPlanner (the opened map takes the
// panel's full size, so the planner sizes the panel from it).
export function MapPage({ orgId, eventId, groups, canEdit, onBack, opened, onOpen }) {
  const setOpened = () => onOpen?.();
  if (!MissionMap) return null; // EVT2: gated off (PLANNER_MAP_ENABLED)
  if (!opened) {
    return (
      <div className="py-10 flex flex-col items-center justify-center gap-3 text-center">
        <p className="text-ui-base text-specter-text-muted">Mission map <span className="ml-1 px-1.5 py-0.5 rounded-pill bg-specter-state-warning/15 text-ui-xs text-amber-300">Preview</span></p>
        <p className="max-w-[460px] text-ui-sm text-specter-text-subtle">
          Place groups, objectives and structures in 3D. Route and movement recording are still to come.
        </p>
        <Button onClick={() => setOpened(true)}>Open the map</Button>
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-ui-md border border-specter-border-divider" style={{ transform: 'translateZ(0)', height: BODY_MAX }}>
      <Suspense fallback={<p className="p-4 text-ui-sm text-specter-text-subtle">Loading the map…</p>}>
        <MissionMap orgId={orgId} eventId={eventId} groups={groups} canEdit={canEdit} onClose={onBack} />
      </Suspense>
    </div>
  );
}

// ── Review ────────────────────────────────────────────────────────────────
export function ReviewPage({ event, groups, frequencies, onDelete }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const roles = groups.flatMap((g) => (g.roles || []).map((r) => ({ ...r, group: g.name })));
  const slots = roles.filter((r) => (r.assignment_mode || 'open') === 'open').reduce((n, r) => n + (r.max_slots || 1), 0);
  const tiers = groups.length ? Math.max(...groups.map((_, i) => computeDepth(i, groups))) : 0;
  const ships = groups.reduce((n, g) => n + (g.ships || []).reduce((s, x) => s + (x.quantity || 1), 0), 0);
  const commander = roles.find((r) => r.is_commander);
  const warnings = [];
  if (!groups.length) warnings.push('No groups yet — people have nothing to join.');
  if (roles.some((r) => !r.name.trim())) warnings.push('Some roles have no name.');
  if (groups.length && !commander) warnings.push('No op commander role set.');
  if (frequencies.some((f) => !(f.role_refs || []).length)) warnings.push('A frequency has no roles that can reach it.');
  // LEADFREQ
  if (groups.length > 1 && leadershipFrequencyIndex(frequencies) < 0) warnings.push('No Leadership frequency — group leaders can only hear their own group. Add it on the Comms page.');
  const rows = [
    ['Starts', new Date(event.start_time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })],
    ['Access', (event.access_mode || 'open') === 'open' ? 'Anyone can sign up' : 'Planners assign'],
    ['Groups', `${groups.length} in ${tiers} tier${tiers === 1 ? '' : 's'}`],
    ['Roles', `${roles.length} · ${slots} sign-up slot${slots === 1 ? '' : 's'}`],
    ['Ships', ships ? `${ships}` : '—'],
    ['Frequencies', frequencies.length ? frequencies.map((f) => f.name).join(', ') : '—'],
    ['Commander', commander ? `${commander.group} › ${commander.name || 'Unnamed'}` : '—'],
  ];
  return (
    <div className="mx-auto max-w-[720px] space-y-3">
      <dl className="rounded-ui-md border border-specter-border-divider divide-y divide-specter-border-divider">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3 px-3 py-2 text-ui-sm">
            <dt className="w-28 shrink-0 text-specter-text-subtle">{k}</dt>
            <dd className="min-w-0 truncate text-specter-text-main">{v}</dd>
          </div>
        ))}
      </dl>
      {warnings.map((w) => <Alert key={w} variant="warning">{w}</Alert>)}
      <p className="text-ui-sm text-specter-text-subtle">Save and launch from the bar below.</p>
      <div className="pt-2 border-t border-specter-border-divider">
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-ui-sm text-red-300">Delete “{event.name}”?</span>
            <Button size="sm" variant="danger" onClick={onDelete}>Delete</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} className="!text-red-300" onClick={() => setConfirmDelete(true)}>Delete operation</Button>
        )}
      </div>
    </div>
  );
}
