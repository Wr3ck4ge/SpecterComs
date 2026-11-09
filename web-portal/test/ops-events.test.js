// An op is launched only by Launch: the clock may say "ready to launch", never
// live. And End only moves the people who are in the op.
import { describe, expect, it } from 'vitest';
import {
  getActiveOpsCards, getOpsBadge, getOpsNotifications, isOpDue, isOpLive, msUntilNextOpsChange, operationEndedMovesMe,
} from '../src/utils/opsEvents.js';

const NOW = new Date('2026-11-03T20:00:00Z');
const at = (min) => new Date(NOW.getTime() + min * 60_000).toISOString();
const op = (o = {}) => ({ id: 'e1', name: 'Op', start_time: at(-10), end_time: at(60), launched: false, ...o });

describe('launched vs due', () => {
  it('past the start time and not launched: due, not live', () => {
    expect(isOpLive(op())).toBe(false);
    expect(isOpDue(op(), NOW)).toBe(true);
  });
  it('launched: live and not due, whatever the clock says', () => {
    expect(isOpLive(op({ launched: true, start_time: at(60), end_time: at(90) }))).toBe(true);
    expect(isOpLive(op({ launched: true, start_time: at(-300), end_time: at(-200) }))).toBe(true);
    expect(isOpDue(op({ launched: true }), NOW)).toBe(false);
  });
  it('before the start, after the end, or ended: not due', () => {
    expect(isOpDue(op({ start_time: at(5) }), NOW)).toBe(false);
    expect(isOpDue(op({ end_time: at(-1) }), NOW)).toBe(false);
    expect(isOpDue(op({ ended_at: at(-1) }), NOW)).toBe(false);
  });
  it('an op with no end time stops being due once it is stale (12h)', () => {
    expect(isOpDue(op({ end_time: null, start_time: at(-60) }), NOW)).toBe(true);
    expect(isOpDue(op({ end_time: null, start_time: at(-13 * 60) }), NOW)).toBe(false);
  });
});

describe('the badge', () => {
  it('a started, unlaunched op is "soon", never "live"', () => {
    expect(getOpsBadge([op()], NOW)).toMatchObject({ kind: 'soon', event: { id: 'e1' } });
  });
  it('only a launched op makes it "live"', () => {
    expect(getOpsBadge([op(), op({ id: 'e2', launched: true })], NOW)).toEqual({ kind: 'live' });
  });
  it('further out it stays a count', () => {
    expect(getOpsBadge([op({ start_time: at(120), end_time: at(180) })], NOW)).toEqual({ kind: 'count', count: 1 });
  });
});

describe('Now & soon cards', () => {
  it('keeps launched, due and next-24h ops, drops the rest', () => {
    const list = [
      op({ id: 'due' }),
      op({ id: 'live', launched: true, start_time: at(-30) }),
      op({ id: 'tomorrow', start_time: at(23 * 60), end_time: null }),
      op({ id: 'later', start_time: at(25 * 60), end_time: null }),
      op({ id: 'over', start_time: at(-120), end_time: at(-60) }),
    ];
    expect(getActiveOpsCards(list, NOW).map((e) => e.id)).toEqual(['live', 'due', 'tomorrow']);
  });
});

describe('notifications', () => {
  it('my started, unlaunched op is "due", and launching it notifies again', () => {
    const [due] = getOpsNotifications({ mine: [op()], now: NOW });
    expect(due).toMatchObject({ kind: 'mine', phase: 'due', key: 'mine:e1:due' });
    const [live] = getOpsNotifications({ mine: [op({ launched: true })], now: NOW });
    expect(live).toMatchObject({ phase: 'live', key: 'mine:e1:live' });
  });
  it('an op starting soon is "soon"; one far off is nothing', () => {
    expect(getOpsNotifications({ mine: [op({ start_time: at(20) })], now: NOW })[0]).toMatchObject({ phase: 'soon' });
    expect(getOpsNotifications({ mine: [op({ start_time: at(90), end_time: at(120) })], now: NOW })).toEqual([]);
  });
  it('an open op past its start is "due", never "live"', () => {
    const ev = op({ access_mode: 'open', total_slots: 4, filled_slots: 1 });
    expect(getOpsNotifications({ events: [ev], orgId: 'o1', now: NOW })[0]).toMatchObject({ kind: 'open', phase: 'due' });
  });
});

describe('the clock timer still wakes at the start time, to redraw', () => {
  it('schedules the start', () => {
    expect(msUntilNextOpsChange([op({ start_time: at(5), end_time: null })], NOW)).toBe(5 * 60_000);
  });
});

describe('operation_ended: who moves', () => {
  const payload = { channel_ids: ['cmd', 'alpha', 'bravo'] };
  it('someone in one of the op\'s channels', () => {
    expect(operationEndedMovesMe(payload, { voiceChannelId: 'alpha' })).toBe(true);
  });
  it('someone elsewhere with one of the op\'s frequencies', () => {
    expect(operationEndedMovesMe(payload, { voiceChannelId: 'lobby', frequencyChannelIds: ['cmd'] })).toBe(true);
  });
  it('a bystander in another channel stays', () => {
    expect(operationEndedMovesMe(payload, { voiceChannelId: 'lobby', frequencyChannelIds: ['other'] })).toBe(false);
  });
  it('nobody out of voice is pulled in', () => {
    expect(operationEndedMovesMe(payload, { voiceChannelId: null, frequencyChannelIds: ['cmd'] })).toBe(false);
  });
  it('no channel list: nobody moves', () => {
    expect(operationEndedMovesMe({}, { voiceChannelId: 'alpha' })).toBe(false);
  });
});
