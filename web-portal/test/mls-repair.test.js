import { describe, it, expect, vi } from 'vitest';
import { createMlsRepair, STEP_WINDOW_MS, LADDER_COOLDOWN_MS, autoRepairEnabled, AUTO_REPAIR_KEY } from '../src/engine/mlsRepair.js';

// S4: the per-group repair ladder controller (engine/mlsRepair.js), with
// injected steps and a fake clock (sleep advances it instantly).
function setup({ recoverAfter = null, enabled = true, online = true, windowMs = STEP_WINDOW_MS } = {}) {
  let t = 1_000_000;
  const stuck = new Set(['g1']);
  const calls = [];
  const flags = { enabled, online };
  const log = vi.fn();
  const repairingChanges = [];
  const mkStep = (name) => ({
    name,
    run: vi.fn(async (id) => {
      calls.push(`${name}:${id}`);
      if (recoverAfter === name) stuck.delete(id);
      return { action: name };
    }),
  });
  const steps = [mkStep('sync'), mkStep('ensure'), mkStep('reset')];
  const sleeps = [];
  const ctl = createMlsRepair({
    steps,
    isStuck: (id) => stuck.has(id),
    enabled: () => flags.enabled,
    online: () => flags.online,
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    log,
    onRepairingChange: (ids) => repairingChanges.push(ids),
    windowMs,
  });
  return { ctl, stuck, calls, steps, flags, log, repairingChanges, sleeps, advance: (ms) => { t += ms; } };
}

describe('mlsRepair ladder', () => {
  it('runs the steps in order, waiting a window after each, then reports exhausted', async () => {
    const s = setup();
    const r = await s.ctl.runLadder('g1');
    expect(r.result).toBe('exhausted');
    expect(s.calls).toEqual(['sync:g1', 'ensure:g1', 'reset:g1']);
    expect(s.sleeps).toEqual([STEP_WINDOW_MS, STEP_WINDOW_MS, STEP_WINDOW_MS]);
    expect(s.log.mock.calls.some(([lvl, msg]) => lvl === 'error' && /repair exhausted/.test(msg))).toBe(true);
    expect(s.repairingChanges).toEqual([['g1'], []]);
    expect(s.ctl.repairing()).toEqual([]);
  });

  it('stops early once the group recovers', async () => {
    const s = setup({ recoverAfter: 'ensure' });
    const r = await s.ctl.runLadder('g1');
    expect(r).toEqual({ result: 'recovered', step: 'ensure' });
    expect(s.calls).toEqual(['sync:g1', 'ensure:g1']);
    expect(s.steps[2].run).not.toHaveBeenCalled();
  });

  it('a recovery signalled by the detector ends the wait without the full window', async () => {
    let t = 0;
    const stuck = new Set(['g1']);
    let wake;
    const ctl = createMlsRepair({
      steps: [{ name: 'sync', run: async () => ({}) }, { name: 'ensure', run: vi.fn(async () => ({})) }],
      isStuck: (id) => stuck.has(id),
      now: () => t,
      sleep: () => new Promise((r) => { wake = r; }), // never advances on its own
      log: () => {},
    });
    const p = ctl.runLadder('g1');
    await new Promise((r) => setTimeout(r, 0));
    stuck.delete('g1');
    ctl.handleStuck([]); // mlsHealth: no longer stuck
    await expect(p).resolves.toEqual({ result: 'recovered', step: 'sync' });
    wake?.();
  });

  it('a failing step is logged and the ladder moves on', async () => {
    const s = setup();
    s.steps[0].run.mockImplementationOnce(async () => { throw new Error('boom'); });
    const r = await s.ctl.runLadder('g1');
    expect(r.result).toBe('exhausted');
    expect(s.steps[1].run).toHaveBeenCalledTimes(1);
    expect(s.log.mock.calls.some(([, msg]) => /repair step failed/.test(msg))).toBe(true);
  });

  it('rate-limits to one ladder per group per cooldown', async () => {
    const s = setup();
    await s.ctl.runLadder('g1');
    expect((await s.ctl.runLadder('g1')).result).toBe('rate_limited');
    expect(s.calls).toHaveLength(3);
    s.advance(LADDER_COOLDOWN_MS);
    expect((await s.ctl.runLadder('g1')).result).toBe('exhausted');
    expect(s.calls).toHaveLength(6);
  });

  it('runs one ladder per group at a time and leaves other groups alone', async () => {
    const s = setup();
    s.stuck.add('g2');
    const first = s.ctl.runLadder('g1');
    expect((await s.ctl.runLadder('g1')).result).toBe('busy');
    expect(s.ctl.repairing()).toEqual(['g1']);
    await first;
    expect(s.calls.every((c) => c.endsWith(':g1'))).toBe(true);
  });

  it('handleStuck starts a ladder per newly stuck group, never twice concurrently', async () => {
    const s = setup();
    s.ctl.handleStuck(['g1']);
    s.ctl.handleStuck(['g1']);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls.filter((c) => c === 'sync:g1')).toHaveLength(1);
  });

  it('does nothing when the setting is off', async () => {
    const s = setup({ enabled: false });
    expect((await s.ctl.runLadder('g1')).result).toBe('disabled');
    s.ctl.handleStuck(['g1']);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.calls).toEqual([]);
  });

  it('stops between steps when the setting is turned off mid-ladder', async () => {
    const s = setup();
    s.steps[0].run.mockImplementationOnce(async () => { s.flags.enabled = false; return {}; });
    const r = await s.ctl.runLadder('g1');
    expect(r).toEqual({ result: 'disabled', step: 'ensure' });
    expect(s.steps[1].run).not.toHaveBeenCalled();
  });

  it('never runs while offline, and an offline attempt does not use up the cooldown', async () => {
    const s = setup({ online: false });
    expect((await s.ctl.runLadder('g1')).result).toBe('offline');
    expect(s.calls).toEqual([]);
    s.flags.online = true;
    expect((await s.ctl.runLadder('g1')).result).toBe('exhausted');
  });
});

describe('autoRepairEnabled', () => {
  it("defaults to on and is off only for '0'", () => {
    const store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k) => (store.has(k) ? store.get(k) : null) });
    try {
      expect(autoRepairEnabled()).toBe(true);
      store.set(AUTO_REPAIR_KEY, '0');
      expect(autoRepairEnabled()).toBe(false);
      store.set(AUTO_REPAIR_KEY, '1');
      expect(autoRepairEnabled()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
