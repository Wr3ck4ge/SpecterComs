// Frequency overlay phase 1 (engine/activeNet.js): the group connection never
// moves; the ACTIVE net (group or one frequency) gets the mic and normal
// volume, every other connected net plays at INACTIVE_NET_GAIN.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  INACTIVE_NET_GAIN, netGain, resolveActiveNet, setActiveTxNet, getActiveTxNet,
  registerNetSender, routeMicFrame, ROUTE_GROUP, ROUTE_NET, ROUTE_DROPPED, _resetActiveNetForTests,
} from '../src/engine/activeNet.js';
import { buildEngineState } from '../src/engine/bridge.js';

const group = { id: 'g', name: 'ALPHA' };
const freqs = [{ name: 'LEADERSHIP', channel_id: 'L' }, { name: 'LOGI', channel_id: 'X' }];
const frame = { opusBytes: new Uint8Array([1, 2, 3]), ssrc: 7, seq: 1 };

describe('netGain', () => {
  it('active net at base volume, others at the inactive constant', () => {
    expect(INACTIVE_NET_GAIN).toBe(0.3);
    expect(netGain(true, 0.8)).toBe(0.8);
    expect(netGain(false, 1)).toBeCloseTo(0.3);
    expect(netGain(false, 2)).toBeCloseTo(0.6);
    expect(netGain(true)).toBe(1);
    expect(netGain(false, NaN)).toBeCloseTo(0.3);
  });
});

describe('resolveActiveNet', () => {
  it('index 0 is the group', () => {
    expect(resolveActiveNet({ voiceChannel: group, freqs, activeFreqIdx: 0 })).toEqual({ txNetId: null, name: 'ALPHA', kind: 'group' });
  });
  it('index i is freqs[i-1]', () => {
    expect(resolveActiveNet({ voiceChannel: group, freqs, activeFreqIdx: 2 })).toEqual({ txNetId: 'X', name: 'LOGI', kind: 'frequency' });
  });
  it('clamps out-of-range indexes', () => {
    expect(resolveActiveNet({ voiceChannel: group, freqs, activeFreqIdx: 9 }).txNetId).toBe('X');
    expect(resolveActiveNet({ voiceChannel: group, freqs, activeFreqIdx: -3 }).txNetId).toBe(null);
  });
  it('a frequency that IS the group channel, or has no channel, resolves to the group', () => {
    expect(resolveActiveNet({ voiceChannel: group, freqs: [{ name: 'CMD', channel_id: 'g' }], activeFreqIdx: 1 }).kind).toBe('group');
    expect(resolveActiveNet({ voiceChannel: group, freqs: [{ name: 'X' }], activeFreqIdx: 1 }).txNetId).toBe(null);
  });
});

describe('routeMicFrame', () => {
  beforeEach(() => _resetActiveNetForTests());

  it('group active: CommLink sends on the group connection, no net sender is called', () => {
    const send = vi.fn();
    registerNetSender('L', send);
    expect(routeMicFrame(frame)).toBe(ROUTE_GROUP);
    expect(send).not.toHaveBeenCalled();
  });

  it('frequency active: only that net gets the frame, the group does not', () => {
    const sendL = vi.fn();
    const sendX = vi.fn();
    registerNetSender('L', sendL);
    registerNetSender('X', sendX);
    setActiveTxNet('X');
    expect(getActiveTxNet()).toBe('X');
    expect(routeMicFrame(frame)).toBe(ROUTE_NET);
    expect(sendX).toHaveBeenCalledWith(frame);
    expect(sendL).not.toHaveBeenCalled();
  });

  it('frequency active but not connected: dropped, never falls back to the group', () => {
    setActiveTxNet('L');
    expect(routeMicFrame(frame)).toBe(ROUTE_DROPPED);
  });

  it('a throwing sender still keeps the frame off the group', () => {
    registerNetSender('L', () => { throw new Error('boom'); });
    setActiveTxNet('L');
    expect(routeMicFrame(frame)).toBe(ROUTE_NET);
  });

  it('unregister removes only its own sender; back to group routes to group', () => {
    const old = vi.fn();
    const unregOld = registerNetSender('L', old);
    const fresh = vi.fn();
    registerNetSender('L', fresh); // reconnect replaced it
    unregOld();                    // stale cleanup must not remove the new one
    setActiveTxNet('L');
    routeMicFrame(frame);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(old).not.toHaveBeenCalled();
    setActiveTxNet(null);
    expect(routeMicFrame(frame)).toBe(ROUTE_GROUP);
  });
});

describe('engine state', () => {
  it('names the active net and keeps the group listening while a frequency is active', () => {
    const st = buildEngineState({ inComms: true, voiceChannel: group, voiceStatus: 'connected', freqs, activeFreqIdx: 1, monitorStatus: { L: { connected: true } } });
    expect(st.voice.activeNet).toEqual({ name: 'LEADERSHIP', kind: 'frequency' });
    expect(st.voice.channelId).toBe('g'); // never moved
    const g = st.voice.freqs.find((f) => f.kind === 'group');
    expect(g.listening).toBe(true);
    expect(g.active).toBe(false);
    expect(st.voice.freqs.find((f) => f.index === 2).listening).toBe(false);
    expect(buildEngineState({ inComms: false }).voice.activeNet).toBe(null);
  });
});
