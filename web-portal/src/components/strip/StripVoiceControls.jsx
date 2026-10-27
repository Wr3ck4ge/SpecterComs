import { useEffect, useState } from 'react';
import {
  AlertCircle, Layers, Loader2, MicOff, MonitorUp, Radio, RefreshCw, X,
} from 'lucide-react';
import { Button, IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { CMD } from '../../engine/bridge';
import { cmdKey } from './useEngine';
import { PulseDot, SlotChip } from './StripBarSlots'; // BAR2
import { pickSpeaker } from './barSlots'; // BAR2

// Voice controls on the strip's bar (P2A, feedback #3) and the screen-share
// source picker. Presentational: StripApp owns the engine and the picker
// state; the dev preview passes canned ones.
//
// The picker replaces the engine's SourcePickerModal (CommLink) for the
// strip: the sources come from the engine (share.listSources → the same Rust
// capture_list_sources CommLink uses), and the chosen one goes back as
// share.start, which runs CommLink's own capture/encode path.

// ── BAR2: voice chips for the bar's slot row (StripBarSlots) ──────────────
// Replace P2A's VoiceBarButtons (Overlay + Screenshare icons at the bar's far
// right): the bar's upper row now shows who's talking, Stream and Overlay as
// slots (voiceSlots below), next to the update / live-op ones.

// How long the speaker chip keeps showing a speaker after they go quiet, so
// it doesn't flicker between words (levels arrive at LEVELS_HZ).
const SPEAKER_HOLD_MS = 700;

// The latest non-null value, held for `ms` after it goes null.
function useHeld(value, key, ms) {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (value) { setHeld(value); return undefined; }
    const t = setTimeout(() => setHeld(null), ms);
    return () => clearTimeout(t);
    // Keyed on `key` (the value's identity), not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return value || held;
}

/**
 * The "who's talking" chip. In voice: the current speaker (pulsing dot), or
 * "You" when transmitting, else the channel name. Not in voice: a quiet
 * "Not in voice". Clicking opens the Channels cabinet.
 * voice        EngineState.voice;  me: my callsign
 * speaking     engine.levels.speaking;  transmitting: PTT held (optional)
 */
export function SpeakerChip({ voice, me, speaking, transmitting = false, onClick }) {
  const inVoice = Boolean(voice?.channelId);
  const now = inVoice && !voice.muted ? pickSpeaker({ speaking, me, transmitting }) : null;
  const who = useHeld(now, now ? `${now.name}+${now.extra}` : '', SPEAKER_HOLD_MS);
  if (!inVoice) {
    return (
      <SlotChip tone="quiet" icon={<Radio size={12} />} onClick={onClick} title="Not in a voice channel. Open channels">
        Not in voice
      </SlotChip>
    );
  }
  const channel = voice.channelName || 'Voice';
  if (who) {
    const label = who.isMe ? `You are transmitting in ${channel}` : `${who.all.join(', ')} talking in ${channel}`;
    return (
      <SlotChip tone="speak" icon={<PulseDot />} onClick={onClick} label={`${label}. Open channels`} title={label}>
        {who.name}{who.extra > 0 && <span className="text-emerald-300/70"> +{who.extra}</span>}
      </SlotChip>
    );
  }
  const status = voice.status === 'connecting' ? 'Connecting…' : channel;
  return (
    <SlotChip
      tone="default"
      icon={voice.muted ? <MicOff size={12} className="text-red-300" /> : <Radio size={12} />}
      onClick={onClick}
      label={`In voice: ${channel}${voice.muted ? ', muted' : ''}. Open channels`}
      title={`In ${channel}${voice.muted ? ' (muted)' : ''}`}
    >
      {status}
    </SlotChip>
  );
}

function overlayInfo({ state, pending }) {
  const open = state.overlay.open;
  const key = open ? cmdKey(CMD.OVERLAY_CLOSE, {}) : cmdKey(CMD.OVERLAY_OPEN, {});
  const busy = pending[cmdKey(CMD.OVERLAY_OPEN, {})]?.status === 'pending' || pending[cmdKey(CMD.OVERLAY_CLOSE, {})]?.status === 'pending';
  const err = pending[key]?.status === 'error' ? pending[key].error : null;
  let label = open ? 'Close the overlay' : 'Open the overlay';
  if (!state.caps.overlay) label = 'The overlay is in safe mode';
  else if (err) label = `${label} (last try failed: ${err})`;
  return { open, busy, err, label };
}

function shareInfo({ state, pending }) {
  const sharing = state.voice.sharing;
  const stopKey = cmdKey(CMD.SHARE_STOP, {});
  const busy = pending[stopKey]?.status === 'pending';
  const err = pending[stopKey]?.status === 'error' ? pending[stopKey].error : null;
  let label = sharing ? 'Stop sharing your screen' : 'Share your screen';
  if (!sharing && !state.caps.share) label = 'Screen sharing from here needs native capture';
  else if (err) label = `${label} (last try failed: ${err})`;
  return { sharing, busy, err, label };
}

/** Stream: start (opens the source picker) / stop your screen share. */
export function StreamChip({ engine, pickerOpen, onClick }) {
  const { sharing, busy, err, label } = shareInfo(engine);
  if (sharing) {
    // While live it says so in words: easy to spot, easy to stop.
    return (
      <SlotChip tone="live" icon={busy ? <Loader2 size={12} className="animate-spin" /> : <PulseDot className="text-red-400" />}
        onClick={onClick} disabled={busy} label={label} pressed className="!gap-1 !px-1.5">
        Live
      </SlotChip>
    );
  }
  return (
    <SlotChip iconOnly tone={pickerOpen ? 'active' : 'default'} pressed={pickerOpen}
      icon={busy ? <Loader2 size={13} className="animate-spin" /> : <MonitorUp size={13} />}
      onClick={onClick} disabled={busy || !engine.state.caps.share} label={label}>
      {err && <ErrorDot />}
    </SlotChip>
  );
}

/** Overlay HUD on/off. */
export function OverlayChip({ engine, onClick }) {
  const { open, busy, err, label } = overlayInfo(engine);
  return (
    <SlotChip iconOnly tone={open ? 'active' : 'default'} pressed={open}
      icon={busy ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />}
      onClick={onClick} disabled={busy || !engine.state.caps.overlay} label={label}>
      {err && <ErrorDot />}
    </SlotChip>
  );
}

function ErrorDot() {
  return <span aria-hidden="true" className="pointer-events-none absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-pill border-2 border-[#0b1d2e] bg-specter-state-warning" />;
}

function SourceTile({ source, selected, onSelect }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        'min-w-0 text-left rounded-ui-row border p-1 transition-colors',
        selected ? 'border-specter-primary-cyan bg-specter-primary-cyan/10' : 'border-specter-border hover:border-specter-border-strong hover:bg-white/5',
        focusRing,
      )}
    >
      <div className="relative w-full overflow-hidden rounded-ui-sm bg-specter-bg-deep" style={{ paddingBottom: '56.25%' }}>
        {source.thumb
          ? <img src={source.thumb} alt="" className="absolute inset-0 h-full w-full object-contain" />
          : <span className="absolute inset-0 flex items-center justify-center text-ui-xs text-specter-text-subtle">No preview</span>}
      </div>
      <div className="mt-1 px-0.5 truncate text-ui-xs text-specter-text-muted" title={source.name}>{source.name}</div>
    </button>
  );
}

