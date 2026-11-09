import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NativeWebTransport, FRAME, encodeFrames, parseFrames } from '../src/engine/nativeWebTransport.js';
import {
  createTransport, readTransportPref, writeTransportPref, forcedTransportMode, redactUrl,
  TRANSPORT_PREF_KEY, TRANSPORT_FORCE_KEY, _resetTransportFactoryForTests,
} from '../src/engine/transportFactory.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const bytes = (...b) => new Uint8Array(b);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };

/** A fake native_wt backend: records invokes, lets the test push frames. */
function mockBackend({ connectError = null, maxDatagramSize = 1100, delayMs = 0 } = {}) {
  const calls = [];
  let channel = null;
  let nextStream = 100;
  class Channel { constructor() { this.onmessage = () => {}; channel = this; } }
  const invoke = vi.fn(async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === 'nwt_connect') {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (connectError) throw connectError;
      return { id: 7, maxDatagramSize };
    }
    if (cmd === 'nwt_open_uni') return nextStream++;
    return null;
  });
  return {
    deps: { invoke, Channel },
    calls,
    push: (frames) => channel.onmessage(encodeFrames(frames)),
    of: (cmd) => calls.filter((c) => c.cmd === cmd),
  };
}

describe('frame codec', () => {
  it('round-trips frames, including several in one message', () => {
    const buf = encodeFrames([
      { kind: FRAME.DATAGRAM, payload: bytes(1, 2) },
      { kind: FRAME.STREAM_DATA, id: 3, payload: bytes(9) },
      { kind: FRAME.STREAM_FIN, id: 3 },
    ]);
    const f = parseFrames(buf);
    expect(f.map((x) => [x.kind, x.id, [...x.payload]])).toEqual([[1, 0, [1, 2]], [3, 3, [9]], [4, 3, []]]);
  });
  it('ignores a truncated tail', () => {
    const buf = new Uint8Array(encodeFrames([{ kind: FRAME.DATAGRAM, payload: bytes(1, 2, 3) }]));
    expect(parseFrames(buf.subarray(0, 10))).toEqual([]);
  });
});

