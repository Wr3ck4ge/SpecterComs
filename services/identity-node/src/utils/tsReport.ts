// T3: trust & safety report intake — validation and policy (pure, no DB).
// docs/TRUST_SAFETY_REPORTING_PLAN_2026_11_09.md sections 4, 5, 7.
//
// The report file arrives sealed to the T&S public key (same model as the D1
// bug reports, packages/shared-web/src/sealedReport.js), so the server can
// only check its shape and size. Nothing here ever echoes a field back or
// logs it.

import { createHash } from 'crypto';

/** Ordered by urgency (plan section 2). */
export const TS_REPORT_CATEGORIES = [
  'csam',            // child sexual exploitation
  'threat_to_life',  // threat to someone's life or safety
  'terrorism',       // terrorism / violent extremism
  'fraud',           // fraud, scams, stolen data or accounts
  'illegal_goods',   // sale of illegal goods or services
  'harassment',
  'other_illegal',
  'rules',           // breaks the community rules (not illegal)
] as const;
export type TsReportCategory = typeof TS_REPORT_CATEGORIES[number];

/** Queue order: CSAM, then threat to life, then the rest; rule breaks last. */
export const TS_REPORT_PRIORITY: Record<TsReportCategory, number> = {
  csam: 0, threat_to_life: 1, terrorism: 2, fraud: 3, illegal_goods: 3, harassment: 3, other_illegal: 3, rules: 4,
};

export const TS_REPORT_STATES = ['received', 'in_review', 'actioned', 'dismissed', 'referred'] as const;
export type TsReportState = typeof TS_REPORT_STATES[number];
export const TS_REPORT_CLOSED_STATES: readonly TsReportState[] = ['actioned', 'dismissed', 'referred'];

/** Decoded ciphertext cap. Base64 inflates by 4/3, so the JSON body stays under nginx's 10 MB /api/ limit. */
export const TS_REPORT_MAX_BLOB = 7 * 1024 * 1024;
export const TS_REPORT_BODY_LIMIT = '10mb';
export const TS_REPORT_MAX_SUBJECT_USERS = 25;
export const TS_REPORT_RETENTION_DEFAULT_DAYS = 180;
/** REPORT Act: CSAM material is preserved at least a year. */
export const TS_REPORT_CSAM_MIN_DAYS = 365;
export const TS_REPORT_REASON_MAX = 500;

const SEAL_ALG = 'ECDH-P256+HKDF-SHA256+A256GCM';
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_CT_B64 = Math.ceil(TS_REPORT_MAX_BLOB / 3) * 4;

export interface TsReportInput {
  category: TsReportCategory;
  priority: number;
  subjectUserIds: string[];
  subjectOrgId: string | null;
  subjectChannelId: string | null;
  clientVersion: string | null;
  manifestSha256: string;
  keyId: string;
  sealedHeader: { v: 1; alg: string; keyId: string; epk: { x: string; y: string }; iv: string };
  ciphertext: Buffer;
  blobSha256: string;
}

type Result = { ok: true; value: TsReportInput } | { ok: false; message: string };

const isStr = (v: unknown, max: number, re?: RegExp): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && (!re || re.test(v));

/**
 * Checks a POST /ts-reports body:
 *   { category, subject: { userIds?, orgId?, channelId? }, clientVersion?, manifestSha256,
 *     keyId, sealed: { v: 1, alg, keyId, epk: { x, y }, iv, ct } }
 * At least one subject id is required. Returns a rebuilt value: nothing extra
 * the client sent is kept.
 */
