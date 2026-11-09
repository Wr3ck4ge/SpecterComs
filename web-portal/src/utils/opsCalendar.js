// Month-calendar helpers for the operations views: OpsCalendarPanel (main
// window) and the tray strip's Operations cabinet. Plain functions over the
// events array from GET /orgs/:id/events.

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Events without an explicit end_time are treated as stale after this many hours
export const MAX_OP_HOURS = 12;

export const effectiveOpEnd = (e) => e.end_time
  ? new Date(e.end_time)
  : new Date(new Date(e.start_time).getTime() + MAX_OP_HOURS * 3600 * 1000);

// Ops that haven't ended yet (by effectiveOpEnd), soonest first.
export function getUpcomingOps(events, now = new Date()) {
  return (events || [])
    .filter(e => effectiveOpEnd(e) > now)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
}

// Day cells for a month grid: leading nulls up to the first weekday, then 1..n.
export function monthCells(year, month) {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
}

// The { year, month } `delta` months away.
export function shiftMonth(view, delta) {
  const d = new Date(view.year, view.month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

// Ops starting on a given day (local time).
export function opsOnDay(events, year, month, day) {
  return (events || []).filter(e => {
    const d = new Date(e.start_time);
    return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
  });
}

// Whether any op spans midday of a given day.
export function hasActiveOpOnDay(events, year, month, day) {
  return (events || []).some(e => {
    const target = new Date(year, month, day, 12);
    return new Date(e.start_time) <= target && effectiveOpEnd(e) >= target;
  });
}

// "YYYY-MM-DD" for a grid cell (the planner's initialDate).
export const dateKey = (year, month, day) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// "filled/total" (or just "filled") signups, or null when there's nothing to show.
export function getSignupSummary(ev) {
  const filled = Number(ev?.filled_slots ?? ev?.signup_count ?? ev?.accepted_signups ?? ev?.confirmed_signups ?? 0);
  const total = Number(ev?.total_slots ?? ev?.max_slots ?? ev?.signup_slots ?? ev?.requested_slots ?? 0);
  if (Number.isFinite(total) && total > 0) return `${filled}/${total}`;
  if (Number.isFinite(filled) && filled > 0) return `${filled}`;
  return null;
}
