// Data hooks shared by the full OperationPlanner (main window) and the tray
// strip's planner: presets, ship search / crew roles / slot claims, and the
// post-launch channel tree. Each wraps the same endpoints the full planner
// called inline before; the pure parts live in utils/eventGroups.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { buildChannelTree, presetLayoutFromGroups, sumShipCrewRoles } from './eventGroups';

/**
 * The server's group-layout presets. Loads when `enabled` (planners only).
 * save(name, groups) / remove(id) → { error } and reload the list.
 */
export function useEventPresets(orgId, enabled) {
  const [presets, setPresets] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.getEventPresets(orgId);
    setPresets(data?.presets || []);
  }, [orgId]);

  useEffect(() => { if (enabled) load(); }, [load, enabled]);

  const save = useCallback(async (name, groups) => {
    setSaving(true);
    const { error } = await api.saveEventPreset(orgId, name.trim(), presetLayoutFromGroups(groups));
    setSaving(false);
    if (!error) load();
    return { error };
  }, [orgId, load]);

  const remove = useCallback(async (presetId) => {
    const { error } = await api.deleteEventPreset(orgId, presetId);
    if (!error) load();
    return { error };
  }, [orgId, load]);

  return { presets, saving, load, save, remove };
}

/** Debounced (250ms) Star Citizen ship search while `open`. */
export function useShipSearch(open, query) {
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    setSearching(true);
    const t = setTimeout(async () => {
      const { data } = await api.getGameShips('star_citizen', query.trim());
      setResults(data?.ships || []);
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query, open]);
  return { results, searching };
}

/**
 * Adds a ship to a composition. A slug already present bumps its quantity
 * instead (composition entries are the claim system's unit of identity —
 * event_group_ship_claims is keyed by group_id + ship_slug + slot_index — so
 * two rows sharing a slug would collide). New entries snapshot the ship's
 * length so map tokens can scale to ship size. Resolves to the new list.
 */
export async function addShipToComposition(composition, ship, qty) {
  const existingIdx = composition.findIndex(c => c.ship_slug === ship.slug);
  if (existingIdx !== -1) {
    return composition.map((c, i) => i === existingIdx ? { ...c, quantity: c.quantity + Math.max(1, qty) } : c);
  }
  const { data } = await api.getShipDimensions('star_citizen', ship.slug);
  const length = typeof data?.dimensions?.length === 'number' ? data.dimensions.length : null;
  return [...composition, { ship_slug: ship.slug, ship_name: ship.name, ship_icon_url: ship.icon_url || null, quantity: Math.max(1, qty), length }];
}

export const compositionKeyOf = (composition) => (composition || []).map(s => `${s.ship_slug}:${s.quantity || 1}`).join(',');

/**
 * Crew roles for a ship composition (fetched per ship, summed by
 * sumShipCrewRoles). Re-runs only when the composition itself changes;
 * `onLoaded(roles)` is called once per load (the planners use it to auto-fill
 * an empty role list).
 */
export function useShipCrewRoles(composition, onLoaded) {
  const [shipRoles, setShipRoles] = useState([]);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  const key = compositionKeyOf(composition);
  useEffect(() => {
    setShipRoles([]);
    if (!composition || composition.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      const perShip = await Promise.all(
        composition.map(s => api.getShipCrewRoles('star_citizen', s.ship_slug).then(({ data }) => ({ quantity: s.quantity || 1, roles: data?.roles || [] })))
      );
      if (cancelled) return;
      const roles = sumShipCrewRoles(perShip);
      setShipRoles(roles);
      onLoadedRef.current?.(roles);
    })();
    return () => { cancelled = true; };
    // Only the composition itself (its key) triggers a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return shipRoles;
}

/**
 * Ship slot claims for one ship-composed group: a slot needs an owner of a
 * matching (or approved-similar) hangar ship claiming it before that hull's
 * crew seats unlock. The three calls are the plan's (they reload it).
 * Returns { entries, busy, claim(shipSlug, slotIndex, userShipId), release(shipSlug) }.
 */
export function useShipSlotClaims({ groupId, ships, getClaimableShips, claimShipSlot, releaseShipSlot }) {
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);
  const compositionFingerprint = compositionKeyOf(ships);
  const claimsFingerprint = (ships || []).map(s => (s.claims || []).map(c => `${c.slot_index}:${c.user_id}`).join(',')).join('|');

  const load = useCallback(async () => {
    const { data } = await getClaimableShips(groupId);
    setEntries(data?.entries || []);
  }, [groupId, getClaimableShips]);

  useEffect(() => {
    if (!compositionFingerprint) { setEntries(null); return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositionFingerprint, claimsFingerprint]);

  const claim = async (shipSlug, slotIndex, userShipId) => {
    setBusy(true);
    const { error } = await claimShipSlot(groupId, shipSlug, slotIndex, userShipId);
    setBusy(false);
    if (!error) load();
  };
  const release = async (shipSlug) => {
    setBusy(true);
    const { error } = await releaseShipSlot(groupId, shipSlug);
    setBusy(false);
    if (!error) load();
  };
  // EVVIEW: `reload` — the strip's ship sign-up refetches eligibility after
  // adding a ship to the hangar (the claims fingerprint doesn't change then).
  return { entries: compositionFingerprint ? entries : null, busy, claim, release, reload: load };
}

/** A launched op's voice-channel hierarchy → { loading, channels, roots, childMap }. */
export function useEventChannelTree(orgId, eventId, enabled = true) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled || !orgId || !eventId) return undefined;
    let stale = false;
    (async () => {
      const { data } = await api.getEventChannelTree(orgId, eventId);
      if (stale) return;
      setChannels(data?.channels || []);
      setLoading(false);
    })();
    return () => { stale = true; };
  }, [orgId, eventId, enabled]);
  return { loading, channels, ...buildChannelTree(channels) };
}
