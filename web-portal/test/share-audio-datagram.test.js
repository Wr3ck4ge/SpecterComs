// Share audio over WebTransport datagrams: framing, the server-capability
// gating, the in-stream fallback and the viewer's datagram reader. See
// src/engine/shareAudio.js and services/media-rust/src/share_audio.rs.
import { describe, it, expect } from 'vitest';
import {
  SHARE_AUDIO_FLAGS, SHARE_AUDIO_CAPABLE_SIGNAL, SHARE_AUDIO_DGRAM_CAPABLE_SIGNAL, SHARE_AUDIO_DATAGRAM_TYPE,
  SHARE_AUDIO_DATAGRAM_HEADER_LEN, SHARE_AUDIO_DATAGRAM_FALLBACK_MAX, SHARE_AUDIO_SUBSCRIBE_PARAM,
  SHARE_AUDIO_DGRAM_SUBSCRIBE_PARAM, SHARE_AUDIO_INNER_V1,
  isShareAudioCapableSignal, isShareAudioDgramCapableSignal, frameShareAudio, frameShareAudioDatagram,
  parseShareAudioDatagram, shareAudioSubscribeParams, chooseShareAudioRoute, datagramSizeLimit,
  createShareAudioSender, readShareAudioDatagrams, decodeShareAudioInner, bytesToBase64,
} from '../src/engine/shareAudio.js';
import { KEYFRAME_REQUEST_BYTE } from '../src/engine/keyframeRequest.js';

// Identity "encryption" with a marker, so tests can see what was encrypted.
const fakeEncrypt = (inner) => { const out = new Uint8Array(inner.length + 1); out[0] = 0xee; out.set(inner, 1); return out; };
const opusB64 = (n = 4) => bytesToBase64(new Uint8Array(n).fill(0x33));

function fakeWriter({ desiredSize = 16, reject = false } = {}) {
  const written = [];
  return {
    written,
    desiredSize,
    write(chunk) { written.push(chunk); return reject ? Promise.reject(new Error('closed')) : Promise.resolve(); },
  };
}

function makeSender({ datagramOk = true, streamOk = true, writer = fakeWriter(), max = 1200 } = {}) {
  const stream = [];
  const caps = { datagramOk, streamOk };
  const sender = createShareAudioSender({
    encrypt: fakeEncrypt,
    caps: () => caps,
    datagramWriter: () => writer,
    maxDatagramSize: () => max,
    submitStream: (f) => stream.push(f),
  });
  return { sender, stream, writer, caps };
}

describe('datagram wire format', () => {
  it('is the in-stream frame without its 4-byte size prefix', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const dg = frameShareAudioDatagram(0xa0b0c0d0, payload);
    const frame = frameShareAudio(0xa0b0c0d0, payload);
    expect(Array.from(dg)).toEqual(Array.from(frame.subarray(4)));
    expect(dg[0]).toBe(SHARE_AUDIO_FLAGS);
    expect(SHARE_AUDIO_DATAGRAM_TYPE).toBe(0x05);
    expect(dg.length).toBe(SHARE_AUDIO_DATAGRAM_HEADER_LEN + payload.length);
  });

  it('round-trips and carries only type + timestamp in cleartext', () => {
    const payload = new Uint8Array([9, 9, 9]);
    const parsed = parseShareAudioDatagram(frameShareAudioDatagram(1234, payload));
    expect(parsed.tsMs).toBe(1234);
    expect(Array.from(parsed.payload)).toEqual([9, 9, 9]);
  });

  it('rejects other datagram types and truncated ones', () => {
    expect(parseShareAudioDatagram(new Uint8Array([KEYFRAME_REQUEST_BYTE]))).toBeNull();
    expect(parseShareAudioDatagram(new Uint8Array([0x01, 0, 0, 0, 1, 7]))).toBeNull();
    expect(parseShareAudioDatagram(new Uint8Array([0x05, 0, 0, 0, 1]))).toBeNull(); // no payload
    expect(parseShareAudioDatagram(null)).toBeNull();
  });

  it('parses a datagram that is a view into a larger buffer', () => {
    const backing = new Uint8Array(32);
    backing.set(frameShareAudioDatagram(77, new Uint8Array([4, 2])), 10);
    const parsed = parseShareAudioDatagram(backing.subarray(10, 17));
    expect(parsed.tsMs).toBe(77);
    expect(Array.from(parsed.payload)).toEqual([4, 2]);
  });

  it('a 20 ms 128 kbps Opus packet fits easily under the fallback max', () => {
    const sealed = fakeEncrypt(new Uint8Array(7 + 320)).length + 28; // generous AEAD overhead
    expect(SHARE_AUDIO_DATAGRAM_HEADER_LEN + sealed).toBeLessThan(SHARE_AUDIO_DATAGRAM_FALLBACK_MAX);
  });
});

