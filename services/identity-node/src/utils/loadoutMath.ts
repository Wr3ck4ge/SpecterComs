// Server-side port of the loadout-merging/weapon-grouping logic that lives
// client-side in web-portal/src/components/ShipEditor.jsx (applyLoadoutOverrides,
// collectGunDescendants, collectWeaponGroups). Duplicated by necessity — this
// is a Node service, not a browser bundle sharing web-portal's code — but kept
// deliberately small and mirroring the client 1:1 so the two don't drift.
//
// Used by getGroupDpsEstimate (eventsController.ts) to figure out which
// weapon MOUNT (turret/rack hardpoint) a crewed seat controls, so DPS can be
// gated on whether that seat is actually crewed for the mission.

export interface LoadoutNode {
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

export interface LoadoutOverride {
  port_id: string;
  class_name: string;
  name: string;
}

export function mergeLoadoutOverrides(nodes: LoadoutNode[], overridesByPortId: Record<string, LoadoutOverride>): LoadoutNode[] {
  return (nodes || []).map(node => {
    const ov = node.port_id && overridesByPortId[node.port_id];
    return {
      ...node,
      name: ov ? ov.name : node.name,
      class_name: ov ? ov.class_name : node.class_name,
      children: mergeLoadoutOverrides(node.children, overridesByPortId),
    };
  });
}

// A MissileLauncher rack's own component row carries no damage stats (see
// componentDetail.ts's header comment) — the loaded Missile child does. So
// "guns" means WeaponGun or Missile nodes, matching ShipEditor.jsx.
function collectGunDescendants(nodes: LoadoutNode[], out: LoadoutNode[]): LoadoutNode[] {
  for (const n of (nodes || [])) {
    if (n.type === 'WeaponGun' || n.type === 'Missile') out.push(n);
    collectGunDescendants(n.children, out);
  }
  return out;
}

export interface WeaponGroup {
  // The mount's own hardpoint_name (a turret or missile rack) — null for a
  // bare top-level gun with no turret/rack wrapper (a fixed, pilot-fired
  // weapon, per ShipEditor.jsx's isBareGun case).
  hardpoint_name: string | null;
  is_bare: boolean;
  guns: LoadoutNode[];
}

export function collectWeaponGroups(topLevelNodes: LoadoutNode[]): WeaponGroup[] {
  const groups: WeaponGroup[] = [];
  for (const top of (topLevelNodes || [])) {
    const guns = collectGunDescendants([top], []);
    if (guns.length === 0) continue;
    const isBare = guns.length === 1 && guns[0] === top;
    groups.push({ hardpoint_name: isBare ? null : (top.hardpoint_name || null), is_bare: isBare, guns });
  }
  return groups;
}
