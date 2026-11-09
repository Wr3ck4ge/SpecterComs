import React from 'react';
import { STRUCTURE_TYPES } from './types';

const ELEVATION_STEP = 0.5;

// Fresh implementation, not a port — the source project's structure builder
// never worked reliably. Same concept (add a structure, then scale/color-edit
// whichever one is selected), own clean implementation.
export default function StructureBuilder({ structures, selectedId, mapKind, onAdd, onUpdate, onDelete, onAdjustElevation, onToggleElevated }) {
  const selected = structures.find(s => s.id === selectedId);

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #0e2233' }}>
      <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.15em', marginBottom: 6 }}>STRUCTURES</div>
      <div style={{ display: 'flex', gap: 4 }}>
        {STRUCTURE_TYPES.map(type => (
          <button key={type} onClick={() => onAdd(type)}
            style={{ flex: 1, fontSize: 9, padding: '5px 4px', background: '#020c14', border: '1px solid #0e2233', color: '#9ca3af', cursor: 'pointer', borderRadius: 3 }}>
            + {type}
          </button>
        ))}
      </div>
      {selected && (
        <div style={{ marginTop: 8, padding: 8, background: '#020c14', border: '1px solid #0e2233', borderRadius: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: '#22d3ee', fontFamily: 'monospace' }}>{selected.name}</span>
            <button onClick={() => onDelete(selected.id)} style={{ fontSize: 9, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>DELETE</button>
          </div>
          <label style={{ fontSize: 9, color: '#0e7490', display: 'block', marginBottom: 2 }}>SCALE</label>
          <input type="range" min="0.2" max="8" step="0.1" value={selected.scale[0]}
            onChange={e => { const v = Number(e.target.value); onUpdate(selected.id, { scale: [v, v, v] }); }}
            style={{ width: '100%', accentColor: '#0891b2' }} />
          <label style={{ fontSize: 9, color: '#0e7490', display: 'block', marginTop: 6, marginBottom: 2 }}>COLOR</label>
          <input type="color" value={selected.color} onChange={e => onUpdate(selected.id, { color: e.target.value })}
            style={{ width: '100%', height: 22, background: 'transparent', border: '1px solid #0e2233', cursor: 'pointer' }} />

          {mapKind === 'surface' && (
            <div style={{ marginTop: 6 }}>
              <label style={{ fontSize: 9, color: '#0e7490', display: 'block', marginBottom: 2 }}>{selected.elevated ? 'ELEVATION (base plane)' : 'ELEVATION (ground-relative)'}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={() => onAdjustElevation(-ELEVATION_STEP)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', fontFamily: 'monospace' }}>−</button>
                <span style={{ fontSize: 11, color: '#e5e7eb', fontFamily: 'monospace', minWidth: 34, textAlign: 'center' }}>{(selected.elevationOffset || 0).toFixed(1)}</span>
                <button onClick={() => onAdjustElevation(ELEVATION_STEP)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', fontFamily: 'monospace' }}>+</button>
                <button onClick={onToggleElevated} style={{ fontSize: 9, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', fontFamily: 'monospace', marginLeft: 'auto' }}>
                  {selected.elevated ? 'USE GROUND' : 'USE BASE PLANE'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
