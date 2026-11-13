// Screen-share audio (S2 transport + S3 playback; see
// docs/STREAMING_PLAN_2026_10_29.md). Pure logic, kept out of CommLink.jsx so
// it can be unit-tested (web-portal/test/share-audio.test.js).
//
// ── Wire format ────────────────────────────────────────────────────────────
// Share audio rides INSIDE the existing share stream (the sharer's publish
// uni stream, relayed by media-rust to each subscriber), as one more frame
// in the same framing the video already uses:
//
//   [4B frame_size BE][1B flags][4B timestamp_ms BE][payload]
//
//   video   flags 0x00 keyframe / 0x01 delta (unchanged)
//   audio   flags 0x05 = SHARE_FRAME_FLAG_AUDIO | SHARE_FRAME_FLAG_DELTA
//           payload = encrypt(inner) with the stream's video key (the same
//           MLS-derived 'video' export + SFrameCrypto as the video frames);
//           inner = [1B SHARE_AUDIO_INNER_V1][4B seq BE][2B duration_ms BE][opus]
//
// The bit-0 "delta" flag is set on purpose: every relay that predates this
// (media-rust masks bit 0 — video_flags_is_keyframe) then treats an audio
// frame as a delta, so it is never cached as the sharer's keyframe.
//
// ── Backward compatibility ─────────────────────────────────────────────────
// Shipped receivers (every 2.0.x) parse the flags byte as
// `buffer[4] === 0 ? 'key' : 'delta'` and would decrypt an audio frame (same
// key) and feed it to VideoDecoder.decode() as a delta — a decode error that
// closes their decoder. No choice of flags value avoids that, so old
// receivers must never SEE an audio frame. Three gates make sure of it:
//   1. media-rust forwards audio frames only to subscribers that asked for
//      them (`share_audio=1` on the subscribe URL — SHARE_AUDIO_SUBSCRIBE_PARAM;
//      old servers ignore unknown query params, old clients never send it).
//   2. A sharer sends audio frames only after its server told it it does that
//      filtering: SHARE_AUDIO_CAPABLE_SIGNAL, a one-byte uni stream on the
//      publish session (same shape as 0xAC/0xDE/0x4B; every shipped publisher
//      ignores unknown signal bytes). An old server never sends it, so a new
//      sharer on an old server sends no audio and nothing can leak to 2.0.x.
//   3. The inner payload starts with SHARE_AUDIO_INNER_V1 inside the
//      ciphertext, so a frame whose flags were tampered with on the way is
//      rejected after decrypt instead of being played (or decoded).
// The server still only ever sees [size][flags][ts] + ciphertext.
//
// ── Datagram transport (preferred) ─────────────────────────────────────────
// On a reliable stream, an audio frame waits behind every video byte queued
// ahead of it, so on a constrained uplink it arrived in clumps. It now goes as
// a WebTransport DATAGRAM when both ends support that. The datagram is the
// in-stream frame minus its length prefix, byte for byte:
//
//   [1B 0x05][4B timestamp_ms BE][encrypt(inner)]     (same inner, same key)
//
//   sharer → server   on the sharer's video PUBLISH session
//   server → viewer   on the viewer's video SUBSCRIBE session
//
// Both sessions are already bound to one sharer, so the cleartext names no
// one (the server knows the sharer from the authenticated publish session;
// the viewer knows which sharer it subscribed to). media-rust converts between
// the two forms without decrypting (services/media-rust/src/share_audio.rs),
// so every mix of old and new clients still works:
//   - a viewer asks for datagrams with SHARE_AUDIO_DGRAM_SUBSCRIBE_PARAM (on
//     top of SHARE_AUDIO_SUBSCRIBE_PARAM, which an older server still needs);
//     a viewer without it gets in-stream frames (2.0.6–2.0.8) or nothing
//     (2.0.0–2.0.5), whatever the sharer sent;
//   - a sharer sends datagrams only after SHARE_AUDIO_DGRAM_CAPABLE_SIGNAL
//     (another one-byte publish signal; shipped clients ignore it). On a
//     server that only sent SHARE_AUDIO_CAPABLE_SIGNAL it stays in-stream,
//     and a packet too big for the path's datagram size goes in-stream too.

/** Bit 0 of the flags byte: 0 = keyframe, 1 = delta (media-rust VIDEO_FLAG_DELTA). */
export const SHARE_FRAME_FLAG_DELTA = 0x01;
/** Bit 2: this frame is share audio, not video (media-rust SHARE_FRAME_FLAG_AUDIO).
 *  Bit 1 is avoided: media-rust's docs once reserved it for an encryption marker. */
