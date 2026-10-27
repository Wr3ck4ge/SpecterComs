// auth/tokenStore.js — where the session's tokens live, and the only code that
// refreshes them. Low-level on purpose: it doesn't import api.js (api.js
// imports this, for fetchWithAuth's token and 401 handling), so there's no
// import cycle. The login/restore/logout flows built on top of it are in
// auth/session.js.
//
// Desktop (Tauri): Rust owns the session (src-tauri/src/session.rs). Tokens
// never sit in JS storage; every window asks Rust for a token, and Rust
// refreshes single-flight so several windows (main, tray strip) plus the Rust
// background sync can't race on the rotating refresh token — the server
// treats a reused refresh token as theft and revokes every session the user
// has. Rust emits `auth-changed` ({ user, reason }) to all windows.
//
// Browser (no Tauri): the old localStorage behaviour — specter_token,
// specter_refresh_token, specter_user — with an in-tab single-flight refresh.
// Changes are announced on `window` as a `specter:auth-changed` CustomEvent
// with the same { user, reason } shape.
//
// Both: specter_user stays mirrored in localStorage, because plenty of UI code
// reads the user's id/callsign from it synchronously.

import { invoke } from '@tauri-apps/api/core';
import { API_BASE_URL } from '../apiBase.js';

export const isTauri = () => Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);

const USER_KEY = 'specter_user';
const TOKEN_KEY = 'specter_token';
const REFRESH_KEY = 'specter_refresh_token';
const BROWSER_EVENT = 'specter:auth-changed';

function mirrorUser(user) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch { /* storage unavailable — callers fall back to their own state */ }
}

// ── Tauri ────────────────────────────────────────────────────────────────────

let configured = null;
// Hands Rust the build-time API base once per window (Rust keeps the first
// value it gets), and drops the plaintext tokens older builds kept in
// localStorage — the encrypted credential file Rust reads is the real copy.
function ready() {
  if (!configured) {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
    } catch { /* ignore */ }
    configured = invoke('auth_configure', { apiBase: API_BASE_URL }).catch((err) => {
      console.warn('auth_configure failed:', err);
    });
  }
  return configured;
}

// A short-lived copy of the access token so every API call isn't an IPC round
// trip. Reused only while it has comfortably more life left than Rust's own
// refresh leeway (120 s), so Rust would have handed back the same token anyway.
// An access token stays valid until it expires even after another window
// refreshes, so a cached one is never wrong, just older.
let cached = null; // { token, exp } (exp in ms)
const CACHE_MIN_REMAINING_MS = 180_000;

function jwtExpMs(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')));
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function cacheToken(token) {
  const exp = token ? jwtExpMs(token) : null;
  cached = token && exp ? { token, exp } : null;
  return token || null;
}

const tauriStore = {
  async getToken() {
    if (cached && cached.exp - Date.now() > CACHE_MIN_REMAINING_MS) return cached.token;
    await ready();
    return cacheToken(await invoke('auth_get_token'));
  },
  async onUnauthorized(staleToken) {
    cached = null;
    await ready();
    return cacheToken(await invoke('auth_refresh', { staleToken: staleToken || null }));
  },
  async restore() {
    await ready();
    const res = await invoke('auth_restore');
    if (res?.status === 'ok') mirrorUser(res.user);
    return res;
  },
  async setSession(token, refreshToken, user) {
    await ready();
    cacheToken(token);
    mirrorUser(user);
    await invoke('auth_set_session', { token, refreshToken: refreshToken || null, user });
  },
  async setUser(user) {
    await ready();
    mirrorUser(user);
    await invoke('auth_set_user', { user });
  },
  async current() {
    await ready();
    return invoke('auth_current');
  },
  async clear() {
    cached = null;
    mirrorUser(null);
    await ready();
    await invoke('auth_logout');
  },
  onAuthChanged(cb) {
    let unlisten = null;
    let stopped = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen('auth-changed', (e) => {
        const payload = e.payload || {};
        if (!payload.user) cached = null;
        mirrorUser(payload.user || null);
        cb(payload);
      }))
      .then((fn) => { if (stopped) fn(); else unlisten = fn; })
      .catch((err) => console.warn('auth-changed listener failed:', err));
    return () => { stopped = true; if (unlisten) unlisten(); };
  },
};

