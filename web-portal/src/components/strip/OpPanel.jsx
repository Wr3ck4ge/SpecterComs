// The op panel that opens above the Operations / Notifications cabinet: the
// read-only op view (OpView) for everyone, and the guided planner
// (OpPlanner) for people allowed to schedule or edit. This file is the
// container — it resolves the op, loads its plan (useOpPlan), members and
// planner presence, and performs create / update / launch / delete with the
// same endpoints and permission rules as WarRoom and OperationPlanner.
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { buildEventBody } from '../../utils/eventGroups';
import { canEditOp, canLaunchOp, canScheduleOps } from '../../utils/opsPermissions';
import useOpPlan from './useOpPlan';
import OpView from './OpView';
import OpPlanner from './OpPlanner';
import { useEventPresets } from '../../utils/plannerHooks';
import { X } from 'lucide-react';
import { IconButton } from '../ui';
import { WideOpFrame } from './stripOpsUi';

/**
 * target, setTarget, close    from useOpPanelTarget
 * ops                         useStripOps() result
 * orgs, activeOrgId           the user's servers
 * layoutFor(kind)            wideOpLayout() for 'plan' | 'view' (from StripView)
 */
export default function OpPanel({ target, setTarget, close, ops, orgs, activeOrgId, layoutFor: baseLayoutFor, visible = true }) {
  // OPGROW: the frame collapses into its bar while the target is closing.
  const layoutFor = (kind) => ({ ...baseLayoutFor(kind), closing: !!target.closing });
  const { orgId, eventId } = target;
  const org = orgs.find((o) => o.id === orgId) || null;
  const user = ops.user;

  // The op itself: from the strip's list when it's on the active server,
  // otherwise (a notification from another server) fetched once.
  const fromList = orgId === activeOrgId ? ops.events.find((e) => e.id === eventId) : null;
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    setFetched(null);
    if (!eventId || fromList) return undefined;
    let stale = false;
    api.getOrgEvents(orgId).then(({ data }) => {
      const ev = (data?.events || []).find((e) => e.id === eventId);
      if (!stale && ev) setFetched(ev);
    }).catch(() => {});
    return () => { stale = true; };
  }, [orgId, eventId, !!fromList]); // eslint-disable-line react-hooks/exhaustive-deps -- refetch only when the source changes
  const event = fromList || fetched || target.event;

  const plan = useOpPlan({ orgId, eventId, planVersion: ops.planVersion });
  const planRef = useRef(plan);
  planRef.current = plan;

  const planning = target.mode === 'plan';
  const canEdit = !!event && canEditOp(org, user, event);
  const canCreate = !eventId && canScheduleOps(org, user);
  const canLaunch = !!event && canLaunchOp(org, user, event);
  // Group presets (planners only), shared with the full planner.
  const presets = useEventPresets(orgId, planning && (canEdit || canCreate));
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState(null);

  // Members (co-planners, direct role assignment) — only needed to plan.
  const [members, setMembers] = useState([]);
  useEffect(() => {
    if (!planning || !orgId) return undefined;
    let stale = false;
    api.getOrgMembers(orgId).then(({ data }) => { if (!stale) setMembers(data?.members || []); }).catch(() => {});
    return () => { stale = true; };
  }, [planning, orgId]);

  // Planner presence heartbeat, as OperationPlanner does for editors.
  // POLISH: the panel now stays open while the strip is hidden; you're not
  // "editing" then, so the heartbeat stops and resumes on show.
  const [editors, setEditors] = useState([]);
  useEffect(() => {
    if (!eventId || !orgId || !visible) return undefined;
    api.pingPresence(orgId, eventId).then(({ data }) => { if (data?.editors) setEditors(data.editors); }).catch(() => {});
    if (!planning || !canEdit) return undefined;
    const id = setInterval(() => api.pingPresence(orgId, eventId), 25_000);
    return () => { clearInterval(id); api.clearPresence(orgId, eventId); };
  }, [eventId, orgId, planning, canEdit, visible]);
  const liveEditors = ops.editors[eventId] || editors;

  // Leaving the planner (closing it) with unsaved plan edits saves them, like
  // the full planner's Back button. POLISH: hiding the strip used to unmount
  // the panel (and so save); it stays open now, so hiding saves explicitly.
  useEffect(() => () => {
    if (planRef.current.dirty) planRef.current.save();
  }, [eventId]);
  useEffect(() => {
    if (!visible && planRef.current.dirty) planRef.current.save();
  }, [visible]);

  // POLISH: shown again after a hide — if the op was deleted meanwhile (it's
  // on the active server and gone from the refreshed list), close the panel.
  // The show's refetch (useStripOps) starts after this effect runs, so the
  // check stays armed until that fetch has finished (or a few seconds pass —
  // no refetch within 10s of the last one, the list is fresh then).
  const showCheck = useRef(null); // null | { sawLoading }
  useEffect(() => {
    if (!visible) { showCheck.current = { sawLoading: false }; return undefined; }
    const t = setTimeout(() => { showCheck.current = null; }, 5000);
    return () => clearTimeout(t);
  }, [visible]);
  useEffect(() => {
    const c = showCheck.current;
    if (!visible || !c) return;
    if (ops.eventsLoading) { c.sawLoading = true; return; }
    if (eventId && orgId === activeOrgId && !ops.eventsError && !ops.events.some((e) => e.id === eventId)) { showCheck.current = null; close(); return; }
    if (c.sawLoading) showCheck.current = null;
  }, [visible, ops.eventsLoading, ops.events]); // eslint-disable-line react-hooks/exhaustive-deps -- armed once per show

  const closePanel = async () => {
    if (planning && plan.dirty) await plan.save();
    close();
  };

  const saveDetails = async (input) => {
    const body = buildEventBody(input);
    if (eventId) {
      const { data, error: err } = await api.updateOrgEvent(orgId, eventId, body);
      if (!err) await api.setEventPlanners(orgId, eventId, input.plannerIds);
      if (!err) {
        setTarget((t) => ({ ...t, event: { ...event, ...data?.event, planners: input.plannerIds.map((uid) => ({ user_id: uid, callsign: members.find((m) => m.user_id === uid)?.callsign || uid })) } }));
        ops.refresh();
      }
      return { error: err };
    }
    const { data, error: err } = await api.createOrgEvent(orgId, body);
    if (err) return { error: err };
    // The response doesn't carry planner callsigns — fill them in locally
    // (same as OperationPlanner's EventHeader).
    const created = {
      ...data.event,
      planners: input.plannerIds.map((uid) => ({ user_id: uid, callsign: members.find((m) => m.user_id === uid)?.callsign || uid })),
    };
    setTarget((t) => ({ ...t, eventId: created.id, event: created, mode: 'plan' }));
    ops.refresh();
    return { error: null };
  };

  const launch = async () => {
    if (!canLaunch) return;
    setLaunching(true);
    setError(null);
    const { error: err } = await api.launchEvent(orgId, eventId);
    setLaunching(false);
    if (err) setError(typeof err === 'string' ? err : 'Launch failed');
    else { ops.refresh(); plan.load(); }
  };

  const remove = async () => {
    const { error: err } = await api.deleteOrgEvent(orgId, eventId);
    if (err) { setError(typeof err === 'string' ? err : 'Delete failed'); return; }
    plan.setMsg(null);
    ops.refresh();
    close();
  };

  if (planning && (canEdit || canCreate)) {
    return (
      <OpPlanner
        event={eventId ? event : null}
        orgId={orgId}
        presets={presets}
        initialDate={target.initialDate}
        plan={plan}
        members={members}
        user={user}
        canLaunch={canLaunch}
        launching={launching}
        editors={liveEditors}
        onSaveDetails={saveDetails}
        onLaunch={launch}
        onDelete={remove}
        onDone={() => setTarget((t) => ({ ...t, mode: 'view' }))}
        onClose={closePanel}
        layout={layoutFor('plan')}
      />
    );
  }
  if (!event) {
    return (
      <WideOpFrame layout={layoutFor('view')} want={420} label="Operation" barLabel="Operation"
        bar={(
          <>
            <span className="flex-1 min-w-0 pl-2 truncate text-ui-sm text-specter-text-subtle">Loading operation…</span>
            <IconButton size="sm" icon={<X size={16} />} label="Close operation" onClick={closePanel} />
          </>
        )}>
        <p className="px-4 py-3 text-ui-sm text-specter-text-subtle">Loading operation…</p>
      </WideOpFrame>
    );
  }
  return (
    <OpView
      event={event}
      user={user}
      plan={error ? { ...plan, msg: { type: 'error', text: error } } : plan}
      canEdit={canEdit}
      canLaunch={canLaunch}
      launching={launching}
      onLaunch={launch}
      onEdit={() => setTarget((t) => ({ ...t, mode: 'plan' }))}
      onClose={closePanel}
      editors={liveEditors}
      orgId={orgId}
      layout={layoutFor('view')}
    />
  );
}
