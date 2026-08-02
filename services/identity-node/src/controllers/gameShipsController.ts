import { Response } from 'express';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { ensureGameShipsFresh } from '../utils/fleetyardsSync.js';
import { ensureShipDataFresh } from '../utils/scunpackedSync.js';
import { ensureComponentCatalogFresh } from '../utils/shipComponentsSync.js';
import { deriveComponentDetail } from '../utils/componentDetail.js';

const SUPPORTED_GAMES = new Set(['star_citizen']);

// ── GET /game-ships?game=star_citizen&q=avenger ──────────────────────────────
export const searchGameShips = async (req: AuthRequest, res: Response) => {
  const game = String(req.query.game || '');
  const q = String(req.query.q || '').trim();

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }

  try {
    await ensureGameShipsFresh(game);

    const result = q
      ? await pool.query(
          `SELECT slug, name, manufacturer_name, manufacturer_code, classification, icon_url
           FROM game_ships WHERE game = $1 AND name ILIKE $2
           ORDER BY name ASC LIMIT 20`,
          [game, `%${q}%`]
        )
      : await pool.query(
          `SELECT slug, name, manufacturer_name, manufacturer_code, classification, icon_url
           FROM game_ships WHERE game = $1
           ORDER BY name ASC LIMIT 20`,
          [game]
        );

    res.json({ ships: result.rows });
  } catch (err) {
    console.error('searchGameShips error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── GET /game-ships/crew-roles?game=star_citizen&slug=aegs-idris-m ───────────
export const getShipCrewRoles = async (req: AuthRequest, res: Response) => {
  const game = String(req.query.game || '');
  const slug = String(req.query.slug || '').trim();

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }
  if (!slug) return res.status(400).json({ message: 'Missing slug' });

  try {
    const data = await ensureShipDataFresh(game, slug);
    res.json({ roles: data?.crew_roles || [] });
  } catch (err) {
    console.error('getShipCrewRoles error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── GET /game-ships/seats?game=star_citizen&slug=aegs-idris-m ────────────────
export const getShipSeats = async (req: AuthRequest, res: Response) => {
  const game = String(req.query.game || '');
  const slug = String(req.query.slug || '').trim();

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }
  if (!slug) return res.status(400).json({ message: 'Missing slug' });

  try {
    const data = await ensureShipDataFresh(game, slug);
    res.json({ seats: data?.raw_seats || [] });
  } catch (err) {
    console.error('getShipSeats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── GET /game-ships/loadout?game=star_citizen&slug=aegs-idris-m ──────────────
export const getShipLoadout = async (req: AuthRequest, res: Response) => {
  const game = String(req.query.game || '');
  const slug = String(req.query.slug || '').trim();

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }
  if (!slug) return res.status(400).json({ message: 'Missing slug' });

  try {
    const data = await ensureShipDataFresh(game, slug);
    res.json({ loadout: data?.stock_loadout || [] });
  } catch (err) {
    console.error('getShipLoadout error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── GET /game-ships/combat-stats?game=star_citizen&slug=aegs-idris-m ─────────
export const getShipCombatStats = async (req: AuthRequest, res: Response) => {
  const game = String(req.query.game || '');
  const slug = String(req.query.slug || '').trim();

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }
  if (!slug) return res.status(400).json({ message: 'Missing slug' });

  try {
    const data = await ensureShipDataFresh(game, slug);
    res.json({ combat_stats: data?.combat_stats || null });
  } catch (err) {
    console.error('getShipCombatStats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── GET /game-ships/dimensions?game=star_citizen&slug=aegs-idris-m ───────────
// Kept separate from combat-stats since it's used by a different, lighter
// concern (map-icon scaling) that doesn't need the rest of the payload.
export const getShipDimensions = async (req: AuthRequest, res: Response) => {
  const game = String(req.query.game || '');
  const slug = String(req.query.slug || '').trim();

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }
  if (!slug) return res.status(400).json({ message: 'Missing slug' });

  try {
    const data = await ensureShipDataFresh(game, slug);
    res.json({ dimensions: data?.combat_stats?.dimensions || null });
  } catch (err) {
    console.error('getShipDimensions error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Weapons and the flight computer (FlightController) can be under-sized for
// their mount — a size-2 gun fits a size-3 hardpoint — matching how Star
// Citizen actually lets you equip those two categories. Every other
// component type (shields, coolers, power plants, quantum/jump drives,
// radar, life support) must be an exact size match; there's no such thing
// as a "smaller" shield fitting a bigger shield generator slot.
const FLEXIBLE_SIZE_TYPES = new Set(['WeaponGun', 'Turret', 'MissileLauncher', 'FlightController']);

// ── GET /game-ships/components?game=star_citizen&type=WeaponGun&size=4&q=revenant&dmg_type=Energy&family=Cannon ──
export const getShipComponents = async (req: AuthRequest, res: Response) => {
  const game = String(req.query.game || '');
  const type = String(req.query.type || '').trim();
  const q = String(req.query.q || '').trim();
  const dmgType = String(req.query.dmg_type || '').trim();
  const family = String(req.query.family || '').trim();
  const sizeRaw = req.query.size !== undefined ? parseInt(String(req.query.size), 10) : NaN;

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }

  try {
    await ensureComponentCatalogFresh(game);

    const conditions = ['game = $1'];
    const params: any[] = [game];
    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }
    if (!Number.isNaN(sizeRaw)) {
      params.push(sizeRaw);
      const exactFit = type && !FLEXIBLE_SIZE_TYPES.has(type);
      conditions.push(exactFit
        ? `(size IS NULL OR size = $${params.length})`
        : `(size IS NULL OR size <= $${params.length})`);
    }
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }
    if (dmgType) {
      params.push(dmgType);
      conditions.push(`dmg_type = $${params.length}`);
    }
    if (family) {
      params.push(family);
      conditions.push(`weapon_family = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT class_name, name, type, sub_type, size, grade, manufacturer_name, manufacturer_code, item_type_label, item_class, weapon_family, dmg_type, stats
       FROM game_ship_components WHERE ${conditions.join(' AND ')}
       ORDER BY name ASC LIMIT 30`,
      params
    );
    // Same derivation the equipped-slot detail view uses (see
    // getShipComponentDetails below) — the swap-search picker used to only
    // surface a hand-rolled DPS/Alpha subset here, meaning candidates and
    // the already-equipped part showed different levels of detail for the
    // exact same data. Merge derived fields onto the raw picker-only ones
    // (name/sub_type/weapon_family/dmg_type/manufacturer_code) instead of
    // replacing them.
    const components = result.rows.map(row => ({
      ...row,
      ...deriveComponentDetail(row),
    }));
    res.json({ components });
  } catch (err) {
    console.error('getShipComponents error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── GET /game-ships/component-details?game=star_citizen&class_names=a,b,c ──
// Batch lookup for the loadout tree's weapon rows: size/type-label/alpha
// breakdown for a specific set of equipped class_names, resolved client-side
// after stock loadout + overrides are merged (so a swapped weapon's stats
// show immediately without a second stock-loadout round trip).
export const getShipComponentDetails = async (req: AuthRequest, res: Response) => {
  const game = String(req.query.game || '');
  const classNames = String(req.query.class_names || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }
  if (classNames.length === 0) return res.json({ components: [] });

  try {
    const result = await pool.query(
      `SELECT class_name, type, size, grade, manufacturer_name, item_type_label, item_class, stats
       FROM game_ship_components WHERE game = $1 AND class_name = ANY($2::text[])`,
      [game, classNames]
    );

    const components = result.rows.map(deriveComponentDetail);

    res.json({ components });
  } catch (err) {
    console.error('getShipComponentDetails error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

const DAMAGE_TYPES = ['Physical', 'Energy', 'Distortion', 'Thermal', 'Biochemical', 'Stun'];

// ── POST /game-ships/damage-estimate ──────────────────────────────────────────
// Approximate time-to-kill: sums the attacker's currently-equipped guns'
// DPS-by-damage-type (split from each weapon's own Alpha ratios), then
// applies the target's shield Resistance and hull Armor.DamageMultipliers.
// This is NOT a flight-model-accurate simulator — no angle, range, or
// penetration modeling, no shield Absorption bleed-through nuance — just a
// reasonable comparative estimate, framed as such in the response.
export const getDamageEstimate = async (req: AuthRequest, res: Response) => {
  const game = String(req.body?.game || '');
  const attackerLoadout: string[] = Array.isArray(req.body?.attacker_loadout) ? req.body.attacker_loadout : [];
  const targetSlug = String(req.body?.target_slug || '').trim();

  if (!SUPPORTED_GAMES.has(game)) {
    return res.status(400).json({ message: 'Unsupported or missing game' });
  }
  if (!targetSlug) return res.status(400).json({ message: 'Missing target_slug' });
  if (attackerLoadout.length === 0) {
    return res.status(400).json({ message: 'No weapons in attacker_loadout' });
  }

  try {
    // Guns and missiles both come through as class_names in attacker_loadout
    // (see CombatTab's walk() in ShipEditor.jsx, which now descends into
    // MissileLauncher racks to collect their loaded Missile children too —
    // a missile rack's own component row carries no damage stats at all,
    // only the loaded missile item does). Missile damage is one-time
    // ordnance, not sustained fire, so it's kept out of the dps/dpsByType
    // sums entirely and reported separately as a payload total instead of
    // being misrepresented as continuous DPS.
    const compRes = await pool.query(
      `SELECT class_name, type, stats FROM game_ship_components WHERE game = $1 AND type IN ('WeaponGun', 'Missile') AND class_name = ANY($2::text[])`,
      [game, attackerLoadout]
    );

    const dpsByType: Record<string, number> = {};
    const burstDpsByType: Record<string, number> = {};
    let totalDps = 0;
    let totalBurstDps = 0;
    let missileCount = 0;
    let missileAlphaTotal = 0;
    for (const row of compRes.rows) {
      if (row.type === 'Missile') {
        const total = Number(row.stats?.Missile?.DamageTotal) || 0;
        if (total > 0) { missileCount++; missileAlphaTotal += total; }
        continue;
      }
      const weapon = row.stats?.Weapon;
      const modes = weapon?.Modes?.[0];
      const sustainedDps = Number(weapon?.Damage?.Sustained ?? modes?.DamagePerSecond) || 0;
      const burstDps = Number(weapon?.Damage?.Burst ?? modes?.DamagePerSecond) || 0;
      if (sustainedDps <= 0 && burstDps <= 0) continue;
      const alphaByType = DAMAGE_TYPES.map(t => Number(modes?.[`Alpha${t}`]) || 0);
      const alphaTotal = alphaByType.reduce((a, b) => a + b, 0);
      DAMAGE_TYPES.forEach((t, i) => {
        const share = alphaTotal > 0 ? alphaByType[i] / alphaTotal : 0;
        dpsByType[t] = (dpsByType[t] || 0) + sustainedDps * share;
        burstDpsByType[t] = (burstDpsByType[t] || 0) + burstDps * share;
      });
      totalDps += sustainedDps;
      totalBurstDps += burstDps;
    }

    const targetData = await ensureShipDataFresh(game, targetSlug);
    const combatStats = targetData?.combat_stats;
    if (!combatStats) {
      return res.status(404).json({ message: 'No combat data available for target ship' });
    }

    let shieldSeconds = 0;
    if (combatStats.shields && combatStats.shields.hp > 0) {
      let effectiveShieldDps = 0;
      for (const t of DAMAGE_TYPES) {
        const raw = dpsByType[t] || 0;
        if (raw <= 0) continue;
        const range = combatStats.shields.resistance?.[t];
        const resistance = range ? (range.min + range.max) / 2 : 0;
        effectiveShieldDps += raw * (1 - resistance);
      }
      shieldSeconds = effectiveShieldDps > 0 ? combatStats.shields.hp / effectiveShieldDps : Infinity;
    }

    let effectiveHullDps = 0;
    for (const t of DAMAGE_TYPES) {
      const raw = dpsByType[t] || 0;
      if (raw <= 0) continue;
      const multiplier = combatStats.armor?.damage_multipliers?.[t] ?? 1;
      effectiveHullDps += raw * multiplier;
    }
    const hullSeconds = effectiveHullDps > 0 ? combatStats.health / effectiveHullDps : Infinity;

    res.json({
      total_dps: totalDps,
      total_burst_dps: totalBurstDps,
      dps_mode: 'sustained',
      dps_by_type: dpsByType,
      burst_dps_by_type: burstDpsByType,
      missile_payload: missileCount > 0 ? { count: missileCount, total_alpha: missileAlphaTotal } : null,
      shield_seconds: shieldSeconds,
      hull_seconds: hullSeconds,
      total_seconds: shieldSeconds + hullSeconds,
      note: 'Approximate — sustained-fire DPS only; does not model angle of incidence, range falloff, or penetration. Missile/torpedo payload is shown separately as one-time ordnance, not folded into time-to-kill.',
    });
  } catch (err) {
    console.error('getDamageEstimate error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};
