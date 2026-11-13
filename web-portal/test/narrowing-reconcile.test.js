import { describe, it, expect } from 'vitest';
import { createNarrowingReconciler, NARROWING_JITTER_MS } from '../src/engine/narrowingReconcile.js';
import { sampleEvent, validateEvent } from '../../shared/events/schema.js';

// B3: channel_audience_narrowed → one jittered reconcile of that channel's group.
function harness({ held = ['c1'], random = () => 0.5, fail = false } = {}) {
  const timers = [];
  const calls = [];
  const onNarrowed = createNarrowingReconciler({
    isHeld: (id) => held.includes(id),
    reconcile: async (orgId, channelId, userId) => {
      calls.push([orgId, channelId, userId]);
      if (fail) throw new Error('409 loop');
    },
    random,
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  const flush = async () => { while (timers.length) await timers.shift().fn(); };
  return { onNarrowed, timers, calls, flush };
}

describe('narrowing reconcile', () => {
  it('the schema sample is what the handler reads', () => {
    const ev = sampleEvent('channel_audience_narrowed', { orgId: 'o1', channelId: 'c1' });
    expect(validateEvent(ev)).toEqual([]);
    const h = harness();
    expect(h.onNarrowed(ev, 'me')).toBe(true);
  });

  it('reconciles a held channel once, after a jittered delay', async () => {
    const h = harness({ random: () => 0.25 });
    expect(h.onNarrowed({ orgId: 'o1', channelId: 'c1' }, 'me')).toBe(true);
    expect(h.timers[0].ms).toBe(Math.floor(0.25 * NARROWING_JITTER_MS));
    expect(h.calls).toEqual([]);
    await h.flush();
    expect(h.calls).toEqual([['o1', 'c1', 'me']]);
  });

  it('a burst for one channel coalesces into one pending run; after it runs, a new event schedules again', async () => {
    const h = harness();
    h.onNarrowed({ orgId: 'o1', channelId: 'c1' }, 'me');
    expect(h.onNarrowed({ orgId: 'o1', channelId: 'c1' }, 'me')).toBe(false);
    await h.flush();
    expect(h.calls).toHaveLength(1);
    expect(h.onNarrowed({ orgId: 'o1', channelId: 'c1' }, 'me')).toBe(true);
  });

  it('skips groups this device does not hold, and malformed events', () => {
    const h = harness({ held: [] });
    expect(h.onNarrowed({ orgId: 'o1', channelId: 'c1' }, 'me')).toBe(false);
    expect(h.onNarrowed({ channelId: 'c1' }, 'me')).toBe(false);
    expect(h.onNarrowed({ orgId: 'o1', channelId: 'c1' }, null)).toBe(false);
    expect(h.timers).toEqual([]);
  });

  it('a failed reconcile is swallowed and does not wedge the channel', async () => {
    const h = harness({ fail: true });
    h.onNarrowed({ orgId: 'o1', channelId: 'c1' }, 'me');
    await h.flush();
    expect(h.onNarrowed({ orgId: 'o1', channelId: 'c1' }, 'me')).toBe(true);
  });
});
