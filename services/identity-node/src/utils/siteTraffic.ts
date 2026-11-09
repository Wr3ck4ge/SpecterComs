/**
 * Privacy-friendly website traffic counter (admin panel "Traffic" section).
 *
 * Answers one question: "is the site getting traffic that isn't me?".
 * Stored (see database/migrations/000071_site_traffic.up.sql):
 *   - daily aggregates: views / bot hits per (UTC day, known route, ref tag),
 *     downloads / bot hits per (day, platform);
 *   - for unique-visitor counting, SHA-256(daily salt | IP | UA) per day.
 * Never stored: IPs, user agents, cookies, query strings, invite codes.
 *
 * The salt is random, held only in this process's memory and replaced at
 * each UTC day boundary, so yesterday's hashes can't be recomputed or linked
 * to today's. Trade-off: a restart mid-day picks a fresh salt, so a visitor
 * seen before and after a restart counts twice that day.
 */
import crypto from 'crypto';

/** Days of per-visitor hashes kept; aggregates are kept indefinitely. */
export const UNIQUES_RETENTION_DAYS = 35;

export type TrafficScope = 'view' | 'download';

export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

// ─── Validation ───────────────────────────────────────────────────────────────

// The website's routes (website/src/App.jsx). /auth/admin is deliberately
// absent: admin panel visits are never counted.
const KNOWN_PATHS = new Set(['/', '/auth', '/dashboard', '/reset-password']);

/**
 * Maps a raw path to a known site route, or null (drop it). Query strings
 * and fragments are stripped (reset tokens live there), case and slashes are
 * normalised, and /join/<code> collapses to '/join/:code' so invite codes are
 * never stored.
 */
export function normalisePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  let p = raw.split(/[?#]/, 1)[0].toLowerCase().replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) return null;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (p === '') p = '/';
  if (KNOWN_PATHS.has(p)) return p;
  if (/^\/join\/[^/]+$/.test(p)) return '/join/:code';
  return null;
}

const REF_RE = /^[a-z0-9-]{1,40}$/;

/** A campaign tag from ?ref=, lower-cased; anything else becomes '' (no ref). */
export function cleanRef(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const r = raw.trim().toLowerCase();
  return REF_RE.test(r) ? r : '';
}

const BOT_UA_RE = /bot|crawl|spider|slurp|preview|scrape|fetch|monitor|curl|wget|python|httpclient|http-client|okhttp|axios|node-fetch|undici|go-http|java\/|libwww|perl|ruby|php|headless|phantom|puppeteer|playwright|selenium|lighthouse|pingdom|uptime|facebookexternalhit|embedly|whatsapp|telegram|discord|skype|vkshare|validator/i;

/** Obvious bots / scripts / link-preview fetchers. A missing UA counts as a bot. */
export function isBotUserAgent(ua: unknown): boolean {
  if (typeof ua !== 'string' || ua.trim() === '') return true;
  return BOT_UA_RE.test(ua);
}

const PLATFORMS = new Set(['windows', 'macos', 'linux']);
export const isDownloadPlatform = (p: unknown): p is string => typeof p === 'string' && PLATFORMS.has(p);

// ─── Daily salt + visitor hash ───────────────────────────────────────────────

/** UTC calendar day as YYYY-MM-DD. */
export const utcDay = (now = new Date()): string => now.toISOString().slice(0, 10);

/**
 * Holds exactly one salt, for the current UTC day. Asking for a new day
 * replaces (and forgets) the old one. `onRotate` fires on each replacement
 * after the first, which is when old uniques get pruned.
 */
export function createDailySalt(opts: { random?: () => Buffer; onRotate?: (day: string) => void } = {}) {
  const random = opts.random ?? (() => crypto.randomBytes(32));
  let current: { day: string; salt: Buffer } | null = null;
  return {
    forDay(day: string): Buffer {
      if (!current || current.day !== day) {
        const rotated = current !== null;
        current = { day, salt: random() };
        if (rotated) opts.onRotate?.(day);
      }
      return current.salt;
    },
  };
}

export function visitorHash(salt: Buffer, ip: string, ua: string): string {
  return crypto.createHash('sha256').update(salt).update('|').update(ip).update('|').update(ua).digest('hex');
}

// ─── Recording ───────────────────────────────────────────────────────────────

export interface HitContext {
  ip: string | undefined;
  ua: string | undefined;
  now?: Date;
}

export function createTrafficRecorder(db: Queryable, opts: { random?: () => Buffer } = {}) {
  const prune = () => db.query(
    `DELETE FROM site_traffic_uniques WHERE day < (now() AT TIME ZONE 'UTC')::date - $1::int`,
    [UNIQUES_RETENTION_DAYS],
  ).catch(() => {});
  const salt = createDailySalt({ random: opts.random, onRotate: () => { void prune(); } });

  async function markUnique(day: string, scope: TrafficScope, ctx: HitContext) {
    const hash = visitorHash(salt.forDay(day), ctx.ip || '', ctx.ua || '');
    await db.query(
      `INSERT INTO site_traffic_uniques (day, scope, visitor_hash) VALUES ($1::date, $2, $3)
       ON CONFLICT DO NOTHING`,
      [day, scope, hash],
    );
  }

  return {
    /** Returns what was counted: 'view', 'bot' or 'dropped' (invalid path). */
    async pageview(rawPath: unknown, rawRef: unknown, ctx: HitContext): Promise<'view' | 'bot' | 'dropped'> {
      const path = normalisePath(rawPath);
      if (!path) return 'dropped';
      const day = utcDay(ctx.now);
      if (isBotUserAgent(ctx.ua)) {
        await db.query(
          `INSERT INTO site_traffic_daily (day, path, ref, bot_hits) VALUES ($1::date, $2, '', 1)
           ON CONFLICT (day, path, ref) DO UPDATE SET bot_hits = site_traffic_daily.bot_hits + 1`,
          [day, path],
        );
        return 'bot';
      }
      await db.query(
        `INSERT INTO site_traffic_daily (day, path, ref, views) VALUES ($1::date, $2, $3, 1)
         ON CONFLICT (day, path, ref) DO UPDATE SET views = site_traffic_daily.views + 1`,
        [day, path, cleanRef(rawRef)],
      );
      await markUnique(day, 'view', ctx);
      return 'view';
    },

    async download(platform: unknown, ctx: HitContext): Promise<'download' | 'bot' | 'dropped'> {
      if (!isDownloadPlatform(platform)) return 'dropped';
      const day = utcDay(ctx.now);
      const bot = isBotUserAgent(ctx.ua);
      await db.query(
        `INSERT INTO site_downloads_daily (day, platform, downloads, bot_hits) VALUES ($1::date, $2, $3, $4)
         ON CONFLICT (day, platform) DO UPDATE SET
           downloads = site_downloads_daily.downloads + EXCLUDED.downloads,
           bot_hits  = site_downloads_daily.bot_hits  + EXCLUDED.bot_hits`,
        [day, platform, bot ? 0 : 1, bot ? 1 : 0],
      );
      if (bot) return 'bot';
      await markUnique(day, 'download', ctx);
      return 'download';
    },

    prune,
  };
}

// ─── Admin report ────────────────────────────────────────────────────────────

export const parseTrafficDays = (raw: unknown): number => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, n));
};