describe('capability gating', () => {
  it('the datagram signal is a new byte that shipped publishers ignore', () => {
    // 2.0.6–2.0.8 act on 0xAC, 0xDE, KEYFRAME_REQUEST_BYTE (0x4B), 0x41 only.
    for (const known of [0xac, 0xde, KEYFRAME_REQUEST_BYTE, SHARE_AUDIO_CAPABLE_SIGNAL]) {
      expect(SHARE_AUDIO_DGRAM_CAPABLE_SIGNAL).not.toBe(known);
    }
    expect(isShareAudioDgramCapableSignal(new Uint8Array([0x44]))).toBe(true);
    expect(isShareAudioDgramCapableSignal(new Uint8Array([0x41]))).toBe(false);
    expect(isShareAudioCapableSignal(new Uint8Array([0x44]))).toBe(false);
  });

  it('viewers ask for both forms, or neither', () => {
    expect(shareAudioSubscribeParams(true)).toBe(`&${SHARE_AUDIO_SUBSCRIBE_PARAM}&${SHARE_AUDIO_DGRAM_SUBSCRIBE_PARAM}`);
    expect(shareAudioSubscribeParams(true)).toContain('share_audio=1');
    expect(shareAudioSubscribeParams(true)).toContain('share_audio_dgram=1');
    expect(shareAudioSubscribeParams(false)).toBe('');
  });

  it('routes by server capability and size', () => {
    const base = { datagramUsable: true, datagramBytes: 400, maxDatagramSize: 1200 };
    expect(chooseShareAudioRoute({ ...base, datagramOk: true, streamOk: true })).toBe('datagram');
    expect(chooseShareAudioRoute({ ...base, datagramOk: true, streamOk: false })).toBe('datagram');
    // Server only sent 0x41 (2.0.6–2.0.8 era): in-stream.
    expect(chooseShareAudioRoute({ ...base, datagramOk: false, streamOk: true })).toBe('stream');
    // Server sent neither: never send (it could hand audio to 2.0.0–2.0.5 viewers).
    expect(chooseShareAudioRoute({ ...base, datagramOk: false, streamOk: false })).toBeNull();
    // Too big for this path, or no usable writer: in-stream fallback.
    expect(chooseShareAudioRoute({ ...base, datagramOk: true, streamOk: true, datagramBytes: 1201 })).toBe('stream');
    expect(chooseShareAudioRoute({ ...base, datagramOk: true, streamOk: true, datagramUsable: false })).toBe('stream');
    expect(chooseShareAudioRoute({ ...base, datagramOk: true, streamOk: false, datagramBytes: 1201 })).toBeNull();
  });

  it('datagramSizeLimit uses the runtime value, else a safe fallback', () => {
    expect(datagramSizeLimit({ maxDatagramSize: 1180 })).toBe(1180);
    expect(datagramSizeLimit({})).toBe(SHARE_AUDIO_DATAGRAM_FALLBACK_MAX);
    expect(datagramSizeLimit(undefined)).toBe(SHARE_AUDIO_DATAGRAM_FALLBACK_MAX);
    expect(datagramSizeLimit({ maxDatagramSize: 0 })).toBe(SHARE_AUDIO_DATAGRAM_FALLBACK_MAX);
  });
});

