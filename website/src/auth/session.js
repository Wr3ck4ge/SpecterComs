// auth/session.js — the website's user session: where its tokens live, and the
// only code that refreshes them. Doesn't import api.js (api.js imports this
// for createApi's auth provider), so there's no import cycle.
//
// identity-node issues a 30-min access JWT plus a 30-day rotating refresh
// token, both in the response body — /auth/refresh and /auth/logout take the
// refresh token in the body too, no cookies anywhere. So the session is:
//  - in memory first: every request reads the tokens held here;
//  - mirrored to localStorage (specter_token, specter_refresh_token,
//    specter_user) so a reload or a second tab stays logged in. Trade-off:
//    anything that runs script on this origin (XSS) can read the refresh
//    token, exactly as it already could the access token. Moving it to an
//    HttpOnly cookie needs a cookie-based /auth/refresh server-side; until
//    then this keeps what's stored to the same three keys as before, wipes
//    them on logout/expiry, and logout revokes the refresh token server-side.
//
// Refresh is single-flight: concurrent callers (a burst of requests that all
// got a 401, or a proactive refresh near expiry) share one /auth/refresh, so
// the rotating refresh token is redeemed once. Tabs pick up each other's
// rotation through the `storage` event; if two tabs do race, the server's
// 60 s same-client grace window hands both the same successor.
//
// The session ends (local wipe + `specter:auth-expired` on window) only when
// the server rejects the refresh token (401/403) or there is none. A network
// error, 429 or 5xx keeps it — that request fails, the next one tries again.

export const TOKEN_KEY = 'specter_token';
export const REFRESH_KEY = 'specter_refresh_token';
export const USER_KEY = 'specter_user';
export const AUTH_EXPIRED_EVENT = 'specter:auth-expired';

// Refresh proactively once the access token has less than this left, so a
// request doesn't have to eat a 401 first.
export const REFRESH_LEEWAY_MS = 60_000;

export function jwtExpMs(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')));
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function browserStorage() {
  try { return window.localStorage; } catch { return null; }
}

// Everything environmental is injectable so the tests can drive it.
export function createSession({
  apiBase,
  fetchImpl = (...args) => fetch(...args),
  storage = browserStorage(),
  events = typeof window !== 'undefined' ? window : null,
  now = () => Date.now(),
} = {}) {
  const read = (k) => { try { return storage?.getItem(k) ?? null; } catch { return null; } };
  const write = (k, v) => {
    try {
      if (v == null) storage?.removeItem(k);
      else storage?.setItem(k, v);
    } catch { /* storage unavailable — the in-memory copy still works for this tab */ }
  };

  let token = read(TOKEN_KEY);
  let refreshToken = read(REFRESH_KEY);
  let refreshing = null;

  // Another tab logged in, rotated, or logged out.
  events?.addEventListener?.('storage', (e) => {
    if (e.key === TOKEN_KEY) token = e.newValue;
    else if (e.key === REFRESH_KEY) refreshToken = e.newValue;
    else if (e.key === null) { token = read(TOKEN_KEY); refreshToken = read(REFRESH_KEY); }
  });

  function wipe() {
    token = null;
    refreshToken = null;
    write(TOKEN_KEY, null);
    write(REFRESH_KEY, null);
    write(USER_KEY, null);
  }

  function expire() {
    wipe();
    events?.dispatchEvent?.(new CustomEvent(AUTH_EXPIRED_EVENT));
  }

  // One /auth/refresh at a time. Resolves to the new access token, or null.
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const presented = refreshToken;
      if (!presented) {
        if (token) expire();
        return null;
      }
      let resp;
      try {
        resp = await fetchImpl(`${apiBase}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: presented }),
        });
      } catch {
        return null; // network trouble — keep the session
      }
      const json = await resp.json().catch(() => ({}));
      if (resp.ok && json.token) {
        token = json.token;
        write(TOKEN_KEY, token);
        if (json.refresh_token) {
          refreshToken = json.refresh_token;
          write(REFRESH_KEY, refreshToken);
        }
        return token;
      }
      if (resp.status === 401 || resp.status === 403) {
        // Another tab may have rotated while this request was in flight; its
        // token is good, ours was just superseded.
        if (refreshToken && refreshToken !== presented) return token;
        expire();
      }
      return null;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    /** The access token for a request, refreshed first when it's about to expire. */
    async getToken() {
      if (!token) return null;
      const exp = jwtExpMs(token);
      if (exp && refreshToken && exp - now() < REFRESH_LEEWAY_MS) {
        const fresh = await refresh();
        // A failed proactive refresh that didn't end the session (network)
        // still hands back the old token while it's valid.
        if (fresh) return fresh;
        return token && exp > now() ? token : null;
      }
      return token;
    },

    /** After a 401 that carried `staleToken`: refresh once (shared) → new token, or null. */
    async onUnauthorized(staleToken) {
      if (token && token !== staleToken) return token; // already refreshed meanwhile
      return refresh();
    },

    hasSession() {
      return Boolean(token);
    },

    /** Stores a login's tokens and user. */
    setSession(accessToken, newRefreshToken, user) {
      token = accessToken;
      refreshToken = newRefreshToken || null;
      write(TOKEN_KEY, token);
      write(REFRESH_KEY, refreshToken);
      write(USER_KEY, user ? JSON.stringify(user) : null);
    },

    /** The stored user if there's a session to go with it, else null. */
    restoreUser() {
      if (!token) return null;
      try {
        const user = JSON.parse(read(USER_KEY) || 'null');
        if (user) return user;
      } catch { /* fall through */ }
      wipe();
      return null;
    },

    /** Revokes the refresh token server-side (best effort), then forgets everything. */
    async logout() {
      const presented = refreshToken;
      wipe();
      if (!presented) return;
      try {
        await fetchImpl(`${apiBase}/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: presented }),
        });
      } catch { /* logged out locally regardless */ }
    },
  };
}
