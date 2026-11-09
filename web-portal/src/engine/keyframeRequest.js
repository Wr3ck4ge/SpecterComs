// Keyframe-on-request (2.1). Any decoder that has to drop a delta frame — its
// decode queue overflowed, it was reset, a viewer window just took over the
// stream — can only resume on a keyframe. Before this, that meant waiting
// for the sharer's next scheduled one (the native encoder's GOP is 2 s), so
// every hiccup froze the picture for up to 2 s. Now the waiting side asks:
//
//   strip viewer / overlay window ──(local event)──▶ engine (CommLink)
//   engine ──(datagram [KEYFRAME_REQUEST_BYTE] on the subscribe session)──▶ media-rust
//   media-rust ──(1-byte uni stream on the publish session)──▶ sharer
//   sharer: the next encoded frame is an IDR (native: FFmpeg pict_type I with
//           forced-idr; browser: VideoEncoder.encode(frame, { keyFrame: true }))
//
// media-rust coalesces requests per sharer (at most one forced keyframe per
// ~400 ms however many viewers ask — see KEYFRAME_REQUEST_MIN_INTERVAL in
// services/media-rust/src/main.rs), and every hop also throttles locally so
// a decoder stuck waiting doesn't spam. Fully backward compatible: a 2.0.x
// sharer ignores the request (keeps its 2 s GOP), a 2.0.x server never reads
// the datagram, a 2.0.x viewer never sends one — the scheduled keyframe is
// always still there as the fallback.

/** The request byte, both on the wire (viewer → server datagram, server →
 *  publisher uni stream) — must match VIDEO_KEYFRAME_REQUEST in media-rust. */
export const KEYFRAME_REQUEST_BYTE = 0x4b;

/** Overlay window → engine (Tauri app event). Payload: {}. */
export const OVERLAY_KEYFRAME_REQUEST_EVENT = 'overlay-keyframe-request';

/** A viewer re-asks at most this often while it keeps waiting. Re-asking at
 *  all matters because the datagram can be lost; the server's own coalescing
 *  is what protects the sharer. */
export const VIEWER_REQUEST_INTERVAL_MS = 300;

/** The sharer forces at most one keyframe per this interval from requests
 *  (mirrors the server's window — a sharer on a pre-2.1 server, or forcing
 *  for its own reasons, still can't be made keyframe-heavy). */
export const PUBLISHER_FORCE_INTERVAL_MS = 400;

/** The sharer's own send pump dropping frames under congestion: a keyframe
 *  is the biggest frame there is, so forcing one into a congested link more
 *  often than this would only make the congestion worse. */
export const PUBLISHER_CONGESTION_FORCE_INTERVAL_MS = 1000;

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * A throttled trigger: `fire(...args)` calls `fn(...args)` unless it already
 * did so within the last `minIntervalMs`, and returns whether it fired.
 * Calls inside the window are dropped, not deferred — every caller here
 * re-triggers on its next dropped frame, so a deferred call would be
 * redundant. `reset()` re-arms it (e.g. a new subscription).
 */
export function createThrottledTrigger(fn, minIntervalMs, now = defaultNow) {
  let last = -Infinity;
  const fire = (...args) => {
    const t = now();
    if (t - last < minIntervalMs) return false;
    last = t;
    fn(...args);
    return true;
  };
  fire.reset = () => { last = -Infinity; };
  return fire;
}

/** The datagram a viewer sends on its video subscribe session. */
export const keyframeRequestDatagram = () => new Uint8Array([KEYFRAME_REQUEST_BYTE]);

/** True if a server → publisher signal stream's first byte is a keyframe request. */
export const isKeyframeRequestSignal = (bytes) => Boolean(bytes && bytes.length > 0 && bytes[0] === KEYFRAME_REQUEST_BYTE);
