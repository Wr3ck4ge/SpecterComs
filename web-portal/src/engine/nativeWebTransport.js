// A WebTransport look-alike backed by the native client in
// src-tauri/src/native_wt.rs. Used (see ./transportFactory.js) when
// WebView2's own QUIC can't reach the relay but a QUIC connection from the
// app process can — some networks drop browser QUIC (e.g. its large,
// two-packet post-quantum ClientHello) and let the native one through.
//
// Only the surface the app uses is implemented:
//   ready, closed, close({ closeCode, reason })
//   datagrams.readable / .writable / .maxDatagramSize
//            .outgoingHighWaterMark / .outgoingMaxAge
//   incomingUnidirectionalStreams (a ReadableStream of ReadableStreams)
//   createUnidirectionalStream() → WritableStream
// with real WHATWG streams, so reader/writer code is unchanged.
//
// It only moves bytes that are already end-to-end encrypted (JS/WASM does
// that before anything reaches a transport); it never sees a key.
//
// Payloads never go through JSON: outgoing bytes are raw invoke bodies,
// incoming ones arrive on a Tauri Channel as ArrayBuffers of frames
//   [kind u8][id u32 LE][len u32 LE][payload]   (see native_wt.rs)

export const FRAME = Object.freeze({
  DATAGRAM: 1, STREAM_OPEN: 2, STREAM_DATA: 3, STREAM_FIN: 4, STREAM_RESET: 5, CLOSED: 6, MAX_DATAGRAM: 7,
});

/** Default bound of the outgoing datagram queue (oldest dropped past it). */
export const DEFAULT_OUTGOING_HWM = 16;
/** Incoming datagrams queued unread past this many are dropped (stale). */
export const INCOMING_DATAGRAM_MAX_QUEUE = 256;
const FALLBACK_MAX_DATAGRAM = 1200;

/** Splits one Channel message into frames: [{ kind, id, payload: Uint8Array }]. */
export function parseFrames(buffer) {
  const buf = buffer instanceof ArrayBuffer ? buffer : buffer?.buffer;
  if (!buf) return [];
  const base = buffer instanceof ArrayBuffer ? 0 : buffer.byteOffset;
  const total = buffer instanceof ArrayBuffer ? buf.byteLength : buffer.byteLength;
  const dv = new DataView(buf, base, total);
  const out = [];
  let i = 0;
  while (i + 9 <= total) {
    const kind = dv.getUint8(i);
    const id = dv.getUint32(i + 1, true);
    const len = dv.getUint32(i + 5, true);
    if (i + 9 + len > total) break;
    out.push({ kind, id, payload: new Uint8Array(buf, base + i + 9, len) });
    i += 9 + len;
  }
  return out;
}

/** Builds frames (tests and the mock). */
export function encodeFrames(frames) {
  const size = frames.reduce((n, f) => n + 9 + (f.payload?.length || 0), 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let i = 0;
  for (const f of frames) {
    const p = f.payload || new Uint8Array(0);
    dv.setUint8(i, f.kind); dv.setUint32(i + 1, f.id || 0, true); dv.setUint32(i + 5, p.length, true);
    out.set(p, i + 9);
    i += 9 + p.length;
  }
  return out.buffer;
}

function toBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError('WebTransport chunks must be BufferSource');
}

/** A WebTransportError-like error (`source`, `streamErrorCode`). */
function wtError(message, source = 'session') {
  const e = new Error(message);
  e.name = 'WebTransportError';
  e.source = source;
  e.streamErrorCode = null;
  return e;
}

async function defaultDeps() {
  const core = await import('@tauri-apps/api/core');
  return { invoke: core.invoke, Channel: core.Channel };
}

