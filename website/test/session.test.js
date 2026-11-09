import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createApi } from '@spectercoms/shared-web/src/api.js';
import { createSession, TOKEN_KEY, REFRESH_KEY, USER_KEY, AUTH_EXPIRED_EVENT } from '../src/auth/session.js';

const API = 'https://api.test';

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

// An unsigned JWT-shaped token with the given exp (seconds) — the session
// only decodes the payload, it never verifies.
function jwt(name, expSec) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub: name, exp: expSec })}.sig`;
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => body });

const NOW = 1_800_000_000_000;
const FAR = NOW / 1000 + 1800;   // 30 min left
const NEAR = NOW / 1000 + 20;    // inside the 60 s leeway

let storage, events, expired, routes, calls;

function setup({ token = jwt('old', FAR), refresh = 'r1' } = {}) {
  storage = memoryStorage({
    ...(token ? { [TOKEN_KEY]: token } : {}),
    ...(refresh ? { [REFRESH_KEY]: refresh } : {}),
    [USER_KEY]: JSON.stringify({ id: 'u1', callsign: 'Ghost' }),
  });
  events = new EventTarget();
  expired = 0;
  events.addEventListener(AUTH_EXPIRED_EVENT, () => { expired += 1; });
  calls = [];
  routes = {};
  const fetchImpl = vi.fn(async (url, opts = {}) => {
    const path = url.slice(API.length);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, auth: opts.headers?.Authorization ?? null, body });
    const handler = routes[path];
    if (!handler) return json(404, {});
    return handler({ auth: opts.headers?.Authorization ?? null, body });
  });
  vi.stubGlobal('fetch', fetchImpl);
  const session = createSession({ apiBase: API, fetchImpl, storage, events, now: () => NOW });
  const { api, fetchWithAuth } = createApi(API, session);
  return { session, api, fetchWithAuth };
}

const refreshCalls = () => calls.filter((c) => c.path === '/auth/refresh');

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('website session: refresh on 401', () => {
  it('refreshes once, retries the original request with the new token', async () => {
    const { api } = setup();
    const fresh = jwt('new', FAR);
    routes['/auth/refresh'] = ({ body }) => (body.refresh_token === 'r1' ? json(200, { token: fresh, refresh_token: 'r2' }) : json(401, {}));
    routes['/users/me'] = ({ auth }) => (auth === `Bearer ${fresh}` ? json(200, { id: 'u1' }) : json(401, {}));

    const res = await api.getMyProfile();

    expect(res).toEqual({ data: { id: 'u1' }, error: null });
    expect(refreshCalls()).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/users/me').map((c) => c.auth)).toEqual([expect.stringContaining('Bearer '), `Bearer ${fresh}`]);
    // The rotated refresh token is what's kept now.
    expect(storage.dump()[REFRESH_KEY]).toBe('r2');
    expect(storage.dump()[TOKEN_KEY]).toBe(fresh);
    expect(expired).toBe(0);
  });

  it('is single-flight: concurrent 401s share one /auth/refresh', async () => {
    const { api } = setup();
    const fresh = jwt('new', FAR);
    let release;
    const gate = new Promise((r) => { release = r; });
    routes['/auth/refresh'] = async () => { await gate; return json(200, { token: fresh, refresh_token: 'r2' }); };
    routes['/users/me'] = ({ auth }) => (auth === `Bearer ${fresh}` ? json(200, { ok: 1 }) : json(401, {}));
    routes['/friends'] = ({ auth }) => (auth === `Bearer ${fresh}` ? json(200, { ok: 2 }) : json(401, {}));
    routes['/orgs/me'] = ({ auth }) => (auth === `Bearer ${fresh}` ? json(200, { ok: 3 }) : json(401, {}));

    const pending = Promise.all([api.getMyProfile(), api.getFriends(), api.getMyOrgs()]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await pending;

    expect(results.map((r) => r.data)).toEqual([{ ok: 1 }, { ok: 2 }, { ok: 3 }]);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('retries only once — a second 401 is returned as an error, no refresh loop', async () => {
    const { api } = setup();
    routes['/auth/refresh'] = () => json(200, { token: jwt('new', FAR), refresh_token: 'r2' });
    routes['/users/me'] = () => json(401, { message: 'nope' });

    const res = await api.getMyProfile();

    expect(res.error).toBe('nope');
    expect(refreshCalls()).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/users/me')).toHaveLength(2);
  });

  it('logs out (wipes storage, fires auth-expired) when the server rejects the refresh token', async () => {
    const { api, session } = setup();
    routes['/auth/refresh'] = () => json(401, { message: 'Refresh token has already been used' });
    routes['/users/me'] = () => json(401, {});

    const res = await api.getMyProfile();

    expect(res.data).toBeNull();
    expect(expired).toBe(1);
    expect(session.hasSession()).toBe(false);
    expect(storage.dump()).toEqual({});
  });

  it('keeps the session when refresh fails transiently (network / 5xx)', async () => {
    const { api, session } = setup();
    routes['/auth/refresh'] = () => { throw new TypeError('Failed to fetch'); };
    routes['/users/me'] = () => json(401, {});

    await api.getMyProfile();
    expect(expired).toBe(0);
    expect(session.hasSession()).toBe(true);

    routes['/auth/refresh'] = () => json(503, {});
    await api.getMyProfile();
    expect(expired).toBe(0);
    expect(storage.dump()[REFRESH_KEY]).toBe('r1');
  });

  it('a pre-refresh-token session (no refresh token stored) ends on 401, as before', async () => {
    const { api } = setup({ refresh: null });
    routes['/users/me'] = () => json(401, {});

    await api.getMyProfile();

    expect(refreshCalls()).toHaveLength(0);
    expect(expired).toBe(1);
  });

  it('a 401 from /auth/* (wrong password) never triggers a refresh or a logout', async () => {
    const { api } = setup();
    routes['/auth/login'] = () => json(401, { message: 'Invalid credentials' });

    const res = await api.login({ email: 'a@b.c', password: 'x' });

    expect(res.error).toBe('Invalid credentials');
    expect(refreshCalls()).toHaveLength(0);
    expect(expired).toBe(0);
  });
});

describe('website session: proactive refresh', () => {
  it('refreshes before the request when the access token is about to expire', async () => {
    const { api } = setup({ token: jwt('old', NEAR) });
    const fresh = jwt('new', FAR);
    routes['/auth/refresh'] = () => json(200, { token: fresh, refresh_token: 'r2' });
    routes['/users/me'] = ({ auth }) => json(200, { auth });

    const res = await api.getMyProfile();

    expect(res.data.auth).toBe(`Bearer ${fresh}`);
    expect(calls.map((c) => c.path)).toEqual(['/auth/refresh', '/users/me']);
  });

  it('concurrent requests near expiry share one proactive refresh', async () => {
    const { api } = setup({ token: jwt('old', NEAR) });
    routes['/auth/refresh'] = () => json(200, { token: jwt('new', FAR), refresh_token: 'r2' });
    routes['/users/me'] = () => json(200, {});
    routes['/friends'] = () => json(200, {});

    await Promise.all([api.getMyProfile(), api.getFriends(), api.getMyProfile()]);

    expect(refreshCalls()).toHaveLength(1);
  });

  it('does not refresh a token with plenty of life left', async () => {
    const { api } = setup();
    routes['/users/me'] = () => json(200, {});
    await api.getMyProfile();
    expect(refreshCalls()).toHaveLength(0);
  });
});

describe('website session: login / logout', () => {
  it('setSession stores the access token, refresh token and user', () => {
    const { session } = setup({ token: null, refresh: null });
    session.setSession('acc', 'ref', { id: 'u9' });
    expect(storage.dump()).toEqual({ [TOKEN_KEY]: 'acc', [REFRESH_KEY]: 'ref', [USER_KEY]: '{"id":"u9"}' });
    expect(session.restoreUser()).toEqual({ id: 'u9' });
  });

  it('logout revokes the refresh token server-side and clears local state', async () => {
    const { session } = setup();
    routes['/auth/logout'] = () => json(200, { message: 'Logged out' });

    await session.logout();

    expect(calls).toEqual([{ path: '/auth/logout', auth: null, body: { refresh_token: 'r1' } }]);
    expect(storage.dump()).toEqual({});
    expect(session.hasSession()).toBe(false);
  });

  it('logout still clears locally when the server is unreachable', async () => {
    const { session } = setup();
    routes['/auth/logout'] = () => { throw new TypeError('offline'); };
    await session.logout();
    expect(storage.dump()).toEqual({});
  });

  it('picks up another tab rotating the refresh token', async () => {
    const { session } = setup();
    const ev = new Event('storage');
    Object.assign(ev, { key: REFRESH_KEY, newValue: 'r-from-other-tab' });
    events.dispatchEvent(ev);
    routes['/auth/logout'] = () => json(200, {});
    await session.logout();
    expect(calls[0].body).toEqual({ refresh_token: 'r-from-other-tab' });
  });
});
