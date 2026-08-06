// ServerHome.jsx — Server landing page shown when an org is selected but no channel is active
import React from 'react';
import OpsCalendarPanel from './OpsCalendarPanel';

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
  const canShowCalendar = canViewCalendar !== false && org?.show_calendar_on_landing !== false;

  // Kept in sync with WarRoom.jsx's GLASS_PANEL constant — same treatment,
  // applied universally across panel-level elements in both files.
  const glass = {
    backdropFilter: 'blur(14px)',
    background: 'linear-gradient(180deg, rgba(4,12,23,0.82), rgba(2,8,16,0.72))',
    border: '1px solid rgba(56,189,248,0.35)',
    boxShadow: 'inset 0 1px 0 rgba(34,211,238,0.06), 0 0 0 1px rgba(34,211,238,0.16), 0 0 26px rgba(34,211,238,0.28), 0 18px 48px rgba(0,0,0,0.35)',
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
          <OpsCalendarPanel
            events={events}
            orgId={org?.id}
            canScheduleEvents={canScheduleEvents}
            onSchedule={onOpenPlanner}
            onOpenEvent={onOpenEvent}
            onLaunchEvent={onLaunchEvent}
            canLaunchEvent={canLaunchEvent}
          />
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
