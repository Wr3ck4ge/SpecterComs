import { api } from '../api';
import { getLastNetReport } from '../engine/netDiagnostics';
import { formatMlsDiagnostics } from './mlsDiagnosticsReport';

// Bundles capture perf stats + all client-side diagnostic logs (setup errors,
// capture errors, capture breadcrumbs, capture debug log, app log, audio
// pipeline log) and sends them to the server, which tags the report with the
// caller's callsign from the auth token. Moved out of SettingsUI's
// DiagnosticsButton so the engine can run it for the tray strip's settings
// cabinet too (the strip has no specter-audio plugin permission, so the
// engine window — which does — collects and submits). Resolves { error }.
export async function collectAndSubmitDiagnostics(appVersion) {
  const { invoke } = await import('@tauri-apps/api/core');
  const safeInvoke = async (cmd) => {
    try { return await invoke(cmd); } catch { return null; }
  };
  const [perf, captureErrors, breadcrumbs, setupErrors, captureDebug, appLog, audioPipelineLog] = await Promise.all([
    safeInvoke('capture_get_perf_report'),
    safeInvoke('capture_get_errors'),
    safeInvoke('capture_get_breadcrumbs'),
    safeInvoke('get_setup_errors'),
    safeInvoke('get_capture_debug_log'),
    safeInvoke('get_app_log'),
    // Mic/speaker device selection + sample-rate/resample decisions — a
    // separate log from the screen-capture ones above (different Tauri
    // plugin/crate entirely). See lib.rs's write_audio_log doc comment.
    safeInvoke('plugin:specter-audio|get_audio_pipeline_log'),
  ]);
  // S2: this device's MLS groups (ids, epochs, member labels — no keys). Best-effort.
  let mlsReport = null;
  try {
    const { getMlsDiagnostics } = await import('../mlsSession');
    mlsReport = formatMlsDiagnostics(await getMlsDiagnostics());
  } catch (err) {
    mlsReport = `MLS diagnostics unavailable: ${String(err?.message ?? err).slice(0, 200)}`;
  }
  return api.submitDiagnostics({
    appVersion,
    perf: trimPerf(perf),
    captureErrors: tail(captureErrors, LOG_TAIL_CHARS.small),
    breadcrumbs: tail(breadcrumbs, LOG_TAIL_CHARS.large),
    setupErrors: tail(setupErrors, LOG_TAIL_CHARS.large),
    captureDebug: tail(captureDebug, LOG_TAIL_CHARS.large),
    appLog: tail(appLog, LOG_TAIL_CHARS.large),
    audioPipelineLog: tail(audioPipelineLog, LOG_TAIL_CHARS.small),
    // The Repair panel's last diagnosis, repair steps and plain-text report.
    netReport: getLastNetReport(),
    mlsReport: tail(mlsReport, LOG_TAIL_CHARS.small),
  });
}

// The server takes up to 2 MB (routes/diag.ts). Logs grow for the whole
// session, so each one is cut to its NEWEST part (what a just-reported
// problem is in); the total stays well under the cap.
export const LOG_TAIL_CHARS = { large: 300_000, small: 100_000 };
export const PERF_MAX_SAMPLES = 2_000;

/** The last `max` characters of a log (string or array of lines), marked when cut. */
export function tail(log, max) {
  if (log == null) return log;
  if (Array.isArray(log)) {
    const out = [];
    let size = 0;
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const line = typeof log[i] === 'string' ? log[i] : JSON.stringify(log[i]);
      size += (line?.length || 0) + 1;
      if (size > max) { out.unshift(`[… ${i + 1} earlier entries cut]`); break; }
      out.unshift(log[i]);
    }
    return out;
  }
  const s = typeof log === 'string' ? log : JSON.stringify(log);
  return s.length <= max ? s : `[… ${s.length - max} earlier characters cut]\n${s.slice(-max)}`;
}

/** Keeps the perf report's newest PERF_MAX_SAMPLES entries in any array field. */
export function trimPerf(perf) {
  if (!perf || typeof perf !== 'object' || Array.isArray(perf)) return perf;
  const out = {};
  for (const [k, v] of Object.entries(perf)) out[k] = Array.isArray(v) && v.length > PERF_MAX_SAMPLES ? v.slice(-PERF_MAX_SAMPLES) : v;
  return out;
}
