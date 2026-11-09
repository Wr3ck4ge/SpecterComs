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
//        │   video, at the stream's aspect │
//        └────────────────────────────────┘
//                  [ server | icons       ]   ← main bar
//
// Default ~480×270 of video (for 16:9) at a 1040px-tall work area, scaled
// with the work area's height; expanded: up to 70% of the work area either
// way. Always clamped to the room above (below) the bar. Rects are window
// CSS px; the panel is position: fixed.

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

/** The viewer's video area follows the stream's aspect within these
 *  (a 32:9 share is 3.56; a portrait one is shown in a square box). */
export const SV_ASPECT_MIN = 1;
export const SV_ASPECT_MAX = 4;
const BASE_ASPECT = 16 / 9;

/** Stream aspect → the aspect the viewer's video area uses. */
export function viewerAspect(aspect) {
  return aspect > 0 && Number.isFinite(aspect) ? clamp(aspect, SV_ASPECT_MIN, SV_ASPECT_MAX) : BASE_ASPECT;
}

/** Mini-mode thumbnail height for the stream's aspect (63 at 16:9). */
export function miniThumbH(aspect) {
  return Math.round(SV_LAYOUT.miniThumbW / viewerAspect(aspect));
}

/**
 * vw, vh     window (= work area) size
 * bar        main bar rect { left, top, right, bottom }
 * grow       'up' | 'down'
 * expanded   the large size
 * aspect     the stream's width / height (default 16:9). The video area is
 *            sized to it, so an ultrawide share gets a wide, short panel
 *            rather than a 16:9 one with bars drawn inside. Its width is
 *            what's sized for a 16:9 stream, widened (still within the room
 *            beside the bar) for a wider one so its height doesn't collapse.
 * Returns { left, width, videoH, height, top? , bottom?, toLeft, canExpand }
 */
export function streamViewerLayout({ vw, vh, bar, grow = 'up', expanded = false, aspect = BASE_ASPECT }) {
  const { margin: m, gap, headerH } = SV_LAYOUT;
  const ar = viewerAspect(aspect);
  const barW = Math.max(0, bar.right - bar.left);
  const freeLeft = bar.right - m;
  const freeRight = vw - bar.left - m;
  const toLeft = freeLeft >= freeRight;
  const availW = Math.max(barW, toLeft ? freeLeft : freeRight);
  const availH = grow === 'down' ? vh - m - (bar.bottom + gap) : bar.top - gap - m;
  const maxByH = Math.max(0, availH - headerH) * ar;
  const fit = (w) => Math.round(Math.max(Math.min(SV_LAYOUT.minW, availW, maxByH), Math.min(w, availW, maxByH)));
  // Wider than 16:9: grow the width with the square root of the extra
  // aspect, so a 32:9 share is ~1.4× as wide and ~0.7× as tall as a 16:9 one
  // (about the same area) instead of the same width at half the height.
  const widen = ar > BASE_ASPECT ? Math.sqrt(ar / BASE_ASPECT) : 1;

  const defaultW = fit(clamp(SV_LAYOUT.baseW * (vh / SV_LAYOUT.refH), SV_LAYOUT.minW, SV_LAYOUT.maxDefaultW) * widen);
  const bigW = fit(Math.min(vw * SV_LAYOUT.expandFrac, (vh * SV_LAYOUT.expandFrac - headerH) * ar));
  const canExpand = bigW > defaultW + 40;
  const width = expanded && canExpand ? bigW : defaultW;
  const videoH = Math.round(width / ar);
  const left = Math.round(toLeft ? bar.right - width : bar.left);
  const pos = grow === 'down'
    ? { top: Math.round(bar.bottom + gap) }
    : { bottom: Math.round(vh - (bar.top - gap)) };
  return { left, width, videoH, height: videoH + headerH, ...pos, toLeft, canExpand };
}
