// Deterministic concurrency test for src/mlsSession.js's device-state lock,
// persistence writer and own-commit flow.
//
//   node scripts/test-mls-session-queue.mjs
//   MLS_SESSION_PATH=/path/to/other/mlsSession.js node scripts/test-mls-session-queue.mjs
//
// The real mls-crypto WASM can't be driven into the interesting
// interleavings deterministically (or without a live server), so this swaps
// it for a stub with the SAME shape — every mutating call is
// `newBlob = f(oldBlob, …)` over one whole-device blob — and records every
// effect (consumed message keys, epochs) inside the blob. A lost update shows
// up as a missing effect. Network/IPC calls are fake and resolve after
// seeded-random delays so operations genuinely interleave.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sessionPath = process.env.MLS_SESSION_PATH ?? join(here, '..', 'src', 'mlsSession.js');

// ── Seeded PRNG + helpers ──────────────────────────────────────────────────
let seed = 0x5eed;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const delay = (maxMs) => new Promise((r) => setTimeout(r, Math.floor(rand() * maxMs)));
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b) => JSON.parse(new TextDecoder().decode(b));
const gidStr = (g) => new TextDecoder().decode(g);

// ── Stub mls-crypto ────────────────────────────────────────────────────────
const stubCalls = { generate_identity: 0 };
const stub = {
  default: async () => {},
  generate_identity(label) {
    stubCalls.generate_identity++;
    return { device_state: enc({ self: label, groups: {} }), key_package: enc({ label }) };
  },
  group_exists: (s, g) => !!dec(s).groups[gidStr(g)],
  group_epoch(s, g) {
    const grp = dec(s).groups[gidStr(g)];
    if (!grp) throw new Error('group not found');
    return BigInt(grp.epoch);
  },
  group_member_labels(s, g) {
    const grp = dec(s).groups[gidStr(g)];
    if (!grp) throw new Error('group not found');
    return [...grp.members];
  },
  create_group(s, g) {
    const st = dec(s);
    st.groups[gidStr(g)] = { epoch: 0, members: [st.self], consumed: [], sent: 0 };
    return enc(st);
  },
  frame_key_packages: (kps) => enc(kps.map((k) => dec(k).label)),
  add_member(s, g, framed) {
    const st = dec(s);
    const grp = st.groups[gidStr(g)];
    const labels = dec(framed);
    const commit = enc({ gid: gidStr(g), from: grp.epoch, to: grp.epoch + 1, author: st.self, add: labels, nonce: rand() });
    grp.epoch += 1;
    grp.members.push(...labels);
    const welcome = enc({ gid: gidStr(g), epoch: grp.epoch, members: [...grp.members] });
    return { device_state: enc(st), commit, welcome };
  },
  remove_member(s, g, labels) {
    const st = dec(s);
    const grp = st.groups[gidStr(g)];
    const commit = enc({ gid: gidStr(g), from: grp.epoch, to: grp.epoch + 1, author: st.self, remove: labels, nonce: rand() });
    grp.epoch += 1;
    grp.members = grp.members.filter((m) => !labels.includes(m));
    return { device_state: enc(st), commit, welcome: new Uint8Array(0) };
  },
  join_from_welcome(s, w) {
    const st = dec(s);
    const wel = dec(w);
    if (!wel.members.includes(st.self)) throw new Error('welcome not for us');
    st.groups[wel.gid] = { epoch: wel.epoch, members: wel.members, consumed: [], sent: 0 };
    return enc(st);
  },
  process_commit(s, g, c) {
    const st = dec(s);
    const grp = st.groups[gidStr(g)];
    const cm = dec(c);
    if (cm.author === st.self) throw new Error('cannot process own commit');
    if (cm.from !== grp.epoch) throw new Error(`wrong epoch ${cm.from} != ${grp.epoch}`);
    grp.epoch = cm.to;
    if (cm.add) grp.members.push(...cm.add);
    if (cm.remove) grp.members = grp.members.filter((m) => !cm.remove.includes(m));
    return enc(st);
  },
  encrypt(s, g, pt) {
    const st = dec(s);
    const grp = st.groups[gidStr(g)];
    grp.sent += 1;
    return { device_state: enc(st), ciphertext: enc({ epoch: grp.epoch, sender: st.self, gen: grp.sent, pt: new TextDecoder().decode(pt) }) };
  },
  decrypt(s, g, c) {
    const st = dec(s);
    const grp = st.groups[gidStr(g)];
    if (!grp) throw new Error('group not found');
    const ct = dec(c);
    if (ct.sender === st.self) throw new Error('own message');
    if (ct.epoch !== grp.epoch) throw new Error(`epoch mismatch ${ct.epoch} != ${grp.epoch}`);
    const key = `${ct.sender}:${ct.epoch}:${ct.gen}`;
    if (grp.consumed.includes(key)) throw new Error('generation already consumed');
    grp.consumed.push(key);
    return { device_state: enc(st), plaintext: new TextEncoder().encode(ct.pt) };
  },
  export_secret: (s, g) => enc(`${gidStr(g)}:${dec(s).groups[gidStr(g)].epoch}`),
  // MR1 additions (the real behaviour is covered by test-mls-wasm.mjs).
  device_credential: (s) => dec(s).self,
  message_epoch(m) {
    const o = dec(m);
    return BigInt(o.epoch ?? o.from);
  },
  export_group_info: (s, g) => enc({ gid: gidStr(g), epoch: dec(s).groups[gidStr(g)].epoch }),
  join_external() { throw new Error('stub: no external join'); },
  resync_external() { throw new Error('stub: no external join'); },
  sign_bytes: () => new Uint8Array([1]),
  own_public_key: () => new Uint8Array([2]),
  verify_bytes: () => true,
};
globalThis.__mlsStub = stub;

