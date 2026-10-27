import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx, focusRing } from '../ui/styles';
import { fitSlots } from './barSlots';

// BAR2: the bar's dynamic slot row — the upper half of the bar's middle
// column, above the server name. A slot is a compact chip provided by
// context (voice, ops, updates…); the row shows as many as fit, highest
// priority first, and fades/slides chips in and out.
//
// Slot = {
//   id        stable key
//   priority  lower = more important (see SLOT_PRIORITY); also the order shown
//   minWidth  px the chip needs to be worth showing (its fixed width for
//             icon-only chips). Fitting uses these numbers, not live widths,
//             so a chip whose text changes (the speaker) never makes the
//             others blink in and out.
//   grow      the chip may widen past minWidth into leftover room (text chips)
//   node      the chip element (usually a <SlotChip>)
// }
//
// Adding a slot: build one with the fields above and add it to the list the
// container passes as StripView's `barSlots` (StripApp), or to StripView's
// built-in ones (update, live op) when the data already lives there.
// Priorities and the fitting rule: ./barSlots.js.

const EXIT_MS = 150;

const TONES = {
  default: 'text-specter-text-muted bg-white/[0.04] hover:bg-white/10 hover:text-specter-text-main',
  quiet:   'text-specter-text-subtle hover:bg-white/5 hover:text-specter-text-muted',
  active:  'text-specter-primary-neon bg-specter-primary-cyan/15 hover:bg-specter-primary-cyan/25',
  speak:   'text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20',
  live:    'text-red-200 bg-red-500/15 hover:bg-red-500/25',
  accent:  'text-specter-bg-deep bg-specter-primary-cyan hover:bg-specter-primary-neon font-semibold',
  warn:    'text-amber-200 bg-specter-state-warning/20 hover:bg-specter-state-warning/30',
};

/**
 * A compact slot chip (24px tall). Icon-only chips must pass `label` (it
 * becomes the aria-label and the tooltip); text chips may pass `title` for a
 * fuller tooltip.
 * tone: default | quiet | active | speak | live | accent | warn
 */
export const SlotChip = forwardRef(function SlotChip(
  { icon, label, title, tone = 'default', pressed, iconOnly = false, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={cx(
        'relative inline-flex items-center gap-1.5 h-6 rounded-pill text-ui-xs leading-none transition-colors duration-150',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        iconOnly ? 'w-[26px] justify-center' : 'min-w-0 max-w-full px-2',
        TONES[tone] || TONES.default,
        focusRing,
        className,
      )}
      {...props}
    >
      {icon && <span aria-hidden="true" className="inline-flex shrink-0">{icon}</span>}
      {!iconOnly && children != null && <span className="min-w-0 truncate">{children}</span>}
      {iconOnly && children}
    </button>
  );
});

/** A pulsing "on air" dot for chips. */
export function PulseDot({ className }) {
  return (
    <span aria-hidden="true" className={cx('relative inline-flex h-2 w-2 shrink-0', className)}>
      <span className="absolute inset-0 rounded-pill bg-current opacity-60 motion-safe:animate-ping" />
      <span className="relative h-2 w-2 rounded-pill bg-current" />
    </span>
  );
}

/**
 * The slot row. Measures its own width and shows the slots that fit;
 * removed slots stay for a short exit animation. `empty` shows when there
 * are no slots at all.
 */
export function BarSlots({ slots = [], empty = null, className }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = fitSlots(slots, width);
  const shownIds = shown.map((s) => s.id).join('|');

  // Keep chips that just went away for their exit animation (at their old
  // place in the row).
  const lastRef = useRef(new Map());
  const timersRef = useRef([]);
  const [leaving, setLeaving] = useState([]);
  useEffect(() => {
    const now = new Map(shown.map((s) => [s.id, s]));
    const gone = [...lastRef.current.values()].filter((s) => !now.has(s.id));
    lastRef.current = now;
    if (!gone.length) {
      setLeaving((prev) => (prev.some((p) => now.has(p.id)) ? prev.filter((p) => !now.has(p.id)) : prev));
      return;
    }
    const until = Date.now() + EXIT_MS;
    setLeaving((prev) => [
      ...prev.filter((p) => !now.has(p.id) && !gone.some((g) => g.id === p.id)),
      ...gone.map((g) => ({ ...g, until })),
    ]);
    timersRef.current.push(setTimeout(() => setLeaving((prev) => prev.filter((p) => p.until > Date.now())), EXIT_MS + 20));
    // Keyed on the shown ids only: the nodes change every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownIds]);
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  const row = [
    ...shown.map((s) => ({ s, gone: false })),
    ...leaving.filter((g) => !shown.some((s) => s.id === g.id)).map((s) => ({ s, gone: true })),
  ].sort((a, b) => a.s.priority - b.s.priority);
  return (
    <div ref={ref} className={cx('flex items-center gap-1 min-w-0 overflow-hidden', className)} role="group" aria-label="Status and quick actions">
      {row.map(({ s, gone }) => (gone ? (
        <div key={`gone-${s.id}`} aria-hidden="true" inert="" className="strip-slot-exit flex min-w-0 shrink pointer-events-none">
          {s.node}
        </div>
      ) : (
        <div key={s.id} className={cx('strip-slot-enter flex min-w-0', s.grow ? 'shrink' : 'shrink-0')} style={{ minWidth: s.minWidth }}>
          {s.node}
        </div>
      )))}
      {!row.length && empty}
    </div>
  );
}
