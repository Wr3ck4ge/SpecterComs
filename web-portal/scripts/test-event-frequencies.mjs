// LEADFREQ: unit tests for the planner's frequency helpers (utils/eventGroups.js)
// — the Leadership net seeding/offer, the role-template default assignment,
// role-removal ref shifting and the save payload.
//
//   node scripts/test-event-frequencies.mjs
import {
  LEADERSHIP_FREQ_NAME, isLeadershipRoleName, newLeadershipFrequency, leadershipFrequencyIndex,
  ensureLeadershipFrequency, toggleLeadershipRole, assignLeadershipDefault, assignAllLeaderRoles,
  removeRoleFromFrequencies, mapEventGroups, buildEventGroupsPayload, newFrequency, newGroup, newRole,
  frequencyHasRole,
} from '../src/utils/eventGroups.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(true); console.log(`ok   - ${name}`); }
  catch (err) { results.push(false); console.log(`FAIL - ${name}\n       ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const group = (name, roleNames) => ({ ...newGroup(name), roles: roleNames.map((n) => newRole(n)) });

test('leader role names are recognised (and others are not)', () => {
  for (const n of ['Commander', 'Op Commander', 'Cmdr', 'Leader', 'Squad Lead', 'Flight Lead', 'Wing Lead', 'Lead', 'Captain', 'XO', 'team lead'])
    assert(isLeadershipRoleName(n), `${n} should be a leader role`);
  for (const n of ['Pilot', 'Gunner', 'Medic', 'Engineer', 'Scout', 'Leadership', 'Mislead', '', null])
    assert(!isLeadershipRoleName(n), `${n} should not be a leader role`);
});

test('ensureLeadershipFrequency prepends a marked LEADERSHIP net once', () => {
  const a = ensureLeadershipFrequency([newFrequency([])]);
  eq(a.map((f) => [f.name, !!f.is_leadership]), [[LEADERSHIP_FREQ_NAME, true], ['FREQ A', false]], 'order');
  assert(ensureLeadershipFrequency(a) === a, 'second call must be a no-op');
  eq(ensureLeadershipFrequency([]), [newLeadershipFrequency()], 'empty list');
  eq(leadershipFrequencyIndex(a), 0, 'index');
  eq(leadershipFrequencyIndex([newFrequency([])]), -1, 'none');
});

test('a role added from a leader template starts on the Leadership net; others do not', () => {
  let freqs = ensureLeadershipFrequency([]);
  freqs = assignLeadershipDefault(freqs, 0, 0, 'Lead');
  freqs = assignLeadershipDefault(freqs, 0, 1, 'Pilot');
  freqs = assignLeadershipDefault(freqs, 1, 0, 'Squad Lead');
  freqs = assignLeadershipDefault(freqs, 1, 0, 'Squad Lead'); // idempotent
  eq(freqs[0].role_refs, [{ group_index: 0, role_index: 0 }, { group_index: 1, role_index: 0 }], 'refs');
  // No Leadership net → nothing changes (never created implicitly).
  const plain = [newFrequency([])];
  assert(assignLeadershipDefault(plain, 0, 0, 'Lead') === plain, 'must not touch a plan without a Leadership net');
});

test('toggleLeadershipRole adds and removes; planners can change the default', () => {
  let freqs = ensureLeadershipFrequency([newFrequency([])]);
  freqs = toggleLeadershipRole(freqs, 2, 1);
  assert(frequencyHasRole(freqs[0], 2, 1), 'not added');
  assert(!frequencyHasRole(freqs[1], 2, 1), 'touched another frequency');
  freqs = toggleLeadershipRole(freqs, 2, 1);
  assert(!frequencyHasRole(freqs[0], 2, 1), 'not removed');
});

test('assignAllLeaderRoles (the one-click offer) assigns every leader-named role', () => {
  const groups = [group('Command', ['Op Commander', 'Comms']), group('Alpha', ['Squad Lead', 'Rifleman', 'Rifleman']), group('Wing', ['Flight Lead', 'Pilot'])];
  const freqs = assignAllLeaderRoles(ensureLeadershipFrequency([]), groups);
  eq(freqs[0].role_refs, [{ group_index: 0, role_index: 0 }, { group_index: 1, role_index: 0 }, { group_index: 2, role_index: 0 }], 'refs');
});

test('removing a role drops its refs and shifts later roles of the same group only', () => {
  const freqs = [{ name: 'X', role_refs: [{ group_index: 0, role_index: 0 }, { group_index: 0, role_index: 1 }, { group_index: 0, role_index: 2 }, { group_index: 1, role_index: 2 }] }];
  eq(removeRoleFromFrequencies(freqs, 0, 1)[0].role_refs,
    [{ group_index: 0, role_index: 0 }, { group_index: 0, role_index: 1 }, { group_index: 1, role_index: 2 }], 'refs');
});

test('load → save round-trips is_leadership and the role refs', () => {
  const data = {
    groups: [
      { id: 'g1', name: 'Command', roles: [{ id: 'r1', name: 'Op Commander' }] },
      { id: 'g2', name: 'Alpha', parent_group_id: 'g1', roles: [{ id: 'r2', name: 'Squad Lead' }, { id: 'r3', name: 'Rifleman' }] },
    ],
    frequencies: [
      { id: 'f1', name: 'LEADERSHIP', is_leadership: true, role_refs: [{ gi: 0, ri: 0 }, { gi: 1, ri: 0 }] },
      { id: 'f2', name: 'LOGI', role_refs: [{ gi: 1, ri: 1 }] },
    ],
  };
  const { groups, frequencies } = mapEventGroups(data);
  eq(frequencies.map((f) => f.is_leadership), [true, false], 'mapped flags');
  const payload = buildEventGroupsPayload(groups, frequencies);
  eq(payload.frequencies, [
    { id: 'f1', name: 'LEADERSHIP', is_leadership: true, role_refs: [{ group_index: 0, role_index: 0 }, { group_index: 1, role_index: 0 }] },
    { id: 'f2', name: 'LOGI', is_leadership: false, role_refs: [{ group_index: 1, role_index: 1 }] },
  ], 'payload');
});

test('save payload remaps Leadership refs when groups are re-sorted parent-first', () => {
  // Child listed before its parent locally → payload puts the parent first.
  const groups = [{ ...group('Alpha', ['Squad Lead']), parent_index: 1 }, group('Command', ['Commander'])];
  const freqs = assignAllLeaderRoles(ensureLeadershipFrequency([]), groups);
  const payload = buildEventGroupsPayload(groups, freqs);
  eq(payload.groups.map((g) => g.name), ['Command', 'Alpha'], 'order');
  eq(payload.frequencies[0], {
    id: null, name: LEADERSHIP_FREQ_NAME, is_leadership: true,
    role_refs: [{ group_index: 1, role_index: 0 }, { group_index: 0, role_index: 0 }],
  }, 'leadership payload');
});

const { buildVoiceFreqs, buildEngineState } = await import('../src/engine/bridge.js');

test('strip transmit chips: group first, Leadership marked, active + monitored state', () => {
  const voiceChannel = { id: 'g', name: 'ALPHA' };
  const freqs = [{ name: 'LEADERSHIP', channel_id: 'L', is_leadership: true }, { name: 'LOGI', channel_id: 'X' }];
  const out = buildVoiceFreqs({ voiceChannel, freqs, activeFreqIdx: 1, monitorStatus: { g: { connected: true } } });
  eq(out.map((f) => [f.index, f.name, f.kind, f.leadership, f.active, f.listening]), [
    [0, 'ALPHA', 'group', false, false, true],
    [1, 'LEADERSHIP', 'frequency', true, true, true],
    [2, 'LOGI', 'frequency', false, false, false],
  ], 'chips');
  eq(buildVoiceFreqs({ voiceChannel, freqs: [] }), [], 'no frequencies → no chips');
  eq(buildVoiceFreqs({ voiceChannel, freqs, activeFreqIdx: 9 }).find((f) => f.active).index, 2, 'clamped');
  const st = buildEngineState({ inComms: true, voiceChannel, voiceStatus: 'connected', freqs, activeFreqIdx: 0 });
  eq(st.voice.freqs.length, 3, 'engine state carries the chips');
  eq(buildEngineState({ inComms: false, freqs }).voice.freqs, [], 'none outside voice');
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
