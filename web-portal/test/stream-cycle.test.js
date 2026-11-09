// Next-stream keybind stepping + op-wide share listing (engine/streamCycle.js).
import { describe, it, expect } from 'vitest';
import {
  nextWatchTarget, mergeWatchableSharers, reconcileWatchTarget,
  shareAnnounceDatagram, parseShareAnnounce, applySharerChange,
} from '../src/engine/streamCycle';

describe('nextWatchTarget', () => {
  const five = ['s1', 's2', 's3', 's4', 's5'];
  it('steps off → s1 → … → s5 → off → s1, one per press', () => {
    const seen = [];
    let cur = null;
    for (let i = 0; i < 7; i += 1) { cur = nextWatchTarget(five, cur); seen.push(cur); }
    expect(seen).toEqual(['s1', 's2', 's3', 's4', 's5', null, 's1']);
  });
  it('a current sharer that vanished restarts at s1', () => {
    expect(nextWatchTarget(five, 'gone')).toBe('s1');
  });
  it('no streams → off', () => {
    expect(nextWatchTarget([], 's1')).toBe(null);
    expect(nextWatchTarget(undefined, null)).toBe(null);
  });
});

describe('mergeWatchableSharers', () => {
  it('group first, then frequencies in order; deduped; never myself', () => {
    const { list, via } = mergeWatchableSharers({
      groupSharers: ['a', 'me', 'b'],
      freqSharers: [
        { channelId: 'f1', sharers: ['c', 'a'] },
        { channelId: 'f2', sharers: ['d', 'c', 'me'] },
      ],
      self: 'me',
    });
    expect(list).toEqual(['a', 'b', 'c', 'd']);
    expect(via).toEqual({ c: 'f1', d: 'f2' }); // group sharers need no frequency
  });
  it('outside an op (no frequencies) it is just the group list', () => {
    expect(mergeWatchableSharers({ groupSharers: ['a'], self: 'me' })).toEqual({ list: ['a'], via: {} });
  });
});

describe('reconcileWatchTarget', () => {
  it('a sharer who stopped → off; listed or self-view kept', () => {
    expect(reconcileWatchTarget(['a'], 'b', 'me')).toBe(null);
    expect(reconcileWatchTarget(['a'], 'a', 'me')).toBe('a');
    expect(reconcileWatchTarget([], 'me', 'me')).toBe('me');
    expect(reconcileWatchTarget(['a'], null, 'me')).toBe(null);
  });
});

describe('share announces on a frequency net', () => {
  const relayed = (on, cs) => new Uint8Array([0xFF, 0x01, on ? 1 : 0, ...new TextEncoder().encode(cs)]);
  it('what I send satisfies the relay (≥ 4 bytes, 0xFF 0x01 flag)', () => {
    expect([...shareAnnounceDatagram(true)]).toEqual([0xFF, 0x01, 1, 0]);
    expect([...shareAnnounceDatagram(false)]).toEqual([0xFF, 0x01, 0, 0]);
  });
  it('parses the relayed form (callsign from the server) and ignores others', () => {
    expect(parseShareAnnounce(relayed(true, 'Alpha1'))).toEqual({ available: true, callsign: 'Alpha1' });
    expect(parseShareAnnounce(new Uint8Array([0xFF, 0x07, 1, 65]))).toBe(null);
    expect(parseShareAnnounce(new Uint8Array([0x08, 0x01]))).toBe(null);
  });
  it('start adds, stop / leave drops, no-ops keep the same array', () => {
    const l1 = applySharerChange([], { callsign: 'a', available: true });
    expect(l1).toEqual(['a']);
    expect(applySharerChange(l1, { callsign: 'a', available: true })).toBe(l1);
    expect(applySharerChange(l1, { callsign: 'a', available: false })).toEqual([]);
    expect(applySharerChange(l1, { callsign: 'z', available: false })).toBe(l1);
  });
});
