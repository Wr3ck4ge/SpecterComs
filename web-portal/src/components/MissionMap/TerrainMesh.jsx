import React, { useMemo, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { applyHeightBrush } from './terrain';

const CANVAS_SIZE = 1024;
const TEXTURE_PATHS = {
  rock: '/textures/terrain/rock.jpg',
  sand: '/textures/terrain/sand.jpg',
  grass: '/textures/terrain/grass.jpg',
  snow: '/textures/terrain/snow.jpg',
  dirt: '/textures/terrain/dirt.jpg',
};
// Flat-color fallback so painting still works visually before real texture
// files are sourced/added under public/textures/terrain/.
const TEXTURE_FALLBACK_COLORS = {
  rock: '#6b6b6b', sand: '#d8c48a', grass: '#4c7a3d', snow: '#e8eef5', dirt: '#6b4a2f',
};
// Matches the cellSize/sectionSize convention used by the space-map <Grid>
// in index.jsx, so ground-plane scale reads consistently across map kinds.
const GRID_CELL_SIZE = 2;
const GRID_SECTION_SIZE = 10;
const GRID_CELL_COLOR = 'rgba(14,34,51,0.65)';
const GRID_SECTION_COLOR = 'rgba(34,211,238,0.55)';

function loadImage(src) {
  const img = new window.Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  return img;
}

// Sculptable ground mesh for a 'surface' map. Two independent edit layers:
// - height (raise/lower/flatten): mutates the live BufferGeometry in place
//   during a drag, committed to layout state only on pointerup.
// - ground texture (paint): a single offscreen canvas used as the mesh's
//   map, hard-edged circular stamps of a tiled source image, persisted as a
//   sparse stroke list (not a base64 blob) and replayed on mount.
//
// When no sculpt tool is active, this mesh takes over the invisible ground
// plane's job from index.jsx's Scene: click-to-place and drag-to-move, using
// the mesh's real (sculpted) surface height instead of a hardcoded y=0.
export default function TerrainMesh({
  terrain, canEdit, activeTool, dragRef, placeMode,
  onTerrainChange, onStrokesChange, onSculptActiveChange, onPlace, onMove,
}) {
  const geometry = useMemo(() => {
    const geo = new THREE.PlaneGeometry(terrain.width, terrain.depth, terrain.segments, terrain.segments);
    geo.rotateX(-Math.PI / 2); // flat in XZ, height along Y — mesh-local space == world space
    return geo;
  }, [terrain.width, terrain.depth, terrain.segments]);

  const heightRef = useRef(terrain.heightMap.slice());
  const paintingRef = useRef(false);
  const sculptingHeightRef = useRef(false);
  const lastStrokePointRef = useRef(null);
  const strokesRef = useRef(terrain.strokes ? terrain.strokes.slice() : []);

  // Re-apply the external heightMap whenever it changes from outside this
  // component (mount, map switch, or our own committed edit landing back in
  // props) — never during our own live drag.
  useEffect(() => {
    heightRef.current = terrain.heightMap.slice();
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heightRef.current[i] || 0);
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
  }, [terrain.heightMap, geometry]);

  // ---- Ground texture canvas ----
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = CANVAS_SIZE;
    c.height = CANVAS_SIZE;
    return c;
  }, []);
  const ctx = useMemo(() => canvas.getContext('2d'), [canvas]);
  const canvasTexture = useMemo(() => new THREE.CanvasTexture(canvas), [canvas]);
  const imagesRef = useRef({});
  if (Object.keys(imagesRef.current).length === 0) {
    Object.keys(TEXTURE_PATHS).forEach(key => { imagesRef.current[key] = loadImage(TEXTURE_PATHS[key]); });
  }

  const drawStroke = useCallback((ctx2d, x, z, radius, texture) => {
    const uvX = (x + terrain.width / 2) / terrain.width;
    const uvZ = (z + terrain.depth / 2) / terrain.depth;
    const cx = uvX * CANVAS_SIZE;
    const cy = (1 - uvZ) * CANVAS_SIZE;
    const px = radius * (CANVAS_SIZE / terrain.width);

    ctx2d.save();
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, px, 0, Math.PI * 2);
    ctx2d.clip();
    const img = imagesRef.current[texture];
    if (img && img.complete && img.naturalWidth > 0) {
      const pattern = ctx2d.createPattern(img, 'repeat');
      ctx2d.fillStyle = pattern;
    } else {
      ctx2d.fillStyle = TEXTURE_FALLBACK_COLORS[texture] || '#555555';
    }
    ctx2d.fillRect(cx - px, cy - px, px * 2, px * 2);
    ctx2d.restore();
  }, [terrain.width, terrain.depth]);

  // Grid lines baked directly into the surface texture (not a separate
  // floating scene object) so they deform with the sculpted mesh and stay
  // visible under paint — this is what a user aims clicks/drags against, so
  // it needs to be literally on the raycast surface, not floating at
  // baseElevation like the old reference <Grid> (see index.jsx), which put
  // the visual aid several units above the actual clickable surface and
  // made cursor position look wrong as the camera orbited.
  const drawGrid = useCallback((ctx2d) => {
    const halfW = terrain.width / 2;
    const halfD = terrain.depth / 2;
    const toCanvasX = wx => ((wx + halfW) / terrain.width) * CANVAS_SIZE;
    const toCanvasY = wz => (1 - (wz + halfD) / terrain.depth) * CANVAS_SIZE;
    const isSectionLine = v => Math.abs(Math.round(v / GRID_SECTION_SIZE) * GRID_SECTION_SIZE - v) < 0.01;

    ctx2d.save();
    ctx2d.lineWidth = 1;
    for (let x = -halfW; x <= halfW + 0.01; x += GRID_CELL_SIZE) {
      ctx2d.strokeStyle = isSectionLine(x) ? GRID_SECTION_COLOR : GRID_CELL_COLOR;
      const cx = toCanvasX(x);
      ctx2d.beginPath();
      ctx2d.moveTo(cx, 0);
      ctx2d.lineTo(cx, CANVAS_SIZE);
      ctx2d.stroke();
    }
    for (let z = -halfD; z <= halfD + 0.01; z += GRID_CELL_SIZE) {
      ctx2d.strokeStyle = isSectionLine(z) ? GRID_SECTION_COLOR : GRID_CELL_COLOR;
      const cy = toCanvasY(z);
      ctx2d.beginPath();
      ctx2d.moveTo(0, cy);
      ctx2d.lineTo(CANVAS_SIZE, cy);
      ctx2d.stroke();
    }
    ctx2d.restore();
  }, [terrain.width, terrain.depth]);

  // Replay persisted strokes onto the canvas on mount / whenever the
  // external strokes array changes (map switch, load).
  useEffect(() => {
    strokesRef.current = terrain.strokes ? terrain.strokes.slice() : [];
    ctx.fillStyle = '#555555';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    strokesRef.current.forEach(s => drawStroke(ctx, s.x, s.z, s.radius, s.texture));
    drawGrid(ctx);
    canvasTexture.needsUpdate = true;
  }, [terrain.strokes, ctx, canvasTexture, drawStroke, drawGrid]);

  const applyAt = useCallback((point, tool, brushSize, brushStrength, paintTexture) => {
    if (tool === 'paint') {
      drawStroke(ctx, point.x, point.z, brushSize, paintTexture);
      drawGrid(ctx);
      canvasTexture.needsUpdate = true;
      const last = lastStrokePointRef.current;
      if (!last || Math.hypot(point.x - last.x, point.z - last.z) > brushSize / 3) {
        strokesRef.current.push({ x: point.x, z: point.z, radius: brushSize, texture: paintTexture });
        lastStrokePointRef.current = { x: point.x, z: point.z };
      }
      return;
    }
    applyHeightBrush(heightRef.current, terrain, { x: point.x, y: point.z }, tool, brushSize, brushStrength);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heightRef.current[i] || 0);
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    sculptingHeightRef.current = true;
  }, [ctx, canvasTexture, drawStroke, drawGrid, terrain, geometry]);

  const handlePointerDown = useCallback((e) => {
    if (!canEdit) return;
    if (activeTool && !e.shiftKey) {
      e.stopPropagation();
      paintingRef.current = true;
      lastStrokePointRef.current = null;
      onSculptActiveChange(true);
      applyAt(e.point, activeTool.tool, activeTool.brushSize, activeTool.brushStrength, activeTool.paintTexture);
    }
  }, [canEdit, activeTool, applyAt, onSculptActiveChange]);

  const handlePointerMove = useCallback((e) => {
    if (paintingRef.current && activeTool) {
      applyAt(e.point, activeTool.tool, activeTool.brushSize, activeTool.brushStrength, activeTool.paintTexture);
      return;
    }
    if (canEdit && dragRef.current) onMove([e.point.x, e.point.y, e.point.z]);
  }, [activeTool, applyAt, canEdit, dragRef, onMove]);

  const handlePointerUp = useCallback(() => {
    if (!paintingRef.current) return;
    paintingRef.current = false;
    onSculptActiveChange(false);
    if (sculptingHeightRef.current) {
      sculptingHeightRef.current = false;
      onTerrainChange(heightRef.current.slice());
    }
    if (activeTool?.tool === 'paint') {
      onStrokesChange(strokesRef.current.slice());
    }
  }, [onSculptActiveChange, onTerrainChange, onStrokesChange, activeTool]);

  const handleClick = useCallback((e) => {
    if (!canEdit || !placeMode || activeTool) return;
    e.stopPropagation();
    onPlace([e.point.x, e.point.y, e.point.z]);
  }, [canEdit, placeMode, activeTool, onPlace]);

  useEffect(() => {
    window.addEventListener('pointerup', handlePointerUp);
    return () => window.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerUp]);

  return (
    <mesh
      geometry={geometry}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onClick={handleClick}
    >
      <meshStandardMaterial map={canvasTexture} roughness={0.9} metalness={0} />
    </mesh>
  );
}
