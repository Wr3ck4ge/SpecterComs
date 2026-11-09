import { describe, it, expect, vi } from 'vitest';
import {
  ALT_PREF_KEY, ALT_PREF_TTL_MS, chooseMediaUrl, classifyConnectFailure, classifyDiagnosis, connectIssueFrom,
  describeVia, formatReport, portOfUrl, readAltPref, runRepairSteps, writeAltPref,
} from '../src/engine/connectionRepair.js';

const MAIN = 'https://spectercoms.net';
const ALT = 'https://spectercoms.net:3478';
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

describe('classifyConnectFailure', () => {
  it('splits ticket, timeout and fast rejection', () => {
    expect(classifyConnectFailure({ phase: 'setup', elapsedMs: 0, message: 'Failed to acquire media ticket' })).toBe('ticket');
    expect(classifyConnectFailure({ phase: 'transport', elapsedMs: 8000, message: 'Opening handshake failed.' })).toBe('timeout');
    expect(classifyConnectFailure({ phase: 'transport', elapsedMs: 300, message: 'Opening handshake failed.' })).toBe('rejected');
    expect(classifyConnectFailure({ phase: 'transport', elapsedMs: 300, message: 'connection timed out' })).toBe('timeout');
  });
});

describe('connectIssueFrom', () => {
  it('stays quiet for one blip, then calls it a QUIC block with the API up', () => {
    expect(connectIssueFrom({ timeouts: 1, apiReachable: true })).toBeNull();
    expect(connectIssueFrom({ timeouts: 2, apiReachable: true }).kind).toBe('quic_blocked');
    expect(connectIssueFrom({ timeouts: 2, apiReachable: false })).toBeNull();
  });
  it('holds back while the alternate port is still to be tried, but not after giving up', () => {
    expect(connectIssueFrom({ timeouts: 2, apiReachable: true, altUntried: true })).toBeNull();
    expect(connectIssueFrom({ timeouts: 2, apiReachable: true, altUntried: true, gaveUp: true }).gaveUp).toBe(true);
  });
  it('a give-up without timeouts is a generic failure', () => {
    expect(connectIssueFrom({ gaveUp: true, attempts: 8 }).kind).toBe('connect_failed');
  });
});

describe('chooseMediaUrl', () => {
  it('uses the main port by default, and when the relay offers no alternate', () => {
    expect(chooseMediaUrl({ mediaUrl: MAIN, altMediaUrl: ALT })).toMatchObject({ url: MAIN, via: 'main' });
    expect(chooseMediaUrl({ mediaUrl: MAIN, timeouts: { main: 9 } })).toMatchObject({ url: MAIN, reason: 'no_alt' });
  });
  it('moves to the alternate after repeated timeouts on the main port', () => {
    expect(chooseMediaUrl({ mediaUrl: MAIN, altMediaUrl: ALT, timeouts: { main: 1 } }).via).toBe('main');
    expect(chooseMediaUrl({ mediaUrl: MAIN, altMediaUrl: ALT, timeouts: { main: 2 } })).toMatchObject({ url: ALT, via: 'alt', reason: 'main_timeouts' });
  });
  it('starts on the alternate with a network preference, and backs off when it fails too', () => {
    const pref = { useAlt: true };
    expect(chooseMediaUrl({ mediaUrl: MAIN, altMediaUrl: ALT, pref })).toMatchObject({ via: 'alt', reason: 'network_pref' });
    expect(chooseMediaUrl({ mediaUrl: MAIN, altMediaUrl: ALT, pref, timeouts: { alt: 2 } })).toMatchObject({ via: 'main', reason: 'alt_failing' });
  });
  it('a preference without an offered alternate is ignored', () => {
    expect(chooseMediaUrl({ mediaUrl: MAIN, pref: { useAlt: true } }).url).toBe(MAIN);
  });
  it('Blocked home network: two 443 timeouts, then the third attempt goes to the alternate', () => {
    const timeouts = { main: 0, alt: 0 };
    const used = [];
    for (let i = 0; i < 3; i++) {
      const c = chooseMediaUrl({ mediaUrl: MAIN, altMediaUrl: ALT, timeouts });
      used.push(c.via);
      if (c.via === 'main') timeouts.main += 1;
    }
    expect(used).toEqual(['main', 'main', 'alt']);
  });
});

describe('alternate-port preference', () => {
  it('round-trips, expires and clears', () => {
    const s = store();
    expect(readAltPref(s)).toBeNull();
    writeAltPref(s, { useAlt: true, publicIp: '203.0.113.7' }, 1000);
    expect(readAltPref(s, 2000)).toMatchObject({ useAlt: true, publicIp: '203.0.113.7' });
    expect(readAltPref(s, 1000 + ALT_PREF_TTL_MS + 1)).toBeNull();
    writeAltPref(s, { useAlt: false });
    expect(s.getItem(ALT_PREF_KEY)).toBeNull();
  });
  it('survives junk and a throwing store', () => {
    const s = store();
    s.setItem(ALT_PREF_KEY, '{nope');
    expect(readAltPref(s)).toBeNull();
    expect(readAltPref({ getItem: () => { throw new Error('blocked'); } })).toBeNull();
    expect(writeAltPref({ setItem: () => { throw new Error('full'); } }, { useAlt: true })).toBeNull();
  });
});

