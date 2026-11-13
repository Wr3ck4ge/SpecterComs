import { useEffect, useRef, useState } from 'react';
import { REPORT_CATEGORIES } from '@spectercoms/shared-web/src/sealedReport.js';

// Settings → About & diagnostics → "Your reports": the user's recent bug
// reports and the owner's replies (useBugReportReplies). Opening it marks the
// shown replies as seen; the ones that were new keep a "New" tag until the
// panel closes. The reply is owner-written plain text: React-escaped,
// pre-wrap, no links or markdown.

const CATEGORY = Object.fromEntries(REPORT_CATEGORIES.map((c) => [c.id, c.label]));
const STATUS = { new: 'Received', triaged: 'Looking into it', closed: 'Closed' };

const fmtDate = (ts) => {
  try { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; }
};

export default function BugReportReplies({ replies }) {
  const [fresh, setFresh] = useState(() => new Set());
  const refreshed = useRef(false);
  const { reports = [], refresh, markSeen } = replies || {};

  useEffect(() => {
    if (!refreshed.current && refresh) { refreshed.current = true; refresh(); }
  }, [refresh]);

  useEffect(() => {
    const unread = reports.filter((r) => r.unread).map((r) => r.id);
    if (!unread.length) return;
    setFresh((s) => new Set([...s, ...unread]));
    markSeen?.(unread);
  }, [reports, markSeen]);

  if (!reports.length) return null;
  return (
    <ul className="space-y-2">
      {reports.map((r) => (
        <li key={r.id} className="rounded-md border border-specter-border px-3 py-2">
          <div className="flex items-center gap-2 text-ui-xs text-specter-text-subtle">
            <span className="text-specter-text-main">{CATEGORY[r.category] || r.category}</span>
            <span>· {fmtDate(r.created_at)}</span>
            {r.app_version && <span className="font-mono">· {r.app_version}</span>}
            <span className="ml-auto">{STATUS[r.status] || r.status}</span>
            {fresh.has(r.id) && <span className="rounded bg-specter-primary-neon/15 px-1.5 text-specter-primary-neon">New</span>}
          </div>
          {r.resolution ? (
            <p className="mt-1.5 whitespace-pre-wrap break-words text-ui-sm text-specter-text-main">{r.resolution}</p>
          ) : (
            <p className="mt-1 text-ui-xs text-specter-text-subtle">No reply yet.</p>
          )}
        </li>
      ))}
    </ul>
  );
}
