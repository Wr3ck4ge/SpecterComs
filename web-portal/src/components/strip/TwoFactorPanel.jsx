// L3: Settings -> Account -> "Two-factor authentication". Turn on (password
// -> add the key to an authenticator app -> confirm with its first code ->
// save the recovery codes, shown once), turn off (password + code), or make
// new recovery codes. Required for server owners once the server switch is on.
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { inputClass } from './stripOpsLayout';

const groupSecret = (s) => String(s || '').replace(/(.{4})/g, '$1 ').trim();

function copy(text) {
  try { navigator.clipboard?.writeText(text); } catch { /* clipboard unavailable */ }
}

const ENTE_AUTH_URL = 'https://ente.io/auth';
async function openEnte() {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(ENTE_AUTH_URL);
  } catch {
    window.open(ENTE_AUTH_URL, '_blank', 'noopener');
  }
}

function Field({ label, ...props }) {
  return (
    <input aria-label={label} placeholder={label} className={cx(inputClass, focusRing)} {...props} />
  );
}

function RecoveryCodes({ codes, onDone }) {
  return (
    <div className="space-y-2">
      <Alert variant="warning">
        Save these recovery codes somewhere safe. Each one signs you in once if you lose your authenticator.
        They are shown only now.
      </Alert>
      <pre className="rounded-ui-sm bg-black/30 p-2 font-mono text-ui-sm leading-relaxed select-all">{codes.join('\n')}</pre>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => copy(codes.join('\n'))}>Copy codes</Button>
        <Button size="sm" onClick={onDone}>I saved them</Button>
      </div>
    </div>
  );
}

