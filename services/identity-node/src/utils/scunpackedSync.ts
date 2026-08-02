import { pool } from '../config/db.js';

// Per-ship seat + loadout data, datamined from StarCitizenWiki/scunpacked-data.
// One raw-GitHub fetch per ship (not a bulk sync like fleetyardsSync — there's
// no list endpoint, and files run ~1MB+, so this is lazy/on-demand and cached
// indefinitely once fetched: seat/port layout is part of a ship's core design
// and doesn't drift like a media URL might.
const SCUNPACKED_SHIPS_BASE = 'https://raw.githubusercontent.com/StarCitizenWiki/scunpacked-data/master/ships/';

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  Captain: 'Captain',
  Helmsman: 'Pilot',
  CoHelmsman: 'Co-Pilot',
  Turret: 'Turret Gunner',
  Bridge: 'Bridge Officer',
  Operator: 'Operator',
  Gunner: 'Gunner',
  MiningOperator: 'Mining Operator',
  RemoteTurretOperator: 'Remote Turret Operator',
  TorpedoOperator: 'Torpedo Operator',
  Engineering: 'Lead Engineer',
};

// Fixed generation order for crew_roles output — mission planning wants
// Captain/Pilot/Co-Pilot filled first, then weapon stations, then the
// catch-all. "Additional Crew" is always appended last (built separately
// below), so it isn't listed here.
const ROLE_ORDER = ['Captain', 'Helmsman', 'CoHelmsman', 'Turret', 'RemoteTurretOperator', 'TorpedoOperator', 'Engineering'];

