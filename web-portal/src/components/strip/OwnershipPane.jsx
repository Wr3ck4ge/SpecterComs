import { useCallback, useEffect, useState } from 'react';
import { Crown } from 'lucide-react';
import { Alert, Button, Input } from '../ui';
import { cx } from '../ui/styles';
import { api } from '../../api';
import { PaneHeader, ToolRow } from './ServerTools';

// L13: server ownership. Owner: hand the server to a member (password +
// recipient acceptance, 7-day window). Recipient: accept / decline. Members:
// see an abandoned-server claim notice; the top admin may start one.
// The server enforces every rule (utils/ownershipTransfer.ts).

const errText = (error, fallback) => (typeof error === 'string' ? error : error?.message || fallback);
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString(); } catch { return ''; } };
const POLL_MS = 30_000;

/** Ownership state for one server; refetches on a slow poll and when `orgs` changes. */
export function useOwnership(orgId, refreshKey) {
  const [s, setS] = useState({ loading: true, data: null, error: null });
  const load = useCallback(async () => {
    if (!orgId) return;
    const { data, error } = await api.getOwnership(orgId);
    setS({ loading: false, data: error ? null : data, error: error ? errText(error, 'Could not load ownership') : null });
  }, [orgId]);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load, refreshKey]);
  return { ...s, reload: load };
}

/** Launcher row, owner only. */
export function OwnershipToolRow({ org, userId, onClick }) {
  if (!org || org.owner_id !== userId) return null;
  return (
    <ToolRow icon={<Crown size={16} aria-hidden="true" />} title="Transfer ownership"
      subtitle="Hand this server to another member" onClick={onClick} />
  );
}

/** Banner for incoming transfers and abandonment notices; renders nothing otherwise. */
export function OwnershipNotice({ org, userId, onChanged }) {
  const { data, reload } = useOwnership(org?.id, org?.owner_id);
  const [form, setForm] = useState(null); // 'accept' | 'claim'
  if (!org || !data) return null;
  const incoming = data.transfer && data.transfer.to_user_id === userId ? data.transfer : null;
  const notice = data.claim_notice;
  if (!incoming && !notice && !data.can_claim) return null;
  const done = () => { setForm(null); reload(); onChanged?.(); };
  return (
    <div className="mx-2 my-1 rounded-ui-row border border-specter-border bg-white/5 px-3 py-2 space-y-1">
      {incoming && (
        <>
          <p className="text-ui-sm text-specter-text-main">
            {incoming.from_callsign} wants to make you the owner of {org.callsign}. Expires {fmtDate(incoming.expires_at)}.
          </p>
          {form === 'accept'
            ? <PasswordForm label="Accept ownership" run={(b) => api.acceptOwnershipTransfer(org.id, b)} onDone={done} onCancel={() => setForm(null)} />
            : (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setForm('accept')}>Accept</Button>
                <Button size="sm" variant="ghost" onClick={async () => { await api.declineOwnershipTransfer(org.id); done(); }}>Decline</Button>
              </div>
            )}
        </>
      )}
      {notice && (
        <p role="status" className="text-ui-sm text-amber-300">
          This server looks abandoned. {notice.claimant_callsign} has claimed ownership; it takes effect on {fmtDate(notice.effective_at)}
          {' '}unless the owner signs in before then.
        </p>
      )}
      {data.can_claim && !notice && (
        form === 'claim'
          ? <PasswordForm label="Start 30-day claim" run={(b) => api.claimAbandonedServer(org.id, b)} onDone={done} onCancel={() => setForm(null)} />
          : (
            <>
              <p className="text-ui-sm text-specter-text-main">The owner of this server is inactive or gone. As its top admin you can claim it.</p>
              <Button size="sm" onClick={() => setForm('claim')}>Claim server</Button>
            </>
          )
      )}
    </div>
  );
}