describe('ports', () => {
  it('reads the port and words it', () => {
    expect(portOfUrl(MAIN)).toBe(443);
    expect(portOfUrl(ALT)).toBe(3478);
    expect(portOfUrl('nope')).toBeNull();
    expect(describeVia('alt', 3478)).toBe('Connected via alternate port 3478');
    expect(describeVia('main', 443)).toBe('Connected via port 443');
    expect(describeVia(null)).toBe('');
  });
});

describe('classifyDiagnosis', () => {
  const healthy = {
    api: { ok: true, ms: 40 }, ticket: { ok: true, status: 200, mediaUrl: MAIN, altMediaUrl: null },
    wt: { result: 'rejected', ms: 120 }, wtAlt: { result: 'skipped' }, local: { quicDisabledBy: [], proxy: {} },
    mls: { checked: 3, behind: [], missing: [], errors: 0, keyPackage: 'present' },
  };
  it('healthy', () => { expect(classifyDiagnosis(healthy)).toMatchObject({ kind: 'ok', voiceReachable: true }); });
  it('API down beats everything', () => {
    expect(classifyDiagnosis({ ...healthy, api: { ok: false, error: 'x' } }).kind).toBe('api_unreachable');
  });
  it('a refused ticket is not a network problem', () => {
    expect(classifyDiagnosis({ ...healthy, ticket: { ok: false, status: 'error', error: 'update' } }).kind).toBe('ticket_failed');
  });
  it('names the QuicAllowed policy when it found one', () => {
    const v = classifyDiagnosis({ ...healthy, wt: { result: 'timeout', ms: 8000 }, local: { quicDisabledBy: ['HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge'], proxy: {} } });
    expect(v.kind).toBe('quic_policy');
    expect(v.explanation).toContain('HKLM');
  });
  it('a 443 timeout with the alternate reachable', () => {
    const v = classifyDiagnosis({ ...healthy, wt: { result: 'timeout', ms: 8000 }, wtAlt: { result: 'rejected', ms: 90 } });
    expect(v).toMatchObject({ kind: 'quic_443_blocked_alt_ok', voiceReachable: true, severity: 'warn' });
  });
  it('a 443 timeout with nothing else gives targeted steps', () => {
    const v = classifyDiagnosis({ ...healthy, wt: { result: 'timeout', ms: 8000 } });
    expect(v.kind).toBe('quic_blocked');
    expect(v.explanation).toContain('UDP port 443');
    expect(v.steps.join(' ')).toMatch(/hotspot/);
    expect(v.steps.join(' ')).toMatch(/VPN/);
  });
  it('mentions a system proxy when one is set', () => {
    const v = classifyDiagnosis({ ...healthy, wt: { result: 'timeout' }, local: { quicDisabledBy: [], proxy: { enabled: true, server: 'p:8080' } } });
    expect(v.steps.join(' ')).toContain('p:8080');
  });
  it('encryption problems only surface once the transport is fine', () => {
    const v = classifyDiagnosis({ ...healthy, mls: { ...healthy.mls, behind: [{}] } });
    expect(v).toMatchObject({ kind: 'encryption', voiceReachable: true });
  });
});

describe('runRepairSteps', () => {
  it('runs in order, reports progress and survives a throwing step', async () => {
    const order = [];
    const seen = [];
    const r = await runRepairSteps([
      { id: 'a', label: 'A', run: async () => { order.push('a'); return { ok: true, message: 'fine' }; } },
      { id: 'b', label: 'B', run: async () => { order.push('b'); throw new Error('boom'); } },
      { id: 'c', label: 'C', run: async () => { order.push('c'); return { ok: true, skipped: true, message: 'n/a' }; } },
    ], (s) => seen.push(s.map((x) => x.status).join()));
    expect(order).toEqual(['a', 'b', 'c']);
    expect(r.map((x) => x.status)).toEqual(['ok', 'fail', 'skipped']);
    expect(r[1].message).toBe('boom');
    expect(seen[0]).toBe('pending,pending,pending');
    expect(seen).toContain('running,pending,pending');
  });
  it('stops early on { stop: true }', async () => {
    const later = vi.fn();
    const r = await runRepairSteps([
      { id: 'a', label: 'A', run: async () => ({ ok: false, stop: true }) },
      { id: 'b', label: 'B', run: later },
    ]);
    expect(later).not.toHaveBeenCalled();
    expect(r[1].status).toBe('skipped');
  });
});

describe('formatReport', () => {
  it('carries the verdict, the checks and the repair results', () => {
    const text = formatReport({
      appVersion: '2.0.12', at: new Date('2026-11-03T00:00:00Z'),
      diag: { api: { ok: true, ms: 40 }, ticket: { ok: true, mediaUrl: MAIN, altMediaUrl: ALT }, wt: { result: 'timeout', ms: 8000 }, wtAlt: { result: 'rejected', ms: 90 } },
      steps: [{ label: 'Reconnect voice', status: 'ok', message: 'Connected via alternate port 3478' }],
    });
    expect(text).toContain('(v2.0.12)');
    expect(text).toContain('[quic_443_blocked_alt_ok]');
    expect(text).toContain('main port: timeout after 8000 ms');
    expect(text).toContain('[OK] Reconnect voice: Connected via alternate port 3478');
  });
});
