// Server / avatar tint palette used by HexBadge. Kept out of HexBadge.jsx so
// that file only exports components (React fast refresh).

export const ORG_COLORS = ['cyan', 'purple', 'green', 'yellow', 'blue', 'orange'];

export const COLOR_MAP = {
  cyan:   { bg: '#041e26', border: '#0891b2', text: '#67e8f9', glow: '#06b6d4' },
  purple: { bg: '#130d24', border: '#7c3aed', text: '#c084fc', glow: '#9333ea' },
  green:  { bg: '#031a0e', border: '#16a34a', text: '#86efac', glow: '#22c55e' },
  yellow: { bg: '#1c1300', border: '#ca8a04', text: '#fde047', glow: '#eab308' },
  blue:   { bg: '#050f24', border: '#2563eb', text: '#93c5fd', glow: '#3b82f6' },
  orange: { bg: '#1c0a00', border: '#c2410c', text: '#fdba74', glow: '#f97316' },
};

/** Colour key for the server at `index` in the server list. */
export function getOrgColor(index) {
  return ORG_COLORS[index % ORG_COLORS.length];
}

export const HEX_PATH = 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)';
