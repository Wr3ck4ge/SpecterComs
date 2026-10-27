// Notifications cabinet of the tray strip: ops you're signed up for that are
// live or launching within 30 minutes (any server), and ops on this server
// starting within the hour that still have open slots. Read state lives in
// the strip's localStorage (useStripOps).
import { useEffect, useState } from 'react';
import { BellOff, Radio, UserPlus } from 'lucide-react';
import { Alert, Badge, Button } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { PanelHeader } from './stripOpsUi';
import { relTime } from './stripOpsLayout';

function NotificationRow({ item, unread, joining, onOpen, onJoin }) {
  const ev = item.event;
  const mine = item.kind === 'mine';
  const live = item.phase === 'live';
  const free = Math.max(0, (Number(ev.total_slots) || 0) - (Number(ev.filled_slots) || 0));
  let line;
  if (mine) line = live ? 'Your op is live' : `Your op launches ${relTime(ev.start_time)}`;
  else line = `${free} open slot${free === 1 ? '' : 's'} · ${live ? 'starting now' : `starts ${relTime(ev.start_time)}`}`;
  return (
    <li
      className={cx(
        'flex items-start gap-2.5 px-2.5 py-2 rounded-ui-md border transition-colors',
        unread ? 'bg-specter-primary-cyan/[0.07] border-specter-primary-cyan/30' : 'bg-specter-bg-deep/40 border-specter-border-divider',
      )}
    >
      <span aria-hidden="true" className={cx('mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-pill',
        mine ? 'bg-specter-state-success/15 text-emerald-300' : 'bg-specter-primary-cyan/15 text-specter-primary-neon')}>
        {mine ? <Radio size={14} /> : <UserPlus size={14} />}
      </span>
      <button type="button" onClick={() => onOpen(item)} className={cx('flex-1 min-w-0 text-left rounded-ui-sm', focusRing)}>
        <span className="flex items-center gap-1.5">
          {unread && <span className="h-1.5 w-1.5 rounded-pill bg-specter-primary-neon shrink-0" aria-label="Unread" />}
          <span className="truncate text-ui-sm font-semibold text-specter-text-main">{ev.name}</span>
        </span>
        <span className="block text-ui-xs text-specter-text-subtle truncate">
          {line}{ev.org_callsign ? ` · ${ev.org_callsign}` : ''}
        </span>
      </button>
      {live && mine && <Badge variant="live" className="mt-1" />}
      {!mine && (
        <Button size="sm" variant="secondary" className="!h-7 !px-2.5 shrink-0" disabled={joining} onClick={() => onJoin(item)}>
          {joining ? 'Joining…' : 'Join'}
        </Button>
      )}
    </li>
  );
}

/**
 * ops       useStripOps() result
 * onOpenEvent(event, orgId)  open the op panel above
 * onClose
 */
export default function NotificationsCabinet({ ops, onOpenEvent, onClose, maxHeight }) {
  const [joiningKey, setJoiningKey] = useState(null);
  const [result, setResult] = useState(null);
  const items = ops.notifications;

  // Opening the cabinet marks what's in it as read (the dots stay visible
  // until it closes, so you can still see what was new).
  const keysNow = items.map((n) => n.key).join('|');
  const [shownUnread] = useState(() => new Set(items.filter((n) => !ops.readKeys.has(n.key)).map((n) => n.key)));
  // POLISH: the cabinet now stays open while the strip is hidden (it comes
  // back as it was), so only mark what's actually on screen.
  useEffect(() => {
    if (keysNow && ops.visible !== false) ops.markRead(keysNow.split('|'));
  }, [keysNow, ops.visible]); // eslint-disable-line react-hooks/exhaustive-deps -- markRead is stable

  const open = (item) => onOpenEvent(item.event, item.orgId);
  const join = async (item) => {
    setJoiningKey(item.key);
    setResult(null);
    const { data, error } = await ops.quickJoin(item.event, item.orgId);
    setJoiningKey(null);
    setResult(error
      ? { variant: 'error', text: typeof error === 'string' ? error : 'Could not join' }
      : { variant: 'success', text: `${item.event.name}: ${data?.message || 'Signed up'}` });
  };

  return (
    <div className="flex flex-col" style={{ maxHeight }}>
      <PanelHeader
        title="Notifications"
        subtitle={items.length ? 'Ops launching soon' : undefined}
        onClose={onClose}
      />
      <div className="strip-scroll min-h-0 flex-1 px-3 pb-3 space-y-2">
        {result && <Alert variant={result.variant}>{result.text}</Alert>}
        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <BellOff size={22} className="text-specter-text-subtle" aria-hidden="true" />
            <p className="text-ui-sm text-specter-text-muted">Nothing launching soon.</p>
            <p className="text-ui-xs text-specter-text-subtle max-w-[260px]">
              Ops you&apos;re signed up for show up here 30 minutes before launch, along with ops starting within the hour that still have open slots.
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5" aria-label="Notifications">
            {items.map((item) => (
              <NotificationRow key={item.key} item={item} unread={shownUnread.has(item.key)}
                joining={joiningKey === item.key} onOpen={open} onJoin={join} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
