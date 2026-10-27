import {
  AlertTriangle, ChevronUp, KeyRound, Layers, Loader2, Maximize2, Minimize2, MonitorOff, RefreshCw, UserX, X,
} from 'lucide-react';
import { Button, IconButton } from '../ui';
import { cx } from '../ui/styles';
import useStripStream, { bridgeStreamSource } from './useStripStream';
import { SV_LAYOUT, streamViewerLayout } from './streamViewerLayout';

// SV: the strip's stream viewer — watch a sharer without the overlay.
// A panel of its own above the main bar (streamViewerLayout), fed by the
// engine over the bridge (useStripStream; protocol in engine/bridge.js).
//
// Modes (StripView decides, from what else is open):
//   full    the 16:9 panel above the bar: header (live dot, sharer, channel)
//           with Expand / Open in overlay / Close
//   mini    a cabinet or the share picker is open: a slim row stacked above
//           it in the column (thumbnail, name, Show / overlay / close). It
//           keeps decoding, so "Show" is instant.
//   hidden  the wide op panel is open: not drawn, not in the region (still
//           decoding — the op panel closes back to the viewer)
// The canvas is the same element in every mode (same tree position), so
// switching modes never drops the decoder or the picture.
//
// props
//   callsign      the sharer being watched
//   voice         engine state.voice (sharers / roster → ended / left states)
//   mode, bar, vw, vh, grow   from StripView (bar = the main bar's rect)
//   onRegion      re-measure the window region (StripView's onRegionChange)
//   expanded, onToggleExpand
//   overlayOk     the overlay can take the stream (state.caps.overlay)
//   error         the stream.watch / overlay hand-off failed (ack error)
//   onOpenOverlay, onClose, onRetry, onShow (mini: close what covers it)
//   source        frame source (dev preview: a mocked one)

function statusView(stream, { callsign, voice, error }) {
  const sharing = voice?.sharers?.includes(callsign);
  const present = voice?.roster?.includes(callsign);
  if (error) return { tone: 'error', Icon: AlertTriangle, title: error, retry: true };
  if (voice && !sharing && !present) return { tone: 'ended', Icon: UserX, title: `${callsign} left the channel` };
  if (voice && !sharing) return { tone: 'ended', Icon: MonitorOff, title: `${callsign} stopped sharing` };
  switch (stream.status) {
    case 'live': return null;
    case 'stalled': return { tone: 'badge', title: stream.message || 'No video for a few seconds…' };
    case 'waiting-key': return { tone: 'wait', Icon: KeyRound, title: 'Waiting for channel key…', sub: 'This device is getting the channel’s encryption key.' };
    case 'waiting-keyframe': return { tone: 'wait', title: 'Waiting for a keyframe…', sub: stream.message && stream.message.startsWith('Channel key') ? 'Channel key acquired.' : null };
    case 'ended': return { tone: 'ended', Icon: MonitorOff, title: stream.message || 'Stream ended', retry: true };
    case 'unavailable': return { tone: 'ended', Icon: MonitorOff, title: stream.message || 'Stream unavailable', retry: true };
    case 'error': return { tone: 'error', Icon: AlertTriangle, title: stream.message || 'Something went wrong with the stream', retry: true };
    default: return { tone: 'wait', title: `Connecting to ${callsign}’s stream…` };
  }
}

function LiveDot({ live }) {
  return (
    <span className={cx('inline-flex items-center gap-1 shrink-0 h-5 px-1.5 rounded-pill text-[10px] font-semibold tracking-wide',
      live ? 'bg-red-500/20 text-red-200' : 'bg-white/[0.06] text-specter-text-subtle')}>
      <span aria-hidden="true" className="relative inline-flex h-1.5 w-1.5">
        {live && <span className="absolute inset-0 rounded-pill bg-red-400 opacity-60 motion-safe:animate-ping" />}
        <span className={cx('relative h-1.5 w-1.5 rounded-pill', live ? 'bg-red-400' : 'bg-specter-text-subtle/60')} />
      </span>
      LIVE
    </span>
  );
}

