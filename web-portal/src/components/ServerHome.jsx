// ServerHome.jsx — Server landing page shown when an org is selected but no channel is active
import React from 'react';

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

export default function ServerHome({
  org,
  events,
  members,
  onOpenPlanner,
  canViewCalendar,
  canScheduleEvents,
  canLaunchEvent,
  onLaunchEvent,
  onOpenEvent,
}) {
  const now = new Date();
  const [view, setView] = React.useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));

  const landingEvents = (events || [])
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

  const visibleEvents = landingEvents.slice(0, 8);
  const activeOpCount = (events || []).filter(e => e.launched).length;
  const canShowCalendar = canViewCalendar !== false && org?.show_calendar_on_landing !== false;

  // Kept in sync with WarRoom.jsx's GLASS_PANEL constant — same treatment,
  // applied universally across panel-level elements in both files.
  const glass = {
    backdropFilter: 'blur(14px)',
    background: 'linear-gradient(180deg, rgba(4,12,23,0.82), rgba(2,8,16,0.72))',
    border: '1px solid rgba(56,189,248,0.35)',
    boxShadow: 'inset 0 1px 0 rgba(34,211,238,0.06), 0 0 0 1px rgba(34,211,238,0.16), 0 0 26px rgba(34,211,238,0.28), 0 18px 48px rgba(0,0,0,0.35)',
  };

  const prevMonth = () => {
    const d = new Date(view.year, view.month - 1, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  const nextMonth = () => {
    const d = new Date(view.year, view.month + 1, 1);
    setView({ year: d.getFullYear(), month: d.getMonth() });
  };

  return (
    <div
      className="flex-1 overflow-y-auto"
      style={{
        color: '#e5e7eb',
        fontFamily: 'monospace',
        background: 'radial-gradient(circle at top, rgba(6,182,212,0.10), transparent 34%), linear-gradient(180deg, #020b12 0%, #020810 100%)',
      }}
    >
      {org?.banner_url && (
        <div style={{ width: '100%', maxHeight: 150, overflow: 'hidden', flexShrink: 0, position: 'relative' }}>
          <img
            src={org.banner_url}
            alt="Server banner"
            style={{ width: '100%', height: 160, objectFit: 'cover', display: 'block' }}
          />
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(2,8,16,0.08), rgba(2,8,16,0.72))' }} />
        </div>
      )}

      <div style={{ padding: '24px 28px 28px' }}>
        {org?.landing_description && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.35em', marginBottom: 8 }}>
              BRIEFING / RULES
            </div>
            <div style={{ ...glass, borderRadius: 14, padding: '14px 16px', fontSize: 12, color: '#cbd5e1', lineHeight: 1.7, whiteSpace: 'pre-wrap', maxWidth: 1100 }}>
              {org.landing_description}
            </div>
          </div>
        )}

        {canShowCalendar && (
          <div style={{ ...glass, borderRadius: 18, padding: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 10, color: '#67e8f9', letterSpacing: '0.35em' }}>OPS CALENDAR</span>
              <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, rgba(34,211,238,0.45), rgba(14,34,51,0.1))' }} />
              {canScheduleEvents && (
                <button
                  onClick={onOpenPlanner}
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

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <button onClick={prevMonth} style={{ color: '#94a3b8', background: 'transparent', border: 'none', cursor: 'pointer' }}>◀</button>
              <span style={{ fontSize: 14, color: '#67e8f9', letterSpacing: '0.28em' }}>
                {MONTH_NAMES[view.month]} {view.year}
              </span>
              <button onClick={nextMonth} style={{ color: '#94a3b8', background: 'transparent', border: 'none', cursor: 'pointer' }}>▶</button>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: '#0e7490', border: '1px solid rgba(14,116,144,0.45)', borderRadius: 999, padding: '3px 10px', letterSpacing: '0.18em' }}>
                {landingEvents.length} OPS
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
          </div>
        )}

        {!canShowCalendar && (
          <div style={{ ...glass, borderRadius: 14, padding: '14px 16px', fontSize: 12, color: '#94a3b8' }}>
            Calendar access is disabled for this server.
          </div>
        )}
      </div>
    </div>
  );
}
