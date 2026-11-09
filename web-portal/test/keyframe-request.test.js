// Keyframe-on-request (2.1), client side: the shared throttle and wire bytes
// (engine/keyframeRequest.js), the sender's send pump asking for a keyframe
// when it starts dropping a GOP (engine/videoSendPump.js), and the strip
// viewer asking whenever it drops frames waiting for one (useStripStream).
// The server-side coalescing has its own cargo tests in media-rust.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  KEYFRAME_REQUEST_BYTE, VIEWER_REQUEST_INTERVAL_MS, createThrottledTrigger,
  keyframeRequestDatagram, isKeyframeRequestSignal,
} from '../src/engine/keyframeRequest.js';
import { createVideoSendPump } from '../src/engine/videoSendPump.js';

vi.mock('react', () => import('./helpers/reactShim.js'));

describe('wire bytes', () => {
  it('matches media-rust VIDEO_KEYFRAME_REQUEST (0x4B) and no existing signal', () => {
    expect(KEYFRAME_REQUEST_BYTE).toBe(0x4b);
    // The publish transport's other signals — must stay distinct.
    expect([0xac, 0xde]).not.toContain(KEYFRAME_REQUEST_BYTE);
    expect(Array.from(keyframeRequestDatagram())).toEqual([0x4b]);
    expect(isKeyframeRequestSignal(new Uint8Array([0x4b]))).toBe(true);
    expect(isKeyframeRequestSignal(new Uint8Array([0xac]))).toBe(false);
    expect(isKeyframeRequestSignal(new Uint8Array([]))).toBe(false);
    expect(isKeyframeRequestSignal(undefined)).toBe(false);
  });
});

describe('createThrottledTrigger', () => {
  it('fires at most once per interval and drops calls inside it', () => {
    let t = 1000;
    const fn = vi.fn();
    const fire = createThrottledTrigger(fn, 300, () => t);
    expect(fire('a')).toBe(true);
    expect(fn).toHaveBeenLastCalledWith('a');
    t += 299;
    expect(fire('b')).toBe(false);
    t += 1;
    expect(fire('c')).toBe(true);
    expect(fn.mock.calls.map((c) => c[0])).toEqual(['a', 'c']);
  });

  it('reset() re-arms it', () => {
    let t = 0;
    const fn = vi.fn();
    const fire = createThrottledTrigger(fn, 1000, () => t);
    fire();
    fire.reset();
    expect(fire()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('createVideoSendPump onResync', () => {
  // A writer whose write() stays pending until release() — i.e. a congested link.
  const stalledWriter = () => {
    const pending = [];
    return {
      writes: [],
      write(buf) { this.writes.push(buf); return new Promise((r) => pending.push(r)); },
      release() { while (pending.length) pending.shift()(); },
    };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('fires once when the pump starts dropping a GOP, again only after it resynced', async () => {
    const writer = stalledWriter();
    const onDrop = vi.fn();
    const onResync = vi.fn();
    const submit = createVideoSendPump({ current: writer }, onDrop, onResync);

    submit('K1', true);            // in flight
    submit('d1', false);           // dropped → resync starts
    submit('d2', false);           // still dropping, same episode
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(onResync).toHaveBeenCalledTimes(1);

    writer.release(); await flush();
    submit('d3', false);           // link free but GOP broken: dropped, no new request
    expect(onResync).toHaveBeenCalledTimes(1);
    submit('K2', true);            // resynced
    writer.release(); await flush();
    submit('d4', false);           // in sync, link free → sent
    writer.release(); await flush();
    expect(writer.writes).toEqual(['K1', 'K2', 'd4']);

    submit('d5', false);           // in flight
    submit('d6', false);           // dropped → a new episode asks again
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('works without callbacks (pre-2.1 call sites)', () => {
    const writer = stalledWriter();
    const submit = createVideoSendPump({ current: writer });
    submit('K', true);
    expect(() => submit('d', false)).not.toThrow();
  });
});

describe('useStripStream asks for a keyframe while it waits for one', () => {
  let now = 0;
  let shim;
  let useStripStream;
  beforeEach(async () => {
    now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    shim = await import('./helpers/reactShim.js');
    ({ default: useStripStream } = await import('../src/components/strip/useStripStream.js'));
  });
  afterEach(() => {
    shim.resetShim();
    vi.restoreAllMocks();
    delete globalThis.VideoDecoder;
    delete globalThis.EncodedVideoChunk;
  });

  const fakeSource = () => {
    const src = {
      handlers: null,
      requests: [],
      subscribe(h) { src.handlers = h; return () => { src.handlers = null; }; },
      requestKeyframe(session) { src.requests.push(session); },
    };
    return src;
  };
  const delta = (session, ts) => ({ session, key: false, ts, data: 'AA==' });

  it('deltas before any keyframe → throttled requests carrying the session', () => {
    const src = fakeSource();
    shim.renderHook(useStripStream, { active: true, callsign: 'alice', source: src });
    src.handlers.onFrame(delta('s1', 1));
    src.handlers.onFrame(delta('s1', 2));
    now += VIEWER_REQUEST_INTERVAL_MS - 1;
    src.handlers.onFrame(delta('s1', 3));
    expect(src.requests).toEqual(['s1']);
    now += 1;
    src.handlers.onFrame(delta('s1', 4));
    expect(src.requests).toEqual(['s1', 's1']);
  });

  it('decoder falling behind → drops to the next keyframe and asks for it', async () => {
    const decoders = [];
    globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
    globalThis.VideoDecoder = class {
      static async isConfigSupported() { return { supported: true }; }
      constructor() { this.state = 'unconfigured'; this.decodeQueueSize = 0; this.decoded = []; decoders.push(this); }
      configure() { this.state = 'configured'; }
      decode(chunk) { this.decoded.push(chunk.type); }
      close() { this.state = 'closed'; }
    };
    const src = fakeSource();
    shim.renderHook(useStripStream, { active: true, callsign: 'alice', source: src });
    src.handlers.onFrame({ session: 's1', key: true, ts: 1, data: 'AA==', config: { codec: 'avc1.640033', width: 1920, height: 1080 } });
    await new Promise((r) => setTimeout(r, 0)); // isConfigSupported → decoder ready, keyframe decoded
    const dec = decoders[0];
    expect(dec.decoded).toEqual(['key']);
    src.handlers.onFrame(delta('s1', 2));
    expect(src.requests).toEqual([]);           // in sync: nothing to ask for
    dec.decodeQueueSize = 99;                   // falls behind
    src.handlers.onFrame(delta('s1', 3));
    expect(src.requests).toEqual(['s1']);
    dec.decodeQueueSize = 0;
    src.handlers.onFrame(delta('s1', 4));       // still waiting (throttled, no new request)
    expect(dec.decoded).toEqual(['key', 'delta']);
    expect(src.requests).toEqual(['s1']);
  });
});
