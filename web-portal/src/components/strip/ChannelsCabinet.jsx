import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle, Hash, Loader2, PhoneOff, Plus, Trash2, Users, Volume2, X,
  ArrowLeft, ChevronRight, RadioTower, // CH2
  KeyRound, Lock, // E2EV
  Eye, // channel visibility
  Crown, // LEADFREQ
  VolumeX, // SA
} from 'lucide-react';
import { Button, IconButton, Input } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { CMD, selectMyChannelUsers, totalUnread } from '../../engine/bridge';
import { cmdKey } from './useEngine';
import { ShareAudioEchoWarning, sharerHasAudio } from './ShareAudioControls'; // SA
import MemberMenu from './MemberMenu'; // PM
import { WATCH_DESTINATIONS, WatchWhere, watchDestination, watchingWhere } from './watchDestinations'; // C2
import { fmtVolumePct } from '../../engine/people'; // PM
import { buildChannelSections, joinBlockedReason } from './channelTree'; // OPTREE
import { ScChannels, ScEncryptedVerified, ScGameHud, ScMicMuted, ScMicOn, ScStreamingLive, ScWatchingStream } from '../icons/brand'; // BRAND

/** CH2: the Channels cabinet's icon (bar button + cabinet header). */
export const CHANNELS_ICON = ScChannels; // BRAND: was Radio

// The Channels cabinet and its side panel, fed by the engine bridge
// (src/engine/bridge.js). Presentational — StripApp owns the bridge and the
// side-panel focus; the dev preview passes canned ones.
//
// The cabinet lists the selected server's channels. Clicking a row "focuses"
// it, and the cabinet itself widens toward the free side (P2A; normally left,
// the strip sits by the tray) with a pane sliding in as part of the same
// panel — StripApp passes it as `pane` and drives the width (useFluidExpand):
//   voice  first click: the channel's members in the pane
//          second click (or Join there): join. The joined channel's pane is
//          live: speaking indicators, a Watch button next to each sharer
//          (C2: it opens the Bar / Game HUD choice under the row,
//          watchDestinations.jsx), mic + leave.
//   text   the chat (StripChat), with a red unread count on unfocused rows.
//
// CH2: two views while in voice.
//   joined  (default once in voice) the channel list collapses and the joined
//           channel takes the cabinet: header (back arrow, name, status),
//           its members (speaking, stream button next to sharers) and my
//           controls. A voice-preview pane is redundant here, so a focused
//           voice row is unfocused; an open chat pane stays open beside it.
//   browse  the full list, with a compact "you're in …" row (mic + leave) at
//           the top that returns to the joined view; clicking the joined
//           channel's row does too.
// Which one shows: joined iff in voice and the user hasn't pressed back for
// THIS channel — `browseFor` (owned by the container so it survives the strip
// hiding) holds the channel id the user backed out of. Joining another
// channel therefore lands in its joined view; leaving shows the list (and the
// container clears browseFor).
//
// OPTREE: a launched operation is one entry (channelTree.js): a heading with
// the op's name and a crown, which nobody joins (command and frequencies are
// not rows here). Its group
// channels hang beneath it, indented by depth in the group tree. My own
// group's row is highlighted (amber edge + "Your group"); a group I may not
// join shows a lock, can still be clicked to see who's there, but never joins
// (the panel's Join is disabled with the reason). The server enforces the
// same rule on the media ticket; this only mirrors it.

/**
 * focus: null | { kind: 'voice' | 'text', id }
 *             | { kind: 'dm', id: userId, name: callsign }   PM: a DM pane
 */
export const sameFocus = (a, b) => Boolean(a && b && a.kind === b.kind && a.id === b.id);

function usePendingHelpers(pending = {}) {
  const pendingFor = (type, args) => pending[cmdKey(type, args)]?.status === 'pending';
  const errorFor = (type, args) => (pending[cmdKey(type, args)]?.status === 'error' ? pending[cmdKey(type, args)].error : null);
  return { pendingFor, errorFor };
}

const pluralUsers = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

function SpeakingDot({ speaking }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'h-2 w-2 shrink-0 rounded-pill transition-colors duration-100',
        speaking ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.85)]' : 'bg-specter-text-subtle/40',
      )}
    />
  );
}

function RowError({ message, onDismiss, className = 'mx-3' }) {
  return (
    <div role="alert" className={cx('flex items-start gap-1.5 mb-1 text-ui-xs text-red-300', className)}>
      <AlertCircle size={13} aria-hidden="true" className="shrink-0 mt-px" />
      <span className="flex-1 min-w-0">{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className={cx('shrink-0 text-red-300/80 hover:text-red-200', focusRing)} aria-label="Dismiss">
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// E2EV: voice is end-to-end encrypted only. While this device has no channel
// key it sends nothing and plays nothing ("Waiting for channel key…") and the
// engine keeps recovering it; a server version-gate refusal shows as
// "Update required" (the full text renders as a RowError under the header).
function VoiceStatus({ status, keyState = null, keyProblem = null, error = null }) {
  if (error) return <span className="shrink-0 text-ui-xs text-red-300" title={error}>Update required</span>;
  if (status === 'connected' && keyState === 'waiting') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-ui-xs text-amber-300" title={keyProblem || "Your voice stays silent until this device receives the channel's encryption key"}>
        <KeyRound size={12} aria-hidden="true" className="animate-pulse" />Waiting for channel key…
      </span>
    );
  }
  if (status === 'connected') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-ui-xs text-emerald-300" title="Voice is end-to-end encrypted">
        <ScEncryptedVerified size={11} />Connected
      </span>
    );
  }
  if (status === 'error') return <span className="shrink-0 text-ui-xs text-red-300">Connection lost</span>;
  return (
    <span className="shrink-0 inline-flex items-center gap-1 text-ui-xs text-specter-text-subtle">
      <Loader2 size={12} aria-hidden="true" className="animate-spin" />Connecting…
    </span>
  );
}

/** Why this device has no channel key, while it's stuck waiting (state.voice.keyProblem; optional). */
function KeyProblem({ voice, className }) {
  if (!voice.keyProblem || voice.status !== 'connected' || voice.keyState !== 'waiting') return null;
  return <p role="status" className={cx('text-ui-xs text-amber-300/90', className)}>{voice.keyProblem}</p>;
}

/**
 * LEADFREQ: during an op, which frequency carries my voice — my group channel
 * or one of my frequencies (the Leadership net first-class, crown + amber).
 * The ones not transmitting are still heard (the engine monitors them).
 * Renders nothing outside ops (state.voice.freqs is empty).
 */
