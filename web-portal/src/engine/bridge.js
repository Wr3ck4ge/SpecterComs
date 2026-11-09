// The engine bridge: a small typed protocol over Tauri events between the
// tray strip (the whole UI since the redesign) and the engine (WarRoom +
// CommLink running in the hidden "main" window, which owns voice, streams,
// MLS and the SSE connection). This module is the single source of truth for
// event names, payload shapes and the protocol version, and is imported by
// both sides:
//   engine side  src/engine/useEngineBridgeHost.js (used by WarRoom)
//   strip side   src/components/strip/useEngine.js (used by StripApp)
//
// ── Transport ──────────────────────────────────────────────────────────────
// Tauri app events. Engine → strip uses emitTo('specter-strip'), strip →
// engine uses emitTo('main'), so the overlay window never wakes up for them.
// Every payload carries `v` (BRIDGE_VERSION). A receiver drops payloads whose
// `v` it doesn't know; bump the version on any incompatible shape change
// (additive fields don't need a bump — readers must ignore unknown fields).
//
// ── Engine → strip ─────────────────────────────────────────────────────────
//   engine-ready       { v }
//       The engine (WarRoom) mounted, i.e. a user is logged in and the engine
//       is up. The strip answers with engine-request-snapshot.
//   engine-state       { v, seq, state: EngineState }
//       The full state. Sent on mount and in answer to every
//       engine-request-snapshot. Replaces whatever the strip had.
//   engine-state-patch { v, seq, patch: Partial<EngineState> }
//       Incremental update: each key present replaces that top-level section
//       of EngineState wholesale (sections are small). `seq` increases by one
//       per engine-state / engine-state-patch; a strip that sees a gap (it
//       missed one, e.g. while its page was reloading) asks for a snapshot.
//       Batched: at most one patch per PATCH_BATCH_MS.
//   engine-levels      { v, levels: { [callsign]: 0..100 }, speaking: string[] }
//       Audio levels for the joined voice channel's users, throttled to
//       LEVELS_HZ. Only sent while a strip holds a levels lease (below) and
//       the user is in voice; one final all-quiet frame is sent when levels
//       stop. Not part of EngineState (too high-rate for patches).
//   engine-command-ack { v, id, ok, error?: string, result?: any }
//       The answer to one engine-command (matched by `id`).
//   engine-chat        { v, channelId, loading, rows: ChatRow[] }      (P2A)
//       The text channel the strip subscribed to with text.select: its recent
//       history (local IndexedDB store, newest CHAT_MAX_ROWS) plus everything
//       that arrived since (live relay, peer backfill, own sends). Always the
//       whole list — sent when the subscription starts and whenever the
//       engine's list for that channel changes; the strip replaces what it
//       had. Plaintext only: the engine decrypts (mlsSession.js's queue) and
//       nothing MLS ever crosses the bridge. Not sent while unsubscribed.
//       ChatRow = { id, senderId, callsign, timestamp, text: string | null
//                   (null = can't be read yet), imageUrl: string | null
//                   (absolute), mine: boolean,
//                   pending: boolean (MR2: text is null and the engine is
//                   waiting for a key / a peer's backfill — show "Waiting for
//                   key…", never a blank row),
//                   relayedBy: string | null (MR2: user id of the member who
//                   backfilled it; null = received live) }
//   engine-stream-frame  { v, session, key, ts, data, config? }          (SV)
//       One encoded video frame of the stream the strip's viewer is watching
//       (stream.watch). Sent ONLY while state.voice.viewer === 'strip', in
//       arrival order (createOrderedEmitter). `data` is the frame's base64
//       bytes AFTER the engine decrypted them (Annex-B H.264 / whatever the
//       sharer's codec is); the strip decodes with its own WebCodecs
//       VideoDecoder, exactly like the overlay window does with
//       overlay-video-nal. Security: this is local IPC between two windows of
//       this app on this device; the MLS-derived video key never leaves the
//       engine and nothing here is ever sent over the network.
//       session  changes when the engine subscribes anew (switching sharer,
//                retry, self-view) — the strip resets its decoder and waits
//                for a keyframe.
//       key      keyframe?   ts  timestamp in µs
//       config   { codec, width, height } — on every keyframe (atomic with it,
//                so a decoder is always configured before its first keyframe)
//   engine-stream-status { v, callsign, status, message }                 (SV)
//       Engine-side problems with the strip-watched stream, sticky (re-sent
//       when the strip viewer takes over a running stream). status:
//       'connecting'   subscribing to the sharer
//       'waiting-key'  frames arrive but this device has no channel key yet
//                      (MLS key recovery running) — nothing is relayed
//       'waiting-keyframe'  key acquired; waiting for the next keyframe
//       'ended'        the stream closed after it had been running
//       'unavailable'  the server never sent the stream (sharer gone)
//       'error'        unrecoverable for this subscription (bad header)
//       'ok'           clears a previous status (frames are flowing)
//
// ── Strip → engine ─────────────────────────────────────────────────────────
//   engine-request-snapshot  { v }
//       "Send me engine-state now." Sent when the strip page mounts, when the
//       strip is shown, on engine-ready, and on a seq gap.
//   engine-levels-lease      { v, on: boolean }
//       Start/stop engine-levels. A lease lasts LEVELS_LEASE_MS; the strip
//       renews it every LEVELS_LEASE_MS / 2 while it wants levels (channels
//       cabinet open; ambient cards later), so a crashed or hidden strip
//       stops the stream on its own.
//   engine-stream-keyframe-request { v, session }                          (KF)
//       The strip's viewer is dropping frames until a keyframe (it just
//       (re)configured, fell behind, or skipped a gap) — ask the sharer for
//       one now instead of waiting out the GOP. The strip throttles it
//       (VIEWER_REQUEST_INTERVAL_MS); the engine forwards it upstream (or to
//       its own encoder for self-view). See engine/keyframeRequest.js.
//       Fire-and-forget: no ack, and an older engine just ignores it.
//   engine-command           { v, id, type, args }
//       One of COMMANDS below. `id` is unique per command (strip-generated).
//       Every command is idempotent (asking for the state you're already in
//       acks ok without doing anything) and is answered by exactly one
//       engine-command-ack. The strip times a command out after
//       COMMAND_TIMEOUT_MS (engine gone / busy) and shows it as failed.
//
// ── EngineState ────────────────────────────────────────────────────────────
//   {
//     user:    { callsign } | null,
//     org:     { id, callsign, canManageChannels } | null   (selected server)
//     channels: [{ id, name, kind: 'voice' | 'text', eventId, parentId,
//                  occupants: string[] (callsigns, from server presence),
//                  // OPTREE (optional; null/true on non-event channels):
//                  eventName,                // the op's name
//                  eventKind: 'command' | 'group' | 'other' | null,
//                  groupId,                  // event_groups.id for a group channel
//                  canJoin: boolean,         // the server's access rule for me
//                  mine: boolean,            // my own group's channel
//                  pendingMine: boolean }],  // my sign-up to it isn't accepted yet
//                  An op shows as ONE entry (its name = its command channel,
//                  joinable only by commander / leaders / organisers) with
//                  its group channels as a tree beneath (parentId).
//     voice:   { channelId, channelName,             // null when not in voice
//                status: 'idle' | 'connecting' | 'connected' | 'error',
//                muted, sharing,                     // my mic / my screen share
//                roster: string[],                   // who's in my channel (live)
//                sharers: string[],                  // who's sharing there
//                watchTarget: string | null,         // stream being watched
//                viewer: 'strip' | 'overlay' | null,  // SV: who shows watchTarget
//                freqs: [{ index, name, kind: 'group' | 'frequency', // LEADFREQ:
//                          leadership, command, active, listening }] }, // op transmit choices
//                          // OPTREE: command = it's the op's command channel
//                                                    // (buildVoiceFreqs; [] outside ops)
//     overlay: { open: boolean },
//     text:    { activeChannelId: string | null },   // text channel the engine has open
//     unread:  { [channelId]: number },              // P2A: unread text messages (>0 only)
//     caps:    { deafen: boolean, overlay: boolean,  // what the engine can do
//                share: boolean }                    // P2A: native capture → strip picker
//   }
//   unread counts every text channel of every server (the SSE stream carries
//   message_relay for all of them), not counting my own messages or the
//   channel the strip is showing. Persisted in the engine's localStorage
//   (src/engine/unreadStore.js), so counts survive a restart.
//
// ── Commands ───────────────────────────────────────────────────────────────
//   server.select     { orgId }          switch the engine's selected server
//   voice.join        { channelId }      join a voice channel (switches if in another)
//   voice.leave       {}                 leave voice
//   voice.setMuted    { muted }          mic mute on/off (absolute, so idempotent)
//   voice.setDeafened { deafened }       not supported yet → ack error (caps.deafen)
//   text.select       { channelId | null }  subscribe the strip's chat to a text
//                                        channel (opens it in the engine, starts
//                                        engine-chat, marks it read; it stays
//                                        read while subscribed). null ends the
//                                        subscription (chat closed / strip hidden).
//   chat.send         { channelId, text } → { id, timestamp }       (P2A)
//                                        encrypt + send in the engine (same path
//                                        as the old TextChat send, incl. its
//                                        optimistic insert); fails with the send
//                                        error, in which case nothing was sent
//   overlay.open      {}                 open the overlay HUD (no watch target) (P2A)
//   overlay.watch     { callsign }       open the overlay HUD watching that sharer
//   overlay.close     {}                 close the overlay HUD
//   share.listSources {} → { sources: [{ id, name, kind: 'monitor' | 'window',
//                          thumb: data-URL | null, width, height }] }  (P2A)
//                                        the native capture sources, for the
//                                        strip's picker (needs caps.share)
//   share.start       { sourceId, name } start sharing that source (P2A); acks
//                                        once capture has started
//   share.stop        {}                 stop sharing (P2A)
//   channels.refresh  {}                 refetch the channel list now
//   stream.watch      { callsign, restart? }   (SV) watch that sharer in the
//                                        strip's stream viewer: the engine sets
//                                        the watch target and relays decrypted
//                                        frames to the strip (engine-stream-*)
//                                        instead of the overlay. If the overlay
//                                        is open it stays open but stops showing
//                                        video (one decode per stream). restart:
//                                        re-subscribe the same sharer (Retry).
//   stream.stop       {}                 (SV) close the strip viewer: clears the
//                                        watch target if the strip owns it
//   voice.setFrequency { index }         (LEADFREQ) transmit on state.voice.freqs[index]
//                                        (0 = my group channel); the others stay
//                                        heard passively
//   server.resyncEncryption { orgId } → { healed, failed, checked, failures, ok, message }   (MR2)
//                                        force-heal every MLS group of that server
//                                        (mlsSession.healOrgEncryption force) and
//                                        catch its chat up again; `message` is the
//                                        line to show ("3 channels re-synced").
//                                        Strip timeout: RESYNC_COMMAND_TIMEOUT_MS
//   share.setAudio    { enabled }        (SA) the "Share audio" toggle: persisted
//                                        (off by default) and applied to a
//                                        running share at once. Fails when this
//                                        native build has no share audio
//                                        (state.voice.shareAudio.supported false)
//   shareAudio.setVolume { callsign, volume?, muted? }   (SA) a sharer's share-
//                                        audio volume (0..2) / mute on this
//                                        device, persisted per sharer
//   (overlay.watch hands the stream to the overlay: viewer becomes 'overlay'.)
//   net.diagnose      {} → { diag, verdict, report }                       (NET)
//                                        the Repair panel's connectivity diagnosis
//                                        (engine/netDiagnostics.js runDiagnosis +
//                                        connectionRepair.classifyDiagnosis); also
//                                        remembered for Submit diagnostics.
//                                        Strip timeout: NET_COMMAND_TIMEOUT_MS
//   net.repair        { step: 'keyPackage' | 'voiceState' | 'voiceReconnect',
//                       useAlt? } → { ok, message, skipped? }               (NET)
//                                        one Repair step run in the engine (the
//                                        encryption resync step is
//                                        server.resyncEncryption). Never touches
//                                        the MLS identity or message history.
//   net.submit        { appVersion, report } → {}                         (NET)
//                                        Submit diagnostics with the repair report
// NET: state.voice.connectIssue = null | { kind: 'quic_blocked' | 'connect_failed',
//   gaveUp, timeouts, attempts, lastKind, via, message } (CommLink's classification,
//   connectionRepair.connectIssueFrom) and state.voice.via = 'main' | 'alt' | null
//   with state.voice.viaPort (the UDP port voice uses). Optional; older strips ignore them.
//
// PM (per-member menu, see engine/people.js). All take the member's userId
// (state.people[callsign].userId); none applies to me.
//   member.setLocalMute { userId, muted }   "Mute for me": the relay stops
//                                        forwarding them to this device only
//                                        (CommLink SET_LOCAL_MUTE), persisted
//   member.setVolume  { userId, volume } their voice volume on this device,
//                                        0..2 (1 = 100 %), persisted per user;
//                                        applied natively per voice lane
//                                        (engine/userVolume.js), on top of the
//                                        channel volume
//   friend.request    { userId }         send a friend request
//   friend.accept     { userId }         accept their pending request
//   friends.refresh   {}                 refetch /friends (the menu does on open)
//   dm.select         { userId | null }  subscribe the strip's DM pane to the
//                                        conversation with that user (engine-dm,
//                                        and a catch-up request to them); null ends it
//   dm.send           { userId, text } → { id, timestamp }   MLS-encrypt + send
//                                        (useChannelChat.sendDm); friends only
//   prefs.setOverlayDms { enabled }      "Show DMs in overlay" (on by default)
//   engine-dm         { v, userId, callsign, loading, rows: ChatRow[] }
//       Engine → strip, like engine-chat but for the dm.select conversation.
//       Plaintext rows, decrypted in the engine; never MLS material.
// state.people  { [callsign]: { userId | null, friend: 'none' | 'friends' |
//                 'outgoing' | 'incoming', localMuted, volume } }
//               the OTHER members of my voice channel ({} outside voice)
// state.prefs   { overlayDms: boolean }
// LIVE: state.liveOps (optional — older strips ignore it): the launched ops of
//   ALL my servers (engine/liveOps.js), newest launch first:
//   [{ key,                 eventId + command channel: one per launch
//      eventId, orgId, orgName, name, startTime, endTime,
//      liveSince,           ms when this client saw it launch, or null
//      filledSlots, totalSlots, commandChannelId,
//      event }]             the op row the strip's op panel opens
//
// SA: state.voice.shareAudio (optional — older strips ignore it):
//   { supported,          this device's native build has share audio
//     enabled,            my "Share audio" toggle
//     active, mode, echoRisk, error,   my share's audio right now (mode:
//                         'process_include' | 'process_exclude' |
//                         'device_loopback'; echoRisk: it may pick up voice chat)
//     sharers: string[],  sharers whose share carries audio (tile indicator)
//     prefs: { [callsign]: { volume, muted } } }   for those sharers
// voice.join acks once the join has been started; connecting → connected is
// then visible in state.voice.status. Sharing state is state.voice.sharing.
// chat.send / share.* can take longer than COMMAND_TIMEOUT_MS (MLS commits,
// capture start-up): the strip passes a longer timeout for those
// (SLOW_COMMAND_TIMEOUT_MS).

