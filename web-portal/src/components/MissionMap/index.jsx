import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, Stars, Html, Line } from '@react-three/drei';
import { api } from '../../api';
import GroupToken from './GroupToken';
import InfantryToken from './InfantryToken';
import InfantryBuilder from './InfantryBuilder';
import ShipCompositionPicker from '../ShipCompositionPicker';
import StructureBuilder from './StructureBuilder';
import ModelAssetMesh from './ModelAssetMesh';
import ModelLibraryPanel from './ModelLibraryPanel';
import MapTabs from './MapTabs';
import TerrainMesh from './TerrainMesh';
import TerrainPanel from './TerrainPanel';
import { resolveEntityHeight, resolveShipHeight } from './terrain';
import {
  OBJECTIVE_TYPES, OBJECTIVE_STATUSES, STATUS_COLORS,
  newObjective, newStructure, newInfantryToken, newModelAsset, newMap, migrateLayout,
} from './types';

const S = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 60,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex', flexDirection: 'column',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 16px', borderBottom: '1px solid #0e2233', background: '#040d15', flexShrink: 0,
  },
  btnCyan: { fontSize: 11, padding: '6px 14px', borderRadius: 3, cursor: 'pointer', letterSpacing: '0.1em', background: '#041e2e', border: '1px solid #0891b2', color: '#22d3ee', fontFamily: 'monospace' },
  btnDim: { fontSize: 11, padding: '6px 14px', borderRadius: 3, cursor: 'pointer', letterSpacing: '0.1em', background: 'transparent', border: '1px solid #0e2233', color: '#9ca3af', fontFamily: 'monospace' },
  panel: { width: 260, flexShrink: 0, background: '#040d15', borderRight: '1px solid #0e2233', padding: 12, overflowY: 'auto' },
  label: { fontSize: 10, color: '#0e7490', letterSpacing: '0.15em', display: 'block', marginBottom: 4 },
  input: { width: '100%', fontSize: 11, background: '#020c14', border: '1px solid #0e2233', color: '#e5e7eb', padding: '5px 8px', fontFamily: 'monospace' },
};

const STRUCTURE_GEOMETRY = {
  Asteroid: <icosahedronGeometry args={[1, 0]} />,
  Station: <boxGeometry args={[1.4, 0.6, 1.4]} />,
  Debris: <octahedronGeometry args={[0.8, 0]} />,
};