export function validateTsReport(body: any): Result {
  if (!body || typeof body !== 'object') return { ok: false, message: 'Invalid report' };
  const { category, subject, clientVersion, manifestSha256, keyId, sealed } = body;
  if (!(TS_REPORT_CATEGORIES as readonly string[]).includes(category)) return { ok: false, message: 'Invalid category' };

  if (!subject || typeof subject !== 'object') return { ok: false, message: 'Invalid subject' };
  const userIds = subject.userIds ?? [];
  if (!Array.isArray(userIds) || userIds.length > TS_REPORT_MAX_SUBJECT_USERS || !userIds.every((u) => typeof u === 'string' && UUID.test(u))) {
    return { ok: false, message: 'Invalid subject users' };
  }
  const orgId = subject.orgId ?? null;
  if (orgId !== null && !(typeof orgId === 'string' && UUID.test(orgId))) return { ok: false, message: 'Invalid subject org' };
  const channelId = subject.channelId ?? null;
  if (channelId !== null && !isStr(channelId, 128, CHANNEL_ID)) return { ok: false, message: 'Invalid subject channel' };
  if (!userIds.length && !orgId && !channelId) return { ok: false, message: 'A report needs a subject' };

  if (clientVersion != null && !isStr(clientVersion, 32, /^[0-9A-Za-z.+-]+$/)) return { ok: false, message: 'Invalid client version' };
  if (!isStr(manifestSha256, 64, SHA256_HEX)) return { ok: false, message: 'Invalid manifest hash' };
  if (!isStr(keyId, 16, KEY_ID)) return { ok: false, message: 'Invalid key id' };
  if (!sealed || typeof sealed !== 'object' || sealed.v !== 1 || sealed.alg !== SEAL_ALG || sealed.keyId !== keyId
    || !sealed.epk || !isStr(sealed.epk.x, 64, B64URL) || !isStr(sealed.epk.y, 64, B64URL)
    || !isStr(sealed.iv, 24, B64) || !isStr(sealed.ct, MAX_CT_B64) || sealed.ct.length % 4 !== 0 || !B64.test(sealed.ct)) {
    return { ok: false, message: 'Invalid sealed report' };
  }
  const ciphertext = Buffer.from(sealed.ct, 'base64');
  // AES-GCM output is at least the 16-byte tag; anything shorter isn't a sealed file.
  if (ciphertext.length < 17 || ciphertext.length > TS_REPORT_MAX_BLOB) return { ok: false, message: 'Invalid sealed report' };

  const cat = category as TsReportCategory;
  return {
    ok: true,
    value: {
      category: cat,
      priority: TS_REPORT_PRIORITY[cat],
      subjectUserIds: [...new Set<string>(userIds.map((u: string) => u.toLowerCase()))],
      subjectOrgId: orgId ? orgId.toLowerCase() : null,
      subjectChannelId: channelId,
      clientVersion: clientVersion ?? null,
      manifestSha256,
      keyId,
      sealedHeader: { v: 1, alg: SEAL_ALG, keyId, epk: { x: sealed.epk.x, y: sealed.epk.y }, iv: sealed.iv },
      ciphertext,
      blobSha256: createHash('sha256').update(ciphertext).digest('hex'),
    },
  };
}

/** Admin state change: anything but back to "received"; a closed report can be reopened to in_review. */
export function canTransition(from: string, to: string): boolean {
  if (!(TS_REPORT_STATES as readonly string[]).includes(to) || to === 'received' || from === to) return false;
  return (TS_REPORT_STATES as readonly string[]).includes(from);
}

export const isClosedState = (s: string) => (TS_REPORT_CLOSED_STATES as readonly string[]).includes(s);

/** TS_REPORT_RETENTION_DAYS, default 180, never below 1. */
export function retentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TS_REPORT_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : TS_REPORT_RETENTION_DEFAULT_DAYS;
}

/** Dismissed reports (owner decision 2026-11-12): TS_REPORT_DISMISSED_RETENTION_DAYS, default 30, never below 1. */
export const TS_REPORT_DISMISSED_RETENTION_DEFAULT_DAYS = 30;
export function dismissedRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TS_REPORT_DISMISSED_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : TS_REPORT_DISMISSED_RETENTION_DEFAULT_DAYS;
}

/**
 * The retention sweep, as one statement: deletes closed, non-held reports
 * older than the retention period (CSAM: at least 365 days; dismissed: the
 * shorter dismissed period, but never CSAM) and writes a "purged" custody
 * row for each. $1 = retention days, $2 = dismissed retention days.
 */
export const TS_REPORT_PURGE_SQL = `
  WITH gone AS (
    DELETE FROM ts_reports
    WHERE NOT legal_hold
      AND state IN ('actioned', 'dismissed', 'referred')
      AND closed_at IS NOT NULL
      AND closed_at < NOW() - make_interval(days => CASE WHEN category = 'csam' THEN GREATEST($1::int, ${TS_REPORT_CSAM_MIN_DAYS}) WHEN state = 'dismissed' THEN $2::int ELSE $1::int END)
    RETURNING id, category, state
  )
  INSERT INTO ts_report_custody (report_id, action, detail)
  SELECT id, 'purged', jsonb_build_object('category', category, 'state', state, 'reason', 'retention') FROM gone`;

/**
 * CSAM restricted handling (plan section 6): when TS_CSAM_REVIEWER_ADMIN_IDS
 * (comma-separated platform_admins ids) is set, only those admins may open a
 * CSAM report file. Unset: any owner-role admin (single-owner setup).
 */
export function csamReviewerAllowed(adminId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!adminId) return false;
  const list = (env.TS_CSAM_REVIEWER_ADMIN_IDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(adminId.toLowerCase());
}

/** Validates { reason } for admin actions that need one. */
export function parseReason(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= TS_REPORT_REASON_MAX ? s : null;
}
