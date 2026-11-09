/**
 * Frequency overlay, phase 1: the ACTIVE NET.
 *
 * A frequency is a closed net, not a channel. While in voice you stay in your
 * group channel (CommLink's connection never moves) and every frequency you
 * may use is a separate, always-connected net (useMonitorChannel with TX).
 * Exactly one net is active at a time:
 *   - it gets your mic (PTT / voice activation transmits only there, sealed
 *     with that net's own MLS audio key), and
 *   - it plays at normal volume; every other connected net plays at
 *     INACTIVE_NET_GAIN of it.
 * The group does NOT hear you while a frequency is active, and vice versa.
 *
 * Routing state is module-level (like voiceRelayAudio's onGroupKeyChange):
 * CommLink and the frequency connections live in the same window but in
 * unrelated components, and the mic frame path must not wait on React.
 */

/** Playback gain of every connected net that is not the active one (×base). */
export const INACTIVE_NET_GAIN = 0.3;

/** Playback volume for a net given whether it is the active one. */
export function netGain(isActive, base = 1) {
  const b = Number.isFinite(base) ? base : 1;
  return isActive ? b : b * INACTIVE_NET_GAIN;
}

/**
 * Phase 2: the nets you can cycle through — your frequencies with a channel,
 * deduped. There is no command channel, so no frequency should ever BE your
 * group channel; one that did (defensive) is dropped rather than becoming a
 * duplicate of the group slot. WarRoom indexes activeFreqIdx into THIS list.
 */
export function netFrequencies(freqs, groupChannelId) {
  const seen = new Set();
  const out = [];
  for (const f of freqs || []) {
    if (!f || !f.channel_id || seen.has(f.channel_id)) continue;
    if (groupChannelId && f.channel_id === groupChannelId) continue; // legacy guard
    seen.add(f.channel_id);
    out.push(f);
  }
  return out;
}

// ── Phase 3: MISSION WIDE ───────────────────────────────────────────────────
// The op commanders' one-way broadcast to everyone in the op. Not a channel:
// its relay room id is the event id, its key the event MLS group's
// MISSION_WIDE_KEY_LABEL export (voiceRelayAudio.js). The server decides who
// may transmit (my-assignment `mission_wide.can_transmit`, and the relay
// drops audio from a listen_only ticket); the client only mirrors it.

export const MISSION_WIDE_NAME = 'MISSION WIDE';

/**
 * While Mission Wide audio plays, every OTHER net (group, frequencies, the
 * active one included) is capped at base × this. One constant, stronger than
 * INACTIVE_NET_GAIN: the commander's broadcast is top priority.
 */
export const MISSION_WIDE_DUCK_GAIN = 0.15;

/** Mission Wide counts as "playing" until this long after its last frame. */
export const MISSION_WIDE_HOLD_MS = 600;

/**
 * Is Mission Wide live for me right now? Only while I'm in voice on a channel
 * of that op, and only when the server offered it (an op without a commander
 * never does). `missionWide` = my-assignment's `mission_wide` or null.
 */
export function missionWideLive(missionWide, { inComms, voiceChannel } = {}) {
  return !!(missionWide?.room_id && inComms && voiceChannel?.event_id
    && voiceChannel.event_id === missionWide.event_id);
}

/**
 * The toggle cycle: my frequencies (netFrequencies), then — for commanders
 * only (`can_transmit`) — the Mission Wide entry, always last so frequency
 * indexes never shift. `live` = missionWideLive(...).
 */
export function netCycle(freqs, groupChannelId, missionWide, live = true) {
  const list = netFrequencies(freqs, groupChannelId);
  if (live && missionWide?.room_id && missionWide.can_transmit === true) {
    list.push({ id: 'mission-wide', channel_id: missionWide.room_id, name: MISSION_WIDE_NAME, mission_wide: true, event_id: missionWide.event_id });
  }
  return list;
}

/**
 * Playback gain of a non-Mission-Wide net: netGain, capped at
 * base × MISSION_WIDE_DUCK_GAIN while Mission Wide audio is playing.
 */
export function duckedNetGain(isActive, base = 1, missionPlaying = false) {
  const g = netGain(isActive, base);
  if (!missionPlaying) return g;
  const b = Number.isFinite(base) ? base : 1;
  return Math.min(g, b * MISSION_WIDE_DUCK_GAIN);
}

/**
 * Which net is active, from WarRoom's state. activeFreqIdx 0 = group,
 * i = freqs[i-1] (clamped); `freqs` is netCycle's output. A frequency
 * without a channel, or (defensively, legacy data only) one that IS the group
 * channel, resolves to the group.
 * Returns { txNetId: null | channelId, name, kind: 'group'|'frequency'|'mission' }.
 */
export function resolveActiveNet({ voiceChannel, freqs = [], activeFreqIdx = 0 }) {
  const group = { txNetId: null, name: voiceChannel?.name || null, kind: 'group' };
  const list = freqs || [];
  const idx = Math.min(Math.max(0, activeFreqIdx | 0), list.length);
  if (idx === 0) return group;
  const f = list[idx - 1];
  if (!f?.channel_id || f.channel_id === voiceChannel?.id) return group;
  if (f.mission_wide) return { txNetId: f.channel_id, name: MISSION_WIDE_NAME, kind: 'mission' };
  return { txNetId: f.channel_id, name: f.name || 'FREQ', kind: 'frequency' };
}

// ── Mic routing ─────────────────────────────────────────────────────────────

let activeTxNetId = null; // null = the group channel (CommLink's own connection)
const senders = new Map(); // netId -> (frame) => void

/** WarRoom: set the active net (null = group). */
export function setActiveTxNet(netId) {
  activeTxNetId = netId || null;
}

export function getActiveTxNet() {
  return activeTxNetId;
}

/**
 * A frequency connection registers how to transmit one mic frame on its net
 * ({ opusBytes, ssrc, seq } → seal with the net's key, sign, send). Returns
 * an unregister function that only removes this exact sender.
 */
export function registerNetSender(netId, send) {
  senders.set(netId, send);
  return () => { if (senders.get(netId) === send) senders.delete(netId); };
}

export const ROUTE_GROUP = 'group';     // caller (CommLink) sends on the group connection
export const ROUTE_NET = 'net';         // handed to the active frequency's sender
export const ROUTE_DROPPED = 'dropped'; // active frequency not connected: dropped, never sent to the group

/**
 * CommLink calls this for every encoded mic frame before sending it. Only
 * ROUTE_GROUP means "send it on the group connection". While a frequency is
 * active the frame goes to that net or nowhere — falling back to the group
 * would let the group hear frequency traffic.
 */
export function routeMicFrame(frame) {
  if (!activeTxNetId) return ROUTE_GROUP;
  const send = senders.get(activeTxNetId);
  if (!send) return ROUTE_DROPPED;
  try { send(frame); } catch { /* sender is best-effort, fail closed */ }
  return ROUTE_NET;
}

/** Test-only reset. */
export function _resetActiveNetForTests() {
  activeTxNetId = null;
  senders.clear();
}