describe('NativeWebTransport', () => {
  it('ready resolves after nwt_connect and exposes maxDatagramSize', async () => {
    const m = mockBackend({ maxDatagramSize: 1150 });
    const t = new NativeWebTransport('https://relay.test/specter?token=x', { deps: m.deps });
    await t.ready;
    expect(m.of('nwt_connect')[0].args.url).toBe('https://relay.test/specter?token=x');
    expect(t.datagrams.maxDatagramSize).toBe(1150);
    m.push([{ kind: FRAME.MAX_DATAGRAM, id: 1300 }]);
    expect(t.datagrams.maxDatagramSize).toBe(1300);
  });

  it('a failed connect rejects ready and closed', async () => {
    const m = mockBackend({ connectError: 'native WebTransport handshake timed out' });
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    await expect(t.ready).rejects.toThrow(/timed out/);
    await expect(t.closed).rejects.toThrow(/timed out/);
  });

  it('incoming datagrams arrive on datagrams.readable as copies', async () => {
    const m = mockBackend();
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    await t.ready;
    const r = t.datagrams.readable.getReader();
    m.push([{ kind: FRAME.DATAGRAM, payload: bytes(0xff, 1) }, { kind: FRAME.DATAGRAM, payload: bytes(5) }]);
    const a = await r.read();
    const b = await r.read();
    expect([...a.value]).toEqual([0xff, 1]);
    expect(a.value.byteOffset).toBe(0); // its own buffer, safe for .buffer users
    expect([...b.value]).toEqual([5]);
  });

  it('incoming unidirectional streams: open, chunks, fin', async () => {
    const m = mockBackend();
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    await t.ready;
    const sr = t.incomingUnidirectionalStreams.getReader();
    m.push([
      { kind: FRAME.STREAM_OPEN, id: 1 },
      { kind: FRAME.STREAM_DATA, id: 1, payload: bytes(0x01, 0x7b) },
      { kind: FRAME.STREAM_DATA, id: 1, payload: bytes(0x7d, 0x0a) },
      { kind: FRAME.STREAM_FIN, id: 1 },
    ]);
    const { value: stream } = await sr.read();
    const rd = stream.getReader();
    const out = [];
    for (;;) { const { value, done } = await rd.read(); if (done) break; out.push(...value); }
    expect(out).toEqual([0x01, 0x7b, 0x7d, 0x0a]);
  });

  it('a reset stream errors its reader; cancel tells Rust to stop', async () => {
    const m = mockBackend();
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    await t.ready;
    const sr = t.incomingUnidirectionalStreams.getReader();
    m.push([{ kind: FRAME.STREAM_OPEN, id: 4 }, { kind: FRAME.STREAM_OPEN, id: 5 }]);
    const s4 = (await sr.read()).value;
    const s5 = (await sr.read()).value;
    m.push([{ kind: FRAME.STREAM_RESET, id: 4, payload: new TextEncoder().encode('stream reset (code: 0)') }]);
    await expect(s4.getReader().read()).rejects.toThrow(/reset/);
    await s5.cancel();
    expect(m.of('nwt_stream_stop')[0].args).toEqual({ session: 7, stream: 5 });
  });

  it('createUnidirectionalStream writes raw bytes in order, then finishes', async () => {
    const m = mockBackend();
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    const ws = await t.createUnidirectionalStream();
    const w = ws.getWriter();
    await w.write(bytes(0x02));
    await w.write(new Uint8Array([1, 2, 3, 4]).buffer);
    await w.close();
    const writes = m.of('nwt_stream_write');
    expect(writes.map((c) => [...c.args])).toEqual([[2], [1, 2, 3, 4]]);
    expect(writes[0].args).toBeInstanceOf(Uint8Array); // raw body, not JSON
    expect(writes[0].opts.headers).toEqual({ 'x-nwt-session': '7', 'x-nwt-stream': '100' });
    expect(m.of('nwt_stream_finish')[0].args).toEqual({ session: 7, stream: 100 });
  });

  it('a stream write error rejects the writer', async () => {
    const m = mockBackend();
    m.deps.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'nwt_connect') return { id: 1, maxDatagramSize: 1200 };
      if (cmd === 'nwt_open_uni') return 1;
      if (cmd === 'nwt_stream_write') throw 'stream stopped (code: 0)';
      return null;
    });
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    const w = (await t.createUnidirectionalStream()).getWriter();
    await expect(w.write(bytes(1))).rejects.toThrow(/stopped/);
  });

  it('outgoing datagrams: raw bodies, writer never reports full, copies the caller buffer', async () => {
    const m = mockBackend();
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    await t.ready;
    const w = t.datagrams.writable.getWriter();
    expect(w.desiredSize).toBeGreaterThan(0);
    const buf = bytes(1, 2, 3);
    await w.write(buf);
    buf[0] = 99; // reused by the caller right after write() resolves
    await tick(); await tick();
    const sent = m.of('nwt_send_datagram');
    expect(sent).toHaveLength(1);
    expect([...sent[0].args]).toEqual([1, 2, 3]);
    expect(sent[0].opts.headers['x-nwt-session']).toBe('7');
    expect(w.desiredSize).toBeGreaterThan(0);
  });

  it('backpressure: a backed-up datagram queue drops the oldest, and stale ones by outgoingMaxAge', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let clock = 0;
    const m = mockBackend();
    const sent = [];
    m.deps.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'nwt_connect') return { id: 1, maxDatagramSize: 1200 };
      if (cmd === 'nwt_send_datagram') { sent.push(args[0]); if (sent.length === 1) await gate; }
      return null;
    });
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps, now: () => clock });
    await t.ready;
    t.datagrams.outgoingHighWaterMark = 4;
    t.datagrams.outgoingMaxAge = 200;
    const w = t.datagrams.writable.getWriter();
    await w.write(bytes(0)); // in flight, blocked on the gate
    await tick();
    for (let i = 1; i <= 10; i++) await w.write(bytes(i)); // queue keeps the newest 4: 7..10
    clock = 100;
    release();
    for (let i = 0; i < 10; i++) await tick();
    expect(sent).toEqual([0, 7, 8, 9, 10]);

    // Stale: queued at t=1000, sent after t=1300 > maxAge 200 → dropped.
    let release2;
    const gate2 = new Promise((r) => { release2 = r; });
    sent.length = 0;
    m.deps.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'nwt_send_datagram') { sent.push(args[0]); if (args[0] === 20) await gate2; }
      return null;
    });
    clock = 1000;
    await w.write(bytes(20));
    await tick();
    await w.write(bytes(21));
    clock = 1300;
    release2();
    for (let i = 0; i < 10; i++) await tick();
    expect(sent).toEqual([20]);
  });

  it('oversize datagrams are dropped, not sent', async () => {
    const m = mockBackend({ maxDatagramSize: 4 });
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    await t.ready;
    const w = t.datagrams.writable.getWriter();
    await w.write(bytes(1, 2, 3, 4, 5));
    await w.write(bytes(1));
    for (let i = 0; i < 5; i++) await tick();
    expect(m.of('nwt_send_datagram').map((c) => c.args.length)).toEqual([1]);
  });

  it('close() calls nwt_close and resolves closed; open streams error', async () => {
    const m = mockBackend();
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    await t.ready;
    const sr = t.incomingUnidirectionalStreams.getReader();
    m.push([{ kind: FRAME.STREAM_OPEN, id: 1 }]);
    const s = (await sr.read()).value.getReader();
    t.close({ closeCode: 3, reason: 'bye' });
    expect(m.of('nwt_close')[0].args).toEqual({ session: 7, code: 3, reason: 'bye' });
    m.push([{ kind: FRAME.CLOSED, payload: new Uint8Array([1, ...new TextEncoder().encode('')]) }]);
    await expect(t.closed).resolves.toMatchObject({ closeCode: 0 });
    await expect(s.read()).rejects.toThrow();
    expect((await sr.read()).done).toBe(true);
  });

  it('an abrupt close (timeout) rejects closed', async () => {
    const m = mockBackend();
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    await t.ready;
    m.push([{ kind: FRAME.CLOSED, payload: new Uint8Array([0, ...new TextEncoder().encode('connection timed out')]) }]);
    await expect(t.closed).rejects.toThrow(/timed out/);
  });

  it('close() before ready closes as soon as the session exists', async () => {
    const m = mockBackend({ delayMs: 5 });
    const t = new NativeWebTransport('https://relay.test/x', { deps: m.deps });
    t.close();
    await t.ready;
    expect(m.of('nwt_close')).toHaveLength(1);
  });
});