function humanizeSegment(seg: string): string {
  return seg
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Class names look like "<MFG>_<Ship>_SCItem_Seat_<Label>" or
// "..._SCItem_Turret_<Label>" — take whatever follows the last Seat_/Turret_
// marker as the human-facing seat label. Falls back to the hardpoint name's
// tail if the class name doesn't match that shape.
function deriveSeatLabel(className: string, hardpointName: string): string {
  const source = className || hardpointName || '';
  const match = source.match(/(?:Seat|Turret)_(.+)$/);
  const raw = match ? match[1] : source.split('_').slice(-2).join('_');
  return humanizeSegment(raw) || 'Seat';
}

export function roleDisplayName(role: string): string {
  return ROLE_DISPLAY_NAMES[role] || humanizeSegment(role);
}

// Only these seat roles are meaningful as named crew stations. Bridge
// stations (Comms/Tactical/Science/Security) exist but are too granular to
// be useful as individually-named slots. Anything not in this set gets
// folded into one generic "Extra Crew" bucket — mission-dependent roles
// (medic, etc.) the planner assigns by hand, not from data.
//
// RemoteTurretOperator/TorpedoOperator/Engineering aren't raw `Role` values
// the game data ever uses directly: torpedo consoles and remote-turret seats
// are tagged plain "Turret" (distinguished only by "Torpedo"/"MissileOnly"/
// "Remote"/"Support_Seat" substrings in their ClassName/HardpointName), and
// an engineering console is sometimes tagged "Engineering" directly and
// sometimes mistagged "Turret" with "Engineer" in the name instead.
// classifySeatRole() below reclassifies seats into these three synthetic
// roles before grouping.
const CORE_SEAT_ROLES = new Set(['Captain', 'Helmsman', 'CoHelmsman', 'Turret', 'RemoteTurretOperator', 'TorpedoOperator', 'Engineering']);
// Captain/Pilot are logically one-seat positions — some ships' datamined
// seat data tags extra generic bridge chairs (e.g. unlabeled "No Armrests"
// seats near the captain's chair) with the same Role, which would otherwise
// wrongly inflate that role to several slots.
//
// CoHelmsman/TorpedoOperator/Engineering are deliberately NOT singular
// (unlike the two above) — a full data audit (2026-07-28) found real ships
// with more than one genuine seat of each, and the singular collapse was
// silently discarding whichever one the raw JSON happened to list second:
//  - CoHelmsman: the Carrack has two distinct co-pilot seats
//    (ANVL_Carrack_SCItem_Seat_CoPilot on both hardpoint_seat_copilot_l and
//    _r) and the Constellation family (Andromeda/Aquila/Phoenix/Taurus) has
//    CoPilot_Left/CoPilot_Right — both real, both meant to be crewed.
//  - TorpedoOperator: the Polaris has two coordinated torpedo seats
//    (RSI_Polaris_Torpedo_Console + RSI_Polaris_Seat_Bridge_MissileOnly) —
//    the collapse meant losing the actual, explicitly-named torpedo console
//    itself.
//  - Engineering: the Carrack has 5 real Engineering-tagged stations
//    (bridge console, cart console, both drone operator seats, support
//    seat), the Reclaimer has an Engineer Console plus two distinct
//    Scanning Consoles, and the Caterpillar's real
//    hardpoint_seat_engineering was losing to its tractor-beam seat.
// Treated the same as Turret: legitimately multi-seat, not a data quirk to
// collapse away.
const SINGULAR_SEAT_ROLES = new Set(['Captain', 'Helmsman']);
const ADDITIONAL_CREW_ROLE = 'AdditionalCrew';

// Reclassifies a raw seat's `Role` into one of the synthetic roles above
// when its ClassName/HardpointName gives it away — see the CORE_SEAT_ROLES
// comment for the real-data evidence behind each pattern. Falls through to
// the seat's own Role unchanged for every ordinary case.
function classifySeatRole(seat: any): string {
  const role = seat?.Role;
  const text = `${seat?.ClassName || ''} ${seat?.HardpointName || ''}`;
  // A seat literally named "Passenger" is never a real crew station no
  // matter what Role the raw data tags it with — seen mistagged as
  // Role:"Engineering" (Freelancer's rear passenger seats) and as
  // Role:"Helmsman" (Greycat UTV's passenger seat, sharing the exact Role of
  // its own driver seat — without this guard the singular-seat collapse
  // could pick the passenger seat over the real driver seat on array order
  // alone). Excluded up front so it always falls through to the generic
  // Extra Crew bucket instead of stealing a named station.
  if (/passenger/i.test(text) && (role === 'Helmsman' || role === 'CoHelmsman' || role === 'Engineering' || role === 'Captain')) {
    return 'Passenger';
  }
  if (role === 'Engineering' || /engineer/i.test(text)) return 'Engineering';
  if (role === 'Helmsman' || role === 'CoHelmsman') {
    // Some ships tag Pilot/Co-Pilot/Gunner seats all with the same
    // Role:"Helmsman" instead of the usual Helmsman/CoHelmsman/Turret split
    // (seen on the Zeus Mk II CL/ES, Perseus, and Drake Command Module) —
    // the ClassName/HardpointName still names each seat correctly, so use
    // that to route it to its real station instead of letting the
    // singular-seat collapse below arbitrarily keep whichever one the raw
    // JSON lists first (which was handing the Pilot slot to the co-pilot or
    // gunner seat on more than one ship).
    if (/co.?pilot/i.test(text)) return 'CoHelmsman';
    if (/gunner/i.test(text)) return 'Turret';
    return role;
  }
  if (role === 'Turret') {
    if (/torpedo|missile.?only/i.test(text)) return 'TorpedoOperator';
    if (/remote|support_seat/i.test(text)) return 'RemoteTurretOperator';
  }
  return role;
}

interface CrewRoleGroup {
  role: string;
  display_name: string;
  count: number;
  seat_labels: string[];
  is_commander_candidate: boolean;
}

interface RawSeat {
  hardpoint_name: string;
  role: string;
  role_display: string;
  seat_label: string;
}

interface LoadoutNode {
  port_id?: string;
  hardpoint_name?: string;
  name?: string;
  class_name?: string;
  type?: string;
  min_size?: number;
  max_size?: number;
  compatible_types?: unknown;
  editable?: boolean;
  children: LoadoutNode[];
}

const DAMAGE_TYPES = ['Physical', 'Energy', 'Distortion', 'Thermal', 'Biochemical', 'Stun'];

interface CombatStats {
  health: number;
  armor: {
    health: number;
    damage_multipliers: Record<string, number>;
    resistance_multipliers: Record<string, number>;
    deflection: Record<string, number>;
  } | null;
  shields: {
    hp: number;
    regen: number;
    resistance: Record<string, { min: number; max: number }>;
    absorption: Record<string, { min: number; max: number }>;
  } | null;
  dimensions: { size_class: number | null; length: number | null; width: number | null; height: number | null };
  // Scunpacked's own role taxonomy (e.g. "Medium Fighter", "Corvette", "Heavy
  // Freight") — distinct from game_ships.classification, which comes from
  // fleetyards' coarser category and doesn't carry a light/medium/heavy tier.
  role: string | null;
  career: string | null;
}

interface ShipData {
  crew_roles: CrewRoleGroup[];
  raw_seats: RawSeat[];
  stock_loadout: LoadoutNode[];
  combat_stats: CombatStats;
}

// Pulls just the base per-damage-type value out of a multiplier block —
// scunpacked also carries "*Change" delta variants (e.g. PhysicalChange)
// alongside the base value, which aren't needed here.
function extractByDamageType(block: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const type of DAMAGE_TYPES) {
    if (block && typeof block[type] === 'number') out[type] = block[type];
  }
  return out;
}

