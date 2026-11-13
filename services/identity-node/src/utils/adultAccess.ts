/**
 * L11: adult (18+) channels. Where they are available, and who may enter.
 *
 * Owner decision 2026-11-12: adult channels are not offered where the law
 * requires third-party / ID age verification. We don't do ID checks, so in a
 * restricted place the feature is simply absent: adult channels are hidden,
 * the toggle isn't offered, attest and join are refused.
 *
 * Availability, evaluated per request:
 *   1. ADULT_CHANNELS_ENABLED must be 'true' (default off until reviewed).
 *   2. The requester's region comes from a LOCAL GeoIP lookup of the request
 *      IP (an interface, see GeoResolver). The IP and the region are used for
 *      this one decision only: never stored, never logged.
 *   3. ADULT_RESTRICTED_REGIONS (comma list: 'GB', 'FR', 'US-TX', ...) names
 *      the places where it is off. Read on every call, so it can change with
 *      a container restart and no build.
 *   FAIL CLOSED: no resolver, no database, an unknown IP or any lookup error
 *   all count as restricted.
 */
import { pool } from '../config/db.js';

export const ADULT_UNAVAILABLE_IN_REGION = 'ADULT_UNAVAILABLE_IN_REGION';
export const ADULT_ATTESTATION_REQUIRED = 'ADULT_ATTESTATION_REQUIRED';

export interface GeoRegion { country: string; region?: string }
/** A local lookup. Returns null when the address is unknown. May be async. */
export type GeoResolver = (ip: string) => GeoRegion | null | Promise<GeoRegion | null>;

let resolver: GeoResolver | null | undefined; // undefined = not yet loaded

/** Tests (and a future MaxMind-reader swap) install their own resolver. */
export function setGeoResolver(r: GeoResolver | null | undefined): void { resolver = r; }

/**
 * Default resolver: the optional `geoip-lite` package (bundled MaxMind
 * GeoLite database, read in-process, no network call). Not installed or no
 * data -> null resolver -> every region counts as restricted.
 */
async function loadDefaultResolver(): Promise<GeoResolver | null> {
  try {
    const name = 'geoip-lite'; // variable so tsc doesn't require the optional module
    const mod: any = await import(name);
    const lookup = (mod.default ?? mod).lookup as ((ip: string) => { country?: string; region?: string } | null) | undefined;
    if (typeof lookup !== 'function') return null;
    return (ip) => {
      const r = lookup(ip);
      return r && r.country ? { country: r.country, region: r.region || undefined } : null;
    };
  } catch {
    return null;
  }
}

export const adultChannelsEnabled = (): boolean => (process.env.ADULT_CHANNELS_ENABLED || '').trim().toLowerCase() === 'true';

/** 'GB' (whole country) or 'US-TX' (one state), upper-cased. */
export function parseRestrictedRegions(raw: string | undefined): string[] {
  return (raw || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

/** Pure: is this place restricted? Unknown (null) is restricted. */
export function isRegionRestricted(geo: GeoRegion | null, list: string[]): boolean {
  if (!geo || !geo.country) return true;
  const c = geo.country.toUpperCase();
  if (list.includes(c)) return true;
  return geo.region ? list.includes(`${c}-${geo.region.toUpperCase()}`) : false;
}

const stripV6Prefix = (ip: string) => ip.replace(/^::ffff:/i, '');

/** Are adult channels available to the requester at this IP right now? */
export async function adultAvailableForIp(ip: string | undefined): Promise<boolean> {
  if (!adultChannelsEnabled()) return false;
  if (!ip) return false;
  try {
    if (resolver === undefined) resolver = await loadDefaultResolver();
    if (!resolver) return false;
    const geo = await resolver(stripV6Prefix(ip));
    return !isRegionRestricted(geo, parseRestrictedRegions(process.env.ADULT_RESTRICTED_REGIONS));
  } catch {
    return false;
  }
}

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function hasAttested(orgId: string, userId: string, db: Queryable = pool): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM org_adult_attestations WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
  return r.rows.length > 0;
}

/** Of `userIds`, those who attested for this org (for an adult channel's MLS audience). */
export async function filterAttested(orgId: string, userIds: string[], db: Queryable = pool): Promise<string[]> {
  if (userIds.length === 0) return [];
  const r = await db.query(
    'SELECT user_id FROM org_adult_attestations WHERE org_id = $1 AND user_id = ANY($2::uuid[])',
    [orgId, userIds],
  );
  const ok = new Set(r.rows.map((x: any) => x.user_id));
  return userIds.filter((u) => ok.has(u));
}

/**
 * Request-level gate for entering an adult channel (presence join, media
 * ticket, sends, MLS reads). Returns null when fine (including for a channel
 * that isn't adult) or the refusal to send as a 403.
 */
export async function adultRegionRefusal(
  scope: { scope: string; adult?: boolean },
  ip: string | undefined,
): Promise<{ code: string; message: string } | null> {
  if (scope.scope !== 'org' || !scope.adult) return null;
  if (!(await adultAvailableForIp(ip))) {
    return { code: ADULT_UNAVAILABLE_IN_REGION, message: 'Adult channels are not available in your region' };
  }
  return null;
}
