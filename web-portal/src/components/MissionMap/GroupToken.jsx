import React from 'react';
import { Html } from '@react-three/drei';

// Marker diameter scaled from the composition's largest ship length (meters,
// snapshotted onto each entry by ShipCompositionPicker — see
// getShipDimensions). Sqrt-based so a capital ship reads as visibly bigger
// than a fighter without dominating the map at 10x the size. No length data
// (older compositions, or a lookup miss) falls back to the previous fixed
// 36px.
function scaleForLength(length) {
  if (typeof length !== 'number' || length <= 0) return 36;
  const px = 24 + Math.sqrt(length) * 3;
  return Math.max(26, Math.min(80, Math.round(px)));
}

// One marker per group — vehicles in a group move together as a single
// placeable unit rather than being scattered as independent tokens (e.g. a
// 3-fighter wing is one token badged "×3", not 3 separate draggable icons).
export default function GroupToken({ token, groupName, selected, canEdit, onSelect, onDragStart }) {
  const composition = token.composition || [];
  const totalQty = composition.reduce((sum, c) => sum + (c.quantity || 1), 0);
  const primary = composition[0];
  const maxLength = composition.reduce((max, c) => Math.max(max, c.length || 0), 0);
  const size = scaleForLength(maxLength);
  const iconSize = Math.round(size * 0.66);

  return (
    <Html position={token.position} center distanceFactor={12} zIndexRange={[10, 0]}>
      <div
        onPointerDown={e => {
          e.stopPropagation();
          onSelect(token.group_index);
          if (canEdit) onDragStart(token.group_index);
        }}
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          cursor: canEdit ? 'grab' : 'default', userSelect: 'none', fontFamily: 'monospace',
        }}
      >
        <div style={{
          width: size, height: size, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(4,13,21,0.9)', border: `2px solid ${selected ? '#f59e0b' : '#22d3ee'}`,
          boxShadow: selected ? '0 0 12px rgba(245,158,11,0.6)' : '0 0 8px rgba(34,211,238,0.4)',
          position: 'relative',
        }}>
          {primary?.ship_icon_url ? (
            <img src={primary.ship_icon_url} alt="" style={{ width: iconSize, height: iconSize, objectFit: 'contain' }} onError={e => { e.target.style.display = 'none'; }} />
          ) : (
            <span style={{ fontSize: 10, color: '#22d3ee' }}>{(groupName || '?').slice(0, 2).toUpperCase()}</span>
          )}
          {totalQty > 1 && (
            <span style={{
              position: 'absolute', bottom: -4, right: -4, fontSize: 9, fontWeight: 'bold',
              background: '#0891b2', color: '#04101a', borderRadius: 8, padding: '1px 4px', lineHeight: 1.3,
            }}>×{totalQty}</span>
          )}
        </div>
        <span style={{ fontSize: 9, color: '#67e8f9', background: 'rgba(4,13,21,0.85)', padding: '1px 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {groupName}
        </span>
      </div>
    </Html>
  );
}
