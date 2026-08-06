import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { BILLING_UI_ENABLED } from './BillingPanel';
import { GAME_OPTIONS, GAME_MODULES } from '../games';

const isTauri = Boolean(window.__TAURI__);

// ── Diagnostics submit button ────────────────────────────────────────────────
// Bundles capture perf stats + all client-side diagnostic logs (setup errors,
// capture errors, capture breadcrumbs, capture debug log) and sends them to the
// server tagged with the user's callsign (attached server-side from the auth
// token — see api.submitDiagnostics). Lets support correlate a specific user's
// report against server-side relay logs without walking them through finding
// log files on their machine. Always available (not gated to an active share)
// since subscribe/overlay failures are often on the viewing side, not the
// sharing side.
function DiagnosticsButton({ appVersion }) {
  const [status, setStatus] = useState('idle'); // idle | sending | ok | err
  useEffect(() => {
    if (status !== 'ok' && status !== 'err') return;
    const t = setTimeout(() => setStatus('idle'), 3000);
    return () => clearTimeout(t);
  }, [status]);

  const submit = async () => {
    setStatus('sending');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const safeInvoke = async (cmd) => {
        try { return await invoke(cmd); } catch (e) { return null; }
      };
      const [perf, captureErrors, breadcrumbs, setupErrors, captureDebug, appLog] = await Promise.all([
        safeInvoke('capture_get_perf_report'),
        safeInvoke('capture_get_errors'),
        safeInvoke('capture_get_breadcrumbs'),
        safeInvoke('get_setup_errors'),
        safeInvoke('get_capture_debug_log'),
        safeInvoke('get_app_log'),
      ]);
      const { error } = await api.submitDiagnostics({
        appVersion,
        perf,
        captureErrors,
        breadcrumbs,
        setupErrors,
        captureDebug,
        appLog,
      });
      setStatus(error ? 'err' : 'ok');
    } catch (e) {
      console.error('[DiagnosticsButton] submit failed:', e);
      setStatus('err');
    }
  };

  const label = { idle: 'Submit Diagnostics', sending: 'Sending…', ok: 'Sent ✓', err: 'Failed ✗' }[status];
  return (
    <button
      onClick={submit}
      disabled={status === 'sending'}
      className="text-specter-text-muted text-xs font-mono opacity-70 hover:opacity-100 hover:text-specter-primary-cyan disabled:opacity-40 uppercase tracking-wider"
    >
      {label}
    </button>
  );
}

const Button = ({ children, variant = 'primary', onClick, full = false, disabled = false }) => {
  const base = `${full ? 'w-full' : ''} px-4 py-1 rounded text-xs font-bold tracking-wider transition-all duration-200 uppercase font-mono`;
  const variants = {
    primary:   'bg-specter-primary-cyan text-specter-bg-surface hover:bg-specter-primary-neon hover:shadow-[0_0_10px_rgba(6,182,212,0.3)]',
    secondary: 'bg-specter-bg-panel text-specter-text-muted hover:text-specter-text-main border border-specter-bg-panel hover:border-specter-primary-dim',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
      {children}
    </button>
  );
};

const TIMEZONE_FALLBACK = ['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','Europe/London','Europe/Paris','Europe/Berlin','Asia/Tokyo','Asia/Shanghai','Asia/Kolkata','Australia/Sydney','Pacific/Auckland'];
function getSupportedTimezones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch (e) { return TIMEZONE_FALLBACK; }
}

