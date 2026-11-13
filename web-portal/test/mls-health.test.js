import { describe, it, expect, vi } from 'vitest';
import { createMlsHealth, FAIL_THRESHOLD, MIN_WINDOW_MS } from '../src/engine/mlsHealth.js';

// S3: stuck-group detection (engine/mlsHealth.js).
function setup() {
  let t = 1_000_000;
  const log = vi.fn();
  const h = createMlsHealth({ now: () => t, log });
  const advance = (ms) => { t += ms; };
  // `count` failures with a key held, evenly spread over `spanMs`.
  const fail = (g, count, spanMs, opts = { keyHeld: true }) => {
    const step = count > 1 ? spanMs / (count - 1) : 0;
    for (let i = 0; i < count; i++) {
      if (i > 0) advance(step);
      h.noteDecrypt(g, false, opts);
    }
  };
  return { h, log, advance, fail };
}

describe('mlsHealth', () => {
  it('is never stuck without a catch-up', () => {
    const { h, fail } = setup();
    fail('g1', 500, 120_000);
    expect(h.stuckGroups()).toEqual([]);
  });

  it('is never stuck after a catch-up that applied no commits', () => {
    const { h, fail } = setup();
    h.noteCatchUp('g1', { commitsApplied: 0 });
    fail('g1', 500, 120_000);
    expect(h.stuckGroups()).toEqual([]);
  });

  it('flags sustained key-held failures after a catch-up that applied commits', () => {
    const { h, log, fail } = setup();
    const cb = vi.fn();
    h.subscribe(cb);
    h.noteCatchUp('g1', { commitsApplied: 2 });
    fail('g1', FAIL_THRESHOLD, MIN_WINDOW_MS);
    expect(h.stuckGroups()).toEqual(['g1']);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(['g1']);
    // Logged once, not per failure.
    fail('g1', 100, 30_000);
    expect(log.mock.calls.filter(([level]) => level === 'warn')).toHaveLength(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not count failures from before the arming catch-up', () => {
    const { h, fail } = setup();
    fail('g1', FAIL_THRESHOLD, MIN_WINDOW_MS);
    h.noteCatchUp('g1', { commitsApplied: 1 });
    fail('g1', 1, 0);
    expect(h.stuckGroups()).toEqual([]);
  });

  it('ignores failures without a key held', () => {
    const { h, fail } = setup();
    h.noteCatchUp('g1', { commitsApplied: 3 });
    fail('g1', 200, 60_000, { keyHeld: false });
    expect(h.stuckGroups()).toEqual([]);
  });

  it('a successful decrypt clears the streak and the flag', () => {
    const { h, fail } = setup();
    const cb = vi.fn();
    h.subscribe(cb);
    h.noteCatchUp('g1', { commitsApplied: 1 });
    fail('g1', FAIL_THRESHOLD - 1, MIN_WINDOW_MS);
    h.noteDecrypt('g1', true);
    fail('g1', FAIL_THRESHOLD - 1, MIN_WINDOW_MS);
    expect(h.stuckGroups()).toEqual([]);
    fail('g1', 2, 1000);
    expect(h.stuckGroups()).toEqual(['g1']);
    h.noteDecrypt('g1', true);
    expect(h.stuckGroups()).toEqual([]);
    expect(cb).toHaveBeenLastCalledWith([]);
  });

  it('respects the minimum time window', () => {
    const { h, advance, fail } = setup();
    h.noteCatchUp('g1', { commitsApplied: 1 });
    // A burst: many failures within a second.
    fail('g1', FAIL_THRESHOLD * 5, 1000);
    expect(h.stuckGroups()).toEqual([]);
    // Still failing once the window has passed.
    advance(MIN_WINDOW_MS);
    h.noteDecrypt('g1', false, { keyHeld: true });
    expect(h.stuckGroups()).toEqual(['g1']);
  });

  it('needs the failure count as well as the window', () => {
    const { h, fail } = setup();
    h.noteCatchUp('g1', { commitsApplied: 1 });
    fail('g1', FAIL_THRESHOLD - 1, MIN_WINDOW_MS * 6);
    expect(h.stuckGroups()).toEqual([]);
  });

  it('tracks groups independently and reset forgets them', () => {
    const { h, fail } = setup();
    h.noteCatchUp('a', { commitsApplied: 1 });
    h.noteCatchUp('b', { commitsApplied: 1 });
    fail('a', FAIL_THRESHOLD, MIN_WINDOW_MS);
    fail('b', FAIL_THRESHOLD, MIN_WINDOW_MS);
    expect(h.stuckGroups()).toEqual(['a', 'b']);
    h.reset('a');
    expect(h.stuckGroups()).toEqual(['b']);
    // Reset also disarms: failures alone don't flag it again.
    fail('a', FAIL_THRESHOLD * 2, MIN_WINDOW_MS * 2);
    expect(h.stuckGroups()).toEqual(['b']);
    h.reset();
    expect(h.stuckGroups()).toEqual([]);
  });

  it('a throwing listener or logger cannot break tracking', () => {
    let t = 0;
    const h = createMlsHealth({ now: () => t, log: () => { throw new Error('log'); } });
    h.subscribe(() => { throw new Error('listener'); });
    h.noteCatchUp('g', { commitsApplied: 1 });
    for (let i = 0; i < FAIL_THRESHOLD; i++) { h.noteDecrypt('g', false, { keyHeld: true }); t += 1000; }
    expect(h.stuckGroups()).toEqual(['g']);
  });
});