export const SHARE_FRAME_FLAG_AUDIO = 0x04;
/** The flags byte every audio frame carries. */
export const SHARE_AUDIO_FLAGS = SHARE_FRAME_FLAG_AUDIO | SHARE_FRAME_FLAG_DELTA;
/** First plaintext byte of an audio payload (format version + type check). */
export const SHARE_AUDIO_INNER_V1 = 0xa1;
const INNER_HEADER_LEN = 7;
/** Server → publisher: "I filter share audio by subscriber capability". */
export const SHARE_AUDIO_CAPABLE_SIGNAL = 0x41;
/** Viewer → server: query param on the video subscribe URL. */
export const SHARE_AUDIO_SUBSCRIBE_PARAM = 'share_audio=1';
/** Control datagram type: [0xFF, 0x07, on] up, [0xFF, 0x07, on, ...callsign]
 *  relayed (callsign rebuilt server-side, like SHARE_ANNOUNCE). Shipped
 *  clients skip unknown 0xFF types; old servers drop it. */
export const SHARE_AUDIO_STATE_CONTROL = 0x07;

/** Tauri event the native capture emits one Opus packet per 20 ms on. */
export const SHARE_AUDIO_FRAME_EVENT = 'specter://share-audio-frame';
/** Overlay window → engine: { callsign, volume, muted }. */
export const OVERLAY_SHARE_AUDIO_VOLUME_EVENT = 'overlay-share-audio-volume';

export const isShareAudioFlags = (flags) => (flags & SHARE_FRAME_FLAG_AUDIO) !== 0;
export const isShareAudioCapableSignal = (bytes) => Boolean(bytes && bytes.length > 0 && bytes[0] === SHARE_AUDIO_CAPABLE_SIGNAL);

/** Plaintext of one audio frame (encrypted by the caller). */
export function encodeShareAudioInner({ seq, durationMs, opus }) {
  const out = new Uint8Array(INNER_HEADER_LEN + opus.length);
  const v = new DataView(out.buffer);
  out[0] = SHARE_AUDIO_INNER_V1;
  v.setUint32(1, seq >>> 0);
  v.setUint16(5, Math.max(0, Math.min(0xffff, Math.round(durationMs || 20))));
  out.set(opus, INNER_HEADER_LEN);
  return out;
}

/** → { seq, durationMs, opus } | null (wrong version/type, or too short). */
export function decodeShareAudioInner(bytes) {
  if (!bytes || bytes.length <= INNER_HEADER_LEN || bytes[0] !== SHARE_AUDIO_INNER_V1) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { seq: v.getUint32(1), durationMs: v.getUint16(5), opus: bytes.subarray(INNER_HEADER_LEN) };
}

/**
 * S7: one received audio payload → { seq, durationMs, opus } | null, for either
 * wire format of the stream (its header's `fv`): v1 = openV1(payload) (the
 * SFrameCrypto decrypt), v2 = openV2(payload, flags, tsMs) (share_frame.rs,
 * kind audio — flags/ts are the in-stream unit's, or SHARE_AUDIO_FLAGS for a
 * datagram, whose first byte is that same flags value). Throws what the
 * opener throws.
 */
export function openShareAudioPayload({ fv, payload, flags = SHARE_AUDIO_FLAGS, tsMs, openV1, openV2 }) {
  const inner = fv === 2 ? openV2(payload, flags, tsMs >>> 0) : openV1(payload);
  return decodeShareAudioInner(inner);
}

/** [4B size][1B flags][4B ts][payload] — the share stream's frame framing. */
export function frameShareUnit(flags, timestampMs, payload) {
  const frameSize = 1 + 4 + payload.length;
  const buf = new Uint8Array(4 + frameSize);
  const v = new DataView(buf.buffer);
  v.setUint32(0, frameSize);
  v.setUint8(4, flags);
  v.setUint32(5, timestampMs >>> 0);
  buf.set(payload, 9);
  return buf;
}

export const frameShareAudio = (timestampMs, payload) => frameShareUnit(SHARE_AUDIO_FLAGS, timestampMs, payload);

