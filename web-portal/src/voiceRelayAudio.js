/**
 * voiceRelayAudio — receive-side pieces shared by CommLink (the main voice
 * channel) and useMonitorChannel (passively monitored channels / frequencies).
 *
 * A voice channel runs in one of two modes, fixed per media-rust room (see
 * RoomState::voice_relay_mode in services/media-rust/src/main.rs, sourced from
 * channels.voice_relay_mode and handed to the client as the media ticket's
 * `voice_relay`):
 *
 *   mixed (false)  server decodes, mixes and re-encodes; every datagram is one
 *                  plaintext (TLS-only) Opus stream on ssrc=0.
 *   relay (true)   server never decodes; each sender's Opus frame is sealed
 *                  by a per-session RelayAudioSender (wasm-crypto, wire v3)
 *                  derived from the channel's MLS 'audio' export, and forwarded
 *                  opaquely on that sender's canonical ssrc. A priority
 *                  speaker's is_global_broadcast copy uses a second sender
 *                  derived from the event's 'audio-cascade' export instead.
 *
 * Relay wire v3 (see web-portal/wasm-crypto/src/relay_audio.rs): the
 * AudioFrame's encrypted_payload is
 *   0x03 | session_id(16) | seq_be64(8) | ts_ms_be64(8) | ChaCha20-Poly1305 ct | tag(16)
 * with key = HKDF(group export, lane, random per-session id), nonce = seq, and
 * AAD = header | ssrc | lane. The proto's own `sequence` field is NOT
 * authenticated and is informational only; replay protection lives in
 * RelayAudioReceiver (per ssrc+session window, authenticated) plus, since v3
 * (E2EV), the authenticated sender timestamp: frames more than ±30 s from the
 * receiver's clock are dropped as 'stale', which bounds replay into a
 * receiver that restarted mid-epoch. v1 (bare encrypt_framed ciphertext) and
 * v2 payloads are rejected.
 *
 * Deliberately has no imports (no wasm, no React, no mlsSession) so it can be
 * exercised from a plain Node harness (tests/relay-monitor-harness.mjs)
 * against the real wasm implementation.
 */

// ── Protobuf helpers for specter.v1.AudioFrame ────────────────────────────────
// Manual proto3 encoding — avoids adding a full protobuf runtime to the bundle.
// Fields: encrypted_payload (1, bytes), ssrc (2, uint32), sequence (3, int32),
// is_global_broadcast (4, bool), sender_signature (5, bytes).

function writeVarint(buf, value) {
  value = value >>> 0;
  while (value > 0x7f) {
    buf.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  buf.push(value & 0x7f);
}

export function decodeAudioFrameProto(bytes) {
  let pos = 0;
  let opusBytes = null;
  let ssrc = 0;
  let sequence = 0;
  let isGlobalBroadcast = false;
  let senderSignature = null;

  while (pos < bytes.length) {
    let tag = 0;
    let shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      let val = 0;
      shift = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        val |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      if (fieldNumber === 2) ssrc = val >>> 0;
      else if (fieldNumber === 3) sequence = val >>> 0;
      else if (fieldNumber === 4) isGlobalBroadcast = val !== 0;
    } else if (wireType === 2) {
      let len = 0; shift = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const data = bytes.slice(pos, pos + len);
      pos += len;
      if (fieldNumber === 1) opusBytes = data;
      else if (fieldNumber === 5) senderSignature = data;
    } else {
      break;
    }
  }

  return { opusBytes, ssrc, sequence, isGlobalBroadcast, senderSignature };
}

// Encoder counterpart to decodeAudioFrameProto above — writes an outgoing
// specter.v1.AudioFrame. Field order/tags must exactly match what
// decodeAudioFrameProto expects on the receiving end.
export function encodeAudioFrameProto(ssrc, sequence, opusBytes, isGlobalBroadcast, senderSignature) {
  const buf = [];

  // Field 1: encrypted_payload (bytes)
  writeVarint(buf, (1 << 3) | 2);
  writeVarint(buf, opusBytes.length);
  for (let i = 0; i < opusBytes.length; i++) buf.push(opusBytes[i]);

  // Field 2: ssrc (uint32)
  writeVarint(buf, (2 << 3) | 0);
  writeVarint(buf, ssrc);

  // Field 3: sequence (int32). Informational only — in relay mode the
  // authenticated 64-bit sequence lives in the v3 payload header. Kept in
  // int32's non-negative range so media-rust's prost round-trip re-encodes it
  // unchanged.
  writeVarint(buf, (3 << 3) | 0);
  writeVarint(buf, sequence & 0x7fffffff);

  // Field 4: is_global_broadcast (bool) — proto3 default (false) is safe to
  // omit; decodeAudioFrameProto already treats a missing field 4 as false.
  if (isGlobalBroadcast) {
    writeVarint(buf, (4 << 3) | 0);
    writeVarint(buf, 1);
  }

  // Field 5: sender_signature (bytes, optional — omitted when signing failed
  // upstream and the frame is being sent unsigned, matching that fallback).
  if (senderSignature && senderSignature.length > 0) {
    writeVarint(buf, (5 << 3) | 2);
    writeVarint(buf, senderSignature.length);
    for (let i = 0; i < senderSignature.length; i++) buf.push(senderSignature[i]);
  }

  return new Uint8Array(buf);
}