export class NativeWebTransport {
  /**
   * deps (tests): { invoke, Channel } — default: @tauri-apps/api/core.
   */
  constructor(url, { deps = null, now = () => Date.now() } = {}) {
    this.url = url;
    this.native = true;
    this._now = now;
    this._sid = null;
    this._closedState = null; // null | 'closing' | 'closed'
    this._incoming = new Map(); // stream id → ReadableStreamDefaultController
    this._writables = new Set();
    this._maxDatagram = FALLBACK_MAX_DATAGRAM;
    this._outQueue = [];
    this._sending = false;
    this._pendingClose = null;

    let readyRes, readyRej, closedRes, closedRej;
    this.ready = new Promise((res, rej) => { readyRes = res; readyRej = rej; });
    this.closed = new Promise((res, rej) => { closedRes = res; closedRej = rej; });
    this.ready.catch(() => {});
    this.closed.catch(() => {});
    this._closedRes = closedRes;
    this._closedRej = closedRej;

    this._dgController = null;
    const readable = new ReadableStream({
      start: (c) => { this._dgController = c; },
    }, { highWaterMark: INCOMING_DATAGRAM_MAX_QUEUE });
    const self = this;
    const writable = new WritableStream({
      write: (chunk) => { self._queueDatagram(chunk); },
    }, { highWaterMark: 64 });
    this.datagrams = {
      readable,
      writable,
      outgoingHighWaterMark: DEFAULT_OUTGOING_HWM,
      outgoingMaxAge: Infinity,
      incomingHighWaterMark: INCOMING_DATAGRAM_MAX_QUEUE,
      incomingMaxAge: Infinity,
      get maxDatagramSize() { return self._maxDatagram; },
    };

    this._streamsController = null;
    this.incomingUnidirectionalStreams = new ReadableStream({
      start: (c) => { this._streamsController = c; },
    });
    this.incomingBidirectionalStreams = new ReadableStream({ start() {} });

    this._depsPromise = deps ? Promise.resolve(deps) : defaultDeps();
    this._connect().then(readyRes, (err) => {
      readyRej(err);
      this._finish(false, err?.message || String(err), err);
    });
  }

  async _connect() {
    const { invoke, Channel } = await this._depsPromise;
    this._invoke = invoke;
    const channel = new Channel();
    channel.onmessage = (msg) => this._onMessage(msg);
    this._channel = channel;
    let info;
    try {
      info = await invoke('nwt_connect', { url: this.url, events: channel });
    } catch (err) {
      throw wtError(typeof err === 'string' ? err : err?.message || 'native WebTransport failed');
    }
    this._sid = info.id;
    if (info.maxDatagramSize) this._maxDatagram = info.maxDatagramSize;
    if (this._pendingClose) {
      const p = this._pendingClose;
      this._pendingClose = null;
      this._sendClose(p);
    }
  }

  _headers(extra = {}) {
    return { headers: { 'x-nwt-session': String(this._sid), ...extra } };
  }

  _onMessage(msg) {
    for (const f of parseFrames(msg)) {
      switch (f.kind) {
        case FRAME.DATAGRAM: {
          const c = this._dgController;
          if (!c || this._closedState === 'closed') break;
          // Unread datagrams pile up only if nobody reads: drop, don't queue.
          if (c.desiredSize !== null && c.desiredSize <= 0) break;
          try { c.enqueue(f.payload.slice()); } catch { /* closed */ }
          break;
        }
        case FRAME.STREAM_OPEN: {
          const id = f.id;
          const rs = new ReadableStream({
            start: (c) => { this._incoming.set(id, c); },
            cancel: () => {
              this._incoming.delete(id);
              this._invoke?.('nwt_stream_stop', { session: this._sid, stream: id }).catch(() => {});
            },
          });
          try { this._streamsController?.enqueue(rs); } catch { /* closed */ }
          break;
        }
        case FRAME.STREAM_DATA: {
          const c = this._incoming.get(f.id);
          if (c) try { c.enqueue(f.payload.slice()); } catch { /* cancelled */ }
          break;
        }
        case FRAME.STREAM_FIN: {
          const c = this._incoming.get(f.id);
          this._incoming.delete(f.id);
          if (c) try { c.close(); } catch { /* cancelled */ }
          break;
        }
        case FRAME.STREAM_RESET: {
          const c = this._incoming.get(f.id);
          this._incoming.delete(f.id);
          if (c) try { c.error(wtError(new TextDecoder().decode(f.payload) || 'stream reset', 'stream')); } catch { /* cancelled */ }
          break;
        }
        case FRAME.MAX_DATAGRAM:
          if (f.id > 0) this._maxDatagram = f.id;
          break;
        case FRAME.CLOSED: {
          const clean = f.payload[0] === 1;
          const reason = new TextDecoder().decode(f.payload.subarray(1));
          this._finish(clean, reason);
          break;
        }
        default: break;
      }
    }
  }

