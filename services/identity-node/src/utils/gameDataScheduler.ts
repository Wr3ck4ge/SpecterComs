import { pool } from '../config/db.js';
import { syncStarCitizenShips } from './fleetyardsSync.js';
import { syncStarCitizenComponents } from './shipComponentsSync.js';
import { refreshShipData } from './scunpackedSync.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Give the process a minute to finish booting (DB pool, other startup tasks)
// before kicking off the first sync, rather than racing them at import time.
const INITIAL_DELAY_MS = 60 * 1000;

// The three game-data sources each had their own lazy, request-triggered
// staleness check (fleetyardsSync: 24h, shipComponentsSync: 7d,
// scunpackedSync: none at all — see its own comments) — meaning data only
// ever refreshed if and when a user happened to hit an endpoint after it
// went stale, and per-ship loadout/combat data never refreshed on its own.
// This runs all three unconditionally once a day so the catalog and every
// cached ship's loadout stay current with upstream (scunpacked-data /
// fleetyards.net) regardless of request traffic.
async function syncAllGameData(): Promise<void> {
  console.log('[gameDataScheduler] starting daily Star Citizen data sync...');

  try {
    await syncStarCitizenShips();
  } catch (err) {
    console.error('[gameDataScheduler] syncStarCitizenShips failed:', err);
  }

  try {
    await syncStarCitizenComponents();
  } catch (err) {
    console.error('[gameDataScheduler] syncStarCitizenComponents failed:', err);
  }

  try {
    // Scoped to ships that already have cached loadout/combat data — not the
    // full fleetyards catalog (game_ships holds every Star Citizen ship
    // model, ~150-200+, most of which no user has ever opened). Refreshing
    // only what's actually cached keeps this a "keep served data current"
    // job, not an unrelated whole-catalog pre-warm.
    const { rows } = await pool.query(
      `SELECT slug FROM game_ships WHERE game = 'star_citizen' AND crew_roles IS NOT NULL`
    );
    let refreshed = 0;
    for (const { slug } of rows) {
      try {
        await refreshShipData('star_citizen', slug);
        refreshed++;
      } catch (err) {
        console.error(`[gameDataScheduler] refreshShipData failed for ${slug}:`, err);
      }
    }
    console.log(`[gameDataScheduler] refreshed ${refreshed}/${rows.length} cached ships' loadout/combat data.`);
  } catch (err) {
    console.error('[gameDataScheduler] failed to list cached ships:', err);
  }

  console.log('[gameDataScheduler] daily sync complete.');
}

export function startGameDataSyncScheduler(): void {
  setTimeout(() => { syncAllGameData(); }, INITIAL_DELAY_MS);
  setInterval(() => { syncAllGameData(); }, DAY_MS);
}