// ── Load the module under test with 'mls-crypto' pointed at the stub ──────
const workDir = mkdtempSync(join(tmpdir(), 'mls-session-test-'));
const stubFile = join(workDir, 'mls-crypto-stub.mjs');
writeFileSync(stubFile, `const s = globalThis.__mlsStub;
export default s.default;
export const { generate_identity, group_exists, group_epoch, group_member_labels, create_group, add_member,
  remove_member, join_from_welcome, process_commit, encrypt, decrypt, export_secret, frame_key_packages,
  sign_bytes, own_public_key, verify_bytes, device_credential, message_epoch, export_group_info,
  join_external, resync_external } = s;\n`);
const src = readFileSync(sessionPath, 'utf8').replace(/from\s+'mls-crypto'/, `from ${JSON.stringify(pathToFileURL(stubFile).href)}`);
const modFile = join(workDir, 'mlsSession.under-test.mjs');
writeFileSync(modFile, src);
let instance = 0;
const freshModule = () => import(`${pathToFileURL(modFile).href}?i=${++instance}`);

// ── Fake environment: Tauri IPC (disk), localStorage, API/server ──────────
function makeEnv({ diskState = null, loadError = null, tauri = true } = {}) {
  const env = { disk: diskState, durableWrites: [], saveCalls: 0, loadCalls: 0, events: [] };
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.window = tauri ? {
    __TAURI__: {
      core: {
        async invoke(cmd, args, opts) {
          if (cmd === 'mls_load_state') {
            env.loadCalls++;
            await delay(3);
            if (loadError) throw loadError;
            const b = env.disk ?? new Uint8Array(0);
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          }
          if (cmd === 'mls_save_state') {
            env.saveCalls++;
            // New API: raw Uint8Array body; old API: { state: number[] }.
            const bytes = args instanceof Uint8Array ? args : new Uint8Array(args.state);
            const durable = opts?.headers?.['x-mls-durable'] === '1';
            await delay(4);
            env.disk = bytes;
            if (durable) env.durableWrites.push(dec(bytes));
            env.events.push({ t: 'save', durable, state: dec(bytes) });
            return null;
          }
          throw new Error(`unexpected invoke ${cmd}`);
        },
      },
    },
  } : {};
  return env;
}

