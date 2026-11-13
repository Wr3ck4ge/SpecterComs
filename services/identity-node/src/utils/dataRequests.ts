// L6: pure helpers for account data requests (export / delete).

export const DATA_REQUEST_TYPES = ['export', 'delete'] as const;
export const DATA_REQUEST_STATUSES = ['open', 'done', 'cancelled'] as const;
export type DataRequestType = typeof DATA_REQUEST_TYPES[number];
export const DATA_REQUEST_NOTE_MAX = 500;
export const DATA_REQUEST_SLA_DAYS = 30;

export function validateDataRequestBody(body: unknown):
  { ok: true; type: DataRequestType; password: string } | { ok: false; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.type !== 'string' || !(DATA_REQUEST_TYPES as readonly string[]).includes(b.type)) {
    return { ok: false, message: 'type must be "export" or "delete"' };
  }
  if (typeof b.password !== 'string' || !b.password || b.password.length > 1024) {
    return { ok: false, message: 'Enter your password to confirm.' };
  }
  return { ok: true, type: b.type as DataRequestType, password: b.password };
}

/** When the user can expect the request to be handled by (GDPR: one month). */
export function dueDate(createdAt: Date | string): string {
  const d = new Date(createdAt);
  d.setUTCDate(d.getUTCDate() + DATA_REQUEST_SLA_DAYS);
  return d.toISOString();
}
