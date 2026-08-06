// OpsCalendarPanel.jsx — the full (non-collapsing) ops calendar: month grid with
// operations plotted on their dates + a scrollable-by-month header, plus a
// scheduled-operations list below. Shared by ServerHome.jsx (server landing page)
// and WarRoom.jsx (CALENDAR header toggle) so both surfaces show the identical
// expanded calendar instead of WarRoom keeping its own cramped, collapsed variant.
import React from 'react';
import { api } from '../api';

// ── Event history: ended operations grouped by month, attendance on expand ──
function EventHistoryPanel({ orgId }) {
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

  if (loading) return <div className="text-xs text-white/30 italic py-2">Loading history…</div>;
  if (!history || history.length === 0) return <div className="text-xs text-white/30 italic py-2">No completed operations yet</div>;

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
    <div className="flex flex-col gap-3">
      {months.map(key => (
        <div key={key}>
          <div className="text-[11px] text-cyan-600 tracking-[0.3em] uppercase mb-1">{byMonth[key].label}</div>
          <div className="flex flex-col gap-1">
            {byMonth[key].items.map(ev => {
              const attendance = attendanceById[ev.id];
              const isExpanded = expandedId === ev.id;
              const attendeeCount = Number(ev.attendee_count) || 0;
              return (
                <div key={ev.id} className="glass-card">
                  <div
                    className="flex items-center gap-2.5 py-2 px-2 cursor-pointer"
                    onClick={() => toggleExpand(ev)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-white/80 truncate">{ev.name}</div>
                      <div className="text-[11px] text-cyan-600">
                        {new Date(ev.ended_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {' · '}{attendeeCount} attended
                      </div>
                    </div>
                    <span className="text-[11px] text-white/40">{isExpanded ? '▲' : '▼'}</span>
                  </div>
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid #0e2233', padding: '8px 10px' }}>
                      {attendanceLoading && !attendance && (
                        <div className="text-[11px] text-white/30 italic">Loading attendance…</div>
                      )}
                      {attendance && attendance.every(g => (g.members || []).length === 0) && (
                        <div className="text-[11px] text-white/30 italic">No attendance recorded</div>
                      )}
                      {attendance?.map(g => {
                        const accepted = (g.members || []).filter(m => m.status === 'accepted');
                        if (accepted.length === 0) return null;
                        return (
                          <div key={g.id} className="mb-1.5 last:mb-0">
                            <div className="text-[10px] text-cyan-600 tracking-[0.2em] uppercase">{g.name}</div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {accepted.map(m => (
                                <span key={m.user_id} className="text-[11px] text-white/70 rounded px-1.5 py-0.5" style={{ background: 'rgba(8,145,178,0.12)', border: '1px solid rgba(8,145,178,0.3)' }}>
                                  {m.callsign}{m.role ? ` — ${m.role}` : ''}
                                </span>
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

function formatEventTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

function getSignupSummary(ev) {
  const filled = Number(ev?.filled_slots ?? ev?.signup_count ?? ev?.accepted_signups ?? ev?.confirmed_signups ?? 0);
  const total = Number(ev?.total_slots ?? ev?.max_slots ?? ev?.signup_slots ?? ev?.requested_slots ?? 0);
  if (Number.isFinite(total) && total > 0) return `${filled}/${total}`;
  if (Number.isFinite(filled) && filled > 0) return `${filled}`;
  return null;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Kept in sync with WarRoom.jsx's GLASS_PANEL constant — same treatment,
// applied universally across panel-level elements across the app.
const glass = {
  backdropFilter: 'blur(14px)',
  background: 'linear-gradient(180deg, rgba(4,12,23,0.82), rgba(2,8,16,0.72))',
  border: '1px solid rgba(56,189,248,0.35)',
  boxShadow: 'inset 0 1px 0 rgba(34,211,238,0.06), 0 0 0 1px rgba(34,211,238,0.16), 0 0 26px rgba(34,211,238,0.28), 0 18px 48px rgba(0,0,0,0.35)',
};

export default function OpsCalendarPanel({
  events,
  orgId,
  canScheduleEvents,
  onSchedule,
  onOpenEvent,
  onLaunchEvent,
  canLaunchEvent,
}) {
  const now = new Date();
  const [view, setView] = React.useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const [tab, setTab] = React.useState('calendar'); // 'calendar' | 'history'

  const upcomingEvents = (events || [])
    .filter(e => !e.end_time || new Date(e.end_time) > now)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  const monthStart = new Date(view.year, view.month, 1);
  const firstWeekday = monthStart.getDay();
  const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
  const cells = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  const eventsOnDay = (day) => (events || []).filter(e => {
    const d = new Date(e.start_time);
    return d.getDate() === day && d.getMonth() === view.month && d.getFullYear() === view.year;
  });

  const hasActiveOp = (day) => (events || []).some(e => {
    const target = new Date(view.year, view.month, day, 12);
    return new Date(e.start_time) <= target && (!e.end_time || new Date(e.end_time) >= target);
  });

  const visibleEvents = upcomingEvents.slice(0, 8);
  const activeOpCount = (events || []).filter(e => e.launched).length;

  const prevMonth = () => {
    const d = new Date(view.year, view.month - 1, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  const nextMonth = () => {
    const d = new Date(view.year, view.month + 1, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  return (
    <div style={{ ...glass, borderRadius: 18, padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 10, color: '#67e8f9', letterSpacing: '0.35em' }}>OPS CALENDAR</span>
        <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, rgba(34,211,238,0.45), rgba(14,34,51,0.1))' }} />
        {canScheduleEvents && onSchedule && (
          <button
            onClick={onSchedule}
            style={{
              fontSize: 10, padding: '3px 10px', borderRadius: 3,
              background: 'rgba(4,30,46,0.85)', border: '1px solid rgba(8,145,178,0.7)',
              color: '#22d3ee', cursor: 'pointer', letterSpacing: '0.15em', flexShrink: 0,
              backdropFilter: 'blur(10px)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#072a40'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#041e2e'; }}
          >
            + SCHEDULE OPERATION
          </button>
        )}
      </div>

      {orgId && (
        <div className="flex items-center gap-3 border-b border-white/10" style={{ marginBottom: 12, paddingBottom: 4 }}>
          {[['calendar', 'CALENDAR'], ['history', 'HISTORY']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setTab(val)}
              style={{
                fontSize: 11, letterSpacing: '0.2em', paddingBottom: 4, background: 'none', border: 'none', cursor: 'pointer',
                color: tab === val ? '#22d3ee' : '#64748b',
                borderBottom: tab === val ? '2px solid #22d3ee' : '2px solid transparent',
              }}
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <button onClick={prevMonth} style={{ color: '#94a3b8', background: 'transparent', border: 'none', cursor: 'pointer' }}>◀</button>
        <span style={{ fontSize: 14, color: '#67e8f9', letterSpacing: '0.28em' }}>
          {MONTH_NAMES[view.month]} {view.year}
        </span>
        <button onClick={nextMonth} style={{ color: '#94a3b8', background: 'transparent', border: 'none', cursor: 'pointer' }}>▶</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#0e7490', border: '1px solid rgba(14,116,144,0.45)', borderRadius: 999, padding: '3px 10px', letterSpacing: '0.18em' }}>
          {upcomingEvents.length} OPS
        </span>
        {activeOpCount > 0 && (
          <span style={{ fontSize: 10, color: '#4ade80', border: '1px solid rgba(74,222,128,0.35)', borderRadius: 999, padding: '3px 10px', letterSpacing: '0.18em' }}>
            {activeOpCount} ACTIVE
          </span>
        )}
      </div>

      <div style={{ overflowX: 'auto', overflowY: 'hidden', paddingBottom: 4, marginBottom: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(108px, 1fr))', gap: 6, minWidth: 780 }}>
          {DAY_NAMES.map(d => (
            <div key={d} style={{ fontSize: 10, color: '#526a7c', letterSpacing: '0.3em', textAlign: 'center', paddingBottom: 2 }}>
              {d}
            </div>
          ))}
          {cells.map((day, index) => {
            if (day === null) {
              return <div key={`pad-${index}`} style={{ minHeight: 104 }} />;
            }

            const dayEvents = eventsOnDay(day);
            const active = hasActiveOp(day);
            const isToday = day === now.getDate() && view.month === now.getMonth() && view.year === now.getFullYear();

            return (
              <div
                key={day}
                style={{
                  minHeight: 104,
                  padding: 6,
                  borderRadius: 10,
                  background: isToday ? 'rgba(8,145,178,0.16)' : active ? 'rgba(4,30,46,0.72)' : 'rgba(4,16,24,0.62)',
                  border: `1px solid ${isToday ? 'rgba(103,232,249,0.35)' : active ? 'rgba(8,145,178,0.22)' : 'rgba(14,34,51,0.7)'}`,
                  overflow: 'hidden',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: isToday ? '#67e8f9' : '#94a3b8', letterSpacing: '0.18em' }}>{day}</span>
                  {dayEvents.length > 0 && (
                    <span style={{ fontSize: 9, color: '#0e7490', letterSpacing: '0.14em' }}>{dayEvents.length} OP</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {dayEvents.slice(0, 2).map(ev => {
                    const summary = getSignupSummary(ev);
                    const start = new Date(ev.start_time);
                    const timeText = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const live = start <= now && (!ev.end_time || new Date(ev.end_time) >= now);
                    return (
                      <button
                        key={ev.id}
                        onClick={() => onOpenEvent?.(ev)}
                        title={`${ev.name} — ${timeText}`}
                        style={{
                          textAlign: 'left', width: '100%', padding: '4px 5px', borderRadius: 6,
                          background: live ? 'rgba(6,182,212,0.14)' : 'rgba(10,30,42,0.95)',
                          border: `1px solid ${live ? 'rgba(6,182,212,0.35)' : 'rgba(14,58,80,0.82)'}`,
                          color: live ? '#67e8f9' : '#7dd3fc', cursor: 'pointer', overflow: 'hidden',
                        }}
                      >
                        <div style={{ fontSize: 9, letterSpacing: '0.08em', color: '#94a3b8' }}>{timeText}</div>
                        <div style={{ fontSize: 10, fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.name}</div>
                        {summary && (
                          <div style={{ fontSize: 9, color: '#94a3b8' }}>{summary} signups</div>
                        )}
                      </button>
                    );
                  })}
                  {dayEvents.length > 2 && (
                    <div style={{ fontSize: 9, color: '#526a7c', letterSpacing: '0.1em' }}>+{dayEvents.length - 2} MORE</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.3em', marginBottom: 8 }}>
        SCHEDULED OPERATIONS
      </div>
      {visibleEvents.length === 0 ? (
        <div style={{ fontSize: 12, color: '#0e7490', fontStyle: 'italic', padding: '6px 0 2px' }}>
          No scheduled operations.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 14px', borderRadius: 14,
                  background: 'rgba(4,16,24,0.82)',
                  border: `1px solid ${ev.launched ? 'rgba(34,197,94,0.28)' : live ? 'rgba(14,74,90,0.62)' : 'rgba(14,34,51,0.9)'}`,
                  cursor: onOpenEvent ? 'pointer' : 'default',
                }}
              >
                <div style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, flexShrink: 0, background: ev.launched ? '#22c55e' : live ? '#0891b2' : '#1d4a5a', minHeight: 28 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 'bold', color: '#e5e7eb', letterSpacing: '0.05em', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {ev.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#0891b2', letterSpacing: '0.08em' }}>
                    {formatEventTime(ev.start_time)}
                  </div>
                  {summary && (
                    <div style={{ fontSize: 10, color: '#64748b', letterSpacing: '0.06em', marginTop: 2 }}>
                      {totalSlots > 0 ? `${summary}/${totalSlots}` : summary} signups
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {canLaunch && (
                    <button
                      onClick={e => { e.stopPropagation(); onLaunchEvent(ev); }}
                      style={{
                        fontSize: 10, color: '#22d3ee', border: '1px solid #0e4a5a',
                        borderRadius: 3, padding: '2px 8px', letterSpacing: '0.2em',
                        background: '#041e2e', cursor: 'pointer', flexShrink: 0,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#072a40'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#041e2e'; }}
                    >
                      LAUNCH
                    </button>
                  )}
                  {ev.launched && (
                    <span style={{ fontSize: 10, color: '#22c55e', border: '1px solid #166534', borderRadius: 3, padding: '2px 8px', letterSpacing: '0.2em', flexShrink: 0 }}>
                      LAUNCHED
                    </span>
                  )}
                  {live && !ev.launched && (
                    <span className="badge-live flex-shrink-0" style={{ fontSize: 10, padding: '2px 8px', letterSpacing: '0.2em' }}>
                      LIVE
                    </span>
                  )}
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
