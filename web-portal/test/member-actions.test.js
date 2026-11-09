// PM: the strip's per-member menu — per-user volume → per-lane gain mapping
// and persistence, friend state, the bridge command shapes and state, and the
// overlay DM toast rules. See src/engine/{userVolume,people,overlayDm}.js.
import { describe, it, expect, vi } from 'vitest';
import {
  USER_VOLUMES_KEY, SET_STREAM_VOLUME_CMD, MAX_FAILURES,
  clampUserVolume, normalizeUserVolumes, gainForUser, withUserVolume,
  loadUserVolumes, saveUserVolumes, createLaneGainSync, laneGainForVolume, masterGainForPercent, percentForMasterGain,
} from '../src/engine/userVolume.js';
import { FRIEND, buildPeople, friendAction, friendStatesById, fmtVolumePct } from '../src/engine/people.js';
import {
  CMD, EV, EMPTY_STATE, buildEngineState, memberCommand, selectMyChannelUsers,
} from '../src/engine/bridge.js';
import { cmdKey } from '../src/components/strip/useEngine.js';
import {
  MAX_TOASTS, TOAST_TTL_MS, SENT_LINGER_MS, TOAST_H, TOAST_GAP, TOAST_AREA_PAD, REPLY_H,
  pushToast, expireToasts, nextExpiryIn, restartToastTimers, toastAreaHeight, toastFromDm,
  loadOverlayDmsEnabled, saveOverlayDmsEnabled,
} from '../src/engine/overlayDm.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('per-user volume values + persistence', () => {
  it('clamps to 0..2 in whole percent; junk is unity', () => {
    expect(clampUserVolume(1.234)).toBe(1.23);
    expect(clampUserVolume(5)).toBe(2);
    expect(clampUserVolume(-1)).toBe(0);
    expect(clampUserVolume('x')).toBe(1);
    expect(clampUserVolume(NaN)).toBe(1);
  });

  it('keeps only non-unity entries and round-trips through storage', () => {
    const st = memStorage();
    saveUserVolumes({ a: 1.5, b: 1, c: 9, '': 0.5 }, st);
    expect(JSON.parse(st.getItem(USER_VOLUMES_KEY))).toEqual({ a: 1.5, c: 2 });
    expect(loadUserVolumes(st)).toEqual({ a: 1.5, c: 2 });
    expect(normalizeUserVolumes(null)).toEqual({});
  });

  it('survives corrupt storage', () => {
    const st = memStorage();
    st.setItem(USER_VOLUMES_KEY, '{nope');
    expect(loadUserVolumes(st)).toEqual({});
    expect(loadUserVolumes({ getItem: () => { throw new Error('denied'); } })).toEqual({});
  });

  it('withUserVolume sets and resets (100 % removes the entry)', () => {
    const v1 = withUserVolume({}, 'u1', 0.5);
    expect(v1).toEqual({ u1: 0.5 });
    expect(withUserVolume(v1, 'u1', 1)).toEqual({});
    expect(gainForUser(v1, 'u1')).toBe(0.5);
    expect(gainForUser(v1, 'u2')).toBe(1);
    expect(gainForUser(v1, undefined)).toBe(1);
  });

  it('boosts above 100 % in dB (200 % = +18 dB), attenuates linearly below', () => {
    expect(laneGainForVolume(0)).toBe(0);
    expect(laneGainForVolume(0.5)).toBe(0.5);
    expect(laneGainForVolume(1)).toBe(1);
    expect(laneGainForVolume(1.5)).toBe(2.818);
    expect(laneGainForVolume(2)).toBe(7.943);
    expect(laneGainForVolume(9)).toBe(7.943); // clamped to the slider's max
    expect(laneGainForVolume(1.5)).toBeLessThanOrEqual(8); // MAX_STREAM_GAIN in specter-audio
  });

  it("Everyone's volume: percent ↔ stored linear gain (200 % = +12 dB, within play_frame's ×4)", () => {
    expect(masterGainForPercent(100)).toBe(1);
    expect(masterGainForPercent(50)).toBe(0.5);
    expect(masterGainForPercent(200)).toBe(3.981);
    expect(masterGainForPercent(500)).toBe(3.981);
    expect(masterGainForPercent('x')).toBe(1);
    for (const p of [0, 25, 100, 150, 200]) expect(percentForMasterGain(masterGainForPercent(p))).toBe(p);
    expect(percentForMasterGain(3.0)).toBe(180); // an old "Input gain" 3.0× setting
    expect(percentForMasterGain(undefined)).toBe(100);
  });
});

