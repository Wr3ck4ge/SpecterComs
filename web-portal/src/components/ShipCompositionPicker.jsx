import React, { useState, useEffect } from 'react';
import { api } from '../api';

// Shared composition editor — search + add { ship, quantity } entries.
// A group can be zero, one, or many vehicles (e.g. a 3-fighter wing, or a
// mixed capital+escort group), so this isn't a single-select. Used by both
// OperationPlanner.jsx's group builder (drives crew-role auto-fill) and
// MissionMap's per-group ship tokens — same UI, same composition shape
// ({ ship_slug, ship_name, ship_icon_url, quantity }), so one component
// instead of two drifting copies.
export default function ShipCompositionPicker({ composition, onChange }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(1);

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
    setOpen(false);
    setQuery('');
    setQty(1);

    // Adding a slug already in the composition bumps its quantity instead of
    // creating a second entry for the same ship — composition entries are
    // the claim system's unit of identity (event_group_ship_claims is keyed
    // by group_id + ship_slug + slot_index), so two rows sharing one slug
    // would collide/misattribute claims against each other.
    const existingIdx = composition.findIndex(c => c.ship_slug === ship.slug);
    if (existingIdx !== -1) {
      onChange(composition.map((c, i) => i === existingIdx ? { ...c, quantity: c.quantity + Math.max(1, qty) } : c));
      return;
    }

    // Snapshot the ship's length so map tokens can scale to actual ship
    // size — same denormalized-snapshot rationale as name/icon_url above.
    // Fetched before the single onChange call (rather than patched in after)
    // so there's no race with the composition changing in between.
    const { data } = await api.getShipDimensions('star_citizen', ship.slug);
    const length = typeof data?.dimensions?.length === 'number' ? data.dimensions.length : null;

    onChange([...composition, { ship_slug: ship.slug, ship_name: ship.name, ship_icon_url: ship.icon_url || null, quantity: Math.max(1, qty), length }]);
  };

  const removeEntry = (idx) => onChange(composition.filter((_, i) => i !== idx));
  const updateQty = (idx, q) => onChange(composition.map((c, i) => i === idx ? { ...c, quantity: Math.max(1, q) } : c));

  return (
    <div style={{ marginTop: 6 }}>
      {composition.map((c, idx) => (
        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#e5e7eb', padding: '3px 0' }}>
          {c.ship_icon_url && <img src={c.ship_icon_url} alt="" style={{ width: 18, height: 18, objectFit: 'contain' }} onError={e => { e.target.style.display = 'none'; }} />}
          <span style={{ flex: 1 }}>{c.ship_name}</span>
          <input type="number" min="1" value={c.quantity} onChange={e => updateQty(idx, parseInt(e.target.value) || 1)}
            style={{ width: 40, fontSize: 11, background: '#020c14', border: '1px solid #0e2233', color: '#e5e7eb', padding: '2px 4px' }} />
          <button onClick={() => removeEntry(idx)} style={{ fontSize: 11, color: '#7f1d1d', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>
      ))}
      {!open ? (
        <button onClick={() => setOpen(true)} style={{ fontSize: 10, color: '#0891b2', background: 'none', border: '1px dashed #0e4a5a', borderRadius: 3, padding: '4px 10px', cursor: 'pointer', marginTop: 3 }}>
          + ADD SHIP
        </button>
      ) : (
        <div style={{ position: 'relative', marginTop: 4 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search ships…"
              style={{ flex: 1, fontSize: 11, background: '#020c14', border: '1px solid #0e4a5a', color: '#e5e7eb', padding: '4px 6px' }}
            />
            <input type="number" min="1" value={qty} onChange={e => setQty(parseInt(e.target.value) || 1)}
              style={{ width: 40, fontSize: 11, background: '#020c14', border: '1px solid #0e4a5a', color: '#e5e7eb', padding: '4px' }} />
            <button onClick={() => setOpen(false)} style={{ fontSize: 10, color: '#0e7490', background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
          </div>
          {(searching || results.length > 0) && (
            <div style={{ maxHeight: 160, overflowY: 'auto', background: '#02070d', border: '1px solid #0e4a5a', borderRadius: 3, marginTop: 2 }}>
              {searching && <div style={{ padding: 6, fontSize: 11, color: '#0e7490' }}>Searching…</div>}
              {!searching && results.map(ship => (
                <button key={ship.slug} onClick={() => addShip(ship)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left', padding: '5px 6px', background: 'transparent', border: 'none', borderBottom: '1px solid #0a1e2e', cursor: 'pointer' }}>
                  {ship.icon_url && <img src={ship.icon_url} alt="" style={{ width: 18, height: 18, objectFit: 'contain' }} onError={e => { e.target.style.display = 'none'; }} />}
                  <span style={{ fontSize: 11, color: '#e5e7eb' }}>{ship.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