function makeServer(selfUserId) {
  const srv = {
    groups: {}, // gid -> { epoch, log: [{epoch, commit, welcome, welcomed}] }
    devices: {}, // userId -> [{device_id, key_package}]
    members: new Set([selfUserId]),
    submitBehaviour: null, // optional (gid, epoch, commitB64) => { error } override
    submits: [],
    channelMembers: {}, // EVMLS: chan -> Set(userId) for event channels
    membersRouteError: null, // EVMLS: e.g. 'HTTP 404: Not Found' (older server)
  };
  const b64 = (u8) => Buffer.from(u8).toString('base64');
  srv.addDevice = (userId, deviceId) => {
    (srv.devices[userId] ??= []).push({ device_id: deviceId, key_package: b64(enc({ label: `${userId}:${deviceId}` })) });
    srv.members.add(userId);
  };
  srv.accept = (gid, epoch, commitB64, welcomeB64, welcomed) => {
    const g = (srv.groups[gid] ??= { epoch: 0, log: [] });
    if (g.epoch !== epoch - 1) return false;
    g.epoch = epoch;
    g.log.push({ epoch, commit: commitB64, welcome: welcomeB64, welcomed: welcomed ?? [] });
    return true;
  };
  srv.api = {
    async registerDevice() { await delay(3); return { data: {}, error: null }; },
    async getUserDeviceKeyPackages(userId) { await delay(5); return { data: { devices: srv.devices[userId] ?? [] }, error: null }; },
    async getOrgMembers() { await delay(5); return { data: { members: [...srv.members].map((user_id) => ({ user_id })) }, error: null }; },
    // EVMLS: per-channel membership. A channel listed in srv.channelMembers is
    // an event channel (its audience); others are org channels.
    async getChannelMlsMembers(_org, chan) {
      await delay(5);
      if (srv.membersRouteError) return { data: null, error: srv.membersRouteError };
      const ev = srv.channelMembers[chan];
      return ev
        ? { data: { scope: 'event', user_ids: [...ev] }, error: null }
        : { data: { scope: 'org', user_ids: [...srv.members] }, error: null };
    },
    async getChannelMlsCatchUp(_org, chan) {
      await delay(8);
      const g = srv.groups[chan];
      if (!g) return { data: { welcome: null, commits: [] }, error: null };
      const w = g.log.find((e) => e.welcome && e.welcomed.includes(selfUserId));
      return { data: { welcome: w ? { epoch: w.epoch, welcome: w.welcome } : null, commits: g.log.map((e) => ({ epoch: e.epoch, commit: e.commit })) }, error: null };
    },
    async submitChannelCommit(_org, chan, epoch, commitB64, welcomeB64, welcomed) {
      srv.submits.push({ chan, epoch, at: Date.now() });
      await delay(15);
      if (srv.submitBehaviour) return srv.submitBehaviour(chan, epoch, commitB64, welcomeB64, welcomed);
      return srv.accept(chan, epoch, commitB64, welcomeB64, welcomed)
        ? { data: { ok: true }, error: null }
        : { data: null, error: 'Epoch conflict — this commit no longer targets the current epoch' };
    },
  };
  return srv;
}

// Build a device-state blob holding the given groups (as if loaded from disk).
const blobWith = (self, groups) => enc({ self, groups });
const ct = (sender, epoch, gen) => Buffer.from(enc({ epoch, sender, gen, pt: `m${gen}@${epoch}` })).toString('base64');
const peerCommit = (gid, from, extra = {}) => Buffer.from(enc({ gid, from, to: from + 1, author: 'peer:dev', nonce: rand(), ...extra })).toString('base64');
const settle = () => new Promise((r) => setTimeout(r, 400)); // let lazy persists drain

