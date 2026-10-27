// P2C: the settings bridge — how the tray strip's Settings cabinet reads and
// writes settings that live in the engine (the hidden main window). A separate
// protocol from bridge.js (its own event names), reusing bridge.js's transport
// helpers only. Engine side: src/engine/useSettingsBridgeHost.js (mounted by
// WarRoom). Strip side: settingsRequest() below + components/strip/useSettings.js.
//
// Why a bridge at all: the strip runs in its own WebView2 profile, so its
// localStorage is not the engine's. The engine is the single source of truth
// for device-level settings (audio devices, gain, VAD threshold, voice mode,
// hotkeys, overlay prefs); CommLink and WarRoom already react to `storage`
// events in the engine window, so a write through here applies live.
//
// ── Events (Tauri app events; payloads carry bridge.js's `v` plus `sv`) ────
//   strip → engine  engine-settings-request   { v, sv, id, op, args }
//   engine → strip  engine-settings-reply     { v, sv, id, ok, result?, error? }
//   engine → strip  engine-settings-changed   { v, sv, values }
//       Sent after every write (from the strip, or from the engine itself —
//       e.g. CommLink's coms-filter button or the gain slider), so an open
//       Settings cabinet never shows stale values.
//   engine → strip  engine-settings-mic-level { v, sv, level: 0..100, live,
//                                               rms, floor, gate, vad, mode }
//       ~15 Hz while a mic test runs. `live` = the test is listening to the
//       already-running voice capture rather than its own. rms/floor are raw
//       i16 RMS (mic level / learned noise floor), gate = transmitting,
//       vad = voice probability 0..1 (null in manual), mode 'auto'|'manual'.
//       All but `level`/`live` are absent if the native build predates them.
//
// ── Ops (request.op) ───────────────────────────────────────────────────────
//   get            {}                    → { values }   raw values (null = unset)
//   set            { key, value }        → { values }   value null removes the key
//   devices        {}                    → { inputs, outputs, permission }
//                     inputs/outputs: [{ id, name, isDefault }]
//                     permission: 'granted' | 'unknown' (no inputs listed:
//                     Windows privacy may be blocking the mic)
//   requestMic     {}                    → devices result (asks the OS for mic access)
//   micTest        { on, deviceId }      → { live }     a lease: the strip
//                     re-sends { on: true } every MIC_TEST_LEASE_MS / 2; the
//                     engine stops the test on its own once the lease lapses
//                     (strip hidden or gone), so a test never leaves the mic
//                     capturing. Changing deviceId restarts the engine's own
//                     capture; a test riding on live voice capture never
//                     stops or restarts it.
//   diagnostics    { appVersion }        → {}           collect + submit logs
//
// Only keys in SETTINGS_KEYS can be read or written.

import { ENGINE_WINDOW, bridgeEmit, bridgeListen } from './bridge.js';

export const SETTINGS_PROTOCOL = 1;

export const SEV = Object.freeze({
  REQUEST: 'engine-settings-request',
  REPLY: 'engine-settings-reply',
  CHANGED: 'engine-settings-changed',
  MIC_LEVEL: 'engine-settings-mic-level',
});

export const SOP = Object.freeze({
  GET: 'get',
  SET: 'set',
  DEVICES: 'devices',
  REQUEST_MIC: 'requestMic',
  MIC_TEST: 'micTest',
  DIAGNOSTICS: 'diagnostics',
});

export const MIC_TEST_LEASE_MS = 10_000;
export const SETTINGS_TIMEOUT_MS = 8_000;
export const DIAGNOSTICS_TIMEOUT_MS = 60_000;

// localStorage keys the engine owns, with the defaults the old SettingsUI
// showed when a key was never set (the strip applies these; the engine reports
// raw values so "never set" stays distinguishable).
export const SETTINGS_DEFAULTS = Object.freeze({
  specter_audio_in: 'default',
  specter_audio_out: 'default',
  specter_audio_gain: '1.0',
  specter_vad_threshold: '15', // browser (non-Tauri) analyser VAD only
  // Voice activation — see engine/voiceActivation.js and specter-audio's vad.rs.
  specter_vad_mode: 'auto', // 'auto' | 'manual'
  specter_noise_suppression: 'true', // Auto only
  specter_vad_sensitivity: 'normal', // 'low' | 'normal' | 'high' (Auto only)
  specter_audio_threshold: '150', // Manual gate, raw i16 RMS (native capture + mixer)
  specter_audio_coms_filter: 'false',
  specter_voice_mode: 'voice-activated',
  specter_ptt_key: '',
  specter_channel_toggle_key: null, // keybinds.js DEFAULT_KEYBINDS (null → default)
  specter_stream_next_key: null,
  specter_overlay_passthrough_key: null,
  specter_overlay_corner: 'top-right',
  specter_overlay_safe_mode: null, // '1' = on; removed = off
});
export const SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_DEFAULTS));

export const isSettingsPayload = (p) => Boolean(p) && p.sv === SETTINGS_PROTOCOL;

/** Listen to a settings event (bridge.js version check + ours). */
export function settingsListen(event, handler) {
  return bridgeListen(event, (p) => { if (isSettingsPayload(p)) handler(p); });
}

/** Emit a settings event to one window. */
export function settingsEmit(target, event, payload = {}) {
  return bridgeEmit(target, event, { ...payload, sv: SETTINGS_PROTOCOL });
}

// ── Strip side: request/reply ───────────────────────────────────────────────
const waiters = new Map(); // id → { resolve, reject, timer }
let stopReplies = null;
let counter = 0;

function ensureReplyListener() {
  if (stopReplies) return;
  stopReplies = settingsListen(SEV.REPLY, ({ id, ok, result, error }) => {
    const w = waiters.get(id);
    if (!w) return;
    waiters.delete(id);
    clearTimeout(w.timer);
    if (ok) w.resolve(result ?? null); else w.reject(new Error(error || 'Failed'));
  });
}

/** Strip side: run one op in the engine → Promise<result>. */
export function settingsRequest(op, args = {}, timeoutMs = SETTINGS_TIMEOUT_MS) {
  ensureReplyListener();
  const id = `s${Date.now().toString(36)}-${(counter += 1)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error("SpecterComs didn't answer. Try again."));
    }, timeoutMs);
    waiters.set(id, { resolve, reject, timer });
    settingsEmit(ENGINE_WINDOW, SEV.REQUEST, { id, op, args }).catch((err) => {
      clearTimeout(timer);
      waiters.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