/**
 * Report for the last `days` UTC days (today included). Per-day rows are
 * zero-filled. `uniques` is null for days older than the hash retention.
 */
export async function trafficReport(db: Queryable, days: number) {
  const span = [days - 1];
  const [daily, paths, refs, platforms] = await Promise.all([
    db.query(
      `WITH d AS (
         SELECT generate_series((now() AT TIME ZONE 'UTC')::date - $1::int, (now() AT TIME ZONE 'UTC')::date, INTERVAL '1 day')::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              COALESCE((SELECT SUM(views)    FROM site_traffic_daily t WHERE t.day = d.day), 0)::int AS views,
              COALESCE((SELECT SUM(bot_hits) FROM site_traffic_daily t WHERE t.day = d.day), 0)::int AS bot_hits,
              COALESCE((SELECT SUM(downloads) FROM site_downloads_daily x WHERE x.day = d.day), 0)::int AS downloads,
              COALESCE((SELECT SUM(bot_hits)  FROM site_downloads_daily x WHERE x.day = d.day), 0)::int AS download_bot_hits,
              CASE WHEN d.day >= (now() AT TIME ZONE 'UTC')::date - $2::int THEN
                (SELECT COUNT(*) FROM site_traffic_uniques u WHERE u.day = d.day AND u.scope = 'view')::int
              END AS uniques,
              CASE WHEN d.day >= (now() AT TIME ZONE 'UTC')::date - $2::int THEN
                (SELECT COUNT(*) FROM site_traffic_uniques u WHERE u.day = d.day AND u.scope = 'download')::int
              END AS download_uniques
       FROM d ORDER BY d.day DESC`,
      [span[0], UNIQUES_RETENTION_DAYS],
    ),
    db.query(
      `SELECT path, SUM(views)::int AS views, SUM(bot_hits)::int AS bot_hits
       FROM site_traffic_daily WHERE day >= (now() AT TIME ZONE 'UTC')::date - $1::int
       GROUP BY path ORDER BY SUM(views) DESC, path LIMIT 20`,
      span,
    ),
    db.query(
      `SELECT ref, SUM(views)::int AS views
       FROM site_traffic_daily WHERE day >= (now() AT TIME ZONE 'UTC')::date - $1::int AND ref <> ''
       GROUP BY ref ORDER BY SUM(views) DESC, ref LIMIT 20`,
      span,
    ),
    db.query(
      `SELECT platform, SUM(downloads)::int AS downloads, SUM(bot_hits)::int AS bot_hits
       FROM site_downloads_daily WHERE day >= (now() AT TIME ZONE 'UTC')::date - $1::int
       GROUP BY platform ORDER BY SUM(downloads) DESC, platform`,
      span,
    ),
  ]);

  const rows = daily.rows;
  const sum = (k: string) => rows.reduce((a: number, r: any) => a + (r[k] ?? 0), 0);
  return {
    days,
    uniques_retention_days: UNIQUES_RETENTION_DAYS,
    totals: {
      views: sum('views'),
      uniques: sum('uniques'),
      downloads: sum('downloads'),
      bot_hits: sum('bot_hits') + sum('download_bot_hits'),
    },
    daily: rows,
    top_paths: paths.rows,
    top_refs: refs.rows,
    downloads_by_platform: platforms.rows,
  };
}
