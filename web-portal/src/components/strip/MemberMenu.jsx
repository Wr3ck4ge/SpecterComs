import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Clock, Loader2, MessageSquare, UserPlus, Volume2, VolumeX, X } from 'lucide-react';
import { cx, focusRing } from '../ui/styles';
import { CMD, memberCommand } from '../../engine/bridge';
import { FRIEND, fmtVolumePct, friendAction } from '../../engine/people';
import { cmdKey } from './useEngine';

// PM: the per-member action menu of the joined voice channel (ChannelsCabinet's
// member rows). Opens anchored under the clicked row — inline in the list, so
// the cabinet's scroll container can't clip it and it stays inside the
// strip's window region. Never shown for my own row.
//
//   Send message   opens the DM pane (friends only: the server relays DMs
//                  between accepted friends)
//   Add friend     or the state: request sent / accept theirs / friends
//   Mute for me    member.setLocalMute (relay stops forwarding them to me)
//   Volume         member.setVolume, 0–200 %, this device only
//
// A non-modal role="dialog", not role="menu": it holds a slider, which a menu
// can't. Keyboard: focus moves into it on open; Tab / Shift+Tab are trapped
// inside it, ArrowUp / ArrowDown move between its controls, Escape (or a click
// outside) closes it and puts focus back on the row.

const FOCUSABLE = 'button:not([disabled]), input:not([disabled])';

function MenuItem({ icon, label, hint, onClick, disabled, pressed, busy }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={cx(
        'w-full h-8 px-2 flex items-center gap-2 rounded-ui-sm text-left text-ui-sm transition-colors',
        disabled ? 'text-specter-text-subtle cursor-default' : 'text-specter-text-main hover:bg-white/5',
        pressed && 'text-amber-300',
        focusRing,
      )}
    >
      <span className="shrink-0 inline-flex w-4 justify-center" aria-hidden="true">
        {busy ? <Loader2 size={14} className="animate-spin" /> : icon}
      </span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {hint && <span className="shrink-0 text-ui-xs text-specter-text-subtle">{hint}</span>}
    </button>
  );
}

/**
 * callsign, person  { userId, friend, localMuted, volume } (state.people[callsign])
 * engine            useEngine (pending)
 * onCommand(type, args) → Promise|void
 * clearError(key)
 * onOpenDm({ userId, callsign }) | undefined (no DM pane here → item hidden)
 * onClose({ restoreFocus })
 */