import { resolveActiveNet } from './activeNet.js';

export const BRIDGE_VERSION = 1;

export const STRIP_WINDOW = 'specter-strip';
export const ENGINE_WINDOW = 'main';

export const EV = Object.freeze({
  READY: 'engine-ready',
  STATE: 'engine-state',
  PATCH: 'engine-state-patch',
  LEVELS: 'engine-levels',
  ACK: 'engine-command-ack',
  CHAT: 'engine-chat', // P2A
  DM: 'engine-dm', // PM
  STREAM_FRAME: 'engine-stream-frame', // SV
  STREAM_STATUS: 'engine-stream-status', // SV
  STREAM_KEYFRAME_REQUEST: 'engine-stream-keyframe-request', // KF
  REQUEST_SNAPSHOT: 'engine-request-snapshot',
  LEVELS_LEASE: 'engine-levels-lease',
  COMMAND: 'engine-command',
});

export const CMD = Object.freeze({
  SERVER_SELECT: 'server.select',
  VOICE_JOIN: 'voice.join',
  VOICE_LEAVE: 'voice.leave',
  VOICE_SET_MUTED: 'voice.setMuted',
  VOICE_SET_DEAFENED: 'voice.setDeafened',
  TEXT_SELECT: 'text.select',
  CHAT_SEND: 'chat.send',
  OVERLAY_OPEN: 'overlay.open',
  OVERLAY_WATCH: 'overlay.watch',
  OVERLAY_CLOSE: 'overlay.close',
  SHARE_LIST_SOURCES: 'share.listSources',
  SHARE_START: 'share.start',
  SHARE_STOP: 'share.stop',
  CHANNELS_REFRESH: 'channels.refresh',
  STREAM_WATCH: 'stream.watch', // SV
  STREAM_STOP: 'stream.stop', // SV
  VOICE_SET_FREQUENCY: 'voice.setFrequency', // LEADFREQ
  SERVER_RESYNC_ENCRYPTION: 'server.resyncEncryption', // MR2
  SHARE_SET_AUDIO: 'share.setAudio', // SA
  SHARE_AUDIO_SET_VOLUME: 'shareAudio.setVolume', // SA
  MEMBER_SET_LOCAL_MUTE: 'member.setLocalMute', // PM
  MEMBER_SET_VOLUME: 'member.setVolume', // PM
  FRIEND_REQUEST: 'friend.request', // PM
  FRIEND_ACCEPT: 'friend.accept', // PM
  FRIENDS_REFRESH: 'friends.refresh', // PM
  DM_SELECT: 'dm.select', // PM
  DM_SEND: 'dm.send', // PM
  PREFS_SET_OVERLAY_DMS: 'prefs.setOverlayDms', // PM
  NET_DIAGNOSE: 'net.diagnose', // NET
  NET_REPAIR: 'net.repair', // NET
  NET_SUBMIT: 'net.submit', // NET
});

