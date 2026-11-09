import { pool } from '../config/db.js';

// Ship-equippable component catalog, synced from scunpacked-data's
// ship-items.json — a repo-root file (~28MB / 5,384 items) already
// pre-filtered to ship-usable items, unlike the site's items.json which is
// every game item including FPS wearables. This is a bulk sync (one big
// fetch, loop-upsert), not per-ship lazy like scunpackedSync.ts — there's
// only one file to fetch regardless of how many ships/components exist.
const SHIP_ITEMS_URL = 'https://raw.githubusercontent.com/StarCitizenWiki/scunpacked-data/master/ship-items.json';

// Purely cosmetic categories — not real loadout components, excluded so the
// swap dropdown isn't cluttered with paint jobs and interior decorations.
const EXCLUDED_TYPES = new Set(['Paints', 'Flair_Surface', 'Flair_Wall', 'Flair_Floor', 'Flair_Cockpit']);

// Weekly — the component catalog only changes on game patches, unlike
// per-ship media URLs that might rotate more often.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

let inFlight: Promise<void> | undefined;

async function isStale(game: string): Promise<boolean> {
  const res = await pool.query(`SELECT MAX(updated_at) AS last FROM game_ship_components WHERE game = $1`, [game]);
  const last = res.rows[0]?.last;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() > STALE_AFTER_MS;
}

// Keep the whole stdItem (weapon/shield/power-plant/etc. stat blocks live
// under type-specific keys we don't need to hand-map) minus verbose flavor
// text that only bloats storage.
function extractStats(stdItem: any): Record<string, unknown> {
  const { Description, DescriptionText, DescriptionData, ...rest } = stdItem || {};
  return rest;
}

// Description's first line is always "Manufacturer: X", its second is
// "Item Type: X" (e.g. "Laser Scattergun", "Ballistic Repeater") -- the only
// human-readable weapon-family label scunpacked provides anywhere. Pull it
// out before extractStats() strips Description away.
function extractItemTypeLabel(description: unknown): string | null {
  if (typeof description !== 'string') return null;
  const match = description.match(/Item Type:\s*([^\n\r]+)/);
  return match ? match[1].trim() : null;
}

// "Class: X" (Civilian/Industrial/Competition/Military/Stealth/etc.) — a
// quality/role tier distinct from the numeric grade (which maps directly to
// a letter grade A-D: grade 1="A" ... 4="D", verified against real data, no
// separate field needed for that one). Class only ever appears as a parsed
// line inside the description text, so it must be pulled out here too,
// before extractStats() strips Description away.
function extractItemClass(description: unknown): string | null {
  if (typeof description !== 'string') return null;
  const match = description.match(/Class:\s*([^\n\r]+)/);
  return match ? match[1].trim() : null;
}

// Last word of the item-type label buckets weapons into the small set of
// families search filters actually care about ("Laser Scattergun" ->
// "Scattergun", "Ballistic Repeater" -> "Repeater", "Neutron Cannon" ->
// "Cannon") without hand-maintaining a manufacturer/tech-name map.
//
// "Last word" alone breaks on a handful of real labels in the live catalog:
// a trailing parenthetical becomes the
// "family" ("Ballistic Gatling (x2)" -> "(x2)", "Turret (Reliant Exclusive)"
// -> "Exclusive)"), an upstream typo splits one family in two ("Plasma
// Canon" -> "Canon", separate from the 7 correctly-spelled "Cannon" items),
// and an inconsistent suffix loses the real family word ("Ballistic Gatling
// Gun" -> "Gun", instead of bucketing with every other "Ballistic Gatling
// ___" item under "Gatling").
function extractWeaponFamily(itemTypeLabel: string | null): string | null {
  if (!itemTypeLabel) return null;
  const cleaned = itemTypeLabel.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] || null;
  if (!last) return null;
  if (/^canon$/i.test(last)) return 'Cannon';
  if (/^gun$/i.test(last) && words.length > 1) return words[words.length - 2];
  return last;
}

const DAMAGE_TYPES = ['Physical', 'Energy', 'Distortion', 'Thermal', 'Biochemical', 'Stun'];

// Guns deal one dominant damage type in practice -- whichever Alpha{Type} is
// largest on the weapon's first fire mode -- used as the ENERGY/BALLISTIC/
// DISTORTION filter and badge in the swap search.
function extractDmgType(stdItem: any): string | null {
  const modes = stdItem?.Weapon?.Modes?.[0];
  if (!modes) return null;
  let best: string | null = null;
  let bestVal = 0;
  for (const t of DAMAGE_TYPES) {
    const v = Number(modes[`Alpha${t}`]) || 0;
    if (v > bestVal) { bestVal = v; best = t; }
  }
  return best;
}

export async function syncStarCitizenComponents(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(SHIP_ITEMS_URL);
  } catch (err) {
    console.error('shipComponentsSync: fetch failed:', err);
    return;
  }
  if (!res.ok) {
    console.error(`shipComponentsSync: GET ship-items.json failed with status ${res.status}`);
    return;
  }

  const items = (await res.json()) as any[];
  let upserted = 0;

  for (const item of items) {
    const type = item.type;
    if (!type || EXCLUDED_TYPES.has(type)) continue;
    const className = item.className;
    const name = item.name;
    if (!className || !name) continue;

    const stdItem = item.stdItem || {};
    const manufacturer = stdItem.Manufacturer || {};
    const itemTypeLabel = extractItemTypeLabel(stdItem.Description);
    const weaponFamily = extractWeaponFamily(itemTypeLabel);
    const dmgType = extractDmgType(stdItem);
    const itemClass = extractItemClass(stdItem.Description);

    await pool.query(
      `INSERT INTO game_ship_components
         (game, class_name, name, type, sub_type, size, grade, manufacturer_name, manufacturer_code, compatible_types, item_type_label, weapon_family, dmg_type, item_class, stats, updated_at)
       VALUES ('star_citizen', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
       ON CONFLICT (game, class_name) DO UPDATE SET
         name = $2, type = $3, sub_type = $4, size = $5, grade = $6,
         manufacturer_name = $7, manufacturer_code = $8, compatible_types = $9,
         item_type_label = $10, weapon_family = $11, dmg_type = $12, item_class = $13, stats = $14, updated_at = NOW()`,
      [
        className,
        name,
        type,
        item.subType || null,
        item.size ?? null,
        item.grade ?? null,
        manufacturer.Name || null,
        manufacturer.Code || null,
        JSON.stringify(stdItem.Ports || []),
        itemTypeLabel,
        weaponFamily,
        dmgType,
        itemClass,
        JSON.stringify(extractStats(stdItem)),
      ]
    );
    upserted++;
  }
  console.log(`shipComponentsSync: upserted ${upserted} Star Citizen components`);
}

export async function ensureComponentCatalogFresh(game: string): Promise<void> {
  if (game !== 'star_citizen') return;
  if (!(await isStale(game))) return;

  if (!inFlight) {
    inFlight = syncStarCitizenComponents().finally(() => { inFlight = undefined; });
  }
  await inFlight;
}
