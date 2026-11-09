/**
 * Unit tests for the admin panel's pure policy helpers (no database needed).
 * Run: npx vitest run src/test/admin-policy.test.ts
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  effectiveAdminRole,
  roleAtLeast,
  assessHwid,
  maskEmail,
  parseListParams,
  escapeLike,
  confirmationMatches,
  redactExportRow,
  createKeyedLimiter,
  hashEmailForLookup,
  safeErr,
  isUuid,
  MAX_PAGE_SIZE,
} from '../utils/adminPolicy.js';

describe('admin roles', () => {
  it('maps legacy super_admin with NULL role to owner, anything else to no access', () => {
    expect(effectiveAdminRole({ role: null, permissions: { super_admin: true } })).toBe('owner');
    expect(effectiveAdminRole({ role: null, permissions: { can_ban_global: true } })).toBeNull();
    expect(effectiveAdminRole({ role: null, permissions: null })).toBeNull();
  });

  it('an explicit role wins over the legacy flag (demotion sticks)', () => {
    expect(effectiveAdminRole({ role: 'viewer', permissions: { super_admin: true } })).toBe('viewer');
  });

  it('ignores unknown role strings', () => {
    expect(effectiveAdminRole({ role: 'god', permissions: { super_admin: true } })).toBeNull();
  });

  it('orders viewer < operator < owner', () => {
    expect(roleAtLeast('owner', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'operator')).toBe(true);
    expect(roleAtLeast('viewer', 'operator')).toBe(false);
    expect(roleAtLeast(null, 'viewer')).toBe(false);
  });
});

describe('hardware id assessment', () => {
  const real = crypto.createHash('sha256').update('specter-coms-hwid-v2-some-machine').digest('hex');

  it('accepts a desktop-client fingerprint', () => {
    expect(assessHwid(real)).toMatchObject({ present: true, bannable: true });
  });

  it('refuses the shared browser placeholder', () => {
    const a = assessHwid('browser-fallback-hwid');
    expect(a.bannable).toBe(false);
    expect(a.reason).toMatch(/every browser/i);
  });

  it('refuses missing, malformed, upper-case and degenerate ids', () => {
    expect(assessHwid(null)).toMatchObject({ present: false, bannable: false });
    expect(assessHwid('')).toMatchObject({ present: false, bannable: false });
    expect(assessHwid('test-hwid-ban-123').bannable).toBe(false);
    expect(assessHwid(real.toUpperCase()).bannable).toBe(false);
    expect(assessHwid(crypto.createHash('sha256').update('').digest('hex')).bannable).toBe(false);
  });
});

describe('PII helpers', () => {
  it('masks emails without leaking the local part or domain', () => {
    expect(maskEmail('jane.doe@example.co.uk')).toBe('j•••@e•••.uk');
    expect(maskEmail('a@b')).toBe('a•••@b•••');
    expect(maskEmail('not-an-email')).toBe('•••');
    expect(maskEmail(null)).toBeNull();
  });

  it('hashes emails exactly like authController (lower-case + trim)', () => {
    expect(hashEmailForLookup('  Jane@Example.com ')).toBe(
      crypto.createHash('sha256').update('jane@example.com').digest('hex'),
    );
  });

  it('safeErr drops pg error detail (which can contain values)', () => {
    const e = Object.assign(new Error('duplicate key value'), {
      code: '23505', detail: 'Key (email_hash)=(abc) already exists.', constraint: 'users_email_hash_key',
    });
    const out = safeErr(e);
    expect(out).toMatchObject({ code: '23505', constraint: 'users_email_hash_key' });
    expect(JSON.stringify(out)).not.toContain('abc');
  });
});

describe('list parameter parsing', () => {
  const sorts = { created_at: 'u.created_at', callsign: 'lower(u.callsign)' };

  it('defaults sensibly', () => {
    const p = parseListParams({}, sorts, 'created_at');
    expect(p).toMatchObject({ page: 1, limit: 50, offset: 0, q: '', sortSql: 'u.created_at', dir: 'desc' });
  });

  it('caps page size and offset, rejects garbage', () => {
    expect(parseListParams({ limit: '100000' }, sorts, 'created_at').limit).toBe(MAX_PAGE_SIZE);
    expect(parseListParams({ limit: '-5' }, sorts, 'created_at').limit).toBe(1);
    expect(parseListParams({ page: 'abc' }, sorts, 'created_at').page).toBe(1);
    expect(parseListParams({ page: '999999999', limit: '100' }, sorts, 'created_at').offset).toBeLessThanOrEqual(100_000);
  });

  it('never lets user input reach ORDER BY', () => {
    const p = parseListParams({ sort: 'created_at; DROP TABLE users', dir: 'sideways' }, sorts, 'created_at');
    expect(p.sortSql).toBe('u.created_at');
    expect(p.dir).toBe('desc');
    expect(parseListParams({ sort: 'callsign', dir: 'ASC' }, sorts, 'created_at')).toMatchObject({ sortSql: 'lower(u.callsign)', dir: 'asc' });
    expect(parseListParams({ sort: '__proto__' }, sorts, 'created_at').sortSql).toBe('u.created_at');
  });

  it('truncates very long searches and escapes LIKE wildcards', () => {
    expect(parseListParams({ q: 'x'.repeat(500) }, sorts, 'created_at').q).toHaveLength(64);
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('confirmation + export redaction', () => {
  it('requires an exact (trimmed) typed confirmation', () => {
    expect(confirmationMatches('Ghost', ' Ghost ')).toBe(true);
    expect(confirmationMatches('Ghost', 'ghost')).toBe(false);
    expect(confirmationMatches('Ghost', undefined)).toBe(false);
  });

  it('drops credentials and secrets from exported rows', () => {
    const row = redactExportRow('user_id', {
      id: 1, user_id: 'u', token_hash: 'x', password_hash: 'y', key_package: '\\x00', created_at: 't', issued_by_admin_id: 'a',
    });
    expect(row).toEqual({ id: 1, user_id: 'u', created_at: 't' });
  });

  it('strips reporter identity when the subject is the accused party', () => {
    const row = redactExportRow('accused_id', { id: 1, accused_id: 'u', reporter_id: 'r', reporter_note: 'n', status: 'pending' });
    expect(row).toEqual({ id: 1, accused_id: 'u', status: 'pending' });
  });
});

describe('keyed rate limiter', () => {
  it('allows max calls per window per key, then blocks, then resets', () => {
    const l = createKeyedLimiter(1000, 2);
    expect(l.take('a', 0)).toBe(true);
    expect(l.take('a', 1)).toBe(true);
    expect(l.take('a', 2)).toBe(false);
    expect(l.take('b', 2)).toBe(true);
    expect(l.take('a', 2000)).toBe(true);
  });
});

describe('isUuid', () => {
  it('validates route ids before they reach SQL', () => {
    expect(isUuid('2f1c1b5e-7d55-4c8e-9a43-0f3a1f8b2c11')).toBe(true);
    expect(isUuid("1' OR '1'='1")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
