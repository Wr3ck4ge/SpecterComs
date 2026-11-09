import { describe, it, expect } from 'vitest';
import { classifyDiagnosis, classifyPath, formatReport } from '../src/engine/connectionRepair.js';
import { applyAltPreference, waitForVoice } from '../src/engine/repairHandlers.js';
import { confirmHandshake, pickTarget } from '../src/engine/netDiagnostics.js';

const pkts = (...sizes) => sizes.map((size) => ({ port: 3479, size }));
const np = ({ version = false, quic = 'timeout', replied = [200, 1200, 1350, 1450], arrived = pkts(200, 1200, 1350, 1450), armed = true, relay = true } = {}) => ({
  armed, ports: armed ? [3479] : [], mainPort: 443, clientIp: '203.0.113.7',
  native: {
    udp: armed ? [{ port: 3479, sent: [200, 1200, 1350, 1450], replied, send_errors: [] }] : [],
    version: { port: 443, sent: [1200, 1350], replied: version },
    quic: [{ port: 443, result: quic, ms: 6000 }],
    dont_fragment: true,
  },
  relay: relay ? { packets: arrived, webtransport: 0 } : null,
});
const base = {
  api: { ok: true, ms: 40 }, ticket: { ok: true, status: 200, mediaUrl: 'https://spectercoms.net' },
  wt: { result: 'timeout', ms: 8000 }, wtAlt: { result: 'skipped' }, local: { quicDisabledBy: [], proxy: {} },
};
const kind = (netprobe, extra = {}) => classifyPath({ ...base, netprobe, ...extra })?.kind ?? null;

describe('classifyPath', () => {
  it('nothing arrived anywhere: all UDP blocked', () => {
    expect(kind(np({ arrived: [], replied: [] }))).toBe('udp_all_blocked');
  });
  it('the alternate port works but 443 does not: a port-specific block', () => {
    expect(kind(np())).toBe('udp443_blocked');
  });
  it('small packets arrive, 1200+ do not: MTU', () => {
    expect(kind(np({ arrived: pkts(200, 200), replied: [200] }))).toBe('mtu_blackhole');
  });
  it('UDP 443 answers but the handshake fails: DPI', () => {
    expect(kind(np({ version: true, quic: 'timeout' }))).toBe('quic_dpi');
    expect(kind(np({ version: true, quic: 'failed' }))).toBe('quic_dpi');
  });
  it('native QUIC works, WebView2 does not: browser QUIC blocked, handled natively', () => {
    const v = classifyPath({ ...base, netprobe: np({ version: true, quic: 'ok' }) });
    expect(v.kind).toBe('browser_quic_blocked');
    expect(v.severity).toBe('warn');
    expect(v.voiceReachable).toBe(true);
    expect(v.title).toMatch(/network blocks browser QUIC; using the native transport automatically/);
    expect(v.explanation).not.toMatch(/this PC/);
  });
  it('a native WebTransport handshake that reached the relay counts the same', () => {
    expect(kind(np({ quic: 'timeout' }), { wtNative: { result: 'rejected', ms: 90 } })).toBe('browser_quic_blocked');
    // Without a netprobe at all, classifyDiagnosis still says so.
    const v = classifyDiagnosis({ ...base, wtNative: { result: 'rejected', ms: 90 } });
    expect(v.kind).toBe('browser_quic_blocked');
    expect(v.voiceReachable).toBe(true);
    expect(classifyDiagnosis({ ...base, wtNative: { result: 'timeout', ms: 6000 } }).kind).toBe('quic_blocked');
  });
  it('packets arrive, replies do not: inbound blocked', () => {
    expect(kind(np({ replied: [] }))).toBe('inbound_blocked');
  });
  it('stays out of it when everything works or the evidence is thin', () => {
    expect(kind(np({ version: true, quic: 'ok' }), { wt: { result: 'rejected', ms: 100 } })).toBeNull();
    expect(kind(np({ armed: false }))).toBeNull();
    expect(kind(np({ relay: false }))).toBeNull();
    expect(classifyPath({})).toBeNull();
    expect(classifyPath({ netprobe: { armed: true, native: null } })).toBeNull();
  });
});