/** L3: only needed when the account has two-factor on; the server says so if it's missing. */
function SecondFactorInput({ value, onChange }) {
  return (
    <Input label="Two-factor code (if you've turned it on)" value={value} autoComplete="one-time-code"
      inputMode="text" maxLength={32} placeholder="123456 or a recovery code"
      onChange={(e) => onChange(e.target.value)} />
  );
}

function PasswordForm({ label, run, onDone, onCancel }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [state, setState] = useState({ busy: false, error: null });
  const submit = async (e) => {
    e.preventDefault();
    setState({ busy: true, error: null });
    const { error } = await run({ password, ...(code.trim() ? { second_factor: code.trim() } : {}) });
    if (error) setState({ busy: false, error: errText(error, 'Could not complete that') });
    else onDone();
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Input label="Confirm your password" type="password" value={password} autoComplete="current-password"
        onChange={(e) => setPassword(e.target.value)} />
      <SecondFactorInput value={code} onChange={setCode} />
      {state.error && <Alert variant="error">{state.error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={state.busy || !password}>{state.busy ? 'Working...' : label}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** Owner-only pane: pick a member, confirm with password; shows/cancels a pending transfer. */
export function OwnershipPane({ org, userId, onBack, onChanged }) {
  const { data, loading, error, reload } = useOwnership(org.id, org.owner_id);
  const [members, setMembers] = useState([]);
  const [to, setTo] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [state, setState] = useState({ busy: false, error: null });

  useEffect(() => {
    let live = true;
    api.getMemberRoster(org.id).then(({ data: r }) => {
      if (live && r?.members) setMembers(r.members.filter((m) => m.user_id !== userId));
    });
    return () => { live = false; };
  }, [org.id, userId]);

  const start = async (e) => {
    e.preventDefault();
    setState({ busy: true, error: null });
    const { error: err } = await api.startOwnershipTransfer(org.id, { to_user_id: to, password, ...(code.trim() ? { second_factor: code.trim() } : {}) });
    if (err) setState({ busy: false, error: errText(err, 'Could not start the transfer') });
    else { setState({ busy: false, error: null }); setPassword(''); setCode(''); reload(); onChanged?.(); }
  };
  const cancel = async () => {
    const { error: err } = await api.cancelOwnershipTransfer(org.id);
    if (err) setState({ busy: false, error: errText(err, 'Could not cancel') });
    else { reload(); onChanged?.(); }
  };

  const pending = data?.transfer && data.transfer.from_user_id === userId ? data.transfer : null;
  return (
    <div>
      <PaneHeader title="Transfer ownership" onBack={onBack} />
      <div className="px-4 space-y-2">
        {loading && <p className="text-ui-xs text-specter-text-subtle">Loading...</p>}
        {error && <Alert variant="error">{error}</Alert>}
        {pending ? (
          <>
            <p className="text-ui-sm text-specter-text-main">
              Waiting for {pending.to_callsign} to accept. Expires {fmtDate(pending.expires_at)}.
            </p>
            <Button size="sm" variant="ghost" onClick={cancel}>Cancel transfer</Button>
          </>
        ) : (
          <form onSubmit={start} className="space-y-2">
            <p className="text-ui-xs text-specter-text-subtle">
              The new owner must accept within 7 days. You become the highest rank. The server wallet stays with the server.
            </p>
            <label className="block text-ui-xs text-specter-text-subtle">
              New owner
              <select value={to} onChange={(e) => setTo(e.target.value)}
                className={cx('mt-1 block h-8 w-full px-2 rounded-ui-row text-ui-sm text-specter-text-main bg-specter-bg-deep/60 border border-specter-border')}>
                <option value="">Choose a member</option>
                {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.callsign}</option>)}
              </select>
            </label>
            <Input label="Confirm your password" type="password" value={password} autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} />
            <SecondFactorInput value={code} onChange={setCode} />
            {state.error && <Alert variant="error">{state.error}</Alert>}
            <Button type="submit" size="sm" disabled={state.busy || !to || !password}>
              {state.busy ? 'Sending...' : 'Send transfer request'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
