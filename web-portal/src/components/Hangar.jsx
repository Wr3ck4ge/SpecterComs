import React, { useState, useEffect } from 'react';
import { api } from '../api';

function HangarShipRow({ ship, onOpen, onRemove }) {
  const lockedCount = (ship.locked_seats || []).length;
  return (
    <div className="border border-specter-primary-dim/40 rounded p-2 flex items-center gap-3">
      {ship.ship_icon_url && (
        <img src={ship.ship_icon_url} alt="" className="w-8 h-8 object-contain rounded" onError={e => { e.target.style.display = 'none'; }} />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-specter-text-main truncate">{ship.ship_name}</div>
        {ship.nickname && <div className="text-xs text-specter-text-muted truncate">{ship.nickname}</div>}
      </div>
      {lockedCount > 0 && (
        <span className="text-xs font-mono text-specter-primary-cyan whitespace-nowrap">{lockedCount} locked</span>
      )}
      <button onClick={() => onOpen(ship)} className="px-3 py-1 text-xs font-mono uppercase tracking-wider border border-specter-primary-dim rounded text-specter-primary-cyan hover:bg-specter-primary-cyan/10">
        Open
      </button>
      <button onClick={() => onRemove(ship.id)} className="text-xs text-red-400 hover:text-red-300 px-2">✕</button>
    </div>
  );
}

// Personal hangar — global per-user, not per-org (see database/migrations/000041_user_hangar).
// Opening a ship hands off to the parent (WarRoom, via SettingsUI) through
// onOpenShip, which renders ShipEditor.jsx in the main content pane —
// SEATS/LOADOUT/MAP/COMBAT need real room, not squeezed into Settings'
// narrow form column. This component itself only owns the ship LIST, which
// stays put in Settings.
export default function Hangar({ onOpenShip }) {
  const [ships, setShips] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [addError, setAddError] = useState(null);

  const load = async () => {
    const { data } = await api.getHangar();
    setShips(data?.ships || []);
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!open) return;
    setSearching(true);
    const t = setTimeout(async () => {
      const { data } = await api.getGameShips('star_citizen', query.trim());
      setResults(data?.ships || []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query, open]);

  const addShip = async (ship) => {
    setAddError(null);
    const { error } = await api.addHangarShip(ship.slug);
    if (!error) {
      setOpen(false);
      setQuery('');
      await load();
    } else {
      setAddError(error);
      console.error('[Hangar] addHangarShip failed:', error);
    }
  };

  const removeShip = async (id) => {
    const { error } = await api.removeHangarShip(id);
    if (!error) setShips(prev => prev.filter(s => s.id !== id));
  };

  return (
    <div className="space-y-3">
      <div className="relative">
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Add a ship… e.g. Avenger"
          className="w-full bg-black border border-specter-primary-dim text-xs p-2 focus:border-specter-primary-cyan outline-none text-specter-text-main font-mono"
        />
        {open && (
          <div className="absolute z-10 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-specter-bg-surface border border-specter-primary-dim rounded">
            {searching && <div className="p-2 text-xs text-specter-text-muted font-mono">Searching…</div>}
            {!searching && results.length === 0 && <div className="p-2 text-xs text-specter-text-muted font-mono">No ships found.</div>}
            {!searching && results.map(ship => (
              <button key={ship.slug} onClick={() => addShip(ship)}
                className="w-full flex items-center gap-2 text-left px-2 py-1 border-b border-specter-primary-dim/20 hover:bg-specter-primary-cyan/10">
                {ship.icon_url && <img src={ship.icon_url} alt="" className="w-5 h-5 object-contain rounded" onError={e => { e.target.style.display = 'none'; }} />}
                <span className="text-xs text-specter-text-main font-mono">{ship.name}</span>
              </button>
            ))}
            <button onClick={() => setOpen(false)} className="w-full text-center py-1 text-xs text-specter-text-muted">CLOSE</button>
          </div>
        )}
      </div>

      {addError && <div className="text-xs text-red-400 font-mono">{addError}</div>}

      {ships === null ? (
        <div className="text-xs text-specter-text-muted font-mono">Loading…</div>
      ) : ships.length === 0 ? (
        <div className="text-xs text-specter-text-muted font-mono opacity-60">No ships in your hangar yet. Search above to add one.</div>
      ) : (
        <div className="space-y-2">
          {ships.map(ship => (
            <HangarShipRow key={ship.id} ship={ship} onOpen={onOpenShip} onRemove={removeShip} />
          ))}
        </div>
      )}
    </div>
  );
}