// ── Datagram framing + capability gating ───────────────────────────────────
/** Server → publisher: "send share audio as datagrams on this session". */
export const SHARE_AUDIO_DGRAM_CAPABLE_SIGNAL = 0x44;
/** Viewer → server: query param on the video subscribe URL. */
export const SHARE_AUDIO_DGRAM_SUBSCRIBE_PARAM = 'share_audio_dgram=1';
/** First byte of a share-audio datagram: the in-stream flags byte. */
export const SHARE_AUDIO_DATAGRAM_TYPE = SHARE_AUDIO_FLAGS;
export const SHARE_AUDIO_DATAGRAM_HEADER_LEN = 5;
/** When the runtime doesn't report datagrams.maxDatagramSize: a size every
 *  QUIC path carries (the 1200-byte minimum MTU less QUIC/H3 overhead). */
export const SHARE_AUDIO_DATAGRAM_FALLBACK_MAX = 1100;
/** Publish-session datagram queue bounds: audio older than this is useless. */
export const SHARE_AUDIO_DATAGRAM_MAX_AGE_MS = 250;
export const SHARE_AUDIO_DATAGRAM_HIGH_WATER_MARK = 16;

export const isShareAudioDgramCapableSignal = (bytes) => Boolean(bytes && bytes.length > 0 && bytes[0] === SHARE_AUDIO_DGRAM_CAPABLE_SIGNAL);

/** The query params a viewer adds to its subscribe URL ('' if it can't play share audio). */
export const shareAudioSubscribeParams = (supported) => (supported ? `&${SHARE_AUDIO_SUBSCRIBE_PARAM}&${SHARE_AUDIO_DGRAM_SUBSCRIBE_PARAM}` : '');

/** [1B 0x05][4B ts][payload] — the in-stream frame without its size prefix. */
export function frameShareAudioDatagram(timestampMs, payload) {
  const buf = new Uint8Array(SHARE_AUDIO_DATAGRAM_HEADER_LEN + payload.length);
  buf[0] = SHARE_AUDIO_DATAGRAM_TYPE;
  new DataView(buf.buffer).setUint32(1, timestampMs >>> 0);
  buf.set(payload, SHARE_AUDIO_DATAGRAM_HEADER_LEN);
  return buf;
}

/** → { tsMs, payload } | null (another datagram type, or too short). */
export function parseShareAudioDatagram(bytes) {
  if (!bytes || bytes.length <= SHARE_AUDIO_DATAGRAM_HEADER_LEN || bytes[0] !== SHARE_AUDIO_DATAGRAM_TYPE) return null;
  const tsMs = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  return { tsMs, payload: bytes.subarray(SHARE_AUDIO_DATAGRAM_HEADER_LEN) };
}

/** The writable side's max datagram size, or the fallback if it's not reported. */
export function datagramSizeLimit(datagrams) {
  const n = Number(datagrams?.maxDatagramSize);
  return Number.isFinite(n) && n > 0 ? n : SHARE_AUDIO_DATAGRAM_FALLBACK_MAX;
}

/**
 * Where one encrypted audio packet goes:
 *   'datagram'  server signalled datagram support, the datagram writer works,
 *               and the packet fits in maxDatagramSize
 *   'stream'    otherwise, if the server signalled in-stream support
 *   null        neither: drop (an older server could leak it to 2.0.x viewers)
 */
export function chooseShareAudioRoute({ datagramOk, streamOk, datagramUsable, datagramBytes, maxDatagramSize }) {
  if (datagramOk && datagramUsable && datagramBytes <= maxDatagramSize) return 'datagram';
  if (streamOk) return 'stream';
  return null;
}

/**
 * Sharer side: encrypts each native Opus packet and sends it as a datagram,
 * or in-stream as a fallback. Every dependency is injected so it can be
 * unit-tested:
 *   encrypt(inner)       the stream's video-key encrypt (throws when no key)
 *   caps()               { datagramOk, streamOk } from the server's signals
 *   datagramWriter()     a WritableStreamDefaultWriter on the publish
 *                        session's datagrams, or null
 *   maxDatagramSize()    current limit (datagramSizeLimit)
 *   submitStream(frame)  the send pump's submit.audio (in-stream frame)
 * A rejected datagram write marks the datagram path broken for this sender
 * (a WritableStream that rejected once is errored), and later packets go
 * in-stream. A full datagram queue drops the packet rather than falling back:
 * by then it is ~300 ms late, and in-stream would only make it later.
 */