const SettingsUI = ({ onClose, user, onOpenShip, micCaptureActive = false }) => {
  const [activeTab, setActiveTab] = useState('audio');

  // Games the user has selected on their profile (see games tab below) —
  // gates per-game modules (e.g. Hangar) from the registry in games.js.
  const [myGames, setMyGames] = useState([]);
  const [gamesLoading, setGamesLoading] = useState(true);
  useEffect(() => {
    api.getMyGames().then(({ data }) => {
      setMyGames(data?.games || []);
      setGamesLoading(false);
    });
  }, []);
  const moduleTabs = myGames.flatMap(g => GAME_MODULES[g] || []);
  const toggleMyGame = (game) => {
    const next = myGames.includes(game) ? myGames.filter(g => g !== game) : [...myGames, game];
    setMyGames(next);
    api.updateMyGames(next);
  };

  const STATIC_TABS = ['audio', 'comms', 'profile', 'games', ...(BILLING_UI_ENABLED ? ['billing'] : [])];
  // If the active tab is a module tab whose game just got deselected, fall
  // back rather than rendering a tab that's no longer in the list.
  useEffect(() => {
    if (gamesLoading) return;
    if (!STATIC_TABS.includes(activeTab) && !moduleTabs.some(m => m.key === activeTab)) {
      setActiveTab('audio');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gamesLoading, myGames]);

  // Personal billing transaction history (billing tab)
  const [transactions, setTransactions] = useState(null);
  const [txError, setTxError] = useState(null);
  useEffect(() => {
    if (activeTab !== 'billing') return;
    api.getMyTransactions().then(({ data, error }) => {
      if (data) setTransactions(data.transactions || []);
      else setTxError(error || 'Failed to load transactions');
    });
  }, [activeTab]);

  const [devices, setDevices] = useState({ audioinput: [], audiooutput: [] });
  const [selectedInput, setSelectedInput] = useState(localStorage.getItem('specter_audio_in') || 'default');
  const [selectedOutput, setSelectedOutput] = useState(localStorage.getItem('specter_audio_out') || 'default');
  const [gain, setGain] = useState(localStorage.getItem('specter_audio_gain') || '1.0');
  const [comsFilterEnabled, setComsFilterEnabled] = useState(localStorage.getItem('specter_audio_coms_filter') === 'true');
  const [audioPermission, setAudioPermission] = useState(isTauri ? 'checking' : 'unknown');
  const [audioSaved, setAudioSaved] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  // Comms settings
  const [voiceMode, setVoiceMode] = useState(localStorage.getItem('specter_voice_mode') || 'voice-activated'); // 'push-to-talk' | 'voice-activated'
  const [pttKey, setPttKey] = useState(localStorage.getItem('specter_ptt_key') || '');
  const [channelToggleKey, setChannelToggleKey] = useState(localStorage.getItem('specter_channel_toggle_key') || '');
  const [streamNextKey, setStreamNextKey] = useState(localStorage.getItem('specter_stream_next_key') || '');
  const [overlayPassthroughKey, setOverlayPassthroughKey] = useState(localStorage.getItem('specter_overlay_passthrough_key') || '');
  const [overlayCorner, setOverlayCorner] = useState(localStorage.getItem('specter_overlay_corner') || 'top-right'); // 'top-right' | 'top-left'
  const [overlaySafeMode, setOverlaySafeMode] = useState(localStorage.getItem('specter_overlay_safe_mode') === '1');
  const [closeBehavior, setCloseBehavior] = useState(localStorage.getItem('specter_close_behavior') || 'quit'); // 'quit' | 'tray_resident' | 'tray_light'
  // Applies immediately on click rather than waiting for the distant "Save
  // Comms" button — unlike the voice/overlay settings below it, this one
  // reads as self-contained (a row of 3 buttons), so requiring a separate
  // save step was a real trap: picking "Close To Tray" without also
  // remembering to click Save left Rust's CloseBehaviorState on its "quit"
  // default, so the X button silently kept fully exiting instead.
  const applyCloseBehavior = (mode) => {
    setCloseBehavior(mode);
    localStorage.setItem('specter_close_behavior', mode);
    if (isTauri) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('set_close_behavior', { mode }).catch(() => {});
      });
    }
  };
  const [recordingKey, setRecordingKey] = useState(null); // 'ptt' | 'channelToggle' | 'streamNext' | 'overlayPassthrough' | null
  const [commsSaved, setCommsSaved] = useState(false);

  // Mic activation threshold (VAD) + live test state
  const [vadThreshold, setVadThreshold] = useState(() => parseInt(localStorage.getItem('specter_vad_threshold') || '15', 10));
  const [vadTestActive, setVadTestActive] = useState(false);
  const [vadTestLevel, setVadTestLevel] = useState(0);
  const vadTestRafRef = useRef(null);
  const vadTestStreamRef = useRef(null);
  const vadTestAnalyserRef = useRef(null);
  const vadTestLevelUnlistenRef = useRef(null);
  const vadTestFrameUnlistenRef = useRef(null);
  const vadTestLastLevelTsRef = useRef(0);
  // True only when the mic test itself called start_capture (i.e. no live channel
  // capture was already running to piggyback on) — gates whether turning the test
  // off is allowed to call stop_capture, so we never kill a real voice-channel mic.
  const vadTestOwnsCaptureRef = useRef(false);

  useEffect(() => {
    if (!isTauri) return;
    import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then(v => setAppVersion(v)).catch(() => {});
  }, []);

  const [timezone, setTimezone] = useState((user && user.timezone) ? user.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [profileImagePath, setProfileImagePath] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState(null);
  const [timezones] = useState(getSupportedTimezones);

  useEffect(() => {
    if (isTauri) {
      // Use the native specter-audio plugin for device enumeration in Tauri.
      import('@tauri-apps/api/core').then(({ invoke }) => {
        // Fetch input devices
        const inputsP = invoke('plugin:specter-audio|list_audio_devices').then(devices =>
          devices.map(d => ({ deviceId: d.id, label: d.name, kind: 'audioinput', is_default: d.is_default }))
        ).catch(err => { console.error('Native input device list failed:', err); return []; });

        // Fetch output devices
        const outputsP = invoke('plugin:specter-audio|list_output_devices').then(devices =>
          devices.map(d => ({ deviceId: d.id, label: d.name, kind: 'audiooutput', is_default: d.is_default }))
        ).catch(err => { console.error('Native output device list failed:', err); return []; });

        Promise.all([inputsP, outputsP]).then(([inputs, outputs]) => {
          setDevices({ audioinput: inputs, audiooutput: outputs });
          const defaultIn = inputs.find(d => d.is_default);
          if (defaultIn && selectedInput === 'default') {
            setSelectedInput(defaultIn.deviceId);
          }
          const defaultOut = outputs.find(d => d.is_default);
          if (defaultOut && selectedOutput === 'default') {
            setSelectedOutput(defaultOut.deviceId);
          }
          // If cpal returned no input devices Windows privacy may be blocking mic access.
          // Set 'unknown' so the "Grant Access" button appears and triggers the OS dialog.
          setAudioPermission(inputs.length > 0 ? 'granted' : 'unknown');
        });
      });
    } else {
      navigator.mediaDevices.enumerateDevices().then(devs => {
        const hasLabels = devs.some(d => d.kind === 'audioinput' && d.label);
        if (hasLabels) setAudioPermission('granted');
        setDevices({ audioinput: devs.filter(d => d.kind === 'audioinput'), audiooutput: devs.filter(d => d.kind === 'audiooutput') });
      }).catch(err => console.error('enumerateDevices:', err));
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'profile') return;
    api.getMyProfile().then(res => {
      if (res.data && res.data.user) {
        if (res.data.user.timezone) setTimezone(res.data.user.timezone);
        if (res.data.user.profile_image_path) setProfileImagePath(res.data.user.profile_image_path);
      }
    });
  }, [activeTab]);

  const requestAudioPermission = () => {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      stream.getTracks().forEach(t => t.stop());
      setAudioPermission('granted');
      navigator.mediaDevices.enumerateDevices().then(devs => {
        setDevices({ audioinput: devs.filter(d => d.kind === 'audioinput'), audiooutput: devs.filter(d => d.kind === 'audiooutput') });
      }).catch(err => console.error(err));
    }).catch(err => { console.error('mic denied:', err); setAudioPermission('denied'); });
  };

  const handleAudioSave = () => {
    localStorage.setItem('specter_audio_in', selectedInput);
    localStorage.setItem('specter_audio_out', selectedOutput);
    localStorage.setItem('specter_audio_gain', gain);
    localStorage.setItem('specter_audio_coms_filter', String(comsFilterEnabled));
    localStorage.setItem('specter_vad_threshold', String(vadThreshold));
    // Dispatch storage events so CommLink can react to changes mid-session
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_audio_in' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_audio_gain' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_audio_coms_filter' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_vad_threshold' }));
    setAudioSaved(true);
  };

  const handleProfileSave = async () => {
    setProfileError(null); setProfileSaved(false); setProfileLoading(true);
    const res = await api.updateProfile({ timezone, profile_image_path: profileImagePath });
    setProfileLoading(false);
    if (res.error) { setProfileError(res.error); return; }
    try {
      const stored = JSON.parse(localStorage.getItem('specter_user') || '{}');
      localStorage.setItem('specter_user', JSON.stringify({ ...stored, timezone, profile_image_path: profileImagePath }));
    } catch (e) { /* ignore */ }
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  };

  const handleBrowse = async () => {
    if (!isTauri) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: false, filters: [{ name: 'Images', extensions: ['png','jpg','jpeg','gif','webp'] }] });
      if (selected) setProfileImagePath(selected);
    } catch (err) { console.error('File picker:', err); }
  };

  // Hotkey recording
  useEffect(() => {
    if (!recordingKey) return;
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // If the key pressed is itself a modifier, wait — we want the non-modifier
      // key that completes the combo (e.g. Ctrl+A), not 'Ctrl' alone.
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Meta');
      const key = e.key;
      if (!['Control','Alt','Shift','Meta'].includes(key)) {
        parts.push(key.length === 1 ? key.toUpperCase() : key);
      }
      if (parts.length === 0) return;
      const combo = parts.join('+');
      if (recordingKey === 'ptt') setPttKey(combo);
      else if (recordingKey === 'channelToggle') setChannelToggleKey(combo);
      else if (recordingKey === 'streamNext') setStreamNextKey(combo);
      else if (recordingKey === 'overlayPassthrough') setOverlayPassthroughKey(combo);
      setRecordingKey(null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [recordingKey]);

  // Start/stop live mic test
  const vadTestUnlistenRef = useRef(null);
  useEffect(() => {
    const logNative = (message) => {
      if (!isTauri) return;
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('client_log', { msg: `[MicTest] ${message}` }))
        .catch(() => {});
    };

    if (!vadTestActive) {
      // Tauri path cleanup
      if (vadTestUnlistenRef.current) { vadTestUnlistenRef.current(); vadTestUnlistenRef.current = null; }
      if (vadTestLevelUnlistenRef.current) { vadTestLevelUnlistenRef.current(); vadTestLevelUnlistenRef.current = null; }
      if (vadTestFrameUnlistenRef.current) { vadTestFrameUnlistenRef.current(); vadTestFrameUnlistenRef.current = null; }
      if (isTauri) {
        if (vadTestOwnsCaptureRef.current) {
          logNative('deactivating mic test; issuing stop_capture');
          import('@tauri-apps/api/core').then(({ invoke }) => invoke('plugin:specter-audio|stop_capture', {}).catch(() => {}));
          vadTestOwnsCaptureRef.current = false;
        } else {
          logNative('deactivating mic test; leaving live channel capture running');
        }
      }
      // Browser path cleanup
      if (vadTestRafRef.current) { cancelAnimationFrame(vadTestRafRef.current); vadTestRafRef.current = null; }
      if (vadTestStreamRef.current) { vadTestStreamRef.current.getTracks().forEach(t => t.stop()); vadTestStreamRef.current = null; }
      vadTestAnalyserRef.current = null;
      setVadTestLevel(0);
      return;
    }

    if (isTauri) {
      // Native Tauri path: use cpal capture → specter://audio-frame events.
      // getUserMedia device IDs are browser GUIDs that don't match cpal device names, so we can't use it here.
      // If a real channel capture is already live, piggyback on it instead of
      // stopping/restarting cpal — doing that here would kill the user's actual
      // voice-channel mic (and never restart it, since CommLink assumes capture
      // stays running once connected).
      const reuseLiveCapture = micCaptureActive;

      Promise.all([
        import('@tauri-apps/api/core'),
        import('@tauri-apps/api/event'),
      ]).then(async ([{ invoke }, { listen }]) => {
        try {
          const deviceId = selectedInput && selectedInput !== 'default' ? selectedInput : null;

          if (reuseLiveCapture) {
            logNative('mic test reusing already-live channel capture (skipping stop/start_capture)');
            vadTestOwnsCaptureRef.current = false;
          } else {
            logNative(`starting mic test (deviceId=${deviceId || 'default'})`);
            // Ensure a clean restart so test mode works even if a previous capture
            // session exited unexpectedly.
            await invoke('plugin:specter-audio|stop_capture', {}).catch(() => {});
            try {
              await invoke('plugin:specter-audio|start_capture', { deviceId });
            } catch (startErr) {
              if (deviceId) {
                logNative(`start_capture failed for selected device; retrying default (${String(startErr)})`);
                await invoke('plugin:specter-audio|start_capture', { deviceId: null });
              } else {
                throw startErr;
              }
            }
            vadTestOwnsCaptureRef.current = true;
            logNative('start_capture succeeded; subscribing to audio-level/audio-frame');
          }

          const unlistenLevel = await listen('specter://audio-level', (event) => {
            const rms = event.payload?.rms ?? 0;
            vadTestLastLevelTsRef.current = Date.now();
            setVadTestLevel(Math.min(100, Math.round((rms / 500) * 100)));
          });

          // Fallback for environments where audio-level isn't emitted.
          const unlisten = await listen('specter://audio-frame', (event) => {
            if ((Date.now() - vadTestLastLevelTsRef.current) < 350) return;
            const { data } = event.payload;
            const opusBytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
            // Approximate amplitude from Opus frame size (larger = louder).
            const approxLevel = Math.min(100, Math.round((opusBytes.length / 150) * 100));
            setVadTestLevel(approxLevel);
          });
          vadTestLevelUnlistenRef.current = unlistenLevel;
          vadTestFrameUnlistenRef.current = unlisten;
          logNative('listeners attached successfully');
        } catch (err) {
          console.error('[MicTest] Native capture failed:', err);
          logNative(`native capture failed: ${String(err)}`);
          setVadTestActive(false);
        }
      });
      return () => {
        if (vadTestUnlistenRef.current) { vadTestUnlistenRef.current(); vadTestUnlistenRef.current = null; }
        if (vadTestLevelUnlistenRef.current) { vadTestLevelUnlistenRef.current(); vadTestLevelUnlistenRef.current = null; }
        if (vadTestFrameUnlistenRef.current) { vadTestFrameUnlistenRef.current(); vadTestFrameUnlistenRef.current = null; }
        if (vadTestOwnsCaptureRef.current) {
          logNative('cleanup: stop_capture on effect teardown');
          import('@tauri-apps/api/core').then(({ invoke }) => invoke('plugin:specter-audio|stop_capture', {}).catch(() => {}));
          vadTestOwnsCaptureRef.current = false;
        } else {
          logNative('cleanup: leaving live channel capture running (test only attached listeners)');
        }
      };
    }

    // Browser path
    let ctx, source;
    const micConstraint = selectedInput && selectedInput !== 'default'
      ? { audio: { deviceId: { exact: selectedInput } } }
      : { audio: true };
    navigator.mediaDevices.getUserMedia(micConstraint)
      .catch(() => navigator.mediaDevices.getUserMedia({ audio: true })) // fallback to default mic
      .then(stream => {
        vadTestStreamRef.current = stream;
        ctx = new AudioContext();
        source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.4;
        source.connect(analyser);
        vadTestAnalyserRef.current = analyser;
        const buf = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (!vadTestAnalyserRef.current) return;
          analyser.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) sum += buf[i];
          setVadTestLevel(sum / buf.length);
          vadTestRafRef.current = requestAnimationFrame(tick);
        };
        tick();
      }).catch(err => {
        console.error('[MicTest] getUserMedia failed:', err);
        setVadTestActive(false);
      });
    return () => {
      if (vadTestRafRef.current) { cancelAnimationFrame(vadTestRafRef.current); vadTestRafRef.current = null; }
      if (vadTestStreamRef.current) { vadTestStreamRef.current.getTracks().forEach(t => t.stop()); vadTestStreamRef.current = null; }
      vadTestAnalyserRef.current = null;
      if (ctx) ctx.close().catch(() => {});
    };
  }, [vadTestActive, selectedInput]);

  const handleCommsSave = () => {
    localStorage.setItem('specter_voice_mode', voiceMode);
    localStorage.setItem('specter_ptt_key', pttKey);
    localStorage.setItem('specter_channel_toggle_key', channelToggleKey);
    localStorage.setItem('specter_stream_next_key', streamNextKey);
    localStorage.setItem('specter_overlay_passthrough_key', overlayPassthroughKey);
    localStorage.setItem('specter_overlay_corner', overlayCorner);
    if (overlaySafeMode) {
      localStorage.setItem('specter_overlay_safe_mode', '1');
    } else {
      localStorage.removeItem('specter_overlay_safe_mode');
    }
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_ptt_key' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_channel_toggle_key' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_voice_mode' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_stream_next_key' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'specter_overlay_passthrough_key' }));
    setCommsSaved(true);
    setTimeout(() => setCommsSaved(false), 2500);
  };

  const tabOrder = ['audio', 'comms', 'profile', 'games', ...moduleTabs.map(m => m.key), ...(BILLING_UI_ENABLED ? ['billing'] : [])];

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full font-mono text-specter-text-main">
      <div className="flex justify-between items-center px-6 py-4 border-b border-specter-primary-dim flex-shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="secondary" onClick={onClose}>&larr; BACK</Button>
          <h2 className="text-xl text-specter-primary-cyan uppercase tracking-widest">[ SETTINGS ]</h2>
        </div>
        <div className="flex items-center gap-3">
          {appVersion && <span className="text-specter-text-muted text-xs font-mono opacity-60">v{appVersion}</span>}
          {isTauri && <DiagnosticsButton appVersion={appVersion} />}
        </div>
      </div>

      <div className="flex border-b border-specter-primary-dim flex-shrink-0 px-6 overflow-x-auto">
        {tabOrder.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors whitespace-nowrap ${activeTab === tab ? 'text-specter-primary-cyan border-b-2 border-specter-primary-cyan -mb-px' : 'text-specter-text-muted hover:text-specter-text-main'}`}>
            {tab}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6 max-w-2xl">
        {activeTab === 'audio' && (
          <div className="space-y-4">
            {audioPermission !== 'granted' && audioPermission !== 'checking' && (
              <div className={`border rounded px-3 py-3 text-xs font-mono space-y-2 ${audioPermission === 'denied' ? 'bg-red-950 border-red-700 text-red-300' : 'bg-yellow-950/40 border-yellow-700/60 text-yellow-300'}`}>
                {audioPermission === 'denied' ? (
                  <div>
                    <div className="font-bold uppercase">Microphone Access Denied</div>
                    <div className="opacity-80 mt-1">Allow microphone access in your OS settings, then reopen Settings.</div>
                  </div>
                ) : (
                  <div>
                    <div className="font-bold uppercase">Microphone Access Required</div>
                    <div className="opacity-80 mt-1">Grant access so device names can be detected.</div>
                    <button onClick={requestAudioPermission} className="mt-2 px-3 py-1.5 border border-yellow-600 text-yellow-300 rounded hover:bg-yellow-700/30 transition-colors uppercase text-xs">
                      Grant Microphone Access
                    </button>
                  </div>
                )}
              </div>
            )}
            <div>
              <label className="block text-xs text-specter-text-muted mb-1">Input Device (Microphone)</label>
              <select value={selectedInput} onChange={e => setSelectedInput(e.target.value)} className="w-full bg-black border border-specter-primary-dim text-xs p-2 focus:border-specter-primary-cyan outline-none">
                <option value="default">System Default Microphone</option>
                {devices.audioinput.filter(d => d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0,5)}...`}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-specter-text-muted mb-1">Output Device (Speakers)</label>
              <select value={selectedOutput} onChange={e => setSelectedOutput(e.target.value)} className="w-full bg-black border border-specter-primary-dim text-xs p-2 focus:border-specter-primary-cyan outline-none">
                <option value="default">System Default Speakers</option>
                {devices.audiooutput.filter(d => d.deviceId !== 'default').map(d => <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${d.deviceId.slice(0,5)}...`}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-specter-text-muted mb-1">Input Gain (Volume)</label>
              <div className="flex items-center gap-2">
                <input type="range" min="0.1" max="3.0" step="0.1" value={gain} onChange={e => setGain(e.target.value)} className="w-full accent-specter-primary-cyan" />
                <span className="text-xs text-specter-primary-neon">{parseFloat(gain).toFixed(1)}x</span>
              </div>
            </div>
            {/* Mic Activation Threshold */}
            <div className="pt-2 border-t border-specter-primary-dim/30">
              <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">Mic Activation Threshold</label>
              <span className="text-xs text-specter-text-muted opacity-60 block mb-2">Level at which your voice triggers activity detection. Lower = more sensitive. Default 15.</span>
              <div className="flex items-center gap-2 mb-2">
                <input type="range" min="1" max="80" step="1" value={vadThreshold} onChange={e => setVadThreshold(Number(e.target.value))} className="w-full accent-specter-primary-cyan" />
                <span className="text-xs text-specter-primary-neon w-8 text-right">{vadThreshold}</span>
              </div>
              {/* Live mic test */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setVadTestActive(v => !v)}
                  className={`px-3 py-1 border text-xs uppercase tracking-widest font-mono transition-colors flex-shrink-0 ${
                    vadTestActive
                      ? 'border-yellow-500 text-yellow-400 bg-yellow-900/20'
                      : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                  }`}
                >
                  {vadTestActive ? '◉ Testing' : '▶ Test Mic'}
                </button>
                {vadTestActive && (
                  <>
                    <div className="flex-1 relative h-4 bg-black border border-specter-primary-dim/40 rounded overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0"
                        style={{
                          width: `${Math.min(100, (vadTestLevel / 80) * 100)}%`,
                          background: vadTestLevel > vadThreshold ? 'rgba(34,197,94,0.7)' : 'rgba(8,145,178,0.5)',
                          transition: 'width 75ms linear, background 100ms',
                        }}
                      />
                      <div
                        className="absolute inset-y-0 w-px bg-yellow-400 opacity-80"
                        style={{ left: `${Math.min(99, (vadThreshold / 80) * 100)}%` }}
                      />
                    </div>
                    <span
                      className="text-xs font-mono flex-shrink-0"
                      style={{ color: vadTestLevel > vadThreshold ? '#22c55e' : '#475569', minWidth: 40 }}
                    >
                      {vadTestLevel > vadThreshold ? 'ACTIVE' : 'SILENT'}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-specter-primary-dim/30">
              <span className="text-xs text-specter-text-muted uppercase tracking-wider">Default Coms Filter Engine</span>
              <button onClick={() => setComsFilterEnabled(!comsFilterEnabled)} className={`px-3 py-1 border text-xs uppercase tracking-widest transition-colors font-mono ${comsFilterEnabled ? 'border-specter-primary-neon text-specter-primary-neon bg-specter-primary-neon/10' : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'}`}>
                {comsFilterEnabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <div className="mt-6 flex justify-end gap-3 items-center">
              {audioSaved && <span className="text-xs font-mono text-specter-state-success">Config saved.</span>}
              <Button onClick={handleAudioSave}>Save Config</Button>
            </div>
          </div>
        )}

        {activeTab === 'comms' && (
          <div className="space-y-4">
            {/* Voice Mode */}
            <div>
              <label className="block text-xs text-specter-text-muted mb-2 uppercase tracking-wider">Voice Mode</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setVoiceMode('voice-activated')}
                  className={`flex-1 px-3 py-2 border text-xs uppercase tracking-widest font-mono transition-colors ${
                    voiceMode === 'voice-activated'
                      ? 'border-specter-primary-neon text-specter-primary-neon bg-specter-primary-neon/10'
                      : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                  }`}
                >
                  Voice Activated
                </button>
                <button
                  onClick={() => setVoiceMode('push-to-talk')}
                  className={`flex-1 px-3 py-2 border text-xs uppercase tracking-widest font-mono transition-colors ${
                    voiceMode === 'push-to-talk'
                      ? 'border-specter-primary-neon text-specter-primary-neon bg-specter-primary-neon/10'
                      : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                  }`}
                >
                  Push to Talk
                </button>
              </div>
            </div>

            {/* PTT Key — only shown when push-to-talk */}
            {voiceMode === 'push-to-talk' && (
              <div>
                <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">Push-to-Talk Key</label>
                <div className="flex gap-2 items-center">
                  <div className="flex-1 bg-black border border-specter-primary-dim text-xs p-2 text-specter-text-main font-mono min-h-[32px] flex items-center">
                    {recordingKey === 'ptt' ? (
                      <span className="text-yellow-400 animate-pulse">Press a key...</span>
                    ) : pttKey ? (
                      <span>{pttKey}</span>
                    ) : (
                      <span className="text-specter-text-muted opacity-50">Not set</span>
                    )}
                  </div>
                  <button
                    onClick={() => setRecordingKey(recordingKey === 'ptt' ? null : 'ptt')}
                    className={`px-3 py-1.5 border text-xs uppercase tracking-widest font-mono transition-colors ${
                      recordingKey === 'ptt'
                        ? 'border-yellow-500 text-yellow-400 bg-yellow-900/20'
                        : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                    }`}
                  >
                    {recordingKey === 'ptt' ? 'Cancel' : 'Bind'}
                  </button>
                  {pttKey && (
                    <button
                      onClick={() => setPttKey('')}
                      className="px-2 py-1.5 border border-specter-primary-dim text-specter-text-muted hover:text-red-400 hover:border-red-700 text-xs font-mono transition-colors"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Channel Toggle Hotkey */}
            <div className="pt-2 border-t border-specter-primary-dim/30">
              <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">Frequency Cycle / Channel Toggle</label>
              <span className="text-xs text-specter-text-muted opacity-60 block mb-2">Cycles your active TX frequency during operations. Press to step through primary channel → frequencies → back to primary.</span>
              <div className="flex gap-2 items-center">
                <div className="flex-1 bg-black border border-specter-primary-dim text-xs p-2 text-specter-text-main font-mono min-h-[32px] flex items-center">
                  {recordingKey === 'channelToggle' ? (
                    <span className="text-yellow-400 animate-pulse">Press a key...</span>
                  ) : channelToggleKey ? (
                    <span>{channelToggleKey}</span>
                  ) : (
                    <span className="text-specter-text-muted opacity-50">Not set</span>
                  )}
                </div>
                <button
                  onClick={() => setRecordingKey(recordingKey === 'channelToggle' ? null : 'channelToggle')}
                  className={`px-3 py-1.5 border text-xs uppercase tracking-widest font-mono transition-colors ${
                    recordingKey === 'channelToggle'
                      ? 'border-yellow-500 text-yellow-400 bg-yellow-900/20'
                      : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                  }`}
                >
                  {recordingKey === 'channelToggle' ? 'Cancel' : 'Bind'}
                </button>
                {channelToggleKey && (
                  <button
                    onClick={() => setChannelToggleKey('')}
                    className="px-2 py-1.5 border border-specter-primary-dim text-specter-text-muted hover:text-red-400 hover:border-red-700 text-xs font-mono transition-colors"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {/* Stream Cycle Hotkey */}
            <div className="pt-2 border-t border-specter-primary-dim/30">
              <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">Cycle Active Stream</label>
              <span className="text-xs text-specter-text-muted opacity-60 block mb-2">Hotkey to cycle through active streams from the overlay or while the game is focused. Supports modifier keys (Ctrl, Alt, Shift).</span>
              <div className="flex gap-2 items-center">
                <div className="flex-1 bg-black border border-specter-primary-dim text-xs p-2 text-specter-text-main font-mono min-h-[32px] flex items-center">
                  {recordingKey === 'streamNext' ? (
                    <span className="text-yellow-400 animate-pulse">Press a key...</span>
                  ) : streamNextKey ? (
                    <span>{streamNextKey}</span>
                  ) : (
                    <span className="text-specter-text-muted opacity-50">Not set</span>
                  )}
                </div>
                <button
                  onClick={() => setRecordingKey(recordingKey === 'streamNext' ? null : 'streamNext')}
                  className={`px-3 py-1.5 border text-xs uppercase tracking-widest font-mono transition-colors ${
                    recordingKey === 'streamNext'
                      ? 'border-yellow-500 text-yellow-400 bg-yellow-900/20'
                      : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                  }`}
                >
                  {recordingKey === 'streamNext' ? 'Cancel' : 'Bind'}
                </button>
                {streamNextKey && (
                  <button
                    onClick={() => setStreamNextKey('')}
                    className="px-2 py-1.5 border border-specter-primary-dim text-specter-text-muted hover:text-red-400 hover:border-red-700 text-xs font-mono transition-colors"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {/* Overlay Passthrough Toggle Hotkey */}
            <div className="pt-2 border-t border-specter-primary-dim/30">
              <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">Overlay Passthrough Toggle</label>
              <span className="text-xs text-specter-text-muted opacity-60 block mb-2">
                Hotkey to force the overlay fully click-through so it cannot intercept any mouse input.
                Press again to restore interactivity. Supports modifier keys (Ctrl, Alt, Shift).
              </span>
              <div className="flex gap-2 items-center">
                <div className="flex-1 bg-black border border-specter-primary-dim text-xs p-2 text-specter-text-main font-mono min-h-[32px] flex items-center">
                  {recordingKey === 'overlayPassthrough' ? (
                    <span className="text-yellow-400 animate-pulse">Press a key...</span>
                  ) : overlayPassthroughKey ? (
                    <span>{overlayPassthroughKey}</span>
                  ) : (
                    <span className="text-specter-text-muted opacity-50">Not set</span>
                  )}
                </div>
                <button
                  onClick={() => setRecordingKey(recordingKey === 'overlayPassthrough' ? null : 'overlayPassthrough')}
                  className={`px-3 py-1.5 border text-xs uppercase tracking-widest font-mono transition-colors ${
                    recordingKey === 'overlayPassthrough'
                      ? 'border-yellow-500 text-yellow-400 bg-yellow-900/20'
                      : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                  }`}
                >
                  {recordingKey === 'overlayPassthrough' ? 'Cancel' : 'Bind'}
                </button>
                {overlayPassthroughKey && (
                  <button
                    onClick={() => setOverlayPassthroughKey('')}
                    className="px-2 py-1.5 border border-specter-primary-dim text-specter-text-muted hover:text-red-400 hover:border-red-700 text-xs font-mono transition-colors"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {/* Overlay Corner */}
            <div className="pt-2 border-t border-specter-primary-dim/30">
              <label className="block text-xs text-specter-text-muted mb-2 uppercase tracking-wider">Overlay Corner</label>
              <span className="text-xs text-specter-text-muted opacity-60 block mb-2">Which corner the game overlay anchors to when activated.</span>
              <div className="flex gap-2">
                {[{ v: 'top-right', l: 'Top Right' }, { v: 'top-left', l: 'Top Left' }].map(opt => (
                  <button key={opt.v} onClick={() => setOverlayCorner(opt.v)}
                    className={`flex-1 px-3 py-2 border text-xs uppercase tracking-widest font-mono transition-colors ${
                      overlayCorner === opt.v
                        ? 'border-specter-primary-neon text-specter-primary-neon bg-specter-primary-neon/10'
                        : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                    }`}
                  >
                    {opt.l}
                  </button>
                ))}
              </div>
            </div>

            {/* Overlay Safe Mode */}
            <div className="pt-2 border-t border-specter-primary-dim/30">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overlaySafeMode}
                  onChange={(e) => setOverlaySafeMode(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-xs text-specter-text-muted uppercase tracking-wider">Overlay Safe Mode</span>
                  <span className="text-xs text-specter-text-muted opacity-60 block mt-1">
                    Always use the in-app local HUD instead of the native always-on-top overlay window. Enable this if the native overlay fails to appear on your system.
                  </span>
                </span>
              </label>
            </div>

            {/* Close Behavior */}
            {isTauri && (
              <div className="pt-2 border-t border-specter-primary-dim/30">
                <label className="block text-xs text-specter-text-muted mb-2 uppercase tracking-wider">When Closing The Window</label>
                <span className="text-xs text-specter-text-muted opacity-60 block mb-2">
                  What the X button does. Tray modes add a system tray icon — use its menu to reopen or quit for real.
                </span>
                <div className="flex flex-col gap-2">
                  {[
                    { v: 'quit', l: 'Fully Close', d: "Exits the app completely — today's default behavior." },
                    { v: 'tray_light', l: 'Close To Tray', d: 'Frees the window’s memory but keeps background message sync and event notifications running.' },
                    { v: 'tray_resident', l: 'Minimize To Tray', d: 'Keeps the window fully loaded in the background for an instant reopen — uses more memory while closed.' },
                  ].map(opt => (
                    <button key={opt.v} onClick={() => applyCloseBehavior(opt.v)}
                      className={`text-left px-3 py-2 border text-xs font-mono transition-colors ${
                        closeBehavior === opt.v
                          ? 'border-specter-primary-neon text-specter-primary-neon bg-specter-primary-neon/10'
                          : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                      }`}
                    >
                      <span className="block uppercase tracking-widest">{opt.l}</span>
                      <span className="block opacity-70 mt-0.5 normal-case tracking-normal">{opt.d}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3 items-center">
              {commsSaved && <span className="text-xs font-mono text-specter-state-success">Comms settings saved.</span>}
              <Button onClick={handleCommsSave}>Save Comms</Button>
            </div>
          </div>
        )}

        {activeTab === 'profile' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">Callsign</label>
              <div className="w-full bg-black/40 border border-specter-primary-dim/40 text-xs p-2 text-specter-text-muted rounded">
                {(user && user.callsign) || '\u2014'}
              </div>
            </div>
            <div>
              <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">Timezone</label>
              <select value={timezone} onChange={e => setTimezone(e.target.value)} className="w-full bg-black border border-specter-primary-dim text-xs p-2 focus:border-specter-primary-cyan outline-none text-specter-text-main">
                {timezones.map(tz => <option key={tz} value={tz}>{tz}</option>)}
              </select>
              <span className="text-xs text-specter-text-muted opacity-60 mt-1 block">Used for event calendar scheduling.</span>
            </div>
            <div>
              <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">Profile Image Path</label>
              <div className="flex gap-2">
                <input type="text" value={profileImagePath} onChange={e => setProfileImagePath(e.target.value)}
                  placeholder={isTauri ? 'Browse or enter a local file path' : 'Enter local file path'}
                  className="flex-1 bg-black border border-specter-primary-dim text-xs p-2 focus:border-specter-primary-cyan outline-none text-specter-text-main font-mono" />
                {isTauri && <Button variant="secondary" onClick={handleBrowse}>Browse</Button>}
              </div>
              <span className="text-xs text-specter-text-muted opacity-60 mt-1 block">Local path to your avatar image file.</span>
            </div>
            {profileError && <div className="border rounded px-3 py-2 text-xs font-mono bg-red-950 border-red-700 text-red-300">{profileError}</div>}
            {profileSaved && <div className="border rounded px-3 py-2 text-xs font-mono bg-green-950 border-green-700 text-green-300">Profile updated successfully.</div>}
            <div className="mt-6 flex justify-end">
              <Button onClick={handleProfileSave} disabled={profileLoading}>
                {profileLoading ? 'Saving...' : 'Save Profile'}
              </Button>
            </div>
          </div>
        )}

        {activeTab === 'games' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-specter-text-muted mb-1 uppercase tracking-wider">My Games</label>
              <span className="text-xs text-specter-text-muted opacity-60 block mb-2">Selecting a game unlocks its modules below (e.g. Hangar for Star Citizen).</span>
              <div className="flex flex-wrap gap-2">
                {GAME_OPTIONS.filter(g => g.v !== 'none').map(g => {
                  const selected = myGames.includes(g.v);
                  return (
                    <button
                      key={g.v}
                      onClick={() => toggleMyGame(g.v)}
                      className={`px-4 py-2 rounded text-xs font-mono uppercase tracking-wider border transition-colors ${
                        selected
                          ? 'border-specter-primary-cyan bg-specter-primary-cyan/10 text-specter-primary-cyan'
                          : 'border-specter-primary-dim/40 text-specter-text-muted hover:text-specter-text-main'
                      }`}
                    >
                      {g.l}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {moduleTabs.map(m => activeTab === m.key && <m.component key={m.key} onOpenShip={onOpenShip} />)}

        {activeTab === 'billing' && (
          <div className="space-y-3">
            <label className="block text-xs text-specter-text-muted uppercase tracking-wider">Transaction History</label>
            {txError ? (
              <div className="border rounded px-3 py-2 text-xs font-mono bg-red-950 border-red-700 text-red-300">{txError}</div>
            ) : transactions === null ? (
              <div className="text-xs text-specter-text-muted font-mono">Loading…</div>
            ) : transactions.length === 0 ? (
              <div className="text-xs text-specter-text-muted font-mono">No transactions yet.</div>
            ) : (
              <div className="space-y-2">
                {transactions.map(tx => (
                  <div key={tx.id} className="flex items-center justify-between gap-2 border border-specter-primary-dim/40 rounded px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-xs text-specter-text-main truncate">Pool funding — {tx.org_name}</div>
                      <div className="text-xs text-specter-text-muted font-mono opacity-70">
                        {tx.payment_method.toUpperCase()} · {new Date(tx.created_at).toLocaleString()}
                        {tx.fee_cents > 0 && ` · fee $${(tx.fee_cents / 100).toFixed(2)}`}
                        {tx.status === 'pending' && tx.payment_method === 'ach' && ' · ACH may take 3-5 business days'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs font-mono text-specter-primary-cyan">${(tx.amount_cents / 100).toFixed(2)}</span>
                      <span className={`text-xs font-mono uppercase ${
                        tx.status === 'succeeded' ? 'text-green-400' :
                        tx.status === 'pending'   ? 'text-yellow-400' : 'text-red-400'
                      }`}>{tx.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsUI;