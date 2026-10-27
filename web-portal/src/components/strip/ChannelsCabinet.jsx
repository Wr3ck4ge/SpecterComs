import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertCircle, Hash, Loader2, Mic, MicOff, MonitorPlay, PhoneOff, Plus, Radio, Trash2, Users, Volume2, X,
  ArrowLeft, ChevronRight, RadioTower, // CH2
  Layers, // SV
  KeyRound, Lock, // E2EV
  Crown, // LEADFREQ
} from 'lucide-react';
import { Button, IconButton, Input } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { CMD, selectMyChannelUsers, totalUnread } from '../../engine/bridge';
import { cmdKey } from './useEngine';

/** CH2: the Channels cabinet's icon (bar button + cabinet header). */
export const CHANNELS_ICON = Radio;

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
//          live: speaking indicators, two stream buttons next to each sharer
//          (SV: Watch = the strip's own stream viewer; the layers icon opens
//          the overlay watching them), mic + leave.
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

/** focus: null | { kind: 'voice' | 'text', id } */
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
function VoiceStatus({ status, keyState = null, error = null }) {
  if (error) return <span className="shrink-0 text-ui-xs text-red-300" title={error}>Update required</span>;
  if (status === 'connected' && keyState === 'waiting') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-ui-xs text-amber-300" title="Your voice stays silent until this device receives the channel's encryption key">
        <KeyRound size={12} aria-hidden="true" className="animate-pulse" />Waiting for channel key…
      </span>
    );
  }
  if (status === 'connected') {
    return (
      <span className="shrink-0 inline-flex items-center gap-1 text-ui-xs text-emerald-300" title="Voice is end-to-end encrypted">
        <Lock size={11} aria-hidden="true" />Connected
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
  return (
    <div className="mb-2">
      <div role="radiogroup" aria-label="Transmit on" className="flex flex-wrap items-center gap-1">
        {freqs.map((f) => {
          const args = { index: f.index };
          const pending = pendingFor(CMD.VOICE_SET_FREQUENCY, args);
          const Icon = f.leadership ? Crown : f.kind === 'group' ? Users : RadioTower;
          return (
            <button
              key={f.index}
              type="button"
              role="radio"
              aria-checked={f.active}
              disabled={pending}
              title={f.active ? `Transmitting on ${f.name}` : `Talk on ${f.name}${f.listening ? ' (you can hear it now)' : ''}`}
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
              <span className="truncate">{f.leadership ? 'Leadership' : f.name}</span>
              {f.active && <Mic size={10} aria-label="transmitting" className="shrink-0" />}
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
          icon={mutePending ? <Loader2 size={13} className="animate-spin" /> : v.muted ? <MicOff size={13} /> : <Mic size={13} />}
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

/** The live members of my voice channel: speaking, mute, stream buttons. */
function MyChannelMembers({ engine, onCommand, clearError }) {
  const { state, levels } = engine;
  const v = state.voice;
  const { pendingFor, errorFor } = usePendingHelpers(engine.pending);
  const overlayOk = state.caps.overlay;
  const users = selectMyChannelUsers(state, levels);
  return (
    <ul className="py-1" aria-label="People in your channel">
      {users.map((u) => {
        const watchArgs = { callsign: u.callsign };
        const watchPending = pendingFor(CMD.OVERLAY_WATCH, watchArgs);
        const watchErr = errorFor(CMD.OVERLAY_WATCH, watchArgs);
        const watching = u.watching && state.overlay.open && v.viewer !== 'strip'; // SV: not while the strip has it
        // SV: Watch = the strip's own viewer (no overlay needed).
        const hereWatching = u.watching && v.viewer === 'strip';
        const herePending = pendingFor(CMD.STREAM_WATCH, watchArgs);
        return (
          <li key={u.callsign}>
            <div className="flex items-center gap-2 h-8 px-4 text-ui-sm">
              <SpeakingDot speaking={u.speaking} />
              <span className={cx('flex-1 min-w-0 truncate', u.speaking ? 'text-emerald-300' : 'text-specter-text-main')}>
                {u.callsign}
                {u.isMe && <span className="ml-1 text-ui-xs text-specter-text-subtle">(you)</span>}
              </span>
              {u.isMe && v.muted && <MicOff size={13} className="shrink-0 text-specter-text-subtle" aria-label="Muted" />}
              {u.sharing && u.isMe && (
                <MonitorPlay size={14} className="shrink-0 mx-1.5 text-specter-primary-neon" aria-label="You're sharing your screen" />
              )}
              {u.sharing && !u.isMe && (
                <IconButton
                  size="sm"
                  active={hereWatching}
                  disabled={herePending}
                  icon={herePending ? <Loader2 size={15} className="animate-spin" /> : <MonitorPlay size={15} />}
                  label={hereWatching ? `Watching ${u.callsign}` : `Watch ${u.callsign}'s stream`}
                  onClick={() => onCommand(CMD.STREAM_WATCH, watchArgs)}
                />
              )}
              {u.sharing && !u.isMe && (
                <IconButton
                  size="sm"
                  active={watching}
                  disabled={!overlayOk || watchPending}
                  icon={watchPending ? <Loader2 size={15} className="animate-spin" /> : <Layers size={15} /> /* SV: was MonitorPlay */}
                  label={!overlayOk
                    ? 'The overlay is in safe mode'
                    : watching ? `Watching ${u.callsign} in the overlay` : `Open ${u.callsign}'s stream in the overlay`}
                  onClick={() => { clearError(cmdKey(CMD.OVERLAY_WATCH, watchArgs)); onCommand(CMD.OVERLAY_WATCH, watchArgs); }}
                />
              )}
            </div>
            {watchErr && <RowError className="mx-4" message={watchErr} onDismiss={() => clearError(cmdKey(CMD.OVERLAY_WATCH, watchArgs))} />}
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
export function VoiceChannelPanel({ engine, channel, onCommand, clearError = () => {}, onClose }) {
  const v = engine.state.voice;
  const { pendingFor, errorFor } = usePendingHelpers(engine.pending);
  const joined = v.channelId === channel.id;
  const joinArgs = { channelId: channel.id };
  const joining = pendingFor(CMD.VOICE_JOIN, joinArgs);
  const joinErr = errorFor(CMD.VOICE_JOIN, joinArgs);

  let list;
  if (joined) {
    list = <MyChannelMembers engine={engine} onCommand={onCommand} clearError={clearError} />;
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
        <Volume2 size={16} aria-hidden="true" className={cx('shrink-0 mt-1', joined ? 'text-emerald-400' : 'text-specter-primary-neon')} />
        <div className="flex-1 min-w-0">
          <h2 className="truncate text-ui-lg font-semibold text-specter-text-main">{channel.name}</h2>
          <p className="text-ui-sm text-specter-text-subtle">
            {joined ? <VoiceStatus status={v.status} keyState={v.keyState} error={v.error} /> : count ? pluralUsers(count) : 'Empty'}
          </p>
        </div>
        <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
      </div>
      {joined && v.error && <RowError className="mx-4 mt-2" message={v.error} /> /* E2EV */}
      <div className="strip-scroll min-h-0 flex-1">{list}</div>
      <div className="px-4 py-3 border-t border-specter-border-divider">
        {joined ? (
          <MyVoiceControls engine={engine} onCommand={onCommand} clearError={clearError} />
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
  else if (v.status === 'connected' && v.keyState === 'waiting') status = <KeyRound size={13} className="shrink-0 animate-pulse text-amber-300" aria-label="Waiting for channel key" />; // E2EV
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
          icon={mutePending ? <Loader2 size={14} className="animate-spin" /> : v.muted ? <MicOff size={14} /> : <Mic size={14} />}
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
          <span aria-hidden="true" className="pointer-events-none absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-pill border-2 border-[#0b1d2e] bg-red-500" />
        )}
      </span>
      <Volume2 size={16} aria-hidden="true" className="shrink-0 mt-1.5 text-emerald-400" />
      <div className="flex-1 min-w-0">
        <h2 className="truncate text-ui-lg font-semibold text-specter-text-main">{v.channelName}</h2>
        <p className="flex items-center gap-1.5 text-ui-sm text-specter-text-subtle">
          <VoiceStatus status={v.status} keyState={v.keyState} error={v.error} />
          <span aria-hidden="true">·</span>
          <span className="truncate">{pluralUsers(count)}</span>
        </p>
        {v.error && <RowError className="mt-1" message={v.error} /> /* E2EV */}
      </div>
      <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
    </div>
  );
}

// ── Cabinet ────────────────────────────────────────────────────────────────

function CreateChannelForm({ busy, error, onSubmit, onCancel }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('voice');
  return (
    <form
      className="mx-3 mb-2 p-3 space-y-2 rounded-ui-row border border-specter-border bg-specter-bg-deep/40"
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit({ name: name.trim(), kind }); }}
      aria-label="Create channel"
    >
      <Input
        autoFocus
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

  useEffect(() => { setConfirmDelete(null); }, [state.org?.id]);
  useEffect(() => { if (!canManage) { setCreating(false); setConfirmDelete(null); } }, [canManage]);

  const voiceChannels = state.channels.filter((c) => c.kind === 'voice');
  const regularVoice = voiceChannels.filter((c) => !c.eventId);
  const opVoice = voiceChannels.filter((c) => c.eventId);
  const textChannels = state.channels.filter((c) => c.kind === 'text');

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

  const renderRow = (ch) => {
    if (confirmDelete === ch.id) {
      return (
        <li key={ch.id}>
          <DeleteConfirm channel={ch} {...deleteState} onConfirm={() => submitDelete(ch)} onCancel={() => setConfirmDelete(null)} />
        </li>
      );
    }
    const isVoice = ch.kind === 'voice';
    const me = { kind: ch.kind, id: ch.id };
    const focused = sameFocus(focus, me);
    const joined = isVoice && v.channelId === ch.id;
    const joinArgs = { channelId: ch.id };
    const joining = isVoice && pendingFor(CMD.VOICE_JOIN, joinArgs);
    const joinErr = isVoice ? errorFor(CMD.VOICE_JOIN, joinArgs) : null;
    const count = joined ? Math.max(v.roster.length, 1) : ch.occupants.length;
    const onClick = () => {
      if (!isVoice) { onFocus(focused ? null : me); return; }
      if (joined) { onBrowseFor(null); return; } // CH2: back to the joined view
      if (!focused) { onFocus(me); return; }
      if (!joining) { clearError(cmdKey(CMD.VOICE_JOIN, joinArgs)); onCommand(CMD.VOICE_JOIN, joinArgs); }
    };
    const Icon = isVoice ? Volume2 : Hash;
    let title;
    if (isVoice && !joined) title = focused ? 'Click again to join' : "Show who's here";
    if (joined) title = 'Open your channel';
    return (
      <li key={ch.id}>
        <div
          className={cx(
            'group flex items-center gap-2 h-9 mx-1 pl-2 pr-1 rounded-ui-row transition-colors',
            joined ? 'bg-emerald-500/10' : focused ? 'bg-specter-primary-cyan/10' : 'hover:bg-white/5',
            focused && 'ring-1 ring-inset ring-specter-primary-cyan/40',
          )}
        >
          <button
            type="button"
            onClick={onClick}
            aria-expanded={focused}
            title={title}
            className={cx('flex-1 min-w-0 flex items-center gap-2 h-full text-left rounded-ui-sm', focusRing)}
          >
            <Icon size={16} aria-hidden="true" className={cx('shrink-0', joined ? 'text-emerald-400' : focused ? 'text-specter-primary-neon' : 'text-specter-text-subtle')} />
            <span className={cx('flex-1 min-w-0 truncate text-ui-base', joined || focused ? 'text-specter-text-main' : 'text-specter-text-muted')}>{ch.name}</span>
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
          {!joined && deleteButton(ch)}
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
            <ul>{regularVoice.map(renderRow)}</ul>
          </section>
        )}
        {opVoice.length > 0 && (
          <section aria-label="Operation channels">
            <SectionLabel><span className="inline-flex items-center gap-1"><RadioTower size={12} aria-hidden="true" />Operation</span></SectionLabel>
            <ul>{opVoice.map(renderRow)}</ul>
          </section>
        )}
        {textChannels.length > 0 && (
          <section aria-label="Text channels">
            <SectionLabel>Text</SectionLabel>
            <ul>{textChannels.map(renderRow)}</ul>
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
        <CreateChannelForm {...createState} onSubmit={submitCreate} onCancel={() => setCreating(false)} />
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
        <div ref={bodyRef}><MyChannelMembers engine={engine} onCommand={onCommand} clearError={clearError} /></div>
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