/** NET: net.diagnose / net.submit run several network probes. */
export const NET_COMMAND_TIMEOUT_MS = 60_000;

/**
 * PM: the strip's command args, built in one place so both sides agree on the
 * shapes (and tests can pin them).
 */
export const memberCommand = Object.freeze({
  setLocalMute: (userId, muted) => [CMD.MEMBER_SET_LOCAL_MUTE, { userId, muted: Boolean(muted) }],
  setVolume: (userId, volume) => [CMD.MEMBER_SET_VOLUME, { userId, volume }],
  friendRequest: (userId) => [CMD.FRIEND_REQUEST, { userId }],
  friendAccept: (userId) => [CMD.FRIEND_ACCEPT, { userId }],
  dmSelect: (userId) => [CMD.DM_SELECT, { userId: userId || null }],
  dmSend: (userId, text) => [CMD.DM_SEND, { userId, text }],
  setOverlayDms: (enabled) => [CMD.PREFS_SET_OVERLAY_DMS, { enabled: Boolean(enabled) }],
});

/** SA: state.voice.shareAudio when nothing is known (older engine, not in voice). */
export const EMPTY_SHARE_AUDIO = Object.freeze({
  supported: false, enabled: false, active: false, mode: null, echoRisk: false, error: null, sharers: [], prefs: {},
});

