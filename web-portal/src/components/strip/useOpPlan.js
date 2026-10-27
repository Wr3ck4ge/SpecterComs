import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { buildEventGroupsPayload, mapEventGroups } from '../../utils/eventGroups';

// One operation's group plan for the strip's op panel: the same endpoints and
// data mapping OperationPlanner's GroupPlanner uses (utils/eventGroups), plus
// its join / leave / approve / respond / save actions. Every action reloads
// the plan afterwards, like GroupPlanner does.
//
// `planVersion` (from useStripOps) bumps on roster/launch SSE events; the
// plan reloads then unless there are unsaved local edits.
export default function useOpPlan({ orgId, eventId, planVersion }) {
  const [groups, setGroupsState] = useState([]);
  const [frequencies, setFrequenciesState] = useState([]);
  const [myAssignment, setMyAssignment] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(null); // { type: 'ok' | 'error', text }
  const [shipConfirm, setShipConfirm] = useState(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const keyRef = useRef(`${orgId}:${eventId}`);
  keyRef.current = `${orgId}:${eventId}`;

  const load = useCallback(async () => {
    if (!orgId || !eventId) { setGroupsState([]); setFrequenciesState([]); setMyAssignment(null); return; }
    const key = `${orgId}:${eventId}`;
    setLoading(true);
    const [{ data, error }, assignmentRes] = await Promise.all([
      api.getEventGroups(orgId, eventId),
      api.getMyEventAssignment(orgId, eventId),
    ]);
    if (keyRef.current !== key) return;
    setLoading(false);
    if (error) { setMsg({ type: 'error', text: typeof error === 'string' ? error : 'Could not load the plan' }); return; }
    const mapped = mapEventGroups(data);
    setGroupsState(mapped.groups);
    setFrequenciesState(mapped.frequencies);
    setMyAssignment(assignmentRes?.data?.assignment || null);
    setDirty(false);
  }, [orgId, eventId]);

  useEffect(() => { setMsg(null); setShipConfirm(null); load(); }, [load]);
  useEffect(() => {
    if (planVersion && !dirtyRef.current) load();
  }, [planVersion]); // eslint-disable-line react-hooks/exhaustive-deps -- reload only on a version bump

  // Local edits (planner): mark dirty until saved.
  const setGroups = useCallback((updater) => {
    setGroupsState(updater);
    setDirty(true);
  }, []);
  // P2B: frequencies are edited in the wide planner's Comms page.
  const setFrequencies = useCallback((updater) => {
    setFrequenciesState(updater);
    setDirty(true);
  }, []);

  // P2B: ship slot claims (same endpoints as GroupPlanner); a claim or
  // release reloads the plan.
  const getClaimableShips = useCallback((groupId) => api.getClaimableShips(orgId, eventId, groupId), [orgId, eventId]);
  const claimShipSlot = useCallback(async (groupId, shipSlug, slotIndex, userShipId) => {
    const res = await api.claimShipSlot(orgId, eventId, groupId, shipSlug, slotIndex, userShipId);
    if (res.error) setMsg({ type: 'error', text: typeof res.error === 'string' ? res.error : 'Claim failed' });
    else load();
    return res;
  }, [orgId, eventId, load]);
  const releaseShipSlot = useCallback(async (groupId, shipSlug) => {
    const res = await api.releaseShipSlot(orgId, eventId, groupId, shipSlug);
    if (res.error) setMsg({ type: 'error', text: typeof res.error === 'string' ? res.error : 'Release failed' });
    else load();
    return res;
  }, [orgId, eventId, load]);

  const run = useCallback(async (call, okText) => {
    setMsg(null);
    const res = await call();
    if (res?.error) setMsg({ type: 'error', text: typeof res.error === 'string' ? res.error : 'Something went wrong' });
    else {
      if (okText || res?.data?.message) setMsg({ type: 'ok', text: okText || res.data.message });
      await load();
    }
    return res;
  }, [load]);

  const save = useCallback(async () => {
    if (!orgId || !eventId) return { error: 'No operation' };
    setSaving(true);
    setMsg(null);
    const res = await api.saveEventGroups(orgId, eventId, buildEventGroupsPayload(groups, frequencies));
    setSaving(false);
    if (res.error) setMsg({ type: 'error', text: typeof res.error === 'string' ? res.error : 'Save failed' });
    else { setMsg({ type: 'ok', text: 'Plan saved' }); await load(); }
    return res;
  }, [orgId, eventId, groups, frequencies, load]);

  // Join a role, confirming first when the join would also reserve the
  // locked seats of a matching hangar ship (GroupPlanner.handleJoinRole).
  const joinRole = useCallback(async (groupId, roleId, seatLabel = null) => {
    const { data } = await api.getGroupShipMatch(orgId, eventId, groupId);
    const match = data?.match;
    if (match && (match.locked_seats || []).length > 0) {
      setShipConfirm({ groupId, roleId, shipId: match.ship_id, shipName: match.ship_name, seatLabels: match.locked_seat_labels || [], joinSeatLabel: seatLabel });
      return null;
    }
    return run(() => api.joinEventRole(orgId, eventId, groupId, roleId, match?.ship_id || null, seatLabel));
  }, [orgId, eventId, run]);

  const confirmShipJoin = useCallback((withShip) => {
    if (!shipConfirm) return null;
    const { groupId, roleId, shipId, joinSeatLabel } = shipConfirm;
    setShipConfirm(null);
    return run(() => api.joinEventRole(orgId, eventId, groupId, roleId, withShip ? shipId : null, joinSeatLabel));
  }, [shipConfirm, orgId, eventId, run]);

  return {
    groups, setGroups, frequencies, setFrequencies, getClaimableShips, claimShipSlot, releaseShipSlot, myAssignment, loading, saving, dirty, msg, setMsg, shipConfirm, load, save,
    joinRole,
    confirmShipJoin,
    cancelShipJoin: () => setShipConfirm(null),
    leaveRole: (groupId, roleId) => run(() => api.leaveEventRole(orgId, eventId, groupId, roleId)),
    approve: (groupId, userId) => run(() => api.approveGroupMember(orgId, eventId, groupId, userId)),
    deny: (groupId, userId) => run(() => api.removeGroupMember(orgId, eventId, groupId, userId)),
    approveAll: (groupId) => run(() => api.approveAllGroupMembers(orgId, eventId, groupId)),
    respond: (accept) => run(() => api.respondEventAssignment(orgId, eventId, accept), accept ? 'Assignment accepted' : 'Assignment declined'),
    quickJoin: () => run(() => api.quickJoinEvent(orgId, eventId)),
  };
}
