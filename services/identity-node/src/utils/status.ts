// L7: public status page. Pure helpers (no DB / NATS) so they unit-test cleanly.

export const STATUS_SEVERITIES = ['info', 'degraded', 'outage', 'maintenance'] as const;
export type StatusSeverity = (typeof STATUS_SEVERITIES)[number];
export type OverallState = 'ok' | 'degraded' | 'outage' | 'maintenance';
export type ComponentState = 'ok' | 'degraded' | 'outage';

export const NOTICE_MAX_CHARS = 280;

export interface StatusNotice { id: number; severity: StatusSeverity; message: string; eta: string | null; since: string }

const RANK: Record<OverallState, number> = { ok: 0, maintenance: 1, degraded: 2, outage: 3 };

/** Worst component state, then the notice (info never changes the state; maintenance only if nothing is worse). */
export function computeOverall(components: Record<string, ComponentState>, notice: Pick<StatusNotice, 'severity'> | null): OverallState {
  let state: OverallState = 'ok';
  for (const s of Object.values(components)) if (RANK[s] > RANK[state]) state = s;
  if (notice && notice.severity !== 'info' && RANK[notice.severity] > RANK[state]) state = notice.severity;
  return state;
}

export type NoticeInput = { severity: StatusSeverity; message: string; eta: Date | null };

export function validateNotice(body: any): { ok: true; value: NoticeInput } | { ok: false; message: string } {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Body required.' };
  if (!(STATUS_SEVERITIES as readonly string[]).includes(body.severity)) return { ok: false, message: 'severity must be info, degraded, outage or maintenance.' };
  if (typeof body.message !== 'string') return { ok: false, message: 'message required.' };
  const message = body.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!message) return { ok: false, message: 'message required.' };
  if (Array.from(message).length > NOTICE_MAX_CHARS) return { ok: false, message: `message must be at most ${NOTICE_MAX_CHARS} characters.` };
  let eta: Date | null = null;
  if (body.eta !== undefined && body.eta !== null && body.eta !== '') {
    eta = typeof body.eta === 'string' ? new Date(body.eta) : new Date(NaN);
    if (Number.isNaN(eta.getTime())) return { ok: false, message: 'eta must be an ISO date.' };
  }
  return { ok: true, value: { severity: body.severity, message, eta } };
}
