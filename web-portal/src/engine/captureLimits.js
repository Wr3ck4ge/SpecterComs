// Encode-size limits sent with capture_start (Rust CaptureConfig →
// capture::enc_dims). The native encoder scales the source by ONE factor —
// the smallest of these that applies, never up — so the aspect ratio is kept
// and nothing is letterboxed:
//   max_height  the profile's height (the old, only cap)
//   max_pixels  the profile's pixel count: an ultrawide source keeps its
//               shape at about the same encode cost (5120×1440 → 2714×762
//               at the 1080p profile, not 3840×1080 — twice the pixels — and
//               not a squeezed 1920×540)
//   max_width   3840: an absolute ceiling for very wide multi-monitor spans
// 16:9 and 16:10 sources come out exactly as before (the height cap rules).

export const MAX_NATIVE_ENCODE_WIDTH = 3840;

/** capture_start's size fields for a stream profile { width, height }. */
export function nativeCaptureLimits(profile) {
  const w = Math.max(0, Math.round(Number(profile?.width) || 0));
  const h = Math.max(0, Math.round(Number(profile?.height) || 0));
  return {
    max_height: h,
    max_width: MAX_NATIVE_ENCODE_WIDTH,
    max_pixels: w * h,
  };
}
