import { describe, it, expect } from 'vitest';
import { createDecodeWatch, createRecoveryBudget, createRateLimitedLog, decoderRecoveryReason } from '../src/engine/videoRecovery.js';
import { streamAspect, overlayStreamHeight, aspectChanged } from '../src/engine/videoAspect.js';
import { streamViewerLayout, miniThumbH, viewerAspect } from '../src/components/strip/streamViewerLayout.js';
import { spsDimsFromAnnexB } from '../src/engine/h264Sps.js';
import { nativeCaptureLimits } from '../src/engine/captureLimits.js';

const clock = () => { let t = 0; const now = () => t; now.add = (d) => { t += d; }; return now; };

describe('decode watch', () => {
  it('flags a stall only while frames keep going in with no output', () => {
    const now = clock();
    const w = createDecodeWatch({ stallMs: 2000, now });
    w.input(); now.add(1000); w.input();
    expect(w.stalled()).toBe(false);
    now.add(1000); w.input();
    expect(w.stalled()).toBe(true);
    w.output();
    expect(w.stalled()).toBe(false);
  });
  it('a paused sharer (no input) is not a stall', () => {
    const now = clock();
    const w = createDecodeWatch({ stallMs: 2000, now });
    w.input(); now.add(5000);
    expect(w.stalled()).toBe(false);
  });
});

describe('recovery budget and logging', () => {
  it('allows max recoveries per window', () => {
    const now = clock();
    const b = createRecoveryBudget({ max: 2, windowMs: 1000, now });
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    now.add(1001);
    expect(b.take()).toBe(true);
  });
  it('rate-limits and counts suppressed lines', () => {
    const now = clock(); const out = [];
    const log = createRateLimitedLog((m) => out.push(m), { intervalMs: 100, now });
    log('a'); log('b'); log('c'); now.add(100); log('d');
    expect(out).toEqual(['a', 'd (+2 suppressed)']);
  });
  it('names why a decoder needs recreating', () => {
    expect(decoderRecoveryReason(null)).toBe(null);
    expect(decoderRecoveryReason({ state: 'configured' })).toBe(null);
    expect(decoderRecoveryReason({ state: 'closed' })).toBe('decoder closed');
    expect(decoderRecoveryReason({ state: 'configured' }, { broken: true })).toBe('decoder error');
    expect(decoderRecoveryReason({ state: 'configured' }, { watch: { stalled: () => true } })).toMatch(/no output/);
  });
});

describe('aspect sizing', () => {
  it('overlay height follows the stream aspect, clamped', () => {
    expect(overlayStreamHeight(16 / 9)).toBe(216);
    expect(overlayStreamHeight(32 / 9)).toBe(108);
    expect(overlayStreamHeight(21 / 9)).toBe(165);
    expect(overlayStreamHeight(9 / 16)).toBe(288); // portrait → 4:3 box
    expect(streamAspect(0, 0)).toBeCloseTo(16 / 9);
    expect(aspectChanged(1.777, 1.778)).toBe(false);
    expect(aspectChanged(16 / 9, 32 / 9)).toBe(true);
  });
  it('strip viewer keeps 16:9 exactly and fits ultrawide to its aspect', () => {
    const bar = { left: 1200, right: 1700, top: 1000, bottom: 1040 };
    const base = streamViewerLayout({ vw: 1920, vh: 1040, bar });
    expect(base.videoH).toBe(Math.round(base.width * 9 / 16));
    const uw = streamViewerLayout({ vw: 1920, vh: 1040, bar, aspect: 5120 / 1440 });
    expect(Math.abs(uw.width / uw.videoH - 5120 / 1440)).toBeLessThan(0.05);
    expect(uw.width).toBeGreaterThan(base.width);
    expect(uw.videoH).toBeLessThan(base.videoH);
    expect(miniThumbH(16 / 9)).toBe(63);
    expect(viewerAspect(0.5)).toBe(1);
  });
});

describe('SPS dims and capture limits', () => {
  it('reads 1920x1080 (cropped) from a High-profile SPS', () => {
    // x264 1920x1080 High@4.0 SPS (cropping 1088 → 1080).
    const sps = Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58]);
    expect(spsDimsFromAnnexB(sps)).toEqual({ width: 1920, height: 1080 });
    expect(spsDimsFromAnnexB(Uint8Array.from([0, 0, 1, 0x65, 0x88]))).toBe(null);
  });
  it('sends the profile height, pixel budget and width ceiling', () => {
    expect(nativeCaptureLimits({ width: 1920, height: 1080 })).toEqual({ max_height: 1080, max_width: 3840, max_pixels: 2073600 });
  });
});