// ── Opening a received frame (fail-closed decrypt gate) ──────────────────────

export const DROP_NO_KEY = 'no-key';
export const DROP_DECRYPT_FAILED = 'decrypt-failed';
// Authenticated replay (same ssrc + session + sequence already played, or
// older than the receiver's window) — expected occasionally from multi-path
// delivery; never a sign of a stale key.
export const DROP_REPLAY = 'replay';
// Not a relay wire-v3 payload (e.g. a v1/v2 frame from an out-of-date client) —
// rejected without trying any key; also not a stale-key signal.
export const DROP_BAD_FORMAT = 'bad-format';
// E2EV: authentic frame whose sender timestamp is outside the skew window
// (relay_audio::MAX_SKEW_MS) — a replay into a restarted receiver, or a
// member whose system clock is badly wrong. Not a stale-key signal.
export const DROP_STALE = 'stale';
// A non-zero ssrc in a MIXED room: media-rust's mixer only ever emits ssrc=0
// (mixer_task, both the room mix and its cascade copies), so the only way a
// mixed room receives anything else is a relay-mode parent channel cascading
// its priority speaker's still-encrypted frame down the event tree. That
// payload is ciphertext — never Opus — so it must not reach a decoder.
export const DROP_UNEXPECTED_RELAY_FRAME = 'unexpected-relay-frame';

/**
 * Returns the playable Opus bytes for a decoded AudioFrame, or why it must be
 * dropped. Never returns ciphertext as playable:
 *  - mixed mode: ssrc=0 frames pass through untouched (plaintext mix);
 *    ssrc≠0 frames are relay ciphertext and are dropped.
 *  - relay mode: the frame MUST open — with the event cascade receiver for an
 *    is_global_broadcast frame, the channel receiver otherwise (both are wasm
 *    RelayAudioReceiver instances; the lane is also bound inside the AEAD, so
 *    the unauthenticated proto flag only selects which one to try). A missing
 *    receiver, a non-v3 payload, a failed AEAD check, a replay or a stale
 *    sender timestamp drops it.
 */
export function openAudioFrame(frame, { relayMode, channelKey, cascadeKey, channelPrevKey = null, cascadePrevKey = null }) {
  const ssrc = frame.ssrc >>> 0;
  if (!relayMode) {
    if (ssrc !== 0) return { ok: false, reason: DROP_UNEXPECTED_RELAY_FRAME };
    return { ok: true, opusBytes: frame.opusBytes };
  }
  const receiver = frame.isGlobalBroadcast ? cascadeKey : channelKey;
  // MR4: the lane's previous receiver while its rekey grace window is open
  // (see createKeyGraceSlot) — a sender that hasn't switched yet still plays.
  const previous = frame.isGlobalBroadcast ? cascadePrevKey : channelPrevKey;
  if (!receiver) return { ok: false, reason: DROP_NO_KEY };
  let firstError;
  try {
    return { ok: true, opusBytes: receiver.open(frame.opusBytes, ssrc) };
  } catch (error) {
    const reason = dropReasonForOpenError(error);
    // Only an AEAD failure can mean "sealed under the other key". A replay or
    // stale verdict already authenticated under the current key, and a
    // malformed / non-v3 payload fails before any key is involved.
    if (reason !== DROP_DECRYPT_FAILED || !previous || previous === receiver) {
      return { ok: false, reason, error };
    }
    firstError = error;
  }
  try {
    return { ok: true, opusBytes: previous.open(frame.opusBytes, ssrc), previousKey: true };
  } catch (error) {
    const reason = dropReasonForOpenError(error);
    // Authentic under the previous key but replayed/stale: report that, not a
    // key failure (it must not feed the stale-key recovery).
    if (reason === DROP_REPLAY || reason === DROP_STALE) return { ok: false, reason, error, previousKey: true };
    return { ok: false, reason: DROP_DECRYPT_FAILED, error: firstError };
  }
}

