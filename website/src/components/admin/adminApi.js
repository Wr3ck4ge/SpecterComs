// Admin-only API client. Deliberately separate from the shared user API client
// (packages/shared-web/src/api.js): that client's 401 handling clears the
// *user* session (specter_token) and fires `specter:auth-expired`, which is
// wrong for an expired admin session. Here a 401 only ends the admin session,
// and a 403 REAUTH_REQUIRED triggers a password re-prompt + one retry.
import { API_BASE_URL } from '../../api';

const TOKEN_KEY = 'specter_admin_token';

// sessionStorage, not localStorage: the admin token dies with the tab instead
// of persisting on disk for the next person at the machine.
export const adminTokenStore = {
  get() {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set(token) {
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
  },
  clear() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    // Older panel builds kept it in localStorage — never leave one behind.
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  },
};

const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

/**
 * hooks:
 *   onSessionExpired(message)  — called on any 401 (admin session over)
 *   requestReauth()            — returns a Promise<boolean>; true once the
 *                                admin has re-entered their password
 */
export function createAdminApi(hooks = {}) {
  async function raw(endpoint, { method = 'GET', body, retried = false } = {}) {
    const token = adminTokenStore.get();
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/admin${endpoint}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch {
      return { response: null, error: 'Network error — is the server reachable?', status: 0 };
    }

    // '/login' and '/login/2fa' (L3) answer 401 for a wrong password / code, not an ended session.
    if (response.status === 401 && !endpoint.startsWith('/login') && endpoint !== '/reauth') {
      const json = await response.json().catch(() => ({}));
      hooks.onSessionExpired?.(json.message || 'Admin session expired.');
      return { response, error: json.message || 'Admin session expired.', status: 401, code: json.code };
    }

    if (response.status === 403 && !retried) {
      const json = await response.clone().json().catch(() => ({}));
      // L3: REQUIRE_2FA_FOR_PRIVILEGED is on and this admin has no 2FA yet.
      if (json.code === 'TWO_FACTOR_REQUIRED') hooks.onTwoFactorRequired?.(json.message);
      if (json.code === 'REAUTH_REQUIRED' && hooks.requestReauth) {
        const ok = await hooks.requestReauth();
        if (ok) return raw(endpoint, { method, body, retried: true });
        return { response, error: 'Action cancelled — password confirmation required.', status: 403, code: json.code };
      }
    }
    return { response, error: null, status: response.status };
  }

  async function call(endpoint, opts) {
    const r = await raw(endpoint, opts);
    if (!r.response || r.error) return { data: null, error: r.error, status: r.status, code: r.code, body: null };
    const json = await r.response.json().catch(() => ({}));
    if (!r.response.ok) {
      const fieldErrors = Array.isArray(json.errors) && json.errors.length ? json.errors.map((e) => e.message).join(' · ') : null;
      return {
        data: null,
        error: fieldErrors || json.message || `HTTP ${r.response.status}`,
        status: r.response.status,
        code: json.code,
        body: json,
      };
    }
    return { data: json, error: null, status: r.response.status, code: null, body: json };
  }

  return {
    raw,
    login:          (username, password) => call('/login', { method: 'POST', body: { username, password } }),
    logout:         () => call('/logout', { method: 'POST', body: {} }),
    // code: authenticator code, needed when this admin has 2FA on (L3).
    reauth:         (password, code) => call('/reauth', { method: 'POST', body: { password, ...(code ? { code } : {}) } }),
    me:             () => call('/me'),

    // L3: two-factor authentication (login second step + the admin's own setup)
    loginTwoFactor: (challenge, { code, recovery_code }) => call('/login/2fa', { method: 'POST', body: { challenge, ...(recovery_code ? { recovery_code } : { code }) } }),
    twoFactorStatus:   () => call('/2fa'),
    twoFactorEnroll:   (password) => call('/2fa/enroll', { method: 'POST', body: { password } }),
    twoFactorConfirm:  (code) => call('/2fa/confirm', { method: 'POST', body: { code } }),
    twoFactorDisable:  (body) => call('/2fa/disable', { method: 'POST', body }),
    twoFactorRecoveryCodes: (body) => call('/2fa/recovery-codes', { method: 'POST', body }),

    overview:       () => call('/overview'),
    traffic:        (days) => call(`/traffic${qs({ days })}`),

    listUsers:      (params) => call(`/users${qs(params)}`),
    getUser:        (id) => call(`/users/${encodeURIComponent(id)}`),
    revealEmail:    (id, reason) => call(`/users/${encodeURIComponent(id)}/reveal-email`, { method: 'POST', body: { reason } }),
    // L12: platform ban appeals
    listAppeals:    (state) => call(`/appeals${qs({ state })}`),
    decideAppeal:   (id, decision, note) => call(`/appeals/${encodeURIComponent(id)}/decide`, { method: 'POST', body: { decision, note } }),
    banUser:        (id, body) => call(`/users/${encodeURIComponent(id)}/ban`, { method: 'POST', body }),
    erasurePreview: (id) => call(`/users/${encodeURIComponent(id)}/erasure-preview`),
    exportUser:     (id, body) => call(`/users/${encodeURIComponent(id)}/export`, { method: 'POST', body }),
    eraseUser:      (id, body) => call(`/users/${encodeURIComponent(id)}/erase`, { method: 'POST', body }),

    listOrgs:       (params) => call(`/orgs${qs(params)}`),
    dissolveOrg:    (id, body) => call(`/orgs/${encodeURIComponent(id)}`, { method: 'DELETE', body }),
    assignOrgNode:  (id, nodeId) => call(`/orgs/${encodeURIComponent(id)}/node`, { method: 'POST', body: { node_id: nodeId } }),
    unassignOrgNode:(id) => call(`/orgs/${encodeURIComponent(id)}/node`, { method: 'DELETE' }),

    listHwidBans:   (params) => call(`/hwid-bans${qs(params)}`),
    removeHwidBan:  (hwid, reason) => call(`/hwid-bans/${encodeURIComponent(hwid)}`, { method: 'DELETE', body: { reason } }),

    listAudit:      (params) => call(`/audit${qs(params)}`),

    listAdmins:     () => call('/admins'),
    setAdminRole:   (id, role) => call(`/admins/${encodeURIComponent(id)}/role`, { method: 'PUT', body: { role } }),

    listNodes:      () => call('/nodes'),
    provisionNode:  (region, nodeId) => call('/nodes/provision', { method: 'POST', body: { region, node_id: nodeId } }),
    listProvisioning: () => call('/nodes/provisioning'),

    // Billing (services/identity-node/src/routes/adminBilling.ts)
    billingOverview:   () => call('/billing/overview'),
    billingOrgs:       (params) => call(`/billing/orgs${qs(params)}`),
    billingOrg:        (orgId) => call(`/billing/orgs/${encodeURIComponent(orgId)}`),
    billingOrgLedger:  (orgId, params) => call(`/billing/orgs/${encodeURIComponent(orgId)}/ledger${qs(params)}`),
    billingPayments:   (params) => call(`/billing/payments${qs(params)}`),
    billingWebhooks:   (params) => call(`/billing/webhooks${qs(params)}`),
    billingExceptions: (params) => call(`/billing/exceptions${qs(params)}`),
    resolveBillingException: (id, note) => call(`/billing/exceptions/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: { note } }),
    reconcileBilling:  (body) => call('/billing/reconcile', { method: 'POST', body }),
    refundPayment:     (id, body) => call(`/billing/contributions/${encodeURIComponent(id)}/refund`, { method: 'POST', body }),
    adjustOrgBalance:  (orgId, body) => call(`/billing/orgs/${encodeURIComponent(orgId)}/adjust`, { method: 'POST', body }),
    settleBilling:     () => call('/billing/settle', { method: 'POST', body: { confirm: 'SETTLE' } }),
    // Plans & pricing (versioned billing config)
    billingConfig:        () => call('/billing/config'),
    billingConfigVersion: (v) => call(`/billing/config/versions/${encodeURIComponent(v)}`),
    saveBillingConfig:    (body) => call('/billing/config', { method: 'PUT', body }),

    // D1: bug reports (owner only; descriptions are sealed, opened in BugReportsSection)
    listBugReportKeys: () => call('/bug-reports/keys'),
    setBugReportKey:   (key) => call('/bug-reports/key', { method: 'PUT', body: key }),
    listBugReports:    (params) => call(`/bug-reports${qs(params)}`),
    // resolution: the reply the reporter sees in the app; undefined = leave it as it is.
    updateBugReport:   (id, status, ownerNote, resolution) => call(`/bug-reports/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { status, owner_note: ownerNote, ...(resolution !== undefined ? { resolution } : {}) },
    }),
    deleteBugReport:   (id) => call(`/bug-reports/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    // L6: user data requests; running the export / erasure uses exportUser / eraseUser above
    listDataRequests:  (status) => call(`/data-requests${qs({ status })}`),
    completeDataRequest: (id, note) => call(`/data-requests/${encodeURIComponent(id)}/complete`, { method: 'POST', body: { note } }),

    listVoiceReports:  (params) => call(`/voice-reports${qs(params)}`),
    updateVoiceReport: (id, status, adminNotes) => call(`/voice-reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status, admin_notes: adminNotes } }),
    voiceReportAudio:  async (id) => {
      const r = await raw(`/voice-reports/${encodeURIComponent(id)}/audio`);
      if (!r.response || r.error) return { data: null, error: r.error };
      if (!r.response.ok) {
        const json = await r.response.json().catch(() => ({}));
        return { data: null, error: json.message || `Audio fetch failed (${r.response.status})` };
      }
      return { data: await r.response.arrayBuffer(), error: null };
    },
  };
}