function extractRangeByDamageType(block: any): Record<string, { min: number; max: number }> {
  const out: Record<string, { min: number; max: number }> = {};
  for (const type of DAMAGE_TYPES) {
    const v = block?.[type];
    if (v && typeof v.Minimum === 'number' && typeof v.Maximum === 'number') {
      out[type] = { min: v.Minimum, max: v.Maximum };
    }
  }
  return out;
}

function extractCombatStats(ship: any): CombatStats {
  const armor = ship?.Armor;
  const shields = ship?.ShieldsTotal;
  return {
    health: typeof ship?.Health === 'number' ? ship.Health : 0,
    armor: armor ? {
      health: typeof armor.Health === 'number' ? armor.Health : 0,
      damage_multipliers: extractByDamageType(armor.DamageMultipliers),
      resistance_multipliers: extractByDamageType(armor.ResistanceMultipliers),
      deflection: extractByDamageType(armor.Deflection),
    } : null,
    shields: (shields && typeof shields.Hp === 'number') ? {
      hp: shields.Hp,
      regen: shields.Regen || 0,
      resistance: extractRangeByDamageType(shields.Resistance),
      absorption: extractRangeByDamageType(shields.Absorption),
    } : null,
    dimensions: {
      size_class: typeof ship?.Size === 'number' ? ship.Size : null,
      length: typeof ship?.Length === 'number' ? ship.Length : null,
      width: typeof ship?.Width === 'number' ? ship.Width : null,
      height: typeof ship?.Height === 'number' ? ship.Height : null,
    },
    role: typeof ship?.Role === 'string' ? ship.Role : null,
    career: typeof ship?.Career === 'string' ? ship.Career : null,
  };
}

function trimLoadoutNode(node: any): LoadoutNode {
  // node.Type is a compound string like "WeaponGun.Gun" or
  // "MissileLauncher.MissileRack" — game_ship_components.type is the flat
  // base ("WeaponGun"), matching ship-items.json's own `type` field. Keeping
  // the compound string here made every component-replacement search return
  // zero rows (exact string match against a value that never appears in the
  // catalog) — split it down to the base type so search actually matches.
  const rawType = typeof node.Type === 'string' ? node.Type : '';
  return {
    port_id: node.PortId,
    hardpoint_name: node.HardpointName,
    name: node.Name,
    class_name: node.ClassName,
    type: rawType.split('.')[0] || undefined,
    min_size: node.MinSize,
    max_size: node.MaxSize,
    compatible_types: node.CompatibleTypes,
    editable: node.Editable,
    children: Array.isArray(node.Loadout) ? node.Loadout.map(trimLoadoutNode) : [],
  };
}

