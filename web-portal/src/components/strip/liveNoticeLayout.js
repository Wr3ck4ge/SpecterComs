// LIVE: placement of the live-op notice that slides out of the bar's side
// (LiveOpNotice.jsx) and the pure helpers behind useLiveNotices. Kept out of
// the component files for fast refresh and unit tests
// (test/live-notice.test.js).
//
// The strip window is the whole work area (strip.rs), so the notice never
// resizes the window: it is one more `data-strip-region` rect, placed beside
// the measured bar, in the bar's own height band. Left of the bar by default
// (the strip normally sits by the tray, at the right); if there isn't room on
// the left (strip docked near the left screen edge, a left taskbar) it goes
// right of the bar instead.

export const LIVE_NOTICE_W = 340;     // the expanded notice
export const LIVE_NOTICE_MIN_W = 240; // narrower than this: try the other side
export const LIVE_TAB_W = 40;         // the collapsed pulsing tab
export const LIVE_GAP = 6;            // between the bar and the notice
export const LIVE_MARGIN = 8;         // strip.rs STRIP_MARGIN, to the screen edge
export const LIVE_AUTO_COLLAPSE_MS = 15_000;

/**
 * Where the notice goes. bar = the bar panel's rect in viewport px
 * ({ left, right, top, bottom }); vw = viewport width. `tab` = the collapsed
 * tab (the side is picked for the FULL notice either way, so the tab sits
 * where the notice opens).
 * Returns { side: 'left' | 'right', left, top, width, height }.
 */
export function liveNoticeLayout({ vw, bar, tab = false, width = LIVE_NOTICE_W }) {
  const roomLeft = Math.max(0, bar.left - LIVE_MARGIN - LIVE_GAP);
  const roomRight = Math.max(0, vw - LIVE_MARGIN - LIVE_GAP - bar.right);
  const fits = (room) => room >= Math.min(width, LIVE_NOTICE_MIN_W);
  let side;
  if (fits(roomLeft)) side = 'left';
  else if (fits(roomRight)) side = 'right';
  else side = roomLeft >= roomRight ? 'left' : 'right';
  const room = side === 'left' ? roomLeft : roomRight;
  const w = Math.max(0, Math.min(tab ? LIVE_TAB_W : width, room));
  return {
    side,
    left: side === 'left' ? bar.left - LIVE_GAP - w : bar.right + LIVE_GAP,
    top: bar.top,
    width: w,
    height: Math.max(0, bar.bottom - bar.top),
  };
}

/** "19:00" / "Tue 19:00" (not today). */
export function fmtStart(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** "just now" / "5 min" / "1 h 20 min". */
export function fmtDuration(ms) {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * The timing line: "Live 12 min · started 19:00" when we saw the launch,
 * else "Started 19:00".
 */
export function liveTimingText(op, now = Date.now()) {
  const start = fmtStart(op.startTime, new Date(now));
  if (op.liveSince) {
    const live = fmtDuration(now - op.liveSince);
    const head = live === 'just now' ? 'Live just now' : `Live ${live}`;
    return start ? `${head} · started ${start}` : head;
  }
  return start ? `Started ${start}` : '';
}

/**
 * The notices to show: live ops not dismissed. Dismissal is per launch
 * (`key`), so the same launch never comes back once dismissed.
 */
export const visibleLiveOps = (liveOps = [], dismissed = new Set()) => liveOps.filter((o) => !dismissed.has(o.key));

/** Live ops that haven't been announced yet (they pop the notice open). */
export const newLiveOps = (ops = [], announced = new Set()) => ops.filter((o) => !announced.has(o.key));

/**
 * Dismissed keys worth keeping: only launches that are still live (bounded
 * storage). Untouched while the list is unknown (engine not connected yet),
 * so a restart can't forget what was dismissed.
 */
export function pruneDismissed(dismissed, liveOps, known) {
  if (!known) return dismissed;
  const live = new Set(liveOps.map((o) => o.key));
  const next = new Set([...dismissed].filter((k) => live.has(k)));
  return next.size === dismissed.size ? dismissed : next;
}

/**
 * Who's in it, from the engine's channel list (only for the engine's current
 * server): my group's channel and how many are in the op's voice channels now.
 * Returns { group: { id, name, inVoice, canJoin } | null, inVoice: number | null }.
 */
export function opPresence(op, engineState) {
  if (!op || engineState?.org?.id !== op.orgId) return { group: null, inVoice: null };
  const chans = (engineState.channels || []).filter((c) => c.eventId === op.eventId && c.kind === 'voice');
  if (!chans.length) return { group: null, inVoice: null };
  const mine = chans.find((c) => c.mine) || null;
  return {
    group: mine ? { id: mine.id, name: mine.name, inVoice: mine.occupants.length, canJoin: mine.canJoin !== false } : null,
    inVoice: chans.reduce((n, c) => n + c.occupants.length, 0),
  };
}
