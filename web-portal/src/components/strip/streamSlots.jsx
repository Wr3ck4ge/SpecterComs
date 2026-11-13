import { useEffect, useState } from 'react';
import { AlertCircle, ChevronRight, Volume2, X } from 'lucide-react';
import { ScWatchingStream } from '../icons/brand'; // BRAND
import { IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { SLOT_PRIORITY } from './barSlots';
import { SlotChip } from './StripBarSlots';
import { sharerHasAudio } from './ShareAudioControls';
import { WatchWhere, watchingWhere } from './watchDestinations';

/** The others in my voice channel who are sharing (not me). */
export function otherSharers(engine) {
  const v = engine?.state?.voice;
  if (!engine?.connected || !v?.channelId) return [];
  const me = engine.state.user?.callsign ?? null;
  return (v.sharers || []).filter((c) => c && c !== me);
}

/**
 * SV/C2: the bar's "streams" slot — someone else in my voice channel is
 * sharing and the strip's viewer isn't open: a red ▶ chip (with a count when
 * there are several) that opens the Streams panel: who's sharing → where to
 * watch. Nothing while the viewer is open (its header has the same switch)
 * or outside voice.
 * engine        useEngine() result
 * viewerOpen    the strip's viewer is showing
 * panelOpen     the Streams panel is open (chip pressed)
 * onToggle()
 */
export function streamWatchSlots({ engine, viewerOpen, panelOpen = false, onToggle }) {
  if (viewerOpen) return [];
  const others = otherSharers(engine);
  if (!others.length) return [];
  const many = others.length > 1;
  const label = many
    ? `${others.length} people are sharing. Choose a stream to watch`
    : `${others[0]} is sharing. Choose where to watch`;
  // Icon-only (the name is in the tooltip): the slot row is ~150px at the
  // bar's normal width and this must not push the Overlay chip out.
  return [{
    id: 'watch',
    priority: SLOT_PRIORITY.watch,
    minWidth: 26,
    node: (
      <SlotChip iconOnly tone="live" pressed={panelOpen} icon={<ScWatchingStream size={13} />} label={label} onClick={onToggle}>
        {many && (
          <span aria-hidden="true" className="pointer-events-none absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-pill bg-red-500 text-[9px] leading-[14px] text-white text-center font-semibold border border-specter-brand-ink">
            {others.length}
          </span>
        )}
      </SlotChip>
    ),
  }];
}

/**
 * C2: the Streams panel (stacked above the bar like the share picker): who's
 * sharing, and for the person picked, where to watch (WATCH_DESTINATIONS).
 * With one sharer their choice is already open.
 * engine       useEngine() result
 * onPick(callsign, dest) → Promise (rejects with the reason it failed)
 * onClose()
 */
export function StreamsPanel({ engine, onPick, onClose, maxHeight = 420 }) {
  const others = otherSharers(engine);
  const state = engine.state;
  const overlayOk = state.caps?.overlay;
  const [chosen, setChosen] = useState(others.length === 1 ? others[0] : null);
  const [pending, setPending] = useState(null); // { callsign, id }
  const [error, setError] = useState(null); // { callsign, message }
  // Nobody left sharing: nothing to choose from.
  const none = others.length === 0;
  useEffect(() => { if (none) onClose(); }, [none, onClose]);
  // The chosen sharer stopped: fall back to the only one left, or none.
  useEffect(() => {
    if (chosen && !others.includes(chosen)) setChosen(others.length === 1 ? others[0] : null);
  }, [chosen, others]);

  const pick = (callsign, dest) => {
    setError(null);
    setPending({ callsign, id: dest.id });
    Promise.resolve(onPick(callsign, dest)).then(
      () => { setPending(null); onClose(); },
      (err) => { setPending(null); setError({ callsign, message: err?.message || 'Could not open the stream' }); },
    );
  };

  return (
    <section data-strip-region aria-label="Streams" className="strip-panel strip-cabinet-swap shrink-0 flex flex-col overflow-hidden" style={{ maxHeight }}>
      <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <h2 className="text-ui-lg font-semibold text-specter-text-main">Streams</h2>
          <p className="text-ui-sm text-specter-text-subtle">
            {others.length > 1 ? 'Pick someone, then where to watch' : 'Where do you want to watch?'}
          </p>
        </div>
        <IconButton size="sm" icon={<X size={16} />} label="Close" onClick={onClose} />
      </div>
      <ul className="strip-scroll min-h-0 flex-1 pb-2" aria-label="People sharing">
        {others.map((c) => {
          const open = chosen === c;
          const where = watchingWhere(state, c);
          return (
            <li key={c}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setChosen(open ? null : c)}
                className={cx('w-full flex items-center gap-2 h-9 px-4 text-left text-ui-sm hover:bg-white/5', open && 'bg-white/[0.03]', focusRing)}
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-pill bg-red-400" />
                <span className="flex-1 min-w-0 truncate font-medium text-specter-text-main">{c}</span>
                {sharerHasAudio(state.voice, c) && <Volume2 size={13} className="shrink-0 text-specter-text-subtle" aria-label={`${c}'s stream has audio`} />}
                {where && <span className="shrink-0 text-ui-xs text-specter-primary-neon">Watching</span>}
                <ChevronRight size={14} aria-hidden="true" className={cx('shrink-0 text-specter-text-subtle transition-transform', open && 'rotate-90')} />
              </button>
              {open && (
                <div className="px-4 pt-1 pb-2">
                  <WatchWhere
                    callsign={c}
                    current={where}
                    pending={pending?.callsign === c ? pending.id : null}
                    overlayOk={overlayOk}
                    onPick={(dest) => pick(c, dest)}
                  />
                  {error?.callsign === c && (
                    <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-ui-xs text-red-300">
                      <AlertCircle size={13} aria-hidden="true" className="shrink-0 mt-px" />{error.message}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
