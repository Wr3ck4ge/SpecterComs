// L3: the signed-in admin's own two-factor authentication (System section).
// Turn on: password -> setup key into an authenticator app -> first code ->
// recovery codes (shown once). Turn off / new codes: password + code.
import React, { useCallback, useEffect, useState } from 'react';
import { RBtn, Alert, Field, TextInput, Badge } from './ui';

const groupSecret = (s) => String(s || '').replace(/(.{4})/g, '$1 ').trim();
const copy = (text) => { try { navigator.clipboard?.writeText(text); } catch { /* unavailable */ } };

export default function TwoFactorSection({ adminApi, onChanged }) {
  const [status, setStatus] = useState(null);
  const [view, setView] = useState(null); // null | 'enroll' | 'scan' | 'codes' | 'disable' | 'regen'
  const [form, setForm] = useState({ password: '', code: '', useRecovery: false });
  const [enroll, setEnroll] = useState(null);
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    const { data } = await adminApi.twoFactorStatus();
    if (data) setStatus(data);
  }, [adminApi]);
  useEffect(() => { load(); }, [load]);

  const go = (v) => { setView(v); setForm({ password: '', code: '', useRecovery: false }); setErr(null); setMsg(null); };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const run = async (fn) => { setBusy(true); setErr(null); try { await fn(); } finally { setBusy(false); } };
  const refresh = () => { load(); onChanged?.(); };

  const startEnroll = () => run(async () => {
    const { data, error } = await adminApi.twoFactorEnroll(form.password);
    if (error) return setErr(error);
    setEnroll(data); go('scan');
  });
  const confirm = () => run(async () => {
    const { data, error } = await adminApi.twoFactorConfirm(form.code.trim());
    if (error) return setErr(error);
    setEnroll(null); setCodes(data.recovery_codes); go('codes'); refresh();
  });
  const disable = () => run(async () => {
    const second = form.useRecovery ? { recovery_code: form.code.trim() } : { code: form.code.trim() };
    const { error } = await adminApi.twoFactorDisable({ password: form.password, ...second });
    if (error) return setErr(error);
    go(null); setMsg('Two-factor authentication is off.'); refresh();
  });
  const regen = () => run(async () => {
    const { data, error } = await adminApi.twoFactorRecoveryCodes({ password: form.password, code: form.code.trim() });
    if (error) return setErr(error);
    setCodes(data.recovery_codes); go('codes'); refresh();
  });

  const back = <RBtn variant="ghost" onClick={() => { go(null); setEnroll(null); }} disabled={busy}>Back</RBtn>;

  return (
    <div className="border border-gray-200 bg-white rounded-lg shadow-sm p-6 space-y-3 text-sm text-gray-600">
      <div className="text-sm font-semibold text-gray-700 border-b border-gray-200 pb-3 flex items-center gap-2">
        Two-factor authentication
        {status && <Badge tone={status.enabled ? 'green' : status.required ? 'red' : 'gray'}>{status.enabled ? 'on' : 'off'}</Badge>}
      </div>
      {!status ? <div className="text-gray-400">Loading…</div> : view === 'codes' && codes ? (
        <div className="space-y-2">
          <Alert type="warn">Save these recovery codes somewhere safe. Each signs you in once if you lose your authenticator. They are shown only now.</Alert>
          <pre className="bg-gray-50 border border-gray-200 rounded p-3 font-mono text-sm select-all">{codes.join('\n')}</pre>
          <div className="flex gap-2">
            <RBtn onClick={() => copy(codes.join('\n'))}>Copy codes</RBtn>
            <RBtn variant="primary" onClick={() => { setCodes(null); go(null); }}>I saved them</RBtn>
          </div>
        </div>
      ) : view === 'enroll' ? (
        <div className="space-y-3 max-w-sm">
          <Field label="Admin password">
            <TextInput type="password" autoFocus autoComplete="current-password" value={form.password} onChange={set('password')} />
          </Field>
          <div className="flex gap-2"><RBtn variant="primary" onClick={startEnroll} disabled={busy || !form.password}>{busy ? 'Checking…' : 'Continue'}</RBtn>{back}</div>
        </div>
      ) : view === 'scan' && enroll ? (
        <div className="space-y-3 max-w-md">
          <div>Add this setup key to an authenticator app. We recommend <a className="underline" href="https://ente.io/auth" target="_blank" rel="noopener noreferrer">Ente Auth</a> (free, open source, encrypted backup) — any authenticator app works.</div>
          <div className="bg-gray-50 border border-gray-200 rounded p-3 font-mono break-all select-all">{groupSecret(enroll.secret)}</div>
          <div className="flex gap-2">
            <RBtn onClick={() => copy(enroll.secret)}>Copy key</RBtn>
            <RBtn onClick={() => copy(enroll.otpauth_uri)}>Copy setup link</RBtn>
          </div>
          <Field label="6-digit code from the app">
            <TextInput inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={form.code} onChange={set('code')} />
          </Field>
          <div className="flex gap-2"><RBtn variant="primary" onClick={confirm} disabled={busy || !form.code.trim()}>{busy ? 'Checking…' : 'Turn on'}</RBtn>{back}</div>
        </div>
      ) : view === 'disable' || view === 'regen' ? (
        <div className="space-y-3 max-w-sm">
          <Field label="Admin password">
            <TextInput type="password" autoFocus autoComplete="current-password" value={form.password} onChange={set('password')} />
          </Field>
          <Field label={form.useRecovery ? 'Recovery code' : '6-digit code from your app'}>
            <TextInput autoComplete="one-time-code" value={form.code} onChange={set('code')} />
          </Field>
          {view === 'disable' && (
            <button type="button" className="text-xs underline text-gray-500" onClick={() => setForm((f) => ({ ...f, code: '', useRecovery: !f.useRecovery }))}>
              {form.useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
            </button>
          )}
          <div className="flex gap-2">
            <RBtn variant={view === 'disable' ? 'danger' : 'primary'} onClick={view === 'disable' ? disable : regen}
              disabled={busy || !form.password || !form.code.trim()}>
              {busy ? 'Checking…' : view === 'disable' ? 'Turn off' : 'Make new codes'}
            </RBtn>
            {back}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            {status.enabled
              ? `On. Sign-in and password re-entry also ask for a code. ${status.recovery_remaining} recovery code${status.recovery_remaining === 1 ? '' : 's'} left.`
              : status.required
                ? 'Required: admin pages stay locked until you turn it on.'
                : 'Off. Turn it on so signing in also needs a code from an authenticator app.'}
          </div>
          <div className="flex gap-2">
            {status.enabled ? (
              <>
                <RBtn onClick={() => go('regen')}>New recovery codes</RBtn>
                <RBtn variant="danger" onClick={() => go('disable')}>Turn off…</RBtn>
              </>
            ) : <RBtn variant="primary" onClick={() => go('enroll')}>Turn on</RBtn>}
          </div>
        </div>
      )}
      {err && <Alert>{err}</Alert>}
      {msg && <Alert type="success">{msg}</Alert>}
    </div>
  );
}
