import { describe, it, expect } from 'vitest';
import { freqBarChips, freqBarHeight, overlayLayout, FREQ_BAR_H } from '../src/engine/freqBar';

const freqs = [
  { id: 'a', name: 'ALPHA', speaker: null },
  { id: 'b', name: 'BRAVO', speaker: 'Ghost' },
  { id: 'c', name: 'CHARLIE', speaker: 'Viper' },
];

describe('freqBarChips', () => {
  it('is empty when nobody speaks', () => {
    expect(freqBarChips({ freqs: [freqs[0]], missionWide: null, activeNet: { kind: 'group' } })).toEqual([]);
    expect(freqBarChips()).toEqual([]);
  });
  it('lists only speaking frequencies, marking the active TX net', () => {
    const c = freqBarChips({ freqs, activeNet: { kind: 'frequency', txNetId: 'c' } });
    expect(c.map(x => [x.key, x.speaker, x.tx])).toEqual([['b', 'Ghost', false], ['c', 'Viper', true]]);
  });
  it('puts Mission Wide first, red-flagged, even with no speaker name', () => {
    const c = freqBarChips({ freqs, missionWide: { playing: true, speaker: null }, activeNet: { kind: 'group' } });
    expect(c[0]).toMatchObject({ key: 'mission', mission: true, speaker: null, tx: false });
    expect(c).toHaveLength(3);
  });
  it('ignores a non-playing Mission Wide (commander merely armed)', () => {
    expect(freqBarChips({ missionWide: { playing: false, transmitting: true }, activeNet: { kind: 'mission' } })).toEqual([]);
  });
  it('marks Mission Wide tx when it is my active net', () => {
    const c = freqBarChips({ missionWide: { playing: true }, activeNet: { kind: 'mission' } });
    expect(c[0].tx).toBe(true);
  });
});

describe('overlayLayout / freqBarHeight', () => {
  it('collapses to zero with no chips', () => {
    expect(freqBarHeight([])).toBe(0);
    expect(freqBarHeight([{}])).toBe(FREQ_BAR_H);
  });
  it('pushes the stream down by exactly the bar height', () => {
    const base = { headerH: 36, pickerH: 0, videoH: 216, toastH: 50 };
    const off = overlayLayout({ ...base, freqBarH: 0 });
    const on = overlayLayout({ ...base, freqBarH: FREQ_BAR_H });
    expect(on.streamTop - off.streamTop).toBe(FREQ_BAR_H);
    expect(on.totalH - off.totalH).toBe(FREQ_BAR_H);
    expect(off.streamTop).toBe(36);
    expect(on.freqBarTop).toBe(36);
  });
  it('places the bar below an open picker', () => {
    expect(overlayLayout({ headerH: 36, pickerH: 100, freqBarH: 28 }).freqBarTop).toBe(136);
  });
});