// RelayAudioReceiver.open throws one of the stable codes from relay_audio.rs.
function dropReasonForOpenError(error) {
  const code = typeof error === 'string' ? error : (error?.message || String(error));
  if (code === 'replay') return DROP_REPLAY;
  if (code === 'stale-timestamp') return DROP_STALE;
  if (code === 'unsupported-version' || code === 'malformed') return DROP_BAD_FORMAT;
  return DROP_DECRYPT_FAILED;
}

/**
 * Keep `prev` (a RelayAudioSender or RelayAudioReceiver) when it was derived
 * from exactly `secret` — a same-epoch re-export must NOT reset a receiver's
 * replay windows (that would let the relay replay recent frames) and needn't
 * start a new sender session. Otherwise returns a fresh one from `create()`.
 * Does NOT free `prev` — the caller owns that (and must skip it when the
 * returned instance is `prev` itself).
 */
export function retainOrReplaceRelayCipher(prev, secret, create) {
  if (prev && secret) {
    try { if (prev.matches_secret(secret)) return prev; } catch { /* freed/invalid — replace */ }
  }
  return create();
}

/**
 * Full receive-side routing for one audio datagram: parse → open (decrypt +
 * authenticated replay gate). Used by useMonitorChannel; CommLink composes
 * the same pieces inline because it interleaves signature verification,
 * logging and report capture between them.
 *
 * Replay/duplicate rejection happens inside the wasm receiver (per
 * (ssrc, session) window, updated only after the AEAD tag verified). The old
 * (ssrc, proto sequence) dedup was keyed on an unauthenticated field and
 * would wrongly drop a second device or a reconnected session of one user.
 *
 * Returns { action: 'play', ssrc, opusBytes, frame } |
 *         { action: 'drop', reason, ssrc?, frame?, error? } |
 *         { action: 'skip', reason }   (not an audio frame)
 */
export function routeAudioDatagram(bytes, { relayMode, channelKey, cascadeKey, channelPrevKey = null, cascadePrevKey = null }) {
  if (!bytes || bytes.length < 2) return { action: 'skip', reason: 'short' };
  if (bytes[0] === 0xFF) return { action: 'skip', reason: 'control' };
  let frame;
  try {
    frame = decodeAudioFrameProto(bytes);
  } catch {
    return { action: 'skip', reason: 'malformed' };
  }
  if (!frame.opusBytes || frame.opusBytes.length === 0) return { action: 'skip', reason: 'empty' };
  const ssrc = frame.ssrc >>> 0;
  const opened = openAudioFrame(frame, { relayMode, channelKey, cascadeKey, channelPrevKey, cascadePrevKey });
  if (!opened.ok) return { action: 'drop', reason: opened.reason, error: opened.error, ssrc, frame };
  return { action: 'play', ssrc, opusBytes: opened.opusBytes, frame, previousKey: !!opened.previousKey };
}

// ── Key continuity across rekeys (MR4) ───────────────────────────────────────
// Every member switches to a new epoch's key when *it* applies the commit, and
// those moments differ by up to a few seconds (SSE delivery, catch-up, the
// Join/commit race). Discarding the old receive key at once dropped ~1 s of
// audio (and a burst of video) per rekey. Instead the previous receive key is
// kept for a short grace window: receive tries the current key, then the
// previous one; send always switches immediately.

export const KEY_GRACE_MS = 10_000;

/**
 * Holds one lane's receive key (a RelayAudioReceiver or an SFrameCrypto —
 * anything with .free()) plus, for `graceMs` after a rekey, the key it
 * replaced. Owns both: the previous key is freed exactly once, when the
 * window expires, when it's displaced by another rekey, or on clear().
 *
 *   install(next)  next becomes current; the old current becomes previous
 *                  (any older previous is freed) and the grace timer
 *                  restarts. Installing the current key again is a no-op;
 *                  installing the previous one swaps them back.
 *   clear()        frees both, no grace — for "no longer a member" and
 *                  channel switches, where an old key must not keep working.
 *   expire()       frees the previous key now (the timer calls this).
 *
 * Timers are injectable for tests.
 */
export function createKeyGraceSlot({ graceMs = KEY_GRACE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let current = null;
  let previous = null;
  let timer = null;
  const release = (key) => {
    if (key) { try { key.free?.(); } catch { /* already freed / invalid */ } }
  };
  const cancelTimer = () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
  };
  const expire = () => {
    cancelTimer();
    const old = previous;
    previous = null;
    release(old);
  };
  const clear = () => {
    cancelTimer();
    const c = current;
    const p = previous;
    current = null;
    previous = null;
    release(c);
    if (p !== c) release(p);
  };
  return {
    get current() { return current; },
    get previous() { return previous; },
    install(next) {
      if (!next) { clear(); return; }
      if (next === current) return;
      const displaced = previous;
      previous = current;
      current = next;
      // `next === displaced` is a swap back to the previous key — it's
      // current again, so it must not be freed.
      if (displaced && displaced !== next) release(displaced);
      cancelTimer();
      if (previous) timer = setTimer(expire, graceMs);
    },
    expire,
    clear,
  };
}

