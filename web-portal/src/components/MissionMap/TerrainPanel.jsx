import React from 'react';
import { TERRAIN_TEXTURES } from './terrain';

const TOOLS = ['raise', 'lower', 'flatten', 'paint'];

const S = {
  input: { width: '100%', fontSize: 11, background: '#020c14', border: '1px solid #0e2233', color: '#e5e7eb', padding: '5px 8px', fontFamily: 'monospace' },
  label: { fontSize: 9, color: '#0e7490', display: 'block', marginBottom: 2 },
};

// Terrain-editing side panel for a 'surface' map — tool select, brush
// size/strength, ground-texture swatches for the paint tool. Only rendered
// when the active map is a surface map and canEdit is true.
export default function TerrainPanel({ tool, brushSize, brushStrength, paintTexture, onChange, onReset }) {
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #0e2233' }}>
      <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.15em', marginBottom: 6 }}>TERRAIN</div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {TOOLS.map(t => (
          <button
            key={t}
            onClick={() => onChange({ tool: tool === t ? null : t })}
            style={{
              flex: 1, fontSize: 9, padding: '5px 4px', borderRadius: 3, cursor: 'pointer', textTransform: 'uppercase',
              background: tool === t ? '#0891b2' : '#020c14', border: '1px solid #0e2233',
              color: tool === t ? '#04101a' : '#9ca3af',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {tool && tool !== 'paint' && (
        <div style={{ fontSize: 9, color: '#0e7490', opacity: 0.7, marginBottom: 6 }}>
          {tool === 'flatten' ? 'Flattens toward baseline (0), not toward cursor height.' : 'Hold Shift to orbit the camera instead of sculpting.'}
        </div>
      )}

      <label style={S.label}>BRUSH SIZE</label>
      <input type="range" min="1" max="20" step="0.5" value={brushSize}
        onChange={e => onChange({ brushSize: Number(e.target.value) })}
        style={{ width: '100%', accentColor: '#0891b2', marginBottom: 6 }} />

      {tool !== 'paint' && (
        <>
          <label style={S.label}>BRUSH STRENGTH</label>
          <input type="range" min="0.1" max="2.0" step="0.1" value={brushStrength}
            onChange={e => onChange({ brushStrength: Number(e.target.value) })}
            style={{ width: '100%', accentColor: '#0891b2', marginBottom: 6 }} />
        </>
      )}

      {tool === 'paint' && (
        <>
          <label style={S.label}>TEXTURE</label>
          <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
            {TERRAIN_TEXTURES.map(tex => (
              <button
                key={tex}
                onClick={() => onChange({ paintTexture: tex })}
                title={tex}
                style={{
                  flex: 1, fontSize: 8, padding: '5px 2px', borderRadius: 3, cursor: 'pointer', textTransform: 'uppercase',
                  background: paintTexture === tex ? '#0891b2' : '#020c14',
                  border: `1px solid ${paintTexture === tex ? '#0891b2' : '#0e2233'}`,
                  color: paintTexture === tex ? '#04101a' : '#9ca3af',
                }}
              >
                {tex}
              </button>
            ))}
          </div>
        </>
      )}

      <button
        onClick={() => { if (window.confirm('Reset terrain to flat? This clears all sculpting and painted texture.')) onReset(); }}
        style={{ width: '100%', fontSize: 9, padding: '5px 4px', background: '#1a0e0e', border: '1px solid #7f1d1d', color: '#ef4444', cursor: 'pointer', borderRadius: 3, marginTop: 4 }}
      >
        RESET TERRAIN
      </button>
    </div>
  );
}
