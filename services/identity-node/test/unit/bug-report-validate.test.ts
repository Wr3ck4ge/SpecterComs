import { describe, it, expect } from 'vitest';
import { validateBugReport, validateReportKey } from '../../src/utils/bugReport.js';
// @ts-ignore — plain JS module shared with the clients
import { createOwnerKey, sealToPublicKey } from '../../../../packages/shared-web/src/sealedReport.js';

// D1: the server only checks the shape/size of a sealed report and of the
// owner's wrapped key; it can never read the description.

async function fixture() {
  const owner = await createOwnerKey('correct horse battery');
  const sealed = await sealToPublicKey(owner, 'The HUD freezes after alt-tab');
  return {
    owner,
    body: { category: 'hud', appVersion: '2.0.24', keyId: owner.keyId, sealed, descChars: 29, redactions: 0, diagnostics: true },
  };
}

describe('validateBugReport', () => {
  it('accepts a sealed report and keeps only known fields', async () => {
    const { body } = await fixture();
    const r = validateBugReport({ ...body, sealed: { ...body.sealed, extra: 'x' }, junk: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value.sealed).sort()).toEqual(['alg', 'ct', 'epk', 'iv', 'keyId', 'v']);
      expect(r.value.diagnostics).toBe(true);
    }
  }, 20_000);

  it('rejects bad categories, mismatched key ids, plaintext and oversize bodies', async () => {
    const { body } = await fixture();
    expect(validateBugReport({ ...body, category: 'nope' }).ok).toBe(false);
    expect(validateBugReport({ ...body, keyId: '0123456789abcdef' }).ok).toBe(false);
    expect(validateBugReport({ ...body, sealed: { ...body.sealed, ct: 'not base64 at all!' } }).ok).toBe(false);
    expect(validateBugReport({ ...body, sealed: { ...body.sealed, ct: 'A'.repeat(20_000) } }).ok).toBe(false);
    expect(validateBugReport({ ...body, descChars: 0 }).ok).toBe(false);
    expect(validateBugReport({ ...body, appVersion: '<script>' }).ok).toBe(false);
    expect(validateBugReport(null).ok).toBe(false);
  }, 20_000);
});

describe('validateReportKey', () => {
  it('accepts a wrapped owner key and rejects a weak or malformed one', async () => {
    const { owner } = await fixture();
    expect(validateReportKey(owner).ok).toBe(true);
    expect(validateReportKey({ ...owner, wrapped: { ...owner.wrapped, iterations: 1000 } }).ok).toBe(false);
    expect(validateReportKey({ ...owner, publicKey: { ...owner.publicKey, crv: 'P-384' } }).ok).toBe(false);
    expect(validateReportKey({}).ok).toBe(false);
  }, 20_000);
});