function FrequencyChips({ engine, onCommand, clearError }) {
  const freqs = engine.state.voice.freqs || [];
  const { pendingFor, errorFor } = usePendingHelpers(engine.pending);
  if (freqs.length < 2) return null;
  const err = freqs.map((f) => errorFor(CMD.VOICE_SET_FREQUENCY, { index: f.index })).find(Boolean);
  // Frequency overlay: every net stays connected; this names the one with my mic.
  const active = freqs.find((f) => f.active);
  const activeLabel = active ? (active.command ? 'Command' : active.leadership ? 'Leadership' : active.name) : null;
  return (
    <div className="mb-2">
      {activeLabel && (
        <p className="mb-1 text-ui-xs text-specter-text-muted" aria-live="polite">
          Talking on <span className="font-semibold text-specter-primary-neon">{activeLabel}</span>
          {active.kind === 'frequency' ? ' · group stays connected, quieter' : ''}
        </p>
      )}
      <div role="radiogroup" aria-label="Transmit on" className="flex flex-wrap items-center gap-1">
        {freqs.map((f) => {
          const args = { index: f.index };
          const pending = pendingFor(CMD.VOICE_SET_FREQUENCY, args);
          const Icon = f.leadership || f.command ? Crown : f.kind === 'group' ? Users : RadioTower;
          return (
            <button
              key={f.index}
              type="button"
              role="radio"
              aria-checked={f.active}
              disabled={pending}
              title={f.active ? `Transmitting on ${f.command ? 'Command' : f.name}` : `Talk on ${f.command ? 'Command' : f.name}${f.listening ? ' (you can hear it now)' : ''}`}
              onClick={() => { if (!f.active) { clearError(cmdKey(CMD.VOICE_SET_FREQUENCY, args)); onCommand(CMD.VOICE_SET_FREQUENCY, args); } }}
              className={cx(
                'inline-flex items-center gap-1 h-6 max-w-[160px] px-2 rounded-pill border text-ui-xs font-medium transition-colors',
                f.active
                  ? (f.leadership ? 'bg-specter-state-warning/15 border-specter-state-warning/60 text-amber-300' : 'bg-specter-primary-cyan/15 border-specter-primary-cyan/60 text-specter-primary-neon')
                  : (f.leadership ? 'border-specter-state-warning/30 text-amber-200/80 hover:bg-white/5' : 'border-specter-border-divider text-specter-text-muted hover:bg-white/5'),
                focusRing,
              )}
            >
              {pending ? <Loader2 size={11} aria-hidden="true" className="animate-spin" /> : <Icon size={11} aria-hidden="true" className="shrink-0" />}
              <span className="truncate">{f.command ? 'Command' : f.leadership ? 'Leadership' : f.name}</span>
              {f.active && <ScMicOn size={10} aria-label="transmitting" className="shrink-0" />}
            </button>
          );
        })}
      </div>
      {err && <RowError className="mt-1" message={err} onDismiss={() => freqs.forEach((f) => clearError(cmdKey(CMD.VOICE_SET_FREQUENCY, { index: f.index })))} />}
    </div>
  );
}

