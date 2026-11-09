// Viewer-side decoder recovery, shared by the engine's own decoder
// (CommLink processVideoData), the strip viewer (useStripStream) and the
// overlay window (GameOverlayWindow).
//
// The failure this exists for: a VideoDecoder error closes the decoder, and
// every viewer then sat on the last painted frame — the main window silently
// skipped decode() on a closed decoder, the strip showed a terminal "error"
// until someone pressed Retry, and none of it was traced. Viewers saw "one
// frame, then frozen until I re-open it". Now, on an error, a closed decoder,
// a decode() that throws, or a stall (frames keep going in, nothing comes out
// for DECODE_STALL_MS), the owner recreates the decoder, waits for the next
// keyframe and asks the sharer for one (keyframeRequest.js) — bounded by a
// recovery budget so a stream that can never decode here doesn't loop.
//
// Everything here is pure (injectable clock) so it is unit-tested.

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Frames going in with nothing coming out for this long = stalled. */
export const DECODE_STALL_MS = 2000;

/** At most this many automatic recoveries per RECOVERY_WINDOW_MS. */
export const RECOVERY_MAX = 5;
export const RECOVERY_WINDOW_MS = 30_000;

/**
 * Tracks decoder input vs. output.
 *   watch.input()   a chunk went into decode()
 *   watch.output()  a frame came out
 *   watch.reset()   new / recreated decoder
 *   watch.stalled() inputs have been going in for ≥ stallMs since the last
 *                   output (or since the first input), and are still going in
 *                   — a paused sharer (static window: no frames at all) is
 *                   not a stall.
 */
export function createDecodeWatch({ stallMs = DECODE_STALL_MS, now = defaultNow } = {}) {
  let pendingSince = null; // first input since the last output
  let lastInput = null;
  return {
    input() {
      const t = now();
      if (pendingSince === null) pendingSince = t;
      lastInput = t;
    },
    output() { pendingSince = null; },
    reset() { pendingSince = null; lastInput = null; },
    stalled(t = now()) {
      return pendingSince !== null && lastInput !== null
        && t - pendingSince >= stallMs && t - lastInput < stallMs;
    },
  };
}

/** A sliding-window budget: take() is true at most `max` times per `windowMs`. */
export function createRecoveryBudget({ max = RECOVERY_MAX, windowMs = RECOVERY_WINDOW_MS, now = defaultNow } = {}) {
  let times = [];
  return {
    take() {
      const t = now();
      times = times.filter((x) => t - x < windowMs);
      if (times.length >= max) return false;
      times.push(t);
      return true;
    },
    reset() { times = []; },
    get used() { return times.length; },
  };
}

/**
 * Rate-limited logger: at most one line per `intervalMs`; the next line that
 * gets through says how many were suppressed. Returns whether it logged.
 */
export function createRateLimitedLog(log, { intervalMs = 5000, now = defaultNow } = {}) {
  let last = -Infinity;
  let suppressed = 0;
  return (msg) => {
    const t = now();
    if (t - last < intervalMs) { suppressed += 1; return false; }
    last = t;
    log(suppressed ? `${msg} (+${suppressed} suppressed)` : msg);
    suppressed = 0;
    return true;
  };
}

/**
 * Why a decoder needs recreating before the next decode, or null if it's fine.
 *   decoder   the VideoDecoder (or null)
 *   broken    its error callback fired
 *   watch     createDecodeWatch for it
 */
export function decoderRecoveryReason(decoder, { broken = false, watch = null, now } = {}) {
  if (!decoder) return null; // nothing to recover — the caller creates one on the next keyframe
  if (broken) return 'decoder error';
  if (decoder.state === 'closed') return 'decoder closed';
  if (watch && watch.stalled(now)) return `no output for ${DECODE_STALL_MS} ms`;
  return null;
}

/** Hardware decode errored this many times in a row → fall back to software. */
export const HW_ERRORS_BEFORE_SOFTWARE = 2;

// ── CommLink main-decoder stall decision ────────────────────────────────────
/** Queue depth that, together with STALL_QUEUE_MS without output, means wedged. */
export const STALL_QUEUE_SIZE = 30;
export const STALL_QUEUE_MS = 1000;
/** Consecutive failed recoveries before giving up on in-place reset and doing a full resubscribe. */
export const RECOVER_ATTEMPTS_BEFORE_RESUBSCRIBE = 3;
/** A recovery that has held this long counts as having worked (attempts reset). */
export const RECOVERY_STABLE_MS = 15_000;

/** Wait before the next in-place recovery: none for the first, then 1 s, 2 s, 4 s (cap 8 s). */
export const recoverBackoffMs = (attempts) => (attempts <= 0 ? 0 : Math.min(1000 * 2 ** (attempts - 1), 8000));

/**
 * Pure decision for the viewer's main decoder.
 *   broken / state / queueSize   decoder health
 *   lastDecodedTs   last output time, or the first input since it; null = nothing pending
 *   lastPacketTs    last time a packet arrived
 *   lastRecoverTs   when the previous recovery ran (null = never)
 *   attempts        consecutive recoveries that have not yet proven stable
 * Returns { action: 'none' | 'reset' | 'resubscribe', reason }.
 */
export function decideVideoRecovery({
  broken = false, state = 'configured', queueSize = 0, lastDecodedTs = null, lastPacketTs = null,
  lastRecoverTs = null, attempts = 0, now = defaultNow(),
} = {}) {
  let reason = null;
  const idle = lastDecodedTs === null ? null : now - lastDecodedTs;
  const packetsFlowing = lastPacketTs !== null && now - lastPacketTs < DECODE_STALL_MS;
  if (broken) reason = 'decoder error';
  else if (state === 'closed') reason = 'decoder closed';
  else if (idle !== null && packetsFlowing && queueSize >= STALL_QUEUE_SIZE && idle >= STALL_QUEUE_MS) reason = `queue ${queueSize} with no output for ${Math.round(idle)} ms`;
  else if (idle !== null && packetsFlowing && idle >= DECODE_STALL_MS) reason = `no output for ${Math.round(idle)} ms`;
  if (!reason) return { action: 'none', reason: null };
  if (attempts >= RECOVER_ATTEMPTS_BEFORE_RESUBSCRIBE) return { action: 'resubscribe', reason };
  if (lastRecoverTs !== null && now - lastRecoverTs < recoverBackoffMs(attempts)) return { action: 'none', reason };
  return { action: 'reset', reason };
}
