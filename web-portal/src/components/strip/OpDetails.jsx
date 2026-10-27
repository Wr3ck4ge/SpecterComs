// EVVIEW: the op view's details drawer (slides out beside the tree panel):
// when, access, organiser / commander / planners, your status (accept /
// decline for restricted ops, quick join), sign-up counts, and the launched
// op's channel tree.
import { CalendarClock, Clock, Lock, MapPin, Radio, Unlock, Volume2, X } from 'lucide-react';
import { Badge, Button, IconButton } from '../ui';
import { cx } from '../ui/styles';
import { fmtEventTime } from '../../utils/format';
import { isOpLive } from '../../utils/opsEvents';
import { buildChannelTree } from '../../utils/eventGroups';
import { useEventChannelTree } from '../../utils/plannerHooks';
import { SectionLabel } from './stripOpsUi';
import { relTime } from './stripOpsLayout';

function MyStatus({ plan, placement, isOpen, launched }) {
  if (plan.loading && !plan.groups.length) return null;
  if (placement.groupName && placement.status === 'pending' && !isOpen) {
    return (
      <div className="p-2.5 rounded-ui-md border border-specter-primary-cyan/40 bg-specter-primary-cyan/[0.07] space-y-2">
        <p className="text-ui-sm text-specter-text-main">
          You&apos;ve been assigned to <strong>{placement.groupName}</strong>
          {placement.role && <> as {placement.role}</>}{placement.isCommander && <> (op commander)</>}.
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => plan.respond(true)}>Accept</Button>
          <Button size="sm" variant="danger" onClick={() => plan.respond(false)}>Decline</Button>
        </div>
      </div>
    );
  }
  if (placement.groupName && placement.status) {
    const tone = placement.status === 'accepted' ? 'text-emerald-300' : placement.status === 'declined' ? 'text-red-300' : 'text-amber-300';
    const word = { accepted: "You're in", declined: 'You declined', pending: 'Waiting for approval in' }[placement.status] || "You're in";
    return (
      <p className={cx('text-ui-sm', tone)}>
        {word} <strong>{placement.groupName}</strong>{placement.role ? ` as ${placement.role}` : ''}{placement.isCommander ? ' (op commander)' : ''}
      </p>
    );
  }
  if (isOpen && !launched && plan.groups.length > 0) {
    return (
      <div className="flex items-center gap-2 p-2.5 rounded-ui-md border border-specter-border bg-white/[0.03]">
        <p className="flex-1 text-ui-sm text-specter-text-muted">Not signed up. Pick a group in the tree, or</p>
        <Button size="sm" onClick={() => plan.quickJoin()}>Quick join</Button>
      </div>
    );
  }
  if (!isOpen && !launched) return <p className="text-ui-sm text-specter-text-subtle">Planners assign people to this op.</p>;
  return null;
}

// A launched op's voice-channel hierarchy (useEventChannelTree). `channels`
// overrides the fetch (dev preview).
function EventChannels({ orgId, eventId, channels: given }) {
  const fetched = useEventChannelTree(orgId, eventId, !given);
  const { roots, childMap, channels } = given ? { ...buildChannelTree(given), channels: given } : fetched;
  if (!given && fetched.loading) return <p className="text-ui-sm text-specter-text-subtle">Loading channels…</p>;
  if (!channels.length) return null;
  const renderNode = (ch, depth = 0) => (
    <li key={ch.id}>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: depth * 16 }}>
        {ch.is_command ? <Radio size={13} aria-hidden="true" className="shrink-0 text-specter-primary-neon" /> : <Volume2 size={13} aria-hidden="true" className="shrink-0 text-specter-text-subtle" />}
        <span className={cx('truncate text-ui-sm', ch.is_command ? 'text-specter-primary-neon font-semibold' : 'text-specter-text-main')}>{ch.name}</span>
        <span className="text-ui-xs text-specter-text-subtle">T{ch.tier}</span>
        {ch.leader_callsign && <span className="truncate text-ui-xs text-specter-text-subtle">Lead: {ch.leader_callsign}</span>}
      </div>
      {(childMap[ch.id] || []).length > 0 && <ul>{childMap[ch.id].map((c) => renderNode(c, depth + 1))}</ul>}
    </li>
  );
  return (
    <div>
      <SectionLabel className="mb-1">Op channels</SectionLabel>
      <ul className="px-2.5 py-1.5 rounded-ui-md border border-specter-border-divider bg-specter-bg-deep/40">{roots.map((ch) => renderNode(ch))}</ul>
    </div>
  );
}