/** Mic + leave for the channel I'm in (used in the cabinet and the panel). */
function MyVoiceControls({ engine, onCommand, clearError }) {
  const v = engine.state.voice;
  const { pendingFor, errorFor } = usePendingHelpers(engine.pending);
  const mutePending = pendingFor(CMD.VOICE_SET_MUTED, {});
  const leavePending = pendingFor(CMD.VOICE_LEAVE, {});
  const muteErr = errorFor(CMD.VOICE_SET_MUTED, {});
  const leaveErr = errorFor(CMD.VOICE_LEAVE, {});
  return (
    <>
      <FrequencyChips engine={engine} onCommand={onCommand} clearError={clearError} /> {/* LEADFREQ */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          className={cx('!h-7', !v.muted && '!border-emerald-500/50 !bg-emerald-500/10 !text-emerald-300')}
          disabled={mutePending || v.status !== 'connected'}
          aria-pressed={v.muted}
          icon={mutePending ? <Loader2 size={13} className="animate-spin" /> : v.muted ? <ScMicMuted size={13} /> : <ScMicOn size={13} />}
          onClick={() => { clearError(cmdKey(CMD.VOICE_SET_MUTED, {})); onCommand(CMD.VOICE_SET_MUTED, { muted: !v.muted }); }}
        >
          {v.muted ? 'Unmute' : 'Mute'}
        </Button>
        {/* Deafen goes here once the engine supports it (state.caps.deafen, voice.setDeafened). */}
        <Button
          variant="danger"
          size="sm"
          className="!h-7"
          disabled={leavePending}
          icon={leavePending ? <Loader2 size={13} className="animate-spin" /> : <PhoneOff size={13} />}
          onClick={() => { clearError(cmdKey(CMD.VOICE_LEAVE, {})); onCommand(CMD.VOICE_LEAVE, {}); }}
        >
          Leave
        </Button>
      </div>
      {muteErr && <RowError className="mt-1" message={muteErr} onDismiss={() => clearError(cmdKey(CMD.VOICE_SET_MUTED, {}))} />}
      {leaveErr && <RowError className="mt-1" message={leaveErr} onDismiss={() => clearError(cmdKey(CMD.VOICE_LEAVE, {}))} />}
    </>
  );
}

// ── Side panel: a voice channel's members ──────────────────────────────────

/**
 * The live members of my voice channel: speaking, mute, stream buttons.
 * PM: clicking another member's name opens their action menu (MemberMenu);
 * rows show when I've muted someone for me and their volume when it isn't 100 %.
 */
function MyChannelMembers({ engine, onCommand, clearError, onOpenDm }) {
  const { state, levels } = engine;
  const v = state.voice;
  const { pendingFor, errorFor } = usePendingHelpers(engine.pending);
  const overlayOk = state.caps.overlay;
  const users = selectMyChannelUsers(state, levels);
  const [menuFor, setMenuFor] = useState(null); // callsign whose menu is open (PM)
  const [chooseFor, setChooseFor] = useState(null); // C2: callsign whose Watch choice is open
  const anchorRefs = useRef(new Map());
  const menuForRef = useRef(null);
  menuForRef.current = menuFor;
  const closeMenu = useCallback(({ restoreFocus } = {}) => {
    const cur = menuForRef.current;
    setMenuFor(null);
    if (cur && restoreFocus) anchorRefs.current.get(cur)?.focus();
  }, []);
  // They left (or I did): nothing to show a menu for.
  const menuUser = menuFor ? users.find((u) => u.callsign === menuFor && u.person?.userId) : null;
  useEffect(() => { if (menuFor && !menuUser) setMenuFor(null); }, [menuFor, menuUser]);
  return (
    <ul className="py-1" aria-label="People in your channel">
      {users.map((u) => {
        const person = u.person; // PM
        const hasMenu = !u.isMe && Boolean(person?.userId);
        const menuOpen = hasMenu && menuFor === u.callsign;
        const nameClass = cx('flex-1 min-w-0 truncate', u.speaking ? 'text-emerald-300' : 'text-specter-text-main');
        const watchArgs = { callsign: u.callsign };
        // C2: where I'm watching them (WATCH_DESTINATIONS id), what's in flight, what failed.
        const where = watchingWhere(state, u.callsign);
        const busyAt = WATCH_DESTINATIONS.find((d) => pendingFor(d.cmd, watchArgs))?.id ?? null;
        const watchErrDest = WATCH_DESTINATIONS.find((d) => errorFor(d.cmd, watchArgs));
        const watchErr = watchErrDest ? errorFor(watchErrDest.cmd, watchArgs) : null;
        const chooseOpen = chooseFor === u.callsign && u.sharing && !u.isMe;
        return (
          <li key={u.callsign}>
            <div className="flex items-center gap-2 h-8 px-4 text-ui-sm">
              <SpeakingDot speaking={u.speaking} />
              {hasMenu ? (
                <button
                  type="button"
                  ref={(el) => { if (el) anchorRefs.current.set(u.callsign, el); else anchorRefs.current.delete(u.callsign); }}
                  data-member-anchor={u.callsign}
                  aria-haspopup="dialog"
                  aria-expanded={menuOpen}
                  title={`Options for ${u.callsign}`}
                  onClick={() => setMenuFor((cur) => (cur === u.callsign ? null : u.callsign))}
                  className={cx(nameClass, 'h-7 -ml-1 px-1 flex items-center gap-1.5 text-left rounded-ui-sm hover:bg-white/5', menuOpen && 'bg-white/5', focusRing)}
                >
                  <span className="min-w-0 truncate">{u.callsign}</span>
                  {person.localMuted && (
                    <VolumeX size={12} className="shrink-0 text-amber-300" aria-label="Muted for you" />
                  )}
                  {!person.localMuted && Math.round((person.volume ?? 1) * 100) !== 100 && (
                    <span className="shrink-0 px-1 rounded-pill bg-white/5 text-ui-xs tabular-nums text-specter-text-subtle" aria-label={`Volume ${fmtVolumePct(person.volume)}`}>
                      {fmtVolumePct(person.volume)}
                    </span>
                  )}
                </button>
              ) : (
                <span className={nameClass}>
                  {u.callsign}
                  {u.isMe && <span className="ml-1 text-ui-xs text-specter-text-subtle">(you)</span>}
                </span>
              )}
              {u.isMe && v.muted && <ScMicMuted size={13} className="shrink-0 text-specter-text-subtle" aria-label="Muted" />}
              {u.sharing && u.isMe && v.shareAudio?.supported && (
                // SA: my share's audio on/off, while sharing.
                <IconButton
                  size="sm"
                  active={Boolean(v.shareAudio.enabled)}
                  disabled={pendingFor(CMD.SHARE_SET_AUDIO, { enabled: !v.shareAudio.enabled })}
                  icon={v.shareAudio.enabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
                  label={v.shareAudio.enabled ? 'Stop sharing your audio' : 'Share your audio too'}
                  onClick={() => onCommand(CMD.SHARE_SET_AUDIO, { enabled: !v.shareAudio.enabled })}
                />
              )}
              {u.sharing && u.isMe && (
                <ScStreamingLive size={14} className="shrink-0 mx-1.5 text-specter-primary-neon" aria-label="You're sharing your screen" />
              )}
              {u.sharing && !u.isMe && sharerHasAudio(v, u.callsign) && (
                // SA: this share carries audio.
                <Volume2 size={13} className="shrink-0 text-specter-text-subtle" aria-label={`${u.callsign}'s stream has audio`} />
              )}
              {u.sharing && !u.isMe && (
                // C2: one Watch button; the where (Bar / Game HUD) opens below the row.
                <IconButton
                  size="sm"
                  active={Boolean(where) || chooseOpen}
                  aria-expanded={chooseOpen}
                  disabled={Boolean(busyAt)}
                  icon={busyAt ? <Loader2 size={15} className="animate-spin" />
                    : where === 'hud' ? <ScGameHud size={15} /> : <ScWatchingStream size={15} />}
                  label={where ? `Watching ${u.callsign} in the ${watchDestination(where)?.label}. Change where`
                    : `Watch ${u.callsign}'s stream`}
                  onClick={() => setChooseFor((cur) => (cur === u.callsign ? null : u.callsign))}
                />
              )}
            </div>
            {chooseOpen && (
              <WatchWhere
                className="mx-4 mb-1.5"
                callsign={u.callsign}
                current={where}
                pending={busyAt}
                overlayOk={overlayOk}
                onPick={(dest) => {
                  clearError(cmdKey(dest.cmd, watchArgs));
                  onCommand(dest.cmd, watchArgs);
                  setChooseFor(null);
                }}
              />
            )}
            {menuOpen && (
              <MemberMenu
                callsign={u.callsign}
                person={person}
                engine={engine}
                onCommand={onCommand}
                clearError={clearError}
                onOpenDm={onOpenDm}
                onClose={closeMenu}
              />
            )}
            {watchErr && <RowError className="mx-4" message={watchErr} onDismiss={() => clearError(cmdKey(watchErrDest.cmd, watchArgs))} />}
            {u.isMe && u.sharing && v.shareAudio?.active && v.shareAudio.echoRisk && <ShareAudioEchoWarning className="mx-4 mb-1" /> /* SA */}
            {u.isMe && u.sharing && v.shareAudio?.error && (
              <p role="alert" className="mx-4 mb-1 text-ui-xs text-red-300">Share audio: {v.shareAudio.error}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The focused voice channel, shown in the side panel. Joined: live users
 * (speaking from engine-levels), stream buttons, my controls. Not joined:
 * who's there (server presence) and Join.
 */
export function VoiceChannelPanel({ engine, channel, onCommand, clearError = () => {}, onClose, onOpenDm }) {
  const v = engine.state.voice;
  const { pendingFor, errorFor } = usePendingHelpers(engine.pending);
  const joined = v.channelId === channel.id;
  const blocked = joinBlockedReason(channel); // OPTREE
  const joinArgs = { channelId: channel.id };
  const joining = pendingFor(CMD.VOICE_JOIN, joinArgs);
  const joinErr = errorFor(CMD.VOICE_JOIN, joinArgs);

  let list;
  if (joined) {
    list = <MyChannelMembers engine={engine} onCommand={onCommand} clearError={clearError} onOpenDm={onOpenDm} />;
  } else if (!channel.occupants.length) {
    list = <p className="px-4 py-3 text-ui-sm text-specter-text-subtle">Nobody here yet.</p>;
  } else {
    list = (
      <ul className="py-1" aria-label="People in this channel">
        {channel.occupants.map((u) => (
          <li key={u} className="flex items-center gap-2 h-8 px-4 text-ui-sm text-specter-text-main">
            <SpeakingDot speaking={false} />
            <span className="truncate">{u}</span>
          </li>
        ))}
      </ul>
    );
  }
  const count = joined ? Math.max(v.roster.length, 1) : channel.occupants.length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-start gap-2 px-4 pt-3 pb-2 border-b border-specter-border-divider">
        {channel.eventKind === 'command'
          ? <Crown size={16} aria-hidden="true" className={cx('shrink-0 mt-1', joined ? 'text-emerald-400' : 'text-amber-300')} />
          : <Volume2 size={16} aria-hidden="true" className={cx('shrink-0 mt-1', joined ? 'text-emerald-400' : 'text-specter-primary-neon')} />}
        <div className="flex-1 min-w-0">
          <h2 className="truncate text-ui-lg font-semibold text-specter-text-main">
            {channel.eventKind === 'command' ? `${channel.eventName || channel.name} · Command` : channel.name}
          </h2>
          <p className="text-ui-sm text-specter-text-subtle">
            {joined ? <VoiceStatus status={v.status} keyState={v.keyState} keyProblem={v.keyProblem} error={v.error} /> : count ? pluralUsers(count) : 'Empty'}
          </p>
          {joined && <KeyProblem voice={v} className="mt-1" />}
        </div>
        <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
      </div>
      {joined && v.error && <RowError className="mx-4 mt-2" message={v.error} /> /* E2EV */}
      <div className="strip-scroll min-h-0 flex-1">{list}</div>
      <div className="px-4 py-3 border-t border-specter-border-divider">
        {joined ? (
          <MyVoiceControls engine={engine} onCommand={onCommand} clearError={clearError} />
        ) : blocked ? (
          // OPTREE: not mine to join — say why instead of offering a Join the
          // server would refuse.
          <>
            <Button size="sm" full disabled icon={<Lock size={14} />}>Join</Button>
            <p className="mt-1.5 text-center text-ui-xs text-specter-text-subtle">{blocked}</p>
          </>
        ) : (
          <>
            <Button
              size="sm"
              full
              disabled={joining}
              icon={joining ? <Loader2 size={14} className="animate-spin" /> : <Volume2 size={14} />}
              onClick={() => { clearError(cmdKey(CMD.VOICE_JOIN, joinArgs)); onCommand(CMD.VOICE_JOIN, joinArgs); }}
            >
              {joining ? 'Joining…' : 'Join'}
            </Button>
            {joinErr
              ? <RowError className="mt-2" message={joinErr} onDismiss={() => clearError(cmdKey(CMD.VOICE_JOIN, joinArgs))} />
              : <p className="mt-1.5 text-center text-ui-xs text-specter-text-subtle">Or click the channel again</p>}
          </>
        )}
      </div>
    </div>
  );
}

// ── CH2: in-voice views ────────────────────────────────────────────────────

/**
 * Browse view, in voice: one compact row — "You're in <channel>" (click → the
 * joined view) with icon-only mute + leave so they stay one click away.
 */
function InVoiceRow({ engine, onCommand, clearError, onOpen }) {
  const v = engine.state.voice;
  const { pendingFor, errorFor } = usePendingHelpers(engine.pending);
  const mutePending = pendingFor(CMD.VOICE_SET_MUTED, {});
  const leavePending = pendingFor(CMD.VOICE_LEAVE, {});
  const err = errorFor(CMD.VOICE_SET_MUTED, {}) || errorFor(CMD.VOICE_LEAVE, {});
  let status = null;
  if (v.error) status = <AlertCircle size={13} className="shrink-0 text-red-300" aria-label={v.error} />; // E2EV
  else if (v.status === 'error') status = <AlertCircle size={13} className="shrink-0 text-red-300" aria-label="Connection lost" />;
  else if (v.status === 'connected' && v.keyState === 'waiting') status = <KeyRound size={13} className="shrink-0 animate-pulse text-amber-300" aria-label={v.keyProblem || 'Waiting for channel key'} />; // E2EV
  else if (v.status !== 'connected') status = <Loader2 size={13} className="shrink-0 animate-spin text-specter-text-subtle" aria-label="Connecting" />;
  return (
    <>
      <div className="mx-3 mb-2 flex items-center gap-0.5 h-10 pl-1 pr-1 rounded-ui-row border border-emerald-500/30 bg-emerald-500/5">
        <button
          type="button"
          onClick={onOpen}
          title="Back to your channel"
          aria-label={`You're in ${v.channelName || 'a voice channel'}. Open it`}
          className={cx('group flex-1 min-w-0 h-8 flex items-center gap-2 pl-1.5 pr-1 rounded-ui-sm text-left hover:bg-emerald-500/10 transition-colors', focusRing)}
        >
          <Volume2 size={15} aria-hidden="true" className="shrink-0 text-emerald-400" />
          <span className="min-w-0 flex-1 truncate text-ui-sm">
            <span className="text-specter-text-subtle">You&apos;re in </span>
            <span className="font-semibold text-specter-text-main">{v.channelName}</span>
          </span>
          {status}
          <ChevronRight size={15} aria-hidden="true" className="shrink-0 text-specter-text-subtle group-hover:text-emerald-300" />
        </button>
        <IconButton
          size="sm"
          className={cx('!h-7 !w-7', !v.muted && '!text-emerald-300')}
          disabled={mutePending || v.status !== 'connected'}
          active={v.muted}
          icon={mutePending ? <Loader2 size={14} className="animate-spin" /> : v.muted ? <ScMicMuted size={14} /> : <ScMicOn size={14} />}
          label={v.muted ? 'Unmute' : 'Mute'}
          onClick={() => { clearError(cmdKey(CMD.VOICE_SET_MUTED, {})); onCommand(CMD.VOICE_SET_MUTED, { muted: !v.muted }); }}
        />
        <IconButton
          size="sm"
          variant="danger"
          className="!h-7 !w-7"
          disabled={leavePending}
          icon={leavePending ? <Loader2 size={14} className="animate-spin" /> : <PhoneOff size={14} />}
          label="Leave"
          onClick={() => { clearError(cmdKey(CMD.VOICE_LEAVE, {})); onCommand(CMD.VOICE_LEAVE, {}); }}
        />
      </div>
      {err && (
        <RowError
          message={err}
          onDismiss={() => { clearError(cmdKey(CMD.VOICE_SET_MUTED, {})); clearError(cmdKey(CMD.VOICE_LEAVE, {})); }}
        />
      )}
    </>
  );
}

/** Joined view header: back to the list, the channel, its status, close. */
function JoinedHeader({ engine, onBack, onClose }) {
  const { state } = engine;
  const v = state.voice;
  const count = Math.max(v.roster.length, 1);
  const unread = totalUnread(state);
  return (
    <div className="flex items-start gap-1.5 pl-2 pr-4 pt-3 pb-2 border-b border-specter-border-divider">
      <span className="relative inline-flex shrink-0">
        <IconButton
          size="sm"
          icon={<ArrowLeft size={16} />}
          label={unread > 0 ? `All channels (${unread} unread)` : 'All channels'}
          onClick={onBack}
        />
        {unread > 0 && (
          <span aria-hidden="true" className="pointer-events-none absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-pill border-2 border-specter-brand-ink bg-red-500" />
        )}
      </span>
      <Volume2 size={16} aria-hidden="true" className="shrink-0 mt-1.5 text-emerald-400" />
      <div className="flex-1 min-w-0">
        <h2 className="truncate text-ui-lg font-semibold text-specter-text-main">{v.channelName}</h2>
        <p className="flex items-center gap-1.5 text-ui-sm text-specter-text-subtle">
          <VoiceStatus status={v.status} keyState={v.keyState} keyProblem={v.keyProblem} error={v.error} />
          <span aria-hidden="true">·</span>
          <span className="truncate">{pluralUsers(count)}</span>
        </p>
        <KeyProblem voice={v} className="mt-1" />
        {v.error && <RowError className="mt-1" message={v.error} /> /* E2EV */}
      </div>
      <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
    </div>
  );
}

// ── Cabinet ────────────────────────────────────────────────────────────────

// ── Channel visibility (owner, 2026-11-08) ────────────────────────────────
// A channel can be limited to ranks at or above a level; the owner always
// sees it. You can't restrict one above your own rank (the server refuses).

/** Ranks (from the server) → picker options I may choose. */
export function visibilityOptions(ranks, org) {
  const mine = org?.isOwner ? Infinity : Number(org?.level) || 0;
  const seen = new Set([0]);
  const opts = [{ value: 0, label: 'Everyone' }];
  for (const r of [...(ranks || [])].sort((a, b) => Number(a.level) - Number(b.level))) {
    const lv = Number(r.level) || 0;
    if (lv <= 0 || lv > mine || seen.has(lv)) continue;
    seen.add(lv);
    opts.push({ value: lv, label: `${r.name} and above` });
  }
  return opts;
}

export function visibilityLabel(ch, ranks) {
  if (!(ch.minLevel > 0)) return null;
  const r = (ranks || []).filter((x) => Number(x.level) === ch.minLevel)[0];
  return r ? `Visible to ${r.name} and above` : `Visible to rank level ${ch.minLevel} and above`;
}

const visSelectCls = cx(
  'w-full h-8 px-2 rounded-ui-row text-ui-sm text-specter-text-main bg-specter-bg-deep/60 border border-specter-border',
  'hover:border-specter-border-strong focus:border-specter-primary-cyan focus:outline-none disabled:opacity-50',
);

function VisibilityPicker({ value, options, onChange, disabled }) {
  // A level not among my options (set by a higher rank) still shows.
  const opts = options.some((o) => o.value === value) ? options : [...options, { value, label: `Level ${value} and above` }];
  return (
    <label className="block text-ui-xs text-specter-text-subtle">
      <span className="inline-flex items-center gap-1 mb-1"><Eye size={12} aria-hidden="true" />Who can see it</span>
      <select className={visSelectCls} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function VisibilityEdit({ channel, options, busy, error, onSave, onCancel, adultAvailable = false }) {
  const [value, setValue] = useState(channel.minLevel || 0);
  const [adult, setAdult] = useState(Boolean(channel.adult));
  return (
    <div className="mx-1 mb-1 px-2 py-2 space-y-2 rounded-ui-row border border-specter-border bg-specter-bg-deep/40" aria-label={`Who can see ${channel.name}`}>
      <p className="text-ui-sm text-specter-text-main"><span className="font-semibold">{channel.name}</span></p>
      <VisibilityPicker value={value} options={options} onChange={setValue} disabled={busy} />
      <p className="text-ui-xs text-specter-text-subtle">Members below this rank won&apos;t see the channel or be able to join it.</p>
      {(adultAvailable || channel.adult) && (
        <label className="flex items-start gap-2 text-ui-sm text-specter-text-main">
          <input type="checkbox" className="mt-0.5" checked={adult} disabled={busy} onChange={(e) => setAdult(e.target.checked)} />
          <span>18+ channel<span className="block text-ui-xs text-specter-text-subtle">Adults only. Members confirm they are 18 or older before entering.</span></span>
        </label>
      )}
      {error && <p role="alert" className="text-ui-xs text-red-300">{error}</p>}
      <div className="flex gap-1.5">
        <Button size="sm" onClick={() => onSave(value, adult)} disabled={busy || (value === (channel.minLevel || 0) && adult === Boolean(channel.adult))}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

function CreateChannelForm({ busy, error, onSubmit, onCancel, visibility = null }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('voice');
  const [minLevel, setMinLevel] = useState(0);
  return (
    <form
      className="mx-3 mb-2 p-3 space-y-2 rounded-ui-row border border-specter-border bg-specter-bg-deep/40"
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit({ name: name.trim(), kind, minLevel }); }}
      aria-label="Create channel"
    >
      <Input
        autoFocus
        maxLength={64 /* TEXT_LIMITS.channelName (identity-node utils/validation.ts) */}
        placeholder="Channel name"
        aria-label="Channel name"
        maxLength={64}
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={busy}
      />
      <div className="flex gap-1 p-0.5 rounded-ui-row bg-specter-bg-deep/60" role="radiogroup" aria-label="Channel type">
        {[{ v: 'voice', label: 'Voice', Icon: Volume2 }, { v: 'text', label: 'Text', Icon: Hash }].map((opt) => (
          <button
            key={opt.v}
            type="button"
            role="radio"
            aria-checked={kind === opt.v}
            onClick={() => setKind(opt.v)}
            disabled={busy}
            className={cx(
              'flex-1 h-7 inline-flex items-center justify-center gap-1.5 rounded-ui-sm text-ui-sm transition-colors',
              kind === opt.v
                ? 'bg-specter-primary-cyan/15 text-specter-primary-neon'
                : 'text-specter-text-muted hover:text-specter-text-main hover:bg-white/5',
              focusRing,
            )}
          >
            <opt.Icon size={14} aria-hidden="true" />
            {opt.label}
          </button>
        ))}
      </div>
      {visibility && visibility.length > 1 && (
        <VisibilityPicker value={minLevel} options={visibility} onChange={setMinLevel} disabled={busy} />
      )}
      {error && <div role="alert" className="text-ui-xs text-red-300">{error}</div>}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" className="flex-1" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
        <Button variant="secondary" size="sm" className="flex-1" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

function DeleteConfirm({ channel, busy, error, onConfirm, onCancel }) {
  return (
    <div className="mx-1 mb-1 px-2 py-2 rounded-ui-row border border-specter-state-error/40 bg-specter-state-error/10" role="alertdialog" aria-label={`Delete ${channel.name}?`}>
      <p className="text-ui-sm text-specter-text-main">Delete <span className="font-semibold">{channel.name}</span>? This can&apos;t be undone.</p>
      {error && <p role="alert" className="mt-1 text-ui-xs text-red-300">{error}</p>}
      <div className="flex gap-1.5 mt-2">
        <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</Button>
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return <div className="px-3 pt-2 pb-1 text-ui-xs font-semibold text-specter-text-subtle">{children}</div>;
}

/** OPTREE: an op's entry in the list: its name. Not a channel, nothing to join. */
function OpHeading({ name }) {
  return (
    <li className="flex items-center gap-2 h-9 mx-1 pl-2 pr-1 text-ui-base font-semibold text-specter-text-main">
      <Crown size={16} aria-hidden="true" className="shrink-0 text-specter-text-subtle" />
      <span className="truncate">{name}</span>
    </li>
  );
}

/**
 * engine            { connected, state, levels, pending } (useEngine)
 * onCommand(type, args)   send a bridge command (errors land in engine.pending)
 * clearError(key)
 * focus, onFocus(focus|null)   which row's side panel is open (see top)
 * onCreateChannel({ name, kind }) → Promise<{ error }>
 * onDeleteChannel(channel)        → Promise<{ error }>
 * initialCreating                 dev preview only
 * browseFor, onBrowseFor(id|null) CH2: the voice channel the user backed out of
 *                                 to the list (see top); null = joined view
 */
export default function ChannelsCabinet({
  engine, onCommand, clearError = () => {}, focus = null, onFocus = () => {},
  onCreateChannel, onDeleteChannel, onClose, initialCreating = false,
  onUpdateChannel = null, onLoadRanks = null, // channel visibility
  onLoadAdultAvailable = null, onAttestAdult = null, // L11 adult channels
  pane = null, paneWidth = 0, expand = 'left', maxHeight = 520, paneMinHeight = 0,
  browseFor = null, onBrowseFor = () => {},
}) {
  const { connected, state } = engine;
  const unread = state.unread || {};

  // ── CH2: which view ─────────────────────────────────────────────────────
  const voiceId = connected ? state.voice.channelId : null;
  const view = voiceId && browseFor !== voiceId ? 'joined' : 'browse';
  // Slide direction for the view that just appeared (none on first mount —
  // the cabinet's own entry animation covers that). Adjusting state during
  // render is React's pattern for "previous value" here.
  const [viewAnim, setViewAnim] = useState({ view, anim: null });
  if (viewAnim.view !== view) setViewAnim({ view, anim: view === 'joined' ? 'fwd' : 'back' });
  // The joined view already shows the channel's members, so a voice-preview
  // pane would be a duplicate; a chat pane stays (talk and type).
  const focusKind = focus?.kind;
  useEffect(() => {
    if (view === 'joined' && focusKind === 'voice') onFocus(null);
  }, [view, focusKind, onFocus]);

  // ── Height (P2A) ────────────────────────────────────────────────────────
  // Always an explicit px height so it can animate: the view's natural
  // height (capped), or — with a pane open — at least the pane's minimum.
  // CH2: re-measured (and re-observed) when the view switches, so the height
  // animates from one view's size to the other's.
  const headRef = useRef(null);
  const bodyRef = useRef(null);
  const footRef = useRef(null);
  const [natural, setNatural] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      if (!headRef.current || !bodyRef.current) return;
      setNatural(headRef.current.offsetHeight + bodyRef.current.offsetHeight + (footRef.current?.offsetHeight || 0) + 8);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    if (headRef.current) ro.observe(headRef.current);
    if (bodyRef.current) ro.observe(bodyRef.current);
    if (footRef.current) ro.observe(footRef.current);
    return () => ro.disconnect();
  }, [view]);
  const listCap = Math.min(520, maxHeight);
  let height;
  if (natural != null) {
    height = Math.min(natural, listCap);
    if (paneWidth > 0) height = Math.min(maxHeight, Math.max(height, paneMinHeight));
  }
  const { pendingFor, errorFor } = usePendingHelpers(engine.pending);
  const [creating, setCreating] = useState(initialCreating);
  const [createState, setCreateState] = useState({ busy: false, error: null });
  const [confirmDelete, setConfirmDelete] = useState(null); // channel id
  const [deleteState, setDeleteState] = useState({ busy: false, error: null });

  const canManage = Boolean(state.org?.canManageChannels);
  const v = state.voice;

  // Channel visibility: the server's ranks, loaded for channel admins.
  const [ranks, setRanks] = useState([]);
  const orgIdForRanks = state.org?.id;
  useEffect(() => {
    let live = true;
    setRanks([]);
    if (canManage && orgIdForRanks && onLoadRanks) onLoadRanks().then((r) => { if (live) setRanks(r || []); }).catch(() => {});
    return () => { live = false; };
  }, [canManage, orgIdForRanks, onLoadRanks]);
  const visOptions = visibilityOptions(ranks, state.org);
  const [editVis, setEditVis] = useState(null); // channel id
  const [visState, setVisState] = useState({ busy: false, error: null });
  const submitVisibility = async (ch, minLevel, adult) => {
    setVisState({ busy: true, error: null });
    const body = { visible_min_level: minLevel };
    if (adult !== undefined && adult !== Boolean(ch.adult)) body.is_adult = adult; // L11
    const { error } = (await onUpdateChannel?.(ch, body)) || {};
    if (error) { setVisState({ busy: false, error: typeof error === 'string' ? error : error?.message || 'Could not change who can see it' }); return; }
    setVisState({ busy: false, error: null });
    setEditVis(null);
  };

  // L11: adult channels. The toggle only exists where the server says they are
  // available; an unattested member confirms 18+ once (inline, on first entry).
  const [adultAvailable, setAdultAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    setAdultAvailable(false);
    if (canManage && orgIdForRanks && onLoadAdultAvailable) onLoadAdultAvailable().then((a) => { if (live) setAdultAvailable(a === true); }).catch(() => {});
    return () => { live = false; };
  }, [canManage, orgIdForRanks, onLoadAdultAvailable]);
  const [attestFor, setAttestFor] = useState(null); // channel id
  const [attestState, setAttestState] = useState({ busy: false, error: null });
  const submitAttest = async () => {
    setAttestState({ busy: true, error: null });
    const { error } = (await onAttestAdult?.()) || {};
    if (error) { setAttestState({ busy: false, error: typeof error === 'string' ? error : error?.message || 'Could not confirm' }); return; }
    setAttestState({ busy: false, error: null });
    setAttestFor(null);
  };

  useEffect(() => { setConfirmDelete(null); setAttestFor(null); }, [state.org?.id]);
  useEffect(() => { if (!canManage) { setCreating(false); setConfirmDelete(null); } }, [canManage]);

  // OPTREE: regular voice, one entry per launched op (its group tree), text.
  const { voice: regularVoice, ops: opSections, text: textChannels } = buildChannelSections(state.channels);

  const submitCreate = async (form) => {
    setCreateState({ busy: true, error: null });
    const { error } = (await onCreateChannel?.(form)) || {};
    if (error) { setCreateState({ busy: false, error: typeof error === 'string' ? error : 'Could not create the channel' }); return; }
    setCreateState({ busy: false, error: null });
    setCreating(false);
  };

  const submitDelete = async (ch) => {
    setDeleteState({ busy: true, error: null });
    const { error } = (await onDeleteChannel?.(ch)) || {};
    if (error) { setDeleteState({ busy: false, error: typeof error === 'string' ? error : 'Could not delete the channel' }); return; }
    setDeleteState({ busy: false, error: null });
    setConfirmDelete(null);
    if (focus?.id === ch.id) onFocus(null);
  };

  const visibilityButton = (ch) => canManage && onUpdateChannel && (
    <IconButton
      size="sm"
      className="!h-6 !w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      icon={<Eye size={13} />}
      label={`Who can see ${ch.name}`}
      onClick={(e) => { e.stopPropagation(); setVisState({ busy: false, error: null }); setEditVis(ch.id); }}
    />
  );

  const deleteButton = (ch) => canManage && (
    <IconButton
      size="sm"
      variant="danger"
      className="!h-6 !w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
      icon={<Trash2 size={13} />}
      label={`Delete ${ch.name}`}
      onClick={(e) => { e.stopPropagation(); setDeleteState({ busy: false, error: null }); setConfirmDelete(ch.id); }}
    />
  );

  // opts (OPTREE): depth = indent in an op's group tree.
  const renderRow = (ch, { depth = 0 } = {}) => {
    if (confirmDelete === ch.id) {
      return (
        <li key={ch.id}>
          <DeleteConfirm channel={ch} {...deleteState} onConfirm={() => submitDelete(ch)} onCancel={() => setConfirmDelete(null)} />
        </li>
      );
    }
    if (editVis === ch.id) {
      return (
        <li key={ch.id}>
          <VisibilityEdit channel={ch} options={visOptions} {...visState} adultAvailable={adultAvailable}
            onSave={(lv, adult) => submitVisibility(ch, lv, adult)} onCancel={() => setEditVis(null)} />
        </li>
      );
    }
    if (attestFor === ch.id) {
      return (
        <li key={ch.id}>
          <div className="mx-1 mb-1 px-2 py-2 space-y-2 rounded-ui-row border border-specter-border bg-specter-bg-deep/40" aria-label={`18+ channel ${ch.name}`}>
            <p className="text-ui-sm text-specter-text-main"><span className="font-semibold">{ch.name}</span> is an 18+ channel</p>
            <p className="text-ui-xs text-specter-text-subtle">Adult content may be shared here. Confirm that you are 18 or older to enter. You only do this once for this server.</p>
            {attestState.error && <p role="alert" className="text-ui-xs text-red-300">{attestState.error}</p>}
            <div className="flex gap-1.5">
              <Button size="sm" onClick={submitAttest} disabled={attestState.busy}>{attestState.busy ? 'Confirming…' : 'I am 18 or older'}</Button>
              <Button variant="secondary" size="sm" onClick={() => setAttestFor(null)} disabled={attestState.busy}>Cancel</Button>
            </div>
          </div>
        </li>
      );
    }
    const visLabel = visibilityLabel(ch, ranks);
    const isVoice = ch.kind === 'voice';
    const me = { kind: ch.kind, id: ch.id };
    const focused = sameFocus(focus, me);
    const joined = isVoice && v.channelId === ch.id;
    const joinArgs = { channelId: ch.id };
    const joining = isVoice && pendingFor(CMD.VOICE_JOIN, joinArgs);
    const joinErr = isVoice ? errorFor(CMD.VOICE_JOIN, joinArgs) : null;
    const count = joined ? Math.max(v.roster.length, 1) : ch.occupants.length;
    const blocked = isVoice && !joined ? joinBlockedReason(ch) : null; // OPTREE
    const onClick = () => {
      if (ch.adultLocked) { setAttestState({ busy: false, error: null }); setAttestFor(ch.id); return; } // L11
      if (!isVoice) { onFocus(focused ? null : me); return; }
      if (joined) { onBrowseFor(null); return; } // CH2: back to the joined view
      if (!focused) { onFocus(me); return; }
      if (blocked) return; // OPTREE: look, don't join
      if (!joining) { clearError(cmdKey(CMD.VOICE_JOIN, joinArgs)); onCommand(CMD.VOICE_JOIN, joinArgs); }
    };
    const Icon = isVoice ? Volume2 : Hash;
    let title;
    if (isVoice && !joined) title = blocked ? `${blocked}. Click to see who's here` : focused ? 'Click again to join' : "Show who's here";
    if (joined) title = 'Open your channel';
    const mine = ch.mine && !joined;
    const pendingHere = ch.pendingMine && !joined && !mine;
    return (
      <li key={ch.id}>
        <div
          className={cx(
            'group flex items-center gap-2 h-9 mx-1 pl-2 pr-1 rounded-ui-row transition-colors',
            joined ? 'bg-emerald-500/10' : focused ? 'bg-specter-primary-cyan/10' : mine ? 'bg-specter-state-warning/10 hover:bg-specter-state-warning/15' : 'hover:bg-white/5',
            focused && 'ring-1 ring-inset ring-specter-primary-cyan/40',
            mine && !focused && 'shadow-[inset_2px_0_0_0_rgba(251,191,36,0.85)]',
          )}
          style={depth > 0 ? { marginLeft: 4 + depth * 14 } : undefined}
        >
          {depth > 0 && <span aria-hidden="true" className="shrink-0 -ml-1 w-2 h-px bg-specter-border-divider" />}
          <button
            type="button"
            onClick={onClick}
            aria-expanded={focused}
            aria-label={blocked ? `${ch.name} (locked: ${blocked})` : undefined}
            title={title}
            className={cx('flex-1 min-w-0 flex items-center gap-2 h-full text-left rounded-ui-sm', focusRing)}
          >
            <Icon
              size={16}
              aria-hidden="true"
              className={cx('shrink-0', joined ? 'text-emerald-400' : focused ? 'text-specter-primary-neon' : mine ? 'text-amber-300' : 'text-specter-text-subtle')}
            />
            <span className={cx('flex-1 min-w-0 truncate text-ui-base',
              joined || focused || mine ? 'text-specter-text-main' : blocked ? 'text-specter-text-subtle' : 'text-specter-text-muted')}
            >
              {ch.name}
            </span>
            {mine && (
              <span className="shrink-0 px-1.5 rounded-pill bg-specter-state-warning/15 text-ui-xs font-medium text-amber-300">Your group</span>
            )}
            {pendingHere && (
              <span className="shrink-0 px-1.5 rounded-pill border border-specter-state-warning/30 text-ui-xs font-medium text-amber-300/80">Pending</span>
            )}
            {blocked && <Lock size={12} aria-hidden="true" className="shrink-0 text-specter-text-subtle" />}
            {ch.adult && (
              <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 rounded-pill border border-specter-border text-ui-xs font-medium text-specter-text-subtle" title={ch.adultLocked ? '18+ channel: confirm your age to enter' : '18+ channel'}>
                {ch.adultLocked && <Lock size={10} aria-hidden="true" />}18+
              </span>
            )}
            {ch.minLevel > 0 && (
              <span className="shrink-0 inline-flex text-specter-text-subtle" title={visLabel || 'Restricted to higher ranks'}>
                <Eye size={12} aria-label={visLabel || 'Restricted to higher ranks'} />
              </span>
            )}
            {joining && (
              <span className="shrink-0 inline-flex items-center gap-1 text-ui-xs text-specter-text-subtle">
                <Loader2 size={12} aria-hidden="true" className="animate-spin" />Joining…
              </span>
            )}
            {!isVoice && !focused && unread[ch.id] > 0 && (
              <UnreadPill count={unread[ch.id]} />
            )}
            {isVoice && count > 0 && (
              <span className="shrink-0 inline-flex items-center gap-1 min-w-[20px] px-1.5 rounded-pill bg-white/5 text-ui-xs tabular-nums text-specter-text-subtle" title={pluralUsers(count)}>
                <Users size={11} aria-hidden="true" />{count}
              </span>
            )}
          </button>
          {!ch.eventId && visibilityButton(ch)}
          {!joined && !ch.eventId && deleteButton(ch) /* OPTREE: an op's channels go with End */}
        </div>
        {joinErr && !focused && <RowError className="ml-8 mr-2" message={joinErr} onDismiss={() => clearError(cmdKey(CMD.VOICE_JOIN, joinArgs))} />}
      </li>
    );
  };

  let body;
  if (!connected) {
    body = (
      <p className="px-4 py-3 inline-flex items-center gap-2 text-ui-sm text-specter-text-subtle">
        <Loader2 size={14} aria-hidden="true" className="animate-spin" />Connecting to SpecterComs…
      </p>
    );
  } else if (!state.org) {
    body = <p className="px-4 py-3 text-ui-sm text-specter-text-subtle">Pick a server first.</p>;
  } else if (!state.channels.length) {
    body = (
      <p className="px-4 py-3 text-ui-sm text-specter-text-subtle">
        {canManage ? 'No channels yet. Add one with +.' : 'No channels here yet.'}
      </p>
    );
  } else {
    body = (
      <>
        {regularVoice.length > 0 && (
          <section aria-label="Voice channels">
            <SectionLabel>Voice</SectionLabel>
            <ul>{regularVoice.map((c) => renderRow(c))}</ul>
          </section>
        )}
        {opSections.length > 0 && (
          <section aria-label="Operations">
            <SectionLabel><span className="inline-flex items-center gap-1"><RadioTower size={12} aria-hidden="true" />{opSections.length === 1 ? 'Operation' : 'Operations'}</span></SectionLabel>
            {opSections.map((op) => (
              <ul key={op.eventId} aria-label={`Operation ${op.name}`} className="mb-1">
                <OpHeading name={op.name} />
                {op.nodes.map(({ channel, depth }) => renderRow(channel, { depth: depth + 1 }))}
              </ul>
            ))}
          </section>
        )}
        {textChannels.length > 0 && (
          <section aria-label="Text channels">
            <SectionLabel>Text</SectionLabel>
            <ul>{textChannels.map((c) => renderRow(c))}</ul>
          </section>
        )}
      </>
    );
  }

  const ChannelsIcon = CHANNELS_ICON;
  const browse = (
    <>
      <div ref={headRef} className="shrink-0">
      <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-2">
        <div className="min-w-0 flex items-start gap-2">
          <ChannelsIcon size={16} aria-hidden="true" className="shrink-0 mt-1.5 text-specter-primary-neon" />
          <div className="min-w-0">
            <h2 className="text-ui-lg font-semibold text-specter-text-main">Channels</h2>
            <p className="text-ui-sm text-specter-text-subtle truncate">{state.org?.callsign || ' '}</p>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {canManage && connected && (
            <IconButton
              size="sm"
              icon={<Plus size={16} />}
              label="Create channel"
              active={creating}
              onClick={() => { setCreateState({ busy: false, error: null }); setCreating((c) => !c); }}
            />
          )}
          <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
        </div>
      </div>
      {voiceId && (
        <InVoiceRow engine={engine} onCommand={onCommand} clearError={clearError} onOpen={() => onBrowseFor(null)} />
      )}
      {creating && canManage && (
        <CreateChannelForm {...createState} visibility={visOptions} onSubmit={submitCreate} onCancel={() => setCreating(false)} />
      )}
      </div>
      <div className="strip-scroll min-h-0 flex-1 pb-2"><div ref={bodyRef}>{body}</div></div>
    </>
  );

  // CH2: the joined channel takes the cabinet's space.
  const joinedView = view === 'joined' && (
    <>
      <div ref={headRef} className="shrink-0">
        <JoinedHeader engine={engine} onBack={() => onBrowseFor(voiceId)} onClose={onClose} />
      </div>
      <div className="strip-scroll min-h-0 flex-1 pb-2" aria-label={`${v.channelName}: members`}>
        <div ref={bodyRef}>
          <MyChannelMembers
            engine={engine}
            onCommand={onCommand}
            clearError={clearError}
            onOpenDm={({ userId, callsign }) => onFocus({ kind: 'dm', id: userId, name: callsign }) /* PM */}
          />
        </div>
      </div>
      <div ref={footRef} className="shrink-0 px-4 py-3 border-t border-specter-border-divider">
        <MyVoiceControls engine={engine} onCommand={onCommand} clearError={clearError} />
      </div>
    </>
  );

  const list = (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      <div key={view} className={cx('flex-1 min-h-0 flex flex-col', viewAnim.anim && `ch-view-${viewAnim.anim}`)}>
        {view === 'joined' ? joinedView : browse}
      </div>
    </div>
  );

  // One continuous panel: the list keeps its column-width part and the pane
  // (members / chat) takes the extra width on the free side (P2A).
  return (
    <div
      className={cx('flex', expand === 'right' ? 'flex-row' : 'flex-row-reverse')}
      style={{
        height: height ?? undefined,
        maxHeight: height == null ? listCap : undefined,
        transition: 'height 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      {list}
      {paneWidth > 0 && (
        <div
          className={cx(
            'shrink-0 min-h-0 flex flex-col border-specter-border-divider',
            expand === 'right' ? 'border-l' : 'border-r',
          )}
          style={{ width: paneWidth }}
        >
          {pane}
        </div>
      )}
    </div>
  );
}

/** Red unread count on a text channel row (P2A). */
export function UnreadPill({ count, className }) {
  return (
    <span
      className={cx('shrink-0 inline-flex items-center justify-center h-[18px] min-w-[18px] px-1.5 rounded-pill bg-red-500 text-white text-[11px] font-bold tabular-nums', className)}
      aria-label={`${count} unread`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