/** MR2: server.resyncEncryption can take a while (one heal per channel group). */
export const RESYNC_COMMAND_TIMEOUT_MS = 120_000;

/** SV: engine-stream-status `status` values (see the protocol notes above). */
export const STREAM_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  WAITING_KEY: 'waiting-key',
  WAITING_KEYFRAME: 'waiting-keyframe',
  ENDED: 'ended',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
  OK: 'ok',
});

export const LEVELS_HZ = 10;
export const LEVELS_LEASE_MS = 30_000;
export const PATCH_BATCH_MS = 50;
export const COMMAND_TIMEOUT_MS = 8_000;
export const SLOW_COMMAND_TIMEOUT_MS = 30_000;
/** engine-chat carries at most this many (newest) rows. */
export const CHAT_MAX_ROWS = 200;
/** A remote level older than this is silence (matches WarRoom's roster). */
export const LEVEL_STALE_MS = 400;

export const EMPTY_STATE = Object.freeze({
  user: null,
  org: null,
  channels: [],
  voice: {
    channelId: null, channelName: null, status: 'idle', muted: true, sharing: false,
    roster: [], sharers: [], watchTarget: null, viewer: null, // SV: viewer
    keyState: null, keyProblem: null, error: null, // E2EV
    freqs: [], // LEADFREQ
  },
  overlay: { open: false },
  text: { activeChannelId: null },
  unread: {},
  caps: { deafen: false, overlay: false, share: false },
  people: {}, // PM
  prefs: { overlayDms: true }, // PM
  liveOps: [], // LIVE
});