// fleetyards' slug -> scunpacked-data's actual ships/ filename, for cases
// where the naive `slug.replace(/-/g, '_')` derivation below doesn't match
// scunpacked's own naming. Verified against the real ships/ directory
// listing (not guessed) — three distinct patterns show up in practice:
//  1. Word order/format differs (fleetyards "f7a-hornet-mk-ii" vs
//     scunpacked "hornet_f7a_mk2" — different order AND "mk-ii" -> "mk2").
//  2. No mark suffix at all on the scunpacked side — some ships were
//     conceived as one thing and shipped as "Mk II" with no real Mk I to
//     disambiguate from, so the game data just uses the base name (e.g.
//     Zeus Mk II CL/ES -> rsi_zeus_cl/rsi_zeus_es).
//  3. The base/default trim of a multi-variant ship has no suffix at all
//     (e.g. "Vanguard Warden" -> aegs_vanguard.json, "Reliant Kore" ->
//     misc_reliant.json — the named trim IS the base model).
// Regenerate/extend this by re-running
// src/scripts/verifyShipSlugAliases.ts whenever fleetyards or
// scunpacked-data adds ships — don't hand-guess new entries.
const SHIP_SLUG_ALIASES: Record<string, string> = {
  'crus-a1-spirit': 'crus_spirit_a1',
  'rsi-aurora-mk-ii': 'rsi_aurora_mk2',
  'crus-c1-spirit': 'crus_spirit_c1',
  'anvl-f7a-hornet-mk-i': 'anvl_hornet_f7a_mk1',
  'anvl-f7a-hornet-mk-ii': 'anvl_hornet_f7a_mk2',
  'anvl-f7c-hornet-mk-ii': 'anvl_hornet_f7c_mk2',
  'anvl-f8c-lightning': 'anvl_lightning_f8c',
  'anvl-f7c-hornet-wildfire-mk-i': 'anvl_hornet_f7c_wildfire',
  'rsi-zeus-mk-ii-cl': 'rsi_zeus_cl',
  'rsi-zeus-mk-ii-es': 'rsi_zeus_es',
  'orig-600i-explorer': 'orig_600i',
  'drak-dragonfly-black': 'drak_dragonfly',
  // Was 'drak_dragonfly' (the base/Black trim's file) — a 2026-07-28 data
  // audit found the dedicated drak_dragonfly_yellow.json file exists (its
  // pilot seat is even named "..._Pilot_YellowJacket") and just wasn't
  // referenced. No visible symptom today since all 3 Dragonfly trims are
  // currently stat-identical, but this is the correct file to point at.
  'drak-dragonfly-yellowjacket': 'drak_dragonfly_yellow',
  'argo-mpuv-cargo': 'argo_mpuv',
  // Were both wrongly aliased to 'argo_mpuv' (the Cargo variant's file) — a
  // 2026-07-28 data audit found this was showing the Cargo model's seats and
  // stats (e.g. Health 5920) under the Personnel and Tractor variants, which
  // each have their own scunpacked file with real stat differences (Tractor
  // is Health 6380, not 5920). Confirmed via each file's own `Name` field.
  'argo-mpuv-personnel': 'argo_mpuv_transport',
  'argo-mpuv-tractor': 'argo_mpuv_1t',
  'misc-reliant-kore': 'misc_reliant',
  'aegs-vanguard-warden': 'aegs_vanguard',

  // 2026-07-31: verifyShipSlugAliases.ts run against the live DB found 74
  // ships (of 243) whose default filename guess didn't resolve — meaning
  // ensureShipDataFresh's fetch 404s every time, and (see the refreshShipData
  // fix above, same commit) that was silently wiping any loadout/seat data
  // back to empty, showing as "No loadout data available for this ship" in
  // the UI. Every entry below was confirmed against the target file's own
  // `Name` field before adding (a wrong pairing is worse than no data). The
  // other ~39 ships from that run have no scunpacked-data file at all yet
  // (Hercules A2/C2/M2, Kraken, Merchantman, Galaxy, Bengal, Hull D/E, etc. —
  // capital/large ships not yet flyable in this data source) — "no data" is
  // correct for those until scunpacked-data adds them, nothing to alias.

  // Kruger/Origin/Aopoa: hyphenated model codes ("L-21", "P-52", "890")
  // fuse into one token on the scunpacked side ("l21", "p52", "890jump")
  // instead of keeping the hyphen as an underscore — the naive
  // slug.replace(/-/g,'_') guess keeps them separate and 404s.
  'krig-l-21-wolf': 'krig_l21_wolf',
  'krig-l-22-alpha-wolf': 'krig_l22_alphawolf',
  'krig-p-52-merlin': 'krig_p52_merlin',
  'krig-p-72-archimedes': 'krig_p72_archimedes',
  'orig-890-jump': 'orig_890jump',
  'xnaa-san-tok-yai': 'xnaa_santokyai',

  // Manufacturer-code mismatches: our slug uses the current/marketing
  // manufacturer code, scunpacked's filename still uses an older or
  // internal-dev manufacturer code for the same hull.
  'grey-basher': 'glsn_basher',
  'grey-shiv': 'glsn_shiv',
  'mrai-fury': 'misc_fury',
  'mrai-fury-lx': 'misc_fury_lx',
  // Confirmed via Name field: "Mirai Fury MX" — the file's own internal
  // trim codename ("miru") isn't the marketing trim name ("MX").
  'mrai-fury-mx': 'misc_fury_miru',
  'mrai-razor': 'misc_razor',
  'mrai-razor-ex': 'misc_razor_ex',
  'mrai-razor-lx': 'misc_razor_lx',
  'espr-blade': 'vncl_blade',
  'espr-glaive': 'vncl_glaive',
  'espr-stinger': 'vncl_stinger',
  'xnaa-nox': 'xian_nox',
  'xnaa-nox-kue': 'xian_nox_kue',

  // Word-order / abbreviated-trim mismatches (single unambiguous file each).
  'aegs-gladius-pirate-edition': 'aegs_gladius_pir',
  'anvl-f8c-lightning-executive-edition': 'anvl_lightning_f8c_exec',

  // RSI Aurora "Mk I" generation: scunpacked's file uses "gs" (an older
  // internal codename, confirmed via Name field: "RSI Aurora Mk I <trim>")
  // instead of "mk_i" for this generation, the same way Zeus Mk II's file
  // has no mk suffix at all — the newer Mk II reissue is the one that got
  // an explicit suffix (rsi_aurora_mk2, already aliased above).
  'rsi-aurora-mk-i-cl': 'rsi_aurora_gs_cl',
  'rsi-aurora-mk-i-es': 'rsi_aurora_gs_es',
  'rsi-aurora-mk-i-ln': 'rsi_aurora_gs_ln',
  'rsi-aurora-mk-i-lx': 'rsi_aurora_gs_lx',
  'rsi-aurora-mk-i-mr': 'rsi_aurora_gs_mr',
  'rsi-aurora-mk-i-se': 'rsi_aurora_gs_se',

  // F7C/F7C-M/F7C-R/F7C-S Hornet family: same "original release has no mk
  // suffix, later Mk II reissue gets _mk2" pattern as Zeus/F7A above — Mk I
  // is the bare filename here (unlike Zeus, an actual Mk I really did ship
  // for these trims, it just predates the Mk II-era naming convention).
  'anvl-f7c-hornet-mk-i': 'anvl_hornet_f7c',
  'anvl-f7c-m-super-hornet-mk-i': 'anvl_hornet_f7cm',
  'anvl-f7c-m-super-hornet-mk-ii': 'anvl_hornet_f7cm_mk2',
  'anvl-f7c-m-super-hornet-heartseeker-mk-i': 'anvl_hornet_f7cm_heartseeker',
  'anvl-f7c-r-hornet-tracker-mk-i': 'anvl_hornet_f7cr',
  'anvl-f7c-r-hornet-tracker-mk-ii': 'anvl_hornet_f7cr_mk2',
  'anvl-f7c-s-hornet-ghost-mk-i': 'anvl_hornet_f7cs',
  'anvl-f7c-s-hornet-ghost-mk-ii': 'anvl_hornet_f7cs_mk2',
};

