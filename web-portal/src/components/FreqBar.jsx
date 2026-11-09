import React from 'react';

// Frequency bar shared by the native overlay and the in-app fallback. Always
// mounted at a fixed height (0 when nobody speaks) so it only offsets what is
// below it; chips come from engine/freqBar.js freqBarChips().
export default function FreqBar({ chips, height }) {
  return (
    <div
      aria-hidden={height === 0}
      style={{
        height, overflow: 'hidden', flexShrink: 0, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 4, padding: height ? '0 4px' : 0,
        background: '#050d17', WebkitAppRegion: 'no-drag',
      }}
    >
      {height > 0 && chips.map((c) => {
        const color = c.mission ? '#f87171' : '#22c55e';
        return (
          <div
            key={c.key}
            title={`${c.label}${c.speaker ? ` · ${c.speaker}` : ''}${c.tx ? ' (TX)' : ''}`}
            style={{
              flex: '1 1 0', minWidth: 0, display: 'flex', alignItems: 'center', gap: 5,
              height: 22, boxSizing: 'border-box', padding: '0 7px', borderRadius: 11,
              border: `1px solid ${c.mission ? 'rgba(248,113,113,0.6)' : 'rgba(34,197,94,0.4)'}`,
              background: c.mission ? 'rgba(127,29,29,0.35)' : 'rgba(6,78,59,0.25)',
              color, fontFamily: 'monospace', fontSize: 10, letterSpacing: '0.04em',
              whiteSpace: 'nowrap', overflow: 'hidden',
            }}
          >
            <span style={{ fontSize: 7, flexShrink: 0 }}>◉</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: c.mission ? 700 : 400 }}>
              {c.tx ? '▲ ' : ''}{c.label}{c.speaker ? ` · ${c.speaker}` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
