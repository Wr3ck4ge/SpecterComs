// P2C: the slot for a game tool's wide panel, beside the Games cabinet (on
// the free side, in StripColumns' side column). Sizes the panel from the
// strip window's inner size — wide panels are possible once the strip window
// covers the work area — and lazy-loads the panel itself, so the hangar and
// ship editor code stays out of the main strip chunk.
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { MAIN_WIDTH } from '../StripSidePanel';

const GameToolPanel = lazy(() => import('./GameToolPanel'));

const MAX_W = 1100;
const MAX_H = 820;
const MIN_W = 340;
const MIN_H = 360;
const PAD = 12; // side column padding + the panel's own border/shadow room

function useWindowSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

/** Panel size for a window of (w, h): the free width beside the main column. */
function gameToolSize(w, h) {
  return {
    width: Math.max(MIN_W, Math.min(MAX_W, w - MAIN_WIDTH - PAD)),
    height: Math.max(MIN_H, Math.min(MAX_H, h - PAD)),
  };
}

/**
 * tool            { game, tool, shipId }
 * onChange(tool)  e.g. open a ship / back to the list
 * onClose()
 * onRegionChange  re-measure the window region (strip.rs) when the panel resizes
 * size            dev preview: { w, h } of the fake window
 */
export default function GameToolDock({ tool, onChange, onClose, onRegionChange, size }) {
  const measured = useWindowSize();
  const { width, height } = gameToolSize(size?.w ?? measured.w, size?.h ?? measured.h);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => onRegionChange?.());
    ro.observe(el);
    return () => ro.disconnect();
  }, [onRegionChange]);
  return (
    <div ref={ref} data-strip-region className="min-h-0 flex flex-col">
      <section aria-label="Game tools" className="strip-panel strip-cabinet-swap overflow-hidden">
        <Suspense fallback={<div style={{ width, height: 120 }} className="p-4 text-ui-sm text-specter-text-subtle">Loading…</div>}>
          <GameToolPanel
            tool={tool.tool}
            shipId={tool.shipId}
            onOpenShip={(shipId) => onChange({ ...tool, shipId })}
            onClose={onClose}
            width={width}
            height={height}
          />
        </Suspense>
      </section>
    </div>
  );
}
