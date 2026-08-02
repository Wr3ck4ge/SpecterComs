// Sculptable low-poly terrain — pure logic (no React/three imports here so
// it's trivially testable and reusable from both TerrainMesh and index.jsx's
// height-correction pass).
//
// Deliberately NOT real Star Citizen terrain data: hand-sculpted heightmaps
// only, to avoid the IP/licensing exposure of extracting real game assets
// into a commercial tool. This is meant to be abstract and low-poly, not a
// faithful terrain reproduction.

export const DEFAULT_TERRAIN_SEGMENTS = 64;

export const TERRAIN_TEXTURES = ['rock', 'sand', 'grass', 'snow', 'dirt'];

// World (x,z) -> heightmap value. Indexing matches THREE.PlaneGeometry's
// native row-major vertex order (X fast-varying axis, segments+1 columns per
// row), so the flat array blits straight onto a PlaneGeometry's position
// attribute with no remapping.
export function getTerrainHeight(x, z, terrain) {
  if (!terrain || !terrain.heightMap) return 0;
  const { width, depth, segments, heightMap } = terrain;
  const halfW = width / 2;
  const halfD = depth / 2;
  if (x < -halfW || x > halfW || z < -halfD || z > halfD) return 0;

  const gridX = Math.max(0, Math.min(segments, Math.floor(((x + halfW) / width) * segments)));
  const gridZ = Math.max(0, Math.min(segments, Math.floor(((z + halfD) / depth) * segments)));
  return heightMap[gridZ * (segments + 1) + gridX] || 0;
}

// Mutates `heightMap` (flat array) in place. `localPoint` is {x, y} in the
// terrain mesh's local, pre-rotation space (local Y = world depth/Z here,
// since the mesh is authored as a flat XY PlaneGeometry then rotated -90deg
// on X to lie flat in the world). Returns nothing — caller re-applies the
// mutated array onto the live BufferGeometry.
export function applyHeightBrush(heightMap, terrain, localPoint, tool, brushSize, brushStrength) {
  const { segments } = terrain;
  const verticesPerRow = segments + 1;
  const halfW = terrain.width / 2;
  const halfD = terrain.depth / 2;

  for (let row = 0; row < verticesPerRow; row++) {
    for (let col = 0; col < verticesPerRow; col++) {
      const vx = (col / segments) * terrain.width - halfW;
      const vy = (row / segments) * terrain.depth - halfD;
      const dist = Math.hypot(vx - localPoint.x, vy - localPoint.y);
      if (dist >= brushSize) continue;

      const falloff = 1 - dist / brushSize;
      const strength = brushStrength * falloff * 0.5;
      const i = row * verticesPerRow + col;
      let h = heightMap[i] || 0;

      if (tool === 'raise') h += strength;
      else if (tool === 'lower') h -= strength;
      // "flatten" decays toward the terrain's rest height (0), not toward
      // the cursor's height — intentional, matches the ported reference
      // behavior. Repeated strokes asymptotically level an area to 0.
      else if (tool === 'flatten') h *= (1 - strength);

      heightMap[i] = h;
    }
  }
}

// Ships never dip below the actual sculpted surface, even where terrain has
// been raised above the map's base elevation plane.
export const MIN_SHIP_CLEARANCE = 1;

// Ground-relative entities (default) track the terrain contour under them
// plus a manual offset; elevated entities instead ride the map's flat
// baseElevation plane, ignoring terrain contour entirely.
export function resolveEntityHeight(entity, terrain) {
  const [x, , z] = entity.position;
  const offset = entity.elevationOffset || 0;
  if (entity.elevated) return terrain.baseElevation + offset;
  return getTerrainHeight(x, z, terrain) + offset;
}

// Ships fly the base elevation plane (+ optional offset) but are clamped to
// never sink below the terrain surface underneath them.
export function resolveShipHeight(entity, terrain) {
  const [x, , z] = entity.position;
  const offset = entity.elevationOffset || 0;
  const flightHeight = terrain.baseElevation + offset;
  const floor = getTerrainHeight(x, z, terrain) + MIN_SHIP_CLEARANCE;
  return Math.max(flightHeight, floor);
}