export default function MemberMenu({ callsign, person, engine, onCommand, clearError = () => {}, onOpenDm, onClose }) {
  const ref = useRef(null);
  const { userId, friend, localMuted } = person;
  const volume = Number.isFinite(person.volume) ? person.volume : 1;
  const [drag, setDrag] = useState(null); // slider value while dragging (0..2)
  const shown = drag ?? volume;
  const pending = engine?.pending || {};
  const statusOf = (type, args) => pending[cmdKey(type, args)];

  const fa = friendAction(friend);
  const [friendType, friendArgs] = fa.action === 'accept' ? memberCommand.friendAccept(userId) : memberCommand.friendRequest(userId);
  const friendStatus = statusOf(friendType, friendArgs);
  const muteStatus = statusOf(CMD.MEMBER_SET_LOCAL_MUTE, { userId });
  const volStatus = statusOf(CMD.MEMBER_SET_VOLUME, { userId });
  const error = [friendStatus, muteStatus, volStatus].find((s) => s?.status === 'error')?.error || null;
  const clearAll = () => {
    clearError(cmdKey(friendType, friendArgs));
    clearError(cmdKey(CMD.MEMBER_SET_LOCAL_MUTE, { userId }));
    clearError(cmdKey(CMD.MEMBER_SET_VOLUME, { userId }));
  };

  // Fresh friend state each time the menu opens (cheap: one GET /friends).
  useEffect(() => { onCommand(CMD.FRIENDS_REFRESH, {}); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the first control on open.
  useLayoutEffect(() => {
    const first = ref.current?.querySelector(FOCUSABLE);
    first?.focus();
  }, []);

  // Click outside closes (the row's own button toggles, so it's excluded via
  // data-member-anchor on the row).
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (e.target.closest?.(`[data-member-anchor="${CSS.escape(callsign)}"]`)) return;
      onClose({ restoreFocus: false });
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [callsign, onClose]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose({ restoreFocus: true }); return; }
    const items = [...(ref.current?.querySelectorAll(FOCUSABLE) || [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Tab') {
      e.preventDefault();
      const n = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
      items[n].focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement?.type !== 'range') {
      e.preventDefault();
      const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      items[n].focus();
    }
  };

  const sendVolume = (v) => onCommand(...memberCommand.setVolume(userId, v));
  const isFriend = friend === FRIEND.FRIENDS;
  let friendIcon = <UserPlus size={14} />;
  if (friend === FRIEND.FRIENDS) friendIcon = <Check size={14} className="text-emerald-300" />;
  else if (friend === FRIEND.OUTGOING) friendIcon = <Clock size={14} />;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={`Actions for ${callsign}`}
      onKeyDown={onKeyDown}
      className="relative mx-3 mb-1 mt-0.5 p-1.5 rounded-ui-md border border-specter-border-strong bg-[#0d2236] shadow-lg"
    >
      {/* the pointer up to the row it belongs to */}
      <span aria-hidden="true" className="absolute -top-[5px] left-6 h-2.5 w-2.5 rotate-45 border-l border-t border-specter-border-strong bg-[#0d2236]" />
      {onOpenDm && (
        <MenuItem
          icon={<MessageSquare size={14} />}
          label="Send message"
          hint={isFriend ? null : 'Friends only'}
          disabled={!isFriend}
          onClick={() => { onOpenDm({ userId, callsign }); onClose({ restoreFocus: false }); }}
        />
      )}
      <MenuItem
        icon={friendIcon}
        label={fa.label}
        disabled={!fa.action || friendStatus?.status === 'pending'}
        busy={friendStatus?.status === 'pending'}
        onClick={() => { clearAll(); onCommand(friendType, friendArgs); }}
      />
      <MenuItem
        icon={localMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        label={localMuted ? 'Unmute for me' : 'Mute for me'}
        pressed={localMuted}
        busy={muteStatus?.status === 'pending'}
        onClick={() => { clearAll(); onCommand(...memberCommand.setLocalMute(userId, !localMuted)); }}
      />
      <div role="group" aria-label={`${callsign}'s volume`} className="px-2 pt-1 pb-1.5">
        <div className="flex items-center justify-between text-ui-xs text-specter-text-subtle">
          <span>Volume (for me)</span>
          <span className="flex items-center gap-1.5">
            <span className={cx('tabular-nums', localMuted ? 'text-amber-300' : 'text-specter-text-main')}>
              {localMuted ? 'Muted' : fmtVolumePct(shown)}
            </span>
            {Math.round(shown * 100) !== 100 && (
              <button
                type="button"
                onClick={() => { setDrag(null); sendVolume(1); }}
                className={cx('text-specter-primary-neon hover:underline rounded-ui-sm', focusRing)}
                aria-label={`Reset ${callsign}'s volume to 100%`}
              >
                Reset
              </button>
            )}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(shown * 100)}
          aria-label={`${callsign}'s volume`}
          aria-valuetext={fmtVolumePct(shown)}
          disabled={localMuted /* muted: the relay doesn't send them at all */}
          onChange={(e) => { const v = Number(e.target.value) / 100; setDrag(v); sendVolume(v); }}
          onPointerUp={() => setDrag(null)}
          onBlur={() => setDrag(null)}
          className={cx('w-full h-4 mt-0.5 accent-[#22d3ee]', localMuted && 'opacity-40')}
        />
      </div>
      {error && (
        <div role="alert" className="flex items-start gap-1.5 mx-2 mb-1 text-ui-xs text-red-300">
          <AlertCircle size={13} aria-hidden="true" className="shrink-0 mt-px" />
          <span className="flex-1 min-w-0">{error}</span>
          <button type="button" onClick={clearAll} className={cx('shrink-0 text-red-300/80 hover:text-red-200', focusRing)} aria-label="Dismiss">
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