export const isBridgePayload = (p) => Boolean(p) && p.v === BRIDGE_VERSION;

const inTauri = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);

/** Emit a bridge event to one window (falls back to app-wide emit). */
export async function bridgeEmit(target, event, payload = {}) {
  if (!inTauri()) return;
  const mod = await import('@tauri-apps/api/event');
  const body = { ...payload, v: BRIDGE_VERSION };
  if (typeof mod.emitTo === 'function') await mod.emitTo(target, event, body);
  else await mod.emit(event, body);
}

/** Listen to a bridge event; returns an unlisten function (sync, safe early). */
export function bridgeListen(event, handler) {
  if (!inTauri()) return () => {};
  let unlisten = null;
  let stopped = false;
  import('@tauri-apps/api/event')
    .then(({ listen }) => listen(event, (e) => { if (isBridgePayload(e.payload)) handler(e.payload); }))
    .then((fn) => { if (stopped) fn(); else unlisten = fn; })
    .catch((err) => console.warn(`[bridge] listen ${event} failed:`, err));
  return () => { stopped = true; if (unlisten) unlisten(); };
}

/**
 * SV: an emitter to one window that keeps call order — the stream relay
 * needs frames to arrive in the order they were sent (a delta before its
 * keyframe is undecodable). bridgeEmit awaits a dynamic import on every call;
 * this loads the module once and then emits synchronously. Fire-and-forget.
 */
