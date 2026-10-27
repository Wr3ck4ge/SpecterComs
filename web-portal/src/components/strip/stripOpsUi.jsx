// Small presentational pieces shared by the strip's Operations and
// Notifications cabinets and the op panel above them.
import {
  useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import {
  EVVIEW, OPGROW, OpFrameContext, WIDE, opGrowScale, prefersReducedMotion, withSubRow,
} from './stripOpsLayout';

export function PanelHeader({ title, subtitle, actions = null, onClose, closeLabel = 'Close' }) {
  return (
    <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-2 shrink-0">
      <div className="min-w-0 flex-1">
        <h2 className="text-ui-lg font-semibold text-specter-text-main truncate">{title}</h2>
        {subtitle && <p className="text-ui-sm text-specter-text-subtle truncate">{subtitle}</p>}
      </div>
      {actions}
      {onClose && <IconButton icon={<X size={16} />} label={closeLabel} size="sm" onClick={onClose} />}
    </div>
  );
}

export function SectionLabel({ children, className = '' }) {
  return <h3 className={cx('text-ui-xs font-semibold text-specter-text-subtle', className)}>{children}</h3>;
}

/** Selectable pill. `selected` shows the on state (aria-pressed). */
export function Chip({ selected = false, onClick, children, className = '', tone = 'cyan', disabled = false, title }) {
  const on = {
    cyan: 'bg-specter-primary-cyan/15 border-specter-primary-cyan/60 text-specter-primary-neon',
    green: 'bg-specter-state-success/15 border-specter-state-success/50 text-emerald-300',
    amber: 'bg-specter-state-warning/15 border-specter-state-warning/50 text-amber-300',
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={selected}
      className={cx(
        'inline-flex items-center gap-1 h-7 px-2.5 rounded-pill border text-ui-xs font-medium transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        focusRing,
        selected ? on : 'bg-white/[0.03] border-specter-border text-specter-text-muted hover:border-specter-border-strong hover:text-specter-text-main',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** One-of-n selector as a row of joined segments. options: [{ value, label }] */
export function Segmented({ value, options, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 rounded-pill bg-specter-bg-deep/60 border border-specter-border">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 px-3 rounded-pill text-ui-xs font-semibold transition-colors',
            focusRing,
            value === o.value ? 'bg-specter-primary-cyan text-specter-bg-deep' : 'text-specter-text-muted hover:text-specter-text-main',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** − n + number stepper. `format(n)` renders the value (e.g. 0 → "∞"). */
export function Stepper({ value, onChange, min = 0, max = 99, label, format = (n) => n }) {
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      <IconButton size="sm" variant="secondary" icon={<Minus size={13} />} label={`Fewer ${label}`}
        disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} />
      <span className="min-w-[28px] text-center text-ui-sm font-semibold tabular-nums text-specter-text-main">{format(value)}</span>
      <IconButton size="sm" variant="secondary" icon={<Plus size={13} />} label={`More ${label}`}
        disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} />
    </div>
  );
}

/** Plain text field in the strip style. */
export function Field({ label, children, hint }) {
  return (
    <label className="block space-y-1">
      <span className="block text-ui-xs font-semibold text-specter-text-subtle">{label}</span>
      {children}
      {hint && <span className="block text-ui-xs text-specter-text-subtle">{hint}</span>}
    </label>
  );
}

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/**
 * OPGROW: the op panel and its secondary bar, placed with position: fixed
 * from wideOpLayout() (stripOpsLayout.js). Each is its own window-region rect
 * (data-strip-region), so the space between them and the main bar stays
 * click-through.
 *
 * Opening shows only the secondary bar (it slides out of the main bar); the
 * content panel then grows out of the bar to the content's natural size:
 *  - the content is laid out once, at its final width, in an absolutely
 *    positioned box anchored to the bar side (bottom when growing up) and the
 *    bar's outer edge, with max-height = the layout's max — so its height is
 *    the natural height clamped to the max (past that, the page body
 *    scrolls). A ResizeObserver on that box tracks the natural height.
 *  - the panel box (overflow hidden) transitions width / height to that size,
 *    revealing the content like a curtain; the content itself never re-lays
 *    out per frame.
 *  - the window region: a transparent "reserve" rect covers the larger of the
 *    old and new size for the whole transition (a superset — never clipped
 *    mid-animation) and settles on transitionend or a timer; the region is
 *    re-measured (layout.onRegion) on every size change, settle, and panel resize.
 * Closing (layout.closing) collapses the panel into the bar, then the bar
 * leaves; useOpPanelTarget unmounts after opCloseDelay().
 *
 *   layout   wideOpLayout() result + { closing, onRegion, devPhase? }
 *   want     the page's preferred panel width (clamped to [minW, max width])
 *   bar      secondary bar content
 *   drawer   EVVIEW: optional { open, width, label, content } — a cabinet
 *            extension that slides out of the panel's free side (left when the
 *            panel grows leftward, right otherwise). See OpDrawer below.
 *   subBar   EVT2: optional page tools for a sub-row of the secondary bar,
 *            between its main row and the main bar. The bar grows away from
 *            the main bar to make room (the panel moves with it, see
 *            withSubRow) and the tools slide up / fade in; null hides it.
 */
//   floating POLISH: no panel chrome (background / border / shadow) — the
//            content floats over the desktop (the event viewer's tree). The
//            box is still the window-region rect (it captures clicks: the
//            tree pans by dragging empty space).
export function WideOpFrame({ layout: baseLayout, want, label, bar = null, barLabel = 'Planner', drawer = null, subBar = null, subLabel = 'Page tools', floating = false, children }) {
  const reduced = prefersReducedMotion();
  const scale = opGrowScale();
  // EVT2: the tools sub-row. The last tools stay rendered while it collapses.
  const subMs = reduced ? 0 : Math.round(WIDE.subMs * scale);
  const subH = subBar ? WIDE.sub : 0;
  const lastSubRef = useRef(subBar);
  if (subBar) lastSubRef.current = subBar;
  const [subAnim, setSubAnim] = useState(false);
  const prevSubH = useRef(subH);
  useLayoutEffect(() => {
    if (prevSubH.current === subH) return undefined;
    prevSubH.current = subH;
    if (!subMs) { if (!subH) lastSubRef.current = null; return undefined; }
    setSubAnim(true);
    const t = setTimeout(() => {
      setSubAnim(false);
      if (!subH) lastSubRef.current = null;
    }, subMs + 40);
    return () => clearTimeout(t);
  }, [subH, subMs]);
  const subContent = subBar || (subAnim ? lastSubRef.current : null);
  const layout = withSubRow(baseLayout, subH);

  const { panel, bar2, grow = 'up', toLeft = true, closing = false, onRegion, devPhase } = layout;
  const growMs = reduced ? 0 : Math.round(OPGROW.growMs * scale);
  const barInMs = reduced ? 0 : Math.round(OPGROW.barInMs * scale);
  const barOutMs = reduced ? 0 : Math.round(OPGROW.barOutMs * scale);
  const maxW = panel.width;
  const panelW = Math.round(Math.max(Math.min(OPGROW.minW, maxW), Math.min(want ?? maxW, maxW)));
  const innerMax = Math.max(0, panel.maxHeight - 2); // inside the 1px border

  const notifyRef = useRef(onRegion);
  notifyRef.current = onRegion;
  const notify = useCallback(() => notifyRef.current?.(), []);
  const ctx = useMemo(() => ({ notifyRegion: notify }), [notify]);

  // Natural (clamped) content height.
  const contentRef = useRef(null);
  const [natH, setNatH] = useState(0);
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return undefined;
    const measure = () => setNatH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Bar first; the panel starts growing once the bar is out.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened || devPhase === 'bar') return undefined;
    const t = setTimeout(() => setOpened(true), barInMs);
    return () => clearTimeout(t);
  }, [opened, devPhase, barInMs]);

  // Closing: the bar leaves once the panel has collapsed.
  const [barLeaving, setBarLeaving] = useState(false);
  useEffect(() => {
    if (!closing) { setBarLeaving(false); return undefined; }
    const t = setTimeout(() => setBarLeaving(true), growMs);
    return () => clearTimeout(t);
  }, [closing, growMs]);

  const h = opened && !closing && devPhase !== 'bar' && natH > 0 ? natH + 2 : 0;

  // Region reserve: max(old, new) while a transition runs, then the new size.
  const [reserve, setReserve] = useState({ w: panelW, h });
  const settle = useCallback(() => {
    setReserve((r) => (r.w === panelW && r.h === h ? r : { w: panelW, h }));
  }, [panelW, h]);
  useLayoutEffect(() => {
    setReserve((r) => {
      const next = growMs ? { w: Math.max(r.w, panelW), h: Math.max(r.h, h) } : { w: panelW, h };
      return next.w === r.w && next.h === r.h ? r : next;
    });
    if (!growMs) return undefined;
    const t = setTimeout(settle, growMs + 80); // transitionend may never fire (hidden window)
    return () => clearTimeout(t);
  }, [panelW, h, growMs, settle]);
  useLayoutEffect(() => { notify(); }, [reserve, h, panelW, barLeaving, subH, subAnim, notify]);

  // The panel's own size changes every frame of a transition. EVT2: so does
  // the secondary bar's while the sub-row comes and goes (the panel moves
  // with it, which a ResizeObserver on the panel alone wouldn't see).
  const panelRef = useRef(null);
  const toolRef = useRef(null);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => notify());
    [panelRef.current, toolRef.current].forEach((el) => el && ro.observe(el));
    return () => ro.disconnect();
  }, [notify, !!bar]); // eslint-disable-line react-hooks/exhaustive-deps -- re-observe when the bar mounts

  const onTransitionEnd = (e) => {
    if (e.target !== e.currentTarget || (e.propertyName !== 'height' && e.propertyName !== 'width')) return;
    settle();
    notify();
  };

  const vert = grow === 'down' ? { top: panel.top } : { bottom: panel.bottom };
  const horiz = toLeft ? { right: panel.right } : { left: panel.left };
  const live = h > 0 || reserve.h > 0;
  return (
    <OpFrameContext.Provider value={ctx}>
      <section
        ref={panelRef}
        data-strip-region={live ? '' : undefined}
        aria-label={label}
        aria-hidden={h === 0 || undefined}
        className={cx(floating ? 'strip-float' : 'strip-panel', 'fixed z-10 overflow-hidden')}
        onTransitionEnd={onTransitionEnd}
        style={{
          ...horiz, ...vert, width: panelW, height: h, opacity: h ? 1 : 0,
          // Opening fades in quickly; collapsing keeps the panel solid until
          // it's nearly folded into the bar.
          transition: growMs ? `width ${growMs}ms ${EASE}, height ${growMs}ms ${EASE}, ${h
            ? `opacity ${Math.round(growMs * 0.6)}ms ease-out`
            : `opacity ${Math.round(growMs * 0.35)}ms ease-in ${Math.round(growMs * 0.65)}ms`}${subMs ? `, ${grow === 'down' ? 'top' : 'bottom'} ${subMs}ms ${EASE}` : ''}` : 'none',
        }}
      >
        <div
          ref={contentRef}
          className="absolute flex flex-col"
          style={{
            [toLeft ? 'right' : 'left']: 0, [grow === 'down' ? 'top' : 'bottom']: 0,
            width: panelW - 2, maxHeight: innerMax, '--op-max': `${innerMax}px`,
          }}
        >
          {children}
        </div>
      </section>
      {drawer && (
        <OpDrawer drawer={drawer} open={!!drawer.open && !closing && h > 0} panel={panel} panelW={panelW} vert={vert}
          toLeft={toLeft} ms={growMs} notify={notify} />
      )}
      {/* Window-region reserve for the panel's transition (transparent). */}
      <div
        aria-hidden="true"
        data-strip-region={reserve.h > 0 ? '' : undefined}
        className="fixed pointer-events-none"
        style={{ ...horiz, ...vert, width: reserve.w, height: reserve.h }}
      />
      {bar && (
        // EVT2: the secondary bar = main row + optional tools sub-row. The
        // region rect is anchored at the main bar side and reserves the
        // larger height while the sub-row animates; the visible box grows
        // away from the main bar (its main row moving with the panel) and
        // clips only while that runs, so bar popovers can overflow it.
        <div
          data-strip-region
          className="fixed z-20 pointer-events-none"
          style={{
            // Same width and outer edge as the panel, resizing with it, so
            // the bar never sticks out past the panel (empty gap mid-bar).
            ...horiz, width: panelW,
            ...(grow === 'down' ? { top: bar2.top } : { bottom: bar2.bottom }),
            height: bar2.height + (subAnim ? WIDE.sub : subH),
            transition: growMs ? `width ${growMs}ms ${EASE}` : 'none',
          }}
        >
          <div
            ref={toolRef}
            className={cx('strip-panel pointer-events-auto absolute inset-x-0 flex flex-col',
              grow === 'down' ? 'top-0 justify-end' : 'bottom-0 justify-start',
              subAnim ? 'overflow-hidden' : 'overflow-visible',
              barLeaving ? (grow === 'down' ? 'strip-opbar-out-down' : 'strip-opbar-out-up')
                : (grow === 'down' ? 'strip-opbar-in-down' : 'strip-opbar-in-up'))}
            style={{
              height: bar2.height + subH,
              animationDuration: `${barLeaving ? barOutMs : barInMs}ms`,
              transition: subMs ? `height ${subMs}ms ${EASE}` : 'none',
            }}
          >
            <div role="toolbar" aria-label={barLabel} className={cx('flex items-center gap-1.5 px-2 shrink-0', grow === 'down' && 'order-2')}
              style={{ height: bar2.height - 2 }}>
              {bar}
            </div>
            {subContent && (
              <div
                role="toolbar"
                aria-label={subLabel}
                className={cx('relative flex items-center gap-1.5 px-2 shrink-0 border-specter-border-divider',
                  grow === 'down' ? 'order-1 border-b' : 'border-t')}
                style={{ height: WIDE.sub }}
                inert={subBar ? undefined : ''}
              >
                {/* POLISH: page tools anchored right, under the main row's actions. */}
                <div
                  className={cx('flex min-w-0 flex-1 items-center justify-end gap-1.5', subBar ? 'strip-subrow-in' : 'strip-subrow-out')}
                  style={{ animationDuration: `${subMs || 1}ms` }}
                >
                  {subContent}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </OpFrameContext.Provider>
  );
}

/**
 * EVVIEW: WideOpFrame's side drawer. A fixed box beside the panel (sharing its
 * bar-side anchor, so it grows the same way), sliding out from under the
 * panel's free edge. The box itself is the window-region rect and stays at its
 * full final size for the whole slide (a superset — the content only moves
 * inside it), mounts before the slide in and unmounts after the slide out;
 * every step re-measures the region. When there isn't room beside the panel
 * it is clamped to the window edge and overlaps the panel instead.
 */
function OpDrawer({ drawer, open, panel, panelW, vert, toLeft, ms, notify }) {
  const { margin } = WIDE;
  const { drawerGap } = EVVIEW;
  const vw = panel.left + panel.width + panel.right;
  const width = Math.min(drawer.width || 340, vw - 2 * margin);
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open && !ms);
  useEffect(() => {
    if (open) {
      setMounted(true);
      if (!ms) { setShown(true); return undefined; }
      // A timer, not rAF: rAF doesn't run while the window is hidden, which
      // would leave the drawer's region up with nothing in it.
      const t = setTimeout(() => setShown(true), 20);
      return () => clearTimeout(t);
    }
    setShown(false);
    if (!ms) { setMounted(false); return undefined; }
    const t = setTimeout(() => setMounted(false), ms + 60);
    return () => clearTimeout(t);
  }, [open, ms]);
  useLayoutEffect(() => { notify(); }, [mounted, shown, panelW, notify]);
  const boxRef = useRef(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => notify());
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted, notify]);
  if (!mounted) return null;
  const horiz = toLeft
    ? { right: Math.max(margin, Math.min(panel.right + panelW + drawerGap, vw - margin - width)) }
    : { left: Math.max(margin, Math.min(panel.left + panelW + drawerGap, vw - margin - width)) };
  const ease = `${ms}ms ${EASE}`;
  return (
    <aside
      ref={boxRef}
      data-strip-region
      aria-label={drawer.label}
      className="fixed z-[11] overflow-hidden pointer-events-none"
      style={{ ...horiz, ...vert, width, maxHeight: panel.maxHeight, transition: ms ? `right ${ease}, left ${ease}` : 'none' }}
      onTransitionEnd={() => notify()}
    >
      <div
        className="strip-panel pointer-events-auto flex flex-col"
        style={{
          maxHeight: panel.maxHeight,
          transform: shown ? 'none' : `translateX(${toLeft ? 100 : -100}%)`,
          opacity: shown ? 1 : 0,
          transition: ms ? `transform ${ease}, opacity ${Math.round(ms * 0.7)}ms ease-out` : 'none',
        }}
        // Keeps the drawer's contents out of the tab order while it's away
        // (React 18 passes a string attribute through; '' = on).
        inert={shown ? undefined : ''}
      >
        {drawer.content}
      </div>
    </aside>
  );
}

