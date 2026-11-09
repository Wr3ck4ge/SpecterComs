// Shared operation-event helpers for the OPERATIONS header button (badge) and
// OpsCalendarPanel's "Now & soon" section. Plain functions over the events
// array so any surface holding the same list (WarRoom now, a tray cabinet
// later) derives identical state without reaching into WarRoom.

import { effectiveOpEnd } from './opsCalendar';

const DAY_MS = 24 * 3600 * 1000;
const SOON_MS = 30 * 60 * 1000;

// Live = launched, and nothing else: an op is only launched when someone with
// permission presses Launch (POST /events/:id/launch, the one place the server
// sets `launched`). The clock never makes an op live, opens its channels or
// moves anyone. 2.0.12 and before also called any op past its start_time live,
// which is why ops looked launched on their own.
export function isOpLive(ev) {
  return !!ev?.launched;
}

// Due = the start time has passed, nobody has launched it yet, and it isn't
// over (an op with no end_time goes stale after MAX_OP_HOURS): "ready to
// launch". That's as far as time goes.
export function isOpDue(ev, now = new Date()) {
  if (!ev || ev.launched || ev.ended_at) return false;
  return new Date(ev.start_time) <= now && effectiveOpEnd(ev) >= now;
}

// "Now & soon": anything launched or due, plus anything starting within 24h,
// soonest first. Slot availability itself is enforced inside
// EventGroupCompModal (JOIN/FULL per role), so this just picks the cards.
export function getActiveOpsCards(events, now = new Date()) {
  const in24h = new Date(now.getTime() + DAY_MS);
  return (events || [])
    .filter(ev => {
      const start = new Date(ev.start_time);
      return isOpLive(ev) || isOpDue(ev, now) || (start > now && start <= in24h);
    })
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
}

// OPERATIONS button badge: 'live' if anything is launched, else 'soon' (with
// the nearest op) if one is due or starts within 30 minutes, else 'count' of
// upcoming ops, else null (no badge).
export function getOpsBadge(events, now = new Date()) {
  const list = events || [];
  if (list.some(ev => isOpLive(ev))) return { kind: 'live' };
  const soon = list
    .filter(ev => {
      const startsIn = new Date(ev.start_time) - now;
      return isOpDue(ev, now) || (startsIn > 0 && startsIn <= SOON_MS);
    })
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))[0];
  if (soon) return { kind: 'soon', event: soon };
  const count = list.filter(ev => !ev.end_time || new Date(ev.end_time) > now).length;
  return count > 0 ? { kind: 'count', count } : null;
}

/**
 * operation_ended: does this client move? Only if it's in voice and its
 * current channel, or one of its frequency channels, belongs to the op
 * (payload.channel_ids); everyone else on the server stays where they are.
 */
export function operationEndedMovesMe(payload, { voiceChannelId = null, frequencyChannelIds = [] } = {}) {
  if (!voiceChannelId || !Array.isArray(payload?.channel_ids)) return false;
  const opChannels = new Set(payload.channel_ids);
  return opChannels.has(voiceChannelId) || frequencyChannelIds.some((id) => opChannels.has(id));
}

// How far ahead the strip's Notifications cabinet looks for ops with open
// slots you could join (ops you're signed up for use SOON_MS).
export const OPEN_SLOTS_WINDOW_MS = 60 * 60 * 1000;

/**
 * Notification items for the tray strip, soonest first:
 *  - kind 'mine': an op you're signed up for (from GET /users/me/upcoming-
 *    events, any server) that's launched, due, or starts within 30 minutes.
 *  - kind 'open': an op on the current server (`events`, from GET
 *    /orgs/:id/events) you're NOT signed up for, open-access, not yet
 *    launched, starting within the hour (or already started), with free slots.
 * Each item: { key, kind, phase: 'live' | 'due' | 'soon', event, orgId }. `key`
 * includes the phase, so an op launching notifies again after "soon" was read.
 */
export function getOpsNotifications({ mine = [], events = [], orgId = null, now = new Date() }) {
  const items = [];
  const mineIds = new Set();
  for (const ev of mine || []) {
    mineIds.add(ev.id);
    const startsIn = new Date(ev.start_time) - now;
    const phase = isOpLive(ev) ? 'live' : isOpDue(ev, now) ? 'due' : startsIn > 0 && startsIn <= SOON_MS ? 'soon' : null;
    if (!phase) continue;
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
    const phase = startsIn <= 0 ? 'due' : 'soon';
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
