// D1: validation for bug reports. The description arrives sealed to the
// owner's key (packages/shared-web/src/sealedReport.js), so the server can
// only check its shape and size; the cleaning and redaction happen on the
// client before sealing, and the owner's admin browser re-checks flags after
// opening it.

export const BUG_REPORT_CATEGORIES = ['voice', 'video', 'hotkeys', 'hud', 'chat', 'other'] as const;
export const BUG_REPORT_STATUSES = ['new', 'triaged', 'closed'] as const;
export const BUG_REPORT_MAX_BODY = 16 * 1024;
export const BUG_REPORT_MAX_CHARS = 2000;
export const OWNER_NOTE_MAX = 4000;
export const RESOLUTION_MAX = 1000;

/**
 * Cleans the owner's reply to a reporter: NFC, strip control / bidi /
 * zero-width characters (newlines and tabs kept), trim. Empty → null.
 * Returns undefined when the value is not a string or is too long.
 */
export function cleanResolution(v: unknown): string | null | undefined {
  if (v == null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!s) return null;
  if (Array.from(s).length > RESOLUTION_MAX) return undefined;
  return s;
}

const SEAL_ALG = 'ECDH-P256+HKDF-SHA256+A256GCM';
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[0-9a-f]{16}$/;
// 2,000 chars × ≤4 UTF-8 bytes + 16-byte tag, base64 → ≤ 10,688 chars.
const MAX_CT_B64 = Math.ceil((BUG_REPORT_MAX_CHARS * 4 + 16) / 3) * 4;

export interface SealedReport {
  v: 1; alg: string; keyId: string; epk: { x: string; y: string }; iv: string; ct: string;
}
export interface BugReportInput {
  category: string; appVersion: string | null; keyId: string; sealed: SealedReport;
  descChars: number; redactions: number; diagnostics: boolean;
}

type Result = { ok: true; value: BugReportInput } | { ok: false; message: string };

const isStr = (v: unknown, max: number, re?: RegExp): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && (!re || re.test(v));
const isCount = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;

/** Checks a POST /bug-reports body; never echoes any of it back. */
export function validateBugReport(body: any): Result {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Invalid report' };
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > BUG_REPORT_MAX_BODY) return { ok: false, message: 'Report too large' };
  const { category, appVersion, keyId, sealed, descChars, redactions, diagnostics } = body;
  if (!BUG_REPORT_CATEGORIES.includes(category)) return { ok: false, message: 'Invalid category' };
  if (appVersion != null && !isStr(appVersion, 32, /^[0-9A-Za-z.+-]+$/)) return { ok: false, message: 'Invalid app version' };
  if (!isStr(keyId, 16, KEY_ID)) return { ok: false, message: 'Invalid key id' };
  if (!sealed || typeof sealed !== 'object' || sealed.v !== 1 || sealed.alg !== SEAL_ALG || sealed.keyId !== keyId
    || !sealed.epk || !isStr(sealed.epk.x, 64, B64URL) || !isStr(sealed.epk.y, 64, B64URL)
    || !isStr(sealed.iv, 24, B64) || !isStr(sealed.ct, MAX_CT_B64, B64)) {
    return { ok: false, message: 'Invalid sealed description' };
  }
  if (!isCount(descChars, BUG_REPORT_MAX_CHARS) || descChars === 0) return { ok: false, message: 'Invalid description length' };
  if (!isCount(redactions ?? 0, 500)) return { ok: false, message: 'Invalid redaction count' };
  return {
    ok: true,
    value: {
      category,
      appVersion: appVersion ?? null,
      keyId,
      // Rebuilt field by field: nothing extra the client sent is stored.
      sealed: { v: 1, alg: SEAL_ALG, keyId, epk: { x: sealed.epk.x, y: sealed.epk.y }, iv: sealed.iv, ct: sealed.ct },
      descChars,
      redactions: redactions ?? 0,
      diagnostics: diagnostics === true,
    },
  };
}

/** Checks an owner key upload ({ keyId, publicKey, wrapped }). */
export function validateReportKey(body: any): { ok: true } | { ok: false; message: string } {
  const { keyId, publicKey: pk, wrapped: w } = body ?? {};
  if (!isStr(keyId, 16, KEY_ID)) return { ok: false, message: 'Invalid key id' };
  if (!pk || pk.kty !== 'EC' || pk.crv !== 'P-256' || !isStr(pk.x, 64, B64URL) || !isStr(pk.y, 64, B64URL)) {
    return { ok: false, message: 'Invalid public key' };
  }
  if (!w || w.v !== 1 || w.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(w.iterations) || w.iterations < 100_000
    || !isStr(w.salt, 64, B64) || !isStr(w.iv, 24, B64) || !isStr(w.ct, 1024, B64)) {
    return { ok: false, message: 'Invalid wrapped key' };
  }
  return { ok: true };
}