export function createShareAudioSender({ encrypt, caps, datagramWriter, maxDatagramSize, submitStream }) {
  const stats = { datagrams: 0, stream: 0, oversize: 0, queueFull: 0, dgramErrors: 0, dropped: 0 };
  let datagramBroken = false;
  const send = ({ data_b64, timestamp_ms, duration_ms, seq } = {}) => {
    if (!data_b64) return null;
    const { datagramOk = false, streamOk = false } = caps() || {};
    if (!datagramOk && !streamOk) { stats.dropped++; return null; }
    let payload;
    try {
      const inner = encodeShareAudioInner({ seq: seq ?? 0, durationMs: duration_ms ?? 20, opus: base64ToBytes(data_b64) });
      payload = encrypt(inner);
    } catch { stats.dropped++; return null; } // no key right now / bad packet: drop, never plaintext
    const ts = timestamp_ms ?? 0;
    const writer = datagramOk && !datagramBroken ? datagramWriter() : null;
    const datagramBytes = SHARE_AUDIO_DATAGRAM_HEADER_LEN + payload.length;
    const limit = maxDatagramSize();
    const route = chooseShareAudioRoute({ datagramOk, streamOk, datagramUsable: Boolean(writer), datagramBytes, maxDatagramSize: limit });
    if (route === 'datagram') {
      if (writer.desiredSize !== null && writer.desiredSize <= 0) { stats.queueFull++; return null; }
      writer.write(frameShareAudioDatagram(ts, payload)).catch(() => { stats.dgramErrors++; datagramBroken = true; });
      stats.datagrams++;
      return 'datagram';
    }
    if (route === 'stream') {
      if (datagramOk && writer && datagramBytes > limit) stats.oversize++;
      submitStream(frameShareAudio(ts, payload));
      stats.stream++;
      return 'stream';
    }
    stats.dropped++;
    return null;
  };
  return { send, stats, get datagramBroken() { return datagramBroken; } };
}

/**
 * Viewer side: reads share-audio datagrams off a subscribe session until it
 * closes and calls onFrame(tsMs, encryptedPayload) for each one. Datagrams of
 * any other type are skipped (none are sent today). `isCurrent()` returning
 * false stops the loop, for when the subscription was superseded.
 */
export async function readShareAudioDatagrams(readable, onFrame, isCurrent = () => true) {
  let reader;
  try { reader = readable.getReader(); } catch { return; }
  try {
    while (isCurrent()) {
      const { value, done } = await reader.read();
      if (done) break;
      const d = parseShareAudioDatagram(value);
      if (d) onFrame(d.tsMs, d.payload);
    }
  } catch { /* transport closed */ } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let b64 = '';
  // Multiple of 3 so no chunk but the last is padded (see CommLink's relay).
  for (let i = 0; i < bytes.length; i += 6144) b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 6144)));
  return b64;
}

// ── A/V sync: how long to hold audio back ──────────────────────────────────
// Audio and video carry timestamps from one clock (QPC ms on the sharer), so
// for each type `arrival - timestamp` is "one-way transit + that type's own
// pipeline delay" plus a constant clock offset that cancels when the two are
// subtracted. The heuristic:
//
//   delay = (videoTransit - audioTransit)   video reaches this machine later
//                                           than the audio captured at the
//                                           same instant (encoder latency,
//                                           bigger frames, pacing)
//         + renderMs                        then still has to be decoded and
//                                           painted (measured decode time
//                                           when this window decodes, else a
//                                           fixed estimate for the overlay /
//                                           strip, which decode elsewhere)
//
// Transits are smoothed with an EWMA (jitter would otherwise make the delay
// wobble), the result is clamped to [minMs, maxMs], and until both streams
// have enough samples — or if the two timestamps clearly aren't from the same
// clock (|lag| > MAX_PLAUSIBLE_LAG_MS, an older native build) — it's
// defaultMs. Deliberately simple: native playback has its own jitter buffer;
// this only lines the two up to within a frame or two.
// The delay is also the native jitter buffer's depth. On the in-stream
// fallback, share audio rides the same reliable stream as the video: below
// ~80 ms a big keyframe ahead of it in the stream drains the buffer and the
// audio gaps. Datagram audio doesn't queue behind video, but the floor stays
// the same until two-machine measurements justify lowering it.
export const AV_DELAY_DEFAULT_MS = 120;
export const AV_DELAY_MIN_MS = 80;
export const AV_DELAY_MAX_MS = 400;
/** decode + paint + IPC to the viewer window, when this window can't measure it. */
export const AV_RENDER_ESTIMATE_MS = 35;
const MIN_SAMPLES = 20;
const EWMA_ALPHA = 0.05;
const MAX_PLAUSIBLE_LAG_MS = 2000;
/** A transit jump bigger than this is a clock reset / u32 wrap: start over. */
const TRANSIT_RESET_MS = 10_000;

