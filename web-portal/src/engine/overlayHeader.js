// OVH: the game overlay's header (GameOverlayWindow) — what the channel
// label says and how wide the overlay gets so it isn't clipped. Pure, so the
// rules are unit-tested (test/overlay-header.test.js).

/** The overlay's base width (CSS px at 100 %) and how far it may grow for a long channel name. */
export const OVERLAY_BASE_W = 384;
export const OVERLAY_MAX_W = 480;

/**
 * The channel label: { lead, tail, full }. In an op's group channel the label
 * is "<op> › <group>" — `lead` (the op) is the part that may be cut with an
 * ellipsis, `tail` (the group / frequency you're on) always stays whole, so a
 * long label is cut in the middle. Elsewhere it's just the channel name
 * (lead = name, tail = null), cut at the end if it has to be.
 */
export function overlayChannelLabel({ channelName = null, opName = null } = {}) {
  const name = (channelName || '').trim();
  const op = (opName || '').trim();
  if (!name) return { lead: 'No channel', tail: null, full: 'No channel' };
  if (op && op !== name) return { lead: op, tail: name, full: `${op} › ${name}` };
  return { lead: name, tail: null, full: name };
}

/**
 * The overlay's layout width (CSS px at 100 %, before the user's scale) so
 * the header fits its content: the base width, grown to fit the header's
 * natural width up to OVERLAY_MAX_W. The header's controls don't scale
 * (natural size) while the window is `width × scale`, so the need is divided
 * by the scale.
 *   headerNeed  natural width of the whole header row in CSS px
 *               (everything else + the label's unclipped width)
 */
export function overlayLayoutWidth({ headerNeed = 0, scale = 1, base = OVERLAY_BASE_W, max = OVERLAY_MAX_W } = {}) {
  const s = scale > 0 ? scale : 1;
  const want = Math.ceil((Number(headerNeed) || 0) / s);
  return Math.max(base, Math.min(max, want));
}