async function fetchShipData(slug: string): Promise<ShipData | null> {
  const fileSlug = SHIP_SLUG_ALIASES[slug] || slug.replace(/-/g, '_');
  let res: Response;
  try {
    res = await fetch(`${SCUNPACKED_SHIPS_BASE}${fileSlug}.json`);
  } catch (err) {
    console.error(`scunpackedSync: fetch failed for ${fileSlug}.json:`, err);
    return null;
  }
  if (!res.ok) {
    console.warn(`scunpackedSync: GET ships/${fileSlug}.json failed with status ${res.status}`);
    return null;
  }

  const ship = await res.json() as any;
  const seats: any[] = Array.isArray(ship?.Seating?.Seats) ? ship.Seating.Seats : [];

  const rawSeats: RawSeat[] = [];
  const grouped = new Map<string, string[]>();
  const additionalCrewLabels: string[] = [];

  for (const seat of seats) {
    const rawRole = seat?.Role;
    if (!rawRole || rawRole === 'Unknown') continue;
    const role = classifySeatRole(seat);
    const seatLabel = deriveSeatLabel(seat.ClassName, seat.HardpointName);
    if (!CORE_SEAT_ROLES.has(role)) {
      // Bridge stations and anything else not in the core set aren't
      // individually lockable/hardpoint-addressable — they only contribute
      // to the generic Extra Crew headcount below.
      additionalCrewLabels.push(seatLabel);
      continue;
    }
    if (SINGULAR_SEAT_ROLES.has(role) && grouped.has(role)) {
      // Already have the one real seat for this role — any further seat
      // sharing the same tag converts to a nameless Extra Crew slot, not a
      // second Captain/Pilot/Torpedo Operator/Lead Engineer. Its own
      // hardpoint-derived label (often junk like "No Armrests") isn't
      // meaningful once demoted, so it doesn't carry a seat label forward.
      additionalCrewLabels.push('Crew');
      continue;
    }
    rawSeats.push({ hardpoint_name: seat.HardpointName || '', role, role_display: roleDisplayName(role), seat_label: seatLabel });
    if (!grouped.has(role)) grouped.set(role, []);
    grouped.get(role)!.push(seatLabel);
  }

  const orderedRoles = Array.from(grouped.keys()).sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    return (ia === -1 ? ROLE_ORDER.length : ia) - (ib === -1 ? ROLE_ORDER.length : ib);
  });
  const crewRoles: CrewRoleGroup[] = orderedRoles.map(role => ({
    role,
    display_name: roleDisplayName(role),
    count: grouped.get(role)!.length,
    seat_labels: grouped.get(role)!.slice(0, 12),
    is_commander_candidate: role === 'Captain' || role === 'Helmsman',
  }));

  if (additionalCrewLabels.length > 0) {
    crewRoles.push({
      role: ADDITIONAL_CREW_ROLE,
      display_name: 'Extra Crew',
      count: additionalCrewLabels.length,
      seat_labels: additionalCrewLabels.slice(0, 12),
      is_commander_candidate: false,
    });
  }

  const loadout: any[] = Array.isArray(ship?.Loadout) ? ship.Loadout : [];
  const stockLoadout = loadout.map(trimLoadoutNode);

  const combatStats = extractCombatStats(ship);

  return { crew_roles: crewRoles, raw_seats: rawSeats, stock_loadout: stockLoadout, combat_stats: combatStats };
}

