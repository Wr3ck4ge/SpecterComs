import { useEffect, useReducer, useRef } from 'react';
import { STRIP_WINDOW } from './bridge.js';
import {
  MIC_TEST_LEASE_MS, SETTINGS_KEYS, SEV, SOP, settingsEmit, settingsListen,
} from './settingsBridge.js';
import { collectAndSubmitDiagnostics } from '../utils/diagnostics';
import { VAD_KEYS, applyNativeVadConfig } from './voiceActivation';

// P2C: engine side of the settings bridge (protocol: ./settingsBridge.js).
// Mounted once by WarRoom in the hidden main window:
//   useSettingsBridgeHost({ micCaptureActive })
// micCaptureActive — voice capture is already running (in voice, unmuted);
// a mic test then only listens to it instead of stopping/restarting cpal,
// which would kill the user's real voice-channel mic (same rule as the old
// SettingsUI mic test).
//
// Writes go to this window's localStorage followed by a synthetic `storage`
// event — exactly what SettingsUI's Save buttons did — so CommLink (devices,
// gain, VAD threshold, coms filter) and WarRoom (global shortcuts) pick them
// up live. The hook also re-renders WarRoom after a write, because some
// settings are read during render (overlay safe mode → the strip bridge's
// caps.overlay).

const isTauri = () => typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
const LEVEL_EMIT_MS = 66;

function readValues() {
  const values = {};
  for (const k of SETTINGS_KEYS) {
    try { values[k] = localStorage.getItem(k); } catch { values[k] = null; }
  }
  return values;
}

const emitToStrip = (event, payload) =>
  settingsEmit(STRIP_WINDOW, event, payload).catch((err) => console.warn(`[settings-bridge] emit ${event} failed:`, err));

const logNative = (message) => {
  if (!isTauri()) return;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('client_log', { msg: `[MicTest/strip] ${message}` }))
    .catch(() => {});
};

async function listDevices() {
  const { invoke } = await import('@tauri-apps/api/core');
  const map = (list) => (list || []).map((d) => ({ id: d.id, name: d.name, isDefault: Boolean(d.is_default) }));
  const [inputs, outputs] = await Promise.all([
    invoke('plugin:specter-audio|list_audio_devices').then(map).catch((err) => { console.error('Native input device list failed:', err); return []; }),
    invoke('plugin:specter-audio|list_output_devices').then(map).catch((err) => { console.error('Native output device list failed:', err); return []; }),
  ]);
  // No inputs usually means Windows privacy is blocking mic access.
  return { inputs, outputs, permission: inputs.length > 0 ? 'granted' : 'unknown' };
}