describe('user → stream gain sync (createLaneGainSync)', () => {
  const setup = (volumes = {}) => {
    const invoke = vi.fn(() => Promise.resolve());
    return { invoke, sync: createLaneGainSync({ invoke, volumes }) };
  };

  it('sends set_stream_volume once per lane, not per frame', async () => {
    const { invoke, sync } = setup({ alice: 0.5 });
    sync.sync('ch:1', 'alice');
    sync.sync('ch:1', 'alice');
    sync.sync('ch:1', 'alice');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(SET_STREAM_VOLUME_CMD, { streamId: 'ch:1', volume: 0.5 });
  });

  it('re-applies on a new stream id for the same user (rejoin / reconnect / move)', async () => {
    const { invoke, sync } = setup({ alice: 1.5 });
    sync.sync('ch:1', 'alice');
    sync.sync('ch2:77', 'alice'); // moved / new ssrc
    await flush();
    expect(invoke.mock.calls.map((c) => c[1])).toEqual([
      { streamId: 'ch:1', volume: 2.818 }, // 150 % = +9 dB
      { streamId: 'ch2:77', volume: 2.818 },
    ]);
  });

  it('follows an ssrc that now belongs to someone else, and a mapping that arrives late', async () => {
    const { invoke, sync } = setup({ alice: 0.2 });
    sync.sync('ch:5', undefined); // SsrcMap not here yet → unity
    sync.sync('ch:5', 'alice'); // now known
    sync.sync('ch:5', 'bob'); // reassigned to bob (unity)
    await flush();
    expect(invoke.mock.calls.map((c) => c[1].volume)).toEqual([1, 0.2, 1]);
  });

  it('a slider change re-syncs every known lane of that user only', async () => {
    const { invoke, sync } = setup({});
    sync.sync('ch:1', 'alice');
    sync.sync('ch:2', 'bob');
    await flush();
    invoke.mockClear();
    sync.setVolumes({ alice: 1.75 });
    await flush();
    expect(invoke.mock.calls.map((c) => c[1])).toEqual([{ streamId: 'ch:1', volume: 4.732 }]); // 175 % = +13.5 dB
    expect(sync.appliedGain('ch:2')).toBe(1);
  });

  it('reset (channel left) makes the next session re-send', async () => {
    const { invoke, sync } = setup({ alice: 0.5 });
    sync.sync('ch:1', 'alice');
    sync.reset();
    sync.sync('ch:1', 'alice');
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('a failed invoke is retried on the next frame, then given up on', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('not allowed')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sync = createLaneGainSync({ invoke, volumes: { alice: 0.5 } });
    for (let i = 0; i < MAX_FAILURES + 5; i += 1) {
      sync.sync('ch:1', 'alice');
      await flush(); await flush();
    }
    expect(invoke).toHaveBeenCalledTimes(MAX_FAILURES);
    warn.mockRestore();
  });
});

describe('friend state (GET /friends rows)', () => {
  const rows = [
    { id: 'f1', callsign: 'Friend', status: 1, initiated_by: 'me' },
    { id: 'o1', callsign: 'Out', status: 0, initiated_by: 'me' },
    { id: 'i1', callsign: 'In', status: 0, initiated_by: 'i1' },
    { user_id: 'legacy', callsign: 'Old', status: 1 },
  ];
  it('maps rows to friends / outgoing / incoming', () => {
    expect(friendStatesById(rows, 'me')).toEqual({ f1: FRIEND.FRIENDS, o1: FRIEND.OUTGOING, i1: FRIEND.INCOMING, legacy: FRIEND.FRIENDS });
  });
  it('labels the menu row', () => {
    expect(friendAction(FRIEND.NONE)).toEqual({ label: 'Add friend', action: 'request' });
    expect(friendAction(FRIEND.INCOMING).action).toBe('accept');
    expect(friendAction(FRIEND.OUTGOING)).toEqual({ label: 'Friend request sent', action: null });
    expect(friendAction(FRIEND.FRIENDS).action).toBeNull();
  });
});

describe('state.people', () => {
  const members = [
    { user_id: 'uMe', callsign: 'Me' }, { user_id: 'uA', callsign: 'Alpha' }, { user_id: 'uB', username: 'Bravo' },
  ];
  it('one entry per other roster member, never me; unknown callsigns have no userId', () => {
    const p = buildPeople({
      roster: ['Me', 'Alpha', 'Bravo', 'Ghost'], myCallsign: 'Me', members,
      friendStates: { uA: FRIEND.FRIENDS }, localMuted: new Set(['uB']), volumes: { uA: 1.5 },
    });
    expect(Object.keys(p)).toEqual(['Alpha', 'Bravo', 'Ghost']);
    expect(p.Alpha).toEqual({ userId: 'uA', friend: FRIEND.FRIENDS, localMuted: false, volume: 1.5 });
    expect(p.Bravo).toEqual({ userId: 'uB', friend: FRIEND.NONE, localMuted: true, volume: 1 });
    expect(p.Ghost.userId).toBeNull();
    expect(fmtVolumePct(1.5)).toBe('150%');
  });
});

describe('bridge: member commands and state', () => {
  it('command shapes', () => {
    expect(memberCommand.setLocalMute('u1', 1)).toEqual(['member.setLocalMute', { userId: 'u1', muted: true }]);
    expect(memberCommand.setVolume('u1', 1.5)).toEqual(['member.setVolume', { userId: 'u1', volume: 1.5 }]);
    expect(memberCommand.friendRequest('u1')).toEqual(['friend.request', { userId: 'u1' }]);
    expect(memberCommand.friendAccept('u1')).toEqual(['friend.accept', { userId: 'u1' }]);
    expect(memberCommand.dmSelect('u1')).toEqual(['dm.select', { userId: 'u1' }]);
    expect(memberCommand.dmSelect(undefined)).toEqual(['dm.select', { userId: null }]);
    expect(memberCommand.dmSend('u1', 'hi')).toEqual(['dm.send', { userId: 'u1', text: 'hi' }]);
    expect(memberCommand.setOverlayDms(0)).toEqual(['prefs.setOverlayDms', { enabled: false }]);
    expect(CMD.FRIENDS_REFRESH).toBe('friends.refresh');
    expect(EV.DM).toBe('engine-dm');
  });

  it('pending keys are per user', () => {
    expect(cmdKey(CMD.MEMBER_SET_VOLUME, { userId: 'u1', volume: 2 })).toBe('member.setVolume:u1');
    expect(cmdKey(CMD.MEMBER_SET_VOLUME, { userId: 'u1' })).not.toBe(cmdKey(CMD.MEMBER_SET_VOLUME, { userId: 'u2' }));
  });

  const base = {
    user: { id: 'uMe', callsign: 'Me' }, inComms: true, voiceChannel: { id: 'c1', name: 'Ops' }, voiceStatus: 'connected',
    voiceRoster: ['Me', 'Alpha'],
  };
  it('people/prefs ride on EngineState; people only while in voice', () => {
    const people = { Alpha: { userId: 'uA', friend: 'none', localMuted: true, volume: 0.5 } };
    const s = buildEngineState({ ...base, people, prefs: { overlayDms: false } });
    expect(s.people).toEqual(people);
    expect(s.prefs).toEqual({ overlayDms: false });
    expect(buildEngineState({ ...base, inComms: false, people }).people).toEqual({});
    expect(buildEngineState(base).prefs).toEqual({ overlayDms: true });
    expect(EMPTY_STATE.prefs.overlayDms).toBe(true);
  });

  it('selectMyChannelUsers attaches the person to others, never to me', () => {
    const people = { Alpha: { userId: 'uA', friend: 'friends', localMuted: false, volume: 1.25 } };
    const s = buildEngineState({ ...base, people });
    const users = selectMyChannelUsers(s, { levels: {}, speaking: [] });
    expect(users[0]).toMatchObject({ callsign: 'Me', isMe: true, person: null });
    expect(users[1]).toMatchObject({ callsign: 'Alpha', person: people.Alpha });
  });
});

describe('overlay DM toasts', () => {
  const t = (id, extra = {}) => ({ id, userId: `u-${id}`, callsign: id, text: `hi ${id}`, timestamp: null, ...extra });

  it('newest first, at most three, repeats replace', () => {
    let s = [];
    for (const id of ['a', 'b', 'c', 'd']) s = pushToast(s, t(id), 1000);
    expect(s.map((x) => x.id)).toEqual(['d', 'c', 'b']);
    s = pushToast(s, t('b'), 2000);
    expect(s.map((x) => x.id)).toEqual(['b', 'd', 'c']);
    expect(s).toHaveLength(MAX_TOASTS);
  });

  it('fades after the TTL in passthrough; never while interactive', () => {
    const s = pushToast([], t('a'), 0);
    expect(expireToasts(s, { now: TOAST_TTL_MS - 1 })).toBe(s);
    expect(expireToasts(s, { now: TOAST_TTL_MS })).toEqual([]);
    expect(expireToasts(s, { now: TOAST_TTL_MS * 10, interactive: true })).toBe(s);
    expect(nextExpiryIn(s, { now: 1000 })).toBe(TOAST_TTL_MS - 1000);
    expect(nextExpiryIn(s, { now: 1000, interactive: true })).toBeNull();
  });

  it('an open or sending reply stays; a sent one lingers briefly, even interactive', () => {
    const open = pushToast([], t('a'), 0);
    expect(expireToasts(open, { now: 1e9, keepId: 'a' })).toBe(open);
    const sending = [{ ...open[0], reply: 'sending' }];
    expect(expireToasts(sending, { now: 1e9 })).toBe(sending);
    const sent = [{ ...open[0], reply: 'sent', sentAt: 100 }];
    expect(expireToasts(sent, { now: 100 + SENT_LINGER_MS - 1, interactive: true })).toBe(sent);
    expect(expireToasts(sent, { now: 100 + SENT_LINGER_MS, interactive: true })).toEqual([]);
  });

  it('going back to passthrough restarts the timers of waiting toasts', () => {
    const s = [{ ...t('a'), addedAt: 0 }, { ...t('b'), addedAt: 0, reply: 'sent', sentAt: 5 }];
    const r = restartToastTimers(s, 500);
    expect(r[0].addedAt).toBe(500);
    expect(r[1]).toBe(s[1]);
  });

  it('the toast area height is bounded and matches the layout constants', () => {
    expect(toastAreaHeight(0)).toBe(0);
    expect(toastAreaHeight(1)).toBe(TOAST_AREA_PAD * 2 + TOAST_H);
    expect(toastAreaHeight(2, true)).toBe(TOAST_AREA_PAD * 2 + 2 * TOAST_H + TOAST_GAP + REPLY_H + TOAST_GAP);
    expect(toastAreaHeight(50, true)).toBe(toastAreaHeight(MAX_TOASTS, true));
  });

  it('builds toasts from engine DM notes (truncated; unreadable stays null)', () => {
    expect(toastFromDm({ id: 'm1', partnerId: 'u1', callsign: 'A', text: 'x'.repeat(2000), timestamp: 't' }).text).toHaveLength(600);
    expect(toastFromDm({ id: 'm1', partnerId: 'u1', text: null }).text).toBeNull();
    expect(toastFromDm({ id: 'm1' })).toBeNull();
  });

  it('"Show DMs in overlay" defaults on and persists', () => {
    const st = memStorage();
    expect(loadOverlayDmsEnabled(st)).toBe(true);
    saveOverlayDmsEnabled(false, st);
    expect(loadOverlayDmsEnabled(st)).toBe(false);
    saveOverlayDmsEnabled(true, st);
    expect(loadOverlayDmsEnabled(st)).toBe(true);
  });
});
