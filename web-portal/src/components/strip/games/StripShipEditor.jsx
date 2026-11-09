// P2C: the strip's ship editor — a token-styled shell (header, nickname,
// stats, tabs) around the main window's ShipEditor tab bodies, which are
// reused as-is (seat locks, loadout card grid with the component picker,
// combat stats + damage estimate). Same data flow as WarRoom's ShipEditor:
// every edit is a PATCH /hangar/:id through onUpdate, and the bodies read the
// patched ship back from props.
import { useEffect, useState } from 'react';
import { Badge } from '../../ui';
import { cx, focusRing } from '../../ui/styles';
import { api } from '../../../api';
import { CombatTab, LoadoutCardGrid, ShipSeatList } from '../../ShipEditor';
import { inputClass } from '../stripOpsLayout';

const TABS = [
  { id: 'seats', label: 'Seats' },
  { id: 'loadout', label: 'Loadout' },
  { id: 'combat', label: 'Combat' },
];

function Stat({ label, value }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="px-3 py-1.5 rounded-ui-row bg-white/[0.04] border border-specter-border-divider">
      <div className="text-[11px] uppercase tracking-wide text-specter-text-subtle">{label}</div>
      <div className="text-ui-sm font-semibold tabular-nums text-specter-text-main">{value}</div>
    </div>
  );
}

export default function StripShipEditor({ ship, onUpdate }) {
  const [tab, setTab] = useState('seats');
  const [nickname, setNickname] = useState(ship.nickname || '');
  const [stats, setStats] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const lockedSeats = ship.locked_seats || [];

  useEffect(() => {
    let cancelled = false;
    api.getShipCombatStats('star_citizen', ship.ship_slug)
      .then(({ data }) => { if (!cancelled) setStats(data?.combat_stats || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ship.ship_slug]);

  const patch = async (p) => {
    setSaveError(null);
    const { error } = await onUpdate(ship.id, p);
    if (error) setSaveError(typeof error === 'string' ? error : 'Could not save');
  };
  const toggleSeat = (hp) => patch({ locked_seats: lockedSeats.includes(hp) ? lockedSeats.filter((s) => s !== hp) : [...lockedSeats, hp] });
  const override = (portId, className, name) => patch({
    loadout_overrides: [...(ship.loadout_overrides || []).filter((o) => o.port_id !== portId), { port_id: portId, class_name: className, name }],
  });
  const saveNickname = () => { if (nickname !== (ship.nickname || '')) patch({ nickname }); };

  const deflect = stats?.armor?.deflection;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-4">
        {ship.ship_icon_url && <img src={ship.ship_icon_url} alt="" className="w-14 h-14 object-contain rounded-ui-sm" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
        <div className="min-w-[200px] flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <h3 className="text-ui-xl font-semibold text-specter-text-main truncate">{ship.ship_name}</h3>
            {(stats?.career || stats?.role) && <Badge>{[stats.career, stats.role].filter(Boolean).join(' · ')}</Badge>}
          </div>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} onBlur={saveNickname}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder="Nickname (optional)" aria-label="Nickname" className={cx(inputClass, 'max-w-xs')} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Stat label="Hull" value={stats?.health?.toLocaleString()} />
          <Stat label="Armor" value={stats?.armor?.health?.toLocaleString()} />
          <Stat label="Phys deflect" value={deflect?.Physical !== undefined ? `${deflect.Physical}°` : null} />
          <Stat label="Energy deflect" value={deflect?.Energy !== undefined ? `${deflect.Energy}°` : null} />
        </div>
      </div>
      {saveError && <p role="alert" className="text-ui-sm text-red-300">{saveError}</p>}
      <div role="tablist" aria-label="Ship editor" className="flex gap-1 border-b border-specter-border-divider">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={cx(
              'px-3 h-9 -mb-px border-b-2 text-ui-sm font-medium transition-colors',
              focusRing,
              tab === t.id ? 'border-specter-primary-cyan text-specter-primary-neon' : 'border-transparent text-specter-text-muted hover:text-specter-text-main',
            )}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'seats' && (
          <>
            <p className="mb-2 text-ui-xs text-specter-text-subtle">Lock the seats you bring your own crew for. When you join an op with this ship, locked seats are reserved for them.</p>
            <ShipSeatList shipSlug={ship.ship_slug} lockedSeats={lockedSeats} onToggle={toggleSeat} />
          </>
        )}
        {tab === 'loadout' && <LoadoutCardGrid shipSlug={ship.ship_slug} overrides={ship.loadout_overrides} onOverride={override} />}
        {tab === 'combat' && <CombatTab ship={ship} stats={stats} />}
      </div>
    </div>
  );
}