export function createOrderedEmitter(target) {
  let emitFn = null;
  let loading = null;
  const load = () => {
    if (!loading) {
      loading = import('@tauri-apps/api/event').then((mod) => {
        emitFn = typeof mod.emitTo === 'function'
          ? (event, body) => mod.emitTo(target, event, body)
          : (event, body) => mod.emit(event, body);
      });
    }
    return loading;
  };
  const fail = (event) => (err) => console.warn(`[bridge] emit ${event} failed:`, err);
  return (event, payload = {}) => {
    if (!inTauri()) return;
    const body = { ...payload, v: BRIDGE_VERSION };
    if (emitFn) { emitFn(event, body).catch(fail(event)); return; }
    load().then(() => emitFn(event, body)).catch(fail(event));
  };
}

/** One server channel row → its EngineState.channels entry. Pure. */
export function engineChannel(ch, channelPresence = {}) {
  return {
    id: ch.id,
    name: ch.name,
    kind: (ch.channel_kind ?? 0) === 1 ? 'text' : 'voice',
    eventId: ch.event_id || null,
    parentId: ch.parent_channel_id || null,
    occupants: Array.isArray(channelPresence[ch.id]) ? channelPresence[ch.id] : [],
    // OPTREE: the server's annotations (channelController listChannels).
    // An older server sends none: everything stays joinable, as before.
    eventName: ch.event_name || null,
    eventKind: ch.event_id ? (ch.event_kind || null) : null,
    groupId: ch.event_group_id || null,
    canJoin: ch.can_join !== false,
    mine: ch.is_my_group === true,
    pendingMine: ch.my_signup_pending === true, // my sign-up here awaits approval
    // Visibility: only ranks at/above this level (and the owner) see it. 0 = everyone.
    minLevel: Number(ch.visible_min_level) || 0,
  };
}

/**
 * Engine side: build EngineState from WarRoom's raw state. Pure, so it's the
 * one place that defines how WarRoom's shapes map onto the protocol.
 */
