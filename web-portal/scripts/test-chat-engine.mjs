// MR2: the channel-chat delivery engine (src/engine/useChannelChat.js) end to
// end against in-memory stubs (scripts/chat-engine-stubs): live relays for
// any channel, pending rows retried on group change, re-encrypted backfill
// answers, dedupe/merge of a peer's bundle, self-skip.
// Run: node scripts/test-chat-engine.mjs
import { register } from 'node:module';
import assert from 'node:assert/strict';

register('./chat-engine-stubs/hooks.mjs', import.meta.url);

const { __chatEngineForTests: E } = await import('../src/engine/useChannelChat.js');
const store = await import('./chat-engine-stubs/messageStore.mjs');
const mls = await import('./chat-engine-stubs/mlsSession.mjs');
const apiStub = await import('./chat-engine-stubs/api.mjs');

Math.random = () => 0; // no responder jitter in tests
const settle = async () => {
  for (let i = 0; i < 20; i++) { await E.idle(); await new Promise((r) => setTimeout(r, 2)); }
};

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed += 1; } catch (err) { console.error(`FAIL ${name}`); throw err; }
};
const ts = (i) => new Date(Date.UTC(2026, 9, 25, 12, 0, i)).toISOString();

const ME = 'me';
const ORG = 'org1';
const CH = 'chan-a';
const OTHER = 'chan-b';
E.setUser({ id: ME, callsign: 'Me' });
E.setOrgReady(ORG);
// What the mounted hook does (its useEffect isn't run without React).
mls.onGroupStateChange(E.onGroupChanged);

await test('relay for a channel that is NOT open is decrypted and stored', async () => {
  mls.giveKey(OTHER, 1);
  E.handleRelay({ id: 'r1', channel_id: OTHER, org_id: ORG, sender_id: 'u2', callsign: 'Nova', encrypted_content: 'enc:1:hello', timestamp: ts(1) });
  await settle();
  assert.equal(store.rows.get('r1').plaintext, 'hello');
  assert.equal(store.rows.get('r1').pending, false);
});

await test('DM relays are ignored', async () => {
  E.handleRelay({ id: 'dm1', channel_id: OTHER, context: 'dm', sender_id: 'u2', encrypted_content: 'enc:1:x', timestamp: ts(2) });
  await settle();
  assert.equal(store.rows.has('dm1'), false);
});

await test('undecryptable relay is stored pending (never lost) and retried on group change', async () => {
  mls.giveKey(CH, 1);
  let notified = 0;
  const unsub = E.subscribeChannel(CH, () => { notified += 1; });
  E.handleRelay({ id: 'p1', channel_id: CH, org_id: ORG, sender_id: 'u2', encrypted_content: 'enc:2:later', timestamp: ts(3) });
  await settle();
  const pending = store.rows.get('p1');
  assert.equal(pending.plaintext, null);
  assert.equal(pending.pending, true);
  assert.equal(pending.fail_reason, 'epoch_ahead_unresolved');
  assert.equal(pending.encrypted_content, 'enc:2:later');
  // The group moves to epoch 2 (a commit / heal) → onGroupStateChange → retry.
  E.onGroupChanged(CH); // what mlsSession's listener would call...
  mls.giveKey(CH, 2);   // ...and the stub's own listener fires too (coalesced)
  await settle();
  assert.equal(store.rows.get('p1').plaintext, 'later');
  assert.equal(store.rows.get('p1').pending, false);
  assert.ok(notified >= 2);
  unsub();
});

