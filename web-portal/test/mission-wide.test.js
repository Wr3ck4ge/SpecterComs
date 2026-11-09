// Frequency overlay phase 3, MISSION WIDE (engine/activeNet.js): the op
// commanders' one-way broadcast. Commanders get it as the last entry of the
// toggle cycle; every participant hears it, and while it plays their other
// nets duck to MISSION_WIDE_DUCK_GAIN. Its frames are ordinary relay frames
// sealed under the event group's key — no key, no audio (never plaintext).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  INACTIVE_NET_GAIN, MISSION_WIDE_DUCK_GAIN, MISSION_WIDE_NAME, netCycle, missionWideLive, duckedNetGain,
  resolveActiveNet, setActiveTxNet, registerNetSender, routeMicFrame, ROUTE_NET, ROUTE_DROPPED,
  _resetActiveNetForTests,
} from '../src/engine/activeNet.js';
import {
  routeAudioDatagram, encodeAudioFrameProto, DROP_NO_KEY, MISSION_WIDE_KEY_LABEL, EVENT_CASCADE_LANE,
} from '../src/voiceRelayAudio.js';

const EVENT = 'ev-1';
const group = { id: 'g', name: 'ALPHA', event_id: EVENT };
const freqs = [{ name: 'LOGI', channel_id: 'X' }];
const commander = { room_id: EVENT, event_id: EVENT, can_transmit: true };
const listener = { room_id: EVENT, event_id: EVENT, can_transmit: false };

describe('toggle cycle', () => {
  it('commanders get Mission Wide last; frequency indexes do not shift', () => {
    const list = netCycle(freqs, 'g', commander, true);
    expect(list.map((f) => f.channel_id)).toEqual(['X', EVENT]);
    expect(list[1]).toMatchObject({ mission_wide: true, name: MISSION_WIDE_NAME });
    expect(resolveActiveNet({ voiceChannel: group, freqs: list, activeFreqIdx: 1 }).kind).toBe('frequency');
    expect(resolveActiveNet({ voiceChannel: group, freqs: list, activeFreqIdx: 2 }))
      .toEqual({ txNetId: EVENT, name: MISSION_WIDE_NAME, kind: 'mission' });
  });

  it('participants (no TX) never get it in the cycle', () => {
    expect(netCycle(freqs, 'g', listener, true).some((f) => f.mission_wide)).toBe(false);
  });

  it('no Mission Wide (op without a commander, old server) or not live → plain frequencies', () => {
    expect(netCycle(freqs, 'g', null, true)).toEqual(freqs);
    expect(netCycle(freqs, 'g', commander, false)).toEqual(freqs);
    expect(netCycle([], 'g', null, true)).toEqual([]);
  });

  it('live only while in voice on a channel of that op', () => {
    expect(missionWideLive(commander, { inComms: true, voiceChannel: group })).toBe(true);
    expect(missionWideLive(commander, { inComms: false, voiceChannel: group })).toBe(false);
    expect(missionWideLive(commander, { inComms: true, voiceChannel: { id: 'o', event_id: 'other' } })).toBe(false);
    expect(missionWideLive(commander, { inComms: true, voiceChannel: { id: 'lobby' } })).toBe(false);
    expect(missionWideLive(null, { inComms: true, voiceChannel: group })).toBe(false);
  });
});

describe('listeners duck their other nets while Mission Wide plays', () => {
  it('one constant, stronger than the inactive-net gain', () => {
    expect(MISSION_WIDE_DUCK_GAIN).toBeLessThan(INACTIVE_NET_GAIN);
  });
  it('no duck while silent', () => {
    expect(duckedNetGain(true, 0.8, false)).toBe(0.8);
    expect(duckedNetGain(false, 1, false)).toBeCloseTo(INACTIVE_NET_GAIN);
  });
  it('every other net (active one included) is capped at base × duck while it plays', () => {
    expect(duckedNetGain(true, 1, true)).toBeCloseTo(MISSION_WIDE_DUCK_GAIN);
    expect(duckedNetGain(false, 1, true)).toBeCloseTo(MISSION_WIDE_DUCK_GAIN);
    expect(duckedNetGain(true, 2, true)).toBeCloseTo(2 * MISSION_WIDE_DUCK_GAIN);
    expect(duckedNetGain(false, NaN, true)).toBeCloseTo(MISSION_WIDE_DUCK_GAIN);
  });
});

describe('mic routing on Mission Wide', () => {
  beforeEach(() => _resetActiveNetForTests());
  const frame = { opusBytes: new Uint8Array([1, 2, 3]), ssrc: 7, seq: 1 };

  it('a commander with Mission Wide active sends only to its room', () => {
    const sent = [];
    registerNetSender(EVENT, (f) => sent.push(f));
    setActiveTxNet(EVENT);
    expect(routeMicFrame(frame)).toBe(ROUTE_NET);
    expect(sent).toHaveLength(1);
  });

  it('no sender registered (listen-only ticket / not connected) → dropped, never sent to the group', () => {
    setActiveTxNet(EVENT);
    expect(routeMicFrame(frame)).toBe(ROUTE_DROPPED);
  });
});

describe('no plaintext fallback', () => {
  it('a Mission Wide frame without the event key is dropped, not played', () => {
    const dgram = encodeAudioFrameProto(1234, 1, new Uint8Array([0x03, 9, 9, 9, 9, 9, 9, 9]), false, null);
    const r = routeAudioDatagram(dgram, { relayMode: true, channelKey: null, cascadeKey: null });
    expect(r.action).toBe('drop');
    expect(r.reason).toBe(DROP_NO_KEY);
  });

  it('its key is its own export label, and the old cascade lane stays off', () => {
    expect(MISSION_WIDE_KEY_LABEL).toBe('audio-mission-wide');
    expect(MISSION_WIDE_KEY_LABEL).not.toBe('audio-cascade');
    expect(EVENT_CASCADE_LANE).toBe(false);
  });
});
