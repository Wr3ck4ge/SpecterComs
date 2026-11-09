import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Fluid sideways expansion of a strip panel (P2A, feedback #2): the Channels
// cabinet widens toward the free side with the members/chat pane sliding in
// as part of the same panel.
//
// Width is never animated (that would re-lay-out the chat list every frame).
// Instead the panel is laid out at its final width at once (`laid` px of
// extra width) and a clip hides the not-yet-revealed part (`hidden` px,
// measured from the free side); only the clip animates. So:
//   grow:   laid = target immediately (the window region, measured from the
//           layout, already covers the final size), clip from hidden → 0
//   shrink: clip 0 → hidden first, and only when that has finished does
//           `laid` drop (and the region shrink) — on transitionend, or a timer
//           fallback (a hidden window may never run the transition)
// The region is therefore always a superset of what's visible, never cut
// short mid-animation. onSettled() runs after each layout change so the
// caller re-measures the region.

export const FLUID_MS = 220;

export default function useFluidExpand(target, onSettled) {
  const [s, setS] = useState({ laid: target, hidden: 0, animate: false, phase: 'idle' });
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  useLayoutEffect(() => {
    setS((prev) => {
      const visible = prev.laid - prev.hidden;
      if (target === visible && prev.laid === target) return prev;
      if (target >= prev.laid) {
        return { laid: target, hidden: target - visible, animate: false, phase: 'grow-start' };
      }
      return { laid: prev.laid, hidden: prev.laid - target, animate: true, phase: 'shrinking' };
    });
  }, [target]);

  // grow-start: the clip has been laid out at its starting value; next frame,
  // release it with the transition on.
  useEffect(() => {
    if (s.phase !== 'grow-start') return undefined;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      setS((prev) => (prev.phase === 'grow-start' ? { ...prev, hidden: 0, animate: true, phase: 'growing' } : prev));
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(go));
    const t = setTimeout(go, 50); // rAF doesn't run while the window is hidden
    return () => { done = true; cancelAnimationFrame(raf); clearTimeout(t); };
  }, [s.phase]);

  const settle = useCallback(() => {
    setS((prev) => {
      if (prev.phase === 'growing') return { ...prev, animate: false, phase: 'idle' };
      if (prev.phase === 'shrinking') return { laid: prev.laid - prev.hidden, hidden: 0, animate: false, phase: 'idle' };
      return prev;
    });
  }, []);

  useEffect(() => {
    if (s.phase !== 'growing' && s.phase !== 'shrinking') return undefined;
    const t = setTimeout(settle, FLUID_MS + 80);
    return () => clearTimeout(t);
  }, [s.phase, s.laid, s.hidden, settle]);

  useEffect(() => { settledRef.current?.(); }, [s.laid, s.phase]);

  const onTransitionEnd = useCallback((e) => {
    if (e.propertyName === 'clip-path' && e.target === e.currentTarget) settle();
  }, [settle]);

  return { laid: s.laid, hidden: s.hidden, animate: s.animate, onTransitionEnd };
}

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** Inline style for the expanding element (the cabinet slot). */
export function fluidSlotStyle({ laid, hidden, animate }, expand, basePad = 4) {
  if (!laid) return undefined;
  const cut = hidden > 0 ? hidden + basePad : 0;
  const left = expand !== 'right';
  return {
    [left ? 'marginLeft' : 'marginRight']: -(basePad + laid),
    clipPath: left ? `inset(0 0 0 ${cut}px)` : `inset(0 ${cut}px 0 0)`,
    transition: animate ? `clip-path ${reducedMotion() ? 1 : FLUID_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none',
  };
}
