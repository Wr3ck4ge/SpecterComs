import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../api';

// P2C: data hook for the personal hangar (global per-user; see
// database/migrations/000041_user_hangar). Same endpoints as Hangar.jsx and
// WarRoom's updateShip, which stay as they are for the main window.
//
//   ships     null (loading) | hangar ship rows
//   error     load failure
//   add(slug) → { error }      remove(id) → { error }
//   update(id, patch) → { error } — the row is replaced by the server's copy,
//                   which the editor reads back on every render (seat locks
//                   and loadout overrides are read from the `ship` prop).
//   search(q) → Promise<ships[]> catalogue search for "add a ship"
export default function useHangar() {
  const [ships, setShips] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const { data, error: err } = await api.getHangar();
    if (err) { setError(typeof err === 'string' ? err : 'Could not load your hangar'); setShips((s) => s || []); return; }
    setError(null);
    setShips(data?.ships || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = useCallback(async (slug) => {
    const { error: err } = await api.addHangarShip(slug);
    if (!err) await load();
    return { error: err || null };
  }, [load]);

  const remove = useCallback(async (id) => {
    const { error: err } = await api.removeHangarShip(id);
    if (!err) setShips((prev) => (prev || []).filter((s) => s.id !== id));
    return { error: err || null };
  }, []);

  const update = useCallback(async (id, patch) => {
    const { data, error: err } = await api.updateHangarShip(id, patch);
    if (!err && data?.ship) setShips((prev) => (prev || []).map((s) => (s.id === id ? data.ship : s)));
    return { error: err || null };
  }, []);

  const search = useCallback(async (q) => {
    const { data } = await api.getGameShips('star_citizen', q.trim());
    return data?.ships || [];
  }, []);

  return { ships, error, load, add, remove, update, search };
}