export function buildEngineState({
  user, org, canManageChannels, channels = [], channelPresence = {},
  inComms, voiceChannel, voiceStatus, voiceMuted, voiceSharing, voiceRoster = [],
  voiceE2e = null, // E2EV: CommLink's { keyState: 'ready'|'waiting', keyProblem, error }
  activeSharers = [], watchTarget, isOverlay, overlaySafeMode, activeChannel,
  unread = {}, canShare = false,
  stripViewer = false, // SV: the strip's viewer owns watchTarget
  // LEADFREQ: the op frequencies this user may use ([{ name, channel_id,
  // is_leadership }], WarRoom's availableFreqs), which one carries my voice
  // (0 = my group channel, i = freqs[i-1]) and per-channel monitor status.
  freqs = [], activeFreqIdx = 0, monitorStatus = {},
  shareAudio = null, // SA: CommLink's onShareAudioChange report
  people = {}, prefs = null, // PM: engine/people.js buildPeople, { overlayDms }
  voiceConnect = null, // NET: CommLink's { connectIssue, via, port }
  liveOps = [], // LIVE: engine/liveOps.js buildLiveOps
}) {
  const callsign = user?.callsign || user?.username || null;
  const inVoice = Boolean(inComms && voiceChannel);
  let status = 'idle';
  if (inVoice) {
    // CommLink starts 'disconnected' before it begins connecting.
    status = voiceStatus === 'connected' ? 'connected' : voiceStatus === 'error' ? 'error' : 'connecting';
  }
  // Same rule as the overlay feed: I'm always listed while I'm sharing.
  const sharers = voiceSharing && callsign && !activeSharers.includes(callsign)
    ? [...activeSharers, callsign]
    : activeSharers;
  return {
    user: callsign ? { callsign } : null,
    org: org ? {
      id: org.id, callsign: org.callsign || org.name || '', canManageChannels: Boolean(canManageChannels),
      // Channel visibility pickers: what I can restrict a channel to (my level, or anything as owner).
      isOwner: Boolean(user?.id && org.owner_id === user.id),
      level: Number(org.role_level) || 0,
    } : null,
    channels: channels.map((ch) => engineChannel(ch, channelPresence)),
    voice: {
      channelId: inVoice ? voiceChannel.id : null,
      channelName: inVoice ? voiceChannel.name || null : null,
      status,
      muted: inVoice ? Boolean(voiceMuted) : true,
      sharing: inVoice ? Boolean(voiceSharing) : false,
      roster: inVoice ? voiceRoster : [],
      sharers: inVoice ? sharers : [],
      watchTarget: inVoice ? watchTarget || null : null,
      // SV: the strip's viewer, else the overlay when it's open (closed
      // overlay + target = the hidden engine decodes it for nobody).
      viewer: inVoice && watchTarget ? (stripViewer ? 'strip' : isOverlay ? 'overlay' : null) : null,
      // E2EV: voice is end-to-end only. keyState 'waiting' = this device has
      // no channel voice key yet (silent, recovering); error = the server's
      // version-gate refusal text. Optional fields — older strips ignore them.
      keyState: inVoice ? (voiceE2e?.keyState || 'waiting') : null,
      // Why it's still waiting, once recovery has been failing for a while.
      keyProblem: inVoice ? (voiceE2e?.keyProblem || null) : null,
      error: inVoice ? (voiceE2e?.error || null) : null,
      freqs: inVoice ? buildVoiceFreqs({ voiceChannel, freqs, activeFreqIdx, monitorStatus }) : [], // LEADFREQ
      // Frequency overlay: the net carrying my voice (group or a frequency).
      activeNet: inVoice ? (({ name, kind }) => ({ name, kind }))(resolveActiveNet({ voiceChannel, freqs, activeFreqIdx })) : null,
      connectIssue: inVoice ? voiceConnect?.connectIssue || null : null, // NET
      via: inVoice ? voiceConnect?.via || null : null, // NET
      viaPort: inVoice ? voiceConnect?.port ?? null : null, // NET
      transport: inVoice ? voiceConnect?.transport || null : null, // 'webview' | 'native'
      // SA: only sharers still sharing; my own share counts while it's active.
      shareAudio: inVoice && shareAudio ? {
        ...EMPTY_SHARE_AUDIO,
        ...shareAudio,
        sharers: (shareAudio.sharers || []).filter((s) => sharers.includes(s))
          .concat(shareAudio.active && callsign && !(shareAudio.sharers || []).includes(callsign) ? [callsign] : []),
        prefs: shareAudio.prefs || {},
      } : { ...EMPTY_SHARE_AUDIO, enabled: Boolean(shareAudio?.enabled), supported: Boolean(shareAudio?.supported) },
    },
    overlay: { open: Boolean(isOverlay) },
    text: { activeChannelId: activeChannel && (activeChannel.channel_kind ?? 0) === 1 ? activeChannel.id : null },
    unread: Object.fromEntries(Object.entries(unread).filter(([, n]) => n > 0)),
    caps: { deafen: false, overlay: !overlaySafeMode, share: Boolean(canShare) },
    people: inVoice ? people || {} : {}, // PM
    prefs: { overlayDms: prefs?.overlayDms !== false }, // PM
    liveOps: Array.isArray(liveOps) ? liveOps : [], // LIVE
  };
}

/**
 * LEADFREQ: state.voice.freqs — the transmit choices during an op: my group
 * channel (index 0) then each frequency I may use (the Leadership net
 * included). Frequency overlay: every entry stays connected; `active` carries
 * my voice and plays at normal volume, the rest play reduced
 * (engine/activeNet.js), `listening` = that net's connection is up. Empty when
 * I have no frequencies (nothing to switch). Switch with voice.setFrequency.
 */
