import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as session from '../../auth/session.js';
import { api } from '../../api.js';
import useEventStream from '../../useEventStream';
import { getOpsBadge, getOpsNotifications, msUntilNextOpsChange } from '../../utils/opsEvents';
import { canEditOp, canLaunchOp, canScheduleOps } from '../../utils/opsPermissions';

// Operations data for the tray strip: the active server's events, the ops
// you're signed up for (any server), the Operations/Notifications badges and
// the notification read state. The strip is its own webview, so it fetches
// over REST itself (the Rust-owned session supplies the token).
//
// Live updates: while the strip is on screen it holds its own SSE connection
// (useEventStream — the server has no per-user connection cap, and the
// stream carries event_launched / event_roster_changed / operation_ended /
// planner_presence). While hidden it holds none: nothing is visible then, and
// every show refetches. Creating, editing or deleting an op has no SSE event,
// so a slow poll (POLL_MS) covers those while the strip is up. A one-shot
// timer re-renders when an op crosses a badge/notification boundary.
//
// localStorage (the strip's own profile):
//   specter_strip_notif_read  JSON array of read notification keys

const READ_KEY = 'specter_strip_notif_read';
const POLL_MS = 120_000;
const SHOW_REFRESH_MIN_MS = 10_000;

const inTauri = () => Boolean(window.__TAURI_INTERNALS__);

function readSet() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_KEY) || '[]')); } catch { return new Set(); }
}
function writeSet(set) {
  try { localStorage.setItem(READ_KEY, JSON.stringify([...set])); } catch { /* not fatal */ }
}

const sortByStart = (list) => [...list].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

// Whether the strip window is on screen (always true outside Tauri).
function useStripVisible() {
  const [visible, setVisible] = useState(() => !inTauri());
  useEffect(() => {
    if (!inTauri()) return undefined;
    let stopped = false;
    const offs = [];
    import('@tauri-apps/api/event').then(({ listen }) => Promise.all([
      listen('strip-shown', () => setVisible(true)),
      listen('strip-hidden', () => setVisible(false)),
    ])).then((fns) => { if (stopped) fns.forEach((f) => f()); else offs.push(...fns); })
      .catch((err) => console.warn('strip visibility listeners failed:', err));
    return () => { stopped = true; offs.forEach((f) => f()); };
  }, []);
  return visible;
}

/**
 * signedIn  the strip is logged in
 * org       the active server's /orgs/me entry (null while loading)
 * Returns everything the Operations / Notifications cabinets and the op panel
 * need; see the object at the bottom.
 */