describe('classifyDiagnosis with the probe', () => {
  it('the path verdict replaces the generic QUIC message', () => {
    expect(classifyDiagnosis({ ...base, netprobe: np({ arrived: [], replied: [] }) }).kind).toBe('udp_all_blocked');
  });
  it('a Windows policy still wins: it names the exact cause', () => {
    expect(classifyDiagnosis({ ...base, netprobe: np({ version: true, quic: 'ok' }), local: { quicDisabledBy: ['X'], proxy: {} } }).kind).toBe('quic_policy');
  });
  it('policy + native works: worked around (a warning), else an error', () => {
    const local = { quicDisabledBy: ['HKLM Edge QuicAllowed'], proxy: {} };
    const viaQuic = classifyDiagnosis({ ...base, netprobe: np({ version: true, quic: 'ok' }), local });
    expect(viaQuic).toMatchObject({ kind: 'quic_policy', severity: 'warn', voiceReachable: true, workedAround: true });
    const viaWt = classifyDiagnosis({ ...base, wtNative: { result: 'rejected', ms: 70 }, local });
    expect(viaWt).toMatchObject({ severity: 'warn', workedAround: true });
    const blocked = classifyDiagnosis({ ...base, wtNative: { result: 'timeout', ms: 6000 }, local });
    expect(blocked).toMatchObject({ kind: 'quic_policy', severity: 'error', voiceReachable: false });
  });
  it('Blocked home network: 443 silent, alternate reachable: handled, with the cause recorded', () => {
    const v = classifyDiagnosis({ ...base, wtAlt: { result: 'rejected', ms: 80 }, netprobe: np() });
    expect(v).toMatchObject({ kind: 'quic_443_blocked_alt_ok', path: 'udp443_blocked', voiceReachable: true });
  });
  it('the report carries the probe detail', () => {
    const text = formatReport({ diag: { ...base, netprobe: np() }, appVersion: '2.0.12' });
    expect(text).toContain('public IP 203.0.113.7');
    expect(text).toContain('UDP 3479: sent 200/1200/1350/1450');
    expect(text).toContain('UDP 443 version check: no answer');
    expect(text).toContain('Native QUIC 443: timeout');
    expect(text).toContain('Relay saw: 3479:200');
  });
});

describe('confirmHandshake', () => {
  const rejected = { result: 'rejected', ms: 50, error: null };
  it('keeps a rejection the relay confirms, or that it could not have seen', () => {
    expect(confirmHandshake(rejected, { node_id: 'n' }, { webtransport: 1 })).toBe(rejected);
    expect(confirmHandshake(rejected, null, null)).toBe(rejected);
  });
  it('downgrades one that never reached an armed relay', () => {
    expect(confirmHandshake(rejected, { node_id: 'n' }, { webtransport: 0 }).result).toBe('error');
  });
});

describe('pickTarget', () => {
  const a = { node_id: 'a', public_url: 'https://a.example' };
  const b = { node_id: 'b', public_url: 'https://b.example/' };
  it('prefers the relay the ticket named', () => {
    expect(pickTarget([a, b], 'https://b.example')).toBe(b);
    expect(pickTarget([a, b], 'https://c.example')).toBe(a);
    expect(pickTarget([], 'https://a.example')).toBeNull();
  });
});

describe('applyAltPreference', () => {
  const store = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  it('sets it when 443 times out and the alternate answers, keyed by the public IP', () => {
    const s = store();
    const p = applyAltPreference({ wt: { result: 'timeout' }, wtAlt: { result: 'rejected' }, netprobe: { clientIp: '203.0.113.7' } }, s);
    expect(p).toMatchObject({ useAlt: true, publicIp: '203.0.113.7' });
  });
  it('clears it when 443 works again, and leaves it alone when nothing is known', () => {
    const s = store();
    applyAltPreference({ wt: { result: 'timeout' }, wtAlt: { result: 'open' } }, s);
    applyAltPreference({ wt: { result: 'timeout' }, wtAlt: { result: 'timeout' } }, s);
    expect(s.m.size).toBe(1);
    applyAltPreference({ wt: { result: 'rejected' } }, s);
    expect(s.m.size).toBe(0);
  });
});

describe('waitForVoice', () => {
  it('reports the port it connected on', async () => {
    const r = await waitForVoice(() => ({ status: 'connected', via: 'alt', port: 3478 }), 100, 1);
    expect(r).toEqual({ ok: true, message: 'Connected via alternate port 3478' });
  });
  it('fails on a classified block or the deadline', async () => {
    const r = await waitForVoice(() => ({ status: 'connecting', connectIssue: { kind: 'quic_blocked', message: 'blocked' } }), 100, 1);
    expect(r).toEqual({ ok: false, message: 'blocked' });
    expect((await waitForVoice(() => ({ status: 'connecting' }), 5, 1)).ok).toBe(false);
  });
});