/** The state shown over (or instead of) the picture. */
function StatusLayer({ view, hasPicture, compact, onRetry, onClose }) {
  if (!view) return null;
  if (view.tone === 'badge') {
    return (
      <div className="absolute left-2 bottom-2 flex items-center gap-1.5 h-6 px-2 rounded-pill bg-black/70 text-ui-xs text-amber-200" role="status">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" />{view.title}
      </div>
    );
  }
  const Icon = view.Icon;
  const spinning = view.tone === 'wait';
  return (
    <div role="status" className={cx('absolute inset-0 flex flex-col items-center justify-center text-center gap-1.5 px-4',
      hasPicture ? 'bg-black/65' : 'bg-specter-bg-deep')}>
      {spinning && !Icon && <Loader2 size={compact ? 14 : 22} className="animate-spin text-specter-primary-cyan" aria-hidden="true" />}
      {Icon && <Icon size={compact ? 14 : 22} aria-hidden="true" className={cx(view.tone === 'error' ? 'text-red-300' : view.tone === 'wait' ? 'text-specter-primary-cyan motion-safe:animate-pulse' : 'text-specter-text-subtle')} />}
      {!compact && (
        <>
          <p className={cx('text-ui-sm font-medium', view.tone === 'error' ? 'text-red-200' : 'text-specter-text-main')}>{view.title}</p>
          {view.sub && <p className="text-ui-xs text-specter-text-subtle">{view.sub}</p>}
          {(view.retry || view.tone === 'ended') && (
            <div className="flex items-center gap-2 mt-1.5">
              {view.retry && <Button size="sm" variant="secondary" className="!h-7" icon={<RefreshCw size={13} />} onClick={onRetry}>Retry</Button>}
              <Button size="sm" variant="ghost" className="!h-7" onClick={onClose}>Close</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function StripStreamViewer({
  callsign, voice = null, channelName = null,
  mode = 'full', bar, vw, vh, grow = 'up', onRegion,
  expanded = false, onToggleExpand, overlayOk = true, error = null,
  onOpenOverlay, onClose, onRetry, onShow,
  source = bridgeStreamSource,
}) {
  const stream = useStripStream({ active: true, callsign, source, paused: mode === 'hidden' });
  const view = statusView(stream, { callsign, voice, error });
  const live = stream.status === 'live' && !view;
  const retry = () => { stream.retry(); onRetry?.(); };
  const lay = bar ? streamViewerLayout({ vw, vh, bar, grow, expanded }) : null;
  const full = mode === 'full' && lay;
  const mini = mode === 'mini';
  const thumbH = Math.round(SV_LAYOUT.miniThumbW * 9 / 16);

  const sharing = !voice || voice.sharers.includes(callsign);
  const overlayBtn = (
    <IconButton size="sm" icon={<Layers size={15} />} disabled={!overlayOk || !sharing} onClick={onOpenOverlay}
      label={!overlayOk ? 'The overlay is in safe mode' : 'Open in overlay'} />
  );
  const closeBtn = <IconButton size="sm" icon={<X size={16} />} label="Close stream" onClick={onClose} />;

  return (
    <section
      aria-label={`${callsign}'s stream`}
      data-strip-region={mode === 'hidden' ? undefined : ''}
      className={cx(
        'strip-panel overflow-hidden flex',
        full ? 'fixed flex-col' : 'relative shrink-0 flex-row items-center gap-2.5 p-1.5',
        mode === 'hidden' && 'hidden',
        full && (grow === 'down' ? 'strip-opbar-in-down' : 'strip-opbar-in-up'),
      )}
      style={full ? {
        left: lay.left, width: lay.width, height: lay.height,
        ...(lay.top != null ? { top: lay.top } : { bottom: lay.bottom }),
        transition: 'width 200ms cubic-bezier(0.2, 0.8, 0.2, 1), height 200ms cubic-bezier(0.2, 0.8, 0.2, 1), left 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      } : undefined}
      // The slide-in (a transform) and a move without a resize don't reach
      // StripView's ResizeObserver: re-measure the window region when they end.
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) onRegion?.(); }}
      onTransitionEnd={(e) => { if (e.target === e.currentTarget) onRegion?.(); }}
    >
      {full ? (
        <header className="flex items-center gap-2 pl-3 pr-1 shrink-0" style={{ height: SV_LAYOUT.headerH }}>
          <LiveDot live={live} />
          <span className="min-w-0 truncate text-ui-sm font-semibold text-specter-text-main" title={callsign}>{callsign}</span>
          {channelName && <span className="min-w-0 truncate text-ui-xs text-specter-text-subtle">· {channelName}</span>}
          <span className="flex-1" />
          {lay.canExpand && (
            <IconButton size="sm" icon={expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              label={expanded ? 'Shrink' : 'Expand'} active={expanded} onClick={onToggleExpand} />
          )}
          {overlayBtn}
          {closeBtn}
        </header>
      ) : null}
      <div className={cx('relative bg-black overflow-hidden', full ? 'flex-1 min-h-0' : 'shrink-0 rounded-ui-sm')}
        style={full ? undefined : { width: SV_LAYOUT.miniThumbW, height: thumbH }}>
        <canvas ref={stream.canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
        <StatusLayer view={view} hasPicture={stream.hasPicture} compact={!full} onRetry={retry} onClose={onClose} />
      </div>
      {mini ? (
        <>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <LiveDot live={live} />
              <span className="min-w-0 truncate text-ui-sm font-semibold text-specter-text-main">{callsign}</span>
            </div>
            <p className="truncate text-ui-xs text-specter-text-subtle">{view && view.tone !== 'badge' ? view.title : channelName ? `Watching in ${channelName}` : 'Watching'}</p>
          </div>
          <div className="flex items-center shrink-0">
            {view?.retry ? <IconButton size="sm" icon={<RefreshCw size={15} />} label="Retry" onClick={retry} />
              : <IconButton size="sm" icon={<ChevronUp size={16} className={grow === 'down' ? 'rotate-180' : undefined} />} label="Show stream" onClick={onShow} />}
            {overlayBtn}
            {closeBtn}
          </div>
        </>
      ) : null}
    </section>
  );
}
