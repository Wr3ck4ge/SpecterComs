// api.js - Centralized API Service

import { invoke } from '@tauri-apps/api/core';
import { createApi } from '@spectercoms/shared-web/src/api.js';
import { API_BASE_URL } from './apiBase.js';
import { apiAuthProvider } from './auth/tokenStore.js';

export { API_BASE_URL };
// The session token comes from auth/tokenStore.js (Rust on desktop), and a 401
// gets one shared refresh + one retry there instead of clearing localStorage.
const shared = createApi(API_BASE_URL, apiAuthProvider);

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

  // L13: ownership transfer + abandoned-server claims (utils/ownershipTransfer.ts).
  getOwnership:        (orgId) => shared.fetchWithAuth(`/orgs/${orgId}/ownership`),
  getIncomingTransfers: () => shared.fetchWithAuth('/orgs/ownership/incoming'),
  startOwnershipTransfer: (orgId, body) => shared.fetchWithAuth(`/orgs/${orgId}/ownership/transfer`, { method: 'POST', body }),
  cancelOwnershipTransfer: (orgId) => shared.fetchWithAuth(`/orgs/${orgId}/ownership/transfer`, { method: 'DELETE' }),
  acceptOwnershipTransfer: (orgId, body) => shared.fetchWithAuth(`/orgs/${orgId}/ownership/accept`, { method: 'POST', body }),
  declineOwnershipTransfer: (orgId) => shared.fetchWithAuth(`/orgs/${orgId}/ownership/decline`, { method: 'POST', body: {} }),
  claimAbandonedServer: (orgId, body) => shared.fetchWithAuth(`/orgs/${orgId}/ownership/claim`, { method: 'POST', body }),

  // ── MLS resilience (v2.0.1, MR1) — used by mlsSession.js ──────────────────
  // Commits that also upload the GroupInfo for the epoch they produce, the
  // GroupInfo read/re-upload, external commits (join / resync without an
  // existing member), and device epoch diagnostics. See mlsGroupController.ts.
  // 409 = epoch conflict (normal, self-healing); 403 on group-info = not on
  // the group's member list; 404 = a server without these routes.
  submitChannelMlsCommit: (orgId, chanId, epoch, commitB64, welcomeB64, welcomedUserIds, groupInfoB64) =>
    shared.fetchWithAuth(`/orgs/${orgId}/channels/${chanId}/mls/commit`, { method: 'POST', body: { epoch, commit: commitB64, welcome: welcomeB64, welcomed_user_ids: welcomedUserIds, group_info: groupInfoB64 ?? null }, expectedStatuses: [409] }),
  submitEventGroupMlsCommit: (orgId, eventId, epoch, commitB64, welcomeB64, welcomedUserIds, groupInfoB64) =>
    shared.fetchWithAuth(`/orgs/${orgId}/events/${eventId}/mls/commit`, { method: 'POST', body: { epoch, commit: commitB64, welcome: welcomeB64, welcomed_user_ids: welcomedUserIds, group_info: groupInfoB64 ?? null }, expectedStatuses: [409] }),
  submitDmMlsCommit: (userId, epoch, commitB64, welcomeB64, groupInfoB64) =>
    shared.fetchWithAuth(`/dm/${userId}/mls/commit`, { method: 'POST', body: { epoch, commit: commitB64, welcome: welcomeB64, group_info: groupInfoB64 ?? null }, expectedStatuses: [409] }),

  getChannelMlsGroupInfo: (orgId, chanId) =>
    shared.fetchWithAuth(`/orgs/${orgId}/channels/${chanId}/mls/group-info`, { method: 'GET', expectedStatuses: [403, 404] }),
  putChannelMlsGroupInfo: (orgId, chanId, epoch, groupInfoB64) =>
    shared.fetchWithAuth(`/orgs/${orgId}/channels/${chanId}/mls/group-info`, { method: 'PUT', body: { epoch, group_info: groupInfoB64 }, expectedStatuses: [403, 404, 409] }),
  submitChannelMlsExternalCommit: (orgId, chanId, epoch, commitB64, groupInfoB64) =>
    shared.fetchWithAuth(`/orgs/${orgId}/channels/${chanId}/mls/external-commit`, { method: 'POST', body: { epoch, commit: commitB64, group_info: groupInfoB64 ?? null }, expectedStatuses: [409] }),

  getEventGroupMlsGroupInfo: (orgId, eventId) =>
    shared.fetchWithAuth(`/orgs/${orgId}/events/${eventId}/mls/group-info`, { method: 'GET', expectedStatuses: [403, 404] }),
  putEventGroupMlsGroupInfo: (orgId, eventId, epoch, groupInfoB64) =>
    shared.fetchWithAuth(`/orgs/${orgId}/events/${eventId}/mls/group-info`, { method: 'PUT', body: { epoch, group_info: groupInfoB64 }, expectedStatuses: [403, 404, 409] }),
  submitEventGroupMlsExternalCommit: (orgId, eventId, epoch, commitB64, groupInfoB64) =>
    shared.fetchWithAuth(`/orgs/${orgId}/events/${eventId}/mls/external-commit`, { method: 'POST', body: { epoch, commit: commitB64, group_info: groupInfoB64 ?? null }, expectedStatuses: [409] }),

  // S7: the DM's two participants + their devices' wire caps (device_caps).
  getDmMlsMembers: (userId) =>
    shared.fetchWithAuth(`/dm/${userId}/mls/members`, { method: 'GET', expectedStatuses: [403, 404] }),
  getDmMlsGroupInfo: (userId) =>
    shared.fetchWithAuth(`/dm/${userId}/mls/group-info`, { method: 'GET', expectedStatuses: [403, 404] }),
  putDmMlsGroupInfo: (userId, epoch, groupInfoB64) =>
    shared.fetchWithAuth(`/dm/${userId}/mls/group-info`, { method: 'PUT', body: { epoch, group_info: groupInfoB64 }, expectedStatuses: [403, 404, 409] }),
  submitDmMlsExternalCommit: (userId, epoch, commitB64, groupInfoB64) =>
    shared.fetchWithAuth(`/dm/${userId}/mls/external-commit`, { method: 'POST', body: { epoch, commit: commitB64, group_info: groupInfoB64 ?? null }, expectedStatuses: [409] }),

  reportMlsDeviceStatus: (deviceId, groups) =>
    shared.fetchWithAuth('/mls/device-status', { method: 'POST', body: { device_id: deviceId, groups }, expectedStatuses: [404] }),

  // registerDevice with the device-id conflict surfaced: the server answers
  // 409 DEVICE_ID_TAKEN (MR3) when the id belongs to another account, and the
  // caller must generate a new id rather than treat it as registered.
  // S7: wireCaps = the formats this build can read (mlsSession WIRE_CAPS),
  // stored per device by the server and returned as mls/members device_caps.
  registerMlsDevice: async (deviceId, keyPackageB64, credentialB64, publicKeyB64 = null, wireCaps = null) => {
    const headers = Number.isInteger(wireCaps) ? { 'X-Specter-Wire-Caps': String(wireCaps) } : {};
    const r = await shared.fetchWithAuth('/devices', { method: 'POST', headers, body: { device_id: deviceId, key_package: keyPackageB64, credential: credentialB64, public_key: publicKeyB64 }, expectedStatuses: [409] });
    const taken = !!r.error && /DEVICE_ID_TAKEN|registered to another account/i.test(r.error);
    return { ...r, code: taken ? 'DEVICE_ID_TAKEN' : null };
  },

  // MR2: org-wide chat catch-up (identity-node messageController.ts).
  // channels = [{ channel_id, since }] → 202 { ok, channels: [ids accepted] }
  requestOrgSync: (orgId, channels) =>
    shared.fetchWithAuth(`/orgs/${orgId}/messages/sync-request`, { method: 'POST', body: { channels } }),
  // One MLS-encrypted backfill bundle for one channel, to the requester only.
  respondOrgSync: (orgId, toUserId, channelId, bundle, count) =>
    shared.fetchWithAuth(`/orgs/${orgId}/messages/sync-response`, {
      method: 'POST', body: { to_user_id: toUserId, channel_id: channelId, bundle, count },
    }),
  // MR2: answer a DM partner's dm_sync_request with one MLS-encrypted bundle
  // (dmController.ts respondDmSync; replaces the per-message `messages` body).
  respondDmSyncBundle: (userId, bundle, count) =>
    shared.fetchWithAuth(`/dm/${userId}/sync-response`, { method: 'POST', body: { bundle, count } }),

  // Repair panel: the server-assisted network test (netprobeController.ts).
  // 429 = run too often; 404 = a server without it. Both just skip the test.
  startNetprobe: () =>
    shared.fetchWithAuth('/diag/netprobe', { method: 'POST', body: {}, expectedStatuses: [404, 429] }),
  getNetprobe: (token) =>
    shared.fetchWithAuth(`/diag/netprobe/${token}`, { method: 'GET', expectedStatuses: [404] }),

  // Server welcome panel (the strip's Welcome pane; orgWelcomeController.ts).
  // Plain org metadata, not end-to-end encrypted. 403 = not a member / not
  // allowed to edit; 400 = a limit (the message says which).
  getOrgWelcome: (orgId) =>
    shared.fetchWithAuth(`/orgs/${orgId}/welcome`, { method: 'GET', expectedStatuses: [403] }),
  updateOrgWelcome: (orgId, { subtitle, sections }) =>
    shared.fetchWithAuth(`/orgs/${orgId}/welcome`, { method: 'PUT', body: { subtitle, sections }, expectedStatuses: [400, 403] }),
};
