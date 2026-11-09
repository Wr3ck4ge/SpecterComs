import { useState } from 'react';
import { AlertTriangle, Volume2, VolumeX } from 'lucide-react';
import { IconButton } from '../ui';
import { cx } from '../ui/styles';
import { clampShareVolume } from '../../engine/shareAudio';

// SA: screen-share audio controls for the strip (engine/shareAudio.js; the
// engine plays the audio and persists these settings per sharer — protocol in
// engine/bridge.js, state.voice.shareAudio + shareAudio.setVolume).
// Presentational: the container sends the commands.

/** Does `callsign`'s share carry audio right now? */
export const sharerHasAudio = (voice, callsign) => Boolean(callsign && voice?.shareAudio?.sharers?.includes(callsign));

/** This device's volume / mute for `callsign`'s share audio. */
export function sharerAudioPref(voice, callsign) {
  const p = voice?.shareAudio?.prefs?.[callsign];
  return { volume: clampShareVolume(p?.volume ?? 1), muted: Boolean(p?.muted) };
}

/**
 * Mute + volume slider (0–200 %) for a watched share.
 * pref { volume, muted };  onChange({ volume } | { muted })
 */
export function ShareAudioVolume({ callsign, pref, onChange, compact = false }) {
  // Local while dragging, so the engine round trip can't fight the thumb.
  const [drag, setDrag] = useState(null);
  const shown = drag ?? pref.volume;
  const what = `${callsign}'s stream audio`;
  return (
    <div className="flex items-center gap-1 shrink-0">
      <IconButton
        size="sm"
        icon={pref.muted ? <VolumeX size={15} className="text-red-300" /> : <Volume2 size={15} />}
        label={pref.muted ? `Unmute ${what}` : `Mute ${what}`}
        active={pref.muted}
        onClick={() => onChange?.({ muted: !pref.muted })}
      />
      {!compact && (
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(shown * 100)}
          disabled={pref.muted}
          aria-label={`${what} volume`}
          title={`${Math.round(shown * 100)} %`}
          onChange={(e) => { const v = Number(e.target.value) / 100; setDrag(v); onChange?.({ volume: v }); }}
          onPointerUp={() => setDrag(null)}
          onBlur={() => setDrag(null)}
          className={cx('w-20 h-1 accent-specter-primary-cyan cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed')}
        />
      )}
    </div>
  );
}

/** The sharer's "my audio may pick up voice chat" note (device loopback). */
export function ShareAudioEchoWarning({ className }) {
  return (
    <p role="note" className={cx('flex items-start gap-1.5 text-ui-xs text-amber-200', className)}>
      <AlertTriangle size={13} aria-hidden="true" className="shrink-0 mt-px" />
      Share audio may capture voice chat — use headphones.
    </p>
  );
}
