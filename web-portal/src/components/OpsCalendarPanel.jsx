// OpsCalendarPanel.jsx — the full (non-collapsing) ops calendar: month grid with
// operations plotted on their dates + a scrollable-by-month header, plus a
// scheduled-operations list below, under a "Now & soon" strip. Rendered only by
// WarRoom.jsx (OPERATIONS header toggle), inline below the header.
import React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Rocket } from 'lucide-react';
import { api } from '../api';
import { fmtEventTime } from '../utils/format';
import { getActiveOpsCards, isOpLive } from '../utils/opsEvents';
import {
  DAY_NAMES, MONTH_NAMES, dateKey, getSignupSummary, getUpcomingOps, hasActiveOpOnDay, monthCells, opsOnDay, shiftMonth,
} from '../utils/opsCalendar';
import { Badge, Button, IconButton } from './ui';
import { cx, focusRing, glassPanel } from './ui/styles';

// Section label used throughout the panel.
function SectionLabel({ children, className = '' }) {
  return <h3 className={cx('text-ui-xs font-semibold text-specter-text-subtle', className)}>{children}</h3>;
}

// Small "Launch" action shared by the Now & soon cards and the scheduled list.
function LaunchButton({ onClick }) {
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<Rocket size={13} />}
      className="!h-7 !px-2.5 !text-ui-xs shrink-0"
      onClick={e => { e.stopPropagation(); onClick(); }}
    >
      Launch
    </Button>
  );
}

