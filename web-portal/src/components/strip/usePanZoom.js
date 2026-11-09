// EVVIEW: transform-based pan / zoom for the op view's group tree.
//
// The canvas is drawn at its natural size and moved with one CSS transform
// (translate + scale, origin top-left), so a camera move never re-lays out
// the tree. Programmatic moves (select a group, fit) animate with a CSS
// transition; manual ones (drag, wheel, pinch, keyboard) apply instantly.
//
//   viewportRef   the clipping element (pointer + wheel input lands here)
//   vp            { w, h } of the viewport — computed by the caller from the
//                 panel's target size (WideOpFrame lays the content out at its
//                 final size at once, so this is what the viewport measures;
//                 computing it avoids a frame at the old size)
//   content       { width, height } of the canvas in px
//   reduced       prefers-reduced-motion → no transitions
//   onBackgroundClick()   a click (no drag) on empty space
//
// Returns { t: { x, y, k }, animate, vp: { w, h }, setView(t, animate),
//           zoomBy(factor, center?), panBy(dx, dy, animate), userMoved,
//           handlers } — spread `handlers` on the viewport.
import { useCallback, useEffect, useRef, useState } from 'react';
import { EVVIEW } from './stripOpsLayout';

const DRAG_THRESHOLD = 4;
const KEEP_VISIBLE = 72; // px of the tree that always stays in view

export default function usePanZoom({ viewportRef, vp, content, reduced, onBackgroundClick }) {
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const [animate, setAnimate] = useState(false);
  const [userMoved, setUserMoved] = useState(false);
  const tRef = useRef(t);
  tRef.current = t;
  const contentRef = useRef(content);
  contentRef.current = content;
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const bgClickRef = useRef(onBackgroundClick);
  bgClickRef.current = onBackgroundClick;

  const clamp = useCallback((next) => {
    const { width, height } = contentRef.current;
    const { w, h } = vpRef.current;
    const k = Math.min(EVVIEW.maxK, Math.max(EVVIEW.minK, next.k));
    const cw = width * k;
    const ch = height * k;
    const keepX = Math.min(KEEP_VISIBLE, cw / 2);
    const keepY = Math.min(KEEP_VISIBLE, ch / 2);
    return {
      k,
      x: Math.min(w - keepX, Math.max(keepX - cw, next.x)),
      y: Math.min(h - keepY, Math.max(keepY - ch, next.y)),
    };
  }, []);

  // Animated moves clear their transition once done so later manual input
  // applies instantly.
  const animTimer = useRef(null);
  const setView = useCallback((next, anim = true, manual = false) => {
    const doAnim = anim && !reduced;
    setAnimate(doAnim);
    clearTimeout(animTimer.current);
    if (doAnim) animTimer.current = setTimeout(() => setAnimate(false), EVVIEW.zoomMs + 40);
    setUserMoved(manual);
    setT(manual ? clamp(next) : next);
  }, [clamp, reduced]);
  useEffect(() => () => clearTimeout(animTimer.current), []);

  const zoomAt = useCallback((factor, cx, cy, anim = false) => {
    const cur = tRef.current;
    const k = Math.min(EVVIEW.maxK, Math.max(EVVIEW.minK, cur.k * factor));
    const r = k / cur.k;
    setView({ k, x: cx - (cx - cur.x) * r, y: cy - (cy - cur.y) * r }, anim, true);
  }, [setView]);

  const zoomBy = useCallback((factor, center) => {
    const { w, h } = vpRef.current;
    zoomAt(factor, center?.x ?? w / 2, center?.y ?? h / 2, true);
  }, [zoomAt]);

  const panBy = useCallback((dx, dy, anim = false) => {
    const cur = tRef.current;
    setView({ ...cur, x: cur.x + dx, y: cur.y + dy }, anim, true);
  }, [setView]);

  // Wheel / trackpad pinch (ctrl+wheel) zoom about the pointer. Needs a
  // non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (e.target.closest?.('[data-pz-ignore]')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewportRef, zoomAt]);

  // Drag to pan (from the background or a node — a moved node press doesn't
  // click); two pointers pinch-zoom. Pointer capture starts only once a drag
  // is real, so plain clicks still reach the node buttons.
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const suppressClick = useRef(false);
  const local = (e) => {
    const r = viewportRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const handlers = {
    onPointerDown: (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest?.('[data-pz-ignore]')) return;
      pointers.current.set(e.pointerId, local(e));
      if (pointers.current.size === 1) {
        gesture.current = { kind: 'pan', id: e.pointerId, start: local(e), t0: tRef.current, moved: false, onNode: !!e.target.closest?.('[data-tree-node]') };
      } else if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        gesture.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, t0: tRef.current, moved: true };
        try { viewportRef.current.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
      }
    },
    onPointerMove: (e) => {
      if (!pointers.current.has(e.pointerId)) return;
      const p = local(e);
      pointers.current.set(e.pointerId, p);
      const g = gesture.current;
      if (!g) return;
      if (g.kind === 'pan' && g.id === e.pointerId) {
        const dx = p.x - g.start.x;
        const dy = p.y - g.start.y;
        if (!g.moved) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
          g.moved = true;
          try { viewportRef.current.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
        }
        setView({ ...g.t0, x: g.t0.x + dx, y: g.t0.y + dy }, false, true);
      } else if (g.kind === 'pinch' && pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const k = Math.min(EVVIEW.maxK, Math.max(EVVIEW.minK, g.t0.k * (d / g.d0)));
        const r = k / g.t0.k;
        setView({ k, x: mid.x - (mid.x - g.t0.x) * r, y: mid.y - (mid.y - g.t0.y) * r }, false, true);
      }
    },
    onPointerUp: (e) => {
      const g = gesture.current;
      pointers.current.delete(e.pointerId);
      if (pointers.current.size > 0) return;
      gesture.current = null;
      if (!g) return;
      if (g.moved) {
        suppressClick.current = g.onNode;
        return;
      }
      if (!g.onNode && !e.target.closest?.('[data-pz-ignore]')) bgClickRef.current?.();
    },
    onPointerCancel: (e) => {
      pointers.current.delete(e.pointerId);
      if (!pointers.current.size) gesture.current = null;
    },
    // A drag that started on a node must not also select it.
    onClickCapture: (e) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };

  return { t, animate, vp, setView, zoomBy, panBy, userMoved, handlers };
}
