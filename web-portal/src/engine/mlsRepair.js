// S4: automatic per-group MLS repair, triggered by the stuck-group detector
// (engine/mlsHealth.js).
//
// When a group is flagged stuck, a ladder runs for THAT group only, one step
// at a time; after each step it waits up to STEP_WINDOW_MS for a successful
// decrypt (the detector un-flags the group) before trying the next:
//   1. sync    catch up to the server's epoch, then re-export keys
//   2. ensure  full ensure*Group (join / resync if diverged, reconcile)
//   3. reset   forced re-join: resync_external (drops the local copy, external
//              commit that also removes our old leaf); if the local copy is
//              too broken to even build that, delete it and join fresh
// After step 3: stop, the chip stays up, "repair exhausted" is logged.
//
// Guards: one ladder per group at a time; at most one ladder per group per
// LADDER_COOLDOWN_MS; nothing while offline or with the setting off
// (specter_mls_auto_repair = '0'); never touches another group.
//
// The controller (createMlsRepair) is pure: steps, clock, health and logging
// are injected, so it's unit-tested without MLS or WASM. startMlsAutoRepair
// wires it to the shared detector; the step functions come from the caller
// (WarRoom → mlsSession.repairGroupStep), so this file never imports WASM.

import { stuckGroups as healthStuckGroups, subscribe as healthSubscribe } from './mlsHealth.js';

export const STEP_WINDOW_MS = 15_000;
export const LADDER_COOLDOWN_MS = 10 * 60_000;
export const AUTO_REPAIR_KEY = 'specter_mls_auto_repair';

/** The setting: default ON, '0' = off. */
export function autoRepairEnabled() {
  try {
    return globalThis.localStorage?.getItem(AUTO_REPAIR_KEY) !== '0';
  } catch {
    return true;
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleLog = (level, msg, fields) => {
  const fn = level === 'warn' || level === 'error' ? console.warn : console.log;
  fn(`[mls-repair] ${msg} ${JSON.stringify(fields ?? {})}`);
};

/**
 * steps: [{ name, run(groupId) → Promise<outcome> }] in ladder order.
 * isStuck(groupId) → bool; enabled() / online() → bool; now() → ms;
 * sleep(ms) → Promise; log(level, msg, fields) (mlsLog's signature);
 * onRepairingChange(groupIds[]) when the set of running ladders changes.
 */
export function createMlsRepair({
  steps,
  isStuck,
  enabled = () => true,
  online = () => true,
  now = () => Date.now(),
  sleep = defaultSleep,
  log = null,
  onRepairingChange = null,
  windowMs = STEP_WINDOW_MS,
  cooldownMs = LADDER_COOLDOWN_MS,
} = {}) {
  const active = new Set();        // groupIds with a ladder running
  const lastLadderAt = new Map();  // groupId -> ms the last ladder started
  const waiters = new Map();       // groupId -> Set<resolve(true)> (recovered)
  let stopped = false;

  const emitLog = (level, msg, fields) => {
    try { (log || consoleLog)(level, msg, fields); } catch { /* never throws */ }
  };
  const notify = () => {
    try { onRepairingChange?.([...active].sort()); } catch { /* listener */ }
  };
  const stuckNow = (id) => {
    try { return Boolean(isStuck(id)); } catch { return true; }
  };

  /** Up to `ms` for `id` to stop being stuck → recovered? */
  function waitRecovered(id, ms) {
    if (!stuckNow(id)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        waiters.get(id)?.delete(onRecover);
        resolve(v);
      };
      const onRecover = () => finish(true);
      if (!waiters.has(id)) waiters.set(id, new Set());
      waiters.get(id).add(onRecover);
      Promise.resolve(sleep(ms)).then(() => finish(!stuckNow(id)), () => finish(!stuckNow(id)));
    });
  }

  /** Runs the ladder for one group → { result, step? }. */
  async function runLadder(groupId) {
    const id = String(groupId);
    if (stopped) return { result: 'stopped' };
    if (!enabled()) return { result: 'disabled' };
    if (!online()) {
      emitLog('info', 'repair postponed: offline', { groupId: id });
      return { result: 'offline' };
    }
    if (active.has(id)) return { result: 'busy' };
    const last = lastLadderAt.get(id);
    if (last != null && now() - last < cooldownMs) {
      emitLog('info', 'repair skipped: a ladder ran for this group recently', { groupId: id, agoMs: now() - last });
      return { result: 'rate_limited' };
    }
    if (!stuckNow(id)) return { result: 'recovered' };

    lastLadderAt.set(id, now());
    active.add(id);
    notify();
    emitLog('warn', 'repair ladder started for a stuck group', { groupId: id, steps: steps.length });
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (stopped) return { result: 'stopped', step: step.name };
        if (!enabled()) {
          emitLog('info', 'repair stopped: automatic repair turned off', { groupId: id, step: step.name });
          return { result: 'disabled', step: step.name };
        }
        if (!online()) {
          emitLog('info', 'repair stopped: offline', { groupId: id, step: step.name });
          return { result: 'offline', step: step.name };
        }
        emitLog('info', 'repair step running', { groupId: id, step: step.name, n: i + 1 });
        try {
          const out = await step.run(id);
          emitLog('info', 'repair step finished', {
            groupId: id, step: step.name, action: out?.action ?? null, reason: out?.reason ?? null,
          });
        } catch (err) {
          emitLog('warn', 'repair step failed', { groupId: id, step: step.name, error: String(err?.message ?? err).slice(0, 200) });
        }
        if (await waitRecovered(id, windowMs)) {
          emitLog('info', 'repair recovered the group', { groupId: id, step: step.name });
          return { result: 'recovered', step: step.name };
        }
      }
      emitLog('error', 'repair exhausted: group still out of sync after every step', { groupId: id });
      return { result: 'exhausted' };
    } finally {
      active.delete(id);
      notify();
    }
  }

  /** mlsHealth subscriber: start a ladder for each newly stuck group; wake waiters of recovered ones. */
  function handleStuck(stuckIds) {
    const stuck = new Set((stuckIds || []).map(String));
    for (const [id, set] of waiters) {
      if (!stuck.has(id)) for (const fn of [...set]) fn();
    }
    if (stopped || !enabled()) return;
    for (const id of stuck) {
      if (!active.has(id)) runLadder(id).catch(() => {});
    }
  }

  function stop() {
    stopped = true;
    for (const set of waiters.values()) for (const fn of [...set]) fn();
  }

  return { runLadder, handleStuck, repairing: () => [...active].sort(), stop };
}

/**
 * Wires a controller to the shared detector. repairStep(groupId, name) runs
 * one ladder step ('sync' | 'ensure' | 'reset'). Re-checks the stuck set when
 * the network comes back. → stop()
 */
export function startMlsAutoRepair({ repairStep, log = null, onRepairingChange = null }) {
  const names = ['sync', 'ensure', 'reset'];
  const ctl = createMlsRepair({
    steps: names.map((name) => ({ name, run: (groupId) => repairStep(groupId, name) })),
    isStuck: (id) => healthStuckGroups().includes(id),
    enabled: autoRepairEnabled,
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    log,
    onRepairingChange,
  });
  const unsubscribe = healthSubscribe((ids) => ctl.handleStuck(ids));
  const onOnline = () => ctl.handleStuck(healthStuckGroups());
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  // Anything already flagged before we subscribed.
  const initial = healthStuckGroups();
  if (initial.length) ctl.handleStuck(initial);
  return () => {
    unsubscribe();
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    ctl.stop();
  };
}
