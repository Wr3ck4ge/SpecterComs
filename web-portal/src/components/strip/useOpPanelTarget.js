// Which op the strip's op panel shows (see OpPanel.jsx), owned by StripApp.
import { useCallback, useEffect, useState } from 'react';
import { opCloseDelay } from './stripOpsLayout';

/**
 * The panel's open/closed state for StripApp. A target is
 *   { seq, orgId, eventId, event?, initialDate?, mode: 'view' | 'plan', closing? }
 * (eventId null = creating; seq changes per open, so the panel is keyed on it). Returns { target, open, schedule, close, setTarget }.
 *
 * OPGROW: close() doesn't drop the target at once — it marks it `closing`, so
 * the panel collapses into the secondary bar and the bar then leaves
 * (WideOpFrame); the target goes after opCloseDelay(). Cabinet / server
 * changes still drop it at once (the cabinet itself is leaving).
 */
export default function useOpPanelTarget({ cabinet, activeOrgId }) {
  const [target, setTarget] = useState(null);
  // The panel belongs to the ops/notifications cabinets: it goes when they do,
  // and a server switch drops an op from the old server.
  useEffect(() => {
    if (cabinet !== 'operations' && cabinet !== 'notifications') setTarget(null);
  }, [cabinet]);
  useEffect(() => { setTarget(null); }, [activeOrgId]);

  // OPGROW: finish a close once the collapse + bar exit have played (a timer:
  // a hidden window may never run the transitions).
  const closingSeq = target?.closing ? target.seq : null;
  useEffect(() => {
    if (closingSeq === null) return undefined;
    const t = setTimeout(() => setTarget((cur) => (cur?.closing && cur.seq === closingSeq ? null : cur)), opCloseDelay());
    return () => clearTimeout(t);
  }, [closingSeq]);

  const open = useCallback((event, orgId = activeOrgId) => {
    setTarget((t) => (t?.eventId === event.id && !t.closing
      ? { ...t, closing: true }
      : { seq: Date.now(), orgId, eventId: event.id, event, mode: 'view' }));
  }, [activeOrgId]);
  const schedule = useCallback((initialDate = null) => {
    setTarget({ seq: Date.now(), orgId: activeOrgId, eventId: null, event: null, initialDate, mode: 'plan' });
  }, [activeOrgId]);
  const close = useCallback(() => setTarget((t) => (t && !t.closing ? { ...t, closing: true } : t)), []);
  return { target, setTarget, open, schedule, close };
}