export function buildVoiceFreqs({ voiceChannel, freqs = [], activeFreqIdx = 0, monitorStatus = {} }) {
  const list = (freqs || []).filter((f) => f && f.channel_id);
  if (!voiceChannel || list.length === 0) return [];
  const idx = Math.min(Math.max(0, activeFreqIdx | 0), list.length);
  // OPTREE: a frequency that IS the channel I'm in (a commander who joined
  // Command directly) is not a second choice — skipped, keeping every other
  // entry's index (voice.setFrequency indexes WarRoom's list, not this one).
  const out = [
    { index: 0, name: voiceChannel.name || 'Group', kind: 'group', leadership: false, command: false, active: idx === 0,
      // Frequency overlay: CommLink never leaves the group, so it is always heard.
      listening: true },
    ...list.map((f, i) => ({
      index: i + 1, name: f.name || 'FREQ', kind: 'frequency', leadership: f.is_leadership === true,
      command: f.is_command === true, active: idx === i + 1,
      // Every frequency (the active one included) is its own connection.
      listening: Boolean(monitorStatus[f.channel_id]?.connected),
      channelId: f.channel_id,
    })).filter((f) => f.channelId !== voiceChannel.id).map(({ channelId: _c, ...f }) => f),
  ];
  return out.length < 2 ? [] : out;
}

/** Either side (P2A): unread messages across the current server's text channels. */
export function totalUnread(state) {
  const unread = state?.unread || {};
  return (state?.channels || []).reduce((n, c) => n + (c.kind === 'text' ? unread[c.id] || 0 : 0), 0);
}

/**
 * Engine side (P2A): the engine's stored channel messages (messageStore.js
 * rows, see useChannelChat) → engine-chat rows. Pure. A row with no
 * `plaintext` key predates E2E (encrypted_content was plaintext then); an
 * explicit null plaintext means it can't be read yet — pending (MR2).
 */
export function buildChatRows(messages = [], { userId, resolveImageUrl = (u) => u } = {}) {
  return messages.slice(-CHAT_MAX_ROWS).map((m) => {
    const text = m.plaintext !== undefined ? (m.plaintext ?? null) : (m.encrypted_content ?? null);
    return {
      id: m.id,
      senderId: m.sender_id ?? null,
      callsign: m.callsign || null,
      timestamp: m.timestamp,
      text,
      imageUrl: m.image_url ? resolveImageUrl(m.image_url) : null,
      mine: Boolean(userId) && m.sender_id === userId,
      pending: text == null,
      relayedBy: m.relayed_by ?? null,
    };
  });
}

/**
 * Engine side: the engine-levels frame for the joined channel.
 * remoteLevels is CommLink's { [callsign]: { level, ts } }.
 */
export function buildLevelsFrame({ callsign, localSpeaking, localLevel, voiceMuted, remoteLevels = {}, now = Date.now() }) {
  const levels = {};
  const speaking = [];
  if (callsign) {
    const lvl = voiceMuted ? 0 : Math.round(localLevel || 0);
    levels[callsign] = lvl;
    if (localSpeaking && !voiceMuted) speaking.push(callsign);
  }
  for (const [who, entry] of Object.entries(remoteLevels)) {
    if (who === callsign) continue;
    const fresh = entry && now - entry.ts < LEVEL_STALE_MS;
    const lvl = fresh ? Math.round(entry.level || 0) : 0;
    levels[who] = lvl;
    // Remote audio only arrives while they transmit (VAD-gated), so fresh
    // audio is speaking.
    if (fresh && lvl > 0) speaking.push(who);
  }
  return { levels, speaking };
}

/**
 * Either side: the users of MY voice channel, ready to render — used by the
 * channels cabinet and meant for the ambient "your channel" card. Me first,
 * then the rest in roster order. Empty when not in voice.
 */
export function selectMyChannelUsers(state, levelsFrame) {
  const v = state?.voice;
  if (!v?.channelId) return [];
  const me = state.user?.callsign || null;
  const roster = v.roster.length ? v.roster : (me ? [me] : []);
  const ordered = me && roster.includes(me) ? [me, ...roster.filter((r) => r !== me)] : roster;
  const speaking = new Set(levelsFrame?.speaking || []);
  return ordered.map((callsign) => ({
    callsign,
    isMe: callsign === me,
    speaking: speaking.has(callsign),
    level: levelsFrame?.levels?.[callsign] ?? 0,
    sharing: v.sharers.includes(callsign),
    watching: v.watchTarget === callsign,
    // PM: who they are to me (userId, friend state, local mute, volume);
    // null for me and for members the engine couldn't resolve.
    person: callsign === me ? null : state.people?.[callsign] || null,
  }));
}