function fmtDuration(start, end) {
  if (!end) return 'Open-ended';
  const mins = Math.round((new Date(end) - new Date(start)) / 60000);
  if (!(mins > 0)) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h ? `${h} h` : ''}${h && m ? ' ' : ''}${m ? `${m} min` : ''}`;
}

// A callsign for a user id from what the op view already has loaded.
function callsignOf(uid, { event, groups, user }) {
  if (!uid) return null;
  if (uid === user?.id) return user.callsign ? `${user.callsign} (you)` : 'You';
  const planner = (event.planners || []).find((p) => p.user_id === uid);
  if (planner?.callsign) return planner.callsign;
  for (const g of groups) if (g.member_callsigns?.[uid]) return g.member_callsigns[uid];
  return null;
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 text-ui-sm">
      <dt className="text-specter-text-subtle">{label}</dt>
      <dd className="text-specter-text-main min-w-0">{children}</dd>
    </div>
  );
}

/**
 * event, user, plan, placement (getMyPlacement), editors, orgId, channels (dev), onClose()
 */
export default function OpDetails({ event, user, plan, placement, editors = [], orgId, channels, onClose }) {
  const now = new Date();
  const groups = plan.groups;
  const isOpen = (event.access_mode || 'open') === 'open';
  const launched = !!event.launched;
  const live = isOpLive(event, now);
  const duration = fmtDuration(event.start_time, event.end_time);
  const commanderRole = groups.flatMap((g) => g.roles || []).find((r) => r.is_commander);
  const commander = commanderRole?.assigned_callsign || callsignOf(event.commander_user_id, { event, groups, user });
  const organiser = callsignOf(event.creator_id, { event, groups, user });
  const planners = (event.planners || []).map((p) => p.callsign).filter(Boolean);
  // Seats from the loaded plan (the list's counts when it isn't loaded yet).
  const seats = groups.length
    ? groups.reduce((acc, g) => {
      (g.roles || []).forEach((r) => { acc.total += Number(r.max_slots) || 1; });
      Object.values(g.member_statuses || {}).forEach((s) => { if (s === 'pending') acc.pending += 1; else if (s === 'accepted') acc.filled += 1; });
      return acc;
    }, { filled: 0, total: 0, pending: 0 })
    : { filled: Number(event.filled_slots) || 0, total: Number(event.total_slots) || 0, pending: 0 };
  const others = editors.filter((e) => e.userId !== user?.id);

  return (
    <div className="flex flex-col min-h-0">
      <header className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-specter-border-divider shrink-0">
        <h2 className="flex-1 min-w-0 truncate text-ui-base font-semibold text-specter-text-main">Details</h2>
        <IconButton size="sm" icon={<X size={16} />} label="Close details" onClick={onClose} />
      </header>
      <div className="strip-scroll min-h-0 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {launched && <Badge variant="live">Launched</Badge>}
          {!launched && live && <Badge variant="live" />}
          <Badge>{isOpen ? <><Unlock size={11} aria-hidden="true" /> Open join</> : <><Lock size={11} aria-hidden="true" /> Restricted</>}</Badge>
          {event.game && event.game !== 'none' && <Badge>{event.game === 'star_citizen' ? 'Star Citizen' : event.game}</Badge>}
        </div>
        <dl className="space-y-1.5">
          <Row label={<span className="inline-flex items-center gap-1"><CalendarClock size={12} aria-hidden="true" />Starts</span>}>
            {fmtEventTime(event.start_time)} <span className="text-specter-text-subtle">· {relTime(event.start_time, now)}</span>
          </Row>
          {duration && (
            <Row label={<span className="inline-flex items-center gap-1"><Clock size={12} aria-hidden="true" />Duration</span>}>
              {duration}{event.end_time && <span className="text-specter-text-subtle"> · until {new Date(event.end_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
            </Row>
          )}
          {event.meetup_location && (
            <Row label={<span className="inline-flex items-center gap-1"><MapPin size={12} aria-hidden="true" />Meet-up</span>}>
              <span className="break-words">{event.meetup_location}</span>
            </Row>
          )}
          <Row label="Access">{isOpen ? 'Open — anyone in the server can sign up' : 'Restricted — planners assign people'}</Row>
          {organiser && <Row label="Organiser">{organiser}</Row>}
          {commander && <Row label="Commander">{commander}</Row>}
          {planners.length > 0 && <Row label="Planners">{planners.join(', ')}</Row>}
        </dl>
        {event.description && <p className="text-ui-sm text-specter-text-muted whitespace-pre-wrap break-words">{event.description}</p>}

        <div>
          <SectionLabel className="mb-1">Sign-ups</SectionLabel>
          <div className="flex items-baseline gap-3 text-ui-sm">
            <span><strong className="tabular-nums text-specter-text-main">{seats.filled}</strong><span className="text-specter-text-subtle">{seats.total ? ` / ${seats.total} seats` : ' signed up'}</span></span>
            {seats.pending > 0 && <span className="text-amber-300 tabular-nums">{seats.pending} pending</span>}
            {groups.length > 0 && <span className="text-specter-text-subtle">{groups.length} group{groups.length === 1 ? '' : 's'}</span>}
          </div>
          {seats.total > 0 && (
            <div className="mt-1.5 h-1.5 rounded-pill bg-white/[0.06] overflow-hidden" aria-hidden="true">
              <div className="h-full bg-specter-primary-cyan/70" style={{ width: `${Math.min(100, (seats.filled / seats.total) * 100)}%` }} />
            </div>
          )}
        </div>

        <div>
          <SectionLabel className="mb-1">Your status</SectionLabel>
          <MyStatus plan={plan} placement={placement} isOpen={isOpen} launched={launched} />
        </div>
        {others.length > 0 && <p className="text-ui-xs text-specter-text-subtle">Being edited by {others.map((e) => e.callsign).join(', ')}</p>}
        {launched && <EventChannels orgId={orgId} eventId={event.id} channels={channels} />}
      </div>
    </div>
  );
}
