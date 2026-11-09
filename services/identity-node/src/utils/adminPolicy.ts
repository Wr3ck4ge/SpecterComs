import crypto from 'crypto';

// Pure (no DB / no env side effects) policy helpers for the platform admin
// panel. Kept out of adminController.ts so they can be unit-tested without a
// Postgres connection (importing config/db.ts exits the process when DB_DSN is
// unset) — see src/test/admin-policy.test.ts.

// ─── Roles ─────────────────────────────────────────────────────────────────────
//
// viewer   — read-only: dashboard, user/org/HWID-ban lists and details (PII masked),
//            billing overview (payments mode / health counts only)
// operator — moderation: ban/unban, HWID-ban revoke, reveal one email (audited),
//            voice reports, node routing/drain, audit log, billing reads,
//            read-only reconcile, resolving a billing exception
// owner    — irreversible / data-subject / money / infra: erase account, export
//            account data, dissolve org, provision nodes, issue invoices,
//            refund / adjust / settle / reconcile-repair (each with re-auth),
//            manage other admins' roles
export const ADMIN_ROLES = ['viewer', 'operator', 'owner'] as const;
export type AdminRole = typeof ADMIN_ROLES[number];

const ROLE_RANK: Record<AdminRole, number> = { viewer: 1, operator: 2, owner: 3 };

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === 'string' && (ADMIN_ROLES as readonly string[]).includes(v);
}

/**
 * platform_admins.role is nullable on purpose: every existing admin-creation
 * path (index.ts seedAdminIfNeeded, scripts/create-root.ts) only sets
 * permissions = { super_admin: true }. A NULL role therefore falls back to the
 * legacy flag — super_admin => owner (exactly the all-access it had before),
 * anything else => no access (exactly what the old requirePlatformAdmin did).
 */
export function effectiveAdminRole(row: { role?: string | null; permissions?: any }): AdminRole | null {
  if (isAdminRole(row.role)) return row.role;
  if (row.role == null && row.permissions?.super_admin === true) return 'owner';
  return null;
}

export function roleAtLeast(actual: AdminRole | null | undefined, required: AdminRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// ─── Session timing ────────────────────────────────────────────────────────────

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Idle timeout: a session unused for this long is dead (server-enforced). */
export const adminIdleTimeoutMinutes = () => envInt('ADMIN_SESSION_IDLE_MINUTES', 30, 5, 240);
/** Absolute lifetime of one admin session regardless of activity. */
export const adminSessionMaxHours = () => envInt('ADMIN_SESSION_MAX_HOURS', 8, 1, 24);
/** How long a password re-entry unlocks owner-level destructive actions. */
export const adminReauthWindowMinutes = () => envInt('ADMIN_REAUTH_WINDOW_MINUTES', 5, 1, 30);

// ─── Hardware IDs ──────────────────────────────────────────────────────────────
//
// A real HWID is what the Tauri client's get_hwid() returns (web-portal
// src-tauri/src/lib.rs): lowercase hex SHA-256 of a salted machine fingerprint.
// Anything else — notably the website's and web-portal's shared
// 'browser-fallback-hwid' placeholder — identifies no device, and a ban on it
// blocks EVERY account that ever sent the same placeholder.
export const KNOWN_PLACEHOLDER_HWIDS = new Set([
  'browser-fallback-hwid',
  'unknown',
  'null',
  'undefined',
  'none',
  '',
]);

const REAL_HWID_RE = /^[0-9a-f]{64}$/;

export type HwidAssessment =
  | { present: false; bannable: false; reason: string }
  | { present: true; bannable: boolean; reason: string };

export function assessHwid(hwid: string | null | undefined): HwidAssessment {
  if (hwid == null || hwid === '') {
    return { present: false, bannable: false, reason: 'No hardware ID on record (account never signed in from the desktop client).' };
  }
  if (KNOWN_PLACEHOLDER_HWIDS.has(hwid.trim().toLowerCase())) {
    return { present: true, bannable: false, reason: 'Placeholder ID shared by every browser/web sign-in — banning it would block all of those users.' };
  }
  if (!REAL_HWID_RE.test(hwid)) {
    return { present: true, bannable: false, reason: 'Not a desktop-client hardware fingerprint (expected 64 hex chars).' };
  }
  // The well-known SHA-256 of the empty string is a real-looking but
  // degenerate value — refuse it too.
  if (hwid === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') {
    return { present: true, bannable: false, reason: 'Degenerate fingerprint (hash of empty input).' };
  }
  return { present: true, bannable: true, reason: 'Desktop-client hardware fingerprint.' };
}

/** First characters only — enough to correlate, not to reconstruct. */
export function shortHwid(hwid: string | null | undefined): string | null {
  if (!hwid) return null;
  return hwid.length > 12 ? `${hwid.slice(0, 12)}…` : hwid;
}

// ─── PII ───────────────────────────────────────────────────────────────────────

/** Must stay identical to authController.hashEmail (lookup key). */
export function hashEmailForLookup(email: string): string {
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

/** "jane.doe@example.co.uk" -> "j•••@e•••.uk" */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '•••';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot > 0 ? domain.slice(dot + 1) : '';
  const domainHead = domain[0] ?? '';
  return `${local[0]}•••@${domainHead}•••${tld ? `.${tld}` : ''}`;
}

/**
 * Error logging without PII: pg errors carry a `detail` (e.g. "Key
 * (email_hash)=(…) already exists") and sometimes the failing parameters.
 * Only the code / constraint / table and message are logged.
 */
export function safeErr(err: any): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { message: String(err) };
  return {
    code: err.code,
    message: typeof err.message === 'string' ? err.message.slice(0, 300) : undefined,
    table: err.table,
    constraint: err.constraint,
  };
}