// ── Tiny runner ────────────────────────────────────────────────────────────
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log(`ok   - ${name}`);
  } catch (err) {
    results.push([name, false]);
    console.log(`FAIL - ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const ME = 'me';
const SELF = 'me:dev1';

// ── Tests ──────────────────────────────────────────────────────────────────

await test('concurrent backfill-style decrypts + a commit in another group lose nothing', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, {
    A: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 },
    B: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 },
  }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  const ops = [];
  for (let i = 1; i <= 40; i++) ops.push(m.decryptChannelOrRecallOwn(srv.api, ME, 'A', ct('peer:dev', 1, i), false));
  ops.push(m.handleChannelCommit(srv.api, ME, 'B', peerCommit('B', 1)));
  for (let i = 41; i <= 60; i++) ops.push(m.decryptChannelOrRecallOwn(srv.api, ME, 'A', ct('peer:dev', 1, i), false));
  const out = await Promise.allSettled(ops); // exactly what TextChat's old Promise.all backfill did
  await settle();
  const failed = out.filter((r) => r.status === 'rejected');
  assert(failed.length === 0, `${failed.length} decrypts failed: ${failed[0]?.reason?.message}`);
  const disk = dec(env.disk);
  assert(disk.groups.A.consumed.length === 60, `A consumed ${disk.groups.A.consumed.length}/60 on disk (lost updates)`);
  assert(disk.groups.B.epoch === 2, `B epoch ${disk.groups.B.epoch} != 2 (commit lost)`);
  assert(env.durableWrites.some((s) => s.groups.B.epoch === 2), 'commit was never durably persisted');
});

await test('catch-up applies onto the CURRENT state (concurrent live commit + decrypts)', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, {
    A: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 },
    C: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 },
  }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.C = { epoch: 3, log: [] };
  const c2 = peerCommit('C', 1);
  const c3 = peerCommit('C', 2);
  srv.groups.C.log.push({ epoch: 2, commit: c2, welcome: null, welcomed: [] }, { epoch: 3, commit: c3, welcome: null, welcomed: [] });
  const ops = [
    m.syncChannelGroupEpoch(srv.api, ME, 'org', 'C'), // catch-up fetch in flight…
    m.handleChannelCommit(srv.api, ME, 'C', c2),      // …while the live commit for epoch 2 lands
  ];
  for (let i = 1; i <= 20; i++) ops.push(m.decryptChannelOrRecallOwn(srv.api, ME, 'A', ct('peer:dev', 1, i), false));
  await Promise.all(ops);
  await settle();
  const disk = dec(env.disk);
  assert(disk.groups.C.epoch === 3, `C epoch ${disk.groups.C.epoch} != 3`);
  assert(disk.groups.A.consumed.length === 20, `A consumed ${disk.groups.A.consumed.length}/20`);
});

await test('own commit: concurrent writers wait; base durable before submit; merge durable before return', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, {
    A: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 },
    CH: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 },
  }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.CH = { epoch: 1, log: [] };
  srv.addDevice('peer', 'dev');
  srv.addDevice('peer', 'dev2'); // second device → reconcile must add it
  const origSubmit = srv.api.submitChannelCommit;
  let durableAtSubmit = null;
  srv.api.submitChannelCommit = async (...a) => {
    // The last write Rust saw before the commit left must have been durable
    // (or nothing changed since load) — the base state survives a crash.
    const lastSave = env.events.at(-1);
    durableAtSubmit = !lastSave || lastSave.durable;
    return origSubmit(...a);
  };
  const ensure = m.ensureChannelGroup(srv.api, ME, 'org', 'CH');
  const decs = [];
  for (let i = 1; i <= 25; i++) {
    await delay(3);
    decs.push(m.decryptChannelOrRecallOwn(srv.api, ME, 'A', ct('peer:dev', 1, i), false));
  }
  await ensure;
  const durableAfter = env.durableWrites.at(-1);
  await Promise.all(decs);
  await settle();
  const disk = dec(env.disk);
  assert(srv.groups.CH.epoch === 2, `server CH epoch ${srv.groups.CH.epoch}`);
  assert(disk.groups.CH.epoch === 2 && disk.groups.CH.members.includes('peer:dev2'), 'own commit not merged');
  assert(disk.groups.A.consumed.length === 25, `A consumed ${disk.groups.A.consumed.length}/25 (own-commit merge clobbered decrypts)`);
  assert(durableAtSubmit === true, `base state not durable at submit (${durableAtSubmit})`);
  assert(durableAfter && durableAfter.groups.CH.epoch === 2, 'merged state not durable when ensureChannelGroup resolved');
});

await test('own commit losing a race (409) adopts the winner, discards own result', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { CH: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.CH = { epoch: 1, log: [] };
  srv.addDevice('peer', 'dev');
  srv.addDevice('peer', 'dev2');
  // A peer's commit lands first.
  srv.submitBehaviour = (chan, epoch) => {
    srv.submitBehaviour = null;
    srv.accept(chan, epoch, peerCommit('CH', 1, { add: ['peer:dev2'] }), null, []);
    return { data: null, error: 'Epoch conflict — this commit no longer targets the current epoch' };
  };
  await m.ensureChannelGroup(srv.api, ME, 'org', 'CH');
  await settle();
  const disk = dec(env.disk);
  assert(disk.groups.CH.epoch === 2, `epoch ${disk.groups.CH.epoch} != 2`);
  assert(disk.groups.CH.members.filter((x) => x === 'peer:dev2').length === 1, 'duplicate / missing member');
});

await test('ambiguous submit failure resolved via the commit log (accepted → adopted)', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { CH: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.CH = { epoch: 1, log: [] };
  srv.addDevice('peer', 'dev');
  srv.addDevice('peer', 'dev2');
  srv.submitBehaviour = (chan, epoch, c, w, wl) => {
    srv.submitBehaviour = null;
    srv.accept(chan, epoch, c, w, wl); // server committed it…
    return { data: null, error: 'Network Error' }; // …but the response was lost
  };
  await m.ensureChannelGroup(srv.api, ME, 'org', 'CH');
  await settle();
  const disk = dec(env.disk);
  assert(disk.groups.CH.epoch === 2 && disk.groups.CH.members.includes('peer:dev2'), `own accepted commit not adopted (epoch ${disk.groups.CH.epoch})`);
});

await test('ambiguous submit failure, not in the log → not adopted', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { CH: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.CH = { epoch: 1, log: [] };
  srv.addDevice('peer', 'dev');
  srv.addDevice('peer', 'dev2');
  let n = 0;
  srv.submitBehaviour = () => (n++ === 0 ? { data: null, error: 'HTTP 502' } : { data: null, error: 'Epoch conflict' });
  await m.ensureChannelGroup(srv.api, ME, 'org', 'CH');
  await settle();
  const disk = dec(env.disk);
  assert(disk.groups.CH.epoch === 1, `rejected commit adopted (epoch ${disk.groups.CH.epoch})`);
});

await test('encrypt returns only after a durable write containing its ratchet step', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { A: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  for (let i = 1; i <= 5; i++) {
    await m.encryptChannel(srv.api, ME, 'A', `hello ${i}`);
    const last = env.durableWrites.at(-1);
    assert(last && last.groups.A.sent === i, `after encrypt #${i} durable sent=${last?.groups.A.sent}`);
  }
});

