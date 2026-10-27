// BAR2: non-component helpers for the bar's slot row (StripBarSlots.jsx) and
// its voice slots (voiceSlots.jsx), kept out of the component files for fast
// refresh.

// Slot priorities: lower = more important; also the order the row shows them.
export const SLOT_PRIORITY = Object.freeze({
  speaker: 10,
  stream: 20,
  watch: 25, // SV: someone is sharing — watch them in the strip
  overlay: 30,
  // An update waiting to install outranks the live-op chip, so it stays
  // visible while in voice (it's short-lived and important).
  update: 35,
  liveOp: 40,
  notInVoice: 60, // the speaker chip outside voice: only when there's room
});

export const SLOT_GAP = 4; // px, matches the row's gap-1

/**
 * Which slots fit in `width`: by priority, stopping at the first one that
 * doesn't fit — so a slot only ever hides after everything less important
 * than it has (a small low-priority chip never squeezes in past a hidden
 * important one).
 */
export function fitSlots(slots, width) {
  const sorted = [...slots].sort((a, b) => a.priority - b.priority);
  if (!(width > 0)) return sorted;
  const shown = [];
  let used = 0;
  for (const s of sorted) {
    const need = (shown.length ? SLOT_GAP : 0) + (s.minWidth || 0);
    if (used + need > width) break;
    shown.push(s);
    used += need;
  }
  return shown;
}

/**
 * Who the speaker chip names. speaking: callsigns (engine-levels `speaking`);
 * me: my callsign; transmitting: I'm on air (PTT held). Other people come
 * first (they're what you want to see); "You" when it's only me. Returns
 * null when nobody is talking.
 */
export function pickSpeaker({ speaking = [], me = null, transmitting = false }) {
  const others = speaking.filter((c) => c && c !== me);
  const meOn = transmitting || (me != null && speaking.includes(me));
  if (!others.length && !meOn) return null;
  if (!others.length) return { name: 'You', isMe: true, extra: 0, all: ['You'] };
  return { name: others[0], isMe: false, extra: others.length - 1 + (meOn ? 1 : 0), all: meOn ? [...others, 'you'] : others };
}
