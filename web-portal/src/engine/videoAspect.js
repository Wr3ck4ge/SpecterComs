// Stream aspect ratio for sizing viewers to the picture instead of a fixed
// 16:9 box (an ultrawide share then gets a wide, short video area — no black
// bars drawn inside it). Pure, unit-tested.

export const ASPECT_16_9 = 16 / 9;

/** The overlay's video area: 4:3 … 32:9; anything outside is fitted inside. */
export const OVERLAY_ASPECT_MIN = 4 / 3;
export const OVERLAY_ASPECT_MAX = 32 / 9;

/**
 * Aspect (w / h) of a stream, clamped to [min, max]; `fallback` when the
 * size is unknown or nonsense.
 */
export function streamAspect(width, height, { min = OVERLAY_ASPECT_MIN, max = OVERLAY_ASPECT_MAX, fallback = ASPECT_16_9 } = {}) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0 && h > 0) || !Number.isFinite(w / h)) return fallback;
  return Math.min(max, Math.max(min, w / h));
}

/** True if two aspects differ enough to be worth a re-layout (> 0.5 %). */
export function aspectChanged(a, b) {
  if (!(a > 0) || !(b > 0)) return a !== b;
  return Math.abs(a / b - 1) > 0.005;
}

/**
 * Overlay video area height (unscaled px) for a stream of `aspect` at the
 * overlay's `width`: 384 / (16:9) = 216, the old fixed STREAM_H.
 */
export function overlayStreamHeight(aspect, width = 384) {
  const a = Math.min(OVERLAY_ASPECT_MAX, Math.max(OVERLAY_ASPECT_MIN, aspect > 0 ? aspect : ASPECT_16_9));
  return Math.round(width / a);
}