  _queueDatagram(chunk) {
    if (this._closedState) return;
    // Copy: the caller may reuse its buffer as soon as write() resolves.
    this._outQueue.push({ bytes: toBytes(chunk).slice(), t: this._now() });
    const hwm = Math.max(1, Number(this.datagrams.outgoingHighWaterMark) || DEFAULT_OUTGOING_HWM);
    while (this._outQueue.length > hwm) this._outQueue.shift(); // drop stale, never queue late
    this._pumpDatagrams();
  }

  async _pumpDatagrams() {
    if (this._sending) return;
    this._sending = true;
    try {
      await this.ready;
      while (this._outQueue.length && !this._closedState) {
        const { bytes, t } = this._outQueue.shift();
        const maxAge = Number(this.datagrams.outgoingMaxAge);
        if (Number.isFinite(maxAge) && maxAge > 0 && this._now() - t > maxAge) continue;
        if (bytes.length > this._maxDatagram) continue; // the browser drops these too
        try { await this._invoke('nwt_send_datagram', bytes, this._headers()); }
        catch (err) { if (/session closed/.test(String(err))) break; }
      }
    } catch { /* never connected */ } finally {
      this._sending = false;
    }
  }

  async createUnidirectionalStream() {
    await this.ready;
    if (this._closedState) throw wtError('session closed');
    let stream;
    try {
      stream = await this._invoke('nwt_open_uni', { session: this._sid });
    } catch (err) { throw wtError(String(err?.message || err)); }
    const headers = this._headers({ 'x-nwt-stream': String(stream) });
    const session = this._sid;
    const invoke = this._invoke;
    const entry = {};
    const ws = new WritableStream({
      start: (c) => { entry.controller = c; },
      write: async (chunk) => {
        try { await invoke('nwt_stream_write', toBytes(chunk), headers); }
        catch (err) { throw wtError(String(err?.message || err), 'stream'); }
      },
      close: async () => {
        this._writables.delete(entry);
        try { await invoke('nwt_stream_finish', { session, stream }); }
        catch (err) { throw wtError(String(err?.message || err), 'stream'); }
      },
      abort: async () => {
        this._writables.delete(entry);
        await invoke('nwt_stream_reset', { session, stream, code: 0 }).catch(() => {});
      },
    });
    this._writables.add(entry);
    return ws;
  }

  close({ closeCode = 0, reason = '' } = {}) {
    if (this._closedState) return;
    this._closedState = 'closing';
    const p = { closeCode, reason };
    if (this._sid == null) this._pendingClose = p;
    else this._sendClose(p);
    // Resolve even if the close frame never comes back (page teardown).
    setTimeout(() => this._finish(true, reason), 1000);
  }

  _sendClose({ closeCode, reason }) {
    this._invoke?.('nwt_close', { session: this._sid, code: closeCode >>> 0, reason: String(reason || '') }).catch(() => {});
  }

  _finish(clean, reason, cause = null) {
    if (this._closedState === 'closed') return;
    const wasClosing = this._closedState === 'closing';
    this._closedState = 'closed';
    const err = cause || wtError(reason || 'connection lost');
    for (const c of this._incoming.values()) { try { c.error(err); } catch { /* done */ } }
    this._incoming.clear();
    for (const w of this._writables) { try { w.controller?.error(err); } catch { /* done */ } }
    this._writables.clear();
    try { this._dgController?.close(); } catch { /* done */ }
    try { this._streamsController?.close(); } catch { /* done */ }
    this._outQueue.length = 0;
    if (clean || wasClosing) this._closedRes({ closeCode: 0, reason: reason || '' });
    else this._closedRej(err);
    // The Channel unregisters itself when Rust drops it (end of the pump).
  }
}
