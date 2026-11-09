// EVVIEW: the op view's group tree as a pan / zoom canvas.
//
// Same tidy-tree layout and node face as StripGroupTree (utils/treeLayout,
// GroupNodeBody; the tree grows upward, root tier next to the bar), drawn
// once at natural size and moved with a single transform (usePanZoom).
//  - Selecting a group (click / Enter) eases the camera to centre it in the
//    room beside the roles cabinet, which docks inside the view on whichever
//    side of the node has more room in the overview.
//  - Esc, the cabinet's ✕ or a click on empty space closes the cabinet and
//    eases back to the overview (fit).
//  - Drag pans, wheel / pinch zooms, and the corner controls zoom / fit.
//  - Keyboard: nodes are a roving-tabindex set; ↑ goes to a child (the tier
//    above), ↓ to the parent, ←/→ along the tier, Home to the top tier,
//    Enter / Space opens the roles; + / − / 0 zoom and fit. Focus moves into
//    the cabinet when it opens and back to the node when it closes.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { layoutTree } from '../../utils/treeLayout';
import { buildGroupTree, computeDepth } from '../../utils/eventGroups';
import { GroupNodeBody } from './StripGroupTree';
import usePanZoom from './usePanZoom';
import { EVVIEW, GROUP_TREE_SIZES, fitTransform, groupSeatFill } from './stripOpsLayout';

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/**
 * groups, myUserId, linkColors
 * vp            { w, h } viewport size (see usePanZoom)
 * selectedIdx   group whose roles are open, or null
 * onSelect(idx | null)
 * renderCabinet(idx, { side, style, headingRef, onClose })
 * overlay       extra content pinned to the top of the view (messages)
 * reduced       prefers-reduced-motion
 */
