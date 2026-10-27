import { pool } from '../config/db.js';

// fleetyards.net's public v1 API — documented, generously rate-limited
// (5000 req/period as of writing), and explicitly meant for third-party
// consumption like this (unlike hotlinking RSI's own undocumented image
// URLs). See docs/ discussion for why this was picked over scunpacked-data,
// which has ship stats but no images/icons of any kind.
const FLEETYARDS_MODELS_URL = 'https://api.fleetyards.net/v1/models?perPage=all';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Only Star Citizen is wired up for v1, but keyed by `game` throughout so a
// second game's sync function can be added alongside this one later without
// touching the schema or the search endpoint.
type SyncFn = () => Promise<void>;
const SYNC_FNS: Record<string, SyncFn> = {
  star_citizen: syncStarCitizenShips,
};

// Coalesces concurrent staleness-triggered syncs for the same game into a
// single in-flight fetch, so a burst of simultaneous searches on a cold
// cache doesn't each kick off their own ~5MB fetch + 243-row upsert.
const inFlight: Record<string, Promise<void> | undefined> = {};

async function isStale(game: string): Promise<boolean> {
  const res = await pool.query(`SELECT MAX(updated_at) AS last FROM game_ships WHERE game = $1`, [game]);
  const last = res.rows[0]?.last;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > STALE_AFTER_MS;
}

export async function syncStarCitizenShips(): Promise<void> {
  const res = await fetch(FLEETYARDS_MODELS_URL);
  if (!res.ok) {
    console.error(`fleetyardsSync: GET /v1/models failed with status ${res.status}`);
    return;
  }
  const body = (await res.json()) as { items?: any[] };
  const items = body.items || [];

  for (const item of items) {
    const slug = item.slug;
    const name = item.name;
    if (!slug || !name) continue;

    await pool.query(
      `INSERT INTO game_ships (game, slug, name, manufacturer_name, manufacturer_code, classification, icon_url, updated_at)
       VALUES ('star_citizen', $1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (game, slug) DO UPDATE SET
         name = $2, manufacturer_name = $3, manufacturer_code = $4, classification = $5, icon_url = $6, updated_at = NOW()`,
      [
        slug,
        name,
        item.manufacturer?.name || null,
        item.manufacturer?.code || null,
        item.classificationLabel || item.classification || null,
        item.media?.angledView?.smallUrl || null,
      ]
    );
  }
  console.log(`fleetyardsSync: upserted ${items.length} Star Citizen ships`);
}

/**
 * Ensures the local game_ships cache for `game` is populated and not stale,
 * syncing lazily (and only once per cold/stale cache, not once per caller)
 * if needed. Safe to call on every search request — a fresh cache is a
 * cheap no-op MAX(updated_at) check. Unknown games are a no-op.
 */
export async function ensureGameShipsFresh(game: string): Promise<void> {
  const syncFn = SYNC_FNS[game];
  if (!syncFn) return;
  if (!(await isStale(game))) return;

  if (!inFlight[game]) {
    inFlight[game] = syncFn().finally(() => { inFlight[game] = undefined; });
  }
  await inFlight[game];
}