/**
 * The source picker, a panel stacked above the bar.
 * list        { loading, error, sources: [...] }
 * starting    a share.start is in flight
 * startError  its error
 * onRefresh(), onStart(source), onClose()
 * maxHeight
 */
export function SharePicker({ list, starting, startError, onRefresh, onStart, onClose, maxHeight = 520, initialTab = 'monitor' }) {
  const [tab, setTab] = useState(initialTab);
  const [selectedId, setSelectedId] = useState(null);
  const sources = list.sources || [];
  const shown = sources.filter((s) => s.kind === tab);
  const selected = sources.find((s) => s.id === selectedId) || null;

  let body;
  if (list.loading && !sources.length) {
    body = (
      <p className="py-10 flex items-center justify-center gap-2 text-ui-sm text-specter-text-subtle">
        <Loader2 size={14} aria-hidden="true" className="animate-spin" />Finding screens and windows…
      </p>
    );
  } else if (list.error && !sources.length) {
    body = (
      <div role="alert" className="m-3 flex items-start gap-1.5 text-ui-sm text-red-300">
        <AlertCircle size={14} aria-hidden="true" className="shrink-0 mt-0.5" />{list.error}
      </div>
    );
  } else if (!shown.length) {
    body = <p className="py-10 text-center text-ui-sm text-specter-text-subtle">Nothing to share here.</p>;
  } else {
    body = (
      <div className="grid grid-cols-2 gap-2 p-3">
        {shown.map((s) => (
          <SourceTile key={s.id} source={s} selected={s.id === selectedId} onSelect={() => setSelectedId(s.id)} />
        ))}
      </div>
    );
  }

  return (
    <section data-strip-region aria-label="Share your screen" className="strip-panel strip-cabinet-swap shrink-0 flex flex-col overflow-hidden" style={{ maxHeight }}>
      <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <h2 className="text-ui-lg font-semibold text-specter-text-main">Share your screen</h2>
          <p className="text-ui-sm text-specter-text-subtle">Pick a screen or a window</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <IconButton size="sm" icon={<RefreshCw size={15} className={list.loading ? 'animate-spin' : undefined} />} label="Refresh" onClick={onRefresh} disabled={list.loading} />
          <IconButton size="sm" icon={<X size={16} />} label="Close" onClick={onClose} />
        </div>
      </div>
      <div className="flex gap-1 mx-3 p-0.5 rounded-ui-row bg-specter-bg-deep/60" role="tablist" aria-label="Source type">
        {[['monitor', 'Screens'], ['window', 'Windows']].map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={tab === v}
            onClick={() => { setTab(v); setSelectedId(null); }}
            className={cx(
              'flex-1 h-7 rounded-ui-sm text-ui-sm transition-colors',
              tab === v ? 'bg-specter-primary-cyan/15 text-specter-primary-neon' : 'text-specter-text-muted hover:text-specter-text-main hover:bg-white/5',
              focusRing,
            )}
          >
            {label} <span className="text-specter-text-subtle tabular-nums">{sources.filter((s) => s.kind === v).length || ''}</span>
          </button>
        ))}
      </div>
      <div className="strip-scroll min-h-0 flex-1">{body}</div>
      {startError && (
        <div role="alert" className="flex items-start gap-1.5 mx-3 mb-1 text-ui-xs text-red-300">
          <AlertCircle size={13} aria-hidden="true" className="shrink-0 mt-px" />{startError}
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-specter-border-divider">
        <span className="flex-1 min-w-0 truncate text-ui-sm text-specter-text-subtle">
          {selected ? selected.name : 'Select a source'}
        </span>
        <Button
          size="sm"
          disabled={!selected || starting}
          icon={starting ? <Loader2 size={14} className="animate-spin" /> : <MonitorUp size={14} />}
          onClick={() => selected && onStart(selected)}
        >
          {starting ? 'Starting…' : 'Start sharing'}
        </Button>
      </div>
    </section>
  );
}