export default function TwoFactorPanel({ api }) {
  const [status, setStatus] = useState(null); // { enabled, recovery_remaining, required, privileged }
  const [view, setView] = useState(null);     // null | 'enroll' | 'scan' | 'codes' | 'disable' | 'regen'
  const [form, setForm] = useState({ password: '', code: '', useRecovery: false });
  const [enroll, setEnroll] = useState(null); // { secret, otpauth_uri }
  const [codes, setCodes] = useState(null);
  const [state, setState] = useState({ busy: false, error: null, message: null });

  const load = useCallback(async () => {
    const { data } = await api.twoFactorStatus();
    if (data) setStatus(data);
  }, [api]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const go = (v) => { setView(v); setForm({ password: '', code: '', useRecovery: false }); setState({ busy: false, error: null, message: null }); };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const run = async (fn) => {
    setState({ busy: true, error: null, message: null });
    try { return await fn(); } finally { setState((s) => ({ ...s, busy: false })); }
  };

  const startEnroll = () => run(async () => {
    const { data, error } = await api.twoFactorEnroll(form.password);
    if (error) return setState({ busy: false, error, message: null });
    setEnroll(data);
    go('scan');
  });
  const confirm = () => run(async () => {
    const { data, error } = await api.twoFactorConfirm(form.code.trim());
    if (error) return setState({ busy: false, error, message: null });
    setEnroll(null);
    setCodes(data.recovery_codes);
    go('codes');
    load();
  });
  const disable = () => run(async () => {
    const second = form.useRecovery ? { recovery_code: form.code.trim() } : { code: form.code.trim() };
    const { error } = await api.twoFactorDisable({ password: form.password, ...second });
    if (error) return setState({ busy: false, error, message: null });
    go(null);
    setState({ busy: false, error: null, message: 'Two-factor authentication is off.' });
    load();
  });
  const regen = () => run(async () => {
    const { data, error } = await api.twoFactorRecoveryCodes({ password: form.password, code: form.code.trim() });
    if (error) return setState({ busy: false, error, message: null });
    setCodes(data.recovery_codes);
    go('codes');
    load();
  });

  if (!status) return <p className="text-ui-sm text-specter-text-subtle">Loading…</p>;
  const { busy } = state;
  const back = <Button size="sm" variant="ghost" disabled={busy} onClick={() => { go(null); setEnroll(null); }}>Back</Button>;

  return (
    <div className="space-y-2.5">
      {view === 'codes' && codes ? (
        <RecoveryCodes codes={codes} onDone={() => { setCodes(null); go(null); }} />
      ) : view === 'enroll' ? (
        <div className="space-y-2">
          <p className="text-ui-sm text-specter-text-muted">Confirm your password to start.</p>
          <Field label="Your password" type="password" autoComplete="current-password" value={form.password} onChange={set('password')} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !form.password} onClick={startEnroll}>{busy ? 'Checking…' : 'Continue'}</Button>
            {back}
          </div>
        </div>
      ) : view === 'scan' && enroll ? (
        <div className="space-y-2">
          <p className="text-ui-sm text-specter-text-muted">
            Add this setup key to an authenticator app. We recommend{' '}
            <button type="button" className={cx('text-specter-primary-neon hover:underline', focusRing)} onClick={openEnte}>Ente Auth</button>
            {' '}(free, open source, encrypted backup) — any authenticator app works.
          </p>
          <div className="rounded-ui-sm bg-black/30 p-2 font-mono text-ui-sm break-all select-all">{groupSecret(enroll.secret)}</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => copy(enroll.secret)}>Copy key</Button>
            <Button size="sm" variant="secondary" onClick={() => copy(enroll.otpauth_uri)}>Copy setup link</Button>
          </div>
          <p className="text-ui-xs text-specter-text-subtle">Time-based, 6 digits, every 30 seconds.</p>
          <Field label="6-digit code from the app" inputMode="numeric" autoComplete="one-time-code" maxLength={7}
            value={form.code} onChange={set('code')} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !form.code.trim()} onClick={confirm}>{busy ? 'Checking…' : 'Turn on'}</Button>
            {back}
          </div>
        </div>
      ) : view === 'disable' || view === 'regen' ? (
        <div className="space-y-2">
          <Field label="Your password" type="password" autoComplete="current-password" value={form.password} onChange={set('password')} />
          <Field label={form.useRecovery ? 'Recovery code' : '6-digit code from your app'} autoComplete="one-time-code"
            inputMode={form.useRecovery ? 'text' : 'numeric'} value={form.code} onChange={set('code')} />
          {view === 'disable' && (
            <button type="button" className={cx('text-ui-xs text-specter-primary-neon hover:underline', focusRing)}
              onClick={() => setForm((f) => ({ ...f, code: '', useRecovery: !f.useRecovery }))}>
              {form.useRecovery ? 'Use an authenticator code' : 'Lost your app? Use a recovery code'}
            </button>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant={view === 'disable' ? 'danger' : undefined} disabled={busy || !form.password || !form.code.trim()}
              onClick={view === 'disable' ? disable : regen}>
              {busy ? 'Checking…' : view === 'disable' ? 'Turn off' : 'Make new codes'}
            </Button>
            {back}
          </div>
        </div>
      ) : (
        <>
          <p className="text-ui-sm text-specter-text-muted">
            {status.enabled
              ? `On. Signing in asks for a code from your authenticator app. ${status.recovery_remaining} recovery code${status.recovery_remaining === 1 ? '' : 's'} left.`
              : 'Off. Turn it on so signing in also needs a code from an authenticator app on your phone.'}
          </p>
          {!status.enabled && status.privileged && (
            <Alert variant={status.required ? 'error' : 'warning'}>
              {status.required
                ? 'You own a server: server settings, ranks and billing need two-factor authentication. Turn it on to use them.'
                : 'You own a server. Two-factor authentication will soon be required for server owners.'}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            {status.enabled ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => go('regen')}>New recovery codes</Button>
                <Button size="sm" variant="danger" onClick={() => go('disable')}>Turn off…</Button>
              </>
            ) : (
              <Button size="sm" onClick={() => go('enroll')}>Turn on</Button>
            )}
          </div>
        </>
      )}
      {state.error && <Alert variant="error">{state.error}</Alert>}
      {state.message && <Alert variant="success">{state.message}</Alert>}
    </div>
  );
}
