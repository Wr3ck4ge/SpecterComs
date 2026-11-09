// NET: the engine's handlers for the Repair panel (net.diagnose, net.repair,
// net.submit — protocol notes in ./bridge.js). The strip drives the steps one
// at a time (connectionRepair.runRepairSteps) so it can show progress; the
// encryption resync step is the existing server.resyncEncryption command.
// Nothing here touches the MLS identity or message history.
import { api } from '../api';
import { CMD } from './bridge.js';
import { classifyDiagnosis, describeVia, formatReport, writeAltPref } from './connectionRepair.js';
import { getLastNetReport, runDiagnosis, setLastNetReport } from './netDiagnostics.js';
import { collectAndSubmitDiagnostics } from '../utils/diagnostics';
import { getClientVersion } from '../clientVersion';

const RECONNECT_WAIT_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The per-network alternate-port preference the diagnosis implies:
 * main port reached → forget it; main timed out but alt reached → set it.
 * Otherwise leave it alone. Exported for tests.
 */
export function applyAltPreference(diag, storage) {
  const reached = (r) => r?.result === 'open' || r?.result === 'rejected';
  if (reached(diag?.wt)) return writeAltPref(storage, { useAlt: false });
  if (diag?.wt?.result === 'timeout' && reached(diag?.wtAlt)) {
    return writeAltPref(storage, { useAlt: true, publicIp: diag?.netprobe?.clientIp || null });
  }
  return undefined;
}

/** Waits for a reconnect's outcome. getInfo() → CommLink's connectInfo. */
export async function waitForVoice(getInfo, timeoutMs = RECONNECT_WAIT_MS, poll = 500) {
  const deadline = Date.now() + timeoutMs;
  await sleep(Math.min(poll * 2, timeoutMs)); // let the teardown finish first
  for (;;) {
    const info = getInfo();
    if (info?.status === 'connected') return { ok: true, message: describeVia(info.via, info.port) || 'Connected' };
    if (info?.connectIssue?.kind === 'quic_blocked' || Date.now() >= deadline) {
      return { ok: false, message: info?.connectIssue?.message || "Voice still can't connect." };
    }
    await sleep(poll);
  }
}

export function createRepairHandlers({ user, orgs, orgId, inVoice, voiceActionsRef }) {
  const voice = () => voiceActionsRef.current;
  return {
    [CMD.NET_DIAGNOSE]: async () => {
      const clientVersion = await getClientVersion().catch(() => null);
      const info = voice()?.connectInfo || null;
      const diag = await runDiagnosis({
        api, userId: user?.id || null, orgs, orgId, clientVersion,
        voice: inVoice && info ? { status: info.status, via: info.via, port: info.port, transport: info.transport || null, connectIssue: info.connectIssue } : null,
      });
      const verdict = classifyDiagnosis(diag);
      applyAltPreference(diag, localStorage);
      setLastNetReport({ diag, verdict, steps: [], text: formatReport({ diag, verdict }) });
      return { diag, verdict };
    },
    [CMD.NET_REPAIR]: async ({ step }) => {
      if (step === 'keyPackage') {
        const state = getLastNetReport()?.diag?.mls?.keyPackage;
        if (state === 'present') return { ok: true, message: "This device's key is registered." };
        if (state === 'missing') {
          // TODO(M3b): needs a re-register helper in mlsSession.js; a restart
          // doesn't do it (only a fresh identity registers).
          return { ok: false, message: "This device's key isn't registered with the server. Submit diagnostics so the team can fix it." };
        }
        return { ok: true, skipped: true, message: "Couldn't check this device's key." };
      }
      if (step === 'voiceState') {
        if (!inVoice || !voice()?.resetConnectState) return { ok: true, skipped: true, message: 'Not in a voice channel.' };
        voice().resetConnectState();
        return { ok: true, message: 'Cleared retry state.' };
      }
      if (step === 'voiceReconnect') {
        if (!inVoice || !voice()?.reconnectNow) return { ok: true, skipped: true, message: 'Join a voice channel to test it.' };
        voice().reconnectNow();
        return waitForVoice(() => voice()?.connectInfo);
      }
      throw new Error(`Unknown repair step: ${step}`);
    },
    [CMD.NET_SUBMIT]: async ({ appVersion, report }) => {
      const last = getLastNetReport();
      setLastNetReport({ ...last, ...report });
      const { error } = await collectAndSubmitDiagnostics(appVersion || '');
      if (error) throw new Error(typeof error === 'string' ? error : 'Upload failed');
    },
  };
}