await test('persist coalescing: 200 sequential decrypts → far fewer IPC writes, final state on disk', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { A: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  for (let i = 1; i <= 200; i++) await m.decryptChannelOrRecallOwn(srv.api, ME, 'A', ct('peer:dev', 1, i), false);
  await settle();
  assert(dec(env.disk).groups.A.consumed.length === 200, 'final state not persisted');
  assert(env.saveCalls < 120, `${env.saveCalls} save IPCs for 200 decrypts`);
  console.log(`       (${env.saveCalls} save IPCs for 200 decrypts)`);
});

await test('unreadable state: no new identity, no registration, distinct error', async () => {
  makeEnv({ diskState: null, loadError: 'MLS_KEY_MISSING: encrypted MLS state exists but its keyring key is gone' });
  const m = await freshModule();
  const srv = makeServer(ME);
  let registered = 0;
  srv.api.registerDevice = async () => { registered++; return { data: {}, error: null }; };
  const before = stubCalls.generate_identity;
  let err = null;
  try { await m.ensureIdentity(srv.api, ME); } catch (e) { err = e; }
  assert(err && err.name === 'MlsStateUnavailableError' && err.code === 'MLS_KEY_MISSING', `got ${err?.name}/${err?.code}`);
  assert(stubCalls.generate_identity === before, 'generated a new identity over unreadable state');
  assert(registered === 0, 'registered a new device');
  let err2 = null;
  try { await m.decryptChannelOrRecallOwn(srv.api, ME, 'A', ct('peer:dev', 1, 1), false); } catch (e) { err2 = e; }
  assert(err2?.name === 'MlsDecryptError' && err2.reason === 'state_unavailable' && err2.code === 'MLS_KEY_MISSING',
    `decrypt did not surface the state error (${err2?.name}/${err2?.reason}/${err2?.code})`);
});

await test('fresh device: one identity even with concurrent first calls; durable before use', async () => {
  const env = makeEnv({ diskState: null });
  const m = await freshModule();
  const srv = makeServer(ME);
  const before = stubCalls.generate_identity;
  await Promise.all([m.ensureIdentity(srv.api, ME), m.ensureIdentity(srv.api, ME), m.signBytes(srv.api, ME, new Uint8Array([1]))]);
  assert(stubCalls.generate_identity - before === 1, `generated ${stubCalls.generate_identity - before} identities`);
  assert(env.durableWrites.length >= 1, 'new identity not durably persisted');
  assert(env.loadCalls === 1, `load called ${env.loadCalls} times`);
});

