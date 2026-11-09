// Privacy-friendly page-view beacon for the admin panel's "Traffic" section.
// No cookies, no third parties, no identifiers: it sends only the route path
// and an optional ?ref= campaign tag. The server keeps daily aggregates
// (services/identity-node/src/utils/siteTraffic.ts).
//
// Fire and forget: every step is wrapped so a missing endpoint, blocked
// storage or an old browser can never throw into the page or slow it down.

export const NO_TRACK_KEY = 'specter_no_track';
export const REF_KEY = 'specter_ref';
const REF_RE = /^[a-z0-9-]{1,40}$/;

const read = (storage, key) => {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
};
const write = (storage, key, value) => {
  try {
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch { /* storage unavailable */ }
};

/** This browser has opted out ("Don't count visits from this browser"). */
export const isOptedOut = (local) => read(local, NO_TRACK_KEY) === '1';
export const setOptedOut = (local, on) => write(local, NO_TRACK_KEY, on ? '1' : null);

const isAdminPath = (pathname) => /^\/auth\/admin(\/|$)/i.test(pathname || '');

export function shouldTrack(pathname, local) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  if (isAdminPath(pathname)) return false;
  return !isOptedOut(local);
}

/**
 * The session's campaign tag: a valid ?ref= on this URL wins and is kept in
 * sessionStorage, so later page views in the same tab carry it too.
 */
export function sessionRef(search, session) {
  let fromUrl = null;
  try { fromUrl = new URLSearchParams(search || '').get('ref'); } catch { /* ignore */ }
  const clean = typeof fromUrl === 'string' ? fromUrl.trim().toLowerCase() : '';
  if (REF_RE.test(clean)) {
    write(session, REF_KEY, clean);
    return clean;
  }
  const stored = read(session, REF_KEY);
  return stored && REF_RE.test(stored) ? stored : '';
}

/**
 * Records ?ref= from the current URL right away, before any redirect can
 * drop the query string. Never throws.
 */
export function rememberRef(search, session) {
  try { sessionRef(search, session ?? globalThis.sessionStorage); } catch { /* ignore */ }
}

/**
 * Sends one page view, or nothing if gated. Returns true when a beacon was
 * handed to the browser (for tests). `env` defaults to the real browser.
 */
export function sendPageview(url, pathname, search, env = {}) {
  try {
    const local = env.localStorage ?? globalThis.localStorage;
    const session = env.sessionStorage ?? globalThis.sessionStorage;
    const nav = env.navigator ?? globalThis.navigator;
    const doFetch = env.fetch ?? globalThis.fetch;
    if (!shouldTrack(pathname, local)) return false;

    const ref = sessionRef(search, session);
    const body = JSON.stringify(ref ? { path: pathname, ref } : { path: pathname });

    // A string body goes as text/plain: a "simple" request, no preflight.
    if (typeof nav?.sendBeacon === 'function') {
      try {
        if (nav.sendBeacon(url, body)) return true;
      } catch { /* fall through to fetch */ }
    }
    if (typeof doFetch === 'function') {
      Promise.resolve()
        .then(() => doFetch(url, {
          method: 'POST',
          body,
          keepalive: true,
          credentials: 'omit',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        }))
        .catch(() => {});
      return true;
    }
  } catch { /* never surface */ }
  return false;
}