describe('createShareAudioSender', () => {
  it('sends an encrypted datagram with the same inner payload as in-stream', () => {
    const { sender, stream, writer } = makeSender();
    expect(sender.send({ data_b64: opusB64(4), timestamp_ms: 5000, duration_ms: 20, seq: 42 })).toBe('datagram');
    expect(stream).toHaveLength(0);
    expect(writer.written).toHaveLength(1);
    const d = parseShareAudioDatagram(writer.written[0]);
    expect(d.tsMs).toBe(5000);
    expect(d.payload[0]).toBe(0xee); // went through encrypt()
    const inner = decodeShareAudioInner(d.payload.subarray(1));
    expect(inner.seq).toBe(42);
    expect(inner.durationMs).toBe(20);
    expect(d.payload[1]).toBe(SHARE_AUDIO_INNER_V1);
    expect(Array.from(inner.opus)).toEqual([0x33, 0x33, 0x33, 0x33]);
  });

  it('falls back in-stream on a server without datagram support', () => {
    const { sender, stream, writer } = makeSender({ datagramOk: false });
    expect(sender.send({ data_b64: opusB64(), timestamp_ms: 7, seq: 1 })).toBe('stream');
    expect(writer.written).toHaveLength(0);
    expect(stream).toHaveLength(1);
    expect(stream[0][4]).toBe(SHARE_AUDIO_FLAGS);
    expect(new DataView(stream[0].buffer).getUint32(5)).toBe(7);
  });

  it('sends nothing until the server has signalled either capability', () => {
    const { sender, stream, writer } = makeSender({ datagramOk: false, streamOk: false });
    expect(sender.send({ data_b64: opusB64(), seq: 1 })).toBeNull();
    expect(stream).toHaveLength(0);
    expect(writer.written).toHaveLength(0);
    expect(sender.stats.dropped).toBe(1);
  });

  it('picks up a capability signal that arrives later', () => {
    const { sender, caps, writer, stream } = makeSender({ datagramOk: false, streamOk: true });
    expect(sender.send({ data_b64: opusB64(), seq: 1 })).toBe('stream');
    caps.datagramOk = true;
    expect(sender.send({ data_b64: opusB64(), seq: 2 })).toBe('datagram');
    expect(stream).toHaveLength(1);
    expect(writer.written).toHaveLength(1);
  });

  it('a packet over maxDatagramSize goes in-stream instead', () => {
    const { sender, stream, writer } = makeSender({ max: 40 });
    expect(sender.send({ data_b64: opusB64(100), seq: 1 })).toBe('stream');
    expect(sender.send({ data_b64: opusB64(4), seq: 2 })).toBe('datagram');
    expect(stream).toHaveLength(1);
    expect(writer.written).toHaveLength(1);
    expect(sender.stats.oversize).toBe(1);
  });

  it('drops (not falls back) when the datagram queue is full', () => {
    const writer = fakeWriter({ desiredSize: 0 });
    const { sender, stream } = makeSender({ writer });
    expect(sender.send({ data_b64: opusB64(), seq: 1 })).toBeNull();
    expect(stream).toHaveLength(0);
    expect(writer.written).toHaveLength(0);
    expect(sender.stats.queueFull).toBe(1);
  });

  it('a rejected datagram write switches this sender to in-stream', async () => {
    const writer = fakeWriter({ reject: true });
    const { sender, stream } = makeSender({ writer });
    expect(sender.send({ data_b64: opusB64(), seq: 1 })).toBe('datagram');
    await Promise.resolve(); await Promise.resolve();
    expect(sender.datagramBroken).toBe(true);
    expect(sender.send({ data_b64: opusB64(), seq: 2 })).toBe('stream');
    expect(stream).toHaveLength(1);
    expect(sender.stats.dgramErrors).toBe(1);
  });

  it('never sends plaintext when encryption throws', () => {
    const writer = fakeWriter();
    const stream = [];
    const sender = createShareAudioSender({
      encrypt: () => { throw new Error('no key'); },
      caps: () => ({ datagramOk: true, streamOk: true }),
      datagramWriter: () => writer,
      maxDatagramSize: () => 1200,
      submitStream: (f) => stream.push(f),
    });
    expect(sender.send({ data_b64: opusB64(), seq: 1 })).toBeNull();
    expect(writer.written).toHaveLength(0);
    expect(stream).toHaveLength(0);
  });

  it('ignores an empty event', () => {
    const { sender, writer } = makeSender();
    expect(sender.send({})).toBeNull();
    expect(sender.send()).toBeNull();
    expect(writer.written).toHaveLength(0);
  });
});

describe('readShareAudioDatagrams', () => {
  const streamOf = (chunks) => new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
  });

  it('delivers share-audio datagrams in arrival order and skips anything else', async () => {
    const got = [];
    await readShareAudioDatagrams(streamOf([
      frameShareAudioDatagram(30, new Uint8Array([3])),
      new Uint8Array([KEYFRAME_REQUEST_BYTE]),
      frameShareAudioDatagram(10, new Uint8Array([1])), // reordered: native reorders by seq
      new Uint8Array([0x05, 0, 0]),
    ]), (ts, payload) => got.push([ts, Array.from(payload)]));
    expect(got).toEqual([[30, [3]], [10, [1]]]);
  });

  it('stops once the subscription is superseded', async () => {
    let current = true;
    const got = [];
    await readShareAudioDatagrams(streamOf([
      frameShareAudioDatagram(1, new Uint8Array([1])),
      frameShareAudioDatagram(2, new Uint8Array([2])),
    ]), (ts) => { got.push(ts); current = false; }, () => current);
    expect(got).toEqual([1]);
  });

  it('returns quietly when the transport errors', async () => {
    const errored = new ReadableStream({ pull(c) { c.error(new Error('closed')); } });
    await expect(readShareAudioDatagrams(errored, () => {})).resolves.toBeUndefined();
    await expect(readShareAudioDatagrams(null, () => {})).resolves.toBeUndefined();
  });
});