/**
 * A popover that opens from the secondary bar into the panel area (up when
 * the strip grows up). OPGROW: the panel may now be smaller than the popover,
 * so it's its own window-region rect and asks the frame for a re-measure.
 */
// EVT2: `offset` (px) is the gap from the popover's anchor; tools in the
// secondary bar's sub-row pass it past the main row.
export function BarPopover({ grow = 'up', align = 'left', label, onClose, children, className = '', offset = 10 }) {
  const ctx = useContext(OpFrameContext);
  const ref = useRef(null);
  useLayoutEffect(() => {
    const notify = () => ctx?.notifyRegion();
    notify();
    const el = ref.current;
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(notify) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); setTimeout(notify, 0); };
  }, [ctx]);
  return (
    <div
      ref={ref}
      data-strip-region
      role="dialog"
      aria-label={label}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose?.(); }}
      className={cx(
        'absolute z-30 w-[340px] max-h-[360px] strip-scroll p-3 rounded-ui-md border border-specter-border-strong bg-[#0d2236] shadow-lg',
        align === 'right' ? 'right-0' : 'left-0',
        className,
      )}
      style={{ [grow === 'down' ? 'top' : 'bottom']: `calc(100% + ${offset}px)` }}
    >
      {children}
    </div>
  );
}

