// P2C: the wide panel for a game's tools (Star Citizen: hangar + ship
// editor), opened beside the Games cabinet. Lazy-loaded by StripApp, so the
// editor's loadout/combat code (ShipEditor.jsx's tab bodies) never lands in
// the main strip chunk.
//
// Layout: one panel sized by the caller from the strip window's inner size.
// The hangar list is a card grid; opening a ship drills into the editor in the
// same panel (back returns to the list).
//
// `transform-gpu` on the panel makes it the containing block for
// position:fixed descendants: ShipEditor's component-picker modal is
// `fixed inset-0`, which would otherwise centre on the whole (region-clipped)
// strip window and could land outside every visible region.
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Rocket, Search, Trash2, X } from 'lucide-react';
import { Alert, Badge, Button, IconButton } from '../../ui';
import { cx, focusRing } from '../../ui/styles';
import { inputClass } from '../stripOpsLayout';
import useHangar from './useHangar';
import StripShipEditor from './StripShipEditor';

function ShipIcon({ url, size = 40 }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <span className="shrink-0 inline-flex items-center justify-center rounded-ui-sm bg-specter-primary-cyan/10 text-specter-primary-neon"
        style={{ width: size, height: size }} aria-hidden="true">
        <Rocket size={Math.round(size * 0.45)} />
      </span>
    );
  }
  return <img src={url} alt="" className="shrink-0 object-contain rounded-ui-sm" style={{ width: size, height: size }} onError={() => setFailed(true)} />;
}

