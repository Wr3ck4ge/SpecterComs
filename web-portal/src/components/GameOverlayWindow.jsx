import React, { useState, useEffect, useRef } from 'react';

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

  // ── Window size is computed here and pushed via setSize ──
  // Width: 384 × scale. Height: header + (picker, when open) + (video, when watching).
  // Header and picker stay at natural size at every scale; only width + video scale.
  // These constants are also applied as explicit element heights below (with
  // box-sizing: border-box in overlay.css), so the DOM and the window can't drift.
  const OVERLAY_W = 384;
  const HEADER_H = 36;
  const STREAM_H = 216; // 384 × (9/16); includes its 1px top divider
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
        const videoH = data.watchTarget ? Math.round(STREAM_H * scale) : 0;
        const totalH = HEADER_H + videoH + (showPicker ? pickerH : 0);
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
  }, [data.watchTarget, showPicker, pickerH, scale]);

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
      }).then(fn => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
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
      <div className="sov-header" style={{ height: HEADER_H }}>
        {/* Channel / freq name — click to open stream picker */}
        <button
          type="button"
          onClick={() => setShowPicker((v) => !v)}
          className="sov-btn sov-channel"
          style={{ WebkitAppRegion: 'no-drag' }}
          title="Click to select stream"
        >
          <span className="sov-channel-icon">◈</span>
          <span className="sov-channel-name">{voiceChannelName || 'No channel'}</span>
          {activeSharers?.length > 0 && (
            <span className="sov-caret">{showPicker ? '▲' : '▼'}</span>
          )}
        </button>

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
    </div>
  );
}
