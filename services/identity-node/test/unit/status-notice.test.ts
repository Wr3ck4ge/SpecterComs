import { describe, it, expect } from 'vitest';
import { computeOverall, validateNotice, NOTICE_MAX_CHARS } from '../../src/utils/status.js';
import { readFileSync } from 'fs';

describe('computeOverall', () => {
  it('is ok with healthy components and no notice', () => {
    expect(computeOverall({ database: 'ok', messaging: 'ok' }, null)).toBe('ok');
  });
  it('takes the worst component', () => {
    expect(computeOverall({ database: 'ok', messaging: 'degraded' }, null)).toBe('degraded');
    expect(computeOverall({ database: 'outage', messaging: 'degraded' }, null)).toBe('outage');
  });
  it('info notices never change the state; maintenance does when nothing is worse', () => {
    expect(computeOverall({ database: 'ok' }, { severity: 'info' })).toBe('ok');
    expect(computeOverall({ database: 'ok' }, { severity: 'maintenance' })).toBe('maintenance');
    expect(computeOverall({ database: 'outage' }, { severity: 'maintenance' })).toBe('outage');
    expect(computeOverall({ database: 'ok' }, { severity: 'outage' })).toBe('outage');
  });
});

describe('validateNotice', () => {
  it('accepts a notice and trims it', () => {
    const r = validateNotice({ severity: 'degraded', message: '  Voice is slow \n', eta: '2026-11-12T20:00:00Z' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.value.message).toBe('Voice is slow'); expect(r.value.eta?.toISOString()).toBe('2026-11-12T20:00:00.000Z'); }
  });
  it('rejects bad severity, empty, oversize and bad eta', () => {
    expect(validateNotice({ severity: 'bad', message: 'x' }).ok).toBe(false);
    expect(validateNotice({ severity: 'info', message: '   ' }).ok).toBe(false);
    expect(validateNotice({ severity: 'info', message: 'a'.repeat(NOTICE_MAX_CHARS + 1) }).ok).toBe(false);
    expect(validateNotice({ severity: 'info', message: 'a'.repeat(NOTICE_MAX_CHARS) }).ok).toBe(true);
    expect(validateNotice({ severity: 'info', message: 'x', eta: 'soon' }).ok).toBe(false);
    expect(validateNotice(null).ok).toBe(false);
  });
});

describe('route wiring', () => {
  const admin = readFileSync(new URL('../../src/routes/admin.ts', import.meta.url), 'utf8');
  it('status-notice admin endpoints are role-gated, never open', () => {
    for (const m of ['get', 'put', 'delete']) {
      const line = admin.split('\n').find((l) => l.startsWith(`router.${m}('/status-notice'`));
      expect(line).toBeDefined();
      expect(line).toMatch(/,\s+(operator|owner),/);
    }
  });
  it('the public /status route has no auth middleware', () => {
    const route = readFileSync(new URL('../../src/routes/status.ts', import.meta.url), 'utf8');
    expect(route).not.toMatch(/authenticate|requireRole/);
  });
});