function StructureMesh({ structure, selected, canEdit, onSelect, onDragStart }) {
  return (
    <group
      position={structure.position}
      scale={structure.scale}
      onPointerDown={e => {
        e.stopPropagation();
        onSelect(structure.id);
        if (canEdit) onDragStart(structure.id);
      }}
    >
      <mesh>
        {STRUCTURE_GEOMETRY[structure.type] || STRUCTURE_GEOMETRY.Asteroid}
        <meshStandardMaterial color={structure.color} roughness={0.7} metalness={0.2} emissive={selected ? structure.color : '#000000'} emissiveIntensity={selected ? 0.4 : 0} />
      </mesh>
      <Html position={[0, 1.4, 0]} center distanceFactor={14} zIndexRange={[5, 0]}>
        <span style={{ fontSize: 9, color: '#9ca3af', fontFamily: 'monospace', background: 'rgba(4,13,21,0.8)', padding: '1px 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
          {structure.name}
        </span>
      </Html>
    </group>
  );
}

function ObjectiveMarker({ objective, selected, canEdit, onSelect, onDragStart }) {
  const color = STATUS_COLORS[objective.status] || '#6b7280';
  return (
    <group
      position={objective.position}
      onPointerDown={e => {
        e.stopPropagation();
        onSelect(objective.id);
        if (canEdit) onDragStart(objective.id);
      }}
    >
      <mesh>
        <sphereGeometry args={[0.35, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={selected ? 1 : 0.5} />
      </mesh>
      <Html position={[0, 0.7, 0]} center distanceFactor={14} zIndexRange={[5, 0]}>
        <span style={{ fontSize: 9, color, fontFamily: 'monospace', background: 'rgba(4,13,21,0.85)', padding: '1px 5px', borderRadius: 2, whiteSpace: 'nowrap', border: `1px solid ${selected ? color : 'transparent'}` }}>
          {objective.name} · {objective.type}
        </span>
      </Html>
    </group>
  );
}

function Scene({
  mapKind, terrain, activeTool, onTerrainChange, onStrokesChange, onSculptActiveChange,
  visibleObjectives, visibleStructures, visibleGroupTokens, visibleInfantry, visibleModelAssets,
  canEdit, placeMode, selected, setSelected, dragRef, setIsDragging, onPlace, onMove, groups,
}) {
  return (
    <>
      <ambientLight intensity={0.5} />
      <pointLight position={[20, 30, 10]} intensity={1.2} />

      {mapKind === 'surface' && terrain ? (
        <>
          <TerrainMesh
            terrain={terrain}
            canEdit={canEdit}
            activeTool={activeTool}
            dragRef={dragRef}
            placeMode={placeMode}
            onTerrainChange={onTerrainChange}
            onStrokesChange={onStrokesChange}
            onSculptActiveChange={onSculptActiveChange}
            onPlace={onPlace}
            onMove={onMove}
          />
          {/* Floating reference plane for elevated objects/ships only — NOT
              the ground-interaction grid (that's baked into TerrainMesh's
              own surface texture so it sits exactly on the raycast surface;
              a grid floating here at baseElevation instead of on the actual
              clickable terrain caused clicks/drags to visually desync from
              the grid as the camera orbited). Dim relative to the terrain
              grid so it doesn't read as the primary ground reference. */}
          <Grid
            position={[0, terrain.baseElevation, 0]}
            args={[terrain.width, terrain.depth]}
            cellSize={2} sectionSize={10}
            cellColor="#0a1a26" sectionColor="#0e5876"
            fadeDistance={Math.max(terrain.width, terrain.depth) * 1.3}
          />
        </>
      ) : (
        <>
          <Stars radius={200} depth={60} count={2000} factor={4} fade speed={0.5} />
          <Grid args={[400, 400]} cellColor="#0e2233" sectionColor="#0891b2" fadeDistance={220} infiniteGrid />

          {/* Invisible plane for placement clicks + drag raycasting */}
          <mesh
            rotation={[-Math.PI / 2, 0, 0]}
            onClick={e => {
              if (!canEdit || !placeMode) return;
              e.stopPropagation();
              onPlace([e.point.x, 0, e.point.z]);
            }}
            onPointerMove={e => {
              if (!canEdit || !dragRef.current) return;
              onMove([e.point.x, 0, e.point.z]);
            }}
          >
            <planeGeometry args={[400, 400]} />
            <meshBasicMaterial visible={false} />
          </mesh>
        </>
      )}

      {visibleObjectives.map(o => (
        <ObjectiveMarker
          key={o.id} objective={o} canEdit={canEdit}
          selected={selected?.kind === 'objective' && selected.id === o.id}
          onSelect={id => setSelected({ kind: 'objective', id })}
          onDragStart={id => { dragRef.current = { kind: 'objective', id }; setIsDragging(true); }}
        />
      ))}

      {visibleStructures.map(s => (
        <StructureMesh
          key={s.id} structure={s} canEdit={canEdit}
          selected={selected?.kind === 'structure' && selected.id === s.id}
          onSelect={id => setSelected({ kind: 'structure', id })}
          onDragStart={id => { dragRef.current = { kind: 'structure', id }; setIsDragging(true); }}
        />
      ))}

      {visibleInfantry.map(t => (
        <InfantryToken
          key={t.id} token={t} canEdit={canEdit}
          selected={selected?.kind === 'infantry' && selected.id === t.id}
          onSelect={id => setSelected({ kind: 'infantry', id })}
          onDragStart={id => { dragRef.current = { kind: 'infantry', id }; setIsDragging(true); }}
        />
      ))}

      {visibleGroupTokens.map(t => (
        <GroupToken
          key={t.group_index} token={t} canEdit={canEdit}
          groupName={groups[t.group_index]?.name || 'Group'}
          selected={selected?.kind === 'token' && selected.id === t.group_index}
          onSelect={id => setSelected({ kind: 'token', id })}
          onDragStart={id => { dragRef.current = { kind: 'token', id }; setIsDragging(true); }}
        />
      ))}

      {visibleModelAssets.map(a => (
        <ModelAssetMesh
          key={a.id} asset={a} canEdit={canEdit}
          selected={selected?.kind === 'modelAsset' && selected.id === a.id}
          onSelect={id => setSelected({ kind: 'modelAsset', id })}
          onDragStart={id => { dragRef.current = { kind: 'modelAsset', id }; setIsDragging(true); }}
        />
      ))}

      {/* Host tethers — planning-only visual link, e.g. a fighter wing
          operating out of a carrier group; independent of the group tree's
          command-structure parent_index (not monitored during gameplay).
          Only drawn when both ends are placed on this same map. */}
      {visibleGroupTokens.filter(t => t.hosted_by_group_index !== null && t.hosted_by_group_index !== undefined).map(t => {
        const host = visibleGroupTokens.find(h => h.group_index === t.hosted_by_group_index);
        if (!host) return null;
        return (
          <Line
            key={`tether-${t.group_index}`}
            points={[t.position, host.position]}
            color="#0891b2"
            dashed
            dashSize={0.3}
            gapSize={0.2}
            lineWidth={1}
            transparent
            opacity={0.6}
          />
        );
      })}
    </>
  );
}

// Mission map — objectives, structures, infantry squads, and per-group ship
// tokens placed across one or more named planning maps (e.g. a space
// muster/routing map plus one or more planet/moon surface maps with
// sculptable terrain). Ship tokens are one marker per group (see
// GroupToken.jsx), decoupled from event_groups.game_selection_key (the
// single-ship crew-role field) since a group can represent zero, one, or
// many vehicles. Infantry tokens are freeform (click-to-place, like
// objectives/structures) and intentionally not tied to the groups/roster
// system. Entities carry a `mapId` field rather than being nested per-map,
// so a group token can be moved between maps and everything else's CRUD
// stays a flat, map-agnostic array (see types.js for the full layout shape).
export default function MissionMap({ orgId, eventId, groups, canEdit, onClose }) {
  const [layout, setLayout] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [placeMode, setPlaceMode] = useState(null); // null | 'objective' | 'infantry' | { structureType }
  const [selected, setSelected] = useState(null); // { kind: 'objective'|'structure'|'token'|'infantry'|'modelAsset', id }
  const [isDragging, setIsDragging] = useState(false);
  const [sculptActive, setSculptActive] = useState(false);
  const [terrainTool, setTerrainTool] = useState({ tool: null, brushSize: 5, brushStrength: 0.5, paintTexture: 'rock' });
  const [modelUploading, setModelUploading] = useState(false);
  const [modelUploadError, setModelUploadError] = useState(null);
  const dragRef = useRef(null);

  useEffect(() => {
    (async () => {
      const { data } = await api.getEventMapLayout(orgId, eventId);
      const migrated = migrateLayout(data?.layout || {});
      const fallbackMapId = migrated._defaultMapId || migrated.activeMapId;
      const groupTokens = groups.map((g, i) => {
        const existing = (migrated.groupTokens || []).find(t => t.group_index === i);
        if (existing) {
          return { ...existing, mapId: existing.mapId || (existing.placed ? fallbackMapId : null) };
        }
        // Seed from the group's already-built ship composition (set via the
        // group builder's ShipCompositionPicker), so the map doesn't start
        // blank for a group that already has ships picked.
        const composition = (g.ships || []).map(s => ({
          ship_slug: s.ship_slug, ship_name: s.ship_name, ship_icon_url: s.ship_icon_url || null, quantity: s.quantity || 1,
        }));
        return { group_index: i, composition, placed: false, position: [0, 0, 0], hosted_by_group_index: null, mapId: null };
      });
      setLayout({
        version: 2,
        maps: migrated.maps,
        activeMapId: migrated.activeMapId,
        objectives: migrated.objectives,
        structures: migrated.structures,
        groupTokens,
        infantryTokens: migrated.infantryTokens,
        modelAssets: migrated.modelAssets,
        routes: migrated.routes,
      });
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, eventId]);

  useEffect(() => {
    const onUp = () => { dragRef.current = null; setIsDragging(false); };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, []);

  const handlePlace = useCallback((position) => {
    setLayout(prev => {
      if (placeMode === 'objective') {
        const obj = newObjective(position, prev.activeMapId);
        setSelected({ kind: 'objective', id: obj.id });
        return { ...prev, objectives: [...prev.objectives, obj] };
      }
      if (placeMode === 'infantry') {
        const inf = newInfantryToken(position, prev.activeMapId);
        setSelected({ kind: 'infantry', id: inf.id });
        return { ...prev, infantryTokens: [...prev.infantryTokens, inf] };
      }
      if (placeMode?.structureType) {
        const st = newStructure(placeMode.structureType, position, prev.activeMapId);
        setSelected({ kind: 'structure', id: st.id });
        return { ...prev, structures: [...prev.structures, st] };
      }
      return prev;
    });
    setPlaceMode(null);
  }, [placeMode]);

  const handleMove = useCallback((position) => {
    const drag = dragRef.current;
    if (!drag) return;
    setLayout(prev => {
      if (drag.kind === 'objective') {
        return { ...prev, objectives: prev.objectives.map(o => o.id === drag.id ? { ...o, position } : o) };
      }
      if (drag.kind === 'structure') {
        return { ...prev, structures: prev.structures.map(s => s.id === drag.id ? { ...s, position } : s) };
      }
      if (drag.kind === 'infantry') {
        return { ...prev, infantryTokens: prev.infantryTokens.map(t => t.id === drag.id ? { ...t, position } : t) };
      }
      if (drag.kind === 'token') {
        return { ...prev, groupTokens: prev.groupTokens.map(t => t.group_index === drag.id ? { ...t, position } : t) };
      }
      if (drag.kind === 'modelAsset') {
        return { ...prev, modelAssets: prev.modelAssets.map(a => a.id === drag.id ? { ...a, position } : a) };
      }
      return prev;
    });
  }, []);

  const updateObjective = (id, updates) => {
    setLayout(prev => ({ ...prev, objectives: prev.objectives.map(o => o.id === id ? { ...o, ...updates } : o) }));
  };
  const deleteObjective = (id) => {
    setLayout(prev => ({ ...prev, objectives: prev.objectives.filter(o => o.id !== id) }));
    setSelected(null);
  };

  const addStructure = (type) => {
    const st = newStructure(type, [0, 0, 0], layout.activeMapId);
    setLayout(prev => ({ ...prev, structures: [...prev.structures, st] }));
    setSelected({ kind: 'structure', id: st.id });
  };
  const updateStructure = (id, updates) => {
    setLayout(prev => ({ ...prev, structures: prev.structures.map(s => s.id === id ? { ...s, ...updates } : s) }));
  };
  const deleteStructure = (id) => {
    setLayout(prev => ({ ...prev, structures: prev.structures.filter(s => s.id !== id) }));
    setSelected(null);
  };

  const updateInfantry = (id, updates) => {
    setLayout(prev => ({ ...prev, infantryTokens: prev.infantryTokens.map(t => t.id === id ? { ...t, ...updates } : t) }));
  };
  const deleteInfantry = (id) => {
    setLayout(prev => ({ ...prev, infantryTokens: prev.infantryTokens.filter(t => t.id !== id) }));
    setSelected(null);
  };

  const updateModelAsset = (id, updates) => {
    setLayout(prev => ({ ...prev, modelAssets: prev.modelAssets.map(a => a.id === id ? { ...a, ...updates } : a) }));
  };
  const deleteModelAsset = (id) => {
    setLayout(prev => ({ ...prev, modelAssets: prev.modelAssets.filter(a => a.id !== id) }));
    setSelected(null);
  };
  const addModelAsset = (name, url) => {
    setLayout(prev => {
      const asset = newModelAsset(name, url, [Math.random() * 6 - 3, 0, Math.random() * 6 - 3], prev.activeMapId);
      setSelected({ kind: 'modelAsset', id: asset.id });
      return { ...prev, modelAssets: [...prev.modelAssets, asset] };
    });
  };
  const handleUploadModel = async (file) => {
    setModelUploadError(null);
    setModelUploading(true);
    const formData = new FormData();
    formData.append('model', file);
    const { data, error } = await api.uploadEventMapModel(orgId, eventId, formData);
    setModelUploading(false);
    if (error) { setModelUploadError(error); return; }
    addModelAsset(data.name, data.url);
  };

  const ELEVATION_STEP = 0.5;
  const ARRAY_KEY_BY_KIND = { objective: 'objectives', structure: 'structures', infantry: 'infantryTokens', modelAsset: 'modelAssets' };
  const adjustElevation = (kind, id, delta) => {
    const arrKey = ARRAY_KEY_BY_KIND[kind];
    setLayout(prev => ({
      ...prev,
      [arrKey]: prev[arrKey].map(e => e.id === id ? { ...e, elevationOffset: (e.elevationOffset || 0) + delta } : e),
    }));
  };
  // Ground-relative (default) vs. elevated (flat base-elevation plane) —
  // infantry has no toggle, it's always ground-relative.
  const toggleElevated = (kind, id) => {
    const arrKey = ARRAY_KEY_BY_KIND[kind];
    setLayout(prev => ({
      ...prev,
      [arrKey]: prev[arrKey].map(e => e.id === id ? { ...e, elevated: !e.elevated } : e),
    }));
  };

  const updateGroupComposition = (groupIndex, composition) => {
    setLayout(prev => ({ ...prev, groupTokens: prev.groupTokens.map(t => t.group_index === groupIndex ? { ...t, composition } : t) }));
  };
  // Three states per group: not placed -> place on the active map; placed on
  // the active map -> remove; placed on a different map -> move it here.
  const handleGroupPlacement = (groupIndex) => {
    setLayout(prev => ({
      ...prev,
      groupTokens: prev.groupTokens.map(t => {
        if (t.group_index !== groupIndex) return t;
        if (!t.placed) {
          return { ...t, placed: true, mapId: prev.activeMapId, position: [Math.random() * 6 - 3, 0, Math.random() * 6 - 3] };
        }
        if (t.mapId !== prev.activeMapId) {
          return { ...t, mapId: prev.activeMapId, position: [Math.random() * 6 - 3, 0, Math.random() * 6 - 3] };
        }
        return { ...t, placed: false };
      }),
    }));
  };
  // Planning-only visual link (e.g. a fighter wing operating out of a
  // carrier group) — independent of the group tree's parent_index, which is
  // command structure, not physical embarkation, and isn't monitored live.
  const updateGroupHost = (groupIndex, hostedByIndex) => {
    setLayout(prev => ({
      ...prev,
      groupTokens: prev.groupTokens.map(t => t.group_index === groupIndex ? { ...t, hosted_by_group_index: hostedByIndex } : t),
    }));
  };

  const handleSwitchMap = (id) => setLayout(prev => ({ ...prev, activeMapId: id }));

  const handleAddMap = (name, kind) => {
    setLayout(prev => {
      const map = newMap(name, kind, prev.maps.length);
      return { ...prev, maps: [...prev.maps, map], activeMapId: map.id };
    });
    setSelected(null);
    setPlaceMode(null);
  };

  const handleRenameMap = (id, name) => {
    setLayout(prev => ({ ...prev, maps: prev.maps.map(m => m.id === id ? { ...m, name } : m) }));
  };

  const handleDeleteMap = (id) => {
    setLayout(prev => {
      if (prev.maps.length <= 1) return prev;
      const remaining = prev.maps.filter(m => m.id !== id);
      const activeMapId = prev.activeMapId === id ? remaining[0].id : prev.activeMapId;
      return {
        ...prev,
        maps: remaining,
        activeMapId,
        objectives: prev.objectives.filter(o => o.mapId !== id),
        structures: prev.structures.filter(s => s.mapId !== id),
        infantryTokens: prev.infantryTokens.filter(t => t.mapId !== id),
        modelAssets: prev.modelAssets.filter(a => a.mapId !== id),
        // Group tokens are roster-linked, not freeform — unplace rather than
        // delete so the roster/composition data is never lost.
        groupTokens: prev.groupTokens.map(t => t.mapId === id ? { ...t, placed: false } : t),
      };
    });
    setSelected(null);
  };

  const updateMapTerrain = (mapId, updates) => {
    setLayout(prev => ({
      ...prev,
      maps: prev.maps.map(m => m.id === mapId ? { ...m, terrain: { ...m.terrain, ...updates } } : m),
    }));
  };

  const resetTerrain = () => {
    const t = activeMap?.terrain;
    if (!t) return;
    const size = (t.segments + 1) * (t.segments + 1);
    updateMapTerrain(layout.activeMapId, { heightMap: new Array(size).fill(0), strokes: [] });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    const { error } = await api.saveEventMapLayout(orgId, eventId, layout);
    setSaving(false);
    if (!error) setSavedAt(new Date());
    else {
      setSaveError(error);
      console.error('[MissionMap] saveEventMapLayout failed:', error);
    }
  };

  const activeMap = layout ? (layout.maps.find(m => m.id === layout.activeMapId) || layout.maps[0]) : null;
  const mapKind = activeMap?.kind || 'space';
  const terrain = activeMap?.terrain;

  // Ground-relative entities (objectives/structures/infantry, default
  // elevated:false) track the terrain contour under them; elevated ones and
  // ships instead ride the map's flat baseElevation plane (ships clamped to
  // never sink below the actual terrain surface) — see terrain.js. Space
  // maps are unaffected: everything stays at its stored y, as before.
  const snapEntity = useCallback((entity) => {
    if (mapKind !== 'surface' || !terrain) return entity;
    const [x, , z] = entity.position;
    return { ...entity, position: [x, resolveEntityHeight(entity, terrain), z] };
  }, [mapKind, terrain]);

  const snapShip = useCallback((entity) => {
    if (mapKind !== 'surface' || !terrain) return entity;
    const [x, , z] = entity.position;
    return { ...entity, position: [x, resolveShipHeight(entity, terrain), z] };
  }, [mapKind, terrain]);

  const visible = useMemo(() => {
    if (!layout) return { objectives: [], structures: [], groupTokens: [], infantryTokens: [], modelAssets: [] };
    return {
      objectives: layout.objectives.filter(o => o.mapId === layout.activeMapId).map(snapEntity),
      structures: layout.structures.filter(s => s.mapId === layout.activeMapId).map(snapEntity),
      groupTokens: layout.groupTokens.filter(t => t.placed && t.mapId === layout.activeMapId).map(snapShip),
      infantryTokens: layout.infantryTokens.filter(t => t.mapId === layout.activeMapId).map(snapEntity),
      modelAssets: layout.modelAssets.filter(a => a.mapId === layout.activeMapId).map(snapEntity),
    };
  }, [layout, snapEntity, snapShip]);

  const countsByMapId = useMemo(() => {
    if (!layout) return {};
    const counts = {};
    layout.objectives.forEach(o => { counts[o.mapId] = (counts[o.mapId] || 0) + 1; });
    layout.structures.forEach(s => { counts[s.mapId] = (counts[s.mapId] || 0) + 1; });
    layout.infantryTokens.forEach(t => { counts[t.mapId] = (counts[t.mapId] || 0) + 1; });
    layout.modelAssets.forEach(a => { counts[a.mapId] = (counts[a.mapId] || 0) + 1; });
    layout.groupTokens.forEach(t => { if (t.placed) counts[t.mapId] = (counts[t.mapId] || 0) + 1; });
    return counts;
  }, [layout]);

  if (loading || !layout) {
    return (
      <div style={S.overlay}>
        <div style={{ margin: 'auto', color: '#0e7490', fontFamily: 'monospace', fontSize: 12 }}>Loading map…</div>
      </div>
    );
  }

  const selectedObjective = selected?.kind === 'objective' ? layout.objectives.find(o => o.id === selected.id) : null;
  const selectedInfantry = selected?.kind === 'infantry' ? layout.infantryTokens.find(t => t.id === selected.id) : null;
  const selectedModelAsset = selected?.kind === 'modelAsset' ? layout.modelAssets.find(a => a.id === selected.id) : null;

  return (
    <div style={S.overlay}>
      <div style={S.header}>
        <div style={{ fontSize: 13, color: '#22d3ee', letterSpacing: '0.2em', fontFamily: 'monospace' }}>MISSION MAP</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {saveError && <span style={{ fontSize: 10, color: '#ef4444', fontFamily: 'monospace' }}>{saveError}</span>}
          {!saveError && savedAt && <span style={{ fontSize: 10, color: '#4ade80', fontFamily: 'monospace' }}>Saved {savedAt.toLocaleTimeString()}</span>}
          {canEdit && (
            <button onClick={handleSave} disabled={saving} style={{ ...S.btnCyan, opacity: saving ? 0.5 : 1 }}>
              {saving ? 'SAVING…' : 'SAVE'}
            </button>
          )}
          <button onClick={onClose} style={S.btnDim}>← BACK</button>
        </div>
      </div>

      <MapTabs
        maps={layout.maps}
        activeMapId={layout.activeMapId}
        canEdit={canEdit}
        countsByMapId={countsByMapId}
        onSwitch={handleSwitchMap}
        onAdd={handleAddMap}
        onRename={handleRenameMap}
        onDelete={handleDeleteMap}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {canEdit && (
          <div style={S.panel}>
            <button
              onClick={() => setPlaceMode(m => m === 'objective' ? null : 'objective')}
              style={{ ...S.btnCyan, width: '100%', background: placeMode === 'objective' ? '#0891b2' : '#041e2e', color: placeMode === 'objective' ? '#04101a' : '#22d3ee' }}
            >
              {placeMode === 'objective' ? 'CLICK MAP TO PLACE…' : '+ PLACE OBJECTIVE'}
            </button>

            {selectedObjective && (
              <div style={{ marginTop: 8, padding: 8, background: '#020c14', border: '1px solid #0e2233', borderRadius: 3 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 10, color: '#22d3ee' }}>EDIT OBJECTIVE</span>
                  <button onClick={() => deleteObjective(selectedObjective.id)} style={{ fontSize: 9, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer' }}>DELETE</button>
                </div>
                <input value={selectedObjective.name} onChange={e => updateObjective(selectedObjective.id, { name: e.target.value })} style={{ ...S.input, marginBottom: 6 }} maxLength={64} />
                <label style={S.label}>TYPE</label>
                <select value={selectedObjective.type} onChange={e => updateObjective(selectedObjective.id, { type: e.target.value })} style={{ ...S.input, marginBottom: 6 }}>
                  {OBJECTIVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <label style={S.label}>STATUS</label>
                <select value={selectedObjective.status} onChange={e => updateObjective(selectedObjective.id, { status: e.target.value })} style={S.input}>
                  {OBJECTIVE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>

                {mapKind === 'surface' && (
                  <div style={{ marginTop: 6 }}>
                    <label style={S.label}>{selectedObjective.elevated ? 'ELEVATION (base plane)' : 'ELEVATION (ground-relative)'}</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button onClick={() => adjustElevation('objective', selectedObjective.id, -ELEVATION_STEP)} style={S.btnDim}>−</button>
                      <span style={{ fontSize: 11, color: '#e5e7eb', fontFamily: 'monospace', minWidth: 34, textAlign: 'center' }}>{(selectedObjective.elevationOffset || 0).toFixed(1)}</span>
                      <button onClick={() => adjustElevation('objective', selectedObjective.id, ELEVATION_STEP)} style={S.btnDim}>+</button>
                      <button onClick={() => toggleElevated('objective', selectedObjective.id)} style={{ ...S.btnDim, marginLeft: 'auto', fontSize: 9 }}>
                        {selectedObjective.elevated ? 'USE GROUND' : 'USE BASE PLANE'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {mapKind === 'surface' && terrain && (
              <TerrainPanel
                tool={terrainTool.tool}
                brushSize={terrainTool.brushSize}
                brushStrength={terrainTool.brushStrength}
                paintTexture={terrainTool.paintTexture}
                onChange={updates => setTerrainTool(prev => ({ ...prev, ...updates }))}
                onReset={resetTerrain}
              />
            )}

            <InfantryBuilder
              selected={selectedInfantry}
              placeMode={placeMode}
              mapKind={mapKind}
              onTogglePlaceMode={() => setPlaceMode(m => m === 'infantry' ? null : 'infantry')}
              onUpdate={updateInfantry}
              onDelete={deleteInfantry}
              onAdjustElevation={delta => adjustElevation('infantry', selectedInfantry.id, delta)}
            />

            <StructureBuilder
              structures={visible.structures}
              selectedId={selected?.kind === 'structure' ? selected.id : null}
              mapKind={mapKind}
              onAdd={addStructure}
              onUpdate={updateStructure}
              onDelete={deleteStructure}
              onAdjustElevation={delta => adjustElevation('structure', selected.id, delta)}
              onToggleElevated={() => toggleElevated('structure', selected.id)}
            />

            <ModelLibraryPanel
              asset={selectedModelAsset}
              mapKind={mapKind}
              uploading={modelUploading}
              uploadError={modelUploadError}
              onAddFromLibrary={m => addModelAsset(m.name, m.url)}
              onUpload={handleUploadModel}
              onUpdate={updateModelAsset}
              onDelete={deleteModelAsset}
              onAdjustElevation={delta => adjustElevation('modelAsset', selectedModelAsset.id, delta)}
              onToggleElevated={() => toggleElevated('modelAsset', selectedModelAsset.id)}
            />

            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #0e2233' }}>
              <div style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.15em', marginBottom: 6 }}>GROUPS</div>
              {groups.length === 0 && <div style={{ fontSize: 10, color: '#0e7490', opacity: 0.7 }}>No groups yet — build the group tree first.</div>}
              {groups.map((g, i) => {
                const token = layout.groupTokens.find(t => t.group_index === i);
                if (!token) return null;
                const onActiveMap = token.placed && token.mapId === layout.activeMapId;
                const onOtherMap = token.placed && token.mapId !== layout.activeMapId;
                const label = onActiveMap ? 'REMOVE FROM MAP' : (onOtherMap ? 'MOVE TO THIS MAP' : 'PLACE ON MAP');
                return (
                  <div key={i} style={{ marginBottom: 8, padding: 8, background: '#020c14', border: '1px solid #0e2233', borderRadius: 3 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#e5e7eb', fontFamily: 'monospace' }}>{g.name}</span>
                      <button
                        onClick={() => handleGroupPlacement(i)}
                        disabled={token.composition.length === 0}
                        style={{ fontSize: 9, padding: '3px 8px', borderRadius: 3, cursor: token.composition.length === 0 ? 'not-allowed' : 'pointer', opacity: token.composition.length === 0 ? 0.4 : 1, background: onActiveMap ? '#1a0e0e' : '#041e2e', border: `1px solid ${onActiveMap ? '#7f1d1d' : '#0891b2'}`, color: onActiveMap ? '#ef4444' : '#22d3ee' }}
                      >
                        {label}
                      </button>
                    </div>
                    {onOtherMap && (
                      <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2 }}>
                        on {layout.maps.find(m => m.id === token.mapId)?.name || 'another map'}
                      </div>
                    )}
                    <ShipCompositionPicker composition={token.composition} onChange={c => updateGroupComposition(i, c)} />
                    {groups.length > 1 && (
                      <div style={{ marginTop: 6 }}>
                        <label style={{ fontSize: 9, color: '#0e7490', display: 'block', marginBottom: 2 }}>HOSTED BY (planning only)</label>
                        <select
                          value={token.hosted_by_group_index ?? ''}
                          onChange={e => updateGroupHost(i, e.target.value === '' ? null : parseInt(e.target.value))}
                          style={{ ...S.input, fontSize: 10, padding: '3px 6px' }}
                        >
                          <option value="">— none —</option>
                          {groups.map((g2, j) => j !== i && (
                            <option key={j} value={j}>{g2.name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ flex: 1, position: 'relative' }}>
          <Canvas camera={{ position: [0, 18, 22], fov: 50 }} onPointerMissed={() => setSelected(null)}>
            <OrbitControls enabled={!isDragging && !sculptActive} maxPolarAngle={Math.PI / 2.1} />
            <Scene
              mapKind={mapKind}
              terrain={terrain}
              activeTool={terrainTool.tool ? terrainTool : null}
              onTerrainChange={heightMap => updateMapTerrain(layout.activeMapId, { heightMap })}
              onStrokesChange={strokes => updateMapTerrain(layout.activeMapId, { strokes })}
              onSculptActiveChange={setSculptActive}
              visibleObjectives={visible.objectives}
              visibleStructures={visible.structures}
              visibleGroupTokens={visible.groupTokens}
              visibleInfantry={visible.infantryTokens}
              visibleModelAssets={visible.modelAssets}
              canEdit={canEdit}
              placeMode={placeMode}
              selected={selected}
              setSelected={setSelected}
              dragRef={dragRef}
              setIsDragging={setIsDragging}
              onPlace={handlePlace}
              onMove={handleMove}
              groups={groups}
            />
          </Canvas>
        </div>
      </div>
    </div>
  );
}