// ── Browser ──────────────────────────────────────────────────────────────────

function browserEmit(user, reason) {
  window.dispatchEvent(new CustomEvent(BROWSER_EVENT, { detail: { user, reason } }));
}

function readUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}

function browserClearLocal() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

let browserRefreshing = null;

const browserStore = {
  async getToken() {
    return localStorage.getItem(TOKEN_KEY);
  },
  onUnauthorized(staleToken) {
    if (browserRefreshing) return browserRefreshing;
    browserRefreshing = (async () => {
      const current = localStorage.getItem(TOKEN_KEY);
      if (current && current !== staleToken) return current; // someone already refreshed
      const refreshToken = localStorage.getItem(REFRESH_KEY);
      if (!refreshToken) {
        browserClearLocal();
        browserEmit(null, 'expired');
        return null;
      }
      let resp;
      try {
        resp = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch {
        return null; // network trouble — keep the session, the request just fails
      }
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && json.token) {
        localStorage.setItem(TOKEN_KEY, json.token);
        if (json.refresh_token) localStorage.setItem(REFRESH_KEY, json.refresh_token);
        browserEmit(readUser(), 'refresh');
        return json.token;
      }
      if (resp.status === 401 || resp.status === 403) {
        browserClearLocal();
        browserEmit(null, 'expired');
      }
      return null;
    })().finally(() => { browserRefreshing = null; });
    return browserRefreshing;
  },
  async restore() {
    const token = localStorage.getItem(TOKEN_KEY);
    const raw = localStorage.getItem(USER_KEY);
    if (!token || !raw) return { status: 'none' };
    try {
      return { status: 'ok', user: JSON.parse(raw) };
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      return { status: 'none' };
    }
  },
  async setSession(token, refreshToken, user) {
    localStorage.setItem(TOKEN_KEY, token);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
    mirrorUser(user);
    browserEmit(user, 'login');
  },
  async setUser(user) {
    mirrorUser(user);
    browserEmit(user, 'user');
  },
  async current() {
    return localStorage.getItem(TOKEN_KEY) ? readUser() : null;
  },
  async clear() {
    // Revoke the refresh token server-side (best effort), then forget it.
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    browserClearLocal();
    if (refreshToken) {
      fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }).catch(() => {});
    }
    browserEmit(null, 'logout');
  },
  onAuthChanged(cb) {
    const handler = (e) => cb(e.detail || {});
    window.addEventListener(BROWSER_EVENT, handler);
    return () => window.removeEventListener(BROWSER_EVENT, handler);
  },
};

// ── Public ───────────────────────────────────────────────────────────────────

const store = () => (isTauri() ? tauriStore : browserStore);

/** A valid access token, or null when logged out. */
export const getToken = () => store().getToken();
/** After a 401 with `staleToken`: refresh once (shared) → new token, or null if the session is over. */
export const refreshAfterUnauthorized = (staleToken) => store().onUnauthorized(staleToken);
/** { status: 'ok', user } | { status: 'none' } | { status: 'offline', error } | { status: 'legacy', email, password } */
export const restoreStored = () => store().restore();
export const setSession = (token, refreshToken, user) => store().setSession(token, refreshToken, user);
export const setUser = (user) => store().setUser(user);
/** The logged-in user, or null. */
export const currentUser = () => store().current();
/** Local + server-side logout; every window hears auth-changed { user: null, reason: 'logout' }. */
export const clearSession = () => store().clear();
/** cb({ user, reason }) — reason: login | restore | refresh | user | logout | expired. Returns unsubscribe. */
export const onAuthChanged = (cb) => store().onAuthChanged(cb);

/** What createApi (packages/shared-web) uses for the user session. */
export const apiAuthProvider = {
  getToken,
  onUnauthorized: refreshAfterUnauthorized,
};
