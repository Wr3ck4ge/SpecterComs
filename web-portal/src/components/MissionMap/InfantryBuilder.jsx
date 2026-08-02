import React from 'react';

const S = {
  btnCyan: { fontSize: 11, padding: '6px 14px', borderRadius: 3, cursor: 'pointer', letterSpacing: '0.1em', background: '#041e2e', border: '1px solid #0891b2', color: '#22d3ee', fontFamily: 'monospace' },
  btnDim: { fontSize: 11, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', letterSpacing: '0.05em', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', fontFamily: 'monospace' },
  input: { width: '100%', fontSize: 11, background: '#020c14', border: '1px solid #0e2233', color: '#e5e7eb', padding: '5px 8px', fontFamily: 'monospace' },
  label: { fontSize: 10, color: '#0e7490', letterSpacing: '0.15em', display: 'block', marginBottom: 4 },
};

const ELEVATION_STEP = 0.5;

// Infantry tokens are click-to-place, like objectives — not roster-driven
// like ship group tokens (see GroupToken.jsx / ShipCompositionPicker.jsx).
// Infantry is always ground-relative (no elevated toggle, unlike
// objectives/structures) — the elevation control here is just a manual
// stacking offset on top of the terrain contour.
export default function InfantryBuilder({ selected, placeMode, mapKind, onTogglePlaceMode, onUpdate, onDelete, onAdjustElevation }) {
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #0e2233' }}>
      <button
        onClick={onTogglePlaceMode}
        style={{ ...S.btnCyan, width: '100%', background: placeMode === 'infantry' ? '#65a30d' : '#041e2e', border: `1px solid ${placeMode === 'infantry' ? '#65a30d' : '#0891b2'}`, color: placeMode === 'infantry' ? '#04101a' : '#22d3ee' }}
      >
        {placeMode === 'infantry' ? 'CLICK MAP TO PLACE…' : '+ PLACE INFANTRY'}
      </button>

      {selected && (
        <div style={{ marginTop: 8, padding: 8, background: '#020c14', border: '1px solid #0e2233', borderRadius: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: '#a3e635' }}>EDIT SQUAD</span>
            <button onClick={() => onDelete(selected.id)} style={{ fontSize: 9, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>DELETE</button>
          </div>
          <input value={selected.name} onChange={e => onUpdate(selected.id, { name: e.target.value })} style={{ ...S.input, marginBottom: 6 }} maxLength={64} />
          <label style={S.label}>PERSONNEL</label>
          <input
            type="number" min={1} max={999} value={selected.personnel_count}
            onChange={e => onUpdate(selected.id, { personnel_count: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            style={S.input}
          />

          {mapKind === 'surface' && (
            <div style={{ marginTop: 6 }}>
              <label style={S.label}>ELEVATION (ground-relative)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={() => onAdjustElevation(-ELEVATION_STEP)} style={S.btnDim}>−</button>
                <span style={{ fontSize: 11, color: '#e5e7eb', fontFamily: 'monospace', minWidth: 34, textAlign: 'center' }}>{(selected.elevationOffset || 0).toFixed(1)}</span>
                <button onClick={() => onAdjustElevation(ELEVATION_STEP)} style={S.btnDim}>+</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
