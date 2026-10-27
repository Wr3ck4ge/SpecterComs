import { useCallback, useEffect, useRef, useState } from 'react';
import { EV, bridgeListen } from '../../engine/bridge.js';
import {
  DIAGNOSTICS_TIMEOUT_MS, MIC_TEST_LEASE_MS, SETTINGS_DEFAULTS, SEV, SOP, settingsListen, settingsRequest,
} from '../../engine/settingsBridge.js';
import { DEFAULT_KEYBINDS } from '../../keybinds';

// P2C: strip side of the settings bridge (protocol: src/engine/settingsBridge.js).
//
//   const s = useSettings({ enabled });
//   s.status          'loading' | 'ready' | 'error'
//   s.error           why loading failed (engine not answering)
//   s.values          effective values (defaults applied), see effective()
//   s.set(key, value) optimistic write → engine; null removes the key
//   s.saveError       last write failure (the value is rolled back)
//   s.reload()
//   s.devices         { inputs, outputs, permission } | null; s.loadDevices(), s.requestMic()
//   s.mic             { on, level, live, error, rms?, floor?, gate?, vad?, mode? }
//                     (rms/floor raw i16 RMS — see settingsBridge's mic-level);
//                     s.setMicTest(on, deviceId)
//   s.submitDiagnostics(appVersion) → Promise
// Everything is engine-held; the strip keeps nothing of its own here.

const KEYBIND_DEFAULTS = {
  specter_channel_toggle_key: DEFAULT_KEYBINDS.channelToggle,
  specter_stream_next_key: DEFAULT_KEYBINDS.streamNext,
  specter_overlay_passthrough_key: DEFAULT_KEYBINDS.overlayPassthrough,
};

/** Raw engine values → what the UI shows (same fallbacks as the old SettingsUI). */
export function effective(raw = {}) {
  const out = {};
  for (const [k, def] of Object.entries(SETTINGS_DEFAULTS)) {
    const v = raw[k];
    if (k in KEYBIND_DEFAULTS) out[k] = v ?? KEYBIND_DEFAULTS[k]; // '' = deliberately unbound
    else out[k] = v ?? def;
  }
  return out;
}

export default function useSettings({ enabled = true } = {}) {
  const [raw, setRaw] = useState(null);
  const rawRef = useRef(raw);
  rawRef.current = raw;
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [devices, setDevices] = useState(null);
  const [mic, setMic] = useState({ on: false, level: 0, live: false, error: null });
  const micRef = useRef({ on: false, deviceId: 'default' });

  const reload = useCallback(() => {
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    settingsRequest(SOP.GET).then((r) => {
      setRaw(r?.values || {});
      setStatus('ready');
      setError(null);
    }).catch((err) => {
      setStatus('error');
      setError(err.message);
    });
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    reload();
    const stops = [
      settingsListen(SEV.CHANGED, ({ values }) => { if (values) { setRaw(values); setStatus('ready'); } }),
      settingsListen(SEV.MIC_LEVEL, ({ level, live, stopped, rms, floor, gate, vad, mode }) => {
        if (stopped) { micRef.current.on = false; setMic((m) => ({ ...m, on: false, level: 0, gate: false })); return; }
        setMic((m) => (m.on ? { ...m, level, live: Boolean(live), rms, floor, gate: Boolean(gate), vad, mode } : m));
      }),
      // A (re)started engine: fetch again.
      bridgeListen(EV.READY, () => reload()),
    ];
    return () => stops.forEach((s) => s());
  }, [enabled, reload]);

  const set = useCallback((key, value) => {
    setSaveError(null);
    const prev = rawRef.current?.[key] ?? null;
    setRaw((r) => ({ ...(r || {}), [key]: value }));
    settingsRequest(SOP.SET, { key, value }).then((r) => {
      if (r?.values) setRaw(r.values);
    }).catch((err) => {
      setRaw((r) => ({ ...(r || {}), [key]: prev }));
      setSaveError(`Couldn't save: ${err.message}`);
    });
  }, []);

  const loadDevices = useCallback(() => {
    settingsRequest(SOP.DEVICES).then(setDevices).catch((err) => setDevices({ inputs: [], outputs: [], permission: 'unknown', error: err.message }));
  }, []);
  const requestMic = useCallback(() => {
    settingsRequest(SOP.REQUEST_MIC, {}, 30_000).then(setDevices).catch((err) => setDevices((d) => ({ ...(d || { inputs: [], outputs: [] }), permission: 'denied', error: err.message })));
  }, []);

  // Mic test: a lease renewed while on; released on off / unmount.
  const setMicTest = useCallback((on, deviceId = 'default') => {
    micRef.current = { on, deviceId };
    setMic({ on, level: 0, live: false, error: null });
    settingsRequest(SOP.MIC_TEST, { on, deviceId }, 15_000)
      .then((r) => { if (on) setMic((m) => ({ ...m, live: Boolean(r?.live) })); })
      .catch((err) => { micRef.current.on = false; setMic({ on: false, level: 0, live: false, error: err.message }); });
  }, []);
  useEffect(() => {
    if (!mic.on) return undefined;
    const t = setInterval(() => {
      const { on, deviceId } = micRef.current;
      if (on) settingsRequest(SOP.MIC_TEST, { on: true, deviceId }).catch(() => {});
    }, MIC_TEST_LEASE_MS / 2);
    return () => clearInterval(t);
  }, [mic.on]);
  useEffect(() => () => {
    if (micRef.current.on) settingsRequest(SOP.MIC_TEST, { on: false }).catch(() => {});
  }, []);

  const submitDiagnostics = useCallback(
    (appVersion) => settingsRequest(SOP.DIAGNOSTICS, { appVersion }, DIAGNOSTICS_TIMEOUT_MS),
    [],
  );

  return {
    status, error, values: effective(raw || {}), set, saveError, clearSaveError: () => setSaveError(null), reload,
    devices, loadDevices, requestMic, mic, setMicTest, submitDiagnostics,
  };
}
