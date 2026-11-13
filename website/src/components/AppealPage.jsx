import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE_URL } from '../api.js';

// L12: public ban-appeal page (/appeal). A suspended account has no session, so
// the user proves who they are with callsign/email + password on each call; the
// server reveals nothing before that. Uses plain fetch on purpose: the shared
// api client's 401 handling would touch the (absent) user session.

async function post(path, body) {
  try {
    const r = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { data } : { error: data.message || 'Something went wrong. Try again later.', code: data.code, status: r.status };
  } catch {
    return { error: 'Could not reach the server. Try again later.' };
  }
}

const fmt = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '');
const inputCls = 'w-full rounded border border-specter-primary-dim bg-specter-bg-deep px-3 py-2 text-sm text-specter-text-primary font-mono';
const btnCls = 'rounded bg-specter-primary-cyan px-4 py-2 text-sm font-mono font-bold uppercase tracking-wider text-black disabled:opacity-50';

export default function AppealPage() {
  const [who, setWho] = useState('');
  const [password, setPassword] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null); // response of /auth/appeal/status
  const [filed, setFiled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const creds = () => (who.includes('@') ? { email: who.trim(), password } : { callsign: who.trim(), password });

  const check = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await post('/auth/appeal/status', creds());
    setBusy(false);
    if (r.error) return setError(r.error);
    setStatus(r.data);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await post('/auth/appeal', { ...creds(), text });
    setBusy(false);
    if (r.error) return setError(r.error);
    setFiled(true);
    setStatus({ ...status, can_appeal: false, appeal: r.data.appeal });
  };

  const ap = status?.appeal;
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-specter-bg-deep">
      <div className="max-w-lg w-full rounded-2xl border border-specter-primary-dim p-6 space-y-4 bg-specter-bg-surface text-specter-text-primary">
        <div className="text-center text-specter-primary-cyan font-mono text-sm font-bold tracking-[0.3em]">SPECTERCOMS</div>
        <div className="text-center text-xs font-mono uppercase tracking-[0.25em] text-specter-text-muted">Appeal an account suspension</div>

        <div className="text-sm text-specter-text-muted space-y-2">
          <p>If Specter suspended or banned your account, you can ask for a review here.</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>One appeal per action, filed within 30 days of it.</li>
            <li>We answer within 14 days, and where possible a different reviewer than the one who acted decides.</li>
            <li>Some bans cannot be appealed.</li>
            <li>This is for actions by Specter on your account. A server kicking or banning you is that server&apos;s own decision; contact its owner.</li>
            <li>Your appeal text is deleted 30 days after we decide.</li>
          </ul>
        </div>

        {!status && (
          <form onSubmit={check} className="space-y-3">
            <input className={inputCls} placeholder="Callsign or email" value={who} onChange={(e) => setWho(e.target.value)} required autoComplete="username" />
            <input className={inputCls} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            {error && <div className="text-sm text-specter-state-error" role="alert">{error}</div>}
            <button className={btnCls} disabled={busy}>{busy ? 'Checking...' : 'Continue'}</button>
          </form>
        )}

        {status && (
          <div className="space-y-3">
            {status.action && (
              <div className="text-sm">
                Action on <strong>{status.callsign}</strong> taken {fmt(status.action.at)}.
                {status.action.reason && <> Reason given: <em>{status.action.reason}</em></>}
              </div>
            )}
            {ap && (
              <div className="rounded border border-specter-primary-dim p-3 text-sm space-y-1">
                <div className="font-mono uppercase tracking-wider text-xs text-specter-primary-cyan">
                  {ap.state === 'open' ? `Appeal received ${fmt(ap.created_at)}` : ap.state === 'overturned' ? 'Appeal successful' : 'Appeal reviewed: the action stands'}
                </div>
                {ap.state === 'open' && <div>We will answer by {fmt(ap.due_by)}. Come back to this page to see the decision.</div>}
                {ap.state === 'overturned' && <div>Your account has been restored. You can sign in again.</div>}
                {ap.decision_note && <div>Note from the reviewer: {ap.decision_note}</div>}
              </div>
            )}
            {!status.can_appeal && !ap && status.message && <div className="text-sm">{status.message}</div>}
            {status.can_appeal && (
              <form onSubmit={submit} className="space-y-3">
                <textarea className={`${inputCls} h-40`} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
                  placeholder="Tell us why this action should be reviewed. Do not include passwords or other secrets." required />
                <div className="text-xs text-specter-text-muted">{text.length} / 2000</div>
                {error && <div className="text-sm text-specter-state-error" role="alert">{error}</div>}
                <button className={btnCls} disabled={busy || text.trim().length < 10}>{busy ? 'Sending...' : 'Submit appeal'}</button>
              </form>
            )}
            {filed && <div className="text-sm text-specter-state-success">Your appeal was submitted.</div>}
          </div>
        )}

        <div className="text-center"><Link to="/" className="text-xs font-mono uppercase tracking-wider text-specter-text-muted hover:text-specter-primary-cyan">Back</Link></div>
      </div>
    </div>
  );
}
