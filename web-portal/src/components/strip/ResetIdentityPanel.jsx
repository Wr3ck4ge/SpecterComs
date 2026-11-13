// S5: Settings → About & diagnostics → Encryption → "Reset encryption
// identity…". The last-resort repair for a device whose MLS state is broken:
// this PC becomes a brand-new encryption device for the account (engine:
// mlsSession.resetEncryptionIdentity via the settings bridge), then the engine
// reloads. Inline confirm (type RESET) — no native dialogs, they steal focus
// from the strip. Leaves voice first so nothing is captured mid-reload.
import { useReducer } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Alert, Button } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { inputClass } from './stripOpsLayout';
import { CMD } from '../../engine/bridge';
import {
  RESET_CONFIRM_WORD, RESET_PANEL_INITIAL, isResetConfirmed, resetPanelReducer, runResetSteps,
} from '../../utils/resetIdentity';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** settings: useSettings() result. engine: useEngine() result (voice state + leave). */
export default function ResetIdentityPanel({ settings, engine }) {
  const [state, dispatch] = useReducer(resetPanelReducer, RESET_PANEL_INITIAL);
  const available = Boolean(settings?.resetMlsIdentity) && engine?.connected !== false;
  const inVoice = Boolean(engine?.state?.voice?.channelId);

  const start = async () => {
    if (!isResetConfirmed(state.text)) return;
    dispatch({ type: 'start' });
    try {
      const { results } = await runResetSteps([
        {
          id: 'leaveVoice', label: 'Leave voice',
          run: async () => {
            if (!inVoice || !engine?.send) return;
            await engine.send(CMD.VOICE_LEAVE, {});
            await sleep(500); // let native capture/transport stop before the engine reloads
          },
        },
        { id: 'reset', label: 'Reset encryption identity', run: () => settings.resetMlsIdentity() },
      ]);
      dispatch({ type: 'succeeded', result: results.reset });
    } catch (err) {
      dispatch({ type: 'failed', error: err.message });
    }
  };

  if (state.phase === 'idle') {
    return (
      <div className="space-y-1.5">
        <p className="text-ui-sm text-specter-text-muted">
          Still can&apos;t read messages after Resync encryption? As a last resort, start over as a new encryption device.
        </p>
        <Button size="sm" variant="danger" disabled={!available} onClick={() => dispatch({ type: 'open' })}
          icon={<AlertTriangle size={14} />}>
          Reset encryption identity…
        </Button>
      </div>
    );
  }

  const running = state.phase === 'running';
  const r = state.result;
  const shortId = r?.newLabel ? r.newLabel.slice(r.newLabel.lastIndexOf(':') + 1).slice(0, 8) : '';
  return (
    <div className="space-y-2 rounded border border-specter-state-error/40 bg-specter-state-error/5 p-2.5">
      <p className="text-ui-sm font-semibold text-red-300">Reset encryption identity</p>
      <ul className="list-disc space-y-1 pl-4 text-ui-xs text-specter-text-muted">
        <li>Last resort: only use this if Resync encryption didn&apos;t fix it.</li>
        <li>This PC drops every encryption key it holds and rejoins every channel and DM as a new device.</li>
        <li>
          Keys come back channel by channel: a channel shows &ldquo;Waiting for channel key&rdquo; until another member
          opens it.
        </li>
        <li>
          Messages already shown on this PC stay readable (they&apos;re stored decrypted here). Messages this PC
          hasn&apos;t decrypted yet, including anything sent before it&apos;s re-added, can&apos;t be read on this PC
          anymore. Your other devices aren&apos;t affected.
        </li>
        {inVoice && <li>You&apos;ll leave voice first. SpecterComs then restarts in the background.</li>}
        {!inVoice && <li>SpecterComs restarts in the background afterwards.</li>}
      </ul>
      {(state.phase === 'confirm' || running) && (
        <>
          <input
            aria-label={`Type ${RESET_CONFIRM_WORD} to confirm`}
            className={cx(inputClass, focusRing)}
            value={state.text}
            disabled={running}
            placeholder={`Type ${RESET_CONFIRM_WORD} to confirm`}
            onChange={(e) => dispatch({ type: 'type', text: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') start(); if (e.key === 'Escape') dispatch({ type: 'cancel' }); }}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="danger" disabled={running || !isResetConfirmed(state.text)} onClick={start}
              icon={running ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}>
              {running ? 'Resetting…' : 'Reset this device'}
            </Button>
            <Button size="sm" variant="secondary" disabled={running} onClick={() => dispatch({ type: 'cancel' })}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {state.phase === 'done' && (
        <Alert variant="success">
          Done. This PC is now a new encryption device{shortId ? ` (${shortId}…)` : ''}.
          SpecterComs is restarting; keys arrive as other members open each channel.
          {r && !r.registered && ' It couldn\'t register with the server just now; it will try again on the next start.'}
        </Alert>
      )}
      {state.phase === 'error' && (
        <>
          <Alert variant="error">Reset failed: {state.error}</Alert>
          <Button size="sm" variant="secondary" onClick={() => dispatch({ type: 'cancel' })}>Close</Button>
        </>
      )}
    </div>
  );
}
