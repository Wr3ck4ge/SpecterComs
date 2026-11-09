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
    audience: {}, // chan -> Set(userId): event channels only
    events: [],
    assignments: {}, // eventId -> my-assignment body
    registrations: [],
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
      // ON CONFLICT (id) DO UPDATE, like registerDevice: a re-registration
      // replaces the device's KeyPackage.
      const rows = (srv.devices[userId] ??= []);
      const row = rows.find((d) => d.device_id === deviceId);
      if (row) row.key_package = kp;
      else rows.push({ device_id: deviceId, key_package: kp });
      srv.registrations.push({ userId, deviceId });
      return { data: {}, error: null, code: null };
    },
    async getUserDeviceKeyPackages(uid) { return ok({ devices: srv.devices[uid] ?? [] }); },
    async getOrgMembers() { return ok({ members: [...srv.members].map((user_id) => ({ user_id })) }); },
    // An event channel's audience (srv.audience[chan]); otherwise the org.
    async getChannelMlsMembers(_org, chan) {
      const event = srv.audience[chan];
      return ok({ scope: event ? 'event' : 'org', user_ids: event ? [...event] : [...srv.members] });
    },
    async getChannels() { return ok({ channels: srv.channels.map((id) => ({ id })) }); },
    async getOrgEvents() { return ok({ events: srv.events }); },
    async getMyEventAssignment(_org, eventId) { return ok(srv.assignments[eventId] ?? { assignment: null, assignments: [] }); },
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
    realLog(`FAIL - ${name}\n       ${err?.stack || err?.message || err}`); // WASM throws bare strings
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

// ── "Waiting for channel key": fresh event channels ───────────────────────
const EV_CH = 'event-group-chan';
const DAY_MS = 24 * 60 * 60_000;
const realNow = Date.now;
/** Runs fn with the clock `days` ahead — the WASM's lifetime checks read it too. */
async function withClockAhead(days, fn) {
  Date.now = () => realNow() + days * DAY_MS;
  try { return await fn(); } finally { Date.now = realNow; }
}
const audioKey = (dev, gid = EV_CH) => dev.m.exportGroupSecret(dev.api, dev.userId, gid, 'audio', 32).then((k) => Buffer.from(k).toString('hex'));
async function sameKey(devs, gid = EV_CH) {
  for (const d of devs) await d.m.syncChannelGroupEpoch(d.api, d.userId, ORG, gid);
  const keys = await Promise.all(devs.map((d) => audioKey(d, gid)));
  assert(new Set(keys).size === 1, `members disagree on the key: ${devs.map((d) => `${d.userId}@${d.m.groupEpoch(gid)}`)}`);
}

await test('fresh event channel: an audience device with an expired KeyPackage does not block the group', async () => {
  const srv = makeServer();
  const stale = await makeDevice(srv, 'stale');           // never refreshed its KeyPackage
  await withClockAhead(85, async () => {
    const alice = await makeDevice(srv, 'alice');
    const bob = await makeDevice(srv, 'bob');
    srv.audience[EV_CH] = new Set(['alice', 'bob', 'stale']);
    await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
    await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH);
    await sameKey([alice, bob]);
    // The stale device isn't lost: it joins by itself once it comes online.
    await stale.m.ensureChannelGroup(stale.api, 'stale', ORG, EV_CH);
    await sameKey([alice, bob, stale]);
  });
});

await test('fresh event channel: the only member with a usable device still gets a key; the next joins it', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  srv.audience[EV_CH] = new Set(['alice', 'bob']);        // bob signed up, no device yet
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
  assert(srv.groups[EV_CH]?.epoch === 1, `no group on the server: ${JSON.stringify(srv.groups[EV_CH]?.epoch)}`);
  await audioKey(alice);
  const bob = await makeDevice(srv, 'bob');
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH);
  await sameKey([alice, bob]);
});

await test('fresh event channel: two members joining at once both get the same key', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  srv.audience[EV_CH] = new Set(['alice', 'bob']);
  await Promise.all([
    alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH),
    bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH),
  ]);
  await sameKey([alice, bob]);
});

await test('fresh event channel: a device whose KeyPackage already served a Welcome still gets in', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, CH); // uses up bob's KeyPackage
  srv.audience[EV_CH] = new Set(['alice', 'bob']);
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH);
  await sameKey([alice, bob]);
});

