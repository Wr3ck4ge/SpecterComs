// Per-user voice volume ("this user's voice, for me") — engine side.
//
// The user picks a volume (0..2, 1 = 100 %) per user id. Voice is played
// natively: CommLink feeds each speaker's frames to the specter-audio plugin
// as one lane, keyed by the stream id `${channelId}:${ssrc}`
// (voiceRelayAudio.relayLaneStreamId), and the server's SsrcMap tells CommLink
// which user an ssrc belongs to. The plugin's set_stream_volume stores a gain
// per stream id and the mixer applies it on top of play_frame's per-call
// volume (channel volume × ducking), so the per-channel volume keeps working.
//
// The user → stream mapping isn't stable: a rejoin, a reconnect, a channel
// move or a different ssrc assignment gives the same user a new stream id
// (and an ssrc can later belong to someone else). So nothing is pushed "per
// user"; instead CommLink calls laneGains.sync(streamId, userId) for every
// frame it plays (one Map lookup), and the plugin is told whenever the gain a
// lane should have differs from what it was last given. That re-applies the
// volume on the first frame of any new lane, whatever caused it, and
// setVolumes re-syncs every known lane at once when the user moves a slider.
//
// Persisted in the engine's localStorage under USER_VOLUMES_KEY as
// { [userId]: volume } (only entries != 1).

export const USER_VOLUMES_KEY = 'specter_user_volumes';
export const MAX_USER_VOLUME = 2;
export const SET_STREAM_VOLUME_CMD = 'plugin:specter-audio|set_stream_volume';

/** 0..MAX_USER_VOLUME, rounded to whole percent; anything invalid → 1. */
export function clampUserVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(MAX_USER_VOLUME, Math.max(0, n)) * 100) / 100;
}

/** { [userId]: volume } → the same without unity / invalid entries. */
export function normalizeUserVolumes(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [uid, v] of Object.entries(map)) {
    if (!uid) continue;
    const c = clampUserVolume(v);
    if (c !== 1) out[uid] = c;
  }
  return out;
}

/** The slider value for this user (unknown user → unity). */
export const gainForUser = (volumes, userId) => (userId && volumes && volumes[userId] != null ? clampUserVolume(volumes[userId]) : 1);

// Above 100 % the slider is a boost in decibels, not a linear multiplier:
// a linear ×2 at 200 % is only +6 dB, which users heard as barely louder
// (owner report 2026-11-08: "feels more like 15 % at 200"). 100 → 200 % now
// spans 0 → +BOOST_DB_AT_MAX dB (150 % ≈ +9 dB ×2.8, 200 % = +18 dB ×7.9). The
// native mixer soft-limits boosted lanes (playback.rs) so peaks don't crack.
// 0..100 % stays linear (an attenuation, unchanged).
export const BOOST_DB_AT_MAX = 18;

/** Slider value (0..MAX_USER_VOLUME) → the linear gain sent to the mixer. */
export function laneGainForVolume(volume) {
  return boostCurve(clampUserVolume(volume), BOOST_DB_AT_MAX);
}

/** 0..2 slider (1 = 100 %) → linear gain: linear to 1, then up to +maxDb at 2. */
function boostCurve(v, maxDb) {
  if (v <= 1) return v;
  const db = (Math.min(v, 2) - 1) * maxDb;
  return Math.round(10 ** (db / 20) * 1000) / 1000;
}

// The default volume for everything you hear (Settings → Audio & voice →
// "Everyone's volume"): the engine's `specter_audio_gain`, applied to every
// voice channel and net (WarRoom → CommLink channelVolume → play_frame's
// `volume`, native clamp ×4). Per-user volume multiplies on top of it. Stored
// as the LINEAR gain (as before); the slider shows 0..200 %, with the same dB
// curve above 100 % but a smaller ceiling, +12 dB (×4), since both stack.
export const MASTER_BOOST_DB_AT_MAX = 12;

/** Slider percent (0..200) → stored linear gain. */
export function masterGainForPercent(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return 1;
  return boostCurve(Math.max(0, Math.min(200, p)) / 100, MASTER_BOOST_DB_AT_MAX);
}

/** Stored linear gain → slider percent (0..200), whole percent. */
export function percentForMasterGain(gain) {
  const g = Number(gain);
  if (!Number.isFinite(g) || g < 0) return 100;
  if (g <= 1) return Math.round(g * 100);
  const pct = 100 + (100 * 20 * Math.log10(g)) / MASTER_BOOST_DB_AT_MAX;
  return Math.round(Math.min(200, pct));
}

/** Immutable update: set (or reset to unity) one user's volume. */
export function withUserVolume(volumes, userId, volume) {
  const next = { ...(volumes || {}) };
  const c = clampUserVolume(volume);
  if (c === 1) delete next[userId];
  else next[userId] = c;
  return next;
}

export function loadUserVolumes(storage = globalThis.localStorage) {
  try {
    return normalizeUserVolumes(JSON.parse(storage?.getItem(USER_VOLUMES_KEY) || '{}'));
  } catch {
    return {};
  }
}

export function saveUserVolumes(volumes, storage = globalThis.localStorage) {
  try { storage?.setItem(USER_VOLUMES_KEY, JSON.stringify(normalizeUserVolumes(volumes))); } catch { /* not fatal */ }
}

/**
 * The lane → gain synchroniser CommLink owns (one per CommLink).
 *   invoke(cmd, args) → Promise   the Tauri invoke
 * sync(streamId, userId)   call per played frame; invokes only on a change
 * setVolumes(volumes)      new per-user map; re-syncs every known lane
 * forget(streamId)         the lane was cleared (optional; see below)
 * reset()                  channel left: forget every lane
 * Forgetting is always safe: the next frame of that lane re-sends its gain.
 * After MAX_FAILURES failed invokes (e.g. a native build without the
 * command) it stops trying, so a missing command can't cost an IPC per frame.
 */
export const MAX_FAILURES = 5;

export function createLaneGainSync({ invoke, volumes = {} } = {}) {
  let vols = normalizeUserVolumes(volumes);
  const applied = new Map(); // streamId → gain last sent
  const laneUser = new Map(); // streamId → userId it was last synced for
  let failures = 0;

  const send = (streamId, gain) => {
    applied.set(streamId, gain);
    if (failures >= MAX_FAILURES || typeof invoke !== 'function') return;
    Promise.resolve()
      .then(() => invoke(SET_STREAM_VOLUME_CMD, { streamId, volume: gain }))
      .then(() => { failures = 0; })
      .catch((err) => {
        failures += 1;
        // Not applied after all: let the next frame try again.
        if (applied.get(streamId) === gain) applied.delete(streamId);
        if (failures === MAX_FAILURES) console.warn('[userVolume] set_stream_volume keeps failing; per-user volume is off for this session:', err);
      });
  };

  const sync = (streamId, userId) => {
    if (!streamId) return;
    laneUser.set(streamId, userId || null);
    const gain = laneGainForVolume(gainForUser(vols, userId));
    if (applied.get(streamId) !== gain) send(streamId, gain);
  };

  return {
    sync,
    setVolumes(next) {
      vols = normalizeUserVolumes(next);
      for (const [streamId, userId] of laneUser) sync(streamId, userId);
    },
    forget(streamId) { applied.delete(streamId); laneUser.delete(streamId); },
    reset() { applied.clear(); laneUser.clear(); },
    /** test/diagnostics */
    appliedGain: (streamId) => applied.get(streamId),
  };
}
