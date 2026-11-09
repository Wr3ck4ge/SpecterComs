// FREQPRIO / FREQWL: a frequency's member whitelist + per-member priority
// (planner side). `member_priorities` keys ARE the whitelist — nobody is on a
// net implicitly; roles are only a shortcut for adding their holders.
import { describe, it, expect } from 'vitest';
import {
  FREQUENCY_DEFAULT_PRIORITY, addFrequencyMembers, addFrequencyRoleWithHolders, buildEventGroupsPayload,
  frequencyMemberPriority, frequencyMembers, frequencyRoleHolderCandidates, isFrequencyMember,
  mapEventGroups, removeFrequencyMember, setFrequencyMemberPriority,
} from '../src/utils/eventGroups.js';

const data = {
  groups: [{
    id: 'g1', name: 'Alpha',
    roles: [{ id: 'r1', name: 'Lead', priority: 5, assignment_mode: 'direct', assigned_user_id: 'u-lead', assigned_callsign: 'Lead' },
      { id: 'r2', name: 'Rifle', priority: 3 }],
    members: [{ user_id: 'u-lead', role_id: 'r1', status: 'accepted', callsign: 'Lead' },
      { user_id: 'u-rifle', role_id: 'r2', status: 'accepted', callsign: 'Rifle' },
      { user_id: 'u-pend', role_id: 'r2', status: 'pending', callsign: 'Pend' }],
  }],
  frequencies: [{ id: 'f1', name: 'NET A', role_refs: [{ gi: 0, ri: 0 }], member_priorities: { 'u-lead': 2 },
    members: [{ user_id: 'u-lead', callsign: 'Lead', priority: 2 }] }],
};
const orgMembers = [{ user_id: 'u-cmdr', callsign: 'Cmdr' }, { user_id: 'u-lead', callsign: 'Lead' }];

describe('frequency whitelist + priority (planner)', () => {
  it('the whitelist is exactly member_priorities; priority never read from the role', () => {
    const { groups, frequencies } = mapEventGroups(data);
    expect(frequencyMembers(frequencies[0], groups)).toEqual([{ user_id: 'u-lead', callsign: 'Lead', priority: 2 }]);
    expect(frequencyMemberPriority(frequencies[0], 'u-lead')).toBe(2); // role priority is 5
    expect(isFrequencyMember(frequencies[0], 'u-cmdr')).toBe(false);
  });

  it('role holders not on the net are suggestions, not members (accepted only)', () => {
    const { groups, frequencies } = mapEventGroups(data);
    const withRifle = [{ ...frequencies[0], role_refs: [...frequencies[0].role_refs, { group_index: 0, role_index: 1 }] }];
    expect(frequencyMembers(withRifle[0], groups).map((m) => m.callsign)).toEqual(['Lead']);
    expect(frequencyRoleHolderCandidates(withRifle[0], groups).map((m) => m.callsign)).toEqual(['Rifle']);
  });

  it('adding a role through the planner adds its current holders', () => {
    const { groups, frequencies } = mapEventGroups(data);
    const f = addFrequencyRoleWithHolders(frequencies, 0, 0, 1, groups);
    expect(f[0].member_priorities).toEqual({ 'u-lead': 2, 'u-rifle': FREQUENCY_DEFAULT_PRIORITY });
  });

  it('add an individual (the commander), set priority, remove — the payload carries the full whitelist', () => {
    const { groups, frequencies } = mapEventGroups(data);
    let f = addFrequencyMembers(frequencies, 0, ['u-cmdr']);
    expect(frequencyMembers(f[0], groups, orgMembers).map((m) => m.callsign)).toEqual(['Cmdr', 'Lead']);
    f = setFrequencyMemberPriority(f, 0, 'u-cmdr', 5);
    f = setFrequencyMemberPriority(f, 0, 'u-lead', FREQUENCY_DEFAULT_PRIORITY); // default stays a member
    expect(f[0].member_priorities).toEqual({ 'u-cmdr': 5, 'u-lead': 3 });
    f = removeFrequencyMember(f, 0, 'u-lead');
    expect(f[0].member_priorities).toEqual({ 'u-cmdr': 5 });
    expect(frequencies[0].member_priorities).toEqual({ 'u-lead': 2 }); // immutable
    expect(buildEventGroupsPayload(groups, f).frequencies[0].member_priorities).toEqual({ 'u-cmdr': 5 });
  });
});
