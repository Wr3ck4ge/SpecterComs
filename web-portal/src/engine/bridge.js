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
//                  occupants: string[] (callsigns, from server presence) }],
//     voice:   { channelId, channelName,             // null when not in voice
//                status: 'idle' | 'connecting' | 'connected' | 'error',
//                muted, sharing,                     // my mic / my screen share
//                roster: string[],                   // who's in my channel (live)
//                sharers: string[],                  // who's sharing there
//                watchTarget: string | null,         // stream being watched
//                viewer: 'strip' | 'overlay' | null,  // SV: who shows watchTarget
//                freqs: [{ index, name, kind: 'group' | 'frequency', // LEADFREQ:
//                          leadership, active, listening }] },     // op transmit choices
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
//   (overlay.watch hands the stream to the overlay: viewer becomes 'overlay'.)
// voice.join acks once the join has been started; connecting → connected is
// then visible in state.voice.status. Sharing state is state.voice.sharing.
// chat.send / share.* can take longer than COMMAND_TIMEOUT_MS (MLS commits,
// capture start-up): the strip passes a longer timeout for those
// (SLOW_COMMAND_TIMEOUT_MS).

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
  STREAM_FRAME: 'engine-stream-frame', // SV
  STREAM_STATUS: 'engine-stream-status', // SV
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
    keyState: null, error: null, // E2EV
    freqs: [], // LEADFREQ
  },
  overlay: { open: false },
  text: { activeChannelId: null },
  unread: {},
  caps: { deafen: false, overlay: false, share: false },
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

/**
 * Engine side: build EngineState from WarRoom's raw state. Pure, so it's the
 * one place that defines how WarRoom's shapes map onto the protocol.
 */
export function buildEngineState({
  user, org, canManageChannels, channels = [], channelPresence = {},
  inComms, voiceChannel, voiceStatus, voiceMuted, voiceSharing, voiceRoster = [],
  voiceE2e = null, // E2EV: CommLink's { keyState: 'ready'|'waiting', error }
  activeSharers = [], watchTarget, isOverlay, overlaySafeMode, activeChannel,
  unread = {}, canShare = false,
  stripViewer = false, // SV: the strip's viewer owns watchTarget
  // LEADFREQ: the op frequencies this user may use ([{ name, channel_id,
  // is_leadership }], WarRoom's availableFreqs), which one carries my voice
  // (0 = my group channel, i = freqs[i-1]) and per-channel monitor status.
  freqs = [], activeFreqIdx = 0, monitorStatus = {},
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
    org: org ? { id: org.id, callsign: org.callsign || org.name || '', canManageChannels: Boolean(canManageChannels) } : null,
    channels: channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      kind: (ch.channel_kind ?? 0) === 1 ? 'text' : 'voice',
      eventId: ch.event_id || null,
      parentId: ch.parent_channel_id || null,
      occupants: Array.isArray(channelPresence[ch.id]) ? channelPresence[ch.id] : [],
    })),
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
      error: inVoice ? (voiceE2e?.error || null) : null,
      freqs: inVoice ? buildVoiceFreqs({ voiceChannel, freqs, activeFreqIdx, monitorStatus }) : [], // LEADFREQ
    },
    overlay: { open: Boolean(isOverlay) },
    text: { activeChannelId: activeChannel && (activeChannel.channel_kind ?? 0) === 1 ? activeChannel.id : null },
    unread: Object.fromEntries(Object.entries(unread).filter(([, n]) => n > 0)),
    caps: { deafen: false, overlay: !overlaySafeMode, share: Boolean(canShare) },
  };
}

/**
 * LEADFREQ: state.voice.freqs — the transmit choices during an op: my group
 * channel (index 0) then each frequency I may use (the Leadership net
 * included). `active` carries my voice; every other entry is heard passively
 * (WarRoom monitors it), `listening` = that monitor is connected. Empty when
 * I have no frequencies (nothing to switch). Switch with voice.setFrequency.
 */
export function buildVoiceFreqs({ voiceChannel, freqs = [], activeFreqIdx = 0, monitorStatus = {} }) {
  const list = (freqs || []).filter((f) => f && f.channel_id);
  if (!voiceChannel || list.length === 0) return [];
  const idx = Math.min(Math.max(0, activeFreqIdx | 0), list.length);
  return [
    { index: 0, name: voiceChannel.name || 'Group', kind: 'group', leadership: false, active: idx === 0,
      listening: idx === 0 || Boolean(monitorStatus[voiceChannel.id]?.connected) },
    ...list.map((f, i) => ({
      index: i + 1, name: f.name || 'FREQ', kind: 'frequency', leadership: f.is_leadership === true, active: idx === i + 1,
      listening: idx === i + 1 || Boolean(monitorStatus[f.channel_id]?.connected),
    })),
  ];
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
  }));
}
