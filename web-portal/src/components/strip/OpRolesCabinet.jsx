// EVVIEW: the cabinet that opens inside the op view's tree, docked beside the
// selected group: its roles (filled / total, who's in each, seats) with Join
// seat / Sign up / Leave from the shared join decision (getRoleJoinState) and
// the plan's actions (useOpPlan), the planner's approval queue, and — for a
// Star Citizen ship group — the ship slots and the ship sign-up flow.
import { forwardRef, useState } from 'react';
import { Check, Rocket, Star, Users, X } from 'lucide-react';
import { Alert, Badge, Button, IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { computeDepth, getRoleJoinState } from '../../utils/eventGroups';
import { useShipSlotClaims } from '../../utils/plannerHooks';
import useHangar from './games/useHangar';
import ShipSignupFlow from './ShipSignupFlow';
import { Chip, SectionLabel, ShipBadge } from './stripOpsUi';
import { groupSeatFill } from './stripOpsLayout';

const PRIORITY = ['', 'Low', 'Med-low', 'Medium', 'High', 'Critical'];
const PRIORITY_DOT = ['', 'bg-slate-500', 'bg-cyan-700', 'bg-cyan-400', 'bg-amber-400', 'bg-red-400'];

// Who holds a role: [{ uid, callsign, status, seat }].
function occupantsOf(group, role) {
  return Object.entries(group.member_role_ids || {})
    .filter(([, rid]) => rid === role.id)
    .map(([uid]) => ({
      uid,
      callsign: group.member_callsigns?.[uid] || uid,
      status: group.member_statuses?.[uid] || 'accepted',
      seat: group.member_seat_labels?.[uid] || null,
    }));
}

function RoleCard({ group, role, myUserId, canAct, canEdit, plan, onBringShip, shipGroup }) {
  const [picking, setPicking] = useState(false);
  const js = getRoleJoinState(group, role, myUserId);
  const open = role.assignment_mode === 'open';
  const needsApproval = role.auto_approve === false;
  const people = occupantsOf(group, role);
  const seats = Array.isArray(role.seat_labels) && role.seat_labels.length > 1 ? role.seat_labels : null;
  const pending = canEdit && open ? people.filter((p) => p.status === 'pending') : [];
  const join = (seat = null) => { setPicking(false); plan.joinRole(group.id, role.id, seat); };

  let action = null;
  if (open && canAct && role.id) {
    if (js.action === 'leave') {
      action = (
        <Button size="sm" variant="danger" className="!h-7 !px-2.5" onClick={() => plan.leaveRole(group.id, role.id)}
          title={shipGroup ? 'Leaving also releases a ship slot you claimed here' : undefined}>Leave</Button>
      );
    } else if (js.action === 'pending') {
      action = (
        <span className="flex items-center gap-1.5">
          <Badge variant="warning">Pending approval</Badge>
          <Button size="sm" variant="ghost" className="!h-7 !px-2" onClick={() => plan.leaveRole(group.id, role.id)}>Cancel</Button>
        </span>
      );
    } else if (js.action === 'claim-ship') {
      action = onBringShip
        ? <Button size="sm" className="!h-7 !px-2.5" icon={<Rocket size={13} />} onClick={onBringShip}>Bring a ship</Button>
        : <span className="text-ui-xs text-specter-text-subtle">Claim a ship to join</span>;
    } else if (js.action === 'awaiting-ship') {
      action = <span className="text-ui-xs text-specter-text-subtle text-right" title="No ship has been claimed for this group yet">Needs a ship first</span>;
    } else if (js.action === 'join' || js.action === 'join-full') {
      const seatPick = js.hasSlot && js.needsSeatChoice;
      action = (
        <Button
          size="sm"
          variant={js.hasSlot ? 'primary' : 'secondary'}
          className="!h-7 !px-2.5 whitespace-nowrap"
          aria-expanded={seatPick ? picking : undefined}
          title={js.hasSlot ? (needsApproval ? 'A planner approves sign-ups for this role' : undefined) : 'Role is full — joins the group without this frequency/priority assignment'}
          onClick={() => (seatPick ? setPicking((p) => !p) : join())}
        >
          {!js.hasSlot ? 'Join (full)' : seatPick ? 'Join seat' : needsApproval ? 'Sign up' : 'Join'}
        </Button>
      );
    }
  }

  return (
    <li className={cx('px-2.5 py-2 rounded-ui-md border bg-specter-bg-deep/50',
      js.amAcceptedInRole ? 'border-specter-state-success/50' : js.amPendingInRole ? 'border-specter-state-warning/50' : 'border-specter-border-divider')}>
      <div className="flex items-center gap-2">
        <span aria-label={`Priority: ${PRIORITY[role.priority] || 'Medium'}`} className={cx('h-2 w-2 rounded-pill shrink-0', PRIORITY_DOT[role.priority] || PRIORITY_DOT[3])} />
        {role.is_commander && <Star size={12} className="text-emerald-300 shrink-0" aria-label="Operation commander" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-ui-sm text-specter-text-main truncate">{role.name || 'Unnamed role'}</span>
            {open && needsApproval && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-amber-300/90">Approval</span>}
          </div>
          <div className="text-ui-xs text-specter-text-subtle">
            {open
              ? <><span className="tabular-nums">{js.filled}/{js.max}</span> filled{js.reserved > 0 ? ` (${js.reserved} reserved)` : ''}</>
              : <>Assigned: {role.assigned_callsign || 'TBD'}</>}
            {js.mySeatLabel && <span className="text-emerald-300"> · your seat {js.mySeatLabel}</span>}
          </div>
        </div>
        {action}
      </div>
      {open && people.length > 0 && !seats && (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label={`In ${role.name}`}>
          {people.map((p) => (
            <li key={p.uid} className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-pill text-ui-xs border',
              p.uid === myUserId ? 'border-specter-state-success/50 text-emerald-300 bg-specter-state-success/10'
                : p.status === 'pending' ? 'border-dashed border-specter-state-warning/50 text-amber-300' : 'border-specter-border text-specter-text-muted')}>
              {p.callsign}{p.status === 'pending' && <span className="sr-only"> (pending)</span>}
            </li>
          ))}
        </ul>
      )}
      {seats && (
        // Seat map: taken seats show who's in them; free ones are the seat
        // picker (active once Join seat is pressed).
        <div className="mt-1.5 flex flex-wrap items-center gap-1" role={picking ? 'group' : undefined} aria-label={picking ? `Pick a ${role.name} seat` : `${role.name} seats`}>
          {picking && <span className="w-full text-ui-xs text-specter-text-subtle">Pick a seat:</span>}
          {seats.map((seat) => {
            const taken = js.takenSeats.find((t) => t.seat_label === seat);
            if (taken) {
              const mine = taken.callsign && people.find((p) => p.uid === myUserId)?.seat === seat;
              return (
                <span key={seat} className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-pill border text-ui-xs',
                  mine ? 'border-specter-state-success/50 text-emerald-300' : 'border-specter-border-divider text-specter-text-subtle')}>
                  {seat} · {taken.callsign}{taken.status === 'pending' ? ' (pending)' : ''}
                </span>
              );
            }
            return picking ? (
              <Chip key={seat} tone="cyan" onClick={() => join(seat)}>{seat}</Chip>
            ) : (
              <span key={seat} className="inline-flex items-center h-6 px-2 rounded-pill border border-dashed border-specter-border text-ui-xs text-specter-text-subtle">{seat} · open</span>
            );
          })}
        </div>
      )}
      {pending.length > 0 && (
        <div className="mt-2 pt-2 border-t border-specter-border-divider space-y-1">
          <div className="flex items-center">
            <span className="flex-1 text-ui-xs font-semibold text-amber-300">Waiting for approval</span>
            {pending.length > 1 && <Chip tone="green" selected onClick={() => plan.approveAll(group.id)}>Approve all</Chip>}
          </div>
          {pending.map(({ uid, callsign }) => (
            <div key={uid} className="flex items-center gap-1.5">
              <span className="flex-1 truncate text-ui-sm text-specter-text-main">{callsign}</span>
              <Chip tone="green" selected onClick={() => plan.approve(group.id, uid)}><Check size={12} />Approve</Chip>
              <Chip onClick={() => plan.deny(group.id, uid)}><X size={12} />Deny</Chip>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

// Who is bringing which hull (compact), with Release for your own claim.
function ShipSlots({ group, claims, myUserId }) {
  const { entries, busy, release } = claims;
  if (!entries || !entries.length) return null;
  return (
    <div className="space-y-1.5">
      <SectionLabel>Ship slots</SectionLabel>
      {entries.map((entry) => (
        <div key={entry.ship_slug} className="flex items-start gap-2 p-2 rounded-ui-md border border-specter-border-divider bg-specter-bg-deep/40">
          <ShipBadge name={entry.ship_name} url={(group.ships || []).find((s) => s.ship_slug === entry.ship_slug)?.ship_icon_url} size={28} />
          <div className="min-w-0 flex-1">
            <div className="text-ui-sm text-specter-text-main truncate">{entry.ship_name}</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {entry.slots.map((slot) => (slot.user_id ? (
                <span key={slot.slot_index} className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-pill border text-ui-xs',
                  slot.user_id === myUserId ? 'border-specter-state-success/50 text-emerald-300 bg-specter-state-success/10' : 'border-specter-border text-specter-text-muted')}>
                  {slot.callsign}{slot.claimed_ship_slug && slot.claimed_ship_slug !== entry.ship_slug ? ' (similar)' : ''}
                  {slot.user_id === myUserId && (
                    <button type="button" disabled={busy} onClick={() => release(entry.ship_slug)} className={cx('ml-0.5 text-red-300 hover:underline', focusRing)}>Release</button>
                  )}
                </span>
              ) : (
                <span key={slot.slot_index} className="inline-flex items-center h-6 px-2 rounded-pill border border-dashed border-specter-border text-ui-xs text-specter-text-subtle">Open</span>
              )))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Loads the hangar only while the flow is open (dev preview passes one in).
function LiveHangarFlow(props) {
  const hangar = useHangar();
  return <ShipSignupFlow {...props} hangar={hangar} />;
}

/**
 * group, groupIdx, groups, event, plan (useOpPlan), myUserId, canEdit
 * side        'left' | 'right' — where the cabinet is docked (animation)
 * onClose()
 * hangar      dev preview only (a useHangar()-shaped object)
 * initialFlow dev preview only (ShipSignupFlow `initial`)
 * Forwarded ref: the heading, focused when the cabinet opens.
 */
const OpRolesCabinet = forwardRef(function OpRolesCabinet({
  group, groupIdx, groups, event, plan, myUserId, canEdit, side, onClose, hangar = null, initialFlow = null, style,
}, headingRef) {
  const launched = !!event.launched;
  const isOpen = (event.access_mode || 'open') === 'open';
  const canAct = isOpen && !launched;
  const sc = event.game === 'star_citizen';
  const shipGroup = (group.ships || []).length > 0;
  const shipFlowAvailable = sc && shipGroup && canAct && !!group.id && !!plan.getClaimableShips;
  const claims = useShipSlotClaims({
    groupId: group.id,
    ships: sc && shipGroup && plan.getClaimableShips ? group.ships : [],
    getClaimableShips: plan.getClaimableShips || (async () => ({ data: { entries: [] } })),
    claimShipSlot: plan.claimShipSlot,
    releaseShipSlot: plan.releaseShipSlot,
  });
  const [flow, setFlow] = useState(initialFlow ? true : false);
  const { members, total } = groupSeatFill(group);
  const parent = group.parent_index !== null && group.parent_index !== undefined ? groups[group.parent_index] : null;
  const myStatus = group.member_statuses?.[myUserId];
  const myRole = (group.roles || []).find((r) => r.id === group.member_role_ids?.[myUserId]);
  const myClaim = (group.ships || []).flatMap((s) => (s.claims || []).map((c) => ({ ...c, ship_name: s.ship_name }))).find((c) => c.user_id === myUserId);
  const showMsg = plan.msg;
  const confirmHere = plan.shipConfirm && plan.shipConfirm.groupId === group.id;

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); if (flow) setFlow(false); else onClose(); }
  };

  return (
    <section
      data-strip-region
      data-pz-ignore
      aria-labelledby={`evview-cab-${groupIdx}`}
      onKeyDown={onKeyDown}
      className={cx('absolute z-20 flex flex-col cursor-auto select-text rounded-ui-md border border-specter-border-strong bg-[#0d2236] shadow-2xl',
        side === 'left' ? 'ch-view-back' : 'ch-view-fwd')}
      style={style}
    >
      <header className="flex items-start gap-2 px-3 pt-2.5 pb-2 border-b border-specter-border-divider shrink-0">
        {shipGroup && <ShipBadge name={group.ships[0].ship_name} url={group.ships[0].ship_icon_url} size={34} count={(group.ships || []).reduce((n, s) => n + (s.quantity || 1), 0)} />}
        <div className="min-w-0 flex-1">
          <h3 id={`evview-cab-${groupIdx}`} ref={headingRef} tabIndex={-1} className="truncate text-ui-base font-semibold text-specter-text-main focus:outline-none">
            {group.name || 'Unnamed group'}
          </h3>
          <p className="text-ui-xs text-specter-text-subtle truncate">
            Tier {computeDepth(groupIdx, groups)} · <span className="tabular-nums">{members}{total ? `/${total}` : ''}</span> {total ? 'seats filled' : 'members'}
            {parent ? ` · reports to ${parent.name}` : ''}
          </p>
        </div>
        <IconButton size="sm" icon={<X size={16} />} label="Close roles" onClick={onClose} />
      </header>
      <div className="strip-scroll min-h-0 flex-1 px-3 py-2.5 space-y-2.5">
        {showMsg && (
          <Alert variant={plan.msg.type === 'error' ? 'error' : 'success'}>
            <span className="flex items-start gap-2">
              <span className="flex-1">{plan.msg.text}</span>
              {plan.setMsg && <button type="button" className={cx('text-ui-xs underline', focusRing)} onClick={() => plan.setMsg(null)}>Dismiss</button>}
            </span>
          </Alert>
        )}
        {confirmHere && (
          <div className="p-2.5 rounded-ui-md border border-specter-state-warning/40 bg-specter-state-warning/10 space-y-2">
            <p className="text-ui-sm text-specter-text-main">
              Bring your <strong>{plan.shipConfirm.shipName}</strong>? Joining with it also reserves its locked seats
              {plan.shipConfirm.seatLabels.length ? ` (${plan.shipConfirm.seatLabels.join(', ')})` : ''}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => plan.confirmShipJoin(true)}>Join with ship</Button>
              <Button size="sm" variant="secondary" onClick={() => plan.confirmShipJoin(false)}>Join without</Button>
              <Button size="sm" variant="ghost" onClick={plan.cancelShipJoin}>Cancel</Button>
            </div>
          </div>
        )}

        {flow && shipFlowAvailable ? (
          hangar
            ? <ShipSignupFlow group={group} plan={plan} myUserId={myUserId} claims={claims} hangar={hangar} initial={initialFlow} onDone={() => setFlow(false)} onCancel={() => setFlow(false)} />
            : <LiveHangarFlow group={group} plan={plan} myUserId={myUserId} claims={claims} initial={initialFlow} onDone={() => setFlow(false)} onCancel={() => setFlow(false)} />
        ) : (
          <>
            {myStatus && (
              <p className={cx('text-ui-sm', myStatus === 'accepted' ? 'text-emerald-300' : myStatus === 'declined' ? 'text-red-300' : 'text-amber-300')}>
                {myStatus === 'pending' ? (isOpen ? 'Waiting for approval' : 'Assigned to you — respond in Details')
                  : myStatus === 'declined' ? 'You declined' : "You're in"}
                {myRole ? ` as ${myRole.name}` : ' this group'}
                {myClaim ? ` · bringing ${myClaim.ship_name}` : ''}
              </p>
            )}
            {shipFlowAvailable && !myClaim && (
              <div className="flex items-center gap-2.5 p-2.5 rounded-ui-md border border-specter-primary-cyan/40 bg-specter-primary-cyan/[0.07]">
                <Rocket size={18} aria-hidden="true" className="shrink-0 text-specter-primary-neon" />
                <p className="flex-1 text-ui-xs text-specter-text-muted">This group flies ships. Bring one from your hangar, or crew someone else&apos;s.</p>
                <Button size="sm" className="!h-7 !px-2.5 whitespace-nowrap" onClick={() => setFlow(true)}>Sign up</Button>
              </div>
            )}
            {!isOpen && !launched && <p className="text-ui-xs text-specter-text-subtle">Restricted op — planners assign people to roles.</p>}
            {launched && <p className="text-ui-xs text-specter-text-subtle">This op has launched — sign-ups are closed.</p>}
            <div>
              <SectionLabel className="mb-1.5 flex items-center gap-1.5"><Users size={12} aria-hidden="true" />Roles</SectionLabel>
              {(group.roles || []).length === 0 ? (
                <p className="text-ui-sm text-specter-text-subtle">No roles in this group.</p>
              ) : (
                <ul className="space-y-1.5">
                  {group.roles.map((role, ri) => (
                    <RoleCard key={role.id || ri} group={group} role={role} myUserId={myUserId} canAct={canAct} canEdit={canEdit} plan={plan}
                      shipGroup={shipGroup} onBringShip={shipFlowAvailable ? () => setFlow(true) : null} />
                  ))}
                </ul>
              )}
            </div>
            {sc && shipGroup && <ShipSlots group={group} claims={claims} myUserId={myUserId} />}
          </>
        )}
      </div>
    </section>
  );
});

export default OpRolesCabinet;
