import { describe, it, expect, vi } from 'vitest';
import {
  sendPageview, shouldTrack, sessionRef, rememberRef, isOptedOut, setOptedOut, NO_TRACK_KEY, REF_KEY,
} from '../src/traffic.js';

const URL_ = '/api/metrics/pageview';

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _m: m,
  };
}
const brokenStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceeded'); },
  removeItem() { throw new Error('SecurityError'); },
};

function env(over = {}) {
  const beacons = [];
  return {
    beacons,
    localStorage: memStorage(),
    sessionStorage: memStorage(),
    navigator: { sendBeacon: vi.fn((url, body) => { beacons.push({ url, body: JSON.parse(body) }); return true; }) },
    fetch: vi.fn(() => Promise.resolve({ ok: true })),
    ...over,
  };
}

describe('beacon gating', () => {
  it('sends the path for a normal page view', () => {
    const e = env();
    expect(sendPageview(URL_, '/', '', e)).toBe(true);
    expect(e.beacons).toEqual([{ url: URL_, body: { path: '/' } }]);
  });

  it('sends nothing when this browser opted out', () => {
    const e = env({ localStorage: memStorage({ [NO_TRACK_KEY]: '1' }) });
    expect(sendPageview(URL_, '/', '', e)).toBe(false);
    expect(e.navigator.sendBeacon).not.toHaveBeenCalled();
    expect(e.fetch).not.toHaveBeenCalled();
  });

  it('the admin toggle round-trips through localStorage', () => {
    const local = memStorage();
    setOptedOut(local, true);
    expect(local.getItem(NO_TRACK_KEY)).toBe('1');
    expect(isOptedOut(local)).toBe(true);
    setOptedOut(local, false);
    expect(local.getItem(NO_TRACK_KEY)).toBeNull();
    expect(shouldTrack('/', local)).toBe(true);
  });

  it('never sends from /auth/admin routes', () => {
    for (const p of ['/auth/admin', '/auth/admin/', '/AUTH/ADMIN', '/auth/admin/x']) {
      const e = env();
      expect(sendPageview(URL_, p, '', e)).toBe(false);
      expect(e.navigator.sendBeacon).not.toHaveBeenCalled();
    }
    expect(shouldTrack('/auth', memStorage())).toBe(true);
    expect(shouldTrack('/auth/administrator', memStorage())).toBe(true); // not the admin route
  });

  it('falls back to fetch keepalive when sendBeacon is missing or refuses', () => {
    for (const navigator of [{}, { sendBeacon: () => false }, { sendBeacon: () => { throw new Error('x'); } }]) {
      const e = env({ navigator });
      expect(sendPageview(URL_, '/auth', '', e)).toBe(true);
    }
    const e = env({ navigator: {} });
    sendPageview(URL_, '/auth', '', e);
    return Promise.resolve().then(() => {
      expect(e.fetch).toHaveBeenCalledWith(URL_, expect.objectContaining({ method: 'POST', keepalive: true, credentials: 'omit' }));
    });
  });

  it('never throws: broken storage, rejected fetch, no transport at all', async () => {
    const rejected = env({ navigator: {}, fetch: () => Promise.reject(new Error('404')) });
    expect(() => sendPageview(URL_, '/', '', rejected)).not.toThrow();
    expect(() => sendPageview(URL_, '/', '', env({ localStorage: brokenStorage, sessionStorage: brokenStorage }))).not.toThrow();
    expect(sendPageview(URL_, '/', '', env({ navigator: {}, fetch: 'unavailable' }))).toBe(false);
    await new Promise((r) => setTimeout(r, 0)); // a rejected fetch must not surface as unhandled
  });
});

describe('ref persistence', () => {
  it('keeps a valid ?ref= for the rest of the session', () => {
    const e = env();
    sendPageview(URL_, '/', '?ref=Reddit', e);
    sendPageview(URL_, '/auth', '', e);
    expect(e.beacons.map((b) => b.body)).toEqual([
      { path: '/', ref: 'reddit' },
      { path: '/auth', ref: 'reddit' },
    ]);
    expect(e.sessionStorage.getItem(REF_KEY)).toBe('reddit');
  });

  it('a new valid ref replaces it; an invalid one is ignored', () => {
    const s = memStorage();
    expect(sessionRef('?ref=discord', s)).toBe('discord');
    expect(sessionRef('?ref=has%20space', s)).toBe('discord');
    expect(sessionRef(`?ref=${'a'.repeat(41)}`, s)).toBe('discord');
    expect(sessionRef('?ref=yt-launch', s)).toBe('yt-launch');
  });

  it('drops invalid refs entirely when nothing valid was seen', () => {
    const e = env();
    sendPageview(URL_, '/', '?ref=<script>', e);
    expect(e.beacons[0].body).toEqual({ path: '/' });
    expect(e.sessionStorage.getItem(REF_KEY)).toBeNull();
  });

  it('rememberRef captures the tag before a redirect strips the query', () => {
    const e = env();
    rememberRef('?ref=newsletter', e.sessionStorage);
    sendPageview(URL_, '/dashboard', '', e);
    expect(e.beacons[0].body).toEqual({ path: '/dashboard', ref: 'newsletter' });
    expect(() => rememberRef('?ref=x', brokenStorage)).not.toThrow();
  });
});
