import { api } from '../api';
import { prepareReportText, sealToPublicKey } from '@spectercoms/shared-web/src/sealedReport.js';
import { collectAndSubmitDiagnostics } from './diagnostics';

// D1: send a bug report from Settings → About & diagnostics. The text is
// cleaned and redacted here, then sealed to the owner's report key before it
// leaves this computer (packages/shared-web/src/sealedReport.js); the server
// stores only the sealed blob.
//
// → { id, redactions, diagnosticsError }   throws with a user-facing message

export async function sendBugReport({ category, text, attachDiagnostics = false, appVersion = '' }) {
  const { text: clean, redactions } = prepareReportText(text);
  if (!clean) throw new Error('Describe the problem first.');
  const send = async () => {
    const { data: key, error } = await api.getBugReportKey();
    if (error) return { error };
    const sealed = await sealToPublicKey(key, clean);
    return api.submitBugReport({
      category,
      appVersion: appVersion || null,
      keyId: key.keyId,
      sealed,
      descChars: Array.from(clean).length,
      redactions,
      diagnostics: Boolean(attachDiagnostics),
    });
  };
  let r = await send();
  // The owner replaced the key between our fetch and the send: once more.
  if (r.error && /key changed/i.test(r.error)) r = await send();
  if (r.error) throw new Error(r.error);

  let diagnosticsError = null;
  if (attachDiagnostics) {
    const d = await collectAndSubmitDiagnostics(appVersion);
    if (d?.error) diagnosticsError = typeof d.error === 'string' ? d.error : 'Upload failed';
  }
  return { id: r.data?.id ?? null, redactions, diagnosticsError };
}
