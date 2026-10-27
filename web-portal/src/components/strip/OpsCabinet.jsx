// Operations cabinet of the tray strip, in three tabs:
//   Calendar     the month grid only; tapping a day drills into that day's
//                ops (and "Schedule on this day" for schedulers); picking an op
//                opens the op view / planner (the wide op panel)
//   Now & soon   live and about-to-start ops (OpsNowAndSoon, list layout,
//                with Join / Launch), then the rest of the upcoming list
//   History      EventHistoryPanel, as in the main window
import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, History, Plus, Radio, Rocket } from 'lucide-react';
import { Alert, Badge, Button, IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { EventHistoryPanel, OpsNowAndSoon } from '../OpsCalendarPanel';
import { getActiveOpsCards, isOpLive } from '../../utils/opsEvents';
import {
  DAY_NAMES, MONTH_NAMES, dateKey, getSignupSummary, getUpcomingOps, hasActiveOpOnDay, monthCells, opsOnDay, shiftMonth,
} from '../../utils/opsCalendar';
import { fmtEventTime } from '../../utils/format';
import { PanelHeader, SectionLabel } from './stripOpsUi';

function MonthGrid({ events, view, setView, selectedDay, onPickDay }) {
  const now = new Date();
  const cells = monthCells(view.year, view.month);
  return (
    <div>
      <div className="flex items-center gap-1 mb-2">
        <IconButton size="sm" icon={<ChevronLeft size={15} />} label="Previous month" onClick={() => setView(shiftMonth(view, -1))} />
        <span className="flex-1 text-center text-ui-base font-semibold">{MONTH_NAMES[view.month]} {view.year}</span>
        <IconButton size="sm" icon={<ChevronRight size={15} />} label="Next month" onClick={() => setView(shiftMonth(view, 1))} />
      </div>
      <div className="grid grid-cols-7 gap-1" role="grid" aria-label="Operations calendar">
        {DAY_NAMES.map((d) => (
          <div key={d} className="text-center text-[11px] text-specter-text-subtle pb-0.5">{d.slice(0, 2)}</div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`pad-${i}`} />;
          const dayOps = opsOnDay(events, view.year, view.month, day);
          const active = hasActiveOpOnDay(events, view.year, view.month, day);
          const isToday = day === now.getDate() && view.month === now.getMonth() && view.year === now.getFullYear();
          const selected = selectedDay === day;
          const label = `${MONTH_NAMES[view.month]} ${day}: ${dayOps.length ? `${dayOps.length} operation${dayOps.length > 1 ? 's' : ''}` : 'no operations'}`;
          return (
            <button
              key={day}
              type="button"
              aria-label={label}
              aria-pressed={selected}
              onClick={() => onPickDay(day)}
              className={cx(
                'relative h-11 rounded-ui-sm flex flex-col items-center justify-center text-ui-sm tabular-nums transition-colors hover:bg-white/10',
                focusRing,
                selected ? 'bg-specter-primary-cyan/25 text-specter-text-main'
                  : isToday ? 'bg-specter-primary-cyan/10 text-specter-primary-neon font-semibold ring-1 ring-specter-primary-cyan/40'
                    : active ? 'bg-white/[0.05] text-specter-text-main' : dayOps.length ? 'text-specter-text-main' : 'text-specter-text-muted',
              )}
            >
              <span>{day}</span>
              {dayOps.length > 0 && (
                <span className="flex gap-0.5 mt-0.5" aria-hidden="true">
                  {dayOps.slice(0, 3).map((ev) => (
                    <span key={ev.id} className={cx('h-1.5 w-1.5 rounded-pill', ev.launched || isOpLive(ev, now) ? 'bg-specter-state-success' : 'bg-specter-primary-neon')} />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-ui-xs text-specter-text-subtle">Tap a day to see its operations.</p>
    </div>
  );
}

function OpRow({ ev, now, selected, canLaunch, onOpen, onLaunch }) {
  const live = isOpLive(ev, now) && !ev.launched;
  const summary = getSignupSummary(ev);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={selected || undefined}
      onClick={() => onOpen(ev)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(ev); } }}
      className={cx(
        'flex items-center gap-2.5 px-2.5 py-2 rounded-ui-md border cursor-pointer transition-colors',
        focusRing,
        selected ? 'bg-specter-primary-cyan/10 border-specter-primary-cyan/50'
          : 'bg-specter-bg-deep/50 border-specter-border-divider hover:border-specter-border-strong hover:bg-specter-bg-deep/70',
      )}
    >
      <span aria-hidden="true" className={cx('w-1 self-stretch min-h-[26px] rounded-pill shrink-0',
        ev.launched ? 'bg-specter-state-success' : live ? 'bg-specter-primary-cyan' : 'bg-specter-primary-dim')} />
      <div className="flex-1 min-w-0">
        <div className="text-ui-sm font-semibold text-specter-text-main truncate">{ev.name}</div>
        <div className="text-ui-xs text-specter-text-subtle truncate">
          <span className="font-mono tabular-nums text-specter-primary-neon">{fmtEventTime(ev.start_time)}</span>
          {summary && <> · {summary} signups</>}
        </div>
      </div>
      {canLaunch && (
        <IconButton size="sm" variant="secondary" icon={<Rocket size={13} />} label={`Launch ${ev.name}`}
          onClick={(e) => { e.stopPropagation(); onLaunch(ev); }} />
      )}
      {ev.launched && <Badge variant="live">Launched</Badge>}
      {live && <Badge variant="live" />}
    </div>
  );
}

function DayPlans({ events, view, day, now, selectedEventId, canSchedule, onBack, onOpen, onSchedule, canLaunch, onLaunch }) {
  const list = opsOnDay(events, view.year, view.month, day);
  const dateLabel = new Date(view.year, view.month, day).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1">
        <IconButton size="sm" icon={<ChevronLeft size={15} />} label="Back to the month" onClick={onBack} />
        <h3 className="flex-1 min-w-0 truncate text-ui-base font-semibold text-specter-text-main">{dateLabel}</h3>
        {canSchedule && onSchedule && (
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} className="!h-7 !px-2.5 shrink-0"
            onClick={() => onSchedule(dateKey(view.year, view.month, day))}>
            Schedule
          </Button>
        )}
      </div>
      {list.length === 0 ? (
        <p className="py-4 text-center text-ui-sm text-specter-text-subtle">
          No operations on this day.{canSchedule && onSchedule ? ' Schedule one with the button above.' : ''}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {list.map((ev) => (
            <OpRow key={ev.id} ev={ev} now={now} selected={ev.id === selectedEventId}
              canLaunch={canLaunch(ev)} onOpen={onOpen} onLaunch={onLaunch} />
          ))}
        </div>
      )}
    </div>
  );
}

const TABS = [
  { id: 'calendar', label: 'Calendar', Icon: CalendarDays },
  { id: 'now', label: 'Now & soon', Icon: Radio },
  { id: 'history', label: 'History', Icon: History },
];

/**
 * ops        useStripOps() result
 * orgId      active server
 * orgName    shown under the title
 * selectedEventId  op currently open in the op panel (highlighted)
 * onOpenEvent(ev), onSchedule(initialDate | null), onClose
 * maxHeight  px
 * initialTab, initialDay   dev preview only
 */
export default function OpsCabinet({
  ops, orgId, orgName, selectedEventId, onOpenEvent, onSchedule, onClose, maxHeight, initialTab, initialDay = null,
}) {
  const now = new Date();
  const events = ops.events || [];
  const nowCards = getActiveOpsCards(events, now);
  const [tab, setTab] = useState(() => initialTab || (nowCards.length ? 'now' : 'calendar'));
  const [view, setView] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const [day, setDay] = useState(initialDay);
  const [launching, setLaunching] = useState(null);
  const [launchError, setLaunchError] = useState(null);

  const nowIds = new Set(nowCards.map((e) => e.id));
  const later = getUpcomingOps(events, now).filter((e) => !nowIds.has(e.id)).slice(0, 12);
  const canLaunch = (ev) => !launching && ops.canLaunch(ev);

  const doLaunch = async (ev) => {
    setLaunching(ev.id);
    setLaunchError(null);
    const { error } = await ops.launch(ev);
    setLaunching(null);
    if (error) setLaunchError(typeof error === 'string' ? error : 'Launch failed');
  };

  return (
    <div className="flex flex-col" style={{ maxHeight }}>
      <PanelHeader
        title="Operations"
        subtitle={orgName}
        onClose={onClose}
        actions={ops.canSchedule && onSchedule ? (
          <Button size="sm" icon={<Plus size={14} />} onClick={() => onSchedule(null)} className="!h-7 !px-2.5 shrink-0">New</Button>
        ) : null}
      />
      <div className="flex items-center gap-1 px-3 pb-2 shrink-0" role="tablist" aria-label="Operations views">
        {TABS.filter((t) => t.id !== 'history' || orgId).map(({ id, label, Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cx('flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-pill text-ui-sm font-medium transition-colors', focusRing,
              tab === id ? 'bg-specter-primary-cyan/15 text-specter-primary-neon' : 'text-specter-text-subtle hover:text-specter-text-main hover:bg-white/5')}>
            <Icon size={14} aria-hidden="true" />
            {label}
            {id === 'now' && nowCards.length > 0 && (
              <span className="min-w-[18px] h-[18px] px-1 rounded-pill bg-specter-state-success/25 text-emerald-300 text-[11px] font-bold tabular-nums inline-flex items-center justify-center">
                {nowCards.length}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="strip-scroll min-h-0 flex-1 px-3 pb-3 space-y-3" role="tabpanel">
        {ops.eventsError && <Alert variant="error">{ops.eventsError}</Alert>}
        {launchError && <Alert variant="error">{launchError}</Alert>}
        {ops.eventsLoading && !events.length && !ops.eventsError && (
          <p className="text-ui-sm text-specter-text-subtle">Loading operations…</p>
        )}

        {tab === 'calendar' && (day === null ? (
          <MonthGrid events={events} view={view} setView={(v) => { setView(v); setDay(null); }} selectedDay={day} onPickDay={setDay} />
        ) : (
          <DayPlans events={events} view={view} day={day} now={now} selectedEventId={selectedEventId}
            canSchedule={ops.canSchedule} onBack={() => setDay(null)} onOpen={onOpenEvent} onSchedule={onSchedule}
            canLaunch={canLaunch} onLaunch={doLaunch} />
        ))}

        {tab === 'now' && (
          <>
            {nowCards.length > 0 ? (
              <OpsNowAndSoon
                cards={nowCards}
                layout="list"
                className=""
                onOpenEvent={onOpenEvent}
                onLaunchEvent={launching ? null : doLaunch}
                canLaunchEvent={ops.canLaunch}
              />
            ) : (
              <p className="py-3 text-center text-ui-sm text-specter-text-subtle">Nothing live or starting in the next 30 minutes.</p>
            )}
            <div>
              <SectionLabel className="mb-1.5">Later</SectionLabel>
              {later.length === 0 ? (
                <p className="text-ui-sm text-specter-text-subtle">No other operations scheduled.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {later.map((ev) => (
                    <OpRow key={ev.id} ev={ev} now={now} selected={ev.id === selectedEventId}
                      canLaunch={canLaunch(ev)} onOpen={onOpenEvent} onLaunch={doLaunch} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'history' && orgId && <EventHistoryPanel orgId={orgId} />}
      </div>
    </div>
  );
}
