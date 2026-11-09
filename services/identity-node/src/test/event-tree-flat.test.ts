/**
 * Frequency overlay phase 2 (DB-free): no command channel, no cross-channel
 * priority cascade.
 *
 *  - publishEventTree hands media-rust a FLAT tree (parent_id null for every
 *    channel), so the relay's descendant cascade reaches nothing; a priority
 *    speaker ducks only their own room (in-group role ducking).
 *  - buildEventChannelTree (GET .../tree) drops parents that aren't listed —
 *    (e.g. a frequency) — so the child becomes top-level, keeps
 *    the group hierarchy otherwise, and never marks a row is_command.
 */
import { describe, it, expect, vi } from 'vitest';

const published: Array<{ subject: string; payload: any }> = [];
vi.mock('../config/nats.js', () => ({
  publishEvent: vi.fn(async (subject: string, payload: any) => { published.push({ subject, payload }); }),
}));

const { publishEventTree, buildEventChannelTree } = await import('../controllers/eventsController.js');

describe('publishEventTree (relay tree)', () => {
  it('publishes every channel with parent_id null, keeping leaders and the frequency flag', async () => {
    const rows = [
      { id: 'root', parent_channel_id: null, is_frequency: false, leader_user_id: null },
      { id: 'alpha', parent_channel_id: 'root', is_frequency: false, leader_user_id: 'u1' },
      { id: 'alpha-1', parent_channel_id: 'alpha', is_frequency: false, leader_user_id: null },
      { id: 'freq', parent_channel_id: null, is_frequency: true, leader_user_id: null },
    ];
    const db = { query: vi.fn(async () => ({ rows })) };
    published.length = 0;
    await publishEventTree('org1', 'ev1', db);
    expect(published).toHaveLength(1);
    expect(published[0].subject).toBe('specter.event.tree.org1');
    const chans = published[0].payload.channels;
    expect(chans.map((c: any) => c.parent_id)).toEqual([null, null, null, null]);
    expect(chans.find((c: any) => c.id === 'alpha').leader_user_id).toBe('u1');
    expect(chans.find((c: any) => c.id === 'freq').is_frequency).toBe(true);
  });
});

describe('buildEventChannelTree (op tree endpoint)', () => {
  it('groups-only op: top-level groups tier 0, sub-groups under their parent', () => {
    const t = buildEventChannelTree([
      { id: 'a', parent_channel_id: null },
      { id: 'a1', parent_channel_id: 'a' },
      { id: 'b', parent_channel_id: null },
    ]);
    expect(t.map((r) => [r.id, r.tier, r.parent_channel_id, r.is_command])).toEqual([
      ['a', 0, null, false], ['a1', 1, 'a', false], ['b', 0, null, false],
    ]);
  });

  it('a parent that is not listed (e.g. a frequency) is dropped', () => {
    const t = buildEventChannelTree([
      { id: 'a', parent_channel_id: 'not-listed' },
      { id: 'a1', parent_channel_id: 'a' },
    ]);
    expect(t.find((r) => r.id === 'a')).toMatchObject({ tier: 0, parent_channel_id: null });
    expect(t.find((r) => r.id === 'a1')).toMatchObject({ tier: 1, parent_channel_id: 'a' });
  });

  it('is cycle-safe', () => {
    const t = buildEventChannelTree([
      { id: 'x', parent_channel_id: 'y' },
      { id: 'y', parent_channel_id: 'x' },
    ]);
    expect(t.every((r) => Number.isFinite(r.tier))).toBe(true);
  });
});
