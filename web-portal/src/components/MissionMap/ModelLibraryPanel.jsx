import React, { useRef, useState } from 'react';

const ELEVATION_STEP = 0.5;

// Bundled, pre-approved models shipped with the app (served from
// web-portal/public/models/), picked from a fixed palette rather than
// uploaded. Empty for now — this app deliberately avoids extracting real
// Star Citizen assets into a commercial tool (see terrain.js's note on the
// same concern for terrain data), so populating this requires sourcing
// royalty-free/original .glb files, dropping them under public/models/, and
// listing them here as { name, url: '/models/<file>.glb' }.
const MODEL_LIBRARY = [];

// Mirrors StructureBuilder's shape (add / selected-entity edit panel) but
// for freeform imported .glb/.gltf models — either picked from the bundled
// MODEL_LIBRARY above or uploaded by the user via the server (see
// api.uploadEventMapModel). Upload targets the same event_map_layouts-backed
// layout as everything else on the map; the file itself lives under
// UPLOADS_BASE/map-models/ on the server (see eventsController.ts).
export default function ModelLibraryPanel({ asset, mapKind, canUpload, uploading, uploadError, onAddFromLibrary, onUpload, onUpdate, onDelete, onAdjustElevation, onToggleElevated }) {
  const fileInputRef = useRef(null);
  const [pickedName, setPickedName] = useState('');

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPickedName(file.name.replace(/\.(glb|gltf)$/i, ''));
    onUpload(file);
  };

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #0e2233' }}>
      <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.15em', marginBottom: 6 }}>3D MODELS</div>

      {MODEL_LIBRARY.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {MODEL_LIBRARY.map(m => (
            <button key={m.url} onClick={() => onAddFromLibrary(m)}
              style={{ flex: '1 0 45%', fontSize: 9, padding: '5px 4px', background: '#020c14', border: '1px solid #0e2233', color: '#9ca3af', cursor: 'pointer', borderRadius: 3 }}>
              + {m.name}
            </button>
          ))}
        </div>
      )}

      <input ref={fileInputRef} type="file" accept=".glb,.gltf" onChange={handleFileChange} style={{ display: 'none' }} />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        style={{ width: '100%', fontSize: 10, padding: '6px 8px', background: '#041e2e', border: '1px solid #0891b2', color: '#22d3ee', cursor: uploading ? 'default' : 'pointer', borderRadius: 3, opacity: uploading ? 0.6 : 1 }}
      >
        {uploading ? `UPLOADING ${pickedName || ''}…` : '+ UPLOAD MODEL (.glb/.gltf)'}
      </button>
      {uploadError && <div style={{ fontSize: 9, color: '#ef4444', marginTop: 4 }}>{uploadError}</div>}

      {asset && (
        <div style={{ marginTop: 8, padding: 8, background: '#020c14', border: '1px solid #0e2233', borderRadius: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: '#c4b5fd', fontFamily: 'monospace' }}>{asset.name}</span>
            <button onClick={() => onDelete(asset.id)} style={{ fontSize: 9, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>DELETE</button>
          </div>
          <input value={asset.name} onChange={e => onUpdate(asset.id, { name: e.target.value })}
            style={{ width: '100%', fontSize: 11, background: '#020c14', border: '1px solid #0e2233', color: '#e5e7eb', padding: '5px 8px', fontFamily: 'monospace', marginBottom: 6 }} maxLength={64} />
          <label style={{ fontSize: 9, color: '#0e7490', display: 'block', marginBottom: 2 }}>SCALE</label>
          <input type="range" min="0.1" max="8" step="0.1" value={asset.scale[0]}
            onChange={e => { const v = Number(e.target.value); onUpdate(asset.id, { scale: [v, v, v] }); }}
            style={{ width: '100%', accentColor: '#7c3aed' }} />

          {mapKind === 'surface' && (
            <div style={{ marginTop: 6 }}>
              <label style={{ fontSize: 9, color: '#0e7490', display: 'block', marginBottom: 2 }}>{asset.elevated ? 'ELEVATION (base plane)' : 'ELEVATION (ground-relative)'}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={() => onAdjustElevation(-ELEVATION_STEP)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', fontFamily: 'monospace' }}>−</button>
                <span style={{ fontSize: 11, color: '#e5e7eb', fontFamily: 'monospace', minWidth: 34, textAlign: 'center' }}>{(asset.elevationOffset || 0).toFixed(1)}</span>
                <button onClick={() => onAdjustElevation(ELEVATION_STEP)} style={{ fontSize: 11, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', fontFamily: 'monospace' }}>+</button>
                <button onClick={onToggleElevated} style={{ fontSize: 9, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', fontFamily: 'monospace', marginLeft: 'auto' }}>
                  {asset.elevated ? 'USE GROUND' : 'USE BASE PLANE'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
