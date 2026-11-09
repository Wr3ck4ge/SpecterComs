/* global VideoDecoder, EncodedVideoChunk -- WebCodecs (WebView2 / Chromium) */
import { useEffect, useRef, useState } from 'react';
import { EV, STREAM_STATUS, ENGINE_WINDOW, bridgeEmit, bridgeListen } from '../../engine/bridge.js';
import { VIEWER_REQUEST_INTERVAL_MS, createThrottledTrigger } from '../../engine/keyframeRequest.js';
import {
  HW_ERRORS_BEFORE_SOFTWARE, createDecodeWatch, createRateLimitedLog, createRecoveryBudget, decoderRecoveryReason,
} from '../../engine/videoRecovery.js';
import { ASPECT_16_9, aspectChanged } from '../../engine/videoAspect.js';

// SV: the strip side of the stream viewer — decodes the frames the engine
// relays for the watched stream (engine-stream-frame, see bridge.js) with
// WebCodecs, the same way the overlay window decodes overlay-video-nal.
//
//   const s = useStripStream({ active, callsign, source, paused });
//   s.canvasRef   attach to the <canvas> the picture is drawn into
//   s.status      'connecting' | 'waiting-key' | 'waiting-keyframe' | 'live'
//                 | 'stalled' | 'ended' | 'unavailable' | 'error'
//   s.message     human text for the status (or null)
//   s.hasPicture  a frame has been drawn (keep showing it under the status)
//   s.aspect      the stream's width / height (decoded frames, else the
//                 header; 16:9 until known) — the viewer sizes itself to it
//   s.retry()     drop the decoder and start over (the caller also asks the
//                 engine to re-subscribe)
//
// A decoder error, a decoder that closed, a decode() that throws, or a stall
// (frames going in, nothing out for 2 s) recreates the decoder on the next
// keyframe and asks for one (engine/videoRecovery.js) — up to RECOVERY_MAX
// times in 30 s before it gives up with the 'error' status and Retry.
//
// Nothing runs while `active` is false: no listener callbacks, no decoder.
// The decoder is created on the first keyframe's config and closed on
// unmount / close / a new session / retry. `paused` (viewer hidden behind
// another panel) keeps decoding — so showing it again is instant — but skips
// drawing.

// Deltas beyond this are dropped until the next keyframe (requested at once —
// KF — but up to 2 s away from a pre-2.1 sharer), so keep it deep enough
// (~100 ms at 60 fps) that a short burst is absorbed — only the newest frame
// is painted anyway.
const MAX_DECODE_QUEUE = 6;
const STALL_MS = 4000;
const MAX_HELD = 150; // frames held while the decoder is being set up (≈ one GOP)
// codec → the hardwareAcceleration value that worked (isConfigSupported is
// async and the answer doesn't change for this page's lifetime).
const HW_CHOICE = new Map();

// ── Frame source ───────────────────────────────────────────────────────────
// The bridge listeners are registered once per page and stay registered
// (frames only arrive while the engine has the strip as the viewer, so an
// idle listener costs nothing). Registering per viewer instead would race
// the engine: the GOP it replays when the strip takes over a running stream
// can arrive before an async listen() has completed.
let sink = null;
let warmed = false;
export function warmStreamListener() {
  if (warmed) return;
  warmed = true;
  bridgeListen(EV.STREAM_FRAME, (p) => sink?.onFrame(p));
  bridgeListen(EV.STREAM_STATUS, (p) => sink?.onStatus(p));
}
export const bridgeStreamSource = {
  subscribe(handlers) {
    warmStreamListener();
    sink = handlers;
    return () => { if (sink === handlers) sink = null; };
  },
  // KF: ask the engine to get a keyframe from the sharer now (see
  // engine-stream-keyframe-request in bridge.js). The hook throttles.
  requestKeyframe(session) {
    bridgeEmit(ENGINE_WINDOW, EV.STREAM_KEYFRAME_REQUEST, { session }).catch(() => {});
  },
};

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const sameConfig = (a, b) => Boolean(a && b) && a.codec === b.codec && a.width === b.width && a.height === b.height;

