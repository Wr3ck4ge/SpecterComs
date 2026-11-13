import { Loader2, MonitorPlay } from 'lucide-react';
import { ScGameHud } from '../icons/brand'; // BRAND
import { CMD } from '../../engine/bridge';
import { cx, focusRing } from '../ui/styles';

// C2: where a stream can be watched. One list, used by the bar's Streams
// panel, the Channels rows' Watch choice and the viewer's header switch.
// Adding an output (e.g. a pop-out "Window") is one more entry here plus the
// engine command that serves it; no caller branches on the ids.
//
// Destination = {
//   id            stable id ('bar' | 'hud' | …)
//   label         shown on the switch
//   Icon          lucide icon
//   cmd           the bridge command that starts watching there ({ callsign })
//   hint          tooltip when it's not the current one
//   needsOverlay  only while the overlay is usable (state.caps.overlay)
// }
export const WATCH_DESTINATIONS = [
  { id: 'bar', label: 'Bar', Icon: MonitorPlay, cmd: CMD.STREAM_WATCH, hint: 'Watch in the viewer above the bar' },
  { id: 'hud', label: 'Game HUD', Icon: ScGameHud, cmd: CMD.OVERLAY_WATCH, hint: 'Watch over your game', needsOverlay: true },
];

export const watchDestination = (id) => WATCH_DESTINATIONS.find((d) => d.id === id) || null;

/** Where this device is watching `callsign` right now: a destination id, or null. */
export function watchingWhere(state, callsign) {
  const v = state?.voice;
  if (!callsign || !v || v.watchTarget !== callsign) return null;
  if (v.viewer === 'strip') return 'bar';
  if (state.overlay?.open) return 'hud';
  return null;
}

/** Why `dest` can't be used right now, or null. */
export function destinationBlocked(dest, { overlayOk = true } = {}) {
  if (dest.needsOverlay && !overlayOk) return 'The Game HUD is in safe mode (Settings → Game HUD & hotkeys)';
  return null;
}

/**
 * The "where" switch: one button per destination.
 * callsign   the sharer (labels only)
 * current    destination id being watched there now (pressed; clicking it does nothing)
 * pending    destination id whose command is in flight (spinner)
 * overlayOk  state.caps.overlay
 * onPick(dest)
 * compact    icon-only buttons (label in the tooltip), for tight headers
 */
export function WatchWhere({ callsign, current = null, pending = null, overlayOk = true, onPick, compact = false, className }) {
  return (
    <div role="group" aria-label={`Where to watch ${callsign}'s stream`}
      className={cx('flex gap-0.5 p-0.5 rounded-ui-row bg-specter-bg-deep/60', compact ? 'shrink-0' : null, className)}>
      {WATCH_DESTINATIONS.map((d) => {
        const blocked = destinationBlocked(d, { overlayOk });
        const here = current === d.id;
        const busy = pending === d.id;
        const Icon = busy ? Loader2 : d.Icon;
        const tip = blocked || (here ? `Watching in the ${d.label}` : d.hint);
        return (
          <button
            key={d.id}
            type="button"
            aria-pressed={here}
            aria-label={compact ? `${d.label}${here ? ' (watching)' : ''}` : undefined}
            disabled={Boolean(blocked) || busy}
            title={tip}
            onClick={() => { if (!here) onPick?.(d); }}
            className={cx(
              'inline-flex items-center justify-center gap-1.5 rounded-ui-sm text-ui-sm transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              compact ? 'h-6 w-7' : 'flex-1 h-7 px-2',
              here ? 'bg-specter-primary-cyan/15 text-specter-primary-neon' : 'text-specter-text-muted hover:text-specter-text-main hover:bg-white/5',
              focusRing,
            )}
          >
            <Icon size={14} aria-hidden="true" className={busy ? 'animate-spin' : undefined} />
            {!compact && d.label}
          </button>
        );
      })}
    </div>
  );
}