export default function useSettingsBridgeHost({ micCaptureActive = false } = {}) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  const micActiveRef = useRef(micCaptureActive);
  micActiveRef.current = micCaptureActive;

  useEffect(() => {
    // ── Mic test ──────────────────────────────────────────────────────────
    // { deviceId, owns, leaseUntil, unlisten[], level, sentLevel, timer }
    let test = null;
    let starting = null; // promise while a start is in flight

    const stopTest = async (why) => {
      const t = test;
      test = null;
      if (!t) return;
      t.unlisten.forEach((fn) => { try { fn(); } catch { /* gone */ } });
      clearInterval(t.timer);
      if (t.owns) {
        logNative(`stopping mic test (${why}); stop_capture`);
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('plugin:specter-audio|stop_capture', {}).catch(() => {});
      } else {
        logNative(`stopping mic test (${why}); leaving live capture running`);
      }
      emitToStrip(SEV.MIC_LEVEL, { level: 0, live: false, stopped: true });
    };

    const startTest = async (deviceId) => {
      const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
      const live = micActiveRef.current;
      const t = { deviceId, owns: false, live, leaseUntil: Date.now() + MIC_TEST_LEASE_MS, unlisten: [], level: 0, info: {}, gateLatched: false, sentKey: '', lastLevelTs: 0, timer: null };
      if (!live) {
        const dev = deviceId && deviceId !== 'default' ? deviceId : null;
        logNative(`starting mic test (deviceId=${dev || 'default'})`);
        // No CommLink may be running to have pushed these: test with the
        // user's real voice-activation settings.
        await applyNativeVadConfig(invoke);
        await invoke('plugin:specter-audio|stop_capture', {}).catch(() => {});
        try {
          await invoke('plugin:specter-audio|start_capture', { deviceId: dev });
        } catch (err) {
          if (!dev) throw err;
          logNative(`start_capture failed for selected device; retrying default (${String(err)})`);
          await invoke('plugin:specter-audio|start_capture', { deviceId: null });
        }
        t.owns = true;
      } else {
        logNative('mic test reusing live voice capture');
      }
      t.unlisten.push(await listen('specter://audio-level', (e) => {
        const p = e.payload || {};
        t.lastLevelTs = Date.now();
        t.level = Math.min(100, Math.round(((p.rms ?? 0) / 500) * 100));
        // The gate is per 20 ms window but we emit at ~15 Hz: latch "open"
        // until the next emit so a short burst still shows on the meter.
        t.info = { rms: p.rms ?? 0, floor: p.floor, vad: p.vad ?? null, mode: p.mode };
        if (p.gate) t.gateLatched = true;
      }));
      // Fallback where audio-level isn't emitted: approximate from Opus size.
      t.unlisten.push(await listen('specter://audio-frame', (e) => {
        if (Date.now() - t.lastLevelTs < 350) return;
        const data = e.payload?.data;
        if (!data) return;
        t.level = Math.min(100, Math.round((atob(data).length / 150) * 100));
      }));
      t.timer = setInterval(() => {
        if (Date.now() > t.leaseUntil) { if (test === t) stopTest('lease expired'); return; }
        const gate = Boolean(t.gateLatched);
        t.gateLatched = false;
        const { floor, mode } = t.info;
        const floorDb = floor ? Math.round(20 * Math.log10(Math.max(1, floor))) : '';
        const key = `${t.level}|${gate ? 1 : 0}|${floorDb}|${mode || ''}`;
        if (key === t.sentKey) return;
        t.sentKey = key;
        emitToStrip(SEV.MIC_LEVEL, { level: t.level, live: t.live, ...t.info, gate });
      }, LEVEL_EMIT_MS);
      test = t;
      return t;
    };

    const micTest = async ({ on, deviceId = 'default' }) => {
      if (starting) await starting.catch(() => {});
      if (!on) { await stopTest('strip'); return { live: false }; }
      if (test) {
        // Renewal. Restart only when the strip picked another input and the
        // test runs its own capture.
        if (test.owns && test.deviceId !== deviceId) await stopTest('device changed');
        else { test.leaseUntil = Date.now() + MIC_TEST_LEASE_MS; return { live: test.live }; }
      }
      starting = startTest(deviceId);
      try {
        const t = await starting;
        return { live: t.live };
      } finally {
        starting = null;
      }
    };

    // ── Ops ───────────────────────────────────────────────────────────────
    const broadcast = () => emitToStrip(SEV.CHANGED, { values: readValues() });

    const ops = {
      [SOP.GET]: () => ({ values: readValues() }),
      [SOP.SET]: ({ key, value }) => {
        if (!SETTINGS_KEYS.includes(key)) throw new Error(`Unknown setting: ${key}`);
        if (value === null || value === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, String(value));
        // Same signal SettingsUI's Save buttons sent; our own storage
        // listener below then broadcasts the new values to the strip.
        window.dispatchEvent(new StorageEvent('storage', { key }));
        // A running CommLink re-pushes voice activation itself on that storage
        // event; a strip mic test with no voice channel has no CommLink, so
        // push here too (idempotent).
        if (VAD_KEYS.includes(key) && isTauri()) {
          import('@tauri-apps/api/core').then(({ invoke }) => applyNativeVadConfig(invoke)).catch(() => {});
        }
        rerender();
        return { values: readValues() };
      },
      [SOP.DEVICES]: () => listDevices(),
      [SOP.REQUEST_MIC]: async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((tr) => tr.stop());
        } catch (err) {
          const res = await listDevices();
          return { ...res, permission: res.inputs.length ? res.permission : 'denied', error: err?.message || String(err) };
        }
        return listDevices();
      },
      [SOP.MIC_TEST]: (args) => micTest(args),
      [SOP.DIAGNOSTICS]: async ({ appVersion }) => {
        const { error } = await collectAndSubmitDiagnostics(appVersion || '');
        if (error) throw new Error(typeof error === 'string' ? error : 'Upload failed');
        return {};
      },
    };

    const stopReq = settingsListen(SEV.REQUEST, async ({ id, op, args }) => {
      const fn = ops[op];
      let reply;
      if (!fn) reply = { id, ok: false, error: `Unknown settings op: ${op}` };
      else {
        try {
          reply = { id, ok: true, result: (await fn(args || {})) ?? null };
        } catch (err) {
          reply = { id, ok: false, error: err?.message || String(err) };
        }
      }
      emitToStrip(SEV.REPLY, reply);
    });

    const onStorage = (e) => { if (!e.key || SETTINGS_KEYS.includes(e.key)) broadcast(); };
    window.addEventListener('storage', onStorage);

    return () => {
      stopReq();
      window.removeEventListener('storage', onStorage);
      stopTest('engine unmount');
    };
  }, []);
}