await test('many members joining at once all converge', async () => {
  const srv = makeServer();
  const devs = [];
  for (const u of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) devs.push(await makeDevice(srv, u));
  srv.audience[EV_CH] = new Set(devs.map((d) => d.userId));
  await Promise.all(devs.map((d) => d.m.ensureChannelGroup(d.api, d.userId, ORG, EV_CH)));
  // Anyone who lost every race retries from CommLink's keyless loop.
  for (const d of devs) if (d.m.groupEpoch(EV_CH) === null) await d.m.ensureChannelGroup(d.api, d.userId, ORG, EV_CH);
  await sameKey(devs);
});

await test('a member removed by an audience change and let back in recovers its key by itself', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  srv.audience[EV_CH] = new Set(['alice', 'bob']);
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH);
  srv.audience[EV_CH] = new Set(['alice']);
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
  await settle();
  let err = null;
  await audioKey(bob).catch((e) => { err = e; });
  assert(err, 'a removed device could still export a key');
  srv.audience[EV_CH] = new Set(['alice', 'bob']);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH);
  await sameKey([alice, bob]);
});

await test('an unusable KeyPackage cannot cost a member who holds the group its key', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  srv.audience[EV_CH] = new Set(['alice', 'bob']);
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH);
  srv.devices.mallory = [{ device_id: 'dead', key_package: Buffer.from('not a key package').toString('base64') }];
  srv.audience[EV_CH].add('mallory');
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH); // threw before
  await sameKey([alice, bob]);
});

await test('an old device republishes its KeyPackage instead of going stale', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const before = srv.devices.alice[0].key_package;
  await withClockAhead(85, async () => {
    await alice.m.ensureIdentity(alice.api, 'alice');
    await settle();
    assert(srv.devices.alice.length === 1, `device rows ${srv.devices.alice.length}`);
    assert(srv.devices.alice[0].key_package !== before, 'KeyPackage not refreshed');
    // Bob can add alice again, and her Welcome is usable.
    const bob = await makeDevice(srv, 'bob');
    srv.audience[EV_CH] = new Set(['alice', 'bob']);
    await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH);
    assert(srv.groups[EV_CH].log[0].welcomed.includes('alice'), 'alice was not added at genesis');
    await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
    assert(srv.externalCommits === 0, 'alice needed an external commit despite a fresh KeyPackage');
    await sameKey([alice, bob]);
  });
});

await test('a consumed KeyPackage is replaced right after the Welcome', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  const before = srv.devices.bob[0].key_package;
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, CH);
  await settle();
  assert(srv.devices.bob[0].key_package !== before, 'the used KeyPackage is still published');
  srv.audience[EV_CH] = new Set(['alice', 'bob']);
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
  await bob.m.ensureChannelGroup(bob.api, 'bob', ORG, EV_CH);
  assert(srv.externalCommits === 0, 'second Welcome was not usable');
  await sameKey([alice, bob]);
});

await test('org heal also repairs frequency channels, which the channel list hides', async () => {
  const srv = makeServer();
  const FREQ = 'freq-chan';
  const alice = await makeDevice(srv, 'alice');
  const bob = await makeDevice(srv, 'bob');
  srv.audience[FREQ] = new Set(['alice']);
  await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, FREQ);
  srv.audience[FREQ].add('bob'); // bob's role was added after the group existed
  srv.events = [{ id: 'ev-1', launched: true }];
  srv.assignments['ev-1'] = { assignment: null, frequencies: [{ channel_id: FREQ }] }; // shape of GET …/my-assignment
  srv.apiFor = ((orig) => (u) => ({ ...orig(u), getEventGroupMlsCatchUp: async () => ({ data: { welcome: null, commits: [], current_epoch: 0 }, error: null }), getEventParticipants: async () => ({ data: { participants: [] }, error: null }) }))(srv.apiFor);
  const api = srv.apiFor('bob');
  const r = await bob.m.healOrgEncryption(api, 'bob', ORG);
  assert(r.healed.includes(FREQ), `heal result ${JSON.stringify(r)}`);
  await sameKey([alice, bob], FREQ);
});

await test('ensureChannelGroup says why a device is keyless', async () => {
  const srv = makeServer();
  const alice = await makeDevice(srv, 'alice');
  srv.audience[EV_CH] = new Set(['someone-else']);
  const r = await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
  assert(r?.held === false && r?.reason === 'not_on_list', `result ${JSON.stringify(r)}`);
  srv.audience[EV_CH] = new Set(['alice']);
  const ok = await alice.m.ensureChannelGroup(alice.api, 'alice', ORG, EV_CH);
  assert(ok?.held === true, `result ${JSON.stringify(ok)}`);
});

rmSync(workDir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok).length;
realLog(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
