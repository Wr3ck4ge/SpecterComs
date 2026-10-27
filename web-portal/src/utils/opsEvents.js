// Shared operation-event helpers for the OPERATIONS header button (badge) and
// OpsCalendarPanel's "Now & soon" section. Plain functions over the events
// array so any surface holding the same list (WarRoom now, a tray cabinet
// later) derives identical state without reaching into WarRoom.

const DAY_MS = 24 * 3600 * 1000;
const SOON_MS = 30 * 60 * 1000;

// Live = launched, or started and not yet past end_time (no end_time means
// still running). Same rule the old Active Operations dropdown used.
export function isOpLive(ev, now = new Date()) {
  const start = new Date(ev.start_time);
  const end = ev.end_time ? new Date(ev.end_time) : null;
  return !!ev.launched || (start <= now && (!end || end >= now));
}

// "Now & soon": anything live/launched plus anything starting within 24h,
// soonest first. Slot availability itself is enforced inside
// EventGroupCompModal (JOIN/FULL per role), so this just picks the cards.
export function getActiveOpsCards(events, now = new Date()) {
  const in24h = new Date(now.getTime() + DAY_MS);
  return (events || [])
    .filter(ev => {
      const start = new Date(ev.start_time);
      return isOpLive(ev, now) || (start > now && start <= in24h);
    })
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
}

// OPERATIONS button badge: 'live' if anything is live, else 'soon' (with the
// nearest op) if one starts within 30 minutes, else 'count' of upcoming ops,
// else null (no badge).
export function getOpsBadge(events, now = new Date()) {
  const list = events || [];
  if (list.some(ev => isOpLive(ev, now))) return { kind: 'live' };
  const soon = list
    .filter(ev => {
      const startsIn = new Date(ev.start_time) - now;
      return startsIn > 0 && startsIn <= SOON_MS;
    })
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0];
  if (soon) return { kind: 'soon', event: soon };
  const count = list.filter(ev => !ev.end_time || new Date(ev.end_time) > now).length;
  return count > 0 ? { kind: 'count', count } : null;
}

// How far ahead the strip's Notifications cabinet looks for ops with open
// slots you could join (ops you're signed up for use SOON_MS).
export const OPEN_SLOTS_WINDOW_MS = 60 * 60 * 1000;

/**
 * Notification items for the tray strip, soonest first:
 *  - kind 'mine': an op you're signed up for (from GET /users/me/upcoming-
 *    events, any server) that's live or starts within 30 minutes.
 *  - kind 'open': an op on the current server (`events`, from GET
 *    /orgs/:id/events) you're NOT signed up for, open-access, not yet
 *    launched, starting within the hour (or already started), with free slots.
 * Each item: { key, kind, phase: 'live' | 'soon', event, orgId }. `key`
 * includes the phase, so an op going live notifies again after "soon" was read.
 */
export function getOpsNotifications({ mine = [], events = [], orgId = null, now = new Date() }) {
  const items = [];
  const mineIds = new Set();
  for (const ev of mine || []) {
    mineIds.add(ev.id);
    const live = isOpLive(ev, now);
    const startsIn = new Date(ev.start_time) - now;
    if (!live && !(startsIn > 0 && startsIn <= SOON_MS)) continue;
    const phase = live ? 'live' : 'soon';
    items.push({ key: `mine:${ev.id}:${phase}`, kind: 'mine', phase, event: ev, orgId: ev.org_id || orgId });
  }
  for (const ev of events || []) {
    if (mineIds.has(ev.id) || ev.launched) continue;
    if ((ev.access_mode || 'open') !== 'open') continue;
    const total = Number(ev.total_slots) || 0;
    if (total <= 0 || (Number(ev.filled_slots) || 0) >= total) continue;
    if (ev.end_time && new Date(ev.end_time) <= now) continue;
    const startsIn = new Date(ev.start_time) - now;
    if (startsIn > OPEN_SLOTS_WINDOW_MS) continue;
    const phase = startsIn <= 0 ? 'live' : 'soon';
    items.push({ key: `open:${ev.id}:${phase}`, kind: 'open', phase, event: ev, orgId });
  }
  return items.sort((a, b) => new Date(a.event.start_time) - new Date(b.event.start_time));
}

// Milliseconds until the badge or the "Now & soon" set can next change on its
// own (an op entering the 24h, 1h (strip notifications) or 30min window,
// starting, or ending), so the
// caller can schedule one re-render instead of polling. null = nothing pending.
export function msUntilNextOpsChange(events, now = new Date()) {
  let next = Infinity;
  for (const ev of events || []) {
    const start = new Date(ev.start_time).getTime();
    const points = [start - DAY_MS, start - OPEN_SLOTS_WINDOW_MS, start - SOON_MS, start];
    if (ev.end_time) points.push(new Date(ev.end_time).getTime() + 1);
    for (const t of points) {
      const delta = t - now.getTime();
      if (delta > 0 && delta < next) next = delta;
    }
  }
  return next === Infinity ? null : next;
}
