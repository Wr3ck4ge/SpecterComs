// Frequency overlay phase 2: no command channel, no cross-channel cascade.
//  - netFrequencies: the nets WarRoom cycles; a legacy frequency that IS my
//    group channel (defensive) is no slot at all.
//  - isListedChannel: frequencies (and any command-kind row) never show as
//    channel-list rows.
//  - EVENT_CASCADE_LANE is off: clients neither derive 'audio-cascade' nor
//    send cascade copies (the relay gets a flat tree).
import { describe, it, expect } from 'vitest';
import { netFrequencies, resolveActiveNet } from '../src/engine/activeNet.js';
import { isListedChannel, buildChannelSections } from '../src/components/strip/channelTree.js';
import { EVENT_CASCADE_LANE } from '../src/voiceRelayAudio.js';

const group = { id: 'g', name: 'ALPHA' };

describe('netFrequencies', () => {
  it('keeps the planner nets in order, deduped, without a channel-less entry', () => {
    const list = [
      { name: 'CMD', channel_id: 'C', is_leadership: true },
      { name: 'LOGI', channel_id: 'X' },
      { name: 'DUP', channel_id: 'X' },
      { name: 'NOCHAN' },
    ];
    expect(netFrequencies(list, 'g').map((f) => f.name)).toEqual(['CMD', 'LOGI']);
  });
  it('defensive: a frequency that IS my group channel is dropped, so indexes stay on real nets', () => {
    const list = [{ name: 'COMMAND', channel_id: 'g', is_command: true }, { name: 'LOGI', channel_id: 'X' }];
    const nets = netFrequencies(list, 'g');
    expect(nets.map((f) => f.channel_id)).toEqual(['X']);
    expect(resolveActiveNet({ voiceChannel: group, freqs: nets, activeFreqIdx: 1 })).toEqual({ txNetId: 'X', name: 'LOGI', kind: 'frequency' });
  });
  it('no frequencies (groups-only op): only the group slot', () => {
    expect(netFrequencies([], 'g')).toEqual([]);
    expect(netFrequencies(undefined, 'g')).toEqual([]);
    expect(resolveActiveNet({ voiceChannel: group, freqs: [], activeFreqIdx: 3 }).kind).toBe('group');
  });
});

describe('isListedChannel', () => {
  it('hides frequency channels and any command-kind row, keeps groups and org channels', () => {
    expect(isListedChannel({ id: 'a', event_kind: 'group' })).toBe(true);
    expect(isListedChannel({ id: 'o' })).toBe(true);
    expect(isListedChannel({ id: 'c', event_kind: 'command' })).toBe(false);
    expect(isListedChannel({ id: 'c', eventKind: 'command' })).toBe(false);
    expect(isListedChannel({ id: 'f', is_frequency: true })).toBe(false);
    expect(isListedChannel(null)).toBe(false);
  });
  it('an op without a command channel still builds one section of its group channels', () => {
    const channels = [
      { id: 'a', kind: 'voice', eventId: 'e', eventKind: 'group', eventName: 'Op', parentId: null },
      { id: 'a1', kind: 'voice', eventId: 'e', eventKind: 'group', eventName: 'Op', parentId: 'a' },
    ];
    const { ops } = buildChannelSections(channels);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ name: 'Op', command: null });
    expect(ops[0].nodes.map((n) => [n.channel.id, n.depth])).toEqual([['a', 0], ['a1', 1]]);
  });
});

describe('cascade lane', () => {
  it('is retired', () => {
    expect(EVENT_CASCADE_LANE).toBe(false);
  });
});
