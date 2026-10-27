import { api } from '../api';

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
  return api.submitDiagnostics({
    appVersion,
    perf,
    captureErrors,
    breadcrumbs,
    setupErrors,
    captureDebug,
    appLog,
    audioPipelineLog,
  });
}
