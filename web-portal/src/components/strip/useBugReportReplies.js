import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';

// The owner's replies to this user's bug reports (GET /bug-reports/mine).
// Checked on sign-in, then every 10 minutes while the strip is visible, and
// whenever refresh() is called (Settings → About & diagnostics opens it).
// The bar shows a chip while a reply is unread; markSeen() clears it.
//
// The reply is plain text written by the owner; it is shown React-escaped
// with pre-wrap, never as markdown or HTML.

const POLL_MS = 10 * 60_000;

export default function useBugReportReplies(signedIn) {
  const [reports, setReports] = useState([]);
  const stoppedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    try {
      const { data, error } = await api.listMyBugReports();
      if (!error && !stoppedRef.current) setReports(Array.isArray(data?.reports) ? data.reports : []);
    } catch { /* offline: keep what we had */ }
  }, [signedIn]);

  useEffect(() => {
    stoppedRef.current = false;
    if (!signedIn) { setReports([]); return undefined; }
    refresh();
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stoppedRef.current = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [signedIn, refresh]);

  const markSeen = useCallback(async (ids) => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return;
    setReports((rs) => rs.map((r) => (list.includes(r.id) ? { ...r, unread: false } : r)));
    await Promise.all(list.map((id) => api.markBugReportSeen(id).catch(() => null)));
  }, []);

  const unread = reports.filter((r) => r.unread).length;
  return { reports, unread, refresh, markSeen };
}