const inFlight: Record<string, Promise<ShipData | null> | undefined> = {};

// Re-fetches `slug` from scunpacked-data and overwrites the cached row —
// used both by ensureShipDataFresh's lazy on-demand fetch below and by the
// daily gameDataScheduler forced refresh (see gameDataScheduler.ts), since
// this data has no staleness window of its own otherwise (see the comment
// at the top of this file: fetched once per ship, cached indefinitely).
// De-duped via `inFlight` so a scheduled refresh racing a concurrent lazy
// fetch for the same ship doesn't double-fetch.
//
// Only writes when `fetchShipData` actually returned something: `data` is
// null on a 404/network failure (wrong SHIP_SLUG_ALIASES guess, transient
// GitHub outage, etc.) — previously this still ran the UPDATE with `|| []`/
// `|| null` fallbacks, which *wiped a ship's real cached loadout/seats back
// to empty* on every failed refresh, and since ensureShipDataFresh treats
// combat_stats === null as "needs a refetch," a permanently-mismatched slug
// re-triggered this wipe on every single page view. Skipping the write on
// failure leaves whatever was last successfully cached (possibly nothing,
// but never regressed from something) until a real fetch succeeds.
export function refreshShipData(game: string, slug: string): Promise<ShipData | null> {
  if (game !== 'star_citizen' || !slug) return Promise.resolve(null);
  const key = `${game}:${slug}`;
  if (!inFlight[key]) {
    inFlight[key] = (async () => {
      const data = await fetchShipData(slug);
      if (data) {
        await pool.query(
          `UPDATE game_ships SET crew_roles = $1, raw_seats = $2, stock_loadout = $3, combat_stats = $4 WHERE game = $5 AND slug = $6`,
          [
            JSON.stringify(data.crew_roles || []),
            JSON.stringify(data.raw_seats || []),
            JSON.stringify(data.stock_loadout || []),
            JSON.stringify(data.combat_stats || null),
            game,
            slug,
          ]
        );
      }
      return data;
    })().finally(() => { inFlight[key] = undefined; });
  }
  return inFlight[key]!;
}

export async function ensureShipDataFresh(game: string, slug: string): Promise<ShipData | null> {
  if (game !== 'star_citizen' || !slug) return null;

  const cached = await pool.query(
    `SELECT crew_roles, raw_seats, stock_loadout, combat_stats FROM game_ships WHERE game = $1 AND slug = $2`,
    [game, slug]
  );
  if (cached.rowCount === 0) return null;

  const row = cached.rows[0];
  // combat_stats was added after crew_roles/raw_seats/stock_loadout, so a
  // ship cached before that migration will have those three populated but
  // combat_stats still null — re-fetch in that case too, not just when
  // nothing has ever been cached.
  if (row.crew_roles !== null && row.combat_stats !== null) {
    return {
      crew_roles: row.crew_roles || [],
      raw_seats: row.raw_seats || [],
      stock_loadout: row.stock_loadout || [],
      combat_stats: row.combat_stats,
    };
  }

  return refreshShipData(game, slug);
}
