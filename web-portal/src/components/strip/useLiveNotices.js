import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import {
  LIVE_AUTO_COLLAPSE_MS, newLiveOps, pruneDismissed, visibleLiveOps,
} from './liveNoticeLayout';

// LIVE: the strip's live-op notices (LiveOpNotice.jsx), fed by the engine's
// EngineState.liveOps (every server, see engine/liveOps.js).
//
//   - A launch that hasn't been announced yet pops the notice open (and, if
//     the strip is hidden, asks StripApp to peek it — onAnnounce).
//   - Open, it folds into a small pulsing tab after LIVE_AUTO_COLLAPSE_MS
//     on screen (the timer only runs while the notice is visible and the
//     pointer isn't on it). Clicking the tab opens it again.
//   - Join / View fold it too; Dismiss removes that launch for good
//     (dismissal is per launch key, persisted, so it never re-notifies).
//   - Several live ops: one at a time with "1 of 3" and arrows; the tab
//     shows the count.
//
// localStorage (the strip's own profile):
//   specter_strip_live_dismissed  JSON array of dismissed launch keys

const DISMISSED_KEY = 'specter_strip_live_dismissed';

function readDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); } catch { return new Set(); }
}
function writeDismissed(set) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set])); } catch { /* not fatal */ }
}

/**
 * liveOps     engine.state.liveOps
 * known       the engine is connected (liveOps is real, not the empty default)
 * onScreen    the notice is actually visible (strip shown or peeked)
 * onAnnounce  () => void — a new launch wants to be seen
 */
export default function useLiveNotices({ liveOps = [], known = false, onScreen = false, onAnnounce = null }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [expanded, setExpanded] = useState(false);
  const [currentKey, setCurrentKey] = useState(null);
  const [hold, setHold] = useState(false);
  const [assignments, setAssignments] = useState({}); // key → assignment | null
  const announcedRef = useRef(new Set());
  const onAnnounceRef = useRef(onAnnounce);
  onAnnounceRef.current = onAnnounce;

  const ops = visibleLiveOps(liveOps, dismissed);
  const keys = ops.map((o) => o.key).join('|');

  // Forget dismissals of launches that are over.
  const liveKeys = liveOps.map((o) => o.key).join('|');
  useEffect(() => {
    setDismissed((prev) => {
      const next = pruneDismissed(prev, liveOps, known);
      if (next !== prev) writeDismissed(next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the keys
  }, [liveKeys, known]);

  // New launches: open on the newest, announce.
  useEffect(() => {
    if (!known) return;
    const fresh = newLiveOps(ops, announcedRef.current);
    if (!fresh.length) return;
    fresh.forEach((o) => announcedRef.current.add(o.key));
    setCurrentKey(fresh[0].key);
    setExpanded(true);
    onAnnounceRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the keys
  }, [keys, known]);

  // Auto-collapse while on screen and not hovered.
  useEffect(() => {
    if (!expanded || !onScreen || hold) return undefined;
    const t = setTimeout(() => setExpanded(false), LIVE_AUTO_COLLAPSE_MS);
    return () => clearTimeout(t);
  }, [expanded, onScreen, hold, currentKey]);

  const index = Math.max(0, ops.findIndex((o) => o.key === currentKey));
  const current = ops[index] || null;

  // My assignment (group / role) for the shown op, once per launch.
  const curKey = current?.key;
  const curOrg = current?.orgId;
  const curEvent = current?.eventId;
  const requestedRef = useRef(new Set());
  useEffect(() => {
    if (!curKey || !curOrg || !curEvent || requestedRef.current.has(curKey)) return;
    requestedRef.current.add(curKey);
    Promise.resolve(api.getMyEventAssignment(curOrg, curEvent)).then(({ data, error } = {}) => {
      if (error) { requestedRef.current.delete(curKey); return; } // try again next time it's shown
      const a = data?.assignment;
      setAssignments((m) => ({ ...m, [curKey]: a ? {
        groupName: a.group_name || null, channelId: a.channel_id || null,
        channelName: a.channel_name || null, role: a.role || null,
      } : null }));
    }).catch(() => { requestedRef.current.delete(curKey); });
  }, [curKey, curOrg, curEvent]);

  const dismiss = useCallback((key) => {
    setDismissed((prev) => {
      const next = new Set(prev).add(key);
      writeDismissed(next);
      return next;
    });
  }, []);
  const step = (d) => {
    if (ops.length < 2) return;
    setCurrentKey(ops[(index + d + ops.length) % ops.length].key);
  };

  return {
    ops,
    current,
    index,
    count: ops.length,
    expanded: expanded && Boolean(current),
    assignment: current ? assignments[current.key] ?? null : null,
    expand: () => setExpanded(true),
    collapse: () => setExpanded(false),
    next: () => step(1),
    prev: () => step(-1),
    dismiss,
    setHold,
  };
}
