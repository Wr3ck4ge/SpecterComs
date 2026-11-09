// NET: Settings → About & diagnostics → Repair connection. "Check connection" runs the diagnosis;
// "Repair" runs every step in order with a live progress list. Steps run one
// engine command at a time, so a closed strip just stops at the next step.
// The strip never touches MLS: resync is the engine's server.resyncEncryption,
// and nothing here deletes the encryption identity or message history.
import { useCallback, useState } from 'react';
import { Check, Copy, Loader2, Minus, Stethoscope, Upload, Wrench, X } from 'lucide-react';
import { Alert, Button } from '../ui';
import { CMD, NET_COMMAND_TIMEOUT_MS, RESYNC_COMMAND_TIMEOUT_MS } from '../../engine/bridge';
import { describeVia, formatReport, runRepairSteps } from '../../engine/connectionRepair';

const SEVERITY = { ok: 'success', warn: 'warning', error: 'error' };

function StepRow({ step }) {
  const icon = {
    pending: <span className="block h-3.5 w-3.5" />,
    running: <Loader2 size={14} className="animate-spin text-specter-primary-neon" aria-label="Running" />,
    ok: <Check size={14} className="text-emerald-300" aria-label="Done" />,
    fail: <X size={14} className="text-red-300" aria-label="Failed" />,
    skipped: <Minus size={14} className="text-specter-text-subtle" aria-label="Skipped" />,
  }[step.status];
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block text-ui-sm text-specter-text-main">{step.label}</span>
        {step.message && <span className="block text-ui-xs text-specter-text-subtle">{step.message}</span>}
      </span>
    </li>
  );
}

/** engine: useEngine() result. appVersion: for the report. */
export default function RepairPanel({ engine, appVersion }) {
  const [result, setResult] = useState(null); // { diag, verdict }
  const [steps, setSteps] = useState([]);
  const [busy, setBusy] = useState(null); // 'check' | 'repair' | 'submit'
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const send = engine?.send;
  const voice = engine?.state?.voice;
  const orgId = engine?.state?.org?.id || null;
  const ready = Boolean(engine?.connected && send);

  const diagnose = useCallback(async () => {
    const r = await send(CMD.NET_DIAGNOSE, {}, { timeoutMs: NET_COMMAND_TIMEOUT_MS, timeoutMessage: 'The check took too long.' });
    setResult(r);
    return r;
  }, [send]);

  const check = async () => {
    setBusy('check'); setError(null); setNotice(null); setSteps([]);
    try { await diagnose(); } catch (err) { setError(err.message); }
    setBusy(null);
  };

  const repair = async () => {
    setBusy('repair'); setError(null); setNotice(null);
    const repairStep = (step) => () => send(CMD.NET_REPAIR, { step }, { timeoutMs: NET_COMMAND_TIMEOUT_MS });
    await runRepairSteps([
      {
        id: 'diagnose', label: 'Check the connection',
        run: async () => {
          const r = await diagnose();
          return { ok: r.verdict.severity !== 'error', message: r.verdict.title };
        },
      },
      {
        id: 'resync', label: 'Re-sync encryption for this server',
        run: async () => {
          if (!orgId) return { ok: true, skipped: true, message: 'No server selected.' };
          const r = await send(CMD.SERVER_RESYNC_ENCRYPTION, { orgId }, { timeoutMs: RESYNC_COMMAND_TIMEOUT_MS, timeoutMessage: 'Still re-syncing in the background.' });
          return { ok: r?.ok !== false, message: r?.message || 'Encryption re-synced' };
        },
      },
      { id: 'keyPackage', label: "Check this device's key", run: repairStep('keyPackage') },
      { id: 'voiceState', label: 'Clear stale voice state', run: repairStep('voiceState') },
      { id: 'voiceReconnect', label: 'Reconnect voice', run: repairStep('voiceReconnect') },
    ], setSteps);
    setBusy(null);
  };

  const reportText = () => formatReport({ diag: result?.diag || {}, verdict: result?.verdict || null, steps, appVersion });

  const copy = async () => {
    try { await navigator.clipboard.writeText(reportText()); setNotice('Report copied.'); } catch { setError("Couldn't copy the report."); }
  };

  const submit = async () => {
    setBusy('submit'); setError(null); setNotice(null);
    try {
      await send(CMD.NET_SUBMIT, { appVersion, report: { steps, text: reportText() } }, { timeoutMs: NET_COMMAND_TIMEOUT_MS });
      setNotice('Diagnostics sent. Thanks!');
    } catch (err) { setError(`Couldn't send diagnostics: ${err.message}`); }
    setBusy(null);
  };

  const v = result?.verdict;
  return (
    <div className="space-y-4">
      <p className="text-ui-sm text-specter-text-muted">
        Checks why voice can&apos;t connect and fixes what it can. Your messages and encryption keys stay as they are.
      </p>
      {voice?.connectIssue && !v && <Alert variant="warning" title="Voice can't connect">{voice.connectIssue.message}</Alert>}
      {voice?.status === 'connected' && voice.via && <p className="text-ui-xs text-emerald-300">{describeVia(voice.via, voice.viaPort)}</p>}
      {!ready && <Alert variant="warning">SpecterComs is still starting. Try again in a moment.</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Wrench size={14} />} disabled={!ready || Boolean(busy)} onClick={repair}>
          {busy === 'repair' ? 'Repairing…' : 'Repair'}
        </Button>
        <Button size="sm" variant="secondary" icon={<Stethoscope size={14} />} disabled={!ready || Boolean(busy)} onClick={check}>
          {busy === 'check' ? 'Checking…' : 'Check only'}
        </Button>
      </div>
      {steps.length > 0 && <ul className="space-y-1.5" aria-label="Repair steps" aria-live="polite">{steps.map((s) => <StepRow key={s.id} step={s} />)}</ul>}
      {v && (
        <Alert variant={SEVERITY[v.severity] || 'info'} title={v.title}>
          <p>{v.explanation}</p>
          {v.steps?.length > 0 && <ol className="mt-2 list-decimal space-y-1 pl-4">{v.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}
      {notice && <Alert variant="success">{notice}</Alert>}
      {result && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={<Copy size={14} />} onClick={copy}>Copy report</Button>
          <Button size="sm" variant="secondary" icon={<Upload size={14} />} disabled={Boolean(busy)} onClick={submit}>
            {busy === 'submit' ? 'Sending…' : 'Submit diagnostics'}
          </Button>
        </div>
      )}
    </div>
  );
}
