import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { OVERLAY_BASE_W, overlayChannelLabel, overlayLayoutWidth } from '../engine/overlayHeader'; // OVH
import { OVERLAY_KEYFRAME_REQUEST_EVENT, VIEWER_REQUEST_INTERVAL_MS, createThrottledTrigger } from '../engine/keyframeRequest';
import { createDecodeWatch, createRateLimitedLog, decoderRecoveryReason } from '../engine/videoRecovery';
import { ASPECT_16_9, aspectChanged, overlayStreamHeight } from '../engine/videoAspect';
import { freqBarChips, freqBarHeight, overlayLayout } from '../engine/freqBar';
import FreqBar from './FreqBar';
import { Volume2, VolumeX } from 'lucide-react';
import { OVERLAY_SHARE_AUDIO_VOLUME_EVENT, clampShareVolume } from '../engine/shareAudio';
// PM: DM toasts + inline reply (data path and privacy notes in engine/overlayDm.js).
import {
  OVERLAY_DM_EVENT, OVERLAY_DM_REPLY_EVENT, OVERLAY_DM_REPLY_RESULT_EVENT,
  TOAST_H, TOAST_GAP, TOAST_AREA_PAD, REPLY_H,
  pushToast, expireToasts, nextExpiryIn, restartToastTimers, toastAreaHeight,
} from '../engine/overlayDm';
// Same as utils/format's fmtTime; inlined so the overlay bundle doesn't pull
// in the big chunk that module shares with the main window.
const fmtTime = (ts) => {
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};

// PM: the engine window's label, for replies (they carry plaintext, so they
// go to the engine only, not app-wide).
const ENGINE_WINDOW_LABEL = 'main';
const emitToEngine = (event, payload) => import('@tauri-apps/api/event')
  .then((mod) => (typeof mod.emitTo === 'function' ? mod.emitTo(ENGINE_WINDOW_LABEL, event, payload) : mod.emit(event, payload)));

/** OVH: the header's channel label; in an op the op name is the part cut short. */
function ChannelLabel({ label, style }) {
  if (!label.tail) return <span className="sov-channel-name" style={style}>{label.lead}</span>;
  return (
    <span className="sov-channel-name sov-channel-name--path" style={style}>
      <span className="sov-channel-lead">{label.lead}</span>
      <span className="sov-channel-tail">&nbsp;›&nbsp;{label.tail}</span>
    </span>
  );
}

/**
 * PM: one DM toast. Never takes focus on its own: the reply box only focuses
 * after the user clicked the toast (which needs the overlay interactive — in
 * passthrough every click goes to the game).
 */
function DmToast({ toast, open, onToggle, onSend, onCloseReply, onDismiss, interactive }) {
  const [text, setText] = useState('');
  const sending = toast.reply === 'sending';
  const sent = toast.reply === 'sent';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: TOAST_GAP, WebkitAppRegion: 'no-drag' }}>
      <div
        role="button"
        tabIndex={interactive ? 0 : -1}
        aria-expanded={open}
        aria-label={`Message from ${toast.callsign}${interactive ? '. Click to reply' : ''}`}
        onClick={() => { if (interactive && !sent) onToggle(); }}
        onKeyDown={(e) => { if (interactive && !sent && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle(); } }}
        style={{
          height: TOAST_H, boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6,
          background: 'rgba(8, 20, 34, 0.96)', border: `1px solid ${open ? 'rgba(103, 218, 245, 0.7)' : 'rgba(103, 218, 245, 0.3)'}`,
          color: '#e5e7eb', cursor: interactive && !sent ? 'pointer' : 'default', overflow: 'hidden',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, lineHeight: '15px' }}>
          <span style={{ fontWeight: 700, color: '#67daf5', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{toast.callsign}</span>
          <span style={{ flexShrink: 0, color: '#64748b', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{toast.timestamp ? fmtTime(toast.timestamp) : ''}</span>
          <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11, color: sent ? '#4ade80' : toast.reply === 'error' ? '#f87171' : '#64748b' }}>
            {sent ? 'Sent' : sending ? 'Sending…' : toast.reply === 'error' ? 'Not sent' : interactive ? 'Reply' : ''}
          </span>
          {interactive && !sending && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDismiss(); }}
              aria-label="Dismiss"
              title="Dismiss"
              style={{ flexShrink: 0, background: 'none', border: 0, padding: '0 2px', color: '#64748b', cursor: 'pointer', fontSize: 11 }}
            >✕</button>
          )}
        </div>
        <div
          style={{
            fontSize: 12, lineHeight: '16px', color: toast.text == null ? '#94a3b8' : '#e5e7eb', fontStyle: toast.text == null ? 'italic' : 'normal',
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word',
          }}
        >
          {toast.text ?? 'New message (waiting for its key)'}
        </div>
      </div>
      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); const t = text.trim(); if (t && !sending) onSend(t); }}
          style={{ height: REPLY_H, boxSizing: 'border-box', display: 'flex', gap: 6, alignItems: 'center' }}
        >
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCloseReply(); } }}
            maxLength={4000}
            disabled={sending}
            placeholder={`Reply to ${toast.callsign}`}
            aria-label={`Reply to ${toast.callsign}`}
            style={{
              flex: 1, minWidth: 0, height: 30, boxSizing: 'border-box', padding: '0 8px', borderRadius: 4, fontSize: 12,
              background: '#041018', color: '#e5e7eb', border: '1px solid rgba(103, 218, 245, 0.45)', outline: 'none',
            }}
          />
          {toast.reply === 'error' && (
            <span title={toast.replyError || 'Not sent'} style={{ flexShrink: 0, maxWidth: 110, fontSize: 11, color: '#f87171', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {toast.replyError || 'Not sent'}
            </span>
          )}
        </form>
      )}
    </div>
  );
}

/**
 * GameOverlayWindow — rendered in the second Tauri window (specter-overlay).
 * Receives voice state from the main window via Tauri events and displays a
 * minimal always-on-top HUD.  The window is transparent with no decorations.
 *
 * Layout:
 *  ┌─[channel/freq name ▾]──[active speaker]──[⠿][%][✕]─┐
 *  │  stream picker popup (when open)                     │
 *  │  screenshare preview (480 × 270)                     │
 *  └──────────────────────────────────────────────────────┘
 *
 * Click-through: window ignores cursor events when it loses focus so the
 * underlying game receives all mouse input uninterrupted.
 */
