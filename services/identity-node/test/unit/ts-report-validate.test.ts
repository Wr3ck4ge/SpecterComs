import { describe, it, expect } from 'vitest';
import {
  validateTsReport, canTransition, isClosedState, retentionDays, csamReviewerAllowed, parseReason,
  TS_REPORT_PRIORITY, TS_REPORT_MAX_BLOB, TS_REPORT_PURGE_SQL,
} from '../../src/utils/tsReport.js';
// @ts-ignore — plain JS module shared with the clients
import { createOwnerKey, sealToPublicKey } from '../../../../packages/shared-web/src/sealedReport.js';

// T3: the server only checks the shape and size of a sealed T&S report and
// stores the ciphertext; it can never read the report file.

const U1 = '11111111-2222-4333-8444-555555555555';
const ORG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SHA = 'a'.repeat(64);

async function fixture() {
  const key = await createOwnerKey('correct horse battery');
  const sealed = await sealToPublicKey(key, JSON.stringify({ manifest: 'x', messages: [] }));
  return {
    key,
    body: { category: 'fraud', subject: { userIds: [U1], orgId: ORG }, clientVersion: '2.1.0', manifestSha256: SHA, keyId: key.keyId, sealed },
  };
}

describe('validateTsReport', () => {
  it('accepts a sealed report, keeps only known fields and hashes the ciphertext', async () => {
    const { body } = await fixture();
    const r = validateTsReport({ ...body, sealed: { ...body.sealed, extra: 'x' }, reporterNote: 'nope', subject: { ...body.subject, junk: 1 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value.sealedHeader).sort()).toEqual(['alg', 'epk', 'iv', 'keyId', 'v']);
    expect(r.value.ciphertext.toString('base64')).toBe(body.sealed.ct);
    expect(r.value.blobSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.value.priority).toBe(TS_REPORT_PRIORITY.fraud);
    expect(r.value.subjectUserIds).toEqual([U1]);
    expect(r.value.subjectChannelId).toBeNull();
    expect(Object.keys(r.value)).not.toContain('reporterNote');
  }, 20_000);

  it('ranks CSAM and threats to life first', () => {
    expect(TS_REPORT_PRIORITY.csam).toBeLessThan(TS_REPORT_PRIORITY.threat_to_life);
    expect(TS_REPORT_PRIORITY.threat_to_life).toBeLessThan(TS_REPORT_PRIORITY.harassment);
    expect(TS_REPORT_PRIORITY.harassment).toBeLessThan(TS_REPORT_PRIORITY.rules);
  });

  it('rejects bad categories, subjects, hashes, keys and ciphertext', async () => {
    const { body } = await fixture();
    const bad = (patch: any) => expect(validateTsReport({ ...body, ...patch }).ok).toBe(false);
    bad({ category: 'spam' });
    bad({ subject: {} });
    bad({ subject: null });
    bad({ subject: { userIds: ['not-a-uuid'] } });
    bad({ subject: { userIds: Array.from({ length: 26 }, () => U1) } });
    bad({ subject: { orgId: 'x' } });
    bad({ subject: { channelId: 'a b<script>' } });
    bad({ manifestSha256: 'A'.repeat(64) });
    bad({ manifestSha256: 'a'.repeat(63) });
    bad({ clientVersion: '<script>' });
    bad({ keyId: '0123456789abcdef' });
    bad({ sealed: { ...body.sealed, ct: 'not base64 at all!' } });
    bad({ sealed: { ...body.sealed, ct: 'AAAA' } }); // shorter than a GCM tag
    bad({ sealed: { ...body.sealed, alg: 'none' } });
    bad({ sealed: { ...body.sealed, ct: undefined } });
    expect(validateTsReport(null).ok).toBe(false);
    expect(validateTsReport('x').ok).toBe(false);
  }, 20_000);

  it('accepts a channel-only subject and enforces the size cap', async () => {
    const { body } = await fixture();
    expect(validateTsReport({ ...body, subject: { channelId: 'dm:abc_123' } }).ok).toBe(true);
    const atCap = Buffer.alloc(TS_REPORT_MAX_BLOB - (TS_REPORT_MAX_BLOB % 3)).toString('base64');
    expect(validateTsReport({ ...body, sealed: { ...body.sealed, ct: atCap } }).ok).toBe(true);
    const over = Buffer.alloc(TS_REPORT_MAX_BLOB + 3).toString('base64');
    expect(validateTsReport({ ...body, sealed: { ...body.sealed, ct: over } }).ok).toBe(false);
  }, 20_000);
});

describe('T&S report policy', () => {
  it('allows reviewing, closing and reopening, never back to received', () => {
    expect(canTransition('received', 'in_review')).toBe(true);
    expect(canTransition('in_review', 'referred')).toBe(true);
    expect(canTransition('dismissed', 'in_review')).toBe(true);
    expect(canTransition('in_review', 'received')).toBe(false);
    expect(canTransition('actioned', 'actioned')).toBe(false);
    expect(canTransition('received', 'deleted')).toBe(false);
    expect(isClosedState('referred')).toBe(true);
    expect(isClosedState('in_review')).toBe(false);
  });

  it('defaults retention to 180 days and keeps it sane', () => {
    expect(retentionDays({})).toBe(180);
    expect(retentionDays({ TS_REPORT_RETENTION_DAYS: '30' })).toBe(30);
    expect(retentionDays({ TS_REPORT_RETENTION_DAYS: '0' })).toBe(180);
    expect(retentionDays({ TS_REPORT_RETENTION_DAYS: 'abc' })).toBe(180);
  });

  it('purges only closed, non-held reports and keeps CSAM at least a year', () => {
    expect(TS_REPORT_PURGE_SQL).toMatch(/NOT legal_hold/);
    expect(TS_REPORT_PURGE_SQL).toMatch(/state IN \('actioned', 'dismissed', 'referred'\)/);
    expect(TS_REPORT_PURGE_SQL).toMatch(/GREATEST\(\$1::int, 365\)/);
    expect(TS_REPORT_PURGE_SQL).toMatch(/INSERT INTO ts_report_custody/);
  });

  it('restricts CSAM files to the designated reviewers when configured', () => {
    const A = '00000000-0000-4000-8000-00000000000a';
    expect(csamReviewerAllowed(A, {})).toBe(true);
    expect(csamReviewerAllowed(null, {})).toBe(false);
    expect(csamReviewerAllowed(A, { TS_CSAM_REVIEWER_ADMIN_IDS: ` ${A.toUpperCase()} ,x` })).toBe(true);
    expect(csamReviewerAllowed(A, { TS_CSAM_REVIEWER_ADMIN_IDS: 'someone-else' })).toBe(false);
  });

  it('requires a short non-empty reason', () => {
    expect(parseReason('  subpoena 2026-123 ')).toBe('subpoena 2026-123');
    expect(parseReason('')).toBeNull();
    expect(parseReason('x'.repeat(501))).toBeNull();
    expect(parseReason(5)).toBeNull();
  });
});