// ── factory ──────────────────────────────────────────────────────────────

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

/**
 * Controllable transports. behaviour(mode, url) → 'ok' | 'hang' | 'reject' |
 * { after: ms, then: 'ok'|'reject' }. Records every instance and its close().
 */
function fakes(behaviour) {
  const made = [];
  const build = (mode) => class {
    constructor(url) {
      this.url = url; this.mode = mode; this.closeCalls = 0; made.push(this);
      const b = behaviour(mode, url);
      const outcome = typeof b === 'object' ? b.then : b;
      const after = typeof b === 'object' ? b.after : 0;
      this.ready = outcome === 'hang' ? new Promise(() => {}) : new Promise((res, rej) => {
        const go = () => (outcome === 'ok' ? res() : rej(new Error(mode === 'native' ? 'native WebTransport handshake timed out' : 'Opening handshake failed.')));
        if (after) setTimeout(go, after); else go();
      });
      this.ready.catch(() => {});
      this.closed = new Promise(() => {});
    }
    close() { this.closeCalls++; }
  };
  return { WT: build('webview'), Native: build('native'), made };
}
const invokeInfo = (forced = null) => vi.fn(async (cmd) => (cmd === 'nwt_info' ? { available: true, forced } : null));
const MAIN = 'https://relay.test/specter?token=SECRET';
const ALT = 'https://relay.test:3478/specter?token=SECRET';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function depsFor(f, extra = {}) {
  return { WebTransport: f.WT, NativeWebTransport: f.Native, inTauri: () => true, invoke: invokeInfo(), nativeAfterMs: 30, deadlineMs: 400, rememberedTimeoutMs: 50, ...extra };
}

