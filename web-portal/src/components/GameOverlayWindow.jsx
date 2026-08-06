import React, { useState, useEffect, useRef } from 'react';

/**
 * GameOverlayWindow — rendered in the second Tauri window (specter-overlay).
 * Receives voice state from the main window via Tauri events and displays a
 * minimal always-on-top HUD.  The window is transparent with no decorations.
 *
 * Layout:
 *  ┌─[channel/freq name ▾]────────[active speaker]──[✕]─┐
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
const OVERLAY_MAX_DECODE_QUEUE = 2;

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
  const [scale, setScale] = useState(() => {
    const saved = parseFloat(localStorage.getItem(SCALE_KEY));
    return SCALE_STEPS.includes(saved) ? saved : 1.0;
  });

  const overlayRef = useRef(null);
  const remoteCanvasRef = useRef(null);      // canvas for remote stream (own VideoDecoder)
  const remoteDecoderRef = useRef(null);     // VideoDecoder instance for remote stream

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
  // Compute activeSpeaker from current data each render (200ms tick keeps it fresh).
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

    // Inject TX pulse animation
    const style = document.createElement('style');
    style.textContent = `@keyframes specter-pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }`;
    document.head.appendChild(style);

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

    const bind = async () => {
      for (let i = 0; i < 120 && !cancelled; i += 1) {
        try {
          const { listen } = await import('@tauri-apps/api/event');

          const headerP = listen('overlay-video-header', (event) => {
        const { codec, width, height } = event.payload;
        if (remoteDecoderRef.current && remoteDecoderRef.current.state !== 'closed') {
          try { remoteDecoderRef.current.close(); } catch {}
        }
        decoderSyncedRef.current = false; // wait for next key frame before decoding
        if (typeof VideoDecoder === 'undefined') return;
        const dec = new VideoDecoder({
          output: (frame) => {
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
          },
          error: (e) => {
            console.error('[overlay decoder]', e);
            // On any decode error the decoder is unusable. Reset and wait for the
            // next live keyframe — the CommLink relay sends header+keyframe atomically
            // on every keyframe, so the decoder self-heals within ≤2s.
            // DO NOT re-emit overlay-ready here: it triggers a GOP seed that races
            // with the live relay's queued microtasks, causing more decode errors
            // and an infinite recovery loop.
            try { if (dec.state !== 'closed') dec.close(); } catch {}
            remoteDecoderRef.current = null;
            decoderSyncedRef.current = false;
          },
        });
        try {
          dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
          remoteDecoderRef.current = dec;
        } catch(e) {
          console.error('[overlay] decoder configure failed', e);
        }
      });

          const nalP = listen('overlay-video-nal', (event) => {
        const dec = remoteDecoderRef.current;
        if (!dec || dec.state === 'closed') return;
        const { data: b64, type, timestamp_us } = event.payload;
        // Key-frame gate: VideoDecoder must start from a key frame after configure.
        if (type === 'key') decoderSyncedRef.current = true;
        if (!decoderSyncedRef.current) return;
        // Decoder already backed up — drop this (and subsequent delta frames)
        // until the next keyframe rather than growing the lag further.
        if (type !== 'key' && dec.decodeQueueSize > OVERLAY_MAX_DECODE_QUEUE) {
          decoderSyncedRef.current = false;
          return;
        }
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        try {
          dec.decode(new EncodedVideoChunk({ type, timestamp: timestamp_us, data: bytes }));
        } catch(e) {
          console.warn('[overlay] decode error', e);
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

  // ── Fixed window size: 480 wide, height depends on whether stream is shown ──
  // Width is fixed at 384 (480 × 0.8). Height: 32px (header only) or 248px (header + 216px stream).
  // Picker open adds extra height for the stream list.
  const OVERLAY_W = 384;
  const HEADER_H = 32;
  const STREAM_H = 216; // 384 × (9/16)
  const PICKER_ITEM_H = 21;
  const PICKER_PAD = 10;
  const pickerCount = (data.activeSharers?.length || 0) + 1; // +1 for NONE option

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
        const { LogicalSize } = await import('@tauri-apps/api/dpi');
        // Header and picker rows stay at natural height; only the video area scales.
        const videoH = data.watchTarget ? Math.round(STREAM_H * scale) : 0;
        const pickerH = (showPicker && pickerCount > 0) ? pickerCount * PICKER_ITEM_H + PICKER_PAD : 0;
        const totalH = HEADER_H + videoH + pickerH;
        console.log('[overlay] setSize', Math.round(OVERLAY_W * scale), 'x', totalH, 'watchTarget:', data.watchTarget);
        await getWin().setSize(new LogicalSize(Math.round(OVERLAY_W * scale), totalH));
      } catch(e) { console.error('[overlay] setSize failed:', e); }
    };
    const t = setTimeout(resize, 30);
    return () => clearTimeout(t);
  }, [data.watchTarget, showPicker, pickerCount, scale]);

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
    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('specter://overlay-passthrough', async () => {
        const next = !passthroughRef.current;
        passthroughRef.current = next;
        setPassthrough(next);
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().setIgnoreCursorEvents(next);
          if (next) setShowPicker(false); // close picker when going passthrough
        } catch {}
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // ── Tick every 200 ms so stale-speaker check stays live ───────────────
  // Pauses automatically when the overlay window is hidden to avoid burning CPU
  // in the background WebView2 process when the overlay is not on screen.
  const [, setTick] = useState(0);
  useEffect(() => {
    let id = null;
    const start = () => { if (!id) id = setInterval(() => setTick((t) => t + 1), 200); };
    const stop  = () => { if (id) { clearInterval(id); id = null; } };
    if (document.visibilityState === 'visible') start();
    const onVisibility = () => document.visibilityState === 'visible' ? start() : stop();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

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
  };

  const { voiceRoster, localSpeaking, activeSharers, remoteLevels, userCallsign, watchTarget, voiceChannelName } = data;

  const handleStreamSelect = async (callsign) => {
    if (!window.__TAURI_INTERNALS__) return;
    const { emit } = await import('@tauri-apps/api/event');
    emit('overlay-stream-select', { callsign: callsign || null });
  };

  // Active remote speaker: only show others, not self (self gets a TX chip instead)
  // activeSpeaker is already computed above for the fade effect.
  // displaySpeaker + speakerFading are used for rendering (2s fade-out).

  // Fully OPAQUE background. On Windows transparent Tauri windows, semi-transparent
  // (alpha < 1) fills can fail to composite and render invisible — leaving only the
  // 1px border visible. A solid fill composites reliably regardless of the
  // transparent window surface beneath it.
  const pill = {
    // Fully OPAQUE background — do not add alpha or backdropFilter here (this
    // transparent WebView2 window can fail to composite semi-transparent fills
    // on Windows; blur would also blur the game behind the HUD).
    // Border/shadow mirror WarRoom.jsx's GLASS_PANEL glow language at a lighter
    // radius, to match the wallet/ops look without the blur.
    background: '#030a13',
    border: '1px solid rgba(56,189,248,0.35)',
    boxShadow: 'inset 0 1px 0 rgba(34,211,238,0.06), 0 0 0 1px rgba(34,211,238,0.16), 0 0 18px rgba(34,211,238,0.22)',
  };

  // ── Shared style for stream picker list items ──
  const pickerItemStyle = {
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 10,
    fontFamily: 'monospace',
    letterSpacing: '0.06em',
    borderRadius: 3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    WebkitAppRegion: 'no-drag',
  };

  return (
    <div
      ref={overlayRef}
      className="font-mono select-none"
      style={{
        width: Math.round(OVERLAY_W * scale),
        // Keep root opaque to avoid WebView2 transparent-on-transparent compositor dropouts.
        background: '#030a13',
        WebkitAppRegion: 'drag',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 6,
        fontFamily: 'monospace',
        userSelect: 'none',
      }}
    >
      {/* ── Header bar: [channel ▾] ── [speaker chip] ── [TX] ── [✕] ── */}
      <div
        style={{
          ...pill,
          display: 'flex',
          alignItems: 'center',
          height: 32,
          padding: '0 8px',
          gap: 6,
          borderRadius: (showPicker || data.watchTarget) ? '6px 6px 0 0' : 6,
        }}
      >
        {/* Blue zone: channel / freq name — click to open stream picker */}
        <button
          onClick={() => setShowPicker((v) => !v)}
          style={{
            flex: 1,
            WebkitAppRegion: 'no-drag',
            background: 'transparent',
            border: 'none',
            color: '#22d3ee',
            fontSize: 11,
            fontFamily: 'monospace',
            letterSpacing: '0.06em',
            textAlign: 'left',
            cursor: 'pointer',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: 0,
          }}
          title="Click to select stream"
        >
          <span style={{ color: '#0e7490', fontSize: 9, flexShrink: 0 }}>◈</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {voiceChannelName || 'NO CHANNEL'}
          </span>
          {activeSharers?.length > 0 && (
            <span style={{ color: '#475569', fontSize: 9, flexShrink: 0, marginLeft: 2 }}>
              {showPicker ? '▲' : '▼'}
            </span>
          )}
        </button>

        {/* Yellow zone: active remote speaker chip (hidden when no speaker) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 8px',
            background: displaySpeaker ? 'rgba(34,197,94,0.08)' : 'transparent',
            border: displaySpeaker ? '1px solid rgba(34,197,94,0.3)' : '1px solid transparent',
            borderRadius: 20,
            flexShrink: 0,
            minWidth: 80,
            transition: 'all 0.15s',
            opacity: speakerFading ? 0 : 1,
            // CSS handles the 2s fade-out when speakerFading flips to true
            transitionProperty: speakerFading ? 'opacity' : 'all',
            transitionDuration: speakerFading ? '2s' : '0.15s',
          }}
        >
          {displaySpeaker ? (
            <>
              <span style={{ fontSize: 7, color: '#22c55e', flexShrink: 0 }}>◉</span>
              <span
                style={{
                  fontSize: 10,
                  color: '#22c55e',
                  fontFamily: 'monospace',
                  letterSpacing: '0.04em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 120,
                }}
              >
                {displaySpeaker}
              </span>
            </>
          ) : localSpeaking ? (
            <>
              <span
                style={{
                  fontSize: 7,
                  color: '#22d3ee',
                  flexShrink: 0,
                  animation: 'specter-pulse 0.8s ease-in-out infinite',
                }}
              >
                ◉
              </span>
              <span style={{ fontSize: 9, color: '#22d3ee', letterSpacing: '0.12em' }}>TX</span>
            </>
          ) : (
            <span style={{ fontSize: 9, color: '#1e3a4a', letterSpacing: '0.1em' }}>——</span>
          )}
        </div>

        {/* Passthrough indicator — only visible when forced passthrough is active */}
        {passthrough && (
          <span
            style={{
              fontSize: 9,
              color: '#f59e0b',
              fontFamily: 'monospace',
              letterSpacing: '0.08em',
              flexShrink: 0,
              padding: '1px 5px',
              border: '1px solid rgba(245,158,11,0.4)',
              borderRadius: 3,
              background: 'rgba(245,158,11,0.08)',
            }}
            title="Overlay is fully passthrough — all clicks go to the game"
          >
            PASS
          </span>
        )}

        {/* Scale cycle button */}
        <button
          onClick={handleScaleCycle}
          style={{
            WebkitAppRegion: 'no-drag',
            background: 'transparent',
            border: '1px solid transparent',
            color: '#475569',
            fontSize: 10,
            cursor: 'pointer',
            padding: '2px 4px',
            borderRadius: 4,
            flexShrink: 0,
            lineHeight: 1,
            fontFamily: 'monospace',
            letterSpacing: '0.04em',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#22d3ee';
            e.currentTarget.style.borderColor = 'rgba(34,211,238,0.25)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = '#475569';
            e.currentTarget.style.borderColor = 'transparent';
          }}
          title={`Overlay scale: ${scale}× (click to cycle)`}
        >
          {Math.round(scale * 100)}%
        </button>

        {/* Red X: exit */}
        <button
          onClick={handleExit}
          style={{
            WebkitAppRegion: 'no-drag',
            background: 'transparent',
            border: '1px solid transparent',
            color: '#475569',
            fontSize: 13,
            cursor: 'pointer',
            padding: '2px 5px',
            borderRadius: 4,
            flexShrink: 0,
            lineHeight: 1,
            fontFamily: 'monospace',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = '#ef4444';
            e.currentTarget.style.borderColor = 'rgba(239,68,68,0.35)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = '#475569';
            e.currentTarget.style.borderColor = 'transparent';
          }}
          title="Exit overlay"
        >
          ✕
        </button>
      </div>

      {/* ── Stream picker popup (shown when header channel button clicked) ── */}
      {showPicker && (
        <div
          style={{
            ...pill,
            borderTop: 'none',
            borderRadius: data.watchTarget ? 0 : '0 0 6px 6px',
            padding: '6px 4px',
            WebkitAppRegion: 'no-drag',
          }}
        >
          <div
            onClick={() => { handleStreamSelect(null); setShowPicker(false); }}
            style={{
              ...pickerItemStyle,
              color: !data.watchTarget ? '#22d3ee' : '#475569',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(8,145,178,0.1)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            — NONE —
          </div>
          {activeSharers?.map((cs) => (
            <div
              key={cs}
              onClick={() => { handleStreamSelect(cs); setShowPicker(false); }}
              style={{
                ...pickerItemStyle,
                color: data.watchTarget === cs ? '#22d3ee' : '#94a3b8',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(8,145,178,0.1)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ color: data.watchTarget === cs ? '#22d3ee' : 'transparent', fontSize: 8 }}>▶</span>
              {cs}
            </div>
          ))}
        </div>
      )}

      {/* ── Stream preview (480 × 270 — 16:9) ──
          Always mounted (never conditionally rendered on data.watchTarget) so
          remoteCanvasRef stays live. Self-view NAL frames start flowing as soon
          as capture_start fires on the main window, which can arrive before the
          overlay-stream-select round trip lands and updates data.watchTarget —
          if the canvas weren't mounted yet, the decoder would decode straight
          into a null ref and silently drop the frame (black screen despite a
          real keyframe having been captured/encoded). Visibility is toggled
          with display/size instead so no frame is ever draw-dropped. */}
      <div
        style={{
          ...pill,
          borderTop: 'none',
          borderRadius: '0 0 6px 6px',
          overflow: 'hidden',
          position: 'relative',
          width: data.watchTarget ? Math.round(OVERLAY_W * scale) : 0,
          height: data.watchTarget ? Math.round(STREAM_H * scale) : 0,
          border: data.watchTarget ? pill.border : 'none',
          boxShadow: data.watchTarget ? pill.boxShadow : 'none',
          flexShrink: 0,
        }}
      >
        {/* Stream preview — always decoded via VideoDecoder (self + remote same path) */}
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <canvas
            ref={remoteCanvasRef}
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
          />
          {videoStatus && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 9, color: '#f87171', letterSpacing: '0.1em', textAlign: 'center', lineHeight: 1.4 }}>
                {videoStatus}
              </span>
            </div>
          )}
        </div>

        {/* Stop-watching button (bottom-right corner of preview) */}
        {data.watchTarget && (
          <button
            onClick={() => { handleStreamSelect(null); setShowPicker(false); }}
            style={{
              position: 'absolute',
              bottom: 6,
              right: 6,
              fontSize: 8,
              color: '#ef4444',
              background: 'rgba(0,0,0,0.65)',
              border: '1px solid rgba(239,68,68,0.4)',
              borderRadius: 3,
              padding: '2px 6px',
              cursor: 'pointer',
              WebkitAppRegion: 'no-drag',
              letterSpacing: '0.1em',
              fontFamily: 'monospace',
            }}
            title="Stop watching"
          >
            ✕ STOP
          </button>
        )}
      </div>
    </div>
  );
}

