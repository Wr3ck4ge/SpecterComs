// Next-stream keybind + op-wide share listing (pure, unit-tested).
//
// Cycle order: off → s1 → … → sN → off → s1. A current target that is no
// longer listed restarts at s1.
export function nextWatchTarget(list, current) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = current == null ? -1 : list.indexOf(current);
  return idx >= list.length - 1 ? null : list[idx + 1];
}

// The streams I can watch: my group channel's sharers first, then sharers
// announced on my frequency nets (in net order), deduped, without myself.
// `freqSharers` = [{ channelId, sharers: [callsign] }] in frequency order.
// Returns { list, via } — via[callsign] = the frequency channel id to ask the
// ticket through (absent for group sharers).
export function mergeWatchableSharers({ groupSharers = [], freqSharers = [], self = null } = {}) {
  const list = [];
  const via = {};
  const seen = new Set();
  const add = (cs, channelId) => {
    if (!cs || cs === self || seen.has(cs)) return;
    seen.add(cs);
    list.push(cs);
    if (channelId) via[cs] = channelId;
  };
  for (const cs of groupSharers) add(cs, null);
  for (const f of freqSharers) for (const cs of f?.sharers || []) add(cs, f.channelId);
  return { list, via };
}

// The watch target to keep after the list changed: a target that is no longer
// listed goes to off (null). My own callsign (self-view) is always kept.
export function reconcileWatchTarget(list, current, self = null) {
  if (current == null) return null;
  if (self && current === self) return current;
  return list.includes(current) ? current : null;
}

// SHARE_ANNOUNCE control datagram: [0xFF, 0x01, available, ...callsign].
// media-rust rebuilds the callsign from the sending session, so it is
// authentic; a sender pads with one byte (the relay wants ≥ 4 bytes).
export const shareAnnounceDatagram = (available) => new Uint8Array([0xFF, 0x01, available ? 1 : 0, 0]);

export function parseShareAnnounce(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0x01) return null;
  const callsign = new TextDecoder().decode(bytes.subarray(3));
  if (!callsign) return null;
  return { available: bytes[2] !== 0, callsign };
}

// Apply one announce / roster Leave to a sharer list (returns the same array
// when nothing changed, so React state doesn't churn).
export function applySharerChange(list, { callsign, available }) {
  if (!callsign) return list;
  const has = list.includes(callsign);
  if (available) return has ? list : [...list, callsign];
  return has ? list.filter((c) => c !== callsign) : list;
}
