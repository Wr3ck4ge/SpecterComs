// Mission map data shapes — objectives, structures, group ship tokens,
// infantry tokens, and the multi-map (space/surface) container they live on.
// Deliberately plain (no ship-template/crew-slot concepts): ship identity
// for a group's composition comes from the existing game_ships/hangar
// pipeline (api.getGameShips), not a separate map-specific catalog.

export const OBJECTIVE_TYPES = ['Point', 'Cave', 'Bunker', 'Tower', 'Station', 'Troops', 'Asteroid', 'AA Gun'];
export const OBJECTIVE_STATUSES = ['Unknown', 'Cleared', 'Hostile', 'Scouted'];
export const STATUS_COLORS = { Unknown: '#6b7280', Cleared: '#4ade80', Hostile: '#ef4444', Scouted: '#f59e0b' };

// On a surface map, `elevated: false` (the default) means the entity tracks
// the terrain contour underneath it (world height = heightmap height at its
// x/z, plus elevationOffset); `elevated: true` means it instead sits on the
// map's flat baseElevation plane (e.g. an orbital platform or debris field
// placed "above" a surface, unaffected by sculpting). Meaningless on space
// maps, where everything stays at y=0 as before.
export function newObjective(position, mapId) {
  return {
    id: crypto.randomUUID(),
    name: 'New Objective',
    type: 'Point',
    status: 'Unknown',
    position,
    mapId,
    elevated: false,
    elevationOffset: 0,
  };
}

// A freeform imported 3D model (.glb/.gltf) placed on the map — either from
// the bundled library (see ModelLibraryPanel's MODEL_LIBRARY manifest) or
// uploaded by the user via the server. `url` is a relative /uploads path
// (server uploads) or a /models path (bundled library, served from
// web-portal/public/models/), resolved against UPLOADS_BASE_URL / the app
// origin respectively at render time — see ModelAssetMesh.
export function newModelAsset(name, url, position, mapId) {
  return {
    id: crypto.randomUUID(),
    name,
    url,
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    mapId,
    elevated: true,
    elevationOffset: 0,
  };
}

export const STRUCTURE_TYPES = ['Asteroid', 'Station', 'Debris'];
export const STRUCTURE_DEFAULT_COLORS = { Asteroid: '#8b7355', Station: '#64748b', Debris: '#57534e' };

// Structures default to elevated (they read as space objects — an asteroid
// or station floating above a surface, not embedded in it) but can be
// switched to ground-relative per instance.
export function newStructure(type, position, mapId) {
  return {
    id: crypto.randomUUID(),
    type,
    name: `New ${type}`,
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    color: STRUCTURE_DEFAULT_COLORS[type] || '#888888',
    mapId,
    elevated: true,
    elevationOffset: 0,
  };
}

// Infantry is always ground-relative (dismounted troops stand on terrain) —
// no elevated toggle, just a manual offset for stacking/visual clearance.
export function newInfantryToken(position, mapId) {
  return {
    id: crypto.randomUUID(),
    name: 'New Squad',
    personnel_count: 4,
    position,
    mapId,
    elevationOffset: 0,
  };
}

// A "map" is one planning canvas (space muster/routing, a planet/moon
// surface, etc). Multiple maps can exist per event; entities reference the
// map they're on via a `mapId` field rather than being nested per-map, so
// existing id-keyed CRUD stays flat and map-agnostic.
export const MAP_KINDS = ['space', 'surface'];

export function newMap(name, kind, order) {
  const map = { id: crypto.randomUUID(), name, kind, order };
  if (kind === 'surface') map.terrain = newTerrain();
  return map;
}

export const DEFAULT_TERRAIN_SEGMENTS = 64;

// baseElevation is the flat reference plane elevated entities and ships sit
// on for this map — visualized in-scene as a grid at that height.
export const DEFAULT_BASE_ELEVATION = 6;

export function newTerrain() {
  const segments = DEFAULT_TERRAIN_SEGMENTS;
  return {
    width: 80,
    depth: 80,
    segments,
    heightMap: new Array((segments + 1) * (segments + 1)).fill(0),
    texture: 'rock',
    strokes: [],
    baseElevation: DEFAULT_BASE_ELEVATION,
  };
}

export function emptyLayout() {
  const mapId = crypto.randomUUID();
  return {
    version: 2,
    maps: [{ id: mapId, name: 'Main', kind: 'space', order: 0 }],
    activeMapId: mapId,
    objectives: [],
    structures: [],
    groupTokens: [],
    infantryTokens: [],
    modelAssets: [],
    routes: [],
  };
}

// Backward-compatible load: pre-multi-map saves (or a brand-new event with no
// saved layout at all) have no `maps`/`mapId` concept. Synthesize one default
// map and tag every pre-existing entity onto it. Idempotent and safe to run
// on every load — nothing is persisted here, only the in-memory shape is
// normalized; the next save writes the v2 shape back.
export function migrateLayout(loaded) {
  if (loaded && loaded.version === 2 && Array.isArray(loaded.maps) && loaded.maps.length > 0) {
    return {
      version: 2,
      maps: loaded.maps,
      activeMapId: loaded.activeMapId || loaded.maps[0].id,
      objectives: loaded.objectives || [],
      structures: loaded.structures || [],
      groupTokens: loaded.groupTokens || [],
      infantryTokens: loaded.infantryTokens || [],
      modelAssets: loaded.modelAssets || [],
      routes: loaded.routes || [],
    };
  }

  const defaultMapId = crypto.randomUUID();
  const tag = (arr) => (arr || []).map(e => ({ ...e, mapId: e.mapId || defaultMapId }));

  return {
    version: 2,
    maps: [{ id: defaultMapId, name: 'Main', kind: 'space', order: 0 }],
    activeMapId: defaultMapId,
    objectives: tag(loaded?.objectives),
    structures: tag(loaded?.structures),
    // groupTokens are reconciled against the live `groups` prop by the
    // caller (index.jsx), which needs this same defaultMapId — returned
    // below so it isn't regenerated a second time.
    groupTokens: loaded?.groupTokens || [],
    infantryTokens: tag(loaded?.infantryTokens),
    modelAssets: tag(loaded?.modelAssets),
    routes: loaded?.routes || [],
    _defaultMapId: defaultMapId,
  };
}