await test('browser (no Tauri): behaves as before — in-memory identity, no IPC', async () => {
  makeEnv({ tauri: false });
  const m = await freshModule();
  const srv = makeServer(ME);
  const before = stubCalls.generate_identity;
  await m.ensureIdentity(srv.api, ME);
  assert(stubCalls.generate_identity - before === 1, 'identity not generated');
  const sig = await m.signBytes(srv.api, ME, new Uint8Array([1]));
  assert(sig instanceof Uint8Array, 'signBytes failed');
});

// ── EVMLS: event channels follow the event's signed-up audience ────────────

await test('event channel: reconcile adds a newly accepted participant, never other org members', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { EV: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.EV = { epoch: 1, log: [] };
  srv.addDevice('peer', 'dev');
  srv.addDevice('newbie', 'dev'); // just accepted into the event
  srv.addDevice('outsider', 'dev'); // org member, not signed up
  srv.channelMembers.EV = new Set([ME, 'peer', 'newbie']);
  let welcomed = null;
  srv.submitBehaviour = (chan, epoch, c, w, wl) => { welcomed = wl; return srv.accept(chan, epoch, c, w, wl) ? { data: { ok: true }, error: null } : { data: null, error: 'Epoch conflict' }; };
  await m.ensureChannelGroup(srv.api, ME, 'org', 'EV');
  await settle();
  const g = dec(env.disk).groups.EV;
  assert(g.members.includes('newbie:dev'), 'accepted participant not added');
  assert(!g.members.includes('outsider:dev'), 'non-participant org member was added');
  assert(JSON.stringify(welcomed) === JSON.stringify(['newbie']), `welcomed ${JSON.stringify(welcomed)}`);
});