function AddShip({ search, onAdd }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    setSearching(true);
    let stale = false;
    const t = setTimeout(() => {
      search(q).then((r) => { if (!stale) { setResults(r); setSearching(false); } })
        .catch(() => { if (!stale) { setResults([]); setSearching(false); } });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q, open, search]);
  const add = async (ship) => {
    setAdding(ship.slug);
    setError(null);
    const { error: err } = await onAdd(ship.slug);
    setAdding(null);
    if (err) { setError(err); return; }
    setOpen(false);
    setQ('');
  };
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search size={14} aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-specter-text-subtle" />
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          placeholder="Add a ship… e.g. Avenger" aria-label="Search ships to add" className={cx(inputClass, 'pl-8')} />
      </div>
      {open && (
        <div className="rounded-ui-row border border-specter-border bg-specter-bg-deep/70">
          <ul className="strip-scroll max-h-56 py-1" aria-label="Ships">
            {searching && <li className="px-3 py-1.5 text-ui-sm text-specter-text-subtle">Searching…</li>}
            {!searching && !results.length && <li className="px-3 py-1.5 text-ui-sm text-specter-text-subtle">No ships found.</li>}
            {!searching && results.map((s) => (
              <li key={s.slug}>
                <button type="button" onClick={() => add(s)} disabled={adding === s.slug}
                  className={cx('w-full flex items-center gap-2 px-3 py-1.5 text-left text-ui-sm hover:bg-white/5 disabled:opacity-60', focusRing)}>
                  <ShipIcon url={s.icon_url} size={22} />
                  <span className="flex-1 min-w-0 truncate">{s.name}</span>
                  <Plus size={14} aria-hidden="true" className="text-specter-text-subtle" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end px-2 py-1 border-t border-specter-border-divider">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Done</Button>
          </div>
        </div>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}

function ShipCard({ ship, onOpen, onRemove }) {
  const [confirm, setConfirm] = useState(false);
  const locked = (ship.locked_seats || []).length;
  const swaps = (ship.loadout_overrides || []).length;
  return (
    <div className="group relative rounded-ui-row border border-specter-border bg-white/[0.02] hover:border-specter-border-strong transition-colors">
      <button type="button" onClick={() => onOpen(ship)}
        className={cx('w-full flex items-center gap-3 p-3 pr-10 text-left rounded-ui-row', focusRing)}>
        <ShipIcon url={ship.ship_icon_url} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-base font-semibold text-specter-text-main">{ship.ship_name}</span>
          <span className="block truncate text-ui-xs text-specter-text-subtle">{ship.nickname || 'No nickname'}</span>
          {(locked > 0 || swaps > 0) && (
            <span className="flex gap-1 mt-1">
              {locked > 0 && <Badge>{locked} seat{locked > 1 ? 's' : ''} locked</Badge>}
              {swaps > 0 && <Badge>{swaps} swap{swaps > 1 ? 's' : ''}</Badge>}
            </span>
          )}
        </span>
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-specter-text-subtle" />
      </button>
      <div className="absolute top-2 right-2">
        {confirm ? (
          <span className="flex items-center gap-1 rounded-ui-row bg-specter-bg-deep/90 p-0.5">
            <Button size="sm" variant="danger" onClick={() => onRemove(ship.id)}>Remove</Button>
            <IconButton size="sm" icon={<X size={14} />} label="Keep" onClick={() => setConfirm(false)} />
          </span>
        ) : (
          <IconButton size="sm" variant="danger" icon={<Trash2 size={14} />} label={`Remove ${ship.ship_name}`}
            className="opacity-60 group-hover:opacity-100" onClick={() => setConfirm(true)} />
        )}
      </div>
    </div>
  );
}

function HangarList({ hangar, tool, onOpenShip }) {
  const { ships, error } = hangar;
  const [removeError, setRemoveError] = useState(null);
  return (
    <div className="space-y-3">
      {tool === 'editor' && (
        <Alert variant="info" icon={false}>Choose a ship to open it in the editor.</Alert>
      )}
      <AddShip search={hangar.search} onAdd={hangar.add} />
      {/* Ship list/images come from Fleetyards and stats/loadouts from
          scunpacked-data, synced server-side (refreshed at most daily). */}
      <p className="text-ui-xs text-specter-text-subtle">
        Ship details, images and stats are filled in as they become available from community data sources. New or recently changed ships may take up to a day to appear, and some ships may not have full stats yet.
      </p>
      {error && <Alert variant="error">{error}</Alert>}
      {removeError && <Alert variant="error">{removeError}</Alert>}
      {ships === null ? (
        <p className="text-ui-sm text-specter-text-subtle">Loading your hangar…</p>
      ) : !ships.length ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Rocket size={28} aria-hidden="true" className="text-specter-text-subtle" />
          <p className="text-ui-base font-semibold">Your hangar is empty</p>
          <p className="text-ui-sm text-specter-text-subtle">Search above to add the ships you own.</p>
        </div>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          {ships.map((s) => (
            <ShipCard key={s.id} ship={s} onOpen={(ship) => onOpenShip(ship.id)}
              onRemove={async (id) => { const { error: err } = await hangar.remove(id); setRemoveError(err); }} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * game        'star_citizen'
 * tool        'hangar' | 'editor'
 * shipId      open ship (editor) or null
 * onOpenShip(id | null), onClose()
 * width, height  from the strip window's inner size (StripApp)
 */
export default function GameToolPanel({ tool = 'hangar', shipId = null, onOpenShip, onClose, width, height }) {
  const hangar = useHangar();
  const ship = shipId && hangar.ships ? hangar.ships.find((s) => s.id === shipId) : null;
  const scrollRef = useRef(null);
  // A removed/unknown ship drops back to the list.
  useEffect(() => { if (shipId && hangar.ships && !ship) onOpenShip(null); }, [shipId, hangar.ships, ship, onOpenShip]);
  useEffect(() => { scrollRef.current?.scrollTo?.(0, 0); }, [shipId]);

  return (
    <div className="relative flex flex-col overflow-hidden transform-gpu" style={{ width, height }}>
      <div className="flex items-center gap-1 px-3 pt-3 pb-2 border-b border-specter-border-divider">
        {ship && <IconButton size="sm" icon={<ChevronLeft size={16} />} label="Back to hangar" onClick={() => onOpenShip(null)} />}
        <nav aria-label="Breadcrumb" className="flex-1 min-w-0 flex items-center gap-1.5 text-ui-sm truncate">
          <span className="text-specter-text-subtle">Star Citizen</span>
          <ChevronRight size={12} aria-hidden="true" className="text-specter-text-subtle" />
          {ship ? (
            <>
              <button type="button" onClick={() => onOpenShip(null)} className={cx('text-specter-text-muted hover:text-specter-text-main', focusRing)}>Hangar</button>
              <ChevronRight size={12} aria-hidden="true" className="text-specter-text-subtle" />
              <span className="truncate font-semibold text-specter-text-main">{ship.nickname || ship.ship_name}</span>
            </>
          ) : (
            <span className="font-semibold text-specter-text-main">{tool === 'editor' ? 'Ship editor' : 'Hangar'}</span>
          )}
        </nav>
        <IconButton size="sm" icon={<X size={16} />} label="Close" onClick={onClose} />
      </div>
      <div ref={scrollRef} className="strip-scroll min-h-0 flex-1 p-4">
        {ship
          ? <StripShipEditor key={ship.id} ship={ship} onUpdate={hangar.update} />
          : <HangarList hangar={hangar} tool={tool} onOpenShip={onOpenShip} />}
      </div>
    </div>
  );
}