export default function useStripStream({ active = true, callsign, source = bridgeStreamSource, paused = false }) {
  const canvasRef = useRef(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [st, setSt] = useState({ status: 'connecting', message: null, hasPicture: false, aspect: ASPECT_16_9 });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let decoder = null;
    let decoderBroken = false;
    let hwErrors = 0;
    let config = null;
    let session = null;
    let needKey = true;
    let latest = null;
    let raf = 0;
    let lastOutputAt = 0;
    let status = 'connecting';
    let message = null;
    let hasPicture = false;
    let aspect = ASPECT_16_9;
    let disposed = false;
    const watch = createDecodeWatch();
    const budget = createRecoveryBudget();
    const logDecode = createRateLimitedLog((m) => console.warn(`[strip-video] ${m}`));
    const publish = () => { if (!disposed) setSt({ status, message, hasPicture, aspect }); };
    const setAspect = (w, h) => {
      const a = w > 0 && h > 0 ? w / h : 0;
      if (a > 0 && aspectChanged(a, aspect)) { aspect = a; publish(); }
    };
    const set = (next, msg = null) => {
      if (status === next && message === msg) return;
      status = next;
      message = msg;
      publish();
    };
    publish();

    const draw = () => {
      raf = 0;
      const frame = latest;
      latest = null;
      if (!frame) return;
      const canvas = canvasRef.current;
      if (canvas && !pausedRef.current) {
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.max(1, Math.round((canvas.clientWidth || frame.displayWidth) * dpr));
        const ch = Math.max(1, Math.round((canvas.clientHeight || frame.displayHeight) * dpr));
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        const scale = Math.min(cw / frame.displayWidth, ch / frame.displayHeight);
        const dw = Math.round(frame.displayWidth * scale);
        const dh = Math.round(frame.displayHeight * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(frame, Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
        if (!hasPicture) { hasPicture = true; publish(); }
      }
      frame.close();
    };

    const closeDecoder = () => {
      if (decoder && decoder.state !== 'closed') { try { decoder.close(); } catch { /* already closed */ } }
      decoder = null;
      decoderBroken = false;
      watch.reset();
    };
    const fail = (msg) => { closeDecoder(); needKey = true; set('error', msg); };
    // KF: while frames are being dropped for want of a keyframe, ask the
    // sharer for one (via the engine) instead of waiting out its GOP.
    // Throttled — the dropping branches below run for every frame.
    const askKey = createThrottledTrigger(() => source.requestKeyframe?.(session), VIEWER_REQUEST_INTERVAL_MS);
    // Drop the decoder, wait for the next keyframe (which recreates it from
    // `config`) and ask for one. Terminal only once the budget is spent.
    const recover = (why) => {
      logDecode(`recovering: ${why} (recoveries in window: ${budget.used})`);
      if (!budget.take()) { held = []; fail(`Couldn't decode the stream: ${why}`); return; }
      closeDecoder();
      held = [];
      needKey = true;
      if (status === 'live') set('waiting-keyframe');
      askKey.reset();
      askKey();
    };

    // Configuring is async: configure() doesn't throw for a config the
    // machine can't decode (e.g. no hardware decoder for the codec) — it
    // fails later through the error callback. So ask isConfigSupported()
    // first, hardware preferred, and hold the frames that arrive meanwhile
    // (starting with the keyframe that carried the config) to decode them
    // once the decoder is ready, instead of waiting a whole GOP.
    let configuring = false;
    let held = [];
    const pickHardware = async (codec) => {
      if (HW_CHOICE.has(codec)) return HW_CHOICE.get(codec);
      let chosen = null;
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
        try {
          const r = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true, hardwareAcceleration });
          if (r?.supported) { chosen = hardwareAcceleration; break; }
        } catch { /* try the next preference */ }
      }
      if (chosen) HW_CHOICE.set(codec, chosen);
      return chosen;
    };
    const makeDecoder = async (cfg) => {
      closeDecoder();
      if (typeof VideoDecoder === 'undefined') { fail("This window can't decode video (WebCodecs is unavailable)."); return; }
      configuring = true;
      const hardwareAcceleration = await pickHardware(cfg.codec);
      configuring = false;
      if (disposed || config !== cfg) return; // superseded meanwhile
      if (!hardwareAcceleration) { held = []; fail(`This stream's format (${cfg.codec}) can't be decoded here.`); return; }
      if (cfg.width && cfg.height) setAspect(cfg.width, cfg.height);
      const dec = new VideoDecoder({
        output: (frame) => {
          if (disposed || dec !== decoder) { frame.close(); return; }
          watch.output();
          hwErrors = 0;
          setAspect(frame.displayWidth, frame.displayHeight);
          if (latest) latest.close();
          latest = frame;
          lastOutputAt = performance.now();
          if (status !== 'live') set('live');
          if (!raf) raf = requestAnimationFrame(draw);
        },
        error: (e) => {
          if (dec !== decoder) return; // an already-replaced decoder
          logDecode(`VideoDecoder error (${hardwareAcceleration}): ${e?.message || e}`);
          // A hardware decoder that keeps failing: fall back to software.
          if (hardwareAcceleration === 'prefer-hardware' && ++hwErrors >= HW_ERRORS_BEFORE_SOFTWARE) {
            HW_CHOICE.set(cfg.codec, 'no-preference');
          }
          // Recover on the next frame (the callback can't decode itself).
          decoderBroken = true;
          recover(`decoder error: ${e?.message || e}`);
        },
      });
      decoder = dec;
      try {
        decoder.configure({ codec: cfg.codec, optimizeForLatency: true, hardwareAcceleration });
      } catch (e) {
        held = [];
        fail(`Couldn't start the decoder: ${e?.message || e}`);
        return;
      }
      const backlog = held;
      held = [];
      backlog.forEach(onFrame);
    };

    function onFrame(p) {
      if (disposed || status === 'error') return; // an error waits for retry()
      if (p.session !== session) {
        // A new subscription (switch, retry, self-view): start clean.
        session = p.session;
        needKey = true;
        config = null;
        held = [];
        closeDecoder();
      }
      if (!configuring) {
        const why = decoderRecoveryReason(decoder, { broken: decoderBroken, watch });
        if (why) recover(why);
        if (status === 'error') return;
      }
      if (p.key && p.config && (!decoder || !sameConfig(p.config, config)) && !(configuring && sameConfig(p.config, config))) {
        config = p.config;
        held = [p];
        makeDecoder(config);
        return;
      }
      // A keyframe without a config (recovering mid-stream): rebuild from the
      // last config we had.
      if (p.key && !p.config && !decoder && config && !configuring) {
        held = [p];
        makeDecoder(config);
        return;
      }
      if (configuring) {
        if (held.length < MAX_HELD) held.push(p); else { held = []; needKey = true; askKey(); }
        return;
      }
      if (needKey) {
        if (!p.key || !decoder) {
          if (status !== 'live' && status !== 'waiting-key') set('waiting-keyframe');
          askKey();
          return;
        }
        needKey = false;
      }
      if (!decoder || decoder.state !== 'configured') return;
      if (!p.key && decoder.decodeQueueSize > MAX_DECODE_QUEUE) { // behind: resync on the next keyframe
        logDecode(`dropping deltas: decode queue ${decoder.decodeQueueSize} > ${MAX_DECODE_QUEUE}`);
        needKey = true;
        askKey();
        return;
      }
      try {
        decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.ts || 0, data: base64ToBytes(p.data) }));
        watch.input();
      } catch (e) {
        recover(`decode() threw: ${e?.message || e}`);
      }
    }

    const onStatus = (p) => {
      if (disposed || (p.callsign && callsign && p.callsign !== callsign)) return;
      switch (p.status) {
        case STREAM_STATUS.OK:
          if (status === 'waiting-key') set('waiting-keyframe');
          break;
        case STREAM_STATUS.CONNECTING:
          if (status !== 'live') set('connecting');
          break;
        case STREAM_STATUS.WAITING_KEY:
        case STREAM_STATUS.WAITING_KEYFRAME:
        case STREAM_STATUS.ENDED:
        case STREAM_STATUS.UNAVAILABLE:
        case STREAM_STATUS.ERROR:
          set(p.status, p.message || null);
          break;
        default:
          break;
      }
    };

    const stop = source.subscribe({ onFrame, onStatus });
    const watchdog = setInterval(() => {
      // Frames going in, nothing coming out: don't wait for the next frame to
      // notice (there may be a GOP of deltas we'd just drop) — recover now.
      if (decoder && !configuring && watch.stalled()) recover('no decoder output for 2 s while frames arrive');
      else if (status === 'live' && performance.now() - lastOutputAt > STALL_MS) set('stalled', 'No video for a few seconds…');
    }, 500);
    return () => {
      disposed = true;
      stop();
      clearInterval(watchdog);
      if (raf) cancelAnimationFrame(raf);
      if (latest) latest.close();
      latest = null;
      closeDecoder();
    };
  }, [active, callsign, source, attempt]);

  return { canvasRef, ...st, retry: () => setAttempt((n) => n + 1) };
}
