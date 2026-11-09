import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, PhoneCall, Users, X } from 'lucide-react';
import { cx, focusRing } from '../ui/styles';
import { PulseDot } from './StripBarSlots';
import { liveNoticeLayout, liveTimingText, opPresence } from './liveNoticeLayout';

// LIVE: the live-op notice — an extension of the bar on its free side (left
// normally, right when there's no room on the left; liveNoticeLayout), in the
// bar's own height band and panel style. It is the home of live-event info
// while an op is live: open it shows the op (server, name, how long it's been
// live, who's in it, your group) with Join / View / Dismiss; after a while it
// folds into a small pulsing tab against the bar (useLiveNotices), which
// opens it again. Fixed-positioned from the measured bar rect, like the wide
// op panel; carries its own data-strip-region (strip.rs clips the window to
// the panels, so the rest of the screen clicks through).

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * notices   useLiveNotices() result
 * bar       the bar panel's rect { left, right, top, bottom } (viewport px)
 * vw        viewport width
 * engineState  engine.state (presence: my group, who's in voice)
 * joining   true while a Join is in progress
 * onJoin(op), onView(op)
 */
export default function LiveOpNotice({ notices, bar, vw, engineState, joining = false, onJoin, onView }) {
  const now = useNow();
  const op = notices.current;
  if (!op || !bar) return null;
  const open = notices.expanded;
  const place = liveNoticeLayout({ vw, bar, tab: !open });
  if (place.width <= 0 || place.height <= 0) return null;
  const towardBar = place.side === 'left' ? ChevronRight : ChevronLeft;
  const awayFromBar = place.side === 'left' ? ChevronLeft : ChevronRight;
  const style = { position: 'fixed', left: place.left, top: place.top, width: place.width, height: place.height };
  const count = notices.count;

  if (!open) {
    const Away = awayFromBar;
    return (
      <button
        type="button"
        data-strip-region=""
        onClick={notices.expand}
        style={style}
        aria-label={count > 1 ? `${count} operations are live. Show` : `Live now: ${op.name}. Show`}
        title={count > 1 ? `${count} operations live` : `Live now: ${op.name} (${op.orgName})`}
        className={cx('strip-panel flex flex-col items-center justify-center gap-1 text-red-300 hover:bg-white/5',
          place.side === 'left' ? 'strip-live-in-left' : 'strip-live-in-right', focusRing)}
      >
        <PulseDot className="text-red-400" />
        {count > 1
          ? <span className="text-[10px] font-semibold leading-none tabular-nums">{count}</span>
          : <span className="text-[9px] font-semibold tracking-wider leading-none">LIVE</span>}
        <Away size={12} aria-hidden="true" className="text-specter-text-subtle" />
      </button>
    );
  }

  const presence = opPresence(op, engineState);
  const a = notices.assignment;
  const groupName = a?.groupName || presence.group?.name || null;
  const timing = liveTimingText(op, now);
  const who = [
    op.filledSlots > 0 ? `${op.filledSlots} signed up` : null,
    presence.inVoice != null ? `${presence.inVoice} in voice` : null,
  ].filter(Boolean).join(' · ');
  const Toward = towardBar;
  return (
    <section
      data-strip-region=""
      aria-label={`Live operation: ${op.name}`}
      role="status"
      style={style}
      onMouseEnter={() => notices.setHold(true)}
      onMouseLeave={() => notices.setHold(false)}
      onFocus={() => notices.setHold(true)}
      onBlur={() => notices.setHold(false)}
      className={cx('strip-panel overflow-hidden flex items-stretch gap-2 pl-3 pr-1.5 py-1',
        place.side === 'left' ? 'strip-live-in-left' : 'strip-live-in-right',
        place.side === 'right' && 'flex-row-reverse pl-1.5 pr-3')}
    >
      <div className="min-w-0 flex-1 flex flex-col justify-center gap-0.5">
        <div className="flex items-center gap-1.5 min-w-0 text-ui-xs leading-none">
          <PulseDot className="text-red-400" />
          <span className="shrink-0 font-semibold tracking-wide text-red-300">LIVE NOW</span>
          <span className="min-w-0 truncate text-specter-text-subtle" title={op.orgName}>{op.orgName}</span>
          {count > 1 && (
            <span className="ml-auto shrink-0 flex items-center">
              <button type="button" onClick={notices.prev} aria-label="Previous live operation"
                className={cx('h-4 w-4 inline-flex items-center justify-center rounded text-specter-text-subtle hover:text-specter-text-main', focusRing)}>
                <ChevronLeft size={12} aria-hidden="true" />
              </button>
              <span className="tabular-nums text-specter-text-subtle">{notices.index + 1}/{count}</span>
              <button type="button" onClick={notices.next} aria-label="Next live operation"
                className={cx('h-4 w-4 inline-flex items-center justify-center rounded text-specter-text-subtle hover:text-specter-text-main', focusRing)}>
                <ChevronRight size={12} aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
        <div className="truncate text-ui-sm font-semibold text-specter-text-main leading-tight" title={op.name}>{op.name}</div>
        <div className="flex items-center gap-1.5 min-w-0 text-[11px] leading-none text-specter-text-subtle">
          {timing && <span className="shrink-0">{timing}</span>}
          {who && <span className="min-w-0 truncate" title={who}>· {who}</span>}
        </div>
        {groupName && (
          <div className="flex items-center gap-1 min-w-0 text-[11px] leading-none">
            <span className="shrink-0 inline-flex items-center gap-1 rounded-pill bg-specter-primary-cyan/15 px-1.5 py-[2px] text-specter-primary-neon">
              <Users size={10} aria-hidden="true" />Your group
            </span>
            <span className="min-w-0 truncate text-specter-text-muted" title={a?.role ? `${groupName} · ${a.role}` : groupName}>
              {groupName}{presence.group ? ` · ${presence.group.inVoice} in channel` : ''}{a?.role ? ` · ${a.role}` : ''}
            </span>
          </div>
        )}
      </div>
      <div className="shrink-0 flex flex-col justify-center gap-1">
        <button type="button" onClick={() => onJoin?.(op)} disabled={joining}
          title={groupName ? `Join ${groupName}` : 'Join the operation'}
          className={cx('h-6 px-2.5 inline-flex items-center justify-center gap-1 rounded-ui-row text-ui-xs font-semibold',
            'bg-specter-primary-cyan text-specter-bg-deep hover:bg-specter-primary-neon disabled:opacity-60', focusRing)}>
          <PhoneCall size={12} aria-hidden="true" />{joining ? 'Joining…' : 'Join'}
        </button>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onView?.(op)} title="View the operation"
            className={cx('h-6 flex-1 px-2 inline-flex items-center justify-center gap-1 rounded-ui-row text-ui-xs',
              'border border-specter-border text-specter-text-main hover:bg-white/5', focusRing)}>
            <Eye size={12} aria-hidden="true" />View
          </button>
          <button type="button" onClick={() => notices.dismiss(op.key)} aria-label={`Dismiss ${op.name}`} title="Dismiss (won't show again for this launch)"
            className={cx('h-6 w-6 inline-flex items-center justify-center rounded-ui-row text-specter-text-subtle hover:bg-white/5 hover:text-specter-text-main', focusRing)}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
      <button type="button" onClick={notices.collapse} aria-label="Fold the notice into the bar" title="Fold"
        className={cx('shrink-0 w-4 -my-1 inline-flex items-center justify-center text-specter-text-subtle hover:text-specter-text-main hover:bg-white/5', focusRing)}>
        <Toward size={12} aria-hidden="true" />
      </button>
    </section>
  );
}
