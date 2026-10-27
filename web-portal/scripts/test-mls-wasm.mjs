// End-to-end test of src/mlsSession.js against the REAL mls-crypto WASM
// (web-portal/mls-crypto/pkg) and an in-memory fake of the identity server's
// MLS endpoints (same rules as mlsGroupController.ts: one commit per epoch,
// commit log, GroupInfo stored with each commit and served only when
// current). Several simulated devices, each its own module instance:
//
//   external join          a device that was never added joins by itself
//   epoch-ahead buffering  a message that outran its commit decrypts after
//                          the automatic catch-up
//   past-epoch decrypt     a message from just before a commit still decrypts
//   resync after divergence  a device that can't reach the server epoch
//                          re-joins by external commit (old leaf replaced)
//   heal / force resync    healOrgEncryption results, onGroupStateChange
//
//   node scripts/test-mls-wasm.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', 'mls-crypto', 'pkg');
const sessionPath = join(here, '..', 'src', 'mlsSession.js');

// ── Load the real WASM synchronously (Node has no fetch for file: URLs) ────
const workDir = mkdtempSync(join(tmpdir(), 'mls-wasm-test-'));
const shim = join(workDir, 'mls-crypto-shim.mjs');
writeFileSync(shim, `import * as m from ${JSON.stringify(pathToFileURL(join(pkgDir, 'mls_crypto.js')).href)};
import { readFileSync } from 'node:fs';
let ready = false;
export default async function init() {
  if (!ready) { m.initSync({ module: readFileSync(${JSON.stringify(join(pkgDir, 'mls_crypto_bg.wasm'))}) }); ready = true; }
}
export * from ${JSON.stringify(pathToFileURL(join(pkgDir, 'mls_crypto.js')).href)};
`);
const src = readFileSync(sessionPath, 'utf8').replace(/from\s+'mls-crypto'/, `from ${JSON.stringify(pathToFileURL(shim).href)}`);
const modFile = join(workDir, 'mlsSession.under-test.mjs');
writeFileSync(modFile, src);
let instance = 0;
const freshModule = () => import(`${pathToFileURL(modFile).href}?i=${++instance}`);

// Browser-mode session (no Tauri): identity lives in memory per module instance.
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const realLog = console.log;
const quiet = process.env.MLS_TEST_VERBOSE ? null : (...a) => { if (!String(a[0]).startsWith('[mls]')) realLog(...a); };
if (quiet) { console.log = quiet; console.warn = quiet; console.error = quiet; }

// ── Fake identity server ─────────────────────────────────────────────────
const ORG = 'org-1';
function makeServer() {
  const srv = {
    groups: {},   // gid -> { epoch, log: [{ epoch, commit, welcome, welcomed }], groupInfo, groupInfoEpoch }
    devices: {},  // userId -> [{ device_id, key_package }]
    members: new Set(),
    channels: ['chan-1'],
    subscribers: [], // { userId, deliver(gid, commitB64), live: boolean }
    statusReports: [],
    externalCommits: 0,
  };
  const ok = (data) => ({ data, error: null });
  const conflict = () => ({ data: null, error: 'Epoch conflict — this commit no longer targets the current epoch' });
  const group = (gid) => (srv.groups[gid] ??= { epoch: 0, log: [], groupInfo: null, groupInfoEpoch: null });
  srv.accept = (gid, epoch, commit, welcome, welcomed, groupInfo) => {
    const g = group(gid);
    if (g.epoch !== epoch - 1) return false;
    g.epoch = epoch;
    g.log.push({ epoch, commit, welcome, welcomed: welcomed ?? [] });
    if (groupInfo) { g.groupInfo = groupInfo; g.groupInfoEpoch = epoch; }
    for (const s of srv.subscribers) if (s.live) s.deliver(gid, commit);
    return true;
  };
  srv.apiFor = (userId) => ({
    async registerMlsDevice(deviceId, kp) {
      srv.members.add(userId);
      (srv.devices[userId] ??= []).push({ device_id: deviceId, key_package: kp });
      return { data: {}, error: null, code: null };
    },
    async getUserDeviceKeyPackages(uid) { return ok({ devices: srv.devices[uid] ?? [] }); },
    async getOrgMembers() { return ok({ members: [...srv.members].map((user_id) => ({ user_id })) }); },
    async getChannelMlsMembers() { return ok({ scope: 'org', user_ids: [...srv.members] }); },
    async getChannels() { return ok({ channels: srv.channels.map((id) => ({ id })) }); },
    async getOrgEvents() { return ok({ events: [] }); },
    async getChannelMlsCatchUp(_org, chan) {
      const g = srv.groups[chan];
      if (!g) return ok({ welcome: null, commits: [], current_epoch: 0, group_info_epoch: null });
      const w = g.log.find((e) => e.welcome && e.welcomed.includes(userId));
      return ok({
        welcome: w ? { epoch: w.epoch, welcome: w.welcome } : null,
        commits: g.log.map((e) => ({ epoch: e.epoch, commit: e.commit })),
        current_epoch: g.epoch,
        group_info_epoch: g.groupInfoEpoch,
      });
    },
    async submitChannelMlsCommit(_org, chan, epoch, commit, welcome, welcomed, groupInfo) {
      return srv.accept(chan, epoch, commit, welcome, welcomed, groupInfo) ? ok({ ok: true }) : conflict();
    },
    async getChannelMlsGroupInfo(_org, chan) {
      const g = srv.groups[chan];
      if (!g || g.epoch === 0) return ok({ exists: false, epoch: 0, group_info: null });
      return ok({ exists: true, epoch: g.epoch, group_info: g.groupInfoEpoch === g.epoch ? g.groupInfo : null, group_info_epoch: g.groupInfoEpoch });
    },
    async putChannelMlsGroupInfo(_org, chan, epoch, groupInfo) {
      const g = srv.groups[chan];
      if (!g || g.epoch !== epoch) return conflict();
      g.groupInfo = groupInfo; g.groupInfoEpoch = epoch;
      return ok({ ok: true });
    },
    async submitChannelMlsExternalCommit(_org, chan, epoch, commit, groupInfo) {
      if (!srv.accept(chan, epoch, commit, null, [], groupInfo)) return conflict();
      srv.externalCommits += 1;
      return ok({ ok: true });
    },
    async reportMlsDeviceStatus(deviceId, groups) { srv.statusReports.push({ userId, deviceId, groups }); return ok({ ok: true }); },
  });
  return srv;
}