export default function useStripOps({ signedIn, org }) {
  const orgId = org?.id || null;
  const visible = useStripVisible();
  const [user, setUser] = useState(null);
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState(null);
  const [mine, setMine] = useState([]);
  const [readKeys, setReadKeys] = useState(readSet);
  const [planVersion, setPlanVersion] = useState(0); // bumps on roster/launch changes
  const [editors, setEditors] = useState({}); // eventId → [{ userId, callsign }]
  const [, setClock] = useState(0);
  const lastFetchRef = useRef(0);
  const orgIdRef = useRef(orgId);
  orgIdRef.current = orgId;

  // ── Who am I ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!signedIn) { setUser(null); return undefined; }
    let stale = false;
    session.currentUser().then((u) => { if (!stale && u) setUser(u); }).catch(() => {});
    const stop = session.onAuthChanged(({ user: u }) => setUser(u || null));
    return () => { stale = true; stop(); };
  }, [signedIn]);

  // ── Fetching ─────────────────────────────────────────────────────────────
  const loadEvents = useCallback((id = orgIdRef.current) => {
    if (!id) return Promise.resolve();
    setEventsLoading(true);
    return api.getOrgEvents(id).then(({ data, error }) => {
      if (orgIdRef.current !== id) return; // switched servers meanwhile
      setEventsLoading(false);
      if (error) { setEventsError(typeof error === 'string' ? error : 'Could not load operations'); return; }
      setEventsError(null);
      setEvents(sortByStart(data?.events || []));
    }).catch((err) => {
      console.warn('getOrgEvents failed:', err);
      setEventsLoading(false);
      setEventsError('Could not load operations');
    });
  }, []);

  const loadMine = useCallback(() => api.getMyUpcomingEvents().then(({ data, error }) => {
    if (!error) setMine(data?.events || []);
  }).catch((err) => console.warn('getMyUpcomingEvents failed:', err)), []);

  const refresh = useCallback(() => {
    lastFetchRef.current = Date.now();
    return Promise.all([loadEvents(), loadMine()]);
  }, [loadEvents, loadMine]);

  // Server switch / login: start over for the new server.
  useEffect(() => {
    setEvents([]);
    setEventsError(null);
    if (signedIn && orgId) { lastFetchRef.current = Date.now(); loadEvents(orgId); loadMine(); }
  }, [signedIn, orgId, loadEvents, loadMine]);

  // Shown again: refetch (unless we just did), then poll while up.
  useEffect(() => {
    if (!signedIn || !visible) return undefined;
    if (Date.now() - lastFetchRef.current > SHOW_REFRESH_MIN_MS) refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [signedIn, visible, refresh]);

  // ── Live updates ─────────────────────────────────────────────────────────
  const refreshTimer = useRef(null);
  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refresh, 300);
  }, [refresh]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);

  useEventStream({
    connected: refreshSoon,
    event_launched: () => { refreshSoon(); setPlanVersion((v) => v + 1); },
    event_roster_changed: () => { refreshSoon(); setPlanVersion((v) => v + 1); },
    operation_ended: () => { refreshSoon(); setPlanVersion((v) => v + 1); },
    planner_presence: (p) => { if (p?.event_id) setEditors((m) => ({ ...m, [p.event_id]: p.editors || [] })); },
  }, { enabled: signedIn && visible });

  // Re-render when the next op crosses a badge / notification boundary.
  const allForClock = useMemo(() => [...events, ...mine], [events, mine]);
  useEffect(() => {
    const ms = msUntilNextOpsChange(allForClock);
    if (ms == null) return undefined;
    const id = setTimeout(() => setClock((c) => c + 1), Math.min(ms, 3600 * 1000));
    return () => clearTimeout(id);
  });

  // A date/time picker's popup is a separate native window in WebView2, so
  // opening one blurs the strip; report "busy" while one is focused so the
  // strip doesn't hide under it (StripApp feeds this to strip_set_busy).
  const [pickerBusy, setPickerBusy] = useState(false);
  useEffect(() => {
    const check = () => {
      const el = document.activeElement;
      setPickerBusy(!!el && el.tagName === 'INPUT' && /^(datetime-local|date|time)$/.test(el.type));
    };
    document.addEventListener('focusin', check);
    document.addEventListener('focusout', check);
    return () => { document.removeEventListener('focusin', check); document.removeEventListener('focusout', check); };
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────────
  const now = new Date();
  const badge = orgId ? getOpsBadge(events, now) : null;
  const notifications = getOpsNotifications({ mine, events, orgId, now });
  const unreadCount = notifications.filter((n) => !readKeys.has(n.key)).length;

  const markRead = useCallback((keys) => {
    setReadKeys((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      writeSet(next);
      return next;
    });
  }, []);

  // Forget read keys for notifications that no longer exist (bounded storage).
  const liveKeys = notifications.map((n) => n.key).join('|');
  useEffect(() => {
    if (!signedIn || eventsLoading) return;
    const keep = new Set(liveKeys ? liveKeys.split('|') : []);
    setReadKeys((prev) => {
      const next = new Set([...prev].filter((k) => keep.has(k)));
      if (next.size === prev.size) return prev;
      writeSet(next);
      return next;
    });
  }, [liveKeys, signedIn, eventsLoading]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const canLaunch = useCallback((ev) => canLaunchOp(org, user, ev), [org, user]);
  const canEdit = useCallback((ev) => canEditOp(org, user, ev), [org, user]);

  const launch = useCallback(async (ev) => {
    if (!orgId || !canLaunchOp(org, user, ev)) return { error: 'Not allowed' };
    const res = await api.launchEvent(orgId, ev.id);
    if (!res.error) refresh();
    return res;
  }, [orgId, org, user, refresh]);

  // Server-side "pick the best open role for me" (open-access ops only).
  const quickJoin = useCallback(async (ev, evOrgId = orgId) => {
    const res = await api.quickJoinEvent(evOrgId, ev.id);
    if (!res.error) refresh();
    return res;
  }, [orgId, refresh]);

  return {
    user,
    visible,
    pickerBusy,
    events,
    eventsLoading,
    eventsError,
    mine,
    badge,
    notifications,
    unreadCount,
    readKeys,
    markRead,
    planVersion,
    editors,
    canSchedule: canScheduleOps(org, user),
    canLaunch,
    canEdit,
    refresh,
    launch,
    quickJoin,
  };
}