await test('epoch_too_old rows wait for a backfill, which replaces them; a catch-up is asked for', async () => {
  apiStub.calls.length = 0;
  E.handleRelay({ id: 'old1', channel_id: CH, org_id: ORG, sender_id: 'u2', encrypted_content: 'enc:0:ancient', timestamp: ts(4) });
  await settle();
  assert.equal(store.rows.get('old1').fail_reason, 'epoch_too_old');
  E.onGroupChanged(CH);
  await settle();
  assert.equal(store.rows.get('old1').plaintext, null, 'not retried into a plaintext');
  const ask = apiStub.calls.find((c) => c.fn === 'requestOrgSync');
  assert.ok(ask, 'a follow-up catch-up was requested');
  assert.deepEqual(ask.channels.map((c) => c.channel_id), [CH]);
  assert.ok(ask.channels[0].since < ts(4), 'since covers the unreadable row');

  // A peer answers with a bundle encrypted under the CURRENT epoch.
  const bundle = JSON.stringify({ v: 1, items: [
    { id: 'old1', sender_id: 'u2', callsign: 'Nova', global_tag: null, timestamp: ts(4), text: 'ancient', image_url: null },
    { id: 'p1', sender_id: 'u2', callsign: 'Nova', global_tag: null, timestamp: ts(3), text: 'REWRITTEN', image_url: null },
    { id: 'new9', sender_id: 'u5', callsign: 'Ash', global_tag: null, timestamp: ts(9), text: 'missed', image_url: null },
  ] });
  E.handleSyncResponse({ type: 'sync_response', org_id: ORG, channel_id: CH, relayed_by: 'u7', bundle: `enc:2:${bundle}`, count: 3 });
  // ...and the same bundle again from a second responder (dedupe by id).
  E.handleSyncResponse({ type: 'sync_response', org_id: ORG, channel_id: CH, relayed_by: 'u8', bundle: `enc:2:${bundle} ` });
  await settle();
  assert.equal(store.rows.get('old1').plaintext, 'ancient');
  assert.equal(store.rows.get('old1').relayed_by, 'u7');
  assert.equal(store.rows.get('p1').plaintext, 'later', 'a readable row is never rewritten by a relayer');
  assert.equal(store.rows.get('new9').plaintext, 'missed');
  assert.equal([...store.rows.values()].filter((r) => r.id === 'new9').length, 1);
});

await test('a bundle that cannot be decrypted yet is kept and retried after the group changes', async () => {
  const bundle = JSON.stringify({ v: 1, items: [{ id: 'fut1', sender_id: 'u2', timestamp: ts(20), text: 'from the future' }] });
  E.handleSyncResponse({ org_id: ORG, channel_id: CH, relayed_by: 'u7', bundle: `enc:3:${bundle}` });
  await settle();
  assert.equal(store.rows.has('fut1'), false);
  mls.giveKey(CH, 3);
  await settle();
  assert.equal(store.rows.get('fut1').plaintext, 'from the future');
});

await test('answers an org_sync_request for any channel, re-encrypted under the current epoch, in bundles', async () => {
  apiStub.calls.length = 0;
  E.handleOrgSyncRequest({ type: 'org_sync_request', org_id: ORG, requester_id: 'u9', channels: [
    { channel_id: CH, since: ts(3) },
    { channel_id: OTHER, since: null },
    { channel_id: 'chan-not-member', since: null },
  ] });
  await settle();
  const answers = apiStub.calls.filter((c) => c.fn === 'respondOrgSync');
  assert.deepEqual(answers.map((a) => a.channelId).sort(), [CH, OTHER].sort());
  const a = answers.find((x) => x.channelId === CH);
  assert.equal(a.toUserId, 'u9');
  assert.match(a.bundle, /^enc:3:/, 'encrypted under the current epoch');
  const doc = JSON.parse(a.bundle.replace(/^enc:3:/, ''));
  assert.deepEqual(doc.items.map((i) => i.id), ['old1', 'new9', 'fut1'], 'only readable rows after since, oldest first');
  assert.equal(doc.items[0].sender_id, 'u2');
  assert.equal(a.count, 3);
  assert.ok(!answers.some((x) => x.bundle.includes('"plaintext"')), 'bundle uses the item format');
});

await test('own requests and repeats within the dedupe window are not answered', async () => {
  apiStub.calls.length = 0;
  E.handleOrgSyncRequest({ org_id: ORG, requester_id: ME, channels: [{ channel_id: CH, since: null }] });
  E.handleOrgSyncRequest({ org_id: ORG, requester_id: 'u9', channels: [{ channel_id: CH, since: ts(3) }] });
  await settle();
  assert.equal(apiStub.calls.filter((c) => c.fn === 'respondOrgSync').length, 0);
});

await test('legacy per-channel sync_request is answered with stored ciphertext only', async () => {
  apiStub.calls.length = 0;
  E.handleLegacySyncRequest({ channel_id: CH, org_id: ORG, requester_id: 'u9', since: null });
  await settle();
  const r = apiStub.calls.find((c) => c.fn === 'respondChannelSync');
  assert.ok(r);
  assert.ok(r.messages.every((m) => m.encrypted_content), 'backfilled rows without ciphertext are not offered');
  assert.ok(!r.messages.some((m) => 'plaintext' in m), 'plaintext never leaves');
});