const SCALE_STEPS = [0.75, 1.0, 1.25, 1.5];
const SCALE_KEY = 'specter-overlay-scale';
// This decoder runs independently of (and competes for hardware decode resources
// with) the main window's decoder for the same stream. If it falls behind — e.g.
// GPU contention with the game itself — feeding it more delta frames only grows
// the backlog, since WebCodecs has no built-in way to skip ahead. Once its queue
// backs up past this, drop non-key frames until the next keyframe instead.
// ~100 ms at 60 fps: absorbs a short burst (only the newest frame is painted)
// instead of throwing everything away until the next keyframe (up to 2 s).
const OVERLAY_MAX_DECODE_QUEUE = 6;

// Whenever this decoder has to wait for a keyframe (just configured, fell
// behind, or errored), ask the engine to get one from the sharer now rather
// than sitting frozen until the scheduled one — see engine/keyframeRequest.js.
// Throttled: the waiting branch below runs for every dropped frame.
const requestKeyframe = createThrottledTrigger(() => {
  import('@tauri-apps/api/event').then(({ emit }) => emit(OVERLAY_KEYFRAME_REQUEST_EVENT, {})).catch(() => {});
}, VIEWER_REQUEST_INTERVAL_MS);

// Decoder trouble goes to the client trace log (rate-limited) so a
// diagnostic report shows it — it used to be console-only, i.e. invisible.
const overlayVideoLog = createRateLimitedLog((msg) => {
  console.warn(`[overlay-video] ${msg}`);
  import('@tauri-apps/api/core').then(({ invoke }) => invoke('client_log', { msg: `[trace] [overlay-video] ${msg}` })).catch(() => {});
});

