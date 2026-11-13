import { describe, it, expect } from 'vitest';
import { validateDataRequestBody, dueDate, DATA_REQUEST_SLA_DAYS } from '../../src/utils/dataRequests.js';

describe('validateDataRequestBody', () => {
  it('accepts export and delete with a password', () => {
    expect(validateDataRequestBody({ type: 'export', password: 'x' })).toEqual({ ok: true, type: 'export', password: 'x' });
    expect(validateDataRequestBody({ type: 'delete', password: 'hunter2' }).ok).toBe(true);
  });
  it('rejects unknown types, missing or oversize passwords and junk bodies', () => {
    expect(validateDataRequestBody({ type: 'purge', password: 'x' }).ok).toBe(false);
    expect(validateDataRequestBody({ type: 'delete' }).ok).toBe(false);
    expect(validateDataRequestBody({ type: 'delete', password: '' }).ok).toBe(false);
    expect(validateDataRequestBody({ type: 'delete', password: 'a'.repeat(1025) }).ok).toBe(false);
    expect(validateDataRequestBody({ type: 'delete', password: 5 }).ok).toBe(false);
    expect(validateDataRequestBody(null).ok).toBe(false);
  });
});

describe('dueDate', () => {
  it('is 30 days after the request', () => {
    expect(DATA_REQUEST_SLA_DAYS).toBe(30);
    expect(dueDate('2026-11-01T00:00:00.000Z')).toBe('2026-12-01T00:00:00.000Z');
  });
});