await test('legacy sync_response: readable rows are skipped, failures stored pending', async () => {
  E.handleSyncResponse({ channel_id: CH, messages: [
    { id: 'p1', sender_id: 'u2', encrypted_content: 'enc:2:later', timestamp: ts(3) },
    { id: 'leg1', sender_id: 'u2', encrypted_content: 'enc:1:legacy ok', timestamp: ts(30) },
    { id: 'leg2', sender_id: 'u2', encrypted_content: 'garbage', timestamp: ts(31) },
  ] });
  await settle();
  assert.equal(store.rows.get('p1').plaintext, 'later');
  assert.equal(store.rows.get('leg1').plaintext, 'legacy ok');
  assert.equal(store.rows.get('leg2').pending, true);
  assert.equal(store.rows.get('leg2').fail_reason, 'corrupt');
});

// ── DMs (same rules) ─────────────────────────────────────────────────────
const PARTNER = 'u2';
const CONV = 'me-u2'; // [ME, PARTNER].sort().join('-')

await test('DM relay is stored whether or not the DM is open; pending until the key arrives', async () => {
  const msg = { id: 'd1', conversation_id: CONV, sender_id: PARTNER, to_user_id: ME, callsign: 'Nova', encrypted_content: 'enc:1:hi there', timestamp: ts(50) };
  E.handleDmRelay({ type: 'message_relay', context: 'dm', partner_id: PARTNER, message: msg });
  await settle();
  assert.equal(store.dmRows.get('d1').pending, true);
  assert.equal(store.dmRows.get('d1').fail_reason, 'not_member');
  mls.giveKey(CONV, 1); // welcome processed → onGroupStateChange(CONV) → DM retry
  await settle();
  assert.equal(store.dmRows.get('d1').plaintext, 'hi there');
  // a DM of someone else's conversation is ignored
  E.handleDmRelay({ context: 'dm', partner_id: 'zz', message: { ...msg, id: 'd-x', conversation_id: 'u2-zz' } });
  await settle();
  assert.equal(store.dmRows.has('d-x'), false);
});

await test('DM catch-up request, answer re-encrypted as a bundle, merge on the requester', async () => {
  apiStub.calls.length = 0;
  await E.requestDmCatchUp(PARTNER);
  const req = apiStub.calls.find((c) => c.fn === 'requestDmSync');
  assert.equal(req.userId, PARTNER);
  assert.equal(req.since, ts(50));

  // The partner asks me: answered with a bundle under my current epoch.
  E.handleDmSyncRequest({ type: 'dm_sync_request', conversation_id: CONV, requester_id: PARTNER, since: null });
  E.handleDmSyncRequest({ type: 'dm_sync_request', conversation_id: CONV, requester_id: ME, since: null }); // own: skipped
  E.handleDmSyncRequest({ type: 'dm_sync_request', conversation_id: 'u2-zz', requester_id: 'zz', since: null }); // not mine
  await settle();
  const answers = apiStub.calls.filter((c) => c.fn === 'respondDmSyncBundle');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].userId, PARTNER);
  assert.match(answers[0].bundle, /^enc:1:/);
  assert.deepEqual(JSON.parse(answers[0].bundle.slice(6)).items.map((i) => i.id), ['d1']);

  // The partner's answer to me: only accepted from the partner.
  const bundle = JSON.stringify({ v: 1, items: [
    { id: 'd0', sender_id: ME, timestamp: ts(45), text: 'my older one' },
    { id: 'd2', sender_id: PARTNER, timestamp: ts(55), text: 'you missed this' },
    { id: 'dz', sender_id: 'zz', timestamp: ts(56), text: 'third party' },
  ] });
  E.handleDmSyncResponse({ type: 'dm_sync_response', conversation_id: CONV, relayed_by: 'zz', bundle: `enc:1:${bundle}` });
  await settle();
  assert.equal(store.dmRows.has('d2'), false, 'not from the partner: ignored');
  E.handleDmSyncResponse({ type: 'dm_sync_response', conversation_id: CONV, relayed_by: PARTNER, bundle: `enc:1:${bundle}`, count: 3 });
  await settle();
  assert.equal(store.dmRows.get('d2').plaintext, 'you missed this');
  assert.equal(store.dmRows.get('d2').to_user_id, ME);
  assert.equal(store.dmRows.get('d0').to_user_id, PARTNER);
  assert.equal(store.dmRows.has('dz'), false, 'senders outside the conversation are dropped');
});

await test('account switch: handlers stop acting for the old account', async () => {
  E.setUser(null);
  E.handleRelay({ id: 'after', channel_id: CH, sender_id: 'u2', encrypted_content: 'enc:3:x', timestamp: ts(40) });
  await settle();
  assert.equal(store.rows.has('after'), false);
});

console.log(`chat engine: ${passed} tests passed`);