export function createAvDelayEstimator({
  defaultMs = AV_DELAY_DEFAULT_MS, minMs = AV_DELAY_MIN_MS, maxMs = AV_DELAY_MAX_MS,
  renderEstimateMs = AV_RENDER_ESTIMATE_MS,
} = {}) {
  const mk = () => ({ ewma: null, n: 0 });
  let video = mk();
  let audio = mk();
  let decodeMs = null;
  const feed = (s, transit) => {
    if (!Number.isFinite(transit)) return;
    if (s.ewma === null || Math.abs(transit - s.ewma) > TRANSIT_RESET_MS) { s.ewma = transit; s.n = 1; return; }
    s.ewma += EWMA_ALPHA * (transit - s.ewma);
    s.n += 1;
  };
  return {
    onVideo(tsMs, arrivalMs) { feed(video, arrivalMs - tsMs); },
    onAudio(tsMs, arrivalMs) { feed(audio, arrivalMs - tsMs); },
    /** Measured decode time of one video frame in this window (ms). */
    onVideoDecodeMs(ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      decodeMs = decodeMs === null ? ms : decodeMs + 0.1 * (ms - decodeMs);
    },
    /** The current estimate, an integer number of ms. */
    delayMs() {
      if (video.n < MIN_SAMPLES || audio.n < MIN_SAMPLES) return defaultMs;
      const lag = video.ewma - audio.ewma;
      if (Math.abs(lag) > MAX_PLAUSIBLE_LAG_MS) return defaultMs;
      const render = decodeMs === null ? renderEstimateMs : decodeMs + 10;
      return Math.round(Math.min(maxMs, Math.max(minMs, lag + render)));
    },
    reset() { video = mk(); audio = mk(); decodeMs = null; },
  };
}

// ── Preferences (localStorage, like the other specter_* share prefs) ───────
export const SHARE_AUDIO_ENABLED_KEY = 'specter_share_audio';
export const SHARE_AUDIO_VOLUMES_KEY = 'specter_share_audio_volumes';
export const DEFAULT_SHARER_AUDIO = Object.freeze({ volume: 1, muted: false });

const safeStorage = (storage) => storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);

/** "Share audio" toggle; off unless the user turned it on. */
export function loadShareAudioEnabled(storage) {
  try { return safeStorage(storage)?.getItem(SHARE_AUDIO_ENABLED_KEY) === '1'; } catch { return false; }
}
export function saveShareAudioEnabled(enabled, storage) {
  try { safeStorage(storage)?.setItem(SHARE_AUDIO_ENABLED_KEY, enabled ? '1' : '0'); } catch { /* private mode */ }
}

export const clampShareVolume = (v) => (Number.isFinite(Number(v)) ? Math.min(2, Math.max(0, Number(v))) : 1);