// S3: mute + volume for the watched share's audio, on the name bar. The
// engine owns playback and persists the setting per sharer; this just sends
// the change (the next overlay-update carries it back as `pref`). The slider
// keeps its own value while dragging so the round trip can't fight the drag.
function ShareAudioControls({ callsign, pref }) {
  const volume = clampShareVolume(pref?.volume ?? 1);
  const muted = Boolean(pref?.muted);
  const [drag, setDrag] = useState(null);
  const send = (change) => {
    import('@tauri-apps/api/event')
      .then(({ emit }) => emit(OVERLAY_SHARE_AUDIO_VOLUME_EVENT, { callsign, ...change }))
      .catch(() => {});
  };
  const shown = drag ?? volume;
  return (
    <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, WebkitAppRegion: 'no-drag' }}>
      <button
        type="button"
        className="sov-btn"
        onClick={() => send({ muted: !muted })}
        title={muted ? `Unmute ${callsign}'s stream audio` : `Mute ${callsign}'s stream audio`}
        aria-label={muted ? `Unmute ${callsign}'s stream audio` : `Mute ${callsign}'s stream audio`}
        aria-pressed={muted}
        style={{ display: 'flex', background: 'none', border: 0, padding: '0 2px', color: muted ? '#f87171' : '#67daf5', cursor: 'pointer' }}
      >
        {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
      </button>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={Math.round(shown * 100)}
        disabled={muted}
        aria-label={`${callsign}'s stream volume`}
        title={`Stream volume ${Math.round(shown * 100)}%`}
        onChange={(e) => { const v = Number(e.target.value) / 100; setDrag(v); send({ volume: v }); }}
        onPointerUp={() => setDrag(null)}
        onBlur={() => setDrag(null)}
        style={{ flex: 1, minWidth: 0, height: 14, accentColor: '#67daf5', opacity: muted ? 0.4 : 1, cursor: 'pointer' }}
      />
      <span style={{ width: 38, textAlign: 'right', fontSize: 11, fontWeight: 600, color: muted ? '#f87171' : '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
        {muted ? 'Muted' : `${Math.round(shown * 100)}%`}
      </span>
    </span>
  );
}

export default function GameOverlayWindow() {
  const [data, setData] = useState({
    voiceRoster: [],
    localSpeaking: false,
    activeSharers: [],
    remoteLevels: {},
    userCallsign: '',
    watchTarget: null,
  });
  const [streamFrameSrc, setStreamFrameSrc] = useState(null); // base64 JPEG from main window (remote view)
  const [videoStatus, setVideoStatus] = useState(null); // stall/error message from main window
  const [showPicker, setShowPicker] = useState(false); // stream selector popup
  const [passthrough, setPassthrough] = useState(false); // forced click-through mode
  const passthroughRef = useRef(false); // ref mirror so event handlers stay current
  // PM: DM toasts (newest first, ≤ MAX_TOASTS) and the one open reply box.
  // Interactive = passthrough off: then toasts don't fade and can be clicked.
  const [dmToasts, setDmToasts] = useState([]);
  const [replyOpenId, setReplyOpenId] = useState(null);
  const [scale, setScale] = useState(() => {
    const saved = parseFloat(localStorage.getItem(SCALE_KEY));
    return SCALE_STEPS.includes(saved) ? saved : 1.0;
  });

  const overlayRef = useRef(null);
  const remoteCanvasRef = useRef(null);      // canvas for remote stream (own VideoDecoder)
  const remoteDecoderRef = useRef(null);     // VideoDecoder instance for remote stream
  // The watched stream's aspect (header, then decoded frames): the video
  // area is sized to it instead of a fixed 16:9 box (see overlayStreamHeight).
  const [streamAspect, setStreamAspect] = useState(ASPECT_16_9);
  const streamAspectRef = useRef(ASPECT_16_9);
  const noteStreamSize = useRef((w, h) => {
    if (!(w > 0 && h > 0)) return;
    const a = w / h;
    if (!aspectChanged(a, streamAspectRef.current)) return;
    streamAspectRef.current = a;
    setStreamAspect(a);
  }).current;

  const addDebugLog = useRef((msg) => {
    console.log('[OVERLAY DEBUG]', `[${new Date().toISOString().slice(11, 23)}] ${msg}`);
  }).current;

  // ── Speaker fade-out: keep displaying the last speaker for 2s after they stop ──
  const [displaySpeaker, setDisplaySpeaker] = useState(null);
  const [speakerFading, setSpeakerFading] = useState(false);
  const speakerFadeTimerRef = useRef(null);
  const decoderSyncedRef = useRef(false);    // true once first key frame received post-configure
  // Keep a ref to latest data so async overlay event handlers never have a stale closure
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  // Keep scale accessible inside VideoDecoder output callback (closure over ref, not state)
  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // ── Speaker name fade-out: show lingering name for 2s with CSS opacity fade ──
  // Compute activeSpeaker from current data each render (the stale-speaker timer
  // below forces a re-render the moment an entry crosses the 1500ms threshold).
  // When it drops to null, keep displaySpeaker alive for 2s with a CSS opacity transition.
  const activeSpeaker = (() => {
    const now = Date.now();
    for (const r of (data.voiceRoster || [])) {
      if (r === data.userCallsign) continue;
      const e = data.remoteLevels?.[r];
      if (e && (now - e.ts) < 1500 && e.level > 15) return r;
    }
    return null;
  })();
  useEffect(() => {
    if (activeSpeaker) {
      clearTimeout(speakerFadeTimerRef.current);
      setSpeakerFading(false);
      setDisplaySpeaker(activeSpeaker);
    } else if (displaySpeaker) {
      setSpeakerFading(true);
      speakerFadeTimerRef.current = setTimeout(() => {
        setDisplaySpeaker(null);
        setSpeakerFading(false);
      }, 2000);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpeaker]);

  // ── On mount: kill scrollbars and signal main window we're ready ────────
  useEffect(() => {
    console.log('[GameOverlayWindow] Component mounted');
    addDebugLog('MOUNT: component mounted, __TAURI_INTERNALS__=' + !!window.__TAURI_INTERNALS__);

    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.body.style.overflow = 'hidden';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    // Do NOT set background transparent — keeps WebView2 surface opaque so
    // semi-transparent CSS fills composite correctly against the dark body.

    // TX pulse animation + hover states live in src/overlay.css (a linked
    // stylesheet). A runtime-injected <style> element is blocked by Tauri's CSP
    // nonce in the packaged app. Colours/borders for :hover-styled classes must
    // NOT also be set inline, or the inline style would win over :hover.

    // Log when the component updates
    console.log('[GameOverlayWindow] Component updated with data:', data);

    // Start in click-through mode so a full-screen transparent overlay cannot
    // block clicks on the main app when opening/closing rapidly.
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      getCurrentWindow().setIgnoreCursorEvents(true).catch(() => {});
      passthroughRef.current = false;
      setPassthrough(false);
      addDebugLog('MOUNT: setIgnoreCursorEvents(true) — click-through');
    }).catch((e) => addDebugLog('MOUNT ERROR: ' + e));
  }, []);

  useEffect(() => {
    let unlisten;
    let cancelled = false;

    const bind = async () => {
      for (let i = 0; i < 120 && !cancelled; i += 1) {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          unlisten = await listen('force-overlay-exit', async () => {
            try {
              const { emit } = await import('@tauri-apps/api/event');
              await emit('overlay-exit');
              const { getCurrentWindow } = await import('@tauri-apps/api/window');
              await getCurrentWindow().hide();
            } catch {}
          });
          return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    bind();
    return () => {
      cancelled = true;
      try { unlisten?.(); } catch {}
    };
  }, []);

  // ── overlay-prepare: WarRoom signals intent to show; reset passthrough then ack ──
  // Called on every toggle-open. Guarantees click-through is active
  // before Rust show_overlay makes the window visible. WarRoom awaits overlay-ready
  // before calling show_overlay (with a timeout fallback for resilience).
  useEffect(() => {
    let unlisten;
    let cancelled = false;

    const bind = async () => {
      for (let i = 0; i < 120 && !cancelled; i += 1) {
        try {
          const { listen, emit } = await import('@tauri-apps/api/event');
          unlisten = await listen('overlay-prepare', async () => {
            try {
              const { getCurrentWindow } = await import('@tauri-apps/api/window');
              await getCurrentWindow().setIgnoreCursorEvents(true).catch(() => {});
              passthroughRef.current = false;
              setPassthrough(false);
              // PM: a reopened overlay starts without last session's toasts.
              setDmToasts([]);
              setReplyOpenId(null);
              addDebugLog('PREPARE: reset to click-through');
              await emit('overlay-ready');
              addDebugLog('PREPARE: overlay-ready emitted');
            } catch (e) {
              addDebugLog('PREPARE ERROR: ' + e);
            }
          });
          addDebugLog('LISTENER: overlay-prepare registered');
          return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    bind();
    return () => {
      cancelled = true;
      try { unlisten?.(); } catch {}
    };
  }, []);

  // ── Listen for overlay-update events from the main window ──────────────
  // Once this listener registers, overlay-ready is emitted to unblock WarRoom's
  // watchdog. overlayUpdateReadyRef still resolves for other coordination uses.
  const overlayUpdateReadyRef = useRef(null);
  const overlayUpdateReadyPromise = useRef(
    new Promise((resolve) => { overlayUpdateReadyRef.current = resolve; })
  );

  useEffect(() => {
    let unlisten;
    let cancelled = false;

    const bind = async () => {
      for (let i = 0; i < 120 && !cancelled; i += 1) {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          unlisten = await listen('overlay-update', (event) => {
            const payload = event.payload;
            addDebugLog(`UPDATE RECV: roster=${(payload.voiceRoster||[]).length} ch=${payload.voiceChannelName||'?'} speaking=${payload.localSpeaking} sharers=${(payload.activeSharers||[]).length}`);
            // Refresh timestamps for actively-speaking users to the overlay's local
            // clock so the 1500ms staleness check isn't defeated by Tauri IPC delay.
            if (payload.remoteLevels) {
              const now = Date.now();
              for (const cs of Object.keys(payload.remoteLevels)) {
                const entry = payload.remoteLevels[cs];
                if (entry && entry.level > 0) {
                  payload.remoteLevels[cs] = { ...entry, ts: now };
                }
              }
            }
            setData(payload);
          });
          addDebugLog(`LISTENER: overlay-update registered (attempt ${i+1})`);
          // Signal the VideoDecoder effect that this listener is now registered.
          overlayUpdateReadyRef.current?.();
          addDebugLog('READY: overlayUpdateReady resolved');
          return;
        } catch (err) {
          addDebugLog(`RETRY overlay-update (${i+1}): ${err?.message || String(err)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      addDebugLog('FAILED: overlay-update listener gave up after 120 attempts');
    };

    bind();
    return () => {
      cancelled = true;
      try { unlisten?.(); } catch {}
    };
  }, []);

  // ── VideoDecoder pipeline: header configures, NAL units decode ────────────
  // Registers video-header and video-nal listeners independently.
  // overlay-ready is emitted by the overlay-update effect above (simpler path).
  useEffect(() => {
    let unlistenHeader, unlistenNal;
    let cancelled = false;
    // Recovery (engine/videoRecovery.js): an error, a closed decoder, a
    // throwing decode() or a stall drops the decoder and asks for a keyframe;
    // the engine re-sends the header with every keyframe, which rebuilds it.
    const watch = createDecodeWatch();
    let decoderBroken = false;
    const dropDecoder = (why) => {
      overlayVideoLog(`recovering: ${why}`);
      const dec = remoteDecoderRef.current;
      try { if (dec && dec.state !== 'closed') dec.close(); } catch {}
      remoteDecoderRef.current = null;
      decoderSyncedRef.current = false;
      decoderBroken = false;
      watch.reset();
      requestKeyframe.reset();
      requestKeyframe();
    };
    const stallTimer = setInterval(() => {
      if (remoteDecoderRef.current && watch.stalled()) dropDecoder('no decoder output for 2 s while frames arrive');
    }, 500);

    const bind = async () => {
      for (let i = 0; i < 120 && !cancelled; i += 1) {
        try {
          const { listen } = await import('@tauri-apps/api/event');

          const headerP = listen('overlay-video-header', (event) => {
        const { codec, width, height } = event.payload;
        noteStreamSize(width, height);
        if (remoteDecoderRef.current && remoteDecoderRef.current.state !== 'closed') {
          try { remoteDecoderRef.current.close(); } catch {}
        }
        decoderSyncedRef.current = false; // wait for next key frame before decoding
        decoderBroken = false;
        watch.reset();
        if (typeof VideoDecoder === 'undefined') return;
        // Paint only the newest decoded frame per display refresh: after a
        // network hiccup frames arrive in a burst, and drawing each one as it
        // decodes plays the backlog back as a visible fast-forward. Older
        // frames in the burst are decoded (P-frames need them) but never drawn.
        let pendingFrame = null;
        let paintScheduled = false;
        const paint = () => {
          paintScheduled = false;
          const frame = pendingFrame;
          pendingFrame = null;
          if (!frame) return;
          const canvas = remoteCanvasRef.current;
          if (canvas) {
              // Size the canvas buffer at physical pixels (CSS container size × DPR).
              // Scale is applied by sizing the container directly — no CSS transform.
              const dpr = window.devicePixelRatio || 1;
              const cw = Math.round((canvas.clientWidth || frame.displayWidth) * dpr);
              const ch = Math.round((canvas.clientHeight || frame.displayHeight) * dpr);
              if (canvas.width !== cw || canvas.height !== ch) {
                canvas.width = cw;
                canvas.height = ch;
              }
              const letterScale = Math.min(cw / frame.displayWidth, ch / frame.displayHeight);
              const dw = Math.round(frame.displayWidth * letterScale);
              const dh = Math.round(frame.displayHeight * letterScale);
              const dx = Math.round((cw - dw) / 2);
              const dy = Math.round((ch - dh) / 2);
              const ctx = canvas.getContext('2d');
              ctx.fillStyle = '#000';
              ctx.fillRect(0, 0, cw, ch);
              ctx.drawImage(frame, dx, dy, dw, dh);
          }
          frame.close();
        };
        const dec = new VideoDecoder({
          output: (frame) => {
            if (dec === remoteDecoderRef.current) watch.output();
            noteStreamSize(frame.displayWidth, frame.displayHeight);
            if (pendingFrame) pendingFrame.close(); // superseded before it was shown
            pendingFrame = frame;
            if (!paintScheduled) { paintScheduled = true; requestAnimationFrame(paint); }
          },
          error: (e) => {
            console.error('[overlay decoder]', e);
            if (dec !== remoteDecoderRef.current) return; // already replaced
            // On any decode error the decoder is unusable. Reset and wait for the
            // next live keyframe — the CommLink relay sends header+keyframe atomically
            // on every keyframe, so the decoder self-heals within ≤2s.
            // DO NOT re-emit overlay-ready here: it triggers a GOP seed that races
            // with the live relay's queued microtasks, causing more decode errors
            // and an infinite recovery loop.
            // ...and ask for that keyframe now (it re-sends the header too).
            decoderBroken = true;
            dropDecoder(`VideoDecoder error: ${e?.message || e}`);
          },
        });
        let overlayConfigured = false;
        for (const hwPref of ['prefer-hardware', 'no-preference']) {
          try {
            dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: hwPref });
            remoteDecoderRef.current = dec;
            overlayConfigured = true;
            break;
          } catch(e) {
            console.error('[overlay] decoder configure failed hwPref=' + hwPref, e);
          }
        }
        if (!overlayConfigured) console.error('[overlay] decoder configure failed on all hw preferences');
      });

          const nalP = listen('overlay-video-nal', (event) => {
        const why = decoderRecoveryReason(remoteDecoderRef.current, { broken: decoderBroken, watch });
        if (why) dropDecoder(why);
        const dec = remoteDecoderRef.current;
        // No decoder (errored, or no header yet): frames are being dropped
        // until a keyframe brings the header — ask for it (throttled).
        if (!dec || dec.state === 'closed') { requestKeyframe(); return; }
        const { data: b64, type, timestamp_us } = event.payload;
        // Key-frame gate: VideoDecoder must start from a key frame after configure.
        if (type === 'key') decoderSyncedRef.current = true;
        if (!decoderSyncedRef.current) { requestKeyframe(); return; }
        // Decoder already backed up — drop this (and subsequent delta frames)
        // until the next keyframe rather than growing the lag further.
        if (type !== 'key' && dec.decodeQueueSize > OVERLAY_MAX_DECODE_QUEUE) {
          overlayVideoLog(`dropping deltas: decode queue ${dec.decodeQueueSize} > ${OVERLAY_MAX_DECODE_QUEUE}`);
          decoderSyncedRef.current = false;
          requestKeyframe();
          return;
        }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        try {
          dec.decode(new EncodedVideoChunk({ type, timestamp: timestamp_us, data: bytes }));
          watch.input();
        } catch(e) {
          dropDecoder(`decode() threw: ${e?.message || e}`);
        }
      });

          const [fn1, fn2] = await Promise.all([headerP, nalP]);
          if (cancelled) {
            try { fn1?.(); } catch {}
            try { fn2?.(); } catch {}
            return;
          }
          unlistenHeader = fn1;
          unlistenNal = fn2;
          // overlay-ready is emitted by the overlay-update effect; video runs in background
          addDebugLog(`LISTENER: video-header + video-nal registered (attempt ${i+1})`);
          return;
        } catch (err) {
          addDebugLog(`RETRY video-listeners (${i+1}): ${err?.message || String(err)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      addDebugLog('FAILED: video-listeners gave up after 120 attempts');
    };

    bind();
    return () => {
      cancelled = true;
      clearInterval(stallTimer);
      try { unlistenHeader?.(); } catch {}
      try { unlistenNal?.(); } catch {}
    };
  }, []);

  // ── Remote-view: JPEG thumbnails forwarded from the main window (legacy, unused) ─
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('overlay-video-frame', (event) => {
        // Only apply when we are watching someone else (main window sends these for remote streams)
        const { watchTarget, userCallsign } = dataRef.current;
        if (watchTarget && watchTarget === userCallsign) return; // self-view handled by canvas
        setStreamFrameSrc(`data:image/jpeg;base64,${event.payload.data}`);
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // Self-view uses only the raw NAL relay path (overlay-video-header/nal).
  // We intentionally do not render capture-preview thumbnails here to avoid
  // CPU-heavy fallback conversion paths.

  // Clear thumbnail/canvas when watch target changes
  useEffect(() => {
    setStreamFrameSrc(null);
    setVideoStatus(null);
    // NOTE: do NOT close/reset remoteDecoderRef here. The overlay-video-header event
    // already closes and recreates the decoder when a new stream is selected, and it
    // arrives in the same React flush as overlay-update. Closing here races with that
    // handler (CommLink effect runs before WarRoom effect in the same render cycle),
    // causing the newly-created decoder to be destroyed before any frames arrive.
    // Only clear the canvas visually so the previous frame doesn't linger.
    const remCanvas = remoteCanvasRef.current;
    if (remCanvas) {
      const ctx = remCanvas.getContext('2d');
      ctx.clearRect(0, 0, remCanvas.width, remCanvas.height);
    }
  }, [data.watchTarget]);

  // ── Listen for stall/error status from main window video pipeline ──────
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('overlay-video-status', (event) => {
        setVideoStatus(event.payload?.message || null);
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // ── PM: DM toasts from the engine, reply results back ───────────────────
  // Only data arrives here; nothing in this path ever focuses the window.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let stopped = false;
    const unlisteners = [];
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      const a = await listen(OVERLAY_DM_EVENT, (e) => {
        const toast = e.payload?.toast;
        if (toast?.id) setDmToasts((s) => pushToast(s, toast));
      });
      const b = await listen(OVERLAY_DM_REPLY_RESULT_EVENT, (e) => {
        const { requestId, ok, error } = e.payload || {};
        const toastId = typeof requestId === 'string' ? requestId.split('|')[0] : null;
        if (!toastId) return;
        setDmToasts((s) => s.map((t) => (t.id !== toastId ? t
          : ok ? { ...t, reply: 'sent', sentAt: Date.now(), replyError: null }
          : { ...t, reply: 'error', replyError: error || 'Not sent' })));
        if (ok) setReplyOpenId((cur) => (cur === toastId ? null : cur));
      });
      if (stopped) { a(); b(); } else unlisteners.push(a, b);
    }).catch(() => {});
    return () => { stopped = true; unlisteners.forEach((fn) => fn()); };
  }, []);

  // Fade: one timer for whichever toast expires next (see overlayDm.js).
  const interactive = !passthrough;
  useEffect(() => {
    const opts = { interactive, keepId: replyOpenId };
    const ms = nextExpiryIn(dmToasts, opts);
    if (ms == null) return undefined;
    const t = setTimeout(() => setDmToasts((s) => expireToasts(s, { ...opts, now: Date.now() })), ms + 5);
    return () => clearTimeout(t);
  }, [dmToasts, interactive, replyOpenId]);
  // Back to passthrough: the reply box closes (it can't be used) and waiting
  // toasts get a fresh fade timer.
  const prevPassthroughRef = useRef(passthrough);
  useEffect(() => {
    if (passthrough && !prevPassthroughRef.current) {
      setReplyOpenId(null);
      setDmToasts((s) => restartToastTimers(s));
    }
    prevPassthroughRef.current = passthrough;
  }, [passthrough]);

  // The typed text stays in the box until the engine confirms (a "sent"
  // result closes the box); on an error it's still there to retry.
  const sendDmReply = (toast, text) => {
    const requestId = `${toast.id}|${Date.now()}`;
    setDmToasts((s) => s.map((t) => (t.id === toast.id ? { ...t, reply: 'sending', replyError: null } : t)));
    emitToEngine(OVERLAY_DM_REPLY_EVENT, { requestId, userId: toast.userId, text })
      .catch(() => setDmToasts((s) => s.map((t) => (t.id === toast.id ? { ...t, reply: 'error', replyError: 'SpecterComs is not answering' } : t))));
  };
  const toastH = toastAreaHeight(dmToasts.length, Boolean(replyOpenId && dmToasts.some((t) => t.id === replyOpenId)));

  // ── Window size is computed here and pushed via setSize ──
  // Width: layout width × scale — 384, grown up to OVERLAY_MAX_W so a long
  // channel name fits the header (OVH, measured below; engine/overlayHeader.js).
  // Height: header + (picker, when open) + (video, when watching).
  // Header and picker stay at natural size at every scale; only width + video scale.
  // These constants are also applied as explicit element heights below (with
  // box-sizing: border-box in overlay.css), so the DOM and the window can't drift.
  const [layoutW, setLayoutW] = useState(OVERLAY_BASE_W); // OVH
  const OVERLAY_W = layoutW;
  const HEADER_H = 36;
  // Video area at the stream's own aspect (216 = 384 × 9/16 for 16:9;
  // includes its 1px top divider). An ultrawide share gets a shorter area
  // (32:9 → 108) instead of a 16:9 box with bars; clamped to 4:3 … 32:9.
  const STREAM_H = overlayStreamHeight(streamAspect, OVERLAY_W);
  const NAME_H = 24;    // streamer name bar under the stream (natural height, doesn't scale)
  const AUDIO_H = 30;   // stream-volume row under the name bar (interactive mode only)
  // Volume row: watching someone else's stream that carries audio, and the
  // overlay is interactive (in passthrough every click goes to the game, so
  // a slider there could never be used).
  const showAudioRow = Boolean(
    data.watchTarget && data.watchTarget !== data.userCallsign
    && data.shareAudio?.sharers?.includes(data.watchTarget) && !passthrough,
  );
  // Frequency bar: chips for frequencies with an active speaker (+ Mission
  // Wide), collapsing to 0 height when silent. Fixed height, pushes the stream.
  const freqChips = freqBarChips({
    freqs: data.freqSpeakers, activeNet: data.activeNetInfo,
    missionWide: data.missionWide,
  });
  const freqBarH = freqBarHeight(freqChips);
  const PICKER_ITEM_H = 30;
  const PICKER_GAP = 2;
  const PICKER_PAD = 4;      // padding on every side of the picker list
  const PICKER_BORDER = 1;   // divider between header and picker
  const pickerCount = (data.activeSharers?.length || 0) + 1; // +1 for the "No stream" row
  const pickerH = PICKER_BORDER + PICKER_PAD * 2
    + pickerCount * PICKER_ITEM_H + (pickerCount - 1) * PICKER_GAP;

  // Cycle to next scale step and persist
  const handleScaleCycle = (e) => {
    e.stopPropagation();
    setScale((prev) => {
      const idx = SCALE_STEPS.indexOf(prev);
      const next = SCALE_STEPS[(idx + 1) % SCALE_STEPS.length];
      localStorage.setItem(SCALE_KEY, String(next));
      return next;
    });
  };

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const resize = async () => {
      try {
        const { getCurrentWindow: getWin } = await import('@tauri-apps/api/window');
        const { LogicalSize, LogicalPosition } = await import('@tauri-apps/api/dpi');
        // Header and picker rows stay at natural height; only the video area scales.
        const videoH = data.watchTarget ? Math.round(STREAM_H * scale) + NAME_H + (showAudioRow ? AUDIO_H : 0) : 0;
        // PM: + the DM toast area under everything (bounded: ≤ 3 toasts + 1 reply box).
        const { totalH } = overlayLayout({ headerH: HEADER_H, pickerH: showPicker ? pickerH : 0, freqBarH, videoH, toastH });
        const w = Math.round(OVERLAY_W * scale);
        console.log('[overlay] setSize', w, 'x', totalH, 'watchTarget:', data.watchTarget);
        const win = getWin();
        await win.setSize(new LogicalSize(w, totalH));

        // The window is repositioned (top-left placed at a screen corner) only
        // once, when it's opened — that math assumes a fixed 384px width and
        // never accounts for the user's saved scale. At scale > 1x on the
        // top-right corner, the window is now wider than that assumption, so
        // its right edge can extend past the monitor's actual right edge —
        // "overlapping"/getting clipped at the screen border. Re-clamp here,
        // every time the real size is known, instead of trying to predict it
        // ahead of time from wherever setPosition gets called.
        const monitor = await win.currentMonitor();
        if (monitor) {
          const f = monitor.scaleFactor;
          const minX = monitor.position.x / f;
          const minY = monitor.position.y / f;
          const maxX = Math.max(minX, minX + monitor.size.width / f - w);
          const maxY = Math.max(minY, minY + monitor.size.height / f - totalH);
          const pos = await win.outerPosition();
          const curX = pos.x / f;
          const curY = pos.y / f;
          const clampedX = Math.min(Math.max(curX, minX), maxX);
          const clampedY = Math.min(Math.max(curY, minY), maxY);
          if (Math.round(clampedX) !== Math.round(curX) || Math.round(clampedY) !== Math.round(curY)) {
            console.log('[overlay] clamping position', curX, curY, '->', clampedX, clampedY);
            await win.setPosition(new LogicalPosition(clampedX, clampedY));
          }
        }
      } catch(e) { console.error('[overlay] setSize failed:', e); }
    };
    const t = setTimeout(resize, 30);
    return () => clearTimeout(t);
  }, [data.watchTarget, showPicker, pickerH, scale, showAudioRow, toastH, STREAM_H, freqBarH, layoutW]);

  // ── Interactivity policy ───────────────────────────────────────────────
  // Keep the overlay interactable by default so it can always be dragged/repositioned.
  // Full click-through is controlled only by the explicit passthrough hotkey.
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    let unlistenFocus;
    import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
        // Forced passthrough (PASS hotkey) overrides all focus changes.
        if (passthroughRef.current) {
          win.setIgnoreCursorEvents(true).catch(() => {});
          return;
        }
        // Always remain interactive so the overlay can be dragged/closed at any time.
        // Use the PASS hotkey to explicitly enter full click-through mode for gameplay.
        win.setIgnoreCursorEvents(false).catch(() => {});
        if (!focused) setShowPicker(false);
      });
    });
    return () => { unlistenFocus?.(); };
  }, []);

  // ── Passthrough toggle: specter://overlay-passthrough hotkey ─────────
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    // `disposed` closes the race where the effect is cleaned up (fast remount,
    // StrictMode double mount) before listen() resolves: without it the late
    // listener is never removed, and every leaked copy toggles passthrough
    // again on the same keypress (two copies = no visible change at all).
    let unlisten;
    let disposed = false;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('specter://overlay-passthrough', async () => {
        const next = !passthroughRef.current;
        passthroughRef.current = next;
        setPassthrough(next);
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const { invoke } = await import('@tauri-apps/api/core');
          await getCurrentWindow().setIgnoreCursorEvents(next);
          if (next) {
            setShowPicker(false); // close picker when going passthrough
            // Back to the game: hand focus back to the window it was taken from.
            await invoke('overlay_restore_focus');
          } else {
            // Leaving passthrough means the user wants to handle the overlay:
            // focus it so it can be dragged/resized right away, no Alt-Tab
            // (skipped by Rust over an exclusive-fullscreen game).
            await invoke('overlay_take_focus');
          }
        } catch {}
      }).then(fn => { if (disposed) fn(); else unlisten = fn; });
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  // ── Stale-speaker timer: re-render exactly when the next speaker goes stale ──
  // activeSpeaker is the only render output that changes with wall-clock time
  // (now - ts < 1500). Rather than polling, schedule one timeout for the earliest
  // moment a currently-fresh speaker entry expires; the re-render recomputes
  // activeSpeaker (possibly falling through to the next fresh speaker) and this
  // effect re-arms for whatever expires next. New overlay-update data re-arms too.
  const [staleTick, setStaleTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    let nextExpiry = Infinity;
    for (const r of (data.voiceRoster || [])) {
      if (r === data.userCallsign) continue;
      const e = data.remoteLevels?.[r];
      if (e && (now - e.ts) < 1500 && e.level > 15) nextExpiry = Math.min(nextExpiry, e.ts + 1500);
    }
    if (nextExpiry === Infinity) return;
    // +1ms so the re-render lands just past the 1500ms boundary; an early fire
    // simply re-arms with a ~0ms delay on the next run of this effect.
    const t = setTimeout(() => setStaleTick((n) => n + 1), Math.max(0, nextExpiry - now) + 1);
    return () => clearTimeout(t);
  }, [data.voiceRoster, data.remoteLevels, data.userCallsign, staleTick]);

  // ── Close: emit overlay-exit so main window resets its button state ────
  // No window.__TAURI__ guard — that check is falsy during early Tauri 2 init
  // and would silently no-op every click. The dynamic imports are always safe.
  const handleExit = async () => {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit('overlay-exit');
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().hide();
    } catch (e) {
      console.error('Overlay hide failed', e);
    }
    // Hand the user back to the app rather than to whatever was behind the HUD.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('strip_show');
    } catch (e) {
      console.error('Strip focus after overlay close failed', e);
    }
  };

  const { voiceRoster, localSpeaking, activeSharers, remoteLevels, userCallsign, watchTarget, voiceChannelName, voiceOpName, missionWide, selfSharing } = data;

  // C4: short notices from the engine (the streaming hotkey: "Streaming X",
  // "Stream stopped", or why it couldn't start). Shown in the header's channel
  // label for ~2.5 s, so the HUD never grows or reflows for them.
  const [notice, setNotice] = useState(null); // { text, kind: 'info'|'live'|'error', at }
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let unlisten;
    let disposed = false;
    import('@tauri-apps/api/event').then(({ listen }) => listen('overlay-notice', (e) => {
      const p = e?.payload;
      if (p && typeof p.text === 'string') setNotice({ text: p.text.slice(0, 80), kind: p.kind || 'info', at: Date.now() });
    })).then((fn) => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  // OVH: the channel label ("<op> › <group>" in an op, cut in the middle if
  // it must be) and the overlay width that fits it. The header's controls
  // keep their natural size, so the need is: the header minus the channel
  // button, plus the button's unclipped width (an invisible copy of it).
  // Phase 3: Mission Wide takes the header while it plays for a listener.
  const missionLabel = missionWide?.playing && !missionWide.transmitting
    ? `MISSION WIDE${missionWide.speaker ? ` · ${missionWide.speaker}` : ''}` : null;
  const baseLabel = missionLabel
    ? { lead: missionLabel, tail: null, full: missionLabel }
    : overlayChannelLabel({ channelName: voiceChannelName, opName: voiceOpName });
  // C4: a notice briefly takes the label's place (the width measurement
  // below keeps using the real label, so the HUD doesn't resize).
  const channelLabel = notice ? { lead: notice.text, tail: null, full: notice.text } : baseLabel;
  const noticeColor = notice ? (notice.kind === 'error' ? '#fbbf24' : notice.kind === 'live' ? '#f87171' : '#a5f3fc') : null;
  const headerRef = useRef(null);
  const channelBtnRef = useRef(null);
  const channelMeasureRef = useRef(null);
  useLayoutEffect(() => {
    const header = headerRef.current;
    const btn = channelBtnRef.current;
    const measure = channelMeasureRef.current;
    if (!header || !btn || !measure) return;
    const need = header.clientWidth - btn.offsetWidth + measure.offsetWidth + 1;
    const next = overlayLayoutWidth({ headerNeed: need, scale });
    setLayoutW((cur) => (cur === next ? cur : next));
  });

  const handleStreamSelect = async (callsign) => {
    if (!window.__TAURI_INTERNALS__) return;
    const { emit } = await import('@tauri-apps/api/event');
    emit('overlay-stream-select', { callsign: callsign || null });
  };

  // Active remote speaker: only show others, not self (self gets a TX chip instead)
  // activeSpeaker is already computed above for the fade effect.
  // displaySpeaker + speakerFading are used for rendering (2s fade-out).

  // Static look lives in src/overlay.css (sov-* classes). Inline styles below
  // are only values that depend on state/scale, plus WebkitAppRegion zones
  // (kept inline so drag/no-drag areas are visible right in the markup).
  // The root stays fully OPAQUE: this transparent WebView2 window can fail to
  // composite semi-transparent fills, and blur would smear the game behind it.
  const overlayW = Math.round(OVERLAY_W * scale);
  const videoH = Math.round(STREAM_H * scale);

  return (
    <div
      ref={overlayRef}
      className="sov-root"
      style={{ width: overlayW, WebkitAppRegion: 'drag' }}
    >
      {/* ── Header bar: [channel ▾] ── [speaker chip / TX] ── [PASS] ── [⠿] [%] [✕] ── */}
      <div ref={headerRef} className="sov-header" style={{ height: HEADER_H }}>
        {/* Channel / freq name — click to open stream picker */}
        <button
          ref={channelBtnRef}
          type="button"
          onClick={() => setShowPicker((v) => !v)}
          className="sov-btn sov-channel"
          style={{ WebkitAppRegion: 'no-drag' }}
          title={activeSharers?.length > 0 ? `${channelLabel.full} — click to select stream` : channelLabel.full}
        >
          <span className="sov-channel-icon">◈</span>
          {/* Phase 3: Mission Wide is red in the header (commander while it is
              their active net, everyone while its audio plays). */}
          <ChannelLabel label={channelLabel} style={noticeColor ? { color: noticeColor, fontWeight: 600 } : missionWide ? { color: '#f87171', fontWeight: 700 } : undefined} />
          {activeSharers?.length > 0 && (
            <span className="sov-caret">{showPicker ? '▲' : '▼'}</span>
          )}
        </button>
        {/* C4: my own share is live: a small, persistent LIVE pip. */}
        {selfSharing && (
          <span
            title="You're streaming"
            aria-label="You're streaming"
            style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '0 5px', marginLeft: 2,
              fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: '#fca5a5', border: '1px solid rgba(248,113,113,0.5)', borderRadius: 3, lineHeight: '14px' }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ef4444' }} />LIVE
          </span>
        )}
        {/* OVH: the same button's content at its natural width, off-screen,
            for the width measurement above. */}
        <span ref={channelMeasureRef} aria-hidden="true" className="sov-btn sov-channel sov-channel--measure">
          <span className="sov-channel-icon">◈</span>
          <ChannelLabel label={baseLabel} />
          {activeSharers?.length > 0 && <span className="sov-caret">▼</span>}
        </span>

        {/* Active remote speaker chip / local TX / idle placeholder */}
        <div
          className={displaySpeaker ? 'sov-chip sov-chip--speaker' : 'sov-chip'}
          style={{
            opacity: speakerFading ? 0 : 1,
            // CSS handles the 2s fade-out when speakerFading flips to true
            transitionProperty: speakerFading ? 'opacity' : 'all',
            transitionDuration: speakerFading ? '2s' : '0.15s',
          }}
        >
          {displaySpeaker ? (
            <>
              <span className="sov-chip-dot">◉</span>
              <span className="sov-chip-name">{displaySpeaker}</span>
            </>
          ) : localSpeaking ? (
            <>
              <span className="sov-chip-dot sov-tx-dot">◉</span>
              <span className="sov-tx">TX</span>
            </>
          ) : (
            <span className="sov-idle">——</span>
          )}
        </div>

        {/* Passthrough indicator — only visible when forced passthrough is active */}
        {passthrough && (
          <span
            className="sov-pass"
            title="Overlay is fully passthrough — all clicks go to the game"
          >
            PASS
          </span>
        )}

        {/* Drag grip — dedicated reposition handle, always draggable. Sits on the
            right beside the controls rather than at the far left edge, where a
            drag that starts near the screen edge tends to trigger Windows Snap. */}
        <div
          className="sov-grip"
          style={{ WebkitAppRegion: 'drag' }}
          title="Drag to reposition"
        >
          ⠿
        </div>

        {/* Scale cycle button */}
        <button
          type="button"
          onClick={handleScaleCycle}
          className="sov-btn sov-hdr-btn sov-scale-btn"
          style={{ WebkitAppRegion: 'no-drag' }}
          title={`Overlay scale: ${scale}× (click to cycle)`}
        >
          {Math.round(scale * 100)}%
        </button>

        {/* Exit */}
        <button
          type="button"
          onClick={handleExit}
          className="sov-btn sov-hdr-btn sov-exit-btn"
          style={{ WebkitAppRegion: 'no-drag' }}
          title="Exit overlay"
        >
          ✕
        </button>
      </div>

      {/* ── Stream picker (shown when header channel button clicked) ──
          Height is set explicitly from the same constants as the window size. */}
      {showPicker && (
        <div
          className="sov-picker"
          style={{
            height: pickerH,
            padding: PICKER_PAD,
            gap: PICKER_GAP,
            WebkitAppRegion: 'no-drag',
          }}
        >
          <button
            type="button"
            onClick={() => { handleStreamSelect(null); setShowPicker(false); }}
            className="sov-btn sov-pick-row"
            style={{ height: PICKER_ITEM_H }}
            aria-current={!data.watchTarget ? 'true' : undefined}
          >
            <span className="sov-pick-icon">—</span>
            <span className="sov-pick-label">No stream</span>
          </button>
          {activeSharers?.map((cs) => {
            const selected = data.watchTarget === cs;
            return (
              <button
                type="button"
                key={cs}
                onClick={() => { handleStreamSelect(cs); setShowPicker(false); }}
                className="sov-btn sov-pick-row"
                style={{ height: PICKER_ITEM_H }}
                aria-current={selected ? 'true' : undefined}
                title={cs}
              >
                <span className="sov-pick-icon">▶</span>
                <span className="sov-pick-label">{cs}</span>
                {selected && <span className="sov-pick-trailing">Watching</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Frequency bar: under the main bar, above the stream. Always mounted
          at a fixed height (0 when silent) so the stream is only offset. ── */}
      <FreqBar chips={freqChips} height={freqBarH} />

      {/* ── Stream preview (16:9, scales with the overlay) ──
          Always mounted (never conditionally rendered on data.watchTarget) so
          remoteCanvasRef stays live. Self-view NAL frames start flowing as soon
          as capture_start fires on the main window, which can arrive before the
          overlay-stream-select round trip lands and updates data.watchTarget —
          if the canvas weren't mounted yet, the decoder would decode straight
          into a null ref and silently drop the frame (black screen despite a
          real keyframe having been captured/encoded). Visibility is toggled
          with display/size instead so no frame is ever draw-dropped. */}
      <div
        className={data.watchTarget ? 'sov-video sov-video-divider' : 'sov-video'}
        style={{
          width: data.watchTarget ? overlayW : 0,
          height: data.watchTarget ? videoH : 0,
        }}
      >
        {/* Stream preview — always decoded via VideoDecoder (self + remote same path) */}
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <canvas
            ref={remoteCanvasRef}
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
          />
          {videoStatus && (
            <div className="sov-video-status-wrap">
              <span className="sov-video-status">{videoStatus}</span>
            </div>
          )}
        </div>

        {/* Stop-watching button (bottom-right corner of preview) */}
        {data.watchTarget && (
          <button
            type="button"
            onClick={() => { handleStreamSelect(null); setShowPicker(false); }}
            className="sov-btn sov-stop-btn"
            style={{ WebkitAppRegion: 'no-drag' }}
            title="Stop watching"
          >
            <span aria-hidden="true">✕</span> Stop
          </button>
        )}
      </div>

      {/* Whose stream this is, on a solid bar under the video (not over it) so
          it reads at a glance whatever the stream shows. */}
      {data.watchTarget && (
        <div
          title={data.watchTarget}
          style={{
            width: overlayW,
            height: NAME_H,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 10px',
            boxSizing: 'border-box',
            background: 'rgba(4, 10, 18, 0.94)',
            borderTop: '1px solid rgba(103, 218, 245, 0.35)',
            color: '#ffffff',
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444', flexShrink: 0 }} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {data.watchTarget === userCallsign ? `${data.watchTarget} (you)` : data.watchTarget}
          </span>
          {data.watchTarget !== userCallsign && data.shareAudio?.sharers?.includes(data.watchTarget) && (
            <span
              aria-label="This stream has audio"
              title={passthrough ? 'Stream has audio — leave passthrough to adjust the volume' : 'Stream has audio'}
              style={{ marginLeft: 'auto', display: 'flex', flexShrink: 0, color: data.shareAudio.prefs?.[data.watchTarget]?.muted ? '#f87171' : '#67daf5' }}
            >
              {data.shareAudio.prefs?.[data.watchTarget]?.muted ? <VolumeX size={13} aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
            </span>
          )}
        </div>
      )}

      {/* Stream volume, under the stream: only while the overlay is
          interactive (passthrough off), since in passthrough it can't be used. */}
      {showAudioRow && (
        <div
          style={{
            width: overlayW,
            height: AUDIO_H,
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            boxSizing: 'border-box',
            background: 'rgba(4, 10, 18, 0.94)',
            borderTop: '1px solid rgba(103, 218, 245, 0.15)',
            WebkitAppRegion: 'no-drag',
          }}
        >
          <ShareAudioControls callsign={data.watchTarget} pref={data.shareAudio.prefs?.[data.watchTarget]} />
        </div>
      )}

      {/* PM: DM toasts, under the stream (or the header when nothing is
          watched). Newest on top. Height = toastAreaHeight(), matched by the
          window size above. Privacy: this window is excluded from screen
          capture (WDA_EXCLUDEFROMCAPTURE), so DM text here doesn't leak into
          a share. TODO(stream-safe mode): a future stream-safe mode must hide
          these toasts entirely. */}
      {dmToasts.length > 0 && (
        <div
          aria-live="polite"
          aria-label="Direct messages"
          style={{
            width: overlayW, height: toastH, boxSizing: 'border-box', padding: TOAST_AREA_PAD,
            display: 'flex', flexDirection: 'column', gap: TOAST_GAP, overflow: 'hidden',
            // No border here: it would eat into the exact height the window is sized to.
            background: 'rgba(4, 10, 18, 0.94)',
            WebkitAppRegion: 'no-drag',
          }}
        >
          {dmToasts.map((t) => (
            <DmToast
              key={t.id}
              toast={t}
              interactive={interactive}
              open={replyOpenId === t.id}
              onToggle={() => setReplyOpenId((cur) => (cur === t.id ? null : t.id))}
              onCloseReply={() => setReplyOpenId(null)}
              onDismiss={() => { setDmToasts((s) => s.filter((x) => x.id !== t.id)); setReplyOpenId((cur) => (cur === t.id ? null : cur)); }}
              onSend={(text) => sendDmReply(t, text)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
