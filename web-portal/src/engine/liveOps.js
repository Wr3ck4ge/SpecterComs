// LIVE: the engine's list of live (launched) ops across ALL of the user's
// servers, published to the strip as EngineState.liveOps (bridge.js). The
// engine holds the one SSE connection that is up all the time (the strip's own
// only runs while it's on screen), so it is the one that sees an op go live
// while the strip is hidden.
//
// Sources: GET /orgs/:id/events per server (launched = live, see
// utils/opsEvents isOpLive) on login / server-list change / SSE reconnect and
// every POLL_MS; event_launched (refetch that server, and remember WHEN it
// went live — the server keeps no launched_at) and operation_ended (drop it).
//
// localStorage (the engine's profile):
//   specter_live_op_since  { [liveOpKey]: { t, orgId } } — when this client
//                          saw that launch happen, for "live for 12 min"

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { isOpLive } from '../utils/opsEvents';

const SINCE_KEY = 'specter_live_op_since';
const POLL_MS = 180_000;
const LAUNCH_REFETCH_DELAY_MS = 500;

/** Which server an SSE org event is for (`subject` = specter.event.org.<id>). */
export function orgIdFromEvent(payload) {
  if (!payload) return null;
  if (payload.org_id || payload.orgId) return payload.org_id || payload.orgId;
  const m = /^specter\.event\.org\.(.+)$/.exec(payload.subject || '');
  return m ? m[1] : null;
}

/**
 * One launch of one op. The command channel is created per launch, so an op
 * that is ended and launched again gets a new key (a dismissed notice comes
 * back for the new launch, not for the old one).
 */
export const liveOpKey = (ev) => `${ev.id}:${ev.command_channel_id || 'launch'}`;

/**
 * EngineState.liveOps from the per-server launched lists. Pure.
 * byOrg  { [orgId]: event[] } (getOrgEvents rows, launched only)
 * orgs   the user's servers ({ id, callsign | name }) — servers left are dropped
 * since  { [key]: { t } }
 * Newest launch first (known launch time first, then start time).
 */
export function buildLiveOps({ byOrg = {}, orgs = [], since = {} }) {
  const out = [];
  for (const org of orgs) {
    for (const ev of byOrg[org.id] || []) {
      if (!isOpLive(ev)) continue;
      const key = liveOpKey(ev);
      out.push({
        key,
        eventId: ev.id,
        orgId: org.id,
        orgName: org.callsign || org.name || '',
        name: ev.name || 'Operation',
        startTime: ev.start_time || null,
        endTime: ev.end_time || null,
        liveSince: since[key]?.t ?? null,
        filledSlots: Number(ev.filled_slots) || 0,
        totalSlots: Number(ev.total_slots) || 0,
        commandChannelId: ev.command_channel_id || null,
        // What the strip's op panel needs to open it (useOpPanelTarget).
        event: {
          id: ev.id, name: ev.name, start_time: ev.start_time, end_time: ev.end_time ?? null,
          launched: true, command_channel_id: ev.command_channel_id ?? null,
          commander_user_id: ev.commander_user_id ?? null, creator_id: ev.creator_id ?? null,
          access_mode: ev.access_mode || 'open', game: ev.game || 'none',
          filled_slots: Number(ev.filled_slots) || 0, total_slots: Number(ev.total_slots) || 0,
          org_id: org.id,
        },
      });
    }
  }
  const t = (o) => o.liveSince ?? (o.startTime ? new Date(o.startTime).getTime() : 0);
  return out.sort((a, b) => t(b) - t(a));
}

function readSince() {
  try { return JSON.parse(localStorage.getItem(SINCE_KEY) || '{}') || {}; } catch { return {}; }
}
function writeSince(v) {
  try { localStorage.setItem(SINCE_KEY, JSON.stringify(v)); } catch { /* not fatal */ }
}

/**
 * Engine hook (WarRoom). Feed it the SSE events through the returned
 * onLaunched / onEnded / onConnected; publish `liveOps` in the bridge state.
 */
export default function useLiveOps({ userId, orgs = [] }) {
  const [byOrg, setByOrg] = useState({});
  const [since, setSince] = useState(readSince);
  const seenLaunchRef = useRef(new Map()); // eventId → ms (event_launched seen)
  const orgIdsKey = orgs.map((o) => o.id).sort().join(',');
  const orgIdsRef = useRef([]);
  orgIdsRef.current = orgIdsKey ? orgIdsKey.split(',') : [];

  const fetchOrg = useCallback(async (orgId) => {
    let res;
    try { res = await api.getOrgEvents(orgId); } catch { return; }
    if (res?.error) return;
    const live = (res?.data?.events || []).filter(isOpLive);
    setByOrg((m) => ({ ...m, [orgId]: live }));
    setSince((prev) => {
      const next = {};
      // Keep other servers' entries; this server's only for ops still live.
      for (const [k, v] of Object.entries(prev)) if (v.orgId !== orgId) next[k] = v;
      for (const ev of live) {
        const key = liveOpKey(ev);
        const seen = seenLaunchRef.current.get(ev.id);
        if (prev[key]) next[key] = prev[key];
        else if (seen) next[key] = { t: seen, orgId };
      }
      if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
      writeSince(next);
      return next;
    });
  }, []);

  const refreshAll = useCallback(() => { orgIdsRef.current.forEach((id) => { fetchOrg(id); }); }, [fetchOrg]);

  useEffect(() => {
    if (!userId) { setByOrg({}); return undefined; }
    refreshAll();
    const t = setInterval(refreshAll, POLL_MS);
    return () => clearInterval(t);
  }, [userId, orgIdsKey, refreshAll]);

  const onLaunched = useCallback((payload) => {
    const eventId = payload?.eventId || payload?.event_id;
    if (eventId) seenLaunchRef.current.set(eventId, Date.now());
    const orgId = orgIdFromEvent(payload);
    setTimeout(() => (orgId ? fetchOrg(orgId) : refreshAll()), LAUNCH_REFETCH_DELAY_MS);
  }, [fetchOrg, refreshAll]);

  const onEnded = useCallback((payload) => {
    const eventId = payload?.eventId || payload?.event_id;
    if (eventId) {
      seenLaunchRef.current.delete(eventId);
      setByOrg((m) => {
        let changed = false;
        const next = {};
        for (const [k, list] of Object.entries(m)) {
          const kept = list.filter((ev) => ev.id !== eventId);
          if (kept.length !== list.length) changed = true;
          next[k] = kept;
        }
        return changed ? next : m;
      });
    }
    const orgId = orgIdFromEvent(payload);
    if (orgId) fetchOrg(orgId);
  }, [fetchOrg]);

  return {
    liveOps: userId ? buildLiveOps({ byOrg, orgs, since }) : [],
    onLaunched,
    onEnded,
    onConnected: refreshAll,
  };
}
