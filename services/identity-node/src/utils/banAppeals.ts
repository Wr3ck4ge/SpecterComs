// L12: pure rules for platform ban appeals.

export const APPEAL_WINDOW_DAYS = 30;
export const APPEAL_ANSWER_DAYS = 14;
export const APPEAL_RETENTION_DAYS = 30; // after the decision
export const APPEAL_TEXT_MAX = 2000;
export const APPEAL_NOTE_MAX = 1000;

const DAY = 24 * 60 * 60 * 1000;

export function validateAppealText(v: unknown): { ok: true; text: string } | { ok: false; message: string } {
  if (typeof v !== 'string') return { ok: false, message: 'Tell us why the action should be reviewed.' };
  const raw = v.trim();
  if (raw.length > APPEAL_TEXT_MAX) return { ok: false, message: `Keep it under ${APPEAL_TEXT_MAX} characters.` };
  const text = redactSecrets(raw);
  if (text.length < 10) return { ok: false, message: 'Please write at least a sentence.' };
  if (text.length > APPEAL_TEXT_MAX) return { ok: false, message: `Keep it under ${APPEAL_TEXT_MAX} characters.` };
  return { ok: true, text };
}

/** Masks things that look like credentials; the text is the user's own words, nothing else is altered. */
export function redactSecrets(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted token]')
    .replace(/\b(password|passwd|pwd|passphrase|token|secret|api[_ -]?key)\b(\s*(?:is|=|:)\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted key]')
    .replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted key]');
}

export const addDays = (d: Date | string, days: number): string => new Date(new Date(d).getTime() + days * DAY).toISOString();

export type EligibilityCode = 'CSAM' | 'WINDOW_CLOSED' | 'ALREADY_APPEALED' | 'NO_ACTION';
export const CSAM_MESSAGE = 'This action cannot be appealed.';

/** Order matters: the CSAM refusal is neutral and checked before anything that could hint at details. */
export function checkEligibility(a: {
  hasAction: boolean; actionAt?: Date | string; csam?: boolean; alreadyAppealed?: boolean; now?: Date;
}): { ok: true } | { ok: false; code: EligibilityCode; message: string } {
  if (!a.hasAction || !a.actionAt) return { ok: false, code: 'NO_ACTION', message: 'No recorded action to appeal. Contact support.' };
  if (a.csam) return { ok: false, code: 'CSAM', message: CSAM_MESSAGE };
  if (a.alreadyAppealed) return { ok: false, code: 'ALREADY_APPEALED', message: 'This action has already been appealed. Each action can be appealed once.' };
  const now = (a.now ?? new Date()).getTime();
  if (now > new Date(addDays(a.actionAt, APPEAL_WINDOW_DAYS)).getTime()) {
    return { ok: false, code: 'WINDOW_CLOSED', message: `Appeals must be filed within ${APPEAL_WINDOW_DAYS} days of the action.` };
  }
  return { ok: true };
}

/** A different admin decides; the acting admin may only if they are the sole admin who can. */
export function checkDecider(a: { actionAdminId: string | null; deciderId: string; deciderCount: number }):
  { ok: true; soleAdmin: boolean } | { ok: false; message: string } {
  if (a.actionAdminId && a.actionAdminId === a.deciderId) {
    if (a.deciderCount <= 1) return { ok: true, soleAdmin: true };
    return { ok: false, message: 'A different admin than the one who took the action must decide this appeal.' };
  }
  return { ok: true, soleAdmin: false };
}
