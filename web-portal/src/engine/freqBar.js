/**
 * Frequency bar: the overlay row under the main bar that shows which
 * frequencies have someone talking. Pure helpers (no React / Tauri).
 */

/** Fixed bar height (px, unscaled) while visible; 0 when nobody is speaking. */
export const FREQ_BAR_H = 28;

/**
 * Which chips to show.
 *  freqs:       [{ id, name, speaker }] one per connected frequency
 *  missionWide: { playing, speaker } | null (Mission Wide audio playing)
 *  activeNet:   resolveActiveNet() result ({ kind, txNetId })
 * Mission Wide first (red), then frequencies in input order. A frequency chip
 * is `tx` when it is my active TX net. Returns [] when nobody is speaking.
 */
export function freqBarChips({ freqs, missionWide, activeNet } = {}) {
  const chips = [];
  if (missionWide?.playing) {
    chips.push({
      key: 'mission', label: 'MISSION WIDE', speaker: missionWide.speaker || null,
      mission: true, tx: activeNet?.kind === 'mission',
    });
  }
  for (const f of freqs || []) {
    if (!f?.id || !f.speaker) continue;
    chips.push({
      key: f.id, label: f.name || 'FREQ', speaker: f.speaker,
      mission: false, tx: activeNet?.kind === 'frequency' && activeNet.txNetId === f.id,
    });
  }
  return chips;
}

/** Bar height for a chip list: fixed while any chip, else 0 (collapsed). */
export function freqBarHeight(chips) {
  return chips && chips.length > 0 ? FREQ_BAR_H : 0;
}

/**
 * Total overlay height and the stream window's top offset. The stream sits
 * below header + picker + frequency bar, so the bar pushes it down by exactly
 * its own height; the DM area is below the stream.
 */
export function overlayLayout({ headerH = 0, pickerH = 0, freqBarH = 0, videoH = 0, toastH = 0 } = {}) {
  const streamTop = headerH + pickerH + freqBarH;
  return { freqBarTop: headerH + pickerH, streamTop, totalH: streamTop + videoH + toastH };
}
