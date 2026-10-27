// Shared stat-derivation for a game_ship_components row — used by both the
// swap-search picker (getShipComponents) and the equipped-slot detail lookup
// (getShipComponentDetails), so the two surfaces always derive the same
// stats for the same data and candidates stay directly comparable.
//
// Field paths below are verified against real scunpacked-data (ship-items.json),
// not guessed — fetched and inspected directly:
//  - stats.Weapon.{EffectiveRange, RateOfFire, Capacity, Damage.{Sustained,Burst}}
//    and stats.Weapon.Modes[0].{RoundsPerMinute, DamagePerSecond, Alpha*, Dps*}
//    all live directly under the item's own stdItem (== our `stats` column).
//  - stats.Ammunition.{Speed, Range} is a sibling of Weapon, not nested under it.
//  - A MissileLauncher rack's OWN stats never carry Weapon/Missile blocks (it's
//    just a mount — confirmed empty on real rack items); the actual damage
//    numbers live on the loaded Missile child item (type: 'Missile'), under
//    stats.Missile.{DamageTotal, Targeting.{LockRangeMin,LockRangeMax,LockTime},
//    ExplosionRadius}. Missiles intentionally get no "dps" field — a per-shot
//    alpha weapon isn't a sustained-fire stat, folding it into total DPS would
//    misrepresent burst ordnance as continuous damage.

const DAMAGE_TYPES = ['Physical', 'Energy', 'Distortion', 'Thermal', 'Biochemical', 'Stun'];

export interface ComponentRow {
  class_name: string;
  type: string | null;
  size: number | null;
  grade: number | null;
  manufacturer_name: string | null;
  item_type_label: string | null;
  item_class: string | null;
  stats: any;
}

export interface ComponentDetail {
  class_name: string;
  size: number | null;
  grade: number | null;
  item_class: string | null;
  manufacturer_name: string | null;
  item_type_label: string | null;
  shield_hp?: number | null;
  shield_regen?: number | null;
  qd_speed?: number | null;
  qd_fuel_rate?: number | null;
  power_output?: number | null;
  cooling_rate?: number | null;
  em: number | null;
  ir: number | null;
  dps: number | null;
  burst_dps: number | null;
  rpm: number | null;
  effective_range: number | null;
  ammo_capacity: number | null;
  projectile_speed: number | null;
  alpha_by_type: Record<string, number>;
  missile: {
    lock_range_min: number | null;
    lock_range_max: number | null;
    lock_time: number | null;
    explosion_radius: number | null;
    damage_total: number | null;
  } | null;
}

export function deriveComponentDetail(row: ComponentRow): ComponentDetail {
  const stats = row.stats || {};
  const weapon = stats?.Weapon;
  const modes = weapon?.Modes?.[0];
  const missileStats = stats?.Missile;

  const alphaByType: Record<string, number> = {};
  for (const t of DAMAGE_TYPES) {
    const v = Number(modes?.[`Alpha${t}`]) || 0;
    if (v > 0) alphaByType[t] = v;
  }

  // The one primary effect stat that actually matters for comparing two
  // components of the same category — verified field paths against real
  // scunpacked-data (ship-items.json), these aren't guessed names.
  let primaryStats: Record<string, number | null> = {};
  if (row.type === 'Shield') {
    primaryStats = { shield_hp: stats?.Shield?.MaxShieldHealth ?? null, shield_regen: stats?.Shield?.MaxShieldRegen ?? null };
  } else if (row.type === 'QuantumDrive') {
    primaryStats = { qd_speed: stats?.QuantumDrive?.StandardJump?.DriveSpeed ?? null, qd_fuel_rate: stats?.QuantumDrive?.FuelConsumptionSCUPerGM ?? null };
  } else if (row.type === 'PowerPlant') {
    primaryStats = { power_output: stats?.ResourceNetwork?.Generation?.Power ?? null };
  } else if (row.type === 'Cooler') {
    primaryStats = { cooling_rate: stats?.ResourceNetwork?.Generation?.Coolant ?? null };
  }

  return {
    class_name: row.class_name,
    size: row.size,
    grade: row.grade,
    item_class: row.item_class,
    manufacturer_name: row.manufacturer_name,
    item_type_label: row.item_type_label,
    ...primaryStats,
    em: stats?.Emission?.Em?.Maximum ?? null,
    ir: stats?.Emission?.Ir ?? null,
    // "Sustained" is the headline number — the fire rate a weapon can
    // actually hold up under capacitor/heat limits, matching how erkul.games
    // presents DPS. Burst (the old DamagePerSecond/Dps field) is kept as a
    // secondary/peak figure, not silently dropped.
    dps: weapon?.Damage?.Sustained ?? modes?.DamagePerSecond ?? null,
    burst_dps: weapon?.Damage?.Burst ?? modes?.DamagePerSecond ?? null,
    rpm: modes?.RoundsPerMinute ?? weapon?.RateOfFire ?? null,
    effective_range: weapon?.EffectiveRange ?? stats?.Ammunition?.Range ?? null,
    ammo_capacity: weapon?.Capacity ?? null,
    projectile_speed: stats?.Ammunition?.Speed ?? null,
    alpha_by_type: alphaByType,
    missile: missileStats ? {
      lock_range_min: missileStats?.Targeting?.LockRangeMin ?? null,
      lock_range_max: missileStats?.Targeting?.LockRangeMax ?? null,
      lock_time: missileStats?.Targeting?.LockTime ?? null,
      explosion_radius: missileStats?.ExplosionRadius?.Maximum ?? null,
      damage_total: missileStats?.DamageTotal ?? null,
    } : null,
  };
}