export default function OpTreeView({ groups, myUserId, linkColors = {}, vp, selectedIdx, onSelect, renderCabinet, overlay = null, reduced = false }) {
  const { node: NODE, options } = GROUP_TREE_SIZES.wide;
  const { roots, childrenMap } = useMemo(() => buildGroupTree(groups), [groups]);
  const layout = useMemo(() => layoutTree({
    roots, childrenOf: (i) => childrenMap[i] || [], sizeOf: () => NODE, options,
  }), [roots, childrenMap, NODE, options]);
  const { width, height } = layout;
  const byId = useMemo(() => Object.fromEntries(layout.nodes.map((n) => [n.id, n])), [layout]);
  const flipY = useCallback((n) => height - n.y - n.h, [height]);
  const commanderGroup = groups.findIndex((g) => (g.roles || []).some((r) => r.is_commander));

  const viewportRef = useRef(null);
  const headingRef = useRef(null);
  const nodeRefs = useRef({});
  const close = useCallback(() => onSelect(null), [onSelect]);
  const pz = usePanZoom({ viewportRef, vp, content: { width, height }, reduced, onBackgroundClick: close });
  const { t, setView } = pz;

  const fit = useMemo(() => fitTransform({ width, height }, vp), [width, height, vp]);
  const cabW = Math.max(240, Math.min(EVVIEW.cabW, vp.w - 220));

  // Which side the cabinet docks on: away from the node in the overview.
  const side = useMemo(() => {
    const n = selectedIdx !== null ? byId[selectedIdx] : null;
    if (!n) return 'right';
    const sx = fit.x + (n.x + n.w / 2) * fit.k;
    return sx <= vp.w / 2 ? 'right' : 'left';
  }, [selectedIdx, byId, fit, vp.w]);

  const freeArea = useCallback((withCabinet) => {
    if (!withCabinet) return { x0: 0, x1: vp.w };
    const used = cabW + 2 * EVVIEW.cabGap;
    return side === 'right' ? { x0: 0, x1: vp.w - used } : { x0: used, x1: vp.w };
  }, [vp.w, cabW, side]);

  // Camera target for the selection (node centred in the free area).
  const selectionView = useCallback((idx) => {
    const n = byId[idx];
    if (!n) return fit;
    const { x0, x1 } = freeArea(true);
    const freeW = Math.max(80, x1 - x0);
    const k = Math.max(0.6, Math.min(EVVIEW.selK, (freeW - 48) / n.w, EVVIEW.maxK));
    const cx = n.x + n.w / 2;
    const cy = flipY(n) + n.h / 2;
    return { k, x: x0 + freeW / 2 - cx * k, y: vp.h / 2 - cy * k };
  }, [byId, fit, freeArea, flipY, vp.h]);

  // Drive the camera from the selection and the viewport size. The first
  // placement is instant; later ones ease (the panel grows / shrinks with
  // the same timing). A manual pan / zoom sticks until the next selection
  // change or Fit.
  const placed = useRef(false);
  const lastSel = useRef(selectedIdx);
  useLayoutEffect(() => {
    if (!vp.w || !vp.h) return;
    const selChanged = lastSel.current !== selectedIdx;
    lastSel.current = selectedIdx;
    if (!placed.current) {
      placed.current = true;
      setView(selectedIdx !== null ? selectionView(selectedIdx) : fit, false);
      return;
    }
    if (pz.userMoved && !selChanged) return;
    setView(selectedIdx !== null ? selectionView(selectedIdx) : fit, true);
  }, [selectedIdx, vp.w, vp.h, width, height]); // eslint-disable-line react-hooks/exhaustive-deps -- camera follows these only

  // Focus: into the cabinet when it opens; back to the node when it closes.
  const [focusIdx, setFocusIdx] = useState(() => {
    if (selectedIdx !== null) return selectedIdx;
    const mine = groups.findIndex((g) => (g.member_user_ids || []).includes(myUserId));
    return mine >= 0 ? mine : (roots[0] ?? 0);
  });
  useEffect(() => { if (!byId[focusIdx] && layout.nodes.length) setFocusIdx(layout.nodes[0].id); }, [byId, focusIdx, layout.nodes]);
  const prevSel = useRef(selectedIdx);
  const userOpened = useRef(false);
  useEffect(() => {
    const prev = prevSel.current;
    prevSel.current = selectedIdx;
    if (selectedIdx !== null && selectedIdx !== prev && userOpened.current) {
      userOpened.current = false;
      headingRef.current?.focus({ preventScroll: true });
    } else if (selectedIdx === null && prev !== null) {
      const el = nodeRefs.current[prev];
      const active = document.activeElement;
      if (el && (!active || active === document.body || !viewportRef.current?.contains(active) || active.closest?.('[data-pz-ignore]'))) {
        el.focus({ preventScroll: true });
      }
      setFocusIdx(prev);
    }
  }, [selectedIdx]);

  const open = (idx) => { userOpened.current = true; setFocusIdx(idx); onSelect(idx); };

  // Bring a keyboard-focused node into view (outside the cabinet).
  const ensureVisible = (idx) => {
    const n = byId[idx];
    if (!n) return;
    const { x0, x1 } = freeArea(selectedIdx !== null);
    const m = 16;
    const sx0 = t.x + n.x * t.k;
    const sx1 = sx0 + n.w * t.k;
    const sy0 = t.y + flipY(n) * t.k;
    const sy1 = sy0 + n.h * t.k;
    let dx = 0;
    let dy = 0;
    if (sx0 < x0 + m) dx = x0 + m - sx0; else if (sx1 > x1 - m) dx = x1 - m - sx1;
    if (sy0 < EVVIEW.padTop) dy = EVVIEW.padTop - sy0; else if (sy1 > vp.h - m) dy = vp.h - m - sy1;
    if (dx || dy) pz.panBy(dx, dy, true);
  };

  const moveFocus = (idx) => {
    if (idx === undefined || idx === null || !byId[idx]) return;
    setFocusIdx(idx);
    nodeRefs.current[idx]?.focus({ preventScroll: true });
    ensureVisible(idx);
  };

  const neighbour = (idx, key) => {
    const n = byId[idx];
    const nearest = (list) => list.reduce((best, c) => (!best || Math.abs(byId[c].x - n.x) < Math.abs(byId[best].x - n.x) ? c : best), null);
    if (key === 'ArrowUp') return nearest(childrenMap[idx] || []);
    if (key === 'ArrowDown') return groups[idx]?.parent_index ?? null;
    if (key === 'Home') return nearest(roots);
    const row = layout.nodes.filter((k) => k.depth === n.depth).sort((a, b) => a.x - b.x);
    const i = row.findIndex((k) => k.id === idx);
    const next = row[i + (key === 'ArrowRight' ? 1 : -1)];
    return next ? next.id : null;
  };

  const onNodeKeyDown = (e, idx) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) {
      e.preventDefault();
      moveFocus(neighbour(idx, e.key));
    } else if (e.key === 'Escape' && selectedIdx !== null) {
      e.preventDefault();
      close();
    }
  };

  const onViewKeyDown = (e) => {
    if (e.target.closest?.('[data-pz-ignore]') || e.target.tagName === 'INPUT') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); pz.zoomBy(1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); pz.zoomBy(0.8); }
    else if (e.key === '0') { e.preventDefault(); setView(selectedIdx !== null ? selectionView(selectedIdx) : fit, true); }
    else if (e.key === 'Escape' && selectedIdx !== null) { e.preventDefault(); close(); }
  };

  const cabinetStyle = {
    top: EVVIEW.cabGap,
    bottom: EVVIEW.cabGap,
    width: cabW,
    [side]: EVVIEW.cabGap,
  };
  const controlsLeft = selectedIdx !== null && side === 'right';

  return (
    <div
      ref={viewportRef}
      role="group"
      aria-label="Operation groups. Arrow keys move between groups, Enter opens a group's roles, plus and minus zoom."
      // POLISH: no background — the tree floats over the desktop (WideOpFrame
      // floating); the whole view stays the window region so empty space
      // still drags to pan, wheels to zoom and clicks to close the cabinet.
      className="relative overflow-hidden select-none touch-none"
      style={{ width: vp.w, height: vp.h, cursor: 'grab' }}
      onKeyDown={onViewKeyDown}
      // Focusing a transformed node must never scroll the clipped view.
      onScroll={(e) => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; }}
      {...pz.handlers}
    >
      {/* POLISH: soft fade at the view's edges (strip-float-fade) so a panned
          tree doesn't end in a hard invisible line. */}
      <div className="absolute inset-0 strip-float-fade">
      <div
        className="absolute left-0 top-0 origin-top-left will-change-transform"
        style={{
          width, height,
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.k})`,
          transition: pz.animate ? `transform ${EVVIEW.zoomMs}ms ${EASE}` : 'none',
        }}
      >
        <svg width={width} height={height} className="absolute inset-0 pointer-events-none overflow-visible" aria-hidden="true">
          {/* POLISH: a dark halo under each connector + a faint cyan glow on
              the line, so links read on bright and dark wallpapers alike. */}
          <g transform={`translate(0 ${height}) scale(1 -1)`} fill="none" strokeLinecap="round" strokeLinejoin="round">
            <g stroke="rgba(4,12,22,0.4)" strokeWidth={5}>
              {layout.paths.map((d, i) => <path key={i} d={d} />)}
            </g>
            <g className="strip-float-links" stroke="rgba(120,226,250,0.9)" strokeWidth={2}>
              {layout.paths.map((d, i) => <path key={i} d={d} />)}
            </g>
          </g>
        </svg>
        {layout.nodes.map((n) => {
          const g = groups[n.id];
          const { members, total } = groupSeatFill(g);
          const selected = selectedIdx === n.id;
          const mine = myUserId && (g.member_user_ids || []).includes(myUserId);
          const link = linkColors[n.id];
          const dimmed = selectedIdx !== null && !selected;
          return (
            <button
              key={n.id}
              ref={(el) => { nodeRefs.current[n.id] = el; }}
              type="button"
              data-tree-node
              tabIndex={focusIdx === n.id ? 0 : -1}
              onClick={() => (selected ? close() : open(n.id))}
              onKeyDown={(e) => onNodeKeyDown(e, n.id)}
              onFocus={() => setFocusIdx(n.id)}
              aria-expanded={selected}
              aria-label={`${g.name || 'Unnamed'}, tier ${computeDepth(n.id, groups)}, ${members}${total ? ` of ${total}` : ''} seats filled${mine ? ', you are in this group' : ''}`}
              // POLISH: floating cards — always a solid base (the tints below
              // used to be see-through, which showed the wallpaper) and a soft
              // drop shadow.
              className={cx(
                'group absolute flex flex-col items-stretch rounded-ui-md border text-center overflow-hidden bg-[#0b1d2e] transition-[border-color,filter,box-shadow] duration-200',
                focusRing,
                selected ? 'border-specter-primary-neon shadow-[0_0_0_3px_rgba(103,218,245,0.3),0_6px_18px_rgba(0,0,0,0.5)]'
                  : mine ? 'strip-float-card border-specter-state-success/60'
                    : 'strip-float-card border-specter-border-strong hover:border-specter-primary-cyan/60',
                // Dimmed by darkening, not opacity: a see-through card would
                // pick up a bright wallpaper and wash out.
                dimmed && 'brightness-[0.6] saturate-50 hover:brightness-100 hover:saturate-100',
              )}
              style={{ left: n.x, top: flipY(n), width: n.w, height: n.h, cursor: 'pointer' }}
            >
              {(selected || mine) && (
                <span aria-hidden="true" className={cx('pointer-events-none absolute inset-0 transition-colors duration-200',
                  selected ? 'bg-specter-primary-cyan/25' : 'bg-specter-state-success/10 group-hover:bg-specter-state-success/15')} />
              )}
              {link && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px]" style={{ background: link }} />}
              <GroupNodeBody g={g} idx={n.id} groups={groups} wide isCommanderGroup={commanderGroup === n.id} />
            </button>
          );
        })}
      </div>
      </div>

      {/* Zoom controls — opposite the cabinet. POLISH: a small floating pill. */}
      <div data-pz-ignore className={cx('absolute top-2 flex items-center gap-0.5 p-0.5 rounded-pill border border-specter-border-strong bg-[#0b1d2e]/95 strip-float-card', controlsLeft ? 'left-2' : 'right-2')}
        role="toolbar" aria-label="Zoom">
        <IconButton size="sm" className="!rounded-pill" icon={<Minus size={14} />} label="Zoom out" onClick={() => pz.zoomBy(0.8)} />
        <span className="min-w-[38px] text-center text-ui-xs tabular-nums text-specter-text-muted" aria-live="off">{Math.round(t.k * 100)}%</span>
        <IconButton size="sm" className="!rounded-pill" icon={<Plus size={14} />} label="Zoom in" onClick={() => pz.zoomBy(1.25)} />
        <IconButton size="sm" className="!rounded-pill" icon={<Maximize2 size={13} />} label="Fit tree" onClick={() => (selectedIdx !== null ? close() : setView(fit, true))} />
      </div>
      {selectedIdx === null && (
        // POLISH: a subtle floating label (faint dark pill + outer glow) that
        // reads on bright and dark wallpapers.
        <p className={cx('pointer-events-none absolute top-3 px-2.5 py-0.5 rounded-pill bg-[#06121e]/55 text-ui-xs text-specter-text-main/85 strip-float-text', controlsLeft ? 'right-3' : 'left-3')}>
          Select a group to see its roles
        </p>
      )}
      {overlay && (
        // POLISH: messages sit on a solid card now that the view has no background.
        <div data-pz-ignore className="absolute top-12 left-1/2 -translate-x-1/2 w-[min(420px,calc(100%-24px))] z-10 rounded-ui-md bg-[#0b1d2e] strip-float-card">{overlay}</div>
      )}

      {selectedIdx !== null && groups[selectedIdx] && renderCabinet(selectedIdx, { side, style: cabinetStyle, headingRef, onClose: close })}
    </div>
  );
}