async function makeDevice(srv, userId, { live = true } = {}) {
  const m = await freshModule();
  const api = srv.apiFor(userId);
  await m.ensureIdentity(api, userId);
  const dev = { userId, m, api, changes: [] };
  m.onGroupStateChange((gid, info) => dev.changes.push({ gid, ...info }));
  const sub = { userId, live, deliver: (gid, commit) => { m.handleChannelCommit(api, userId, gid, commit).catch(() => {}); } };
  srv.subscribers.push(sub);
  dev.sub = sub;
  return dev;
}

// ── Tiny runner ───────────────────────────────────────────────────────────
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    realLog(`ok   - ${name}`);
  } catch (err) {
    results.push([name, false]);
    realLog(`FAIL - ${name}\n       ${err.stack || err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function expectReason(p, reason) {
  try { await p; } catch (err) {
    assert(err.name === 'MlsDecryptError', `expected MlsDecryptError, got ${err.name}: ${err.message}`);
    assert(err.reason === reason, `expected reason ${reason}, got ${err.reason} (${err.message})`);
    return err;
  }
  throw new Error(`expected a ${reason} failure, but it decrypted`);
}
const CH = 'chan-1';

await test('external join: a device nobody added joins by itself; everyone reads it', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH); // genesis, welcomes bob
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, CH);       // joins from the welcome
  assert(srv.groups[CH].epoch === 1, `server epoch ${srv.groups[CH].epoch}`);
  assert(srv.groups[CH].groupInfoEpoch === 1, 'genesis commit did not upload its GroupInfo');
  assert(bob.m.groupEpoch(CH) === 1, `bob epoch ${bob.m.groupEpoch(CH)}`);

  // Carol registers afterwards; with live delivery off for everyone, nobody
  // reconciles her in — she must get in on her own.
  for (const s of srv.subscribers) s.live = false;
  const carol = await makeDevice(srv, 'carol', { live: false });
  srv.members.add('carol');
  srv.groups[CH].log = srv.groups[CH].log; // (no welcome for carol exists)
  await carol.m.ensureChannelGroup(carol.api, 'carol', ORG, CH);
  assert(srv.externalCommits === 1, `external commits ${srv.externalCommits}`);
  assert(carol.m.groupEpoch(CH) === 2, `carol epoch ${carol.m.groupEpoch(CH)}`);
  await settle(); // listeners run on a later tick, outside the state lock
  assert(carol.changes.some((c) => c.gid === CH), 'carol got no onGroupStateChange');

  // Epoch-ahead buffering: bob is still at epoch 1 (missed the live commit);
  // carol's epoch-2 message makes him catch up and then decrypts.
  const ct = await carol.m.encryptChannel(carol.api, 'carol', CH, 'hi from carol');
  assert(bob.m.groupEpoch(CH) === 1, 'bob should still be behind');
  assert(await bob.m.decryptChannel(bob.api, 'bob', CH, ct, false) === 'hi from carol', 'bob could not read carol');
  assert(bob.m.groupEpoch(CH) === 2, `bob epoch after catch-up ${bob.m.groupEpoch(CH)}`);
  assert(await alice.m.decryptChannel(alice.api, 'alice', CH, ct, false) === 'hi from carol', 'alice could not read carol');
  const back = await alice.m.encryptChannel(alice.api, 'alice', CH, 'welcome carol');
  assert(await carol.m.decryptChannel(carol.api, 'carol', CH, back, false) === 'welcome carol', 'carol could not read alice');
});

await test('past-epoch decrypt: a message sent just before a commit still decrypts after it', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, CH);
  const late = await alice.m.encryptChannel(alice.api, 'alice', CH, 'sent at epoch 1');
  // Dave joins (epoch 2) and the commit reaches bob before alice's message.
  const dave = await makeDevice(srv, 'dave');
  srv.members.add('dave');
  await dave.m.ensureChannelGroup(dave.api, 'dave', ORG, CH);
  await settle();
  assert(bob.m.groupEpoch(CH) === 2, `bob epoch ${bob.m.groupEpoch(CH)}`);
  assert(await bob.m.decryptChannel(bob.api, 'bob', CH, late, false) === 'sent at epoch 1', 'past-epoch message lost');
  // Dave joined after it was sent: that's a backfill case, typed as such.
  await expectReason(dave.m.decryptChannel(dave.api, 'dave', CH, late, false), 'epoch_too_old');
});

await test('resync after divergence: unreachable server epoch → external resync, old leaf replaced', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, CH);
  bob.sub.live = false;
  // Two more devices join; their commits are then lost from the log (as if
  // bob's copy forked) — bob can't get from epoch 1 to 3.
  for (const u of ['erin', 'frank']) {
    const d = await makeDevice(srv, u);
    srv.members.add(u);
    await d.m.ensureChannelGroup(d.api, u, ORG, CH);
  }
  await settle();
  assert(srv.groups[CH].epoch === 3, `server epoch ${srv.groups[CH].epoch}`);
  srv.groups[CH].log = srv.groups[CH].log.filter((e) => e.epoch < 2);
  const lost = await alice.m.encryptChannel(alice.api, 'alice', CH, 'at epoch 3');

  const r = await bob.m.healOrgEncryption(bob.api, 'bob', ORG);
  assert(r.checked === 1 && r.healed.length === 1 && r.healed[0] === CH && r.failed.length === 0, `heal result ${JSON.stringify(r)}`);
  assert(bob.m.groupEpoch(CH) === 4, `bob epoch ${bob.m.groupEpoch(CH)}`);
  await settle();
  assert(alice.m.groupEpoch(CH) === 4, `alice epoch ${alice.m.groupEpoch(CH)}`);

  // Same five devices: the resync replaced bob's leaf rather than adding one.
  const msg = await alice.m.encryptChannel(alice.api, 'alice', CH, 'bob is back');
  assert(await bob.m.decryptChannel(bob.api, 'bob', CH, msg, false) === 'bob is back', 'bob cannot read after resync');
  const reply = await bob.m.encryptChannel(bob.api, 'bob', CH, 'thanks');
  assert(await alice.m.decryptChannel(alice.api, 'alice', CH, reply, false) === 'thanks', 'alice cannot read bob after resync');
  // What was sent while bob was forked needs a backfill — typed, not lost silently.
  await expectReason(bob.m.decryptChannel(bob.api, 'bob', CH, lost, false), 'epoch_too_old');
  assert(srv.statusReports.some((s) => s.userId === 'bob' && s.groups.some((g) => g.group_id === CH && g.status === 'resynced' && g.epoch === 4)),
    'device status not reported');
});

await test('decrypt failures from a forked copy trigger a background heal', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, CH);
  bob.sub.live = false;
  const gina = await makeDevice(srv, 'gina');
  srv.members.add('gina');
  await gina.m.ensureChannelGroup(gina.api, 'gina', ORG, CH);
  srv.groups[CH].log = srv.groups[CH].log.filter((e) => e.epoch < 2); // bob can never apply epoch 2
  const ahead = await alice.m.encryptChannel(alice.api, 'alice', CH, 'epoch 2');
  // The decrypt can't resolve (catch-up can't reach epoch 2) → typed, and a heal is scheduled.
  await expectReason(bob.m.decryptChannel(bob.api, 'bob', CH, ahead, false), 'epoch_ahead_unresolved');
  for (let i = 0; i < 40 && bob.m.groupEpoch(CH) !== 3; i++) await settle(25);
  assert(bob.m.groupEpoch(CH) === 3, `background heal did not resync bob (epoch ${bob.m.groupEpoch(CH)})`);
  assert(bob.changes.some((c) => c.gid === CH), 'no onGroupStateChange for the heal');
  await settle();
  const fresh = await alice.m.encryptChannel(alice.api, 'alice', CH, 'after heal');
  assert(await bob.m.decryptChannel(bob.api, 'bob', CH, fresh, false) === 'after heal', 'bob cannot read after the background heal');
});

await test('force resync of a healthy group; removal is flagged in onGroupStateChange', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, CH);
  const healthy = await bob.m.healOrgEncryption(bob.api, 'bob', ORG);
  assert(healthy.healed.length === 0 && healthy.checked === 1, `healthy heal ${JSON.stringify(healthy)}`);
  const forced = await bob.m.healOrgEncryption(bob.api, 'bob', ORG, { force: true });
  assert(forced.healed.length === 1, `forced heal ${JSON.stringify(forced)}`);
  await settle();
  assert(alice.m.groupEpoch(CH) === 2 && bob.m.groupEpoch(CH) === 2, 'epochs after forced resync');
  assert(alice.changes.some((c) => c.gid === CH && c.removed === false), 'resync of the same device flagged as a removal');

  // Bob leaves the org → alice's reconcile removes him → removed:true.
  srv.members.delete('bob');
  alice.changes.length = 0;
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH);
  await settle();
  assert(alice.changes.some((c) => c.gid === CH && c.removed === true), `removal not flagged: ${JSON.stringify(alice.changes)}`);
});

await test('a stale GroupInfo (old client commit) is re-uploaded by a current member, then joins work', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, CH);
  srv.groups[CH].groupInfo = null; srv.groups[CH].groupInfoEpoch = null; // as if a pre-2.0.1 client committed
  const hank = await makeDevice(srv, 'hank', { live: false });
  srv.members.add('hank');
  for (const s of srv.subscribers) s.live = false;
  // Hank can't join yet (no current GroupInfo) — and must not create a rival group.
  // (Alice/bob's reconcile would add him; skip it by asking hank first.)
  const before = srv.groups[CH].epoch;
  const hankFirst = await hank.m.healOrgEncryption(hank.api, 'hank', ORG);
  assert(hankFirst.failed[0]?.reason === 'group_info_unavailable', `hank first heal ${JSON.stringify(hankFirst)}`);
  assert(srv.groups[CH].epoch === before, 'hank committed without a GroupInfo');
  await bob.m.syncChannelGroupEpoch(bob.api, 'bob', ORG, CH); // a member catches up → re-uploads
  assert(srv.groups[CH].groupInfoEpoch === srv.groups[CH].epoch, 'GroupInfo not re-uploaded');
  const hankSecond = await hank.m.healOrgEncryption(hank.api, 'hank', ORG);
  assert(hankSecond.healed[0] === CH, `hank second heal ${JSON.stringify(hankSecond)}`);
});

await test('account switch: caches reset, the other account gets its own identity and device id', async () => {
  const srv = makeServer();
  const m = await freshModule();
  const apiA = srv.apiFor('acct-a');
  const apiB = srv.apiFor('acct-b');
  await m.ensureIdentity(apiA, 'acct-a');
  const bob = await makeDevice(srv, 'acct-c');
  await m.ensureChannelGroup(apiA, 'acct-a', ORG, CH);
  assert(m.groupEpoch(CH) === 1, 'acct-a not in the group');
  m.notePendingSent(CH, 'secret draft');
  await m.ensureIdentity(apiB, 'acct-b'); // different user → automatic reset
  assert(m.groupEpoch(CH) === null, 'acct-b sees acct-a\'s group state');
  const devA = srv.devices['acct-a'][0].device_id;
  const devB = srv.devices['acct-b'][0].device_id;
  assert(devA !== devB, 'both accounts registered the same device id');
  assert(localStorage.getItem('specter_mls_device_id:acct-a') === devA && localStorage.getItem('specter_mls_device_id:acct-b') === devB, 'device ids not per account');
  void bob;
});

rmSync(workDir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok).length;
realLog(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
