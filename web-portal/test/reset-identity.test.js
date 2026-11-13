import { describe, expect, it } from 'vitest';
import {
  RESET_PANEL_INITIAL, isResetConfirmed, resetPanelReducer, runResetSteps,
} from '../src/utils/resetIdentity.js';

describe('isResetConfirmed', () => {
  it('needs the word RESET (case and surrounding spaces ignored)', () => {
    expect(isResetConfirmed('RESET')).toBe(true);
    expect(isResetConfirmed('  reset ')).toBe(true);
    expect(isResetConfirmed('RESE')).toBe(false);
    expect(isResetConfirmed('RESET!')).toBe(false);
    expect(isResetConfirmed('')).toBe(false);
    expect(isResetConfirmed(null)).toBe(false);
  });
});

describe('runResetSteps', () => {
  const sequence = (log, { failAt = null, optional = [] } = {}) =>
    ['wipe', 'clearId', 'dropServerDevice', 'restart'].map((id) => ({
      id,
      label: id,
      optional: optional.includes(id),
      run: async () => {
        log.push(id);
        if (id === failAt) throw new Error(`${id} broke`);
        return `${id}-ok`;
      },
    }));

  it('runs every step in order: wipe → clear id → drop server device → restart', async () => {
    const log = [];
    const r = await runResetSteps(sequence(log));
    expect(log).toEqual(['wipe', 'clearId', 'dropServerDevice', 'restart']);
    expect(r.done).toEqual(log);
    expect(r.warnings).toEqual([]);
    expect(r.results.restart).toBe('restart-ok');
  });

  it('stops at the first failing required step with a clear error', async () => {
    const log = [];
    const err = await runResetSteps(sequence(log, { failAt: 'clearId' })).catch((e) => e);
    expect(log).toEqual(['wipe', 'clearId']); // never dropped the device or restarted
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Reset stopped at "clearId": clearId broke');
    expect(err.step).toBe('clearId');
    expect(err.done).toEqual(['wipe']);
  });

  it('a failing first step runs nothing else', async () => {
    const log = [];
    const err = await runResetSteps(sequence(log, { failAt: 'wipe' })).catch((e) => e);
    expect(log).toEqual(['wipe']);
    expect(err.done).toEqual([]);
  });

  it('an optional step failing is a warning, and the rest still runs', async () => {
    const log = [];
    const r = await runResetSteps(sequence(log, { failAt: 'dropServerDevice', optional: ['dropServerDevice'] }));
    expect(log).toEqual(['wipe', 'clearId', 'dropServerDevice', 'restart']);
    expect(r.done).toEqual(['wipe', 'clearId', 'restart']);
    expect(r.warnings).toEqual(['dropServerDevice: dropServerDevice broke']);
  });

  it('accepts synchronous steps and non-Error throws', async () => {
    const r = await runResetSteps([{ id: 'a', label: 'A', run: () => 1 }]);
    expect(r.results.a).toBe(1);
    // eslint-disable-next-line no-throw-literal
    const err = await runResetSteps([{ id: 'b', label: 'B', run: () => { throw 'nope'; } }]).catch((e) => e);
    expect(err.message).toBe('Reset stopped at "B": nope');
  });
});

describe('resetPanelReducer', () => {
  const run = (actions, from = RESET_PANEL_INITIAL) => actions.reduce(resetPanelReducer, from);

  it('idle → confirm → running needs the confirm word', () => {
    let s = run([{ type: 'open' }]);
    expect(s.phase).toBe('confirm');
    s = resetPanelReducer(s, { type: 'start' });
    expect(s.phase).toBe('confirm'); // nothing typed
    s = run([{ type: 'type', text: 'RESE' }, { type: 'start' }], s);
    expect(s.phase).toBe('confirm');
    s = run([{ type: 'type', text: 'reset' }, { type: 'start' }], s);
    expect(s.phase).toBe('running');
  });

  it('cannot start straight from idle', () => {
    expect(run([{ type: 'type', text: 'RESET' }, { type: 'start' }]).phase).toBe('idle');
  });

  it('while running, cancel/open/typing are ignored', () => {
    const running = run([{ type: 'open' }, { type: 'type', text: 'RESET' }, { type: 'start' }]);
    expect(resetPanelReducer(running, { type: 'cancel' })).toBe(running);
    expect(resetPanelReducer(running, { type: 'open' })).toBe(running);
    expect(resetPanelReducer(running, { type: 'type', text: 'x' })).toBe(running);
  });

  it('running → done keeps the result; running → error keeps the message', () => {
    const running = run([{ type: 'open' }, { type: 'type', text: 'RESET' }, { type: 'start' }]);
    const done = resetPanelReducer(running, { type: 'succeeded', result: { newLabel: 'u:d', registered: true } });
    expect(done.phase).toBe('done');
    expect(done.result.newLabel).toBe('u:d');
    const failed = resetPanelReducer(running, { type: 'failed', error: 'Reset stopped at "x": y' });
    expect(failed.phase).toBe('error');
    expect(failed.error).toMatch(/Reset stopped/);
    // results only land while running
    expect(resetPanelReducer(RESET_PANEL_INITIAL, { type: 'succeeded', result: {} })).toBe(RESET_PANEL_INITIAL);
  });

  it('cancel from confirm/error goes back to idle and clears the text', () => {
    const s = run([{ type: 'open' }, { type: 'type', text: 'RES' }, { type: 'cancel' }]);
    expect(s).toEqual(RESET_PANEL_INITIAL);
    const running = run([{ type: 'open' }, { type: 'type', text: 'RESET' }, { type: 'start' }]);
    expect(run([{ type: 'failed', error: 'e' }, { type: 'cancel' }], running)).toEqual(RESET_PANEL_INITIAL);
  });
});