describe('createTransport', () => {
  beforeEach(() => { _resetTransportFactoryForTests(); vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('outside Tauri: plain WebTransport, no race', async () => {
    const f = fakes(() => 'hang');
    const r = await createTransport(MAIN, { deps: { WebTransport: f.WT, inTauri: () => false } });
    expect(r.mode).toBe('webview');
    expect(f.made).toHaveLength(1);
  });

  it('races WebView2 on both ports at t=0; the first ready wins and the loser is closed', async () => {
    const f = fakes((mode, url) => (url === ALT ? 'ok' : 'hang'));
    const storage = memStorage();
    const r = await createTransport(MAIN, { altUrl: ALT, storage, deps: depsFor(f) });
    expect(r).toMatchObject({ mode: 'webview', slot: 'alt', url: ALT });
    expect(f.made.map((t) => `${t.mode}:${t.url === ALT ? 'alt' : 'main'}`)).toEqual(['webview:main', 'webview:alt']);
    expect(f.made[0].closeCalls).toBe(1); // main loser closed
    expect(f.made[1].closeCalls).toBe(0);
    expect(readTransportPref(storage)).toMatchObject({ mode: 'webview', slot: 'alt' });
  });

  it('native joins after the delay when WebView2 is not ready; all losers closed, (native, port) remembered', async () => {
    const f = fakes((mode, url) => (mode === 'native' && url === MAIN ? 'ok' : mode === 'native' ? 'hang' : 'hang'));
    const storage = memStorage();
    const logs = [];
    const t0 = Date.now();
    const r = await createTransport(MAIN, { altUrl: ALT, storage, log: (l) => logs.push(l), deps: depsFor(f) });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(r).toMatchObject({ mode: 'native', slot: 'main', fellBack: true });
    expect(f.made.map((t) => t.mode)).toEqual(['webview', 'webview', 'native', 'native']);
    for (const t of f.made) expect(t.closeCalls).toBe(t === r.transport ? 0 : 1);
    expect(readTransportPref(storage)).toMatchObject({ mode: 'native', slot: 'main' });
    expect(logs.some((l) => /^\[transport\] mode=native port=443 label=wt/.test(l))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/SECRET|token/); // never log the ticket
  });

  it('a loser that becomes ready later is closed then, too', async () => {
    const f = fakes((mode, url) => (url === MAIN ? 'ok' : { after: 20, then: 'ok' }));
    const r = await createTransport(MAIN, { altUrl: ALT, storage: memStorage(), deps: depsFor(f) });
    expect(r.slot).toBe('main');
    await sleep(40);
    expect(f.made[1].closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('every WebView2 attempt failing fast starts native at once (no delay)', async () => {
    const f = fakes((mode) => (mode === 'native' ? 'ok' : 'reject'));
    const r = await createTransport(MAIN, { altUrl: ALT, storage: memStorage(), deps: depsFor(f, { nativeAfterMs: 10_000 }) });
    expect(r.mode).toBe('native');
  });

  it('remembered (mode, port) is used directly — no race', async () => {
    const storage = memStorage();
    writeTransportPref(storage, { mode: 'native', slot: 'alt' });
    const f = fakes(() => 'ok');
    const r = await createTransport(MAIN, { altUrl: ALT, storage, deps: depsFor(f) });
    expect(r).toMatchObject({ mode: 'native', slot: 'alt', fellBack: false });
    expect(f.made).toHaveLength(1);
  });

  it('a remembered choice that fails re-races and remembers the new winner', async () => {
    const storage = memStorage();
    writeTransportPref(storage, { mode: 'native', slot: 'main' });
    let first = true;
    const f = fakes((mode) => {
      if (mode === 'native' && first) { first = false; return 'reject'; }
      return mode === 'webview' ? 'ok' : 'hang';
    });
    const r = await createTransport(MAIN, { altUrl: ALT, storage, deps: depsFor(f) });
    expect(r.mode).toBe('webview');
    expect(readTransportPref(storage)?.mode).toBe('webview');
  });

  it('one decision per network: concurrent first joins share one race', async () => {
    const f = fakes((mode) => (mode === 'native' ? 'ok' : 'hang'));
    const storage = memStorage();
    const deps = depsFor(f);
    const [voice, mon1, mon2] = await Promise.all([
      createTransport(MAIN, { altUrl: ALT, storage, label: 'voice', deps }),
      createTransport(MAIN.replace('SECRET', 'm1'), { altUrl: ALT, storage, label: 'monitor', deps }),
      createTransport(MAIN.replace('SECRET', 'm2'), { storage, label: 'subscribe', deps }),
    ]);
    expect([voice.mode, mon1.mode, mon2.mode]).toEqual(['native', 'native', 'native']);
    // One race (2 webview + 2 native) + one direct native session each for the others.
    expect(f.made.filter((t) => t.mode === 'webview')).toHaveLength(2);
    expect(f.made.filter((t) => t.mode === 'native')).toHaveLength(4);
  });

  it('everything fails: throws a timeout-classifiable error and closes everything', async () => {
    const f = fakes((mode) => (mode === 'native' ? 'reject' : 'hang'));
    await expect(createTransport(MAIN, { altUrl: ALT, storage: memStorage(), deps: depsFor(f) })).rejects.toThrow(/timed out/);
    for (const t of f.made) expect(t.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('dev switch: localStorage forces native (no WebView2) or webview (no native)', async () => {
    const f = fakes(() => 'ok');
    const r = await createTransport(MAIN, { altUrl: ALT, storage: memStorage({ [TRANSPORT_FORCE_KEY]: 'native' }), deps: depsFor(f) });
    expect(r.mode).toBe('native');
    expect(f.made.every((t) => t.mode === 'native')).toBe(true);

    const g = fakes(() => 'reject');
    await expect(createTransport(MAIN, { storage: memStorage({ [TRANSPORT_FORCE_KEY]: 'webview' }), deps: depsFor(g) })).rejects.toThrow(/handshake failed/);
    expect(g.made.every((t) => t.mode === 'webview')).toBe(true);
  });

  it('dev switch: SPECTER_TRANSPORT env (via nwt_info) forces native', async () => {
    const f = fakes(() => 'ok');
    const r = await createTransport(MAIN, { storage: memStorage(), deps: depsFor(f, { invoke: invokeInfo('native') }) });
    expect(r.mode).toBe('native');
    expect(f.made.every((t) => t.mode === 'native')).toBe(true);
  });

  it('native losers still connecting are closed once their session exists (real shim, mock backend)', async () => {
    // WebView2 wins at once; native never started. Then: native forced on
    // two ports, main wins, alt (slow) must get nwt_close after connecting.
    const backend = mockBackend({ delayMs: 15 });
    let n = 0;
    backend.deps.invoke.mockImplementation(async (cmd) => {
      if (cmd === 'nwt_connect') { const id = ++n; await sleep(id === 1 ? 1 : 15); return { id, maxDatagramSize: 1200 }; }
      return null;
    });
    const r = await createTransport(MAIN, {
      altUrl: ALT, storage: memStorage({ [TRANSPORT_FORCE_KEY]: 'native' }),
      deps: { inTauri: () => true, invoke: invokeInfo(), nativeDeps: backend.deps, deadlineMs: 400 },
    });
    expect(r.mode).toBe('native');
    await sleep(40);
    const closes = backend.deps.invoke.mock.calls.filter(([cmd]) => cmd === 'nwt_close').map(([, a]) => a.session);
    expect(closes).toContain(2);
    expect(closes).not.toContain(1);
  });
});

describe('transport preference helpers', () => {
  it('expire after the TTL and ignore junk', () => {
    const s = memStorage();
    writeTransportPref(s, { mode: 'native', slot: 'alt' }, 1000);
    expect(readTransportPref(s, 2000)).toMatchObject({ mode: 'native', slot: 'alt' });
    expect(readTransportPref(s, 1000 + 4 * 24 * 3600 * 1000)).toBeNull();
    s.setItem(TRANSPORT_PREF_KEY, '{bad');
    expect(readTransportPref(s)).toBeNull();
    writeTransportPref(s, null);
    expect(s.getItem(TRANSPORT_PREF_KEY)).toBeNull();
  });
  it('forced mode', () => {
    expect(forcedTransportMode(memStorage({ [TRANSPORT_FORCE_KEY]: 'native' }))).toBe('native');
    expect(forcedTransportMode(memStorage({ [TRANSPORT_FORCE_KEY]: 'bogus' }), 'webview')).toBe('webview');
    expect(forcedTransportMode(memStorage())).toBeNull();
  });
  it('redactUrl keeps host and path only', () => {
    expect(redactUrl('https://relay.example:3478/specter?token=abc&channel_id=1')).toBe('relay.example:3478/specter');
    expect(redactUrl('nope')).toBe('?');
  });
});
