// SV: placement of the strip's stream viewer (StripStreamViewer). Kept out
// of the component file for fast refresh.
//
// The viewer is its own panel stacked directly above the main bar (below it
// when the taskbar is at the top), anchored to the bar's outer edge like the
// wide op panel (wideOpLayout) and extending toward the free side:
//
//        ┌──────────── viewer ────────────┐
//        │ ● LIVE  Kestrel       ⤢  ◫  ✕ │   ← header
//        │                                │
//        │           16:9 video           │
//        └────────────────────────────────┘
//                  [ server | icons       ]   ← main bar
//
// Default ~480×270 of video at a 1040px-tall work area, scaled with the work
// area's height; expanded: up to 70% of the work area either way. Always
// clamped to the room above (below) the bar. Rects are window CSS px; the
// panel is position: fixed.

export const SV_LAYOUT = Object.freeze({
  margin: 8,        // from the window edges
  gap: 8,           // between the bar and the viewer
  headerH: 36,
  baseW: 480,       // video width at refH
  refH: 1040,       // work-area height the base size is for (1080p minus a taskbar)
  minW: 320,
  maxDefaultW: 720,
  expandFrac: 0.7,  // expanded: at most this share of the work area's width and height
  miniThumbW: 112,  // mini (a cabinet is open): thumbnail width
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * vw, vh     window (= work area) size
 * bar        main bar rect { left, top, right, bottom }
 * grow       'up' | 'down'
 * expanded   the large size
 * Returns { left, width, videoH, height, top? , bottom?, toLeft, canExpand }
 */
export function streamViewerLayout({ vw, vh, bar, grow = 'up', expanded = false }) {
  const { margin: m, gap, headerH } = SV_LAYOUT;
  const barW = Math.max(0, bar.right - bar.left);
  const freeLeft = bar.right - m;
  const freeRight = vw - bar.left - m;
  const toLeft = freeLeft >= freeRight;
  const availW = Math.max(barW, toLeft ? freeLeft : freeRight);
  const availH = grow === 'down' ? vh - m - (bar.bottom + gap) : bar.top - gap - m;
  const maxByH = Math.max(0, availH - headerH) * (16 / 9);
  const fit = (w) => Math.round(Math.max(Math.min(SV_LAYOUT.minW, availW, maxByH), Math.min(w, availW, maxByH)));

  const defaultW = fit(clamp(SV_LAYOUT.baseW * (vh / SV_LAYOUT.refH), SV_LAYOUT.minW, SV_LAYOUT.maxDefaultW));
  const bigW = fit(Math.min(vw * SV_LAYOUT.expandFrac, (vh * SV_LAYOUT.expandFrac - headerH) * (16 / 9)));
  const canExpand = bigW > defaultW + 40;
  const width = expanded && canExpand ? bigW : defaultW;
  const videoH = Math.round(width * 9 / 16);
  const left = Math.round(toLeft ? bar.right - width : bar.left);
  const pos = grow === 'down'
    ? { top: Math.round(bar.bottom + gap) }
    : { bottom: Math.round(vh - (bar.top - gap)) };
  return { left, width, videoH, height: videoH + headerH, ...pos, toLeft, canExpand };
}
