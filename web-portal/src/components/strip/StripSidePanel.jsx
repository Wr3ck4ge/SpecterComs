// P2A: the strip window covers the whole monitor work area (see strip.rs,
// "Window = the whole work area" and its LAYOUT CONTRACT). This file places
// the bar/cabinet column (StripView) at the layout's `barRect`; everything
// else in the window is empty, outside the window region, and click-through.
// (It used to hold the two-column frame and the detached side panel; the
// side panel is gone — the Channels cabinet now widens itself, see
// useFluidExpand.js.)

import { cx } from '../ui/styles';

export const MAIN_WIDTH = 420; // keep in sync with strip.rs MAIN_WIDTH
const MARGIN = 8; // strip.rs STRIP_MARGIN

/**
 * The layout before Rust has sent one (dev, or the first frame): the column
 * at the bottom-right of the viewport, free side left — what strip.rs
 * produces for a bottom taskbar with the tray at the right.
 */
function fallbackLayout(vw = window.innerWidth, vh = window.innerHeight) {
  const w = Math.max(1, Math.min(MAIN_WIDTH, vw - 2 * MARGIN));
  const x = Math.max(MARGIN, vw - MARGIN - w);
  const h = Math.max(1, vh - 2 * MARGIN);
  return {
    edge: 'bottom', grow: 'up', expand: 'left',
    barRect: { x, y: MARGIN, w, h },
    freeRect: { x: MARGIN, y: MARGIN, w: Math.max(0, x - MARGIN), h },
    workArea: { w: vw, h: vh },
    scale: window.devicePixelRatio || 1,
  };
}

/** Positions `children` (StripView) in the layout's bar column. */
export function StripFrame({ layout, grow = 'up', expand = 'left', aside = null, children }) {
  const base = layout?.barRect?.w > 0 ? layout : fallbackLayout();
  const r = base.barRect;
  const f = base.freeRect;
  return (
    <div className="relative h-full w-full">
      <div className="absolute" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
        {children}
      </div>
      {/* A wide panel (e.g. a game tool) in the free area beside the bar
          column: hugs the column's edge and the docked end. It carries its
          own data-strip-region. */}
      {aside && f?.w > 0 && (
        <div
          className={cx('absolute flex p-1.5 pointer-events-none',
            expand === 'right' ? 'justify-start' : 'justify-end',
            grow === 'down' ? 'items-start' : 'items-end')}
          style={{ left: f.x, top: f.y, width: f.w, height: f.h }}
        >
          <div className="pointer-events-auto">{aside}</div>
        </div>
      )}
    </div>
  );
}
