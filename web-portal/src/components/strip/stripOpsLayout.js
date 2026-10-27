// Non-component helpers for the strip's ops UI (kept out of stripOpsUi.jsx so
// that file only exports components, for fast refresh).
import { createContext, useEffect, useState } from 'react';
import { cx } from '../ui/styles';
import { layoutTree } from '../../utils/treeLayout';
import { buildGroupTree } from '../../utils/eventGroups';

export const inputClass = cx(
  'w-full h-8 px-2.5 rounded-ui-row text-ui-sm text-specter-text-main placeholder:text-specter-text-subtle',
  'bg-specter-bg-deep/60 border border-specter-border hover:border-specter-border-strong focus:border-specter-primary-cyan focus:outline-none',
);

// "in 12 min" / "in 3 h" / "started 5 min ago".
export function relTime(ts, now = new Date()) {
  const diff = new Date(ts) - now;
  const mins = Math.round(Math.abs(diff) / 60000);
  const span = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} d`;
  if (mins < 1) return diff >= 0 ? 'now' : 'just started';
  return diff >= 0 ? `in ${span}` : `started ${span} ago`;
}

// Window height in CSS px, kept current on resize (the strip window can be
// clamped to a small work area, so panels size themselves from it).
export function useViewportHeight() {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return h;
}

// Window size in CSS px, kept current on resize. The strip window may cover
// the whole monitor work area (clipped to the panels' region), so the wide
// op panel sizes itself from this.
export function useViewportSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize((s) => (s.w === window.innerWidth && s.h === window.innerHeight ? s : { w: window.innerWidth, h: window.innerHeight }));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

// ── Wide op panel (planner / op view) ──────────────────────────────────────
// The planner opens as a large panel in the free work area beside/above the
// bar, with a slim secondary bar directly above the main bar:
//
//        ┌──────────────────────────── panel ─────────────┐
//        │                                                 │
//        └─────────────────────────────────────────────────┘
//        [ steps ············ status · save · launch · next · ✕ ]  ← secondary bar
//        [ page tools (EVT2 sub-row, only when the page has some) ]
//                                      [ server | icons   ]   ← main bar
//
// Both share the main bar's outer edge (right edge when the free space is to
// the left) and extend toward the free side, so they read as one column
// growing out of the bar. Taskbar on top (grow 'down') mirrors it vertically.
// All rects are in window CSS px; the elements are position: fixed.
export const WIDE = {
  margin: 8,        // from the window edges
  gap: 8,           // between bar, secondary bar and panel
  bar2: 48,         // secondary bar height
  sub: 40,          // EVT2: the secondary bar's page-tools sub-row (when shown)
  subMs: 150,       // EVT2: sub-row slide / fade
  planMaxW: 1440,
  viewMaxW: 1440,   // the view sizes to its tree; this only lets a wide tree open bigger
  maxH: 940,
};

/**
 * vw, vh     window size
 * bar        main bar rect { left, top, right, bottom } (window px)
 * grow       'up' | 'down'
 * kind       'plan' (up to planMaxW wide) | 'view' (up to viewMaxW)
 * Returns { panel: { left, right, width, top?, bottom?, maxHeight }, bar2: { left, top, width, height },
 *           toLeft, grow, compact }
 * OPGROW: panel.width / maxHeight are the panel's MAXIMUM size; the panel
 * itself sizes to its content (WideOpFrame).
 */
export function wideOpLayout({ vw, vh, bar, grow = 'up', kind = 'plan' }) {
  const { margin: m, gap } = WIDE;
  const barW = Math.max(0, bar.right - bar.left);
  const freeLeft = bar.right - m;          // grow leftward from the bar's right edge
  const freeRight = vw - bar.left - m;     // grow rightward from the bar's left edge
  const toLeft = freeLeft >= freeRight;
  const avail = Math.max(barW, toLeft ? freeLeft : freeRight);
  const maxW = kind === 'plan' ? WIDE.planMaxW : WIDE.viewMaxW;
  const width = Math.round(Math.min(avail, Math.max(barW, maxW)));
  const left = Math.round(toLeft ? bar.right - width : bar.left);

  // OPGROW: the read-only view gets the secondary bar too (title + actions),
  // so both open as "bar first, then the panel grows out of it".
  const bar2H = WIDE.bar2;
  let bar2;
  let panel;
  if (grow === 'down') {
    const bar2Top = bar.bottom + gap;
    const top = bar2Top + bar2H + gap;
    panel = { left, width, top: Math.round(top), maxHeight: Math.max(160, Math.min(WIDE.maxH, vh - m - top)) };
    bar2 = { left, top: Math.round(bar2Top), width, height: bar2H };
  } else {
    const bar2Top = bar.top - gap - bar2H;
    const bottomEdge = bar2Top - gap;
    panel = { left, width, bottom: Math.round(vh - bottomEdge), maxHeight: Math.max(160, Math.min(WIDE.maxH, bottomEdge - m)) };
    bar2 = { left, top: Math.round(bar2Top), width, height: bar2H };
  }
  // OPGROW: the panel is anchored to the bar's outer edge (right edge when it
  // grows leftward) so a narrower-than-max panel still hugs that edge and
  // widening moves only the free side. `right` is from the window's right.
  panel.right = Math.round(vw - (left + width));
  // EVT2: the bar-side edge as a distance from the window's bottom (grow up)
  // so the secondary bar can grow away from the main bar with a sub-row.
  bar2.bottom = Math.round(vh - (bar2.top + bar2H));
  return { panel, bar2, toLeft, grow, compact: width < 900 };
}

/**
 * EVT2: wideOpLayout() with the secondary bar's tools sub-row shown (subH px,
 * 0 = hidden). The sub-row sits between the bar's main row and the main bar,
 * so the main row and the panel move away from the main bar by subH and the
 * panel's maximum height shrinks by as much.
 */
export function withSubRow(layout, subH) {
  if (!subH) return layout;
  const { panel, grow = 'up' } = layout;
  const moved = grow === 'down' ? { top: panel.top + subH } : { bottom: panel.bottom + subH };
  return { ...layout, panel: { ...panel, ...moved, maxHeight: Math.max(160, panel.maxHeight - subH) } };
}

// ── OPGROW: dynamic op panel sizing ─────────────────────────────────────────
// The op panel opens as just the secondary bar; the content panel then grows
// out of it to the current page's natural size (clamped to wideOpLayout's
// max), and collapses back into the bar before the bar closes.
export const OPGROW = {
  barInMs: 150,     // secondary bar slides out of the main bar
  growMs: 220,      // panel width / height transitions
  barOutMs: 140,    // secondary bar leaves after the panel has collapsed
  minW: 420,        // never narrower than the main bar
  headerH: 60,      // planner panel header (for the body max height)
  bodyPad: 32,      // body vertical padding
};

// WideOpFrame provides { notifyRegion } so things that pop out of it (bar
// popovers, carrying their own data-strip-region) can ask for a re-measure.
export const OpFrameContext = createContext(null);

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// Dev preview only: ?slow=N multiplies the op panel's durations (to catch a
// mid-transition frame in a screenshot).
export function opGrowScale() {
  try { return Number(new URLSearchParams(window.location.search).get('opslow')) || 1; } catch { return 1; }
}

/** Close delay (panel collapse + bar exit) for the target's closing phase. */
export function opCloseDelay() {
  if (prefersReducedMotion()) return 0;
  return (OPGROW.growMs + OPGROW.barOutMs) * opGrowScale() + 40;
}

// Group tree node sizes (StripGroupTree), shared so panels can size
// themselves to a tree before it renders.
export const GROUP_TREE_SIZES = {
  compact: { node: { w: 96, h: 40 }, options: { siblingGap: 8, subtreeGap: 12, levelGap: 22, stub: 8 } },
  // EVT2: near-square cards (name ×2 lines, 120×56 ship image, ship, tier ·
  // slots, seat dots) — about twice the old 68px height. The gaps grew a
  // little with them so tiers and families still read apart.
  wide: { node: { w: 164, h: 162 }, options: { siblingGap: 16, subtreeGap: 30, levelGap: 44, stub: 14 } },
};

/** The laid-out tree's { width, height } in px (canvas only, no padding). */
export function groupTreeSize(groups, variant = 'wide') {
  if (!groups?.length) return { width: 0, height: 0 };
  const { node, options } = GROUP_TREE_SIZES[variant] || GROUP_TREE_SIZES.compact;
  const { roots, childrenMap } = buildGroupTree(groups);
  const { width, height } = layoutTree({ roots, childrenOf: (i) => childrenMap[i] || [], sizeOf: () => node, options });
  return { width, height };
}

/** Seats in a group: members vs. the sum of its roles' slots. */
export function groupSeatFill(g) {
  const roles = g.roles || [];
  const total = roles.reduce((n, r) => n + (Number(r.max_slots) || 1), 0);
  const members = (g.member_user_ids || []).length;
  return { members, total };
}

// ── EVVIEW: tree-first op view ──────────────────────────────────────────────
// The read-only op view is the group tree alone, in a panel sized to the
// tree; event details live in a drawer beside the panel, and a group's roles
// in a cabinet inside the tree view.
export const EVVIEW = {
  padX: 24,          // tree viewport padding around the laid-out tree
  padTop: 52,        // room for the zoom controls row
  padBottom: 24,
  minH: 200,         // smallest tree viewport
  cabW: 336,         // roles cabinet width (inside the tree view)
  cabGap: 10,        // cabinet inset from the viewport edges
  selMinW: 740,      // panel width wanted while a group's cabinet is open
  selMinH: 470,      // … and height
  drawerW: 344,      // event details drawer
  drawerGap: 8,
  zoomMs: 420,       // camera moves (select / fit)
  selK: 1.25,        // zoom when a group is selected
  minFitK: 0.8,      // fit never shrinks below this; past it the tree pans
  minK: 0.3,
  maxK: 2.5,
};

/**
 * Camera that fits a w×h tree in a vw×vh viewport (EVVIEW padding): scaled
 * down to at most 1, never below minFitK; centred, or (when it still doesn't
 * fit) anchored at the bottom tier, which is the root tier next to the bar.
 */
export function fitTransform(tree, vp) {
  const { padX, padTop, padBottom, minFitK } = EVVIEW;
  const availW = Math.max(40, vp.w - 2 * padX);
  const availH = Math.max(40, vp.h - padTop - padBottom);
  const k = Math.max(Math.min(minFitK, 1), Math.min(1, availW / Math.max(1, tree.width), availH / Math.max(1, tree.height)));
  const w = tree.width * k;
  const h = tree.height * k;
  const x = padX + (availW - w) / 2; // centred (a too-wide tree overflows evenly)
  const y = h <= availH ? padTop + (availH - h) / 2 : vp.h - padBottom - h;
  return { x, y, k };
}

/** Panel content size (tree viewport) the op view asks for. */
export function opViewWant(tree, selected) {
  const { padX, padTop, padBottom, minH, selMinW, selMinH } = EVVIEW;
  const w = tree.width + 2 * padX;
  const h = Math.max(minH, tree.height + padTop + padBottom);
  return selected ? { w: Math.max(w, selMinW), h: Math.max(h, selMinH) } : { w, h };
}

// Heights for the ops cabinet and the op panel stacked above it, from the
// strip window's height (strip.rs clamps it to the work area). With the
// panel open, the cabinet collapses to a short list and the panel gets the rest.
const BAR_RESERVE = 100;         // bar (68px since BAR2) + root padding + gap
const CABINET_UNDER_PANEL = 220;
const SLOT_PAD = 20;             // cabinet slot padding + gap between panels
export function stripOpsHeights(vh, panelOpen) {
  if (!panelOpen) return { cabinet: Math.max(200, Math.min(560, vh - BAR_RESERVE - SLOT_PAD)), panel: 0 };
  const cabinet = Math.max(150, Math.min(CABINET_UNDER_PANEL, Math.round((vh - BAR_RESERVE) * 0.32)));
  return { cabinet, panel: Math.max(220, Math.min(600, vh - BAR_RESERVE - cabinet - 2 * SLOT_PAD)) };
}

// EVT2: the planner's Map step is out of scope for now. While this is false
// the step is hidden (OpPlanner) and the lazy MissionMap import in
// plannerPages is dropped at build time, so the strip never loads the map.
export const PLANNER_MAP_ENABLED = false;

// P2B: planner form helpers (wide planner, OpPlanner / plannerPages).
export const DURATIONS = [0, 1, 2, 3, 4]; // hours; 0 = open-ended

// ISO → the local "YYYY-MM-DDTHH:mm" a datetime-local input wants.
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}