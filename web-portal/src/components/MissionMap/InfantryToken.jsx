import React from 'react';
import { Html } from '@react-three/drei';

const SIZE = 34;

// Friendly ground-squad marker — additive/parallel to GroupToken (ship crews),
// deliberately not tied into the groups/roster system: a freeform entity
// created directly on the map, same as objectives/structures. Visually
// distinct (square badge, amber accent) so it reads as a different kind of
// unit from ship tokens at a glance.
export default function InfantryToken({ token, selected, canEdit, onSelect, onDragStart }) {
  const initials = (token.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'IN';

  return (
    <Html position={token.position} center distanceFactor={12} zIndexRange={[10, 0]}>
      <div
        onPointerDown={e => {
          e.stopPropagation();
          onSelect(token.id);
          if (canEdit) onDragStart(token.id);
        }}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          cursor: canEdit ? 'grab' : 'default', userSelect: 'none', fontFamily: 'monospace',
        }}
      >
        <div style={{
          width: SIZE, height: SIZE, borderRadius: 4, transform: 'rotate(45deg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(4,13,21,0.9)', border: `2px solid ${selected ? '#f59e0b' : '#84cc16'}`,
          boxShadow: selected ? '0 0 12px rgba(245,158,11,0.6)' : '0 0 8px rgba(132,204,22,0.4)',
          position: 'relative',
        }}>
          <span style={{ fontSize: 10, color: '#84cc16', transform: 'rotate(-45deg)' }}>{initials}</span>
          {token.personnel_count > 1 && (
            <span style={{
              position: 'absolute', bottom: -8, right: -8, fontSize: 9, fontWeight: 'bold', transform: 'rotate(-45deg)',
              background: '#65a30d', color: '#04101a', borderRadius: 8, padding: '1px 4px', lineHeight: 1.3,
            }}>×{token.personnel_count}</span>
          )}
        </div>
        <span style={{ fontSize: 9, color: '#a3e635', background: 'rgba(4,13,21,0.85)', padding: '1px 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {token.name}
        </span>
      </div>
    </Html>
  );
}