/**
 * True when two SFrameCrypto instances hold the same key: a probe sealed by
 * `a` opens under `b`. SFrameCrypto has no matches_secret (unlike the relay
 * ciphers) and the secret itself is deliberately not kept on the JS side, so
 * this is how a same-epoch video re-export is recognised — otherwise every
 * Join/Leave refresh would push a duplicate of the current key into the grace
 * slot and evict the genuinely previous one.
 */
export function sameSFrameKey(a, b) {
  if (!a || !b) return false;
  try {
    b.decrypt(a.encrypt(new Uint8Array(1)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `fn(key)` with the slot's current key, then — only if that throws —
 * with its previous key. Returns { value, previousKey } or rethrows the
 * current key's error. For SFrame video, where every failure is an AEAD
 * failure (the relay audio path uses openAudioFrame's finer-grained version).
 */
export function withGraceKeys(slot, fn) {
  const { current, previous } = slot;
  if (!current) throw new Error('no key');
  try {
    return { value: fn(current), previousKey: false };
  } catch (err) {
    if (!previous || previous === current) throw err;
    try { return { value: fn(previous), previousKey: true }; } catch { throw err; }
  }
}

// ── Escalated healing throttle (MR4) ─────────────────────────────────────────
// Sustained decrypt failures (frames failing both keys) escalate from a
// catch-up to ensureChannelGroup to mlsSession's org-wide healOrgEncryption.
// The last is heavy (every channel in the org), and CommLink plus every
// monitored channel can hit it for the same org at once — so at most one
// automatic heal per org per interval, shared module-wide.
export const ORG_HEAL_MIN_INTERVAL_MS = 60_000;
const lastOrgHealAt = new Map(); // orgId -> ms

export function claimOrgHeal(orgId, now = Date.now(), minIntervalMs = ORG_HEAL_MIN_INTERVAL_MS) {
  if (!orgId) return false;
  const last = lastOrgHealAt.get(orgId);
  if (last !== undefined && now - last < minIntervalMs) return false;
  lastOrgHealAt.set(orgId, now);
  return true;
}

// ── Lanes & ducking ──────────────────────────────────────────────────────────

// Native (Tauri) play_frame stream id for one sender's lane — gives each
// sender its own native decoder + jitter queue (playback.rs sums every
// registered stream_id). Must stay `${channelId}:${ssrc}`: CommLink's
// disconnect/Leave cleanup clear_streams by exactly this id.
export const relayLaneStreamId = (channelId, ssrc) => `${channelId}:${ssrc >>> 0}`;

// Matches the proto's PriorityLevel comment (specter.proto): tier 1
// ("-MAX dB") is near-silence, tier 2 ("-20dB") mirrors the legacy 0.1 gain.
export const duckGainForLevel = (level) => (level <= 1 ? 0.05 : 0.1);

/**
 * Gain multiplier for one lane under the server's RosterMessage::Duck /
 * DuckRelease state: every lane except the active priority speaker's own is
 * attenuated while a duck is active.
 */
export function laneDuckMultiplier(duckState, ssrc) {
  const { active, activeSsrc, level } = duckState || {};
  return (active && (ssrc >>> 0) !== activeSsrc) ? duckGainForLevel(level) : 1.0;
}

// ── MLS key-change notifications ─────────────────────────────────────────────
// WarRoom's global mls_commit / mls_welcome SSE handler applies a commit or
// Welcome to local MLS state for ANY channel/event group, but only had a hook
// (onMlsCommitRef) into the one channel CommLink has open. Monitored channels
// subscribe here, keyed by MLS group id (channel id, or event id for the
// cascade group), to re-export their key after the epoch moved.
const keyChangeListeners = new Map(); // groupId -> Set<fn>

export function onGroupKeyChange(groupId, fn) {
  if (!groupId) return () => {};
  let set = keyChangeListeners.get(groupId);
  if (!set) { set = new Set(); keyChangeListeners.set(groupId, set); }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0 && keyChangeListeners.get(groupId) === set) keyChangeListeners.delete(groupId);
  };
}

export function notifyGroupKeyChange(groupId) {
  const set = groupId && keyChangeListeners.get(groupId);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(groupId); } catch { /* best-effort */ }
  }
}
