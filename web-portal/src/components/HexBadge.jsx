import { useState } from 'react';
import { COLOR_MAP, HEX_PATH } from '../utils/orgColors';

// Hexagonal avatar / server logo. Shared by the main window (WarRoom) and the
// tray strip. Shows `imageUrl` when it loads, otherwise `letter` on a tinted fill.
// Palette and getOrgColor(index) live in utils/orgColors.js.

/**
 * letter:   fallback initial (upper-cased)
 * colorKey: one of ORG_COLORS (utils/orgColors.js)
 * size:     outer size in px
 * active:   brighter rim with a glow
 * online:   green presence dot, bottom-right
 * imageUrl: logo / avatar; falls back to the letter if it fails to load
 */
export default function HexBadge({ letter, colorKey = 'cyan', size = 44, active = false, online = false, imageUrl = null }) {
  const c = COLOR_MAP[colorKey] || COLOR_MAP.cyan;
  const inner = size * 0.84;
  const offset = (size - inner) / 2;
  const [imgErr, setImgErr] = useState(false);
  const showImage = imageUrl && !imgErr;
  const dot = Math.min(9, Math.max(6, Math.round(size * 0.3)));

  return (
    <div style={{ width: size, height: size, position: 'relative', flexShrink: 0 }}>
      {/* Border layer */}
      <div style={{
        clipPath: HEX_PATH,
        background: active ? c.glow : c.border,
        width: size, height: size,
        position: 'absolute',
        filter: active ? `drop-shadow(0 0 8px ${c.glow})` : 'none',
        opacity: active ? 1 : 0.75,
        transition: 'all 0.2s',
      }} />
      {/* Fill layer */}
      <div style={{
        clipPath: HEX_PATH,
        background: showImage ? 'transparent' : c.bg,
        width: inner, height: inner,
        position: 'absolute', top: offset, left: offset,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {showImage ? (
          <img
            src={imageUrl}
            alt=""
            onError={() => setImgErr(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span
            className="font-ui"
            style={{ color: c.text, fontWeight: 600, fontSize: Math.max(8, size * 0.36), lineHeight: 1, userSelect: 'none' }}
          >
            {(letter || '?').toUpperCase()}
          </span>
        )}
      </div>
      {/* Online dot */}
      {online && (
        <div style={{
          position: 'absolute', bottom: 0, right: 0,
          width: dot, height: dot, borderRadius: '50%',
          background: '#4ade80', boxShadow: '0 0 0 2px #081828',
        }} />
      )}
    </div>
  );
}
