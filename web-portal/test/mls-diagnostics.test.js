import { describe, expect, it } from 'vitest';
import { formatMlsDiagnostics, mlsGroupName, sortMlsGroups } from '../src/utils/mlsDiagnosticsReport.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const OWN = 'user-1:dev-a';

describe('formatMlsDiagnostics (S2)', () => {
  it('reports a state that is not loaded', () => {
    const text = formatMlsDiagnostics({ loaded: false, ownLabel: null, groups: [] }, { now: NOW });
    expect(text).toContain('MLS diagnostics — 2026-11-10T12:00:00.000Z');
    expect(text).toContain('This device: (unknown — identity not loaded)');
    expect(text).toContain('not loaded');
    expect(text).not.toContain('Groups held');
  });

  it('handles a missing diagnostics object', () => {
    expect(formatMlsDiagnostics(null, { now: NOW })).toContain('No diagnostics available.');
  });

  it('lists groups with epoch, members and membership, sorted, errors last', () => {
    const text = formatMlsDiagnostics({
      loaded: true,
      ownLabel: OWN,
      stateVersion: 7,
      groups: [
        { groupId: 'zz-broken', error: 'bad group' },
        { groupId: 'chan-b', epoch: 3, memberCount: 1, memberLabels: ['user-2:dev-x'], selfIsMember: false },
        { groupId: 'chan-a', epoch: 12, memberCount: 2, memberLabels: [OWN, 'user-2:dev-x'], selfIsMember: true },
      ],
    }, { now: NOW, names: { 'chan-a': 'General' } });
    expect(text).toContain(`This device: ${OWN}`);
    expect(text).toContain('State version: 7');
    expect(text).toContain('Groups held: 3 (1 without this device as a member) (1 unreadable)');
    expect(text).toContain('Group General (chan-a)');
    expect(text).toContain('  epoch: 12');
    expect(text).toContain(`    - ${OWN}  (this device)`);
    expect(text).toContain('  this device is a member: NO');
    expect(text).toContain('  error: bad group');
    const a = text.indexOf('chan-a');
    const b = text.indexOf('Group chan-b');
    const z = text.indexOf('zz-broken');
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(z);
  });

  it('reports a group-listing error', () => {
    const text = formatMlsDiagnostics({ loaded: true, ownLabel: OWN, groups: [], error: 'boom' }, { now: NOW });
    expect(text).toContain('Error listing groups: boom');
    expect(text).toContain('Groups held: 0');
  });
});

describe('helpers', () => {
  it('mlsGroupName falls back to the raw id', () => {
    expect(mlsGroupName('g1', null)).toBe('g1');
    expect(mlsGroupName('g1', { g1: 'Ops' })).toBe('Ops (g1)');
  });

  it('sortMlsGroups does not mutate its input and tolerates null', () => {
    const input = [{ groupId: 'b' }, { groupId: 'a' }];
    expect(sortMlsGroups(input).map((g) => g.groupId)).toEqual(['a', 'b']);
    expect(input[0].groupId).toBe('b');
    expect(sortMlsGroups(null)).toEqual([]);
  });
});
