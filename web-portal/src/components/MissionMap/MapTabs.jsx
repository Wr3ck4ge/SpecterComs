import React, { useState } from 'react';
import { MAP_KINDS } from './types';

const tabStyle = (active) => ({
  fontSize: 10, padding: '6px 12px', cursor: 'pointer', letterSpacing: '0.08em', fontFamily: 'monospace',
  background: active ? '#0891b2' : '#020c14', color: active ? '#04101a' : '#9ca3af',
  border: '1px solid #0e2233', borderBottom: 'none', borderRadius: '3px 3px 0 0',
  display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
});

// Tab strip for switching/managing the planning canvases attached to an
// event (e.g. a space muster/routing map plus one or more planet/moon
// surface maps). Entities reference whichever map they're on via `mapId`
// rather than being nested per-map — see types.js.
export default function MapTabs({ maps, activeMapId, canEdit, countsByMapId, onSwitch, onAdd, onRename, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('space');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const sorted = [...maps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const commitAdd = () => {
    const name = newName.trim();
    if (name) onAdd(name, newKind);
    setAdding(false);
    setNewName('');
    setNewKind('space');
  };

  const commitRename = (id) => {
    const name = renameValue.trim();
    if (name) onRename(id, name);
    setRenamingId(null);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, padding: '8px 16px 0', background: '#040d15', borderBottom: '1px solid #0e2233', flexShrink: 0 }}>
      {sorted.map(map => (
        <div
          key={map.id}
          style={tabStyle(map.id === activeMapId)}
          onClick={() => onSwitch(map.id)}
          onDoubleClick={() => { if (canEdit) { setRenamingId(map.id); setRenameValue(map.name); } }}
        >
          {renamingId === map.id ? (
            <input
              autoFocus
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={() => commitRename(map.id)}
              onKeyDown={e => { if (e.key === 'Enter') commitRename(map.id); if (e.key === 'Escape') setRenamingId(null); }}
              onClick={e => e.stopPropagation()}
              style={{ fontSize: 10, fontFamily: 'monospace', width: 90, background: '#020c14', border: '1px solid #0891b2', color: '#e5e7eb', padding: '1px 4px' }}
            />
          ) : (
            <>
              <span>{map.name}</span>
              <span style={{ fontSize: 8, opacity: 0.6, textTransform: 'uppercase' }}>{map.kind}</span>
            </>
          )}
          {canEdit && maps.length > 1 && renamingId !== map.id && (
            <span
              onClick={e => {
                e.stopPropagation();
                const count = countsByMapId?.[map.id] || 0;
                const msg = count > 0
                  ? `Delete map "${map.name}"? ${count} placed item${count === 1 ? '' : 's'} on it will be removed.`
                  : `Delete map "${map.name}"?`;
                if (window.confirm(msg)) onDelete(map.id);
              }}
              style={{ fontSize: 10, opacity: 0.6, cursor: 'pointer', marginLeft: 2 }}
            >×</span>
          )}
        </div>
      ))}

      {canEdit && (adding ? (
        <div style={{ ...tabStyle(false), cursor: 'default', gap: 4 }}>
          <input
            autoFocus
            placeholder="Map name"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitAdd(); if (e.key === 'Escape') setAdding(false); }}
            style={{ fontSize: 10, fontFamily: 'monospace', width: 90, background: '#020c14', border: '1px solid #0891b2', color: '#e5e7eb', padding: '1px 4px' }}
          />
          <select value={newKind} onChange={e => setNewKind(e.target.value)} style={{ fontSize: 9, fontFamily: 'monospace', background: '#020c14', border: '1px solid #0e2233', color: '#e5e7eb' }}>
            {MAP_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          <span onClick={commitAdd} style={{ fontSize: 10, color: '#22d3ee', cursor: 'pointer' }}>✓</span>
          <span onClick={() => setAdding(false)} style={{ fontSize: 10, color: '#ef4444', cursor: 'pointer' }}>✕</span>
        </div>
      ) : (
        <div style={tabStyle(false)} onClick={() => setAdding(true)}>+ ADD MAP</div>
      ))}
    </div>
  );
}