await test('event channel: a member who left the event is removed (epoch advances → key rotates)', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { EV: { epoch: 1, members: [SELF, 'peer:dev', 'gone:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.EV = { epoch: 1, log: [] };
  srv.addDevice('peer', 'dev');
  srv.addDevice('gone', 'dev'); // still in the org, left the event
  srv.channelMembers.EV = new Set([ME, 'peer']);
  await m.ensureChannelGroup(srv.api, ME, 'org', 'EV');
  await settle();
  const g = dec(env.disk).groups.EV;
  assert(!g.members.includes('gone:dev'), 'departed member still in the group');
  assert(g.epoch === 2 && srv.groups.EV.epoch === 2, `epoch ${g.epoch}/${srv.groups.EV.epoch} != 2`);
});

await test('event channel: a user outside the audience never commits (no genesis, no reconcile)', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { EV2: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.addDevice('peer', 'dev');
  srv.channelMembers.EV = new Set(['peer']); // no local group, not a member
  srv.channelMembers.EV2 = new Set(['peer']); // has stale local state, removed
  srv.groups.EV2 = { epoch: 1, log: [] };
  await m.ensureChannelGroup(srv.api, ME, 'org', 'EV');
  await m.ensureChannelGroup(srv.api, ME, 'org', 'EV2');
  await settle();
  assert(srv.submits.length === 0, `${srv.submits.length} commits submitted`);
  assert(!dec(env.disk ?? blobWith(SELF, {})).groups.EV, 'created a group it may not hold');
});

await test('member list failure (not an old server) throws instead of falling back to the org', async () => {
  makeEnv({ diskState: blobWith(SELF, { EV: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.EV = { epoch: 1, log: [] };
  srv.addDevice('peer', 'dev');
  srv.addDevice('outsider', 'dev');
  srv.membersRouteError = 'HTTP 500: Internal Server Error';
  let err = null;
  try { await m.ensureChannelGroup(srv.api, ME, 'org', 'EV'); } catch (e) { err = e; }
  assert(err && /member list unavailable/.test(err.message), `got ${err?.message}`);
  assert(srv.submits.length === 0, 'committed without a member list');
});

await test('older server (no /mls/members route → 404) falls back to the org member list', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { CH: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  srv.groups.CH = { epoch: 1, log: [] };
  srv.addDevice('peer', 'dev');
  srv.addDevice('peer2', 'dev');
  srv.membersRouteError = 'HTTP 404: Not Found';
  await m.ensureChannelGroup(srv.api, ME, 'org', 'CH');
  await settle();
  assert(dec(env.disk).groups.CH.members.includes('peer2:dev'), 'org fallback did not add the org member');
});

// ── MR1: per-account identity, account switch, typed decrypt errors ────────

await test('state of another account is never used (MLS_ACCOUNT_MISMATCH), and no identity is generated', async () => {
  makeEnv({ diskState: blobWith('someone-else:dev9', {}) });
  const m = await freshModule();
  const srv = makeServer(ME);
  const before = stubCalls.generate_identity;
  let err = null;
  try { await m.ensureIdentity(srv.api, ME); } catch (e) { err = e; }
  assert(err?.code === 'MLS_ACCOUNT_MISMATCH', `got ${err?.code}`);
  assert(stubCalls.generate_identity === before, 'generated an identity');
});

await test('MLS_NO_SESSION on load: not ready, no identity, retried after login', async () => {
  const env = makeEnv({ diskState: null, loadError: 'MLS_NO_SESSION: not signed in' });
  const m = await freshModule();
  const srv = makeServer(ME);
  const before = stubCalls.generate_identity;
  let err = null;
  try { await m.ensureIdentity(srv.api, ME); } catch (e) { err = e; }
  assert(err?.code === 'MLS_NO_SESSION' && stubCalls.generate_identity === before, `got ${err?.code}`);
  env.disk = blobWith(SELF, {});
  // Same env object: clear the load error by swapping invoke's behaviour.
  const inv = globalThis.window.__TAURI__.core.invoke;
  globalThis.window.__TAURI__.core.invoke = (cmd, ...a) => (cmd === 'mls_load_state'
    ? Promise.resolve(env.disk.buffer.slice(0)) : inv(cmd, ...a));
  await m.ensureIdentity(srv.api, ME);
  assert(m.groupEpoch('nothing') === null, 'identity not usable after login');
});

await test('fresh identity: per-account device id; DEVICE_ID_TAKEN regenerates it once', async () => {
  makeEnv({ diskState: null });
  localStorage.setItem('specter_mls_device_id', 'legacy-dev'); // never adopted without a state proving ownership
  const m = await freshModule();
  const srv = makeServer(ME);
  const ids = [];
  srv.api.registerMlsDevice = async (deviceId) => {
    ids.push(deviceId);
    return ids.length === 1 ? { data: null, error: 'taken', code: 'DEVICE_ID_TAKEN' } : { data: {}, error: null, code: null };
  };
  await m.ensureIdentity(srv.api, ME);
  assert(ids.length === 2 && ids[0] !== ids[1], `registrations ${JSON.stringify(ids)}`);
  assert(!ids.includes('legacy-dev'), 'adopted the legacy per-PC id for a fresh identity');
  assert(localStorage.getItem(`specter_mls_device_id:${ME}`) === ids[1], 'per-account id not stored');
});

await test('loaded state: its device id becomes this account\'s (legacy key adopted only by its owner)', async () => {
  makeEnv({ diskState: blobWith('me:legacy-dev', {}) });
  localStorage.setItem('specter_mls_device_id', 'legacy-dev');
  const m = await freshModule();
  await m.ensureIdentity(makeServer(ME).api, ME);
  assert(localStorage.getItem(`specter_mls_device_id:${ME}`) === 'legacy-dev', 'owner did not keep its device id');
});

await test('account switch: in-memory caches dropped; queued work of the old account cannot write', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { A: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  await m.ensureIdentity(srv.api, ME);
  assert(m.groupEpoch('A') === 1, 'group not loaded');
  const pending = m.decryptChannel(srv.api, ME, 'A', ct('peer:dev', 1, 1), false);
  m.resetForUser('other'); // e.g. logout + login as another account
  let err = null;
  try { await pending; } catch (e) { err = e; }
  assert(err && /ACCOUNT_SWITCHED/.test(`${err.code} ${err.message}`), `old work not refused: ${err?.message}`);
  assert(m.groupEpoch('A') === null, 'old account\'s group still visible');
  env.disk = blobWith('other:dev2', {});
  let err2 = null;
  try { await m.ensureIdentity(srv.api, ME); } catch (e) { err2 = e; } // ME again ≠ 'other' → reset → loads other's state
  assert(err2?.code === 'MLS_ACCOUNT_MISMATCH', `got ${err2?.code}`);
});

await test('save rejected as MLS_ACCOUNT_MISMATCH: stale write dropped, caches reset', async () => {
  const env = makeEnv({ diskState: blobWith(SELF, { A: { epoch: 1, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  await m.ensureIdentity(srv.api, ME);
  const inv = globalThis.window.__TAURI__.core.invoke;
  globalThis.window.__TAURI__.core.invoke = (cmd, ...a) => (cmd === 'mls_save_state'
    ? Promise.reject('MLS_ACCOUNT_MISMATCH: state belongs to me, but this window loaded other\'s') : inv(cmd, ...a));
  let err = null;
  try { await m.encryptChannel(srv.api, ME, 'A', 'x'); } catch (e) { err = e; }
  assert(err && /ACCOUNT_MISMATCH/.test(String(err?.message ?? err)), `encrypt should fail: ${err}`);
  assert(m.groupEpoch('A') === null, 'cache not reset after a stale-account write');
  void env;
});

await test('typed decrypt reasons: corrupt / not_member / epoch_too_old / epoch_ahead (caught up) / own echo', async () => {
  makeEnv({ diskState: blobWith(SELF, { A: { epoch: 2, members: [SELF, 'peer:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  const reason = async (p) => { try { await p; return 'ok'; } catch (e) { return e.name === 'MlsDecryptError' ? e.reason : `${e.name}:${e.message}`; } };
  assert(await reason(m.decryptChannel(srv.api, ME, 'A', btoa('not json'), false)) === 'corrupt', 'garbage');
  assert(await reason(m.decryptChannel(srv.api, ME, 'Z', ct('peer:dev', 1, 1), false)) === 'not_member', 'not held');
  assert(await reason(m.decryptChannel(srv.api, ME, 'A', ct('peer:dev', 1, 1), false)) === 'epoch_too_old', 'too old');
  // Ahead of us, the commit is in the log: decrypt catches up and succeeds.
  srv.groups.A = { epoch: 3, log: [{ epoch: 3, commit: peerCommit('A', 2), welcome: null, welcomed: [] }] };
  await m.syncChannelGroupEpoch(srv.api, ME, 'org', 'A'); // registers the channel's context (org)
  srv.groups.A.epoch = 4;
  srv.groups.A.log.push({ epoch: 4, commit: peerCommit('A', 3), welcome: null, welcomed: [] });
  assert(await m.decryptChannel(srv.api, ME, 'A', ct('peer:dev', 4, 1), false) === 'm1@4', 'epoch-ahead not resolved by catch-up');
  assert(await reason(m.decryptChannel(srv.api, ME, 'A', ct('peer:dev', 6, 1), false)) === 'epoch_ahead_unresolved', 'unresolvable ahead');
  m.notePendingSent('A', 'my own words');
  assert(await m.decryptChannelOrRecallOwn(srv.api, ME, 'A', ct(SELF, 4, 1), true) === 'my own words', 'own echo not recalled');
});

await test('onGroupStateChange: live commit → cb(groupId, { removed })', async () => {
  makeEnv({ diskState: blobWith(SELF, { A: { epoch: 1, members: [SELF, 'peer:dev', 'gone:dev'], consumed: [], sent: 0 } }) });
  const m = await freshModule();
  const srv = makeServer(ME);
  const seen = [];
  const unsub = m.onGroupStateChange((gid, info) => seen.push([gid, info?.removed]));
  await m.handleChannelCommit(srv.api, ME, 'A', peerCommit('A', 1, { add: ['new:dev'] }));
  await m.handleChannelCommit(srv.api, ME, 'A', peerCommit('A', 2, { remove: ['gone:dev'] }));
  await settle();
  unsub();
  await m.handleChannelCommit(srv.api, ME, 'A', peerCommit('A', 3));
  await settle();
  assert(JSON.stringify(seen) === JSON.stringify([['A', false], ['A', true]]), `seen ${JSON.stringify(seen)}`);
});

rmSync(workDir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
