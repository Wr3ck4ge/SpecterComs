// L6: Settings -> Account -> "Your data". Ask for a copy of your data or for
// your account to be deleted. Nothing is automatic: the request goes to a
// human admin (password re-entered to ask). Deletion: processed within 30 days,
// sign-in keeps working until then, and it can be cancelled while open.
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { inputClass } from './stripOpsLayout';

export const DELETE_CONFIRM_WORD = 'DELETE';
export const isDeleteConfirmed = (text) => String(text || '').trim() === DELETE_CONFIRM_WORD;

const fmt = (iso) => { try { return new Date(iso).toLocaleDateString(); } catch { return ''; } };

function statusLine(r) {
  const what = r.type === 'delete' ? 'Account deletion' : 'Data export';
  if (r.status === 'open') return `${what}: requested ${fmt(r.created_at)}, to be handled by ${fmt(r.due_by)}.`;
  if (r.status === 'done') return `${what}: completed ${fmt(r.resolved_at)}.`;
  return `${what}: cancelled ${fmt(r.resolved_at)}.`;
}

export default function DataRequestsPanel({ api }) {
  const [requests, setRequests] = useState(null);
  const [form, setForm] = useState(null); // { type, password, confirm }
  const [state, setState] = useState({ busy: false, error: null, message: null });

  const load = useCallback(async () => {
    const { data } = await api.listDataRequests();
    if (data?.requests) setRequests(data.requests);
  }, [api]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const open = (type) => (requests || []).find((r) => r.type === type && r.status === 'open');
  const recent = (requests || []).filter((r) => r.status !== 'open').slice(0, 2);

  const submit = async () => {
    setState({ busy: true, error: null, message: null });
    const { error, code } = await api.createDataRequest(form.type, form.password, form.code?.trim() || undefined);
    // L3: 2FA on -> the server asks for a code; show the field and let them retry.
    if (code === 'TWO_FACTOR_CODE_REQUIRED') { setForm((f) => ({ ...f, needCode: true })); setState({ busy: false, error, message: null }); return; }
    if (error) { setState({ busy: false, error, message: null }); return; }
    setForm(null);
    setState({ busy: false, error: null, message: 'Request sent. You will see its status here.' });
    load();
  };
  const cancel = async (r) => {
    setState({ busy: true, error: null, message: null });
    const { error } = await api.cancelDataRequest(r.id);
    setState({ busy: false, error: error || null, message: error ? null : 'Deletion request cancelled.' });
    load();
  };

  const exportOpen = open('export');
  const deleteOpen = open('delete');
  const canSubmit = form && form.password && (form.type === 'export' || isDeleteConfirmed(form.confirm)) && !state.busy;

  return (
    <div className="space-y-2.5">
      <p className="text-ui-sm text-specter-text-muted">
        Ask for a copy of the data we hold about you, or for your account to be deleted. A person at SpecterComs handles each
        request, within 30 days. Message and voice content is end-to-end encrypted and is not stored readably by us.
      </p>
      {(requests || []).filter((r) => r.status === 'open').map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2">
          <span className="text-ui-sm">{statusLine(r)}</span>
          {r.type === 'delete' && <Button size="sm" variant="secondary" disabled={state.busy} onClick={() => cancel(r)}>Cancel request</Button>}
        </div>
      ))}
      {recent.map((r) => <p key={r.id} className="text-ui-xs text-specter-text-subtle">{statusLine(r)}</p>)}

      {!form && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={Boolean(exportOpen)}
            onClick={() => { setState({ busy: false, error: null, message: null }); setForm({ type: 'export', password: '', confirm: '' }); }}>
            Request my data
          </Button>
          <Button size="sm" variant="danger" disabled={Boolean(deleteOpen)}
            onClick={() => { setState({ busy: false, error: null, message: null }); setForm({ type: 'delete', password: '', confirm: '' }); }}>
            Delete my account…
          </Button>
        </div>
      )}

      {form && (
        <div className="space-y-2">
          {form.type === 'delete' && (
            <Alert variant="warning">
              Deleting your account erases your profile and removes you from your servers. A person processes it within 30 days.
              You can still sign in until then, and you can cancel here any time before it is processed. Once processed it cannot be undone.
            </Alert>
          )}
          <input type="password" autoComplete="current-password" aria-label="Your password" placeholder="Your password"
            className={cx(inputClass, focusRing)} value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
          {form.needCode && (
            <input type="text" inputMode="numeric" autoComplete="one-time-code" aria-label="Authenticator code" placeholder="6-digit code from your authenticator app"
              className={cx(inputClass, focusRing)} value={form.code || ''}
              onChange={(e) => setForm({ ...form, code: e.target.value })} />
          )}
          {form.type === 'delete' && (
            <input type="text" aria-label={`Type ${DELETE_CONFIRM_WORD} to confirm`} placeholder={`Type ${DELETE_CONFIRM_WORD} to confirm`}
              className={cx(inputClass, focusRing)} value={form.confirm}
              onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
          )}
          <div className="flex gap-2">
            <Button size="sm" variant={form.type === 'delete' ? 'danger' : undefined} disabled={!canSubmit} onClick={submit}>
              {state.busy ? 'Sending…' : form.type === 'delete' ? 'Request deletion' : 'Send request'}
            </Button>
            <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => { setForm(null); setState({ busy: false, error: null, message: null }); }}>Back</Button>
          </div>
        </div>
      )}
      {state.error && <Alert variant="error">{state.error}</Alert>}
      {state.message && <Alert variant="success">{state.message}</Alert>}
    </div>
  );
}
