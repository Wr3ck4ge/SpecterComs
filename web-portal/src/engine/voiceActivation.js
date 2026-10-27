// Voice-activation settings shared by CommLink (live voice), the settings
// bridge host (strip mic test) and the old SettingsUI. The gate itself runs
// natively in the capture path (specter-audio's vad.rs); this only reads the
// engine-window localStorage keys and pushes them to the plugin.
//
//   specter_vad_mode           'auto' (default) | 'manual'
//   specter_noise_suppression  'true' (default) | 'false'   (Auto only)
//   specter_vad_sensitivity    'low' | 'normal' (default) | 'high' (Auto only)
//   specter_audio_threshold    Manual gate, raw i16 RMS (default 150) — the
//                              same key CommLink's in-panel slider always used
//   specter_voice_mode         'push-to-talk' forces the Manual gate, so PTT
//                              behaves exactly as it did before Auto existed

export const VAD_KEYS = Object.freeze([
  'specter_vad_mode',
  'specter_noise_suppression',
  'specter_vad_sensitivity',
  'specter_audio_threshold',
  'specter_voice_mode',
]);

export const DEFAULT_MANUAL_THRESHOLD = 150;

const read = (k) => {
  try { return localStorage.getItem(k); } catch { return null; }
};

export function readManualThreshold() {
  const v = parseFloat(read('specter_audio_threshold'));
  return Number.isFinite(v) ? v : DEFAULT_MANUAL_THRESHOLD;
}

/** The config the native gate should run with right now. */
export function readVadConfig() {
  const ptt = read('specter_voice_mode') === 'push-to-talk';
  const chosen = read('specter_vad_mode') === 'manual' ? 'manual' : 'auto';
  const sens = read('specter_vad_sensitivity');
  return {
    mode: ptt ? 'manual' : chosen,
    noiseSuppression: read('specter_noise_suppression') !== 'false',
    sensitivity: sens === 'low' || sens === 'high' ? sens : 'normal',
    threshold: readManualThreshold(),
  };
}

/**
 * Threshold the media server's mixer should apply to this sender (control
 * datagram 0x05). In Auto the client gate is authoritative — denoised or
 * whispered speech can sit below a fixed RMS — so the mixer is told 0 (pass
 * whatever arrives); Manual keeps sending the user's threshold as before.
 */
export function serverThresholdFor(cfg = readVadConfig()) {
  return cfg.mode === 'auto' ? 0 : cfg.threshold;
}

/** Push the current config into the native capture gate. Best-effort. */
export async function applyNativeVadConfig(invoke, cfg = readVadConfig()) {
  await Promise.all([
    invoke('plugin:specter-audio|set_send_threshold', { value: cfg.threshold }).catch(() => {}),
    invoke('plugin:specter-audio|set_vad_config', {
      mode: cfg.mode,
      noiseSuppression: cfg.noiseSuppression,
      sensitivity: cfg.sensitivity,
    }).catch((err) => console.warn('[VAD] set_vad_config failed:', err)),
  ]);
  return cfg;
}
