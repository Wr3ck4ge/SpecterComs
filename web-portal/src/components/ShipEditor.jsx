import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../api';

// ── Seats ──────────────────────────────────────────────────────────────────
// Locking a seat means "I'm bringing crew for this seat"; when the owner
// joins a group with a matching ship, locked seats reserve capacity on the
// group's matching role automatically (see the join-confirm flow in
// OperationPlanner.jsx's NodeEditorPanel).
function ShipSeatList({ shipSlug, lockedSeats, onToggle }) {
  const [seats, setSeats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await api.getShipSeats('star_citizen', shipSlug);
      if (!cancelled) setSeats(data?.seats || []);
    })();
    return () => { cancelled = true; };
  }, [shipSlug]);

  if (seats === null) return <div className="text-xs text-specter-text-muted font-mono">Loading seats…</div>;
  if (seats.length === 0) return <div className="text-xs text-specter-text-muted font-mono opacity-60">No seat data available for this ship.</div>;

  return (
    <div className="space-y-1">
      {seats.map(seat => {
        const locked = lockedSeats.includes(seat.hardpoint_name);
        return (
          <button
            key={seat.hardpoint_name}
            onClick={() => onToggle(seat.hardpoint_name)}
            className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded text-sm font-mono border transition-colors ${
              locked
                ? 'border-specter-primary-cyan bg-specter-primary-cyan/10 text-specter-primary-cyan'
                : 'border-specter-primary-dim/40 text-specter-text-muted hover:text-specter-text-main'
            }`}
          >
            <span>{seat.seat_label} <span className="opacity-50">({seat.role_display || seat.role})</span></span>
            <span className="uppercase tracking-wider text-xs">{locked ? 'LOCKED' : 'LOCK'}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Loadout ────────────────────────────────────────────────────────────────
// Weapon-only filters for the swap search: dmg_type/weapon_family are
// precomputed at sync time (see shipComponentsSync.ts) from scunpacked's
// per-weapon Alpha breakdown and "Item Type: X" description line, so these
// are plain column filters, not a client-side stats scan.
const DMG_TYPE_FILTERS = ['Energy', 'Physical', 'Distortion'];
const WEAPON_FAMILY_FILTERS = ['Cannon', 'Gatling', 'Repeater', 'Scattergun'];

function FilterRow({ label, options, value, onChange }) {
  return (
    <div className="flex items-center gap-1 flex-wrap mb-1">
      <span className="text-xs text-specter-text-muted opacity-50 uppercase tracking-wider mr-1">{label}</span>
      {['All', ...options].map(opt => {
        const active = opt === 'All' ? !value : opt === value;
        return (
          <button
            key={opt}
            onClick={() => onChange(opt === 'All' ? '' : opt)}
            className={`px-2 py-0.5 text-xs font-mono uppercase rounded border transition-colors ${
              active
                ? 'border-specter-primary-cyan bg-specter-primary-cyan/10 text-specter-primary-cyan'
                : 'border-specter-primary-dim/40 text-specter-text-muted hover:text-specter-text-main'
            }`}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

// Sort controls for the search results list — separate from FilterRow
// (which narrows by weapon type/dmg type) since this reorders instead of
// hiding. "Stat" sorts by whichever single number matters most for that
// component's category (see primaryStatValue) so the same control works for
// weapons (DPS), shields (Shield HP), power plants (Power), etc. without a
// type-specific column. Clicking the active option again flips direction;
// clicking a different option switches to it with a sensible default
// direction (best-first for Stat/Size, A-Z for Name).
const SORT_OPTIONS = [
  { key: 'stat', label: 'Stat' },
  { key: 'name', label: 'Name' },
  { key: 'size', label: 'Size' },
];

function SortRow({ sortKey, sortDir, onChange }) {
  return (
    <div className="flex items-center gap-1 flex-wrap mb-1">
      <span className="text-xs text-specter-text-muted opacity-50 uppercase tracking-wider mr-1">Sort</span>
      {SORT_OPTIONS.map(opt => {
        const active = sortKey === opt.key;
        return (
          <button
            key={opt.key}
            onClick={() => onChange(opt.key)}
            className={`px-2 py-0.5 text-xs font-mono uppercase rounded border transition-colors ${
              active
                ? 'border-specter-primary-cyan bg-specter-primary-cyan/10 text-specter-primary-cyan'
                : 'border-specter-primary-dim/40 text-specter-text-muted hover:text-specter-text-main'
            }`}
          >
            {opt.label}{active ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
          </button>
        );
      })}
      {sortKey !== 'default' && (
        <button
          onClick={() => onChange('default')}
          className="px-2 py-0.5 text-xs font-mono uppercase text-specter-text-muted opacity-50 hover:opacity-100"
        >
          Clear
        </button>
      )}
    </div>
  );
}

// The one number that best represents "is this component better" for
// whatever category it is — same priority order as buildStatEntries below
// (which renders every one of these as labeled text), reused here so
// sorting by "Stat" picks the same figure a player would actually look at.
function primaryStatValue(detail) {
  if (!detail) return null;
  if (detail.dps != null) return detail.dps;
  if (detail.missile?.damage_total != null) return detail.missile.damage_total;
  if (detail.shield_hp != null) return detail.shield_hp;
  if (detail.power_output != null) return detail.power_output;
  if (detail.cooling_rate != null) return detail.cooling_rate;
  if (detail.qd_speed != null) return detail.qd_speed;
  return null;
}

// Search/select a compatible replacement for one editable port. Filters
// game_ship_components by the port's type + max size — no full combat
// simulation, just the raw stats (DPS/Alpha/etc., whatever's present) side
// by side so the comparison is meaningful.
// `embedded` skips the standalone bordered wrapper + its own Cancel button —
// used inside ComponentPickerModal, which already supplies a border/backdrop
// and its own close (✕) affordance.
function ComponentPicker({ node, onSelect, onClose, embedded }) {
  const [query, setQuery] = useState('');
  const [dmgType, setDmgType] = useState('');
  const [family, setFamily] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [sortKey, setSortKey] = useState('default');
  const [sortDir, setSortDir] = useState('desc');
  const isWeapon = node.type === 'WeaponGun';

  useEffect(() => {
    setSearching(true);
    const t = setTimeout(async () => {
      const { data } = await api.getShipComponents('star_citizen', node.type, node.max_size, query.trim(), dmgType, family);
      setResults(data?.components || []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query, node.type, node.max_size, dmgType, family]);

  const handleSortChange = (key) => {
    if (key === 'default') { setSortKey('default'); return; }
    if (sortKey === key) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); return; }
    setSortKey(key);
    setSortDir(key === 'name' ? 'asc' : 'desc');
  };

  // Sorting is client-side over the already-fetched (type/size-filtered)
  // results, not a server round-trip — the candidate list for one slot is
  // small enough that re-sorting on every click is instant.
  const sortedResults = useMemo(() => {
    if (sortKey === 'default') return results;
    const dir = sortDir === 'asc' ? 1 : -1;
    const arr = [...results];
    if (sortKey === 'name') {
      arr.sort((a, b) => dir * displayItemName(a.name, a.class_name).localeCompare(displayItemName(b.name, b.class_name)));
    } else if (sortKey === 'stat') {
      arr.sort((a, b) => dir * ((primaryStatValue(a) ?? -Infinity) - (primaryStatValue(b) ?? -Infinity)));
    } else if (sortKey === 'size') {
      arr.sort((a, b) => dir * ((a.size ?? 0) - (b.size ?? 0)));
    }
    return arr;
  }, [results, sortKey, sortDir]);

  const content = (
    <>
      {isWeapon && (
        <>
          <FilterRow label="Dmg" options={DMG_TYPE_FILTERS} value={dmgType} onChange={setDmgType} />
          <FilterRow label="Type" options={WEAPON_FAMILY_FILTERS} value={family} onChange={setFamily} />
        </>
      )}
      <SortRow sortKey={sortKey} sortDir={sortDir} onChange={handleSortChange} />
      <input
        autoFocus
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search compatible components…"
        className="w-full bg-black border border-specter-primary-dim/50 text-sm p-1.5 mb-1 text-specter-text-main font-mono outline-none"
      />
      {searching && <div className="text-xs text-specter-text-muted font-mono p-1.5">Searching…</div>}
      {!searching && results.length === 0 && <div className="text-xs text-specter-text-muted font-mono p-1.5">No compatible components found.</div>}
      {/* `c` is already the merged getShipComponents response (raw columns +
          deriveComponentDetail's derived fields — see gameShipsController.ts),
          so ComponentStatLine renders identically here and on the equipped
          slot card it'll replace — no more guessing which of two similar
          parts is actually better. */}
      {!searching && sortedResults.map(c => (
        <button key={c.class_name} onClick={() => onSelect(c)}
          className="w-full text-left px-1.5 py-1.5 text-sm font-mono text-specter-text-main hover:bg-specter-primary-cyan/10 flex flex-col gap-0.5 border-b border-specter-primary-dim/10 last:border-b-0">
          <span className="flex items-center justify-between gap-2">
            <span className="truncate">{displayItemName(c.name, c.class_name)}</span>
            <span className="text-specter-text-muted opacity-70 whitespace-nowrap text-xs shrink-0">{c.manufacturer_code || `S${c.size ?? '?'}`}</span>
          </span>
          <ComponentStatLine detail={c} />
        </button>
      ))}
      {!embedded && <button onClick={onClose} className="w-full text-center py-1 text-xs text-specter-text-muted uppercase">Cancel</button>}
    </>
  );

  if (embedded) return content;
  return (
    <div className="mt-1 border border-specter-primary-dim rounded bg-black/60 p-2 max-h-64 overflow-y-auto">
      {content}
    </div>
  );
}

// Modal wrapper for picking a slot's replacement component — used by the
// card-grid loadout view instead of the old cramped inline-expand-below-a-
// tiny-far-right-link layout.
function ComponentPickerModal({ node, onSelect, onClose }) {
  return (
    <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-specter-bg-surface border border-specter-primary-dim rounded w-full max-w-md max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-specter-primary-dim/40 flex-shrink-0">
          <span className="text-xs text-specter-primary-cyan uppercase tracking-wider truncate">
            {displayHardpointName(node.hardpoint_name, node.port_id)}
          </span>
          <button onClick={onClose} className="text-specter-text-muted hover:text-specter-text-main text-sm px-2 flex-shrink-0">✕</button>
        </div>
        <div className="p-3 overflow-y-auto flex-1">
          <ComponentPicker node={node} onSelect={onSelect} onClose={onClose} embedded />
        </div>
      </div>
    </div>
  );
}

// Stock loadout tree — hardpoint -> mount -> weapon -> sub-parts, from
// game_ships.stock_loadout (see scunpackedSync.ts), with loadout_overrides
// (a hangar ship's swapped components, see PATCH /hangar/:id) merged on top
// as deltas rather than a duplicated tree.
export function applyLoadoutOverrides(nodes, overridesByPortId) {
  return (nodes || []).map(node => {
    const ov = node.port_id && overridesByPortId[node.port_id];
    return {
      ...node,
      name: ov ? ov.name : node.name,
      class_name: ov ? ov.class_name : node.class_name,
      children: applyLoadoutOverrides(node.children, overridesByPortId),
    };
  });
}

// Real, meaningful ship loadout components — the game data's Editable flag
// is true for plenty of things that aren't actually "loadout" in any useful
// sense (doors, fuses, etc.), so filtering by editable alone let those
// through. This is a curated allowlist by component type instead.
const LOADOUT_TYPE_ALLOWLIST = new Set([
  'JumpDrive', 'Cooler', 'PowerPlant', 'QuantumDrive', 'Shield',
  'LifeSupportGenerator', 'WeaponGun', 'Turret', 'MissileLauncher', 'Missile',
  'Radar', 'FlightController',
]);

// The game data leaves plenty of item names unresolved as a literal
// "<= PLACEHOLDER =>" string — fall back to the class name instead of
// showing that.
function displayItemName(name, className) {
  if (name && !/PLACEHOLDER/i.test(name)) return name;
  return className || '—';
}

// "hardpoint_class_2" etc. is the raw port naming convention for a
// size-keyed mount — the number is the item size class, so show it as such.
// Everything else gets a light humanize pass (strip the "hardpoint_"
// prefix, underscores -> spaces, title case) instead of the raw
// "hardpoint_front_left_turret"-style string.
function displayHardpointName(hardpointName, portId) {
  const raw = hardpointName || portId || '';
  const sizeMatch = raw.match(/^hardpoint_class_(\d+)$/i);
  if (sizeMatch) return `Size ${sizeMatch[1]}`;
  if (!raw) return raw;
  return raw
    .replace(/^hardpoint_/i, '')
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Physical hierarchy (mount -> gun nesting) isn't meaningful for browsing or
// comparing loadout slots — the card grid flattens everything and groups by
// function instead (except Weapons, which is grouped by mount — see
// collectWeaponGroups — and rendered separately, first). Order here is the
// display order for everything after Weapons.
const CATEGORY_GROUPS = [
  { label: 'Flight Computer', types: ['FlightController'] },
  { label: 'Shields', types: ['Shield'] },
  { label: 'Power', types: ['PowerPlant'] },
  { label: 'Cooling', types: ['Cooler'] },
  { label: 'Propulsion', types: ['QuantumDrive', 'JumpDrive'] },
  { label: 'Avionics', types: ['Radar'] },
  { label: 'Life Support', types: ['LifeSupportGenerator'] },
];

// Mirrors FLEXIBLE_SIZE_TYPES in gameShipsController.ts (getShipComponents) —
// only cosmetic here (the "or smaller" badge), the actual filtering
// enforcement happens server-side.
const FLEXIBLE_SIZE_TYPES = new Set(['WeaponGun', 'Turret', 'MissileLauncher', 'FlightController']);

function flattenLoadoutNodes(nodes, out) {
  for (const n of (nodes || [])) {
    if (LOADOUT_TYPE_ALLOWLIST.has(n.type)) out.push(n);
    flattenLoadoutNodes(n.children, out);
  }
  return out;
}

// A MissileLauncher rack's own component row carries no damage stats at all
// (verified against real scunpacked data — a rack's stdItem has no Weapon or
// Missile block, only Ports referencing whatever's loaded into it) — the
// actual missile/torpedo item loaded as its child is what has DamageTotal/
// lock-range/etc. So collect the loaded Missile children as "guns" instead
// of the rack itself; a rack with nothing loaded (or a decorative end-cap
// with no children at all) correctly contributes zero guns.
function collectGunDescendants(nodes, out) {
  for (const n of (nodes || [])) {
    if (n.type === 'WeaponGun' || n.type === 'Missile') out.push(n);
    collectGunDescendants(n.children, out);
  }
  return out;
}

// Weapons are grouped by physical mount, not flattened — but grouping by the
// mount's own `type` string doesn't work: checked against real scunpacked
// data (Idris-M), player-manned turrets are typed "TurretBase.MannedTurret"
// (base type "TurretBase", not "Turret"), while only the small AI/remote
// turrets and point-defense turrets use the bare "Turret" type — and some
// guns (e.g. a nose-mounted railgun) sit at the top level with no turret
// wrapper at all. Type-matching would silently miss every real manned
// turret. Grouping by top-level loadout branch instead works for all three
// shapes: each root entry that contains any gun becomes one group, labeled
// with its own hardpoint name (a missile rack's hardpoint name, groups its
// loaded missiles the same way a turret groups its guns); a bare top-level
// gun (no wrapper) is its own ungrouped card.
function collectWeaponGroups(topLevelNodes) {
  const groups = [];
  for (const top of (topLevelNodes || [])) {
    const guns = collectGunDescendants([top], []);
    if (guns.length === 0) continue;
    const isBareGun = guns.length === 1 && guns[0] === top;
    groups.push({ label: isBareGun ? null : displayHardpointName(top.hardpoint_name, top.port_id), guns });
  }
  return groups;
}

// Every allowlisted slot gets its details resolved now (manufacturer/grade/
// size, plus DPS/Alpha for weapons) — not just weapons as before — so every
// card in the grid can show something more than a bare name.
function collectLoadoutClassNames(nodes, out) {
  for (const n of (nodes || [])) {
    if (LOADOUT_TYPE_ALLOWLIST.has(n.type) && n.class_name) out.add(n.class_name);
    collectLoadoutClassNames(n.children, out);
  }
}

// Numeric grade -> letter grade (1=A best ... 4=D worst) — verified 1:1
// against real scunpacked data, safe to hardcode rather than needing a
// server round-trip for something this simple.
const GRADE_LETTERS = { 1: 'A', 2: 'B', 3: 'C', 4: 'D' };

// Every numeric stat a component might carry, as an ordered {label, value}
// list — one source of truth for both the equipped-slot card (SlotCard) and
// the swap-search picker (ComponentPicker's result rows), so the two never
// drift back out of sync: picking a replacement used to show far less
// detail than the slot you were replacing, for the exact same underlying
// data. Field paths verified against real scunpacked-data (ship-items.json),
// not guessed. Rendered as a labeled grid (see ComponentStatLine) instead of
// a wrapped line of bare numbers, so each figure says what it is.
function buildStatEntries(detail) {
  const out = [];
  const alphaEntries = detail.alpha_by_type ? Object.entries(detail.alpha_by_type) : [];

  // dps is already the sustained figure (see componentDetail.ts) — burst
  // shown as its own entry only when it differs, as the peak/secondary number.
  if (detail.dps) out.push({ label: 'DPS', value: Math.round(detail.dps).toLocaleString() });
  if (detail.burst_dps && Math.round(detail.burst_dps) !== Math.round(detail.dps || 0)) {
    out.push({ label: 'Burst DPS', value: Math.round(detail.burst_dps).toLocaleString() });
  }
  for (const [t, v] of alphaEntries) out.push({ label: `${t} Alpha`, value: Math.round(v).toLocaleString() });
  if (detail.rpm) out.push({ label: 'RPM', value: Math.round(detail.rpm).toLocaleString() });
  if (detail.effective_range) out.push({ label: 'Range', value: `${Math.round(detail.effective_range).toLocaleString()}m` });
  if (detail.ammo_capacity) out.push({ label: 'Ammo', value: detail.ammo_capacity.toLocaleString() });

  if (detail.shield_hp != null) out.push({ label: 'Shield HP', value: Math.round(detail.shield_hp).toLocaleString() });
  if (detail.shield_regen != null) out.push({ label: 'Regen', value: `${Math.round(detail.shield_regen).toLocaleString()}/s` });
  if (detail.qd_speed != null) out.push({ label: 'Speed', value: `${Math.round(detail.qd_speed / 1000).toLocaleString()} km/s` });
  if (detail.qd_fuel_rate != null) out.push({ label: 'Fuel Rate', value: `${detail.qd_fuel_rate} SCU/Gm` });
  if (detail.power_output != null) out.push({ label: 'Power', value: detail.power_output.toLocaleString() });
  if (detail.cooling_rate != null) out.push({ label: 'Cooling', value: `${detail.cooling_rate}/s` });

  if (detail.missile) {
    if (detail.missile.damage_total) out.push({ label: 'Damage', value: Math.round(detail.missile.damage_total).toLocaleString() });
    if (detail.missile.lock_range_max) {
      const lo = detail.missile.lock_range_min ? `${Math.round(detail.missile.lock_range_min)}-` : '';
      out.push({ label: 'Lock Range', value: `${lo}${Math.round(detail.missile.lock_range_max)}m` });
    }
    if (detail.missile.lock_time) out.push({ label: 'Lock Time', value: `${detail.missile.lock_time}s` });
    if (detail.missile.explosion_radius) out.push({ label: 'Blast Radius', value: `${detail.missile.explosion_radius}m` });
  }

  if (detail.em != null) out.push({ label: 'EM', value: Math.round(detail.em).toLocaleString() });
  if (detail.ir != null) out.push({ label: 'IR', value: Math.round(detail.ir).toLocaleString() });

  return out;
}

// Single source of truth for rendering a component's stats — used by both
// the equipped-slot card (SlotCard) and the swap-search picker
// (ComponentPicker's result rows). Manufacturer/grade/class/item-type is a
// compact "meta" line; every actual number gets its own labeled cell in a
// grid instead of being dropped unlabeled into a wrapped string of spans.
function ComponentStatLine({ detail }) {
  if (!detail) return null;
  const gradeLetter = detail.grade != null ? GRADE_LETTERS[detail.grade] : null;
  const metaBits = [detail.item_type_label, detail.manufacturer_name, gradeLetter ? `Grade ${gradeLetter}` : null, detail.item_class].filter(Boolean);
  const stats = buildStatEntries(detail);

  return (
    <>
      {metaBits.length > 0 && (
        <div className="text-xs text-specter-text-muted font-mono opacity-70 truncate">
          {metaBits.join(' · ')}
        </div>
      )}
      {stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 mt-0.5">
          {stats.map(s => (
            <div key={s.label} className="flex items-baseline gap-1 min-w-0">
              <span className="text-[10px] text-specter-text-muted opacity-50 uppercase tracking-wider truncate">{s.label}</span>
              <span className="text-xs text-specter-text-main font-mono whitespace-nowrap">{s.value}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function SlotCard({ node, detail, onOverride }) {
  const [picking, setPicking] = useState(false);
  const flexible = FLEXIBLE_SIZE_TYPES.has(node.type);

  return (
    <div className="border border-specter-primary-dim/40 rounded p-3 bg-black/30 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-specter-text-muted opacity-60 truncate">{displayHardpointName(node.hardpoint_name, node.port_id)}</span>
        {node.max_size != null && (
          <span
            className="text-xs font-mono text-specter-text-muted opacity-70 shrink-0"
            title={flexible ? 'Accepts this size or smaller' : 'Requires an exact size match'}
          >
            SIZE {node.max_size}{flexible ? '−' : ''}
          </span>
        )}
      </div>
      <div className="text-sm text-specter-text-main font-mono truncate">{displayItemName(node.name, node.class_name)}</div>
      <ComponentStatLine detail={detail} />
      {node.editable && onOverride && (
        <button
          onClick={() => setPicking(true)}
          className="mt-1 px-2 py-1 text-xs font-mono uppercase tracking-wider border border-specter-primary-dim rounded text-specter-primary-cyan hover:bg-specter-primary-cyan/10 self-start"
        >
          Change
        </button>
      )}
      {picking && (
        <ComponentPickerModal
          node={node}
          onSelect={c => { onOverride(node.port_id, c.class_name, c.name); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function LoadoutCardGrid({ shipSlug, overrides, onOverride }) {
  const [loadout, setLoadout] = useState(null);
  const [details, setDetails] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await api.getShipLoadout('star_citizen', shipSlug);
      if (!cancelled) setLoadout(data?.loadout || []);
    })();
    return () => { cancelled = true; };
  }, [shipSlug]);

  const overridesByPortId = {};
  for (const ov of (overrides || [])) {
    if (ov.port_id) overridesByPortId[ov.port_id] = ov;
  }
  const merged = loadout ? applyLoadoutOverrides(loadout, overridesByPortId) : [];
  // Weapons are rendered via weaponGroups (grouped by mount) instead of the
  // flat list — flat still covers every other category unchanged.
  const flat = useMemo(() => flattenLoadoutNodes(merged, []).filter(n => n.type !== 'WeaponGun' && n.type !== 'MissileLauncher' && n.type !== 'Missile' && n.type !== 'Turret'), [merged]);
  const weaponGroups = useMemo(() => collectWeaponGroups(merged), [merged]);

  const classNamesKey = useMemo(() => {
    const set = new Set();
    collectLoadoutClassNames(merged, set);
    return [...set].sort().join(',');
  }, [merged]);

  useEffect(() => {
    if (!classNamesKey) { setDetails({}); return; }
    let cancelled = false;
    (async () => {
      const { data } = await api.getShipComponentDetails('star_citizen', classNamesKey.split(','));
      if (!cancelled) {
        const map = {};
        for (const d of (data?.components || [])) map[d.class_name] = d;
        setDetails(map);
      }
    })();
    return () => { cancelled = true; };
  }, [classNamesKey]);

  if (loadout === null) return <div className="text-xs text-specter-text-muted font-mono">Loading loadout…</div>;
  if (loadout.length === 0) return <div className="text-xs text-specter-text-muted font-mono opacity-60">No loadout data available for this ship.</div>;
  if (flat.length === 0 && weaponGroups.length === 0) {
    return <div className="text-xs text-specter-text-muted font-mono opacity-60">No customizable components on this ship.</div>;
  }

  return (
    <div className="space-y-6">
      {weaponGroups.length > 0 && (
        <div>
          <div className="text-xs text-specter-primary-cyan uppercase tracking-wider mb-2">Weapons</div>
          <div className="space-y-3">
            {weaponGroups.map((wg, gi) => (
              wg.label ? (
                <div key={gi} className="border border-specter-primary-dim/25 rounded p-2">
                  <div className="text-xs text-specter-text-muted uppercase tracking-wider mb-2 opacity-80">{wg.label}</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {wg.guns.map((node, i) => (
                      <SlotCard key={node.port_id || i} node={node} detail={node.class_name ? details[node.class_name] : null} onOverride={onOverride} />
                    ))}
                  </div>
                </div>
              ) : (
                <div key={gi} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  <SlotCard node={wg.guns[0]} detail={wg.guns[0].class_name ? details[wg.guns[0].class_name] : null} onOverride={onOverride} />
                </div>
              )
            ))}
          </div>
        </div>
      )}
      {CATEGORY_GROUPS.map(group => {
        const nodes = flat.filter(n => group.types.includes(n.type));
        if (nodes.length === 0) return null;
        return (
          <div key={group.label}>
            <div className="text-xs text-specter-primary-cyan uppercase tracking-wider mb-2">{group.label}</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {nodes.map((node, i) => (
                <SlotCard key={node.port_id || i} node={node} detail={node.class_name ? details[node.class_name] : null} onOverride={onOverride} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Map (approximate turret/seat layout) ──────────────────────────────────
// Parsed from direction keywords already present in each hardpoint's name
// (front/rear, left/right, upper/lower) — no real 3D coordinate data exists
// in any accessible source (checked), so this is a schematic, not a
// to-scale diagram.
function parseSeatPosition(hardpointName) {
  const hp = (hardpointName || '').toLowerCase();
  let x = 0, y = 0, z = 0, found = false;
  if (hp.includes('front')) { y = -1; found = true; }
  if (hp.includes('rear') || hp.includes('aft')) { y = 1; found = true; }
  if (hp.includes('left')) { x = -1; found = true; }
  if (hp.includes('right')) { x = 1; found = true; }
  if (hp.includes('upper') || hp.includes('top')) z = 1;
  if (hp.includes('lower') || hp.includes('bottom')) z = -1;
  return found ? { x, y, z } : null;
}

function TurretMap({ shipSlug }) {
  const [seats, setSeats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await api.getShipSeats('star_citizen', shipSlug);
      if (!cancelled) setSeats(data?.seats || []);
    })();
    return () => { cancelled = true; };
  }, [shipSlug]);

  if (seats === null) return <div className="text-xs text-specter-text-muted font-mono">Loading map…</div>;
  if (seats.length === 0) return <div className="text-xs text-specter-text-muted font-mono opacity-60">No seat data available for this ship.</div>;

  const cells = {};
  const unplaced = [];
  for (const seat of seats) {
    const pos = parseSeatPosition(seat.hardpoint_name);
    if (!pos) { unplaced.push(seat); continue; }
    const key = `${pos.y}_${pos.x}`;
    (cells[key] = cells[key] || []).push({ ...seat, z: pos.z });
  }

  return (
    <div className="max-w-xl">
      <div className="text-xs text-specter-text-muted opacity-60 mb-2">Approximate layout parsed from hardpoint naming — not to scale.</div>
      <div className="text-xs text-specter-text-muted opacity-50 text-center font-mono uppercase">Front</div>
      <div className="grid grid-cols-3 gap-1">
        {[-1, 0, 1].flatMap(y => [-1, 0, 1].map(x => {
          const items = cells[`${y}_${x}`] || [];
          return (
            <div key={`${y}_${x}`} className="border border-specter-primary-dim/30 rounded p-2 min-h-[64px]">
              {items.map(item => (
                <div key={item.hardpoint_name} title={item.seat_label} className="text-xs text-specter-primary-cyan font-mono truncate">
                  {item.z === 1 ? '▲ ' : item.z === -1 ? '▼ ' : ''}{item.seat_label}
                </div>
              ))}
            </div>
          );
        }))}
      </div>
      <div className="text-xs text-specter-text-muted opacity-50 text-center font-mono uppercase mt-1">Rear</div>
      {unplaced.length > 0 && (
        <div className="mt-3 pt-2 border-t border-specter-primary-dim/20">
          <div className="text-xs text-specter-text-muted uppercase tracking-wider mb-1">Unplaced</div>
          {unplaced.map(s => <div key={s.hardpoint_name} className="text-xs text-specter-text-muted font-mono">{s.seat_label}</div>)}
        </div>
      )}
    </div>
  );
}

// ── Combat ─────────────────────────────────────────────────────────────────
const DAMAGE_TYPES = ['Physical', 'Energy', 'Distortion', 'Thermal', 'Biochemical', 'Stun'];

function formatSeconds(s) {
  if (!isFinite(s)) return 'never (no effective damage)';
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function CombatTab({ ship, stats }) {
  const [targetQuery, setTargetQuery] = useState('');
  const [targetResults, setTargetResults] = useState([]);
  const [targetOpen, setTargetOpen] = useState(false);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [targetName, setTargetName] = useState('');

  useEffect(() => {
    if (!targetOpen) return;
    const t = setTimeout(async () => {
      const { data } = await api.getGameShips('star_citizen', targetQuery.trim());
      setTargetResults(data?.ships || []);
    }, 250);
    return () => clearTimeout(t);
  }, [targetQuery, targetOpen]);

  const runEstimate = async (target) => {
    setTargetOpen(false);
    setTargetQuery('');
    setTargetName(target.name);
    setEstimating(true);
    setEstimateError(null);
    setEstimate(null);

    const { data: loadoutData } = await api.getShipLoadout('star_citizen', ship.ship_slug);
    const overridesByPortId = {};
    for (const ov of (ship.loadout_overrides || [])) if (ov.port_id) overridesByPortId[ov.port_id] = ov;
    const merged = applyLoadoutOverrides(loadoutData?.loadout || [], overridesByPortId);
    // Missiles/torpedoes are loaded as children of a MissileLauncher rack,
    // not the rack itself (the rack carries no damage stats — see
    // collectGunDescendants above) — walk collects both so ordnance shows up
    // in the estimate instead of silently contributing zero.
    const classNames = [];
    const walk = (nodes) => {
      for (const n of (nodes || [])) {
        if ((n.type === 'WeaponGun' || n.type === 'Missile') && n.class_name) classNames.push(n.class_name);
        walk(n.children);
      }
    };
    walk(merged);

    if (classNames.length === 0) {
      setEstimating(false);
      setEstimateError('No guns or missiles equipped — nothing to estimate.');
      return;
    }

    const { data, error } = await api.getDamageEstimate('star_citizen', classNames, target.slug);
    setEstimating(false);
    if (error) setEstimateError(error);
    else setEstimate(data);
  };

  if (stats === null) return <div className="text-xs text-specter-text-muted font-mono">Loading combat stats…</div>;

  return (
    <div className="max-w-xl space-y-4">
      <div>
        <div className="text-xs text-specter-primary-cyan uppercase tracking-wider mb-2">Hull &amp; Shields</div>
        <div className="text-sm font-mono text-specter-text-main space-y-1">
          <div>Hull HP: <span className="text-specter-text-muted">{stats.health?.toLocaleString() || '—'}</span></div>
          {stats.shields ? (
            <>
              <div>Shield HP: <span className="text-specter-text-muted">{stats.shields.hp?.toLocaleString()}</span></div>
              <div>Shield Regen: <span className="text-specter-text-muted">{stats.shields.regen?.toLocaleString()}/s</span></div>
            </>
          ) : (
            <div className="text-specter-text-muted opacity-60">No shields.</div>
          )}
        </div>
      </div>

      {stats.armor && (
        <div>
          <div className="text-xs text-specter-primary-cyan uppercase tracking-wider mb-2">Armor Damage Multipliers</div>
          <div className="grid grid-cols-3 gap-2 text-sm font-mono">
            {DAMAGE_TYPES.filter(t => stats.armor.damage_multipliers[t] !== undefined).map(t => (
              <div key={t} className="text-specter-text-muted">{t}: <span className="text-specter-text-main">{stats.armor.damage_multipliers[t].toFixed(2)}×</span></div>
            ))}
          </div>
        </div>
      )}

      <div className="pt-2 border-t border-specter-primary-dim/20">
        <div className="text-xs text-specter-primary-cyan uppercase tracking-wider mb-2">What Can This Kill</div>
        <div className="text-xs text-specter-text-muted opacity-60 mb-2">
          Approximate — sums this ship's equipped guns' DPS by damage type against a target's shields and armor. Doesn't model angle of incidence, range falloff, or penetration.
        </div>
        <div className="relative">
          <button onClick={() => setTargetOpen(o => !o)} className="px-3 py-1.5 text-xs font-mono uppercase tracking-wider border border-specter-primary-dim rounded text-specter-primary-cyan hover:bg-specter-primary-cyan/10">
            Pick Target Ship
          </button>
          {targetOpen && (
            <div className="absolute z-10 top-full left-0 mt-1 w-72 max-h-56 overflow-y-auto bg-specter-bg-surface border border-specter-primary-dim rounded">
              <input
                autoFocus
                value={targetQuery}
                onChange={e => setTargetQuery(e.target.value)}
                placeholder="Search ships…"
                className="w-full bg-black border-b border-specter-primary-dim/50 text-sm p-2 text-specter-text-main font-mono outline-none"
              />
              {targetResults.map(t => (
                <button key={t.slug} onClick={() => runEstimate(t)}
                  className="w-full flex items-center gap-2 text-left px-2 py-1.5 border-b border-specter-primary-dim/20 hover:bg-specter-primary-cyan/10">
                  {t.icon_url && <img src={t.icon_url} alt="" className="w-5 h-5 object-contain" onError={e => { e.target.style.display = 'none'; }} />}
                  <span className="text-sm text-specter-text-main font-mono">{t.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {estimating && <div className="text-xs text-specter-text-muted font-mono mt-3">Estimating…</div>}
        {estimateError && <div className="text-xs text-red-400 font-mono mt-3">{estimateError}</div>}
        {estimate && (
          <div className="mt-3 p-3 border border-specter-primary-dim/40 rounded bg-black/40 text-sm font-mono space-y-1">
            <div className="text-specter-primary-cyan">vs. {targetName}</div>
            <div>
              Sustained DPS: <span className="text-specter-text-main">{Math.round(estimate.total_dps)}</span>
              {estimate.total_burst_dps && Math.round(estimate.total_burst_dps) !== Math.round(estimate.total_dps) && (
                <span className="text-specter-text-muted opacity-60"> ({Math.round(estimate.total_burst_dps)} burst)</span>
              )}
            </div>
            {estimate.missile_payload && (
              <div>Missile payload: <span className="text-specter-text-main">{estimate.missile_payload.count} × ordnance, {Math.round(estimate.missile_payload.total_alpha).toLocaleString()} total dmg</span></div>
            )}
            {estimate.shield_seconds > 0 && <div>Shield down in: <span className="text-specter-text-main">{formatSeconds(estimate.shield_seconds)}</span></div>}
            <div>Hull destroyed in: <span className="text-specter-text-main">{formatSeconds(estimate.hull_seconds)}</span></div>
            <div className="text-specter-primary-cyan">Total time-to-kill (guns only): {formatSeconds(estimate.total_seconds)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// Compact hull/armor/deflection readout shown in the header on every tab
// (previously only visible buried in the Combat tab). Deflection is in
// degrees off the incoming shot's angle, from game_ships.combat_stats (see
// scunpackedSync.ts's extractCombatStats) — not a percentage.
function ShipHeaderStats({ stats }) {
  if (!stats) return null;
  const armor = stats.armor;
  const deflection = armor?.deflection;
  return (
    <div className="hidden md:flex items-center gap-4 text-xs font-mono px-4">
      {(stats.career || stats.role) && (
        <div className="text-specter-text-muted">{[stats.career, stats.role].filter(Boolean).join(' · ').toUpperCase()}</div>
      )}
      <div className="text-specter-text-muted">HULL <span className="text-specter-text-main">{stats.health?.toLocaleString() || '—'}</span></div>
      {armor && (
        <div className="text-specter-text-muted">ARMOR <span className="text-specter-text-main">{armor.health?.toLocaleString() || '—'}</span></div>
      )}
      {deflection?.Physical !== undefined && (
        <div className="text-specter-text-muted">PHYS DEFLECT <span className="text-specter-text-main">{deflection.Physical}°</span></div>
      )}
      {deflection?.Energy !== undefined && (
        <div className="text-specter-text-muted">ENERGY DEFLECT <span className="text-specter-text-main">{deflection.Energy}°</span></div>
      )}
    </div>
  );
}

// ── Ship editor shell ────────────────────────────────────────────────────
// Fills the same center-pane slot Settings itself renders into (WarRoom.jsx
// swaps this in for SettingsUI when a ship is opened, both as siblings in
// the same <main> container) rather than a fixed full-viewport overlay —
// SEATS/LOADOUT/MAP/COMBAT still get real room, they just stay within the
// Settings window instead of covering the sidebar/cabinet too.
const TABS = ['seats', 'loadout', 'map', 'combat'];
// TurretMap (see below) is a crude guess parsed from hardpoint-name keywords
// (front/rear/left/right), not real coordinate data — genuinely useless on
// plenty of ships. Disabled until it's backed by something better; flip back
// to true to restore the tab.
const MAP_TAB_ENABLED = false;

export default function ShipEditor({ ship, onUpdate, onClose }) {
  const [tab, setTab] = useState('seats');
  const [nickname, setNickname] = useState(ship.nickname || '');
  const [combatStats, setCombatStats] = useState(null);
  const lockedSeats = ship.locked_seats || [];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await api.getShipCombatStats('star_citizen', ship.ship_slug);
      if (!cancelled) setCombatStats(data?.combat_stats || null);
    })();
    return () => { cancelled = true; };
  }, [ship.ship_slug]);

  const toggleSeat = (hardpointName) => {
    const next = lockedSeats.includes(hardpointName)
      ? lockedSeats.filter(s => s !== hardpointName)
      : [...lockedSeats, hardpointName];
    onUpdate(ship.id, { locked_seats: next });
  };

  const saveNickname = () => {
    if (nickname !== (ship.nickname || '')) onUpdate(ship.id, { nickname });
  };

  const handleOverride = (portId, classNameVal, nameVal) => {
    const overrides = (ship.loadout_overrides || []).filter(o => o.port_id !== portId);
    overrides.push({ port_id: portId, class_name: classNameVal, name: nameVal });
    onUpdate(ship.id, { loadout_overrides: overrides });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full bg-specter-bg-surface font-mono">
      <div className="flex items-center justify-between px-6 py-4 border-b border-specter-primary-dim/40 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {ship.ship_icon_url && (
            <img src={ship.ship_icon_url} alt="" className="w-8 h-8 object-contain rounded" onError={e => { e.target.style.display = 'none'; }} />
          )}
          <div className="min-w-0">
            <div className="text-specter-primary-cyan uppercase tracking-widest text-sm truncate">{ship.ship_name}</div>
            <input
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              onBlur={saveNickname}
              placeholder="Nickname (optional)"
              className="bg-transparent text-xs text-specter-text-muted font-mono outline-none border-b border-transparent focus:border-specter-primary-dim"
            />
          </div>
        </div>
        <ShipHeaderStats stats={combatStats} />
        <button onClick={onClose} className="px-4 py-1.5 text-xs font-mono uppercase tracking-wider border border-specter-primary-dim rounded text-specter-text-muted hover:text-specter-text-main flex-shrink-0">
          ← Back
        </button>
      </div>

      <div className="flex border-b border-specter-primary-dim/40 px-6 flex-shrink-0">
        {TABS.map(t => {
          const disabled = t === 'map' && !MAP_TAB_ENABLED;
          return (
            <button
              key={t}
              onClick={() => { if (!disabled) setTab(t); }}
              disabled={disabled}
              title={disabled ? 'Turret map — coming soon' : undefined}
              className={`px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                disabled ? 'text-specter-text-muted opacity-30 cursor-not-allowed'
                  : tab === t ? 'text-specter-primary-cyan border-b-2 border-specter-primary-cyan -mb-px'
                  : 'text-specter-text-muted hover:text-specter-text-main'
              }`}
            >
              {t}
            </button>
          );
        })}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'seats' && <ShipSeatList shipSlug={ship.ship_slug} lockedSeats={lockedSeats} onToggle={toggleSeat} />}
        {tab === 'loadout' && <LoadoutCardGrid shipSlug={ship.ship_slug} overrides={ship.loadout_overrides} onOverride={handleOverride} />}
        {tab === 'map' && MAP_TAB_ENABLED && <TurretMap shipSlug={ship.ship_slug} />}
        {tab === 'combat' && <CombatTab ship={ship} stats={combatStats} />}
      </div>
    </div>
  );
}