// ── Now & soon: live/launched ops plus anything starting within 24h ─────────
// Replaces WarRoom's old Active Operations dropdown. Prop-driven (takes the
// already-filtered cards) so a compact surface can reuse it as-is. Clicking a
// card opens the op (EventGroupCompModal handles JOIN per role); LAUNCH shows
// where the caller grants it, same rule as the scheduled list below.
// layout: 'wrap' (cards side by side, the main window) | 'list' (full-width
// stacked cards, for narrow surfaces like the tray strip).
export function OpsNowAndSoon({ cards, onOpenEvent, onLaunchEvent, canLaunchEvent, layout = 'wrap', className = 'mb-4' }) {
  const now = new Date();
  if (!cards || cards.length === 0) return null;
  const list = layout === 'list';
  return (
    <section className={cx('font-ui', className)}>
      <SectionLabel className="mb-2">Now &amp; soon</SectionLabel>
      <div className={list ? 'flex flex-col gap-1.5' : 'flex flex-wrap gap-2'}>
        {cards.map(ev => {
          const start = new Date(ev.start_time);
          const live = isOpLive(ev, now);
          const hasSlots = Number(ev.total_slots) > 0;
          const slotsOpen = hasSlots && Number(ev.filled_slots) < Number(ev.total_slots);
          const canLaunch = !!onLaunchEvent && !!canLaunchEvent?.(ev) && !ev.launched;
          return (
            <div
              key={ev.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpenEvent?.(ev)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenEvent?.(ev); } }}
              className={cx(
                list ? 'w-full px-3 py-2' : 'flex-shrink-0 min-w-[210px] max-w-[280px] p-3',
                'rounded-ui-md cursor-pointer text-left transition-colors',
                'bg-specter-bg-deep/50 border hover:bg-specter-bg-deep/70',
                live ? 'border-specter-state-success/40 hover:border-specter-state-success/60' : 'border-specter-border hover:border-specter-border-strong',
                focusRing,
              )}
            >
              {list ? (
                <div className="flex items-center gap-2.5">
                  {live ? (
                    <Badge variant="live" className="shrink-0" />
                  ) : (
                    <span className="shrink-0 font-mono text-ui-xs tabular-nums text-specter-primary-neon">
                      {start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-ui-sm font-semibold text-specter-text-main truncate">{ev.name}</div>
                    {hasSlots && (
                      <div className={cx('text-ui-xs', slotsOpen ? 'text-emerald-300' : 'text-specter-text-subtle')}>
                        {ev.filled_slots}/{ev.total_slots} slots{slotsOpen ? ' · open' : ''}
                      </div>
                    )}
                  </div>
                  {canLaunch && <LaunchButton onClick={() => onLaunchEvent(ev)} />}
                </div>
              ) : (<>
              <div className="flex items-center gap-2 mb-1.5 min-h-[28px]">
                {live ? (
                  <Badge variant="live" />
                ) : (
                  <span className="font-mono text-ui-xs tabular-nums text-specter-primary-neon">
                    {start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                <div className="flex-1" />
                {canLaunch && <LaunchButton onClick={() => onLaunchEvent(ev)} />}
              </div>
              <div className="text-ui-base font-semibold text-specter-text-main truncate">{ev.name}</div>
              {hasSlots && (
                <div className={cx('mt-0.5 text-ui-xs', slotsOpen ? 'text-emerald-300' : 'text-specter-text-subtle')}>
                  {ev.filled_slots}/{ev.total_slots} slots{slotsOpen ? ' · open' : ''}
                </div>
              )}
              </>)}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Event history: ended operations grouped by month, attendance on expand ──
// Exported for the tray strip's Operations cabinet (same list, narrower).
export function EventHistoryPanel({ orgId }) {
  const [history, setHistory] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [expandedId, setExpandedId] = React.useState(null);
  const [attendanceById, setAttendanceById] = React.useState({});
  const [attendanceLoading, setAttendanceLoading] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getOrgEventHistory(orgId).then(({ data }) => {
      if (!cancelled) { setHistory(data?.events || []); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [orgId]);

  const toggleExpand = async (ev) => {
    if (expandedId === ev.id) { setExpandedId(null); return; }
    setExpandedId(ev.id);
    if (attendanceById[ev.id]) return;
    setAttendanceLoading(true);
    const { data } = await api.getEventGroups(orgId, ev.id);
    setAttendanceLoading(false);
    setAttendanceById(prev => ({ ...prev, [ev.id]: data?.groups || [] }));
  };

  if (loading) return <div className="py-2 text-ui-sm text-specter-text-subtle">Loading history…</div>;
  if (!history || history.length === 0) return <div className="py-2 text-ui-sm text-specter-text-subtle">No completed operations yet</div>;

  // Group by month, most recent month first (history is already ended_at DESC).
  const months = [];
  const byMonth = {};
  for (const ev of history) {
    const d = new Date(ev.ended_at);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!byMonth[key]) { byMonth[key] = { label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`, items: [] }; months.push(key); }
    byMonth[key].items.push(ev);
  }

  return (
    <div className="flex flex-col gap-4">
      {months.map(key => (
        <div key={key}>
          <SectionLabel className="mb-1.5">{byMonth[key].label}</SectionLabel>
          <div className="flex flex-col gap-1.5">
            {byMonth[key].items.map(ev => {
              const attendance = attendanceById[ev.id];
              const isExpanded = expandedId === ev.id;
              const attendeeCount = Number(ev.attendee_count) || 0;
              return (
                <div key={ev.id} className="rounded-ui-md bg-specter-bg-deep/50 border border-specter-border-divider">
                  <button
                    type="button"
                    className={cx('w-full flex items-center gap-3 px-3 py-2 rounded-ui-md text-left hover:bg-white/5 transition-colors', focusRing)}
                    onClick={() => toggleExpand(ev)}
                    aria-expanded={isExpanded}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-ui-sm font-semibold text-specter-text-main truncate">{ev.name}</div>
                      <div className="text-ui-xs text-specter-text-subtle">
                        {new Date(ev.ended_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' · '}{attendeeCount} attended
                      </div>
                    </div>
                    <ChevronDown
                      size={15}
                      aria-hidden="true"
                      className={cx('shrink-0 text-specter-text-subtle transition-transform duration-150', isExpanded && 'rotate-180')}
                    />
                  </button>
                  {isExpanded && (
                    <div className="px-3 py-2 border-t border-specter-border-divider">
                      {attendanceLoading && !attendance && (
                        <div className="text-ui-xs text-specter-text-subtle">Loading attendance…</div>
                      )}
                      {attendance && attendance.every(g => (g.members || []).length === 0) && (
                        <div className="text-ui-xs text-specter-text-subtle">No attendance recorded</div>
                      )}
                      {attendance?.map(g => {
                        const accepted = (g.members || []).filter(m => m.status === 'accepted');
                        if (accepted.length === 0) return null;
                        return (
                          <div key={g.id} className="mb-2 last:mb-0">
                            <div className="text-ui-xs font-semibold text-specter-text-subtle">{g.name}</div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {accepted.map(m => (
                                <Badge key={m.user_id}>
                                  {m.callsign}{m.role ? ` — ${m.role}` : ''}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// getSignupSummary, MONTH_NAMES, DAY_NAMES and the month-grid helpers live in
// utils/opsCalendar (shared with the tray strip).

export default function OpsCalendarPanel({
  events,
  orgId,
  canScheduleEvents,
  onSchedule,
  onScheduleForDate,
  onOpenEvent,
  onLaunchEvent,
  canLaunchEvent,
}) {
  const now = new Date();
  const [view, setView] = React.useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const [tab, setTab] = React.useState('calendar'); // 'calendar' | 'history'

  const upcomingEvents = getUpcomingOps(events, now);
  const cells = monthCells(view.year, view.month);
  const eventsOnDay = (day) => opsOnDay(events, view.year, view.month, day);
  const hasActiveOp = (day) => hasActiveOpOnDay(events, view.year, view.month, day);

  const visibleEvents = upcomingEvents.slice(0, 8);
  const activeOpCount = (events || []).filter(e => e.launched).length;
  const nowCards = getActiveOpsCards(events, now);

  const prevMonth = () => setView(v => shiftMonth(v, -1));
  const nextMonth = () => setView(v => shiftMonth(v, 1));

  return (
    <div className={cx('rounded-ui-lg p-4 font-ui text-specter-text-main', glassPanel)}>
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-ui-lg font-semibold">Operations</h2>
        <div className="flex-1" />
        {canScheduleEvents && onSchedule && (
          <Button size="sm" icon={<Plus size={15} />} onClick={onSchedule}>
            Schedule operation
          </Button>
        )}
      </div>

      <OpsNowAndSoon
        cards={nowCards}
        onOpenEvent={onOpenEvent}
        onLaunchEvent={onLaunchEvent}
        canLaunchEvent={canLaunchEvent}
      />

      {orgId && (
        <div className="flex items-center gap-4 mb-3 border-b border-specter-border-divider" role="tablist">
          {[['calendar', 'Calendar'], ['history', 'History']].map(([val, label]) => (
            <button
              key={val}
              type="button"
              role="tab"
              aria-selected={tab === val}
              onClick={() => setTab(val)}
              className={cx(
                '-mb-px pb-2 pt-0.5 text-ui-sm font-medium border-b-2 transition-colors rounded-t-ui-sm',
                tab === val
                  ? 'border-specter-primary-neon text-specter-text-main'
                  : 'border-transparent text-specter-text-subtle hover:text-specter-text-main',
                focusRing,
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'history' && orgId ? (
        <EventHistoryPanel orgId={orgId} />
      ) : (
      <>
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        <IconButton size="sm" icon={<ChevronLeft size={16} />} label="Previous month" onClick={prevMonth} />
        <span className="min-w-[140px] text-center text-ui-base font-semibold">
          {MONTH_NAMES[view.month]} {view.year}
        </span>
        <IconButton size="sm" icon={<ChevronRight size={16} />} label="Next month" onClick={nextMonth} />
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <Badge>{upcomingEvents.length} upcoming</Badge>
          {activeOpCount > 0 && (
            <Badge variant="live">{activeOpCount} active</Badge>
          )}
        </div>
      </div>

      <div className="overflow-x-auto overflow-y-hidden pb-1 mb-4">
        <div className="grid gap-1.5 min-w-[780px]" style={{ gridTemplateColumns: 'repeat(7, minmax(108px, 1fr))' }}>
          {DAY_NAMES.map(d => (
            <div key={d} className="pb-0.5 text-center text-ui-xs text-specter-text-subtle">
              {d}
            </div>
          ))}
          {cells.map((day, index) => {
            if (day === null) {
              return <div key={`pad-${index}`} className="min-h-[76px]" />;
            }

            const dayEvents = eventsOnDay(day);
            const active = hasActiveOp(day);
            const isToday = day === now.getDate() && view.month === now.getMonth() && view.year === now.getFullYear();

            const isEmpty = dayEvents.length === 0;
            const cellDate = dateKey(view.year, view.month, day);
            const canScheduleHere = isEmpty && canScheduleEvents && onScheduleForDate;
            return (
              <div
                key={day}
                onClick={canScheduleHere ? () => onScheduleForDate(cellDate) : undefined}
                title={canScheduleHere ? 'Schedule an operation on this day' : undefined}
                className={cx(
                  'group/day min-h-[76px] p-1.5 rounded-ui-row border overflow-hidden transition-colors',
                  isToday
                    ? 'bg-specter-primary-cyan/10 border-specter-primary-cyan/50'
                    : active
                      ? 'bg-specter-bg-panel/60 border-specter-border'
                      : 'bg-specter-bg-deep/40 border-specter-border-divider',
                  canScheduleHere ? 'cursor-pointer hover:border-specter-border-strong hover:bg-specter-bg-panel/50' : 'cursor-default',
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <span
                    className={cx(
                      'inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-pill text-ui-xs tabular-nums',
                      isToday ? 'bg-specter-primary-cyan text-specter-bg-deep font-semibold' : 'text-specter-text-muted',
                    )}
                  >
                    {day}
                  </span>
                  {canScheduleHere && (
                    <Plus size={13} aria-hidden="true" className="text-specter-text-subtle opacity-0 group-hover/day:opacity-100 transition-opacity" />
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {dayEvents.slice(0, 2).map(ev => {
                    const summary = getSignupSummary(ev);
                    const start = new Date(ev.start_time);
                    const timeText = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const live = start <= now && (!ev.end_time || new Date(ev.end_time) >= now);
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => onOpenEvent?.(ev)}
                        title={`${ev.name} — ${timeText}`}
                        className={cx(
                          'w-full text-left px-1.5 py-1 rounded-ui-sm border overflow-hidden transition-colors',
                          live
                            ? 'bg-specter-primary-cyan/15 border-specter-primary-cyan/40 hover:bg-specter-primary-cyan/25'
                            : 'bg-specter-bg-panel/80 border-specter-border hover:border-specter-border-strong',
                          focusRing,
                        )}
                      >
                        <div className="font-mono text-[11px] leading-4 tabular-nums text-specter-text-subtle">{timeText}</div>
                        <div className="text-ui-xs font-semibold truncate text-specter-text-main">{ev.name}</div>
                        {summary && (
                          <div className="text-[11px] leading-4 text-specter-text-subtle">{summary} signups</div>
                        )}
                      </button>
                    );
                  })}
                  {dayEvents.length > 2 && (
                    <div className="px-1 text-[11px] text-specter-text-subtle">+{dayEvents.length - 2} more</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <SectionLabel className="mb-2">Scheduled operations</SectionLabel>
      {visibleEvents.length === 0 ? (
        <div className="py-1.5 text-ui-sm text-specter-text-subtle">
          No scheduled operations.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {visibleEvents.map(ev => {
            const start = new Date(ev.start_time);
            const end = ev.end_time ? new Date(ev.end_time) : null;
            const live = start <= now && (!end || end >= now);
            const summary = getSignupSummary(ev);
            const totalSlots = Number(ev.total_slots ?? ev.max_slots ?? ev.signup_slots ?? ev.requested_slots ?? 0);
            const canLaunch = !!onLaunchEvent && !!canLaunchEvent?.(ev) && !ev.launched;
            return (
              <div
                key={ev.id}
                onClick={() => onOpenEvent?.(ev)}
                className={cx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-ui-md border transition-colors bg-specter-bg-deep/50',
                  ev.launched ? 'border-specter-state-success/30' : live ? 'border-specter-border-strong' : 'border-specter-border-divider',
                  onOpenEvent ? 'cursor-pointer hover:bg-specter-bg-deep/70 hover:border-specter-border-strong' : 'cursor-default',
                )}
              >
                <div
                  aria-hidden="true"
                  className={cx(
                    'w-1 self-stretch min-h-[28px] rounded-pill flex-shrink-0',
                    ev.launched ? 'bg-specter-state-success' : live ? 'bg-specter-primary-cyan' : 'bg-specter-primary-dim',
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-ui-base font-semibold text-specter-text-main truncate">
                    {ev.name}
                  </div>
                  <div className="flex items-center gap-2 text-ui-xs">
                    <span className="font-mono tabular-nums text-specter-primary-neon">{fmtEventTime(ev.start_time)}</span>
                    {summary && (
                      <span className="text-specter-text-subtle">
                        · {totalSlots > 0 ? `${summary}/${totalSlots}` : summary} signups
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {canLaunch && <LaunchButton onClick={() => onLaunchEvent(ev)} />}
                  {ev.launched && (
                    <Badge className="!border-specter-state-success/40 !text-emerald-300">Launched</Badge>
                  )}
                  {live && !ev.launched && <Badge variant="live" />}
                </div>
              </div>
            );
          })}
        </div>
      )}
      </>
      )}
    </div>
  );
}
