// Screen-share audio (S2/S3): wire framing, the backward-compat flags, the
// A/V delay heuristic, per-sharer prefs, the playback controller and the
// send pump's audio priority. See src/engine/shareAudio.js.
import { describe, it, expect, vi } from 'vitest';
import {
  SHARE_AUDIO_FLAGS, SHARE_FRAME_FLAG_DELTA, SHARE_AUDIO_INNER_V1, SHARE_AUDIO_CAPABLE_SIGNAL,
  isShareAudioFlags, isShareAudioCapableSignal, encodeShareAudioInner, decodeShareAudioInner,
  frameShareAudio, frameShareUnit, base64ToBytes, bytesToBase64,
  createAvDelayEstimator, AV_DELAY_DEFAULT_MS, AV_DELAY_MIN_MS, AV_DELAY_MAX_MS, AV_RENDER_ESTIMATE_MS,
  loadShareAudioEnabled, saveShareAudioEnabled, loadSharerAudioPref, saveSharerAudioPref, effectiveShareVolume,
  createShareAudioNative, createShareAudioPlayer, DELAY_UPDATE_INTERVAL_MS,
} from '../src/engine/shareAudio.js';
import { createVideoSendPump, AUDIO_QUEUE_MAX } from '../src/engine/videoSendPump.js';
import { buildEngineState } from '../src/engine/bridge.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
};

