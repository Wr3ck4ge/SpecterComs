// auth/session.js — login, register, restore and logout for any window (the
// main window's AuthScreen today, the tray strip's compact login in S9).
// Token storage and refresh live one level down in auth/tokenStore.js (Rust
// on desktop, localStorage in a browser); this module is the flows on top.
//
//   restore()                      → user | null   (on startup)
//   login({ email, password })     → { user, error }
//   register({ callsign, global_tag, email, password }) → { data, error }
//   forgotPassword(email)          → { data, error }
//   logout()                       → logs out every window
//   getToken()                     → access token | null
//   currentUser()                  → user | null
//   onAuthChanged(cb)              → unsubscribe; cb({ user, reason })

import { invoke } from '@tauri-apps/api/core';
import { api } from '../api.js';
import {
  isTauri,
  restoreStored,
  setSession,
  setUser,
  clearSession,
} from './tokenStore.js';

export { isTauri, getToken, currentUser, onAuthChanged } from './tokenStore.js';

// Compare semver strings: returns true if remote > local
function isNewerVersion(remote, local) {
  if (!remote || !local) return false;
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

// The login response's latest_version is only a hint to check for an update
// now rather than at the next scheduled check — Rust (updater.rs) still does
// the real check, download and install.
export async function checkVersionFromLogin(latestVersion) {
  if (!isTauri() || !latestVersion) return;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const currentVersion = await getVersion();
    console.log(`Version check: current=${currentVersion}, server=${latestVersion}`);
    if (isNewerVersion(latestVersion, currentVersion)) {
      await invoke('updater_check_now');
    }
  } catch (e) {
    console.error('Version check failed:', e);
  }
}

async function getHwid() {
  try {
    return await invoke('get_hwid');
  } catch (err) {
    console.warn('HWID native call failed, using fallback:', err);
    return 'browser-fallback-hwid';
  }
}

async function adoptLogin(data) {
  // Desktop: Rust encrypts and persists it for the next launch, and tells
  // every other window. Browser: localStorage, as before.
  await setSession(data.token, data.refresh_token || null, data.user).catch((err) => {
    console.log('Saving session failed:', err);
  });
  if (data.latest_version) checkVersionFromLogin(data.latest_version);
}

/** Logs in; on success the session is stored and every window is told. */
export async function login({ email, password }) {
  const hwid = await getHwid();
  const { data, error } = await api.login({ email, password, hwid });
  if (error) return { user: null, error };
  await adoptLogin(data);
  return { user: data.user, error: null };
}

/** Creates an account. Doesn't log in — the UI sends the user to the login form. */
export async function register({ callsign, global_tag, email, password }) {
  const hwid = await getHwid();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const payload = { callsign, email, password, hwid, timezone };
  if (global_tag) payload.global_tag = global_tag;
  return api.register(payload);
}

export const forgotPassword = (email) => api.forgotPassword(email);

/** Ends the session everywhere (and revokes the refresh token server-side). */
export async function logout() {
  await clearSession().catch((err) => console.log('Logout failed:', err));
}

/**
 * Startup restore for a secondary window (the tray strip): the saved session
 * → user, or null, WITHOUT restore()'s profile re-fetch and its
 * clear-the-session-on-failure. The main window still runs restore() at
 * launch; its fresh profile reaches this window as auth-changed "user", and a
 * legacy migration it does arrives as "login". Keeps a network blip in a
 * second window from logging every window out.
 */
export async function restoreQuiet() {
  try {
    const saved = await restoreStored();
    return saved?.status === 'ok' ? saved.user : null;
  } catch (err) {
    console.log('Session restore failed:', err?.message || err);
    return null;
  }
}

/**
 * Restores a saved session on startup → user, or null for the login screen.
 * Desktop: Rust loads the encrypted saved session (once per process — a
 * second window gets the in-memory one), refreshing the access token if it's
 * stale, then the profile is re-fetched so the user snapshot is current.
 * Browser: whatever's in localStorage, without a profile fetch (as before).
 */
export async function restore() {
  let saved;
  try {
    saved = await restoreStored();
  } catch (err) {
    console.log('Auto-login failed:', err?.message || err);
    return null;
  }

  if (saved?.status === 'ok') {
    if (!isTauri()) return saved.user;
    const { data, error } = await api.getMyProfile();
    if (error || !data) {
      console.log('Auto-login failed:', error);
      await clearSession().catch(() => {});
      return null;
    }
    // getMyProfile returns { user: {...} }
    const profileUser = data.user || data;
    await setUser(profileUser).catch(() => {});
    return profileUser;
  }

  if (saved?.status === 'legacy') {
    // One-time migration from builds that saved the email/password itself:
    // log in with them once; the token session saved by adoptLogin replaces
    // the old file contents (Rust writes only token/refresh/user).
    console.log('Attempting one-time migration from legacy saved credentials...');
    const hwid = await getHwid();
    const { data, error } = await api.login({ email: saved.email, password: saved.password, hwid });
    if (error || !data?.token) {
      console.log('Auto-login failed:', error);
      await clearSession().catch(() => {});
      return null;
    }
    await adoptLogin(data);
    return data.user;
  }

  if (saved?.status === 'offline') {
    // Couldn't reach the server to refresh. Same as before: login screen,
    // saved session kept on disk for the next launch.
    console.log('Auto-login failed:', saved.error);
  }
  return null;
}
