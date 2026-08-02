// api.js - Centralized API Service

import { invoke } from '@tauri-apps/api/core';
import { createApi } from '@spectercoms/shared-web/src/api.js';

export const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8082";
const shared = createApi(API_BASE_URL);

export const UPLOADS_BASE_URL = shared.UPLOADS_BASE_URL;

export const api = {
  ...shared.api,

  // Misconduct Report Buffer (Tauri Native) — desktop-app-only, not part of
  // the shared client since it has no meaning outside a Tauri webview.
  // Frames are buffered locally; data only leaves the client when the user explicitly submits a report.
  submitReportFrame: async (timestamp, ssrc, frame) => {
    try { await invoke('submit_report_frame', { timestamp, ssrc, frame }); } catch (e) {}
  },
  snipReportClip: async (durationMs) => {
    try { return await invoke('snip_report_clip', { durationMs, currentTime: Date.now() }); } catch (e) { return []; }
  },
};