describe('wire format', () => {
  it('audio frames carry bit 0 (delta) so no relay ever caches them as a keyframe', () => {
    expect(SHARE_AUDIO_FLAGS & SHARE_FRAME_FLAG_DELTA).toBe(SHARE_FRAME_FLAG_DELTA);
    // media-rust: video_flags_is_keyframe = flags & 1 == 0
    expect((SHARE_AUDIO_FLAGS & 0x01) === 0).toBe(false);
    expect(isShareAudioFlags(SHARE_AUDIO_FLAGS)).toBe(true);
    // Video as every client has always sent it is never audio.
    expect(isShareAudioFlags(0x00)).toBe(false);
    expect(isShareAudioFlags(0x01)).toBe(false);
  });

  it('frames as [4B size][1B flags][4B ts][payload], the same layout as video', () => {
    const payload = new Uint8Array([9, 8, 7]);
    const buf = frameShareAudio(0x01020304, payload);
    const v = new DataView(buf.buffer);
    expect(buf.length).toBe(4 + 1 + 4 + 3);
    expect(v.getUint32(0)).toBe(1 + 4 + 3);
    expect(buf[4]).toBe(SHARE_AUDIO_FLAGS);
    expect(v.getUint32(5)).toBe(0x01020304);
    expect(Array.from(buf.slice(9))).toEqual([9, 8, 7]);
    // ts wraps like the video path's `>>> 0`
    expect(new DataView(frameShareUnit(1, 2 ** 32 + 5, payload).buffer).getUint32(5)).toBe(5);
  });

  it('inner payload round-trips and rejects anything that is not v1 audio', () => {
    const opus = new Uint8Array([1, 2, 3, 4, 5]);
    const inner = encodeShareAudioInner({ seq: 0xdeadbeef, durationMs: 20, opus });
    expect(inner[0]).toBe(SHARE_AUDIO_INNER_V1);
    const back = decodeShareAudioInner(inner);
    expect(back.seq).toBe(0xdeadbeef);
    expect(back.durationMs).toBe(20);
    expect(Array.from(back.opus)).toEqual([1, 2, 3, 4, 5]);
    // A video NAL (Annex-B start code) mis-flagged as audio must not play.
    expect(decodeShareAudioInner(new Uint8Array([0, 0, 0, 1, 0x65, 0, 0, 0]))).toBeNull();
    expect(decodeShareAudioInner(new Uint8Array([SHARE_AUDIO_INNER_V1, 0, 0]))).toBeNull();
    expect(decodeShareAudioInner(null)).toBeNull();
  });

  it('recognises the server capability signal', () => {
    expect(isShareAudioCapableSignal(new Uint8Array([SHARE_AUDIO_CAPABLE_SIGNAL]))).toBe(true);
    expect(isShareAudioCapableSignal(new Uint8Array([0xac]))).toBe(false);
    expect(isShareAudioCapableSignal(new Uint8Array([0x4b]))).toBe(false);
    expect(isShareAudioCapableSignal(null)).toBe(false);
  });

  it('base64 helpers round-trip (including > one chunk)', () => {
    const bytes = new Uint8Array(20000).map((_, i) => i * 7);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('createAvDelayEstimator', () => {
  const feed = (est, { videoLag, n = 40, clockOffset = 5_000_000 }) => {
    for (let i = 0; i < n; i++) {
      const ts = clockOffset + i * 20;
      est.onAudio(ts, i * 20 + 30);            // audio transit 30 ms
      est.onVideo(ts, i * 20 + 30 + videoLag); // video arrives videoLag later
    }
  };

  it('is the default until both streams have enough samples', () => {
    const est = createAvDelayEstimator();
    expect(est.delayMs()).toBe(AV_DELAY_DEFAULT_MS);
    for (let i = 0; i < 5; i++) { est.onAudio(i, i); est.onVideo(i, i + 50); }
    expect(est.delayMs()).toBe(AV_DELAY_DEFAULT_MS);
  });

  it('holds audio back by the video lag plus the render estimate', () => {
    const est = createAvDelayEstimator();
    feed(est, { videoLag: 80 });
    expect(est.delayMs()).toBe(80 + AV_RENDER_ESTIMATE_MS);
  });

  it('uses the measured decode time when this window decodes', () => {
    const est = createAvDelayEstimator();
    feed(est, { videoLag: 80 });
    for (let i = 0; i < 30; i++) est.onVideoDecodeMs(12);
    expect(est.delayMs()).toBe(Math.round(80 + 12 + 10));
  });

  it('clamps to [min, max]', () => {
    const lo = createAvDelayEstimator();
    feed(lo, { videoLag: -200 }); // audio is the slow one
    expect(lo.delayMs()).toBe(AV_DELAY_MIN_MS);
    const hi = createAvDelayEstimator();
    feed(hi, { videoLag: 1500 });
    expect(hi.delayMs()).toBe(AV_DELAY_MAX_MS);
  });

  it('falls back to the default when the clocks clearly differ (older native build)', () => {
    const est = createAvDelayEstimator();
    for (let i = 0; i < 40; i++) {
      est.onAudio(1_000_000 + i * 20, i * 20);
      est.onVideo(9_000_000 + i * 20, i * 20); // another clock entirely
    }
    expect(est.delayMs()).toBe(AV_DELAY_DEFAULT_MS);
  });

  it('restarts a stream after a clock jump instead of averaging across it', () => {
    const est = createAvDelayEstimator();
    feed(est, { videoLag: 80 });
    // u32 timestamp wrap on both: transit jumps by 2^32 for each.
    feed(est, { videoLag: 80, clockOffset: 5_000_000 - 2 ** 32 });
    expect(est.delayMs()).toBe(80 + AV_RENDER_ESTIMATE_MS);
  });
});

describe('preferences', () => {
  it('"Share audio" is off by default and persists', () => {
    const st = memStorage();
    expect(loadShareAudioEnabled(st)).toBe(false);
    saveShareAudioEnabled(true, st);
    expect(loadShareAudioEnabled(st)).toBe(true);
    saveShareAudioEnabled(false, st);
    expect(loadShareAudioEnabled(st)).toBe(false);
  });

  it('volume/mute persist per sharer, clamped to 0..2', () => {
    const st = memStorage();
    expect(loadSharerAudioPref('Alpha', st)).toEqual({ volume: 1, muted: false });
    saveSharerAudioPref('Alpha', { volume: 5 }, st);
    saveSharerAudioPref('Bravo', { muted: true }, st);
    expect(loadSharerAudioPref('Alpha', st)).toEqual({ volume: 2, muted: false });
    expect(loadSharerAudioPref('Bravo', st)).toEqual({ volume: 1, muted: true });
    saveSharerAudioPref('Alpha', { volume: -1, muted: true }, st);
    expect(loadSharerAudioPref('Alpha', st)).toEqual({ volume: 0, muted: true });
    expect(effectiveShareVolume({ volume: 1.5, muted: false })).toBe(1.5);
    expect(effectiveShareVolume({ volume: 1.5, muted: true })).toBe(0);
  });

  it('survives corrupt or unavailable storage', () => {
    const bad = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
    expect(loadSharerAudioPref('X', bad)).toEqual({ volume: 1, muted: false });
    expect(() => saveSharerAudioPref('X', { volume: 1 }, bad)).not.toThrow();
    expect(() => saveShareAudioEnabled(true, bad)).not.toThrow();
  });
});

describe('createShareAudioNative (fail-soft)', () => {
  it('probe: false when the command does not exist or is not allowed, true otherwise', async () => {
    const missing = createShareAudioNative(async () => { throw new Error('Command share_audio_playback_stop not found'); });
    expect(await missing.probe()).toBe(false);
    const denied = createShareAudioNative(async () => { throw 'specter-audio.share_audio_playback_stop not allowed. Permissions associated with this command: ...'; });
    expect(await denied.probe()).toBe(false);
    const ok = createShareAudioNative(async () => null);
    expect(await ok.probe()).toBe(true);
    const complains = createShareAudioNative(async () => { throw new Error('unknown sharer'); });
    expect(await complains.probe()).toBe(true);
  });

  it('every call but start() resolves even when the native side throws', async () => {
    const invoke = vi.fn(async () => { throw new Error('boom'); });
    const n = createShareAudioNative(invoke);
    await expect(n.stop()).resolves.toBeNull();
    await expect(n.playFrame('A', 'AA==', 1, 2)).resolves.toBeNull();
    await expect(n.setVolume('A', 1)).resolves.toBeNull();
    await expect(n.setDelay('A', 100)).resolves.toBeNull();
    await expect(n.playbackStop('A')).resolves.toBeNull();
    await expect(n.start('src')).rejects.toThrow('boom');
    expect(invoke).toHaveBeenCalledWith('plugin:specter-audio|share_audio_play_frame', { sharerId: 'A', dataB64: 'AA==', timestampMs: 1, seq: 2 });
    expect(invoke).toHaveBeenCalledWith('plugin:specter-audio|share_audio_start', { sourceId: 'src' });
  });
});

describe('createShareAudioPlayer', () => {
  const fakeNative = () => ({
    playFrame: vi.fn(), setVolume: vi.fn(), setDelay: vi.fn(), playbackStop: vi.fn(),
  });

  it('applies the sharer pref and initial delay before the first frame, then plays', () => {
    const native = fakeNative();
    let t = 0;
    const p = createShareAudioPlayer(native, { getPref: () => ({ volume: 0.5, muted: false }), now: () => t });
    p.frame('Alpha', { tsMs: 100, seq: 1, opus: new Uint8Array([1, 2, 3]) });
    expect(native.setVolume).toHaveBeenCalledWith('Alpha', 0.5);
    expect(native.setDelay).toHaveBeenCalledWith('Alpha', AV_DELAY_DEFAULT_MS);
    expect(native.playFrame).toHaveBeenCalledWith('Alpha', bytesToBase64(new Uint8Array([1, 2, 3])), 100, 1);
    expect(p.sharer).toBe('Alpha');
  });

  it('switching sharer stops the previous one; stop() is idempotent', () => {
    const native = fakeNative();
    const p = createShareAudioPlayer(native, { getPref: () => ({ volume: 1, muted: true }), now: () => 0 });
    p.frame('Alpha', { tsMs: 1, seq: 1, opus: 'AA==' });
    p.frame('Bravo', { tsMs: 2, seq: 1, opus: 'AA==' });
    expect(native.playbackStop).toHaveBeenCalledWith('Alpha');
    expect(native.setVolume).toHaveBeenLastCalledWith('Bravo', 0); // muted
    p.stop();
    p.stop();
    expect(native.playbackStop).toHaveBeenCalledTimes(2);
    expect(p.sharer).toBeNull();
  });

  it('updates the delay at most once per interval and only on a real change', () => {
    const native = fakeNative();
    let t = 0;
    const p = createShareAudioPlayer(native, { getPref: () => ({ volume: 1, muted: false }), now: () => t });
    p.video('Alpha', 5); // ignored: Alpha isn't playing yet
    const frames = 200; // 4 s: two update intervals
    for (let i = 0; i < frames; i++) {
      t = i * 20;
      p.frame('Alpha', { tsMs: 1000 + i * 20, seq: i, opus: 'AA==' });
      p.video('Alpha', 1000 + i * 20 - 120); // video lags audio by 120 ms
    }
    const calls = native.setDelay.mock.calls.map((c) => c[1]);
    expect(calls[0]).toBe(AV_DELAY_DEFAULT_MS);
    expect(calls.length).toBeLessThanOrEqual(1 + Math.ceil((frames * 20) / DELAY_UPDATE_INTERVAL_MS));
    expect(calls.at(-1)).toBe(120 + AV_RENDER_ESTIMATE_MS);
  });

  it('applyPref only touches the sharer that is playing', () => {
    const native = fakeNative();
    const p = createShareAudioPlayer(native, { getPref: () => ({ volume: 1, muted: false }), now: () => 0 });
    p.applyPref('Alpha', { volume: 2, muted: false });
    expect(native.setVolume).not.toHaveBeenCalled();
    p.frame('Alpha', { tsMs: 1, seq: 1, opus: 'AA==' });
    p.applyPref('Alpha', { volume: 2, muted: false });
    expect(native.setVolume).toHaveBeenLastCalledWith('Alpha', 2);
  });
});

describe('send pump: share audio priority', () => {
  const stalledWriter = () => {
    const pending = [];
    return {
      writes: [],
      write(buf) { this.writes.push(buf); return new Promise((r) => pending.push(r)); },
      releaseOne() { pending.shift()?.(); },
      release() { while (pending.length) pending.shift()(); },
    };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('audio goes out before a pending video frame', async () => {
    const w = stalledWriter();
    const submit = createVideoSendPump({ current: w });
    submit('K1', true);  // in flight
    submit('K2', true);  // queued behind it
    submit.audio('a1');
    submit.audio('a2');
    w.releaseOne(); await flush();
    w.releaseOne(); await flush();
    w.releaseOne(); await flush();
    w.release(); await flush();
    expect(w.writes).toEqual(['K1', 'a1', 'a2', 'K2']);
  });

  it('audio drops never count as video congestion', async () => {
    const w = stalledWriter();
    const onDrop = vi.fn();
    const onResync = vi.fn();
    const submit = createVideoSendPump({ current: w }, onDrop, onResync);
    submit.audio('a0'); // in flight
    for (let i = 1; i <= AUDIO_QUEUE_MAX + 5; i++) submit.audio(`a${i}`);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onResync).not.toHaveBeenCalled();
    for (let i = 0; i < AUDIO_QUEUE_MAX + 2; i++) { w.release(); await flush(); }
    // Oldest queued frames were dropped, the newest AUDIO_QUEUE_MAX kept.
    expect(w.writes.length).toBe(1 + AUDIO_QUEUE_MAX);
    expect(w.writes.at(-1)).toBe(`a${AUDIO_QUEUE_MAX + 5}`);
  });

  it('a delta arriving while only audio is in flight is queued, not dropped', async () => {
    const w = stalledWriter();
    const onDrop = vi.fn();
    const submit = createVideoSendPump({ current: w }, onDrop);
    submit('K', true);
    w.release(); await flush();
    submit.audio('a1'); // in flight
    submit('d1', false);
    expect(onDrop).not.toHaveBeenCalled();
    w.release(); await flush(); w.release(); await flush();
    expect(w.writes).toEqual(['K', 'a1', 'd1']);
  });
});

describe('bridge state.voice.shareAudio', () => {
  const base = {
    user: { callsign: 'Me' }, inComms: true, voiceChannel: { id: 'c', name: 'C' }, voiceStatus: 'connected',
    activeSharers: ['Alpha', 'Bravo'], voiceSharing: true,
  };
  it('lists only sharers still sharing, plus me while my audio is active', () => {
    const s = buildEngineState({
      ...base,
      shareAudio: { supported: true, enabled: true, active: true, echoRisk: true, sharers: ['Alpha', 'Gone'], prefs: { Alpha: { volume: 1, muted: false } } },
    });
    expect(s.voice.shareAudio.sharers).toEqual(['Alpha', 'Me']);
    expect(s.voice.shareAudio.echoRisk).toBe(true);
    expect(s.voice.shareAudio.prefs.Alpha).toEqual({ volume: 1, muted: false });
  });
  it('is empty-but-present without a report (older engine paths)', () => {
    const s = buildEngineState(base);
    expect(s.voice.shareAudio).toMatchObject({ supported: false, enabled: false, sharers: [] });
  });
});
