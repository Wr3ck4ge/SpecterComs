import { describe, it, expect } from 'vitest';
import {
  LIVE_GAP, LIVE_MARGIN, LIVE_NOTICE_W, LIVE_TAB_W,
  fmtDuration, liveNoticeLayout, liveTimingText, newLiveOps, opPresence, pruneDismissed, visibleLiveOps,
} from '../src/components/strip/liveNoticeLayout.js';
import { buildLiveOps, liveOpKey, orgIdFromEvent } from '../src/engine/liveOps.js';
import { trayActivityFor } from '../src/engine/trayActivity.js';
import { OVERLAY_BASE_W, OVERLAY_MAX_W, overlayChannelLabel, overlayLayoutWidth } from '../src/engine/overlayHeader.js';
import { buildEngineState, EMPTY_STATE } from '../src/engine/bridge.js';

// The bar as strip.rs docks it: MAIN_WIDTH 560 against the right edge of a
// 1920-wide work area, 70px tall at the bottom.
const barRight = { left: 1920 - 8 - 560, right: 1920 - 8, top: 1000, bottom: 1070 };

describe('live notice placement', () => {
  it('opens left of the bar in its height band (bottom taskbar, tray at the right)', () => {
    const p = liveNoticeLayout({ vw: 1920, bar: barRight });
    expect(p.side).toBe('left');
    expect(p.width).toBe(LIVE_NOTICE_W);
    expect(p.left + p.width).toBe(barRight.left - LIVE_GAP); // attached to the bar's left edge
    expect([p.top, p.height]).toEqual([barRight.top, 70]);
  });

  it('the tab sits against the bar on the same side', () => {
    const p = liveNoticeLayout({ vw: 1920, bar: barRight, tab: true });
    expect(p.side).toBe('left');
    expect(p.width).toBe(LIVE_TAB_W);
    expect(p.left + p.width).toBe(barRight.left - LIVE_GAP);
  });

  it('falls back to the right when the strip is docked near the left edge (left taskbar)', () => {
    const bar = { left: 8, right: 568, top: 8, bottom: 78 }; // top-left, grow down
    const p = liveNoticeLayout({ vw: 1920, bar });
    expect(p.side).toBe('right');
    expect(p.left).toBe(bar.right + LIVE_GAP);
    // The tab follows the notice's side.
    expect(liveNoticeLayout({ vw: 1920, bar, tab: true }).side).toBe('right');
  });

  it('stays left with a narrower notice when the left has some room, and clamps on tiny screens', () => {
    const bar = { left: 8 + 260, right: 268 + 560, top: 0, bottom: 70 };
    const p = liveNoticeLayout({ vw: 1400, bar });
    expect(p.side).toBe('left');
    expect(p.width).toBe(260 - LIVE_GAP);
    expect(p.left).toBe(LIVE_MARGIN);
    const tiny = liveNoticeLayout({ vw: 600, bar: { left: 20, right: 580, top: 0, bottom: 70 } });
    expect(tiny.width).toBeLessThanOrEqual(20);
    expect(tiny.width).toBeGreaterThanOrEqual(0);
  });
});

describe('live notice state helpers', () => {
  const ops = [{ key: 'a:1' }, { key: 'b:1' }];
  it('dismissed launches stay hidden; a relaunch (new key) shows again', () => {
    expect(visibleLiveOps(ops, new Set(['a:1'])).map((o) => o.key)).toEqual(['b:1']);
    expect(visibleLiveOps([{ key: 'a:2' }], new Set(['a:1'])).map((o) => o.key)).toEqual(['a:2']);
  });
  it('announces only what is new', () => {
    expect(newLiveOps(ops, new Set(['a:1'])).map((o) => o.key)).toEqual(['b:1']);
  });
  it('prunes dismissals only once the live list is known', () => {
    const d = new Set(['a:1', 'gone:1']);
    expect(pruneDismissed(d, [], false)).toBe(d);
    expect([...pruneDismissed(d, ops, true)]).toEqual(['a:1']);
  });
  it('timing text', () => {
    const now = new Date('2026-11-07T20:30:00').getTime();
    const startTime = new Date('2026-11-07T20:00:00').toISOString();
    expect(liveTimingText({ startTime, liveSince: now - 12 * 60_000 }, now)).toMatch(/^Live 12 min · started /);
    expect(liveTimingText({ startTime, liveSince: null }, now)).toMatch(/^Started /);
    expect(fmtDuration(80 * 60_000)).toBe('1 h 20 min');
    expect(fmtDuration(10_000)).toBe('just now');
  });
  it('presence: my group and who is in the op voice channels (engine server only)', () => {
    const op = { orgId: 'o1', eventId: 'e1' };
    const st = {
      org: { id: 'o1' },
      channels: [
        { id: 'c1', name: 'Command', kind: 'voice', eventId: 'e1', mine: false, canJoin: false, occupants: ['A'] },
        { id: 'c2', name: 'Group 3', kind: 'voice', eventId: 'e1', mine: true, canJoin: true, occupants: ['B', 'C'] },
        { id: 'c3', name: 'Lobby', kind: 'voice', eventId: null, mine: false, canJoin: true, occupants: ['D'] },
      ],
    };
    expect(opPresence(op, st)).toEqual({ group: { id: 'c2', name: 'Group 3', inVoice: 2, canJoin: true }, inVoice: 3 });
    expect(opPresence({ ...op, orgId: 'o2' }, st)).toEqual({ group: null, inVoice: null });
  });
});