// ─── Validation / list parameters ──────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Escape LIKE/ILIKE wildcards so a search for "a_b" or "50%" is literal. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export interface ListParams {
  page: number;
  limit: number;
  offset: number;
  q: string;
  sortSql: string;
  sort: string;
  dir: 'asc' | 'desc';
}

export const MAX_PAGE_SIZE = 100;
export const MAX_OFFSET = 100_000;
export const MAX_SEARCH_LEN = 64;

/**
 * Parses page/limit/q/sort/dir from a query string. `sortable` maps the public
 * sort key to a trusted SQL expression — the only thing ever interpolated into
 * ORDER BY, so user input never reaches SQL text.
 */
export function parseListParams(
  query: Record<string, unknown>,
  sortable: Record<string, string>,
  defaultSort: string,
  defaultDir: 'asc' | 'desc' = 'desc',
): ListParams {
  const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
  const limitRaw = parseInt(str(query.limit), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_PAGE_SIZE, Math.max(1, limitRaw)) : 50;
  const pageRaw = parseInt(str(query.page), 10);
  let page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const maxPage = Math.floor(MAX_OFFSET / limit) + 1;
  if (page > maxPage) page = maxPage;
  const sortKey = Object.prototype.hasOwnProperty.call(sortable, str(query.sort)) ? str(query.sort) : defaultSort;
  const dirRaw = str(query.dir).toLowerCase();
  const dir: 'asc' | 'desc' = dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : defaultDir;
  const q = str(query.q).trim().slice(0, MAX_SEARCH_LEN);
  return { page, limit, offset: (page - 1) * limit, q, sort: sortKey, sortSql: sortable[sortKey], dir };
}

/** Typed-confirmation check for destructive actions (exact match, trimmed). */
export function confirmationMatches(expected: string | null | undefined, given: unknown): boolean {
  return typeof expected === 'string' && typeof given === 'string' && given.trim() === expected;
}

/** Normalises an optional free-text reason; returns null if absent/blank. */
export function cleanReason(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// ─── Data-subject export ───────────────────────────────────────────────────────

// Columns never included in an account export: credential material and
// secrets (useless to the subject, dangerous if the export leaks), and opaque
// encrypted blobs. The subject's own email is exported separately, decrypted.
const EXPORT_REDACT_RE = /(password|token|secret|_hash$|encrypted|audio_clip|private|key_package|admin_id$)/i;

// When the subject appears in a report as the ACCUSED party, the reporter's
// identity and statement are third-party data (GDPR Art. 15(4)) — dropped.
const ACCUSED_COLUMNS = new Set(['accused_id', 'reported_id']);
const REPORTER_FIELDS = ['reporter_id', 'reporter_note', 'speaking_history', 'speaker_map', 'evidence_payload', 'hardware_hash'];

export function redactExportRow(column: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (EXPORT_REDACT_RE.test(k)) continue;
    out[k] = v;
  }
  if (ACCUSED_COLUMNS.has(column)) {
    for (const f of REPORTER_FIELDS) delete out[f];
  }
  return out;
}

// ─── Rate limiting (keyed by admin id, not IP) ────────────────────────────────

export function createKeyedLimiter(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Returns true if the call is allowed (and counts it). */
    take(key: string, now = Date.now()): boolean {
      const e = hits.get(key);
      if (!e || now > e.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        if (hits.size > 10_000) {
          for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
        }
        return true;
      }
      if (e.count >= max) return false;
      e.count += 1;
      return true;
    },
  };
}
