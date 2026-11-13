import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { API_BASE_URL } from '../../apiBase.js';
import { cx } from '../ui/styles';

// L7: incident notice. Polls the public GET /status every 60 s (doubling up
// to 10 min after failures, paused while the window is hidden) and shows the
// admin-written notice. Dismissal is per notice id (remembered locally), so a
// new notice shows again. Renders nothing when there is no notice.

const POLL_MS = 60_000;
const MAX_BACKOFF_MS = 600_000;
const DISMISS_KEY = 'specter.status.dismissed';

const TONE = {
  info: 'border-sky-400/40 text-sky-100',
  maintenance: 'border-sky-400/40 text-sky-100',
  degraded: 'border-amber-400/50 text-amber-100',
  outage: 'border-red-400/50 text-red-100',
};
const LABEL = { info: 'Notice', maintenance: 'Maintenance', degraded: 'Degraded service', outage: 'Outage' };

export function readDismissed() {
  try { return Number(localStorage.getItem(DISMISS_KEY)) || 0; } catch { return 0; }
}
function writeDismissed(id) {
  try { localStorage.setItem(DISMISS_KEY, String(id)); } catch { /* storage unavailable */ }
}

export function useStatusNotice() {
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    let stopped = false;
    let timer = null;
    let failures = 0;
    const schedule = () => {
      if (stopped) return;
      const wait = Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS);
      timer = setTimeout(tick, wait);
    };
    const tick = async () => {
      timer = null;
      if (document.hidden) return; // resumed by visibilitychange
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(`${API_BASE_URL}/status`, { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(to);
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        if (stopped) return;
        failures = 0;
        setNotice(body?.notice && body.notice.message ? body.notice : null);
      } catch {
        failures = Math.min(failures + 1, 4);
      }
      schedule();
    };
    const onVis = () => {
      if (!document.hidden && !timer && !stopped) tick();
    };
    document.addEventListener('visibilitychange', onVis);
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  return notice;
}

/** grow: 'up' | 'down' - which side of the bar the banner sits on. */
export default function StatusBanner({ grow = 'up' }) {
  const notice = useStatusNotice();
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = useCallback(() => { writeDismissed(notice.id); setDismissed(notice.id); }, [notice]);
  if (!notice || notice.id <= dismissed) return null;
  const eta = notice.eta ? new Date(notice.eta) : null;
  return (
    <div
      data-strip-region=""
      role="status"
      className={cx(
        'absolute left-0 right-0 flex items-start gap-2 rounded-md border bg-black/80 px-2.5 py-2 text-xs font-ui shadow-lg',
        grow === 'down' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
        TONE[notice.severity] || TONE.info,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{LABEL[notice.severity] || 'Notice'}</div>
        <div className="break-words">{notice.message}</div>
        {eta && !Number.isNaN(eta.getTime()) && (
          <div className="opacity-70">Expected back by {eta.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
        )}
      </div>
      <button type="button" onClick={dismiss} aria-label="Dismiss notice" className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}