/**
 * A ship's image (Fleetyards `icon_url` / `ship_icon_url`) with a fallback
 * badge — the ship's initials (or `code`, e.g. a manufacturer code) — when
 * there's no URL or it fails to load. `count` > 1 adds a ×N corner badge.
 */
// `w` widens the image box (ship icons are wide side views, so a square box
// draws them small); the initials fallback stays size × size.
export function ShipBadge({ name = '', url, size = 28, w, code, count = 0, className = '' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  const corner = count > 1 ? (
    <span aria-hidden="true" className="absolute -bottom-1 -right-1 px-1 rounded-pill bg-specter-primary-cyan text-[9px] font-bold leading-[13px] tabular-nums text-specter-bg-deep">×{count}</span>
  ) : null;
  const box = { width: size, height: size };
  if (url && !failed) {
    return (
      <span className={cx('relative inline-flex shrink-0', className)} style={{ ...box, width: w || size }}>
        <img src={url} alt="" className="h-full w-full object-contain rounded-ui-sm"
          onError={() => setFailed(true)} />
        {corner}
      </span>
    );
  }
  const initials = (code || name.split(/[\s-]+/).map((w) => w[0]).filter(Boolean).slice(0, 3).join('') || '?').toUpperCase();
  return (
    <span className={cx('relative inline-flex shrink-0 items-center justify-center rounded-ui-sm border border-specter-border bg-white/[0.06] font-bold text-specter-text-muted', className)}
      style={{ ...box, fontSize: Math.max(8, Math.round(size * 0.32)) }} title={name || undefined} aria-hidden="true">
      {initials}
      {corner}
    </span>
  );
}

/** Tiny count / state bubble pinned to a bar icon's corner. */
export function IconBadge({ kind, count }) {
  if (!kind) return null;
  const base = 'pointer-events-none absolute -top-0.5 -right-0.5 inline-flex items-center justify-center rounded-pill border-2 border-[#0b1d2e]';
  if (kind === 'live') {
    return <span aria-hidden="true" className={cx(base, 'h-3 w-3 bg-specter-state-success animate-pulse')} />;
  }
  if (kind === 'soon') {
    return <span aria-hidden="true" className={cx(base, 'h-3 w-3 bg-specter-state-warning')} />;
  }
  return (
    <span aria-hidden="true" className={cx(base, 'h-[17px] min-w-[17px] px-1 text-[10px] font-bold tabular-nums bg-specter-primary-cyan text-specter-bg-deep')}>
      {count > 99 ? '99+' : count}
    </span>
  );
}