function readVolumeMap(storage) {
  try {
    const raw = safeStorage(storage)?.getItem(SHARE_AUDIO_VOLUMES_KEY);
    const map = raw ? JSON.parse(raw) : {};
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch { return {}; }
}

/** Per sharer (by callsign): { volume 0..2, muted }. */
export function loadSharerAudioPref(callsign, storage) {
  const e = readVolumeMap(storage)[callsign];
  if (!e || typeof e !== 'object') return { ...DEFAULT_SHARER_AUDIO };
  return { volume: clampShareVolume(e.volume ?? 1), muted: Boolean(e.muted) };
}

export function saveSharerAudioPref(callsign, pref, storage) {
  if (!callsign) return loadSharerAudioPref(callsign, storage);
  const map = readVolumeMap(storage);
  const next = { ...loadSharerAudioPref(callsign, storage), ...pref };
  next.volume = clampShareVolume(next.volume);
  next.muted = Boolean(next.muted);
  map[callsign] = next;
  try { safeStorage(storage)?.setItem(SHARE_AUDIO_VOLUMES_KEY, JSON.stringify(map)); } catch { /* private mode */ }
  return next;
}

export const effectiveShareVolume = (pref) => (pref?.muted ? 0 : clampShareVolume(pref?.volume ?? 1));

// ── Native commands (specter-audio plugin), fail-soft ──────────────────────
// Older native builds don't have these: every call resolves (null on
// failure) and `probe()` tells the UI whether to show share-audio at all.
const CMD_PREFIX = 'plugin:specter-audio|';
// Tauri 2's wording: "Command <name> not found", "plugin <name> not found",
// "<plugin>.<cmd> not allowed ..." (no capability grant — equally unusable).
const MISSING_COMMAND = /not found|unknown command|not allowed|denied/i;

export function createShareAudioNative(invoke) {
  const call = (name, args) => Promise.resolve()
    .then(() => invoke(`${CMD_PREFIX}${name}`, args))
    .catch((err) => { console.debug(`[share-audio] ${name} failed:`, err); return null; });
  let probed = null;
  return {
    /** true if this native build has the share-audio commands. Cached. */
    probe() {
      if (!probed) {
        // A playback stop for a sharer that doesn't exist is a no-op, so it
        // is a side-effect-free way to ask "does the command exist?". An
        // error that isn't "no such command" means it exists and complained.
        probed = Promise.resolve()
          .then(() => invoke(`${CMD_PREFIX}share_audio_playback_stop`, { sharerId: '' }))
          .then(() => true, (err) => !MISSING_COMMAND.test(String(err?.message ?? err ?? '')));
      }
      return probed;
    },
    /** → { mode, echoRisk } | null */
    start: (sourceId, bitrateKbps) => Promise.resolve()
      .then(() => invoke(`${CMD_PREFIX}share_audio_start`, bitrateKbps ? { sourceId, bitrateKbps } : { sourceId })),
    stop: () => call('share_audio_stop', {}),
    playFrame: (sharerId, dataB64, timestampMs, seq) => call('share_audio_play_frame', { sharerId, dataB64, timestampMs, seq }),
    setVolume: (sharerId, volume) => call('share_audio_set_volume', { sharerId, volume }),
    setDelay: (sharerId, delayMs) => call('share_audio_set_delay', { sharerId, delayMs }),
    playbackStop: (sharerId) => call('share_audio_playback_stop', { sharerId }),
  };
}

// ── Viewer-side playback controller ────────────────────────────────────────
// Plays the share audio of the ONE sharer this device is watching. CommLink
// calls frame() for every decrypted audio frame of the watched stream and
// video() for every usable video frame; stop() when the watch ends.
// Native converges to a new delay gently (1% rate), so updates are cheap, but
// chasing estimator noise is still pointless: only move for a real change.
export const DELAY_UPDATE_INTERVAL_MS = 2000;
export const DELAY_UPDATE_MIN_CHANGE_MS = 20;

export function createShareAudioPlayer(native, {
  getPref = (callsign) => loadSharerAudioPref(callsign),
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  estimator = createAvDelayEstimator(),
} = {}) {
  let sharer = null;
  let sentDelay = null;
  let lastDelayAt = -Infinity;
  const begin = (callsign) => {
    if (sharer) native.playbackStop(sharer);
    sharer = callsign;
    estimator.reset();
    sentDelay = estimator.delayMs();
    lastDelayAt = now();
    native.setVolume(callsign, effectiveShareVolume(getPref(callsign)));
    native.setDelay(callsign, sentDelay);
  };
  const maybeUpdateDelay = (t) => {
    if (t - lastDelayAt < DELAY_UPDATE_INTERVAL_MS) return;
    lastDelayAt = t;
    const d = estimator.delayMs();
    if (sentDelay !== null && Math.abs(d - sentDelay) < DELAY_UPDATE_MIN_CHANGE_MS) return;
    sentDelay = d;
    native.setDelay(sharer, d);
  };
  return {
    get sharer() { return sharer; },
    /** One decrypted audio frame of `callsign`'s share. */
    frame(callsign, { tsMs, seq, opus }) {
      if (!callsign) return;
      if (sharer !== callsign) begin(callsign);
      const t = now();
      estimator.onAudio(tsMs, t);
      maybeUpdateDelay(t);
      native.playFrame(callsign, typeof opus === 'string' ? opus : bytesToBase64(opus), tsMs, seq);
    },
    /** A usable video frame of the watched stream arrived. */
    video(callsign, tsMs) {
      if (callsign && callsign === sharer) estimator.onVideo(tsMs, now());
    },
    videoDecodeMs(ms) { estimator.onVideoDecodeMs(ms); },
    /** Volume/mute changed for `callsign` (applies at once if it's playing). */
    applyPref(callsign, pref) {
      if (callsign && callsign === sharer) native.setVolume(callsign, effectiveShareVolume(pref));
    },
    /** Stop playing (unwatch, sharer left, switch). Idempotent. */
    stop() {
      if (!sharer) return;
      native.playbackStop(sharer);
      sharer = null;
      sentDelay = null;
      estimator.reset();
    },
    delayMs: () => estimator.delayMs(),
  };
}
