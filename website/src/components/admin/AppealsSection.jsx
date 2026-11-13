import React, { useCallback, useEffect, useState } from 'react';
import { RBtn, Alert, Badge, Time, Field, TextInput } from './ui';

// L12: platform ban appeals. One per enforcement action, filed within 30 days,
// answer within 14. The server refuses a decision by the admin who took the
// action unless they are the only admin able to decide (then it is flagged).
// Overturning lifts the account ban (and the hardware ban recorded for it).

const STATE_TONE = { open: 'amber', upheld: 'gray', overturned: 'green' };

export default function AppealsSection({ adminApi }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [view, setView] = useState('open');
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    const { data, error } = await adminApi.listAppeals(view);
    if (error) { setErr(error); return; }
    setErr(null);
    setRows(data.appeals);
  }, [adminApi, view]);
  useEffect(() => { load(); }, [load]);

  const decide = async (a, decision) => {
    setBusy(a.id); setMsg(null);
    const { data, error } = await adminApi.decideAppeal(a.id, decision, notes[a.id] || null);
    setBusy(null);
    if (error) { setErr(error); return; }
    setErr(null);
    setMsg(`${data.message}${data.sole_admin_decision ? ' Flagged: you took the original action and are the only admin who can decide.' : ''}${data.emailed ? ' The user was emailed.' : ' No email sent; the user sees the decision on the appeal page.'}`);
    load();
  };

  const overdue = (a) => a.state === 'open' && new Date(a.due_by).getTime() < Date.now();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Appeals</h2>
        <p className="text-sm text-gray-500">
          Platform suspensions and bans only. Answer within 14 days. A different admin than the one who acted should decide.
          Appeal text is deleted 30 days after the decision.
        </p>
      </div>
      <div className="flex gap-2">
        {['open', 'upheld', 'overturned'].map((s) => (
          <RBtn key={s} small variant={view === s ? 'success' : 'default'} onClick={() => { setRows(null); setView(s); }}>{s}</RBtn>
        ))}
      </div>
      {err && <Alert onDismiss={() => setErr(null)}>{err}</Alert>}
      {msg && <Alert type="warn" onDismiss={() => setMsg(null)}>{msg}</Alert>}
      {rows && rows.length === 0 && <div className="text-sm text-gray-400">No {view} appeals.</div>}
      {rows && rows.map((a) => (
        <div key={a.id} className="border border-gray-200 bg-white rounded-lg shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <strong>{a.callsign}</strong>
            <Badge tone={STATE_TONE[a.state]}>{a.state}</Badge>
            {overdue(a) && <Badge tone="red">Overdue</Badge>}
            <span className="text-gray-500">Filed <Time ts={a.created_at} />; due <Time ts={a.due_by} /></span>
          </div>
          <div className="text-xs text-gray-500">
            Ban on <Time ts={a.action_at} /> by {a.action_admin_username || 'unknown'}{a.action_reason ? `, reason: ${a.action_reason}` : ''}
            {a.is_own_action && <> <Badge tone="red">Your action</Badge></>}
          </div>
          <div className="text-sm whitespace-pre-wrap border-l-2 border-gray-200 pl-3 text-gray-800">{a.text}</div>
          {a.state === 'open' ? (
            <div className="space-y-2">
              <Field label="Note to the user (optional)">
                <TextInput value={notes[a.id] || ''} maxLength={1000} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
              </Field>
              <div className="flex gap-2">
                <RBtn small variant="success" disabled={busy === a.id} onClick={() => decide(a, 'overturned')}>Overturn (restore account)</RBtn>
                <RBtn small variant="danger" disabled={busy === a.id} onClick={() => decide(a, 'upheld')}>Uphold</RBtn>
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-500">Decided <Time ts={a.decided_at} /> by {a.decided_by_username || 'unknown'}{a.decision_note ? `: ${a.decision_note}` : ''}</div>
          )}
        </div>
      ))}
    </div>
  );
}