describe('engine live ops', () => {
  it('reads the server from the SSE subject', () => {
    expect(orgIdFromEvent({ type: 'event_launched', subject: 'specter.event.org.abc-1', eventId: 'e' })).toBe('abc-1');
    expect(orgIdFromEvent({ org_id: 'x' })).toBe('x');
    expect(orgIdFromEvent({})).toBe(null);
  });
  it('builds the list across servers, launched only, newest launch first', () => {
    const orgs = [{ id: 'o1', callsign: 'Testing Server' }, { id: 'o2', name: 'Ghost Fleet' }];
    const byOrg = {
      o1: [{ id: 'e1', name: 'coms testing', launched: true, command_channel_id: 'cc1', start_time: '2026-11-07T19:00:00Z', filled_slots: '7', total_slots: '12' }],
      o2: [{ id: 'e2', name: 'Op Two', launched: true, command_channel_id: 'cc2', start_time: '2026-11-07T18:00:00Z' },
        { id: 'e3', name: 'Not live', launched: false }],
      gone: [{ id: 'e9', name: 'left server', launched: true }],
    };
    const since = { [liveOpKey({ id: 'e2', command_channel_id: 'cc2' })]: { t: Date.parse('2026-11-07T20:00:00Z') } };
    const list = buildLiveOps({ byOrg, orgs, since });
    expect(list.map((o) => o.eventId)).toEqual(['e2', 'e1']);
    expect(list[1]).toMatchObject({ key: 'e1:cc1', orgName: 'Testing Server', filledSlots: 7, totalSlots: 12, liveSince: null });
    expect(list[1].event).toMatchObject({ id: 'e1', launched: true, org_id: 'o1' });
  });
  it('is part of the bridge state (empty by default)', () => {
    expect(EMPTY_STATE.liveOps).toEqual([]);
    expect(buildEngineState({}).liveOps).toEqual([]);
    expect(buildEngineState({ liveOps: [{ key: 'k' }] }).liveOps).toEqual([{ key: 'k' }]);
  });
});

describe('tray activity', () => {
  it('idle outside voice, active / muted in it, label "<channel> (<server>)"', () => {
    expect(trayActivityFor({ inVoice: false, channelName: 'Alpha' })).toEqual({ state: 'idle', label: '' });
    expect(trayActivityFor({ inVoice: true, channelName: 'Alpha', orgName: 'Ghost Fleet' })).toEqual({ state: 'active', label: 'Alpha (Ghost Fleet)' });
    expect(trayActivityFor({ inVoice: true, muted: true, channelName: 'Alpha' })).toEqual({ state: 'muted', label: 'Alpha' });
    expect(trayActivityFor({ inVoice: true })).toEqual({ state: 'active', label: 'voice' });
  });
});

describe('overlay header', () => {
  it('op channels read "<op> › <group>"; others just the name', () => {
    expect(overlayChannelLabel({ channelName: 'Group 3', opName: 'Operation coms testing' }))
      .toEqual({ lead: 'Operation coms testing', tail: 'Group 3', full: 'Operation coms testing › Group 3' });
    expect(overlayChannelLabel({ channelName: 'Voice and Video Testing' }))
      .toEqual({ lead: 'Voice and Video Testing', tail: null, full: 'Voice and Video Testing' });
    expect(overlayChannelLabel({ channelName: 'Ops', opName: 'Ops' }).tail).toBe(null);
    expect(overlayChannelLabel({}).full).toBe('No channel');
  });
  it('grows the overlay to fit the header, within bounds, per scale', () => {
    expect(overlayLayoutWidth({ headerNeed: 300, scale: 1 })).toBe(OVERLAY_BASE_W);
    expect(overlayLayoutWidth({ headerNeed: 430, scale: 1 })).toBe(430);
    expect(overlayLayoutWidth({ headerNeed: 900, scale: 1 })).toBe(OVERLAY_MAX_W);
    // The header doesn't scale but the window does: at 125 % less layout width is needed.
    expect(overlayLayoutWidth({ headerNeed: 500, scale: 1.25 })).toBe(400);
  });
});
