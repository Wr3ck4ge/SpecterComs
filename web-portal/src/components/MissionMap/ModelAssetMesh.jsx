import React, { Suspense, useMemo } from 'react';
import { Html, useGLTF } from '@react-three/drei';
import { UPLOADS_BASE_URL } from '../../api';

// Server-uploaded models are stored as a relative /uploads/... path (same
// convention as avatar/org-logo uploads — see eventsController.ts) and need
// the API origin prefixed. Bundled library models are served by the web app
// itself from /models/... and are used as-is (see ModelLibraryPanel).
function resolveModelUrl(url) {
  return url.startsWith('/uploads/') ? `${UPLOADS_BASE_URL}${url}` : url;
}

// Renders a single loaded GLTF scene graph. Split out from ModelAssetMesh so
// the Suspense boundary below only covers the part that actually suspends
// (useGLTF) — selection/drag chrome around it renders immediately.
function LoadedModel({ url, scale }) {
  const { scene } = useGLTF(resolveModelUrl(url));
  // Clone so multiple placed instances of the same uploaded/library model
  // don't share one Object3D (drei's useGLTF cache returns the same scene
  // graph for a given url — moving one instance would move all of them).
  const cloned = useMemo(() => scene.clone(true), [scene]);
  return <primitive object={cloned} scale={scale} />;
}

// Placeholder shown while a model is loading, or if it fails to load
// (useGLTF throws into the nearest error boundary otherwise — this app has
// none around the map, so a broken/missing file would otherwise blank the
// whole scene; a visible fallback box is safer for a planning tool where an
// org member might upload a bad file).
function ModelFallback() {
  return (
    <mesh>
      <boxGeometry args={[0.8, 0.8, 0.8]} />
      <meshStandardMaterial color="#7c3aed" wireframe />
    </mesh>
  );
}

export default function ModelAssetMesh({ asset, selected, canEdit, onSelect, onDragStart }) {
  return (
    <group
      position={asset.position}
      onPointerDown={e => {
        e.stopPropagation();
        onSelect(asset.id);
        if (canEdit) onDragStart(asset.id);
      }}
    >
      <Suspense fallback={<ModelFallback />}>
        <LoadedModel url={asset.url} scale={asset.scale} />
      </Suspense>
      {selected && (
        <mesh>
          <sphereGeometry args={[0.9, 12, 12]} />
          <meshBasicMaterial color="#f59e0b" wireframe transparent opacity={0.5} />
        </mesh>
      )}
      <Html position={[0, 1.2, 0]} center distanceFactor={14} zIndexRange={[5, 0]}>
        <span style={{ fontSize: 9, color: '#c4b5fd', fontFamily: 'monospace', background: 'rgba(4,13,21,0.85)', padding: '1px 5px', borderRadius: 2, whiteSpace: 'nowrap', border: `1px solid ${selected ? '#f59e0b' : 'transparent'}` }}>
          {asset.name}
        </span>
      </Html>
    </group>
  );
}
