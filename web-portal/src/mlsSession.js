// mlsSession.js — client-side MLS (RFC 9420) session management.
//
// Wraps the mls-crypto WASM module with device-identity bootstrap, local
// persistence, and group setup for both DMs and org text channels. This
// device's MLS identity private key and every group's ratchet state live in
// a single opaque blob, encrypted at rest via the OS keyring (see
// web-portal/src-tauri/src/mls_store.rs) — Tauri desktop only for now;
// outside Tauri, identity never persists across restarts, so E2E doesn't
// establish.
//
// ── Concurrency invariants (read before touching device state) ───────────
//
// The device state is ONE blob covering every group, and every mutating WASM
// call is `newBlob = f(oldBlob, …)`. Two operations that each read the blob,
// await something, then write their result back would silently discard each
// other's changes — e.g. a decrypt in channel A overwriting a commit just
// applied in channel B, leaving B on the wrong epoch (wrong key) forever. So:
//
//  I1. `deviceStateCache` is the single source of truth. It is only ever
//      replaced (never mutated in place) and only by commitState(), which is
//      only called while holding the state lock (withStateLock).
//  I2. Every read-modify-write runs inside withStateLock, and reads
//      `deviceStateCache` INSIDE the critical section, immediately before
//      the synchronous WASM call(s). Nothing captured before the lock was
//      acquired is ever used as a base state.
//  I3. The lock is never held across network calls, with exactly ONE
//      exception: an own commit's submit request (runOwnCommit). The WASM
//      API returns a whole-device blob with the commit already merged, and
//      MLS can't re-apply your own commit later (process_commit rejects it)
//      nor can one group be spliced out of a blob — so the only way to merge
//      an accepted commit onto the state it was built from is to make sure
//      no other write happens in between. Everything else (key-package and
//      member-list fetches, catch-up fetches, GroupInfo fetches) happens
//      outside the lock, and the result is re-validated against the
//      then-current state inside it. External commits (join / resync) are
//      own commits too and go through runOwnCommit.
//  I4. Read-only calls (export_secret, export_group_info, sign_bytes,
//      group_exists, group_epoch, group_member_labels outside a build step)
//      read the latest committed `deviceStateCache` without taking the lock.
//  I5. Durability: decrypt-only changes are persisted lazily (coalesced;
//      Rust flushes them within ~200 ms and on exit). Every group operation
//      (identity creation, create/add/remove, welcome, commit, catch-up,
//      own-commit merge, external join/resync) and every encrypt is
//      persisted DURABLY (fsynced by Rust) before the lock is released and
//      before the caller gets a result — so nothing that depends on it (a
//      ciphertext, a follow-up commit) can reach the server first. Before an
//      own commit is submitted, the state it was built from is made durable.
//  I6. withStateLock is not re-entrant: code running inside it must call
//      the *Locked helpers, never the public functions.
//  I7. (v2.0.1) The cache belongs to ONE account (boundUserId). A call with a
//      different user id resets every in-memory cache first (resetForUser);
//      lock work queued for the previous account fails with
//      MLS_ACCOUNT_SWITCHED instead of writing into the new account's state.
//
// Flows:
//   decrypt / encrypt       lock{ read → WASM → commit } (+ durable for encrypt)
//   handleGroupWelcome/Commit  lock{ read → join/process → commit → durable }
//   catchUpGroup            fetch (unlocked) → lock{ apply welcome + commits
//                           newer than the CURRENT epoch → commit → durable }
//   ensure*Group            catch-up → (not a member: external join from the
//                           server's GroupInfo; diverged: resync; no group on
//                           the server: genesis, solo when nobody else can be
//                           added) → member/key-package fetch (unlocked) →
//                           runOwnCommit(build from CURRENT state, re-checking
//                           whether there's still anything to do) → catch-up.
//                           A failed reconcile never costs this device a key
//                           it can already export.
//   runOwnCommit            lock{ read → build → durable(base) → submit →
//                           accepted? commit(result) → durable }
//
// ── Self-healing (v2.0.1, MR1) ───────────────────────────────────────────
// Every own commit uploads the GroupInfo for the epoch it produces, so:
//  - JOIN: a device that isn't in a group the server knows joins it by an
//    external commit (join_external) — no waiting for some member's client
//    to reconcile it in, no genesis guess. Genesis only when the server says
//    the group doesn't exist (GET …/mls/group-info → exists:false).
//  - HEAL: a device whose copy diverged — catch-up can't reach the server's
//    epoch, a live commit can't be applied, or current-epoch decrypts keep
//    failing — re-joins just that group (resync_external: drop the local
//    copy, external commit that also removes its old leaf).
//  - Every swallowed failure goes to mlsLog → setup_errors.log. Plaintext
//    and key material are never logged; fields are ids, epochs and reasons.
import initMls, {
  generate_identity,
  group_exists,
  group_is_active,
  delete_group,
  group_epoch,
  group_member_labels,
  create_group,
  create_solo_group,
  add_member,
  remove_member,
  join_from_welcome,
  process_commit,
  encrypt,
  decrypt,
  export_secret,
  frame_key_packages,
  generate_key_package,
  key_package_usable,
  sign_bytes,
  own_public_key,
  verify_bytes,
  export_group_info,
  join_external,
  resync_external,
  message_epoch,
  device_credential,
  group_ids,
} from 'mls-crypto';
import { noteCatchUp as noteHealthCatchUp, setMlsHealthLogger } from './engine/mlsHealth.js'; // S3
import { plaintextFromBytes } from './engine/frank.js'; // S7: v2 envelopes keep their binary header

// S7: wire formats this build can READ, advertised on device registration as
// X-Specter-Wire-Caps (server: user_devices.wire_caps, migration 000086).
// Bit 0 = chat/DM envelope v2 + franking (engine/frank.js), bit 1 = share
// frames v2 (wasm-crypto share_frame.rs). Senders switch to v2 only when every
// device of a conversation advertises the bit (S8).
export const WIRE_CAP_CHAT_V2 = 1;
export const WIRE_CAP_SHARE_V2 = 2;
export const WIRE_CAPS = WIRE_CAP_CHAT_V2 | WIRE_CAP_SHARE_V2;

let wasmReady = null;
function ensureWasm() {
  if (!wasmReady) wasmReady = initMls();
  return wasmReady;
}

function isTauri() {
  return typeof window !== 'undefined' && !!window.__TAURI__;
}

// ── Logging ───────────────────────────────────────────────────────────────

const LOG_DEDUPE_MS = 30_000;
const recentLogs = new Map(); // line -> last time written

function logValue(v) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  return String(v?.message ?? v).slice(0, 200);
}

/**
 * MLS diagnostics → console and (Tauri) setup_errors.log via client_log.
 * `fields` must only carry ids, epochs, counts, reason codes and library
 * error strings — never plaintext, ciphertext or key material. 'debug' stays
 * in the console; identical lines are written at most once per 30 s.
 */
export function mlsLog(level, msg, fields = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(fields ?? {})) clean[k] = logValue(v);
  const line = `[mls] ${level} ${msg} ${JSON.stringify(clean)}`;
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(line);
  if (level === 'debug' || !isTauri()) return;
  const now = Date.now();
  const last = recentLogs.get(line);
  if (last && now - last < LOG_DEDUPE_MS) return;
  recentLogs.set(line, now);
  if (recentLogs.size > 500) {
    for (const [k, t] of recentLogs) if (now - t >= LOG_DEDUPE_MS) recentLogs.delete(k);
  }
  try {
    Promise.resolve(window.__TAURI__.core.invoke('client_log', { msg: line })).catch(() => {});
  } catch { /* logging must never throw */ }
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Thrown when a device state exists on disk but can't be read (keyring
 * unavailable, key missing, file undecryptable, …), when nobody is signed in
 * (MLS_NO_SESSION), when the state belongs to another account
 * (MLS_ACCOUNT_MISMATCH) or the account switched mid-operation
 * (MLS_ACCOUNT_SWITCHED). Distinct from "no state yet": ensureIdentity must
 * never answer this by generating a new identity, which would silently
 * replace this device's real one under the same device id and lock it out of
 * every group.
 */
export class MlsStateUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MlsStateUnavailableError';
    this.code = /^(MLS_[A-Z_]+)/.exec(message)?.[1] ?? 'MLS_STATE_UNKNOWN';
  }
}

/**
 * Why a channel/DM message couldn't be decrypted:
 *   epoch_ahead_unresolved  sent in an epoch this device hasn't reached, and
 *                           catching up didn't get it there (retry on
 *                           onGroupStateChange)
 *   epoch_too_old           older than the kept past-epoch window, or this
 *                           device joined after it was sent (needs a backfill)
 *   not_member              this device doesn't hold the group
 *   state_unavailable       no usable MLS state (keyring, not signed in, …)
 *   corrupt                 not an MLS message, or undecryptable at the
 *                           current epoch (replayed / forked / garbage)
 */
export class MlsDecryptError extends Error {
  constructor(reason, message, details = {}) {
    super(message || reason);
    this.name = 'MlsDecryptError';
    this.reason = reason;
    Object.assign(this, details);
  }
}

// ── Device id (per account) ──────────────────────────────────────────────

// Before v2.0.1 the device id was per PC, so a second account on the same PC
// silently reused the first account's identity. It's per account now; the
// legacy key is only ever adopted when the loaded state's own credential
// proves it's this account's (see initIdentity).
const LEGACY_DEVICE_ID_KEY = 'specter_mls_device_id';
const deviceIdKey = (userId) => `specter_mls_device_id:${userId}`;

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* best effort */ }
}
function storageRemove(key) {
  try { localStorage.removeItem?.(key); } catch { /* best effort */ }
}

function getOrCreateDeviceId(userId) {
  let deviceId = storageGet(deviceIdKey(userId));
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    storageSet(deviceIdKey(userId), deviceId);
  }
  return deviceId;
}

// Credential content is `${userId}:${deviceId}`, not an opaque label — group
// membership reconciliation (see reconcileGroupDevices below) needs to map
// an MLS group's current members back to real accounts (e.g. "this user left
// the org, remove all their devices"), which an arbitrary per-device label
// can't support on its own.
function credentialFor(userId, deviceId) {
  return `${userId}:${deviceId}`;
}
const userIdOfLabel = (label) => label.slice(0, label.lastIndexOf(':'));
const deviceIdOfLabel = (label) => label.slice(label.lastIndexOf(':') + 1);

function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── Persistence (raw bytes over IPC — see mls_store.rs) ───────────────────

async function loadState() {
  if (!isTauri()) return new Uint8Array(0);
  let res;
  try {
    res = await window.__TAURI__.core.invoke('mls_load_state');
  } catch (err) {
    throw new MlsStateUnavailableError(String(err?.message ?? err));
  }
  // tauri::ipc::Response arrives as an ArrayBuffer.
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  if (ArrayBuffer.isView(res)) return new Uint8Array(res.buffer, res.byteOffset, res.byteLength);
  if (Array.isArray(res)) return new Uint8Array(res);
  throw new MlsStateUnavailableError('MLS_STATE_IO: unexpected mls_load_state response type');
}

function saveState(bytes, durable) {
  // Raw body (Uint8Array → application/octet-stream, no JSON number array).
  return window.__TAURI__.core.invoke('mls_save_state', bytes, {
    headers: { 'x-mls-durable': durable ? '1' : '0' },
  });
}

// ── Device-state store + write lock ───────────────────────────────────────

let deviceStateCache = null; // Uint8Array — latest committed state (I1)
let stateVersion = 0;        // bumped on every commitState
let ownCredential = null;    // `${userId}:${deviceId}` of the loaded state
let boundUserId = null;      // the account deviceStateCache belongs to (I7)
let sessionGen = 0;          // bumped by resetForUser
let lockHolderGen = 0;       // sessionGen of the lock work currently running

let lockTail = Promise.resolve();

const accountSwitched = () => new MlsStateUnavailableError('MLS_ACCOUNT_SWITCHED: the signed-in account changed during this MLS operation');

/** Runs `fn` exclusively w.r.t. every other state writer, FIFO. Not re-entrant (I6). */
function withStateLock(fn) {
  const gen = sessionGen;
  const run = lockTail.then(() => {
    if (gen !== sessionGen) throw accountSwitched();
    lockHolderGen = gen;
    return fn();
  });
  lockTail = run.then(() => undefined, () => undefined);
  return run;
}

/** The committed state for lock work; a reset (account switch) since the call began → MLS_ACCOUNT_SWITCHED. */
function currentState() {
  if (!deviceStateCache) throw accountSwitched();
  return deviceStateCache;
}

/** Only call while holding the state lock (I1). Returns the new version. */
function commitState(newState) {
  if (lockHolderGen !== sessionGen) throw accountSwitched(); // I7
  deviceStateCache = newState;
  stateVersion += 1;
  schedulePersist();
  return stateVersion;
}

// Single writer: at most one mls_save_state in flight, always sending the
// newest committed state, so saves can never land out of order and bursts
// (e.g. a backfill of 200 decrypts) collapse into a handful of IPC calls.
let persistedVersion = 0; // newest version Rust has accepted (memory or disk)
let durableVersion = 0;   // newest version Rust confirmed fsynced
let durableWanted = 0;
let writerActive = false;
let durableWaiters = [];  // { version, resolve, reject }

function schedulePersist() {
  if (!isTauri() || writerActive) return;
  runWriter();
}

async function runWriter() {
  writerActive = true;
  try {
    for (;;) {
      const durable = durableWanted > durableVersion;
      if (!durable && persistedVersion >= stateVersion) break;
      if (!deviceStateCache) break; // reset (account switch) — nothing to save
      const version = stateVersion;
      const bytes = deviceStateCache;
      try {
        await saveState(bytes, durable);
        persistedVersion = Math.max(persistedVersion, version);
        if (durable) {
          durableVersion = Math.max(durableVersion, version);
          const ready = durableWaiters.filter((w) => w.version <= durableVersion);
          durableWaiters = durableWaiters.filter((w) => w.version > durableVersion);
          ready.forEach((w) => w.resolve());
        }
      } catch (err) {
        const message = String(err?.message ?? err);
        // Fail every outstanding durability request — callers must not act
        // as if their change were safely on disk. Not retried in a loop; the
        // next commitState()/waitDurable() tries again.
        const failed = durableWaiters;
        durableWaiters = [];
        durableWanted = durableVersion;
        const wrapped = err instanceof Error ? err : new Error(message);
        failed.forEach((w) => w.reject(wrapped));
        if (/MLS_ACCOUNT_MISMATCH|MLS_NO_SESSION/.test(message)) {
          // MR3: this window's state belongs to an account that's no longer
          // the Rust session's — a stale write. Drop it and forget the cache;
          // the next call loads the signed-in account's state.
          mlsLog('warn', 'dropping MLS state write for a stale account', { error: message });
          resetForUser(null);
        } else {
          mlsLog('error', 'persisting MLS device state failed', { error: message });
        }
        break;
      }
    }
  } finally {
    writerActive = false;
  }
}

/** Resolves once a state at least as new as `version` is fsynced (I5). */
function waitDurable(version = stateVersion) {
  if (!isTauri() || durableVersion >= version) return Promise.resolve();
  return new Promise((resolve, reject) => {
    durableWaiters.push({ version, resolve, reject });
    if (version > durableWanted) durableWanted = version;
    schedulePersist();
  });
}

/** commitState + durable persist. Only call while holding the state lock. */
async function commitDurableLocked(newState) {
  const version = commitState(newState);
  await waitDurable(version);
  return version;
}

// ── Group-state change notifications ─────────────────────────────────────

const groupListeners = new Set();

/**
 * cb(groupIdStr, { removed }) after any epoch/membership change of a group
 * on this device (own commit, live or caught-up commit, welcome, external
 * join/resync). `removed` is true when the change removed any member device.
 * Runs outside the state lock. Returns an unsubscribe function.
 */
export function onGroupStateChange(cb) {
  groupListeners.add(cb);
  return () => groupListeners.delete(cb);
}

function emitGroupChange(groupIdStr, removed = false) {
  for (const cb of [...groupListeners]) {
    setTimeout(() => {
      try {
        cb(groupIdStr, { removed: !!removed });
      } catch (err) {
        mlsLog('warn', 'group change listener threw', { groupId: groupIdStr, error: err });
      }
    }, 0);
  }
}

/**
 * Without the group, if `state`'s copy is one this device was removed from.
 * Such a copy (a commit removed our leaf — an event audience change, a
 * stale-leaf reconcile) still exists and even tracks the epoch, but is Inactive
 * and can never export a key again; kept, it reads as held and healthy, so
 * nothing would re-join it. → the state to use, or `state` itself if unchanged.
 */
function withoutEvictedCopy(state, groupId) {
  if (!group_exists(state, groupId) || group_is_active(state, groupId)) return state;
  mlsLog('warn', 'this device was removed from the group; dropped the evicted copy', { groupId: textDecoder.decode(groupId) });
  return delete_group(state, groupId);
}

function labelsIn(state, groupId) {
  try {
    return state && group_exists(state, groupId) ? group_member_labels(state, groupId) : [];
  } catch {
    return [];
  }
}

/** Did going from `before` to `after` remove any member device (multiset diff)? */
function anyRemoved(before, after) {
  const left = new Map();
  for (const l of after) left.set(l, (left.get(l) ?? 0) + 1);
  for (const l of before) {
    const n = left.get(l) ?? 0;
    if (n === 0) return true;
    left.set(l, n - 1);
  }
  return false;
}

// ── Account binding ──────────────────────────────────────────────────────

let identityPromise = null;

/**
 * Drops every in-memory MLS cache (device state, own credential, pending own
 * messages, group contexts, heal bookkeeping) and binds the session to
 * `userId` (null = unbound). Called automatically when any function is
 * called with a different currentUserId than the state was loaded for.
 * Nothing on disk is touched — the next call loads `userId`'s own state.
 */
export function resetForUser(userId) {
  sessionGen += 1;
  boundUserId = userId ?? null;
  deviceStateCache = null;
  ownCredential = null;
  identityPromise = null;
  pendingSent.clear();
  groupCtx.clear();
  decryptFailures.clear();
  lastHealAt.clear();
  inflightOrgHeals.clear();
  groupInfoRefreshed.clear();
  keyPackageNextCheckAt = 0;
  epochMemo = { version: -1, map: new Map() };
  // Whatever the previous account still had queued for disk is not ours.
  persistedVersion = durableVersion = durableWanted = stateVersion;
  const failed = durableWaiters;
  durableWaiters = [];
  failed.forEach((w) => w.reject(accountSwitched()));
}

// ── Identity ──────────────────────────────────────────────────────────────

/**
 * Loads (or, on a genuinely fresh device, generates and registers) this
 * device's MLS identity. Safe to call repeatedly and concurrently — a
 * single in-flight initialization is shared. Throws MlsStateUnavailableError
 * (and never generates a new identity) if a state exists but can't be read,
 * nobody is signed in, or the state belongs to another account.
 */
export function ensureIdentity(api, currentUserId) {
  if (currentUserId && boundUserId && currentUserId !== boundUserId) resetForUser(currentUserId);
  if (deviceStateCache) {
    maybeRefreshKeyPackage(api, currentUserId);
    return Promise.resolve(deviceStateCache);
  }
  if (!identityPromise) {
    if (currentUserId) boundUserId = currentUserId;
    const gen = sessionGen;
    identityPromise = initIdentity(api, currentUserId, gen).catch((err) => {
      if (gen === sessionGen) identityPromise = null; // allow a retry (e.g. keyring unlocked later)
      throw err;
    });
  }
  return identityPromise;
}

function registerDevice(api, deviceId, identity, credential) {
  const args = [
    deviceId,
    toB64(identity.key_package),
    toB64(textEncoder.encode(credential)),
    toB64(own_public_key(identity.device_state)),
  ];
  if (typeof api.registerMlsDevice === 'function') return api.registerMlsDevice(...args, WIRE_CAPS);
  return api.registerDevice(...args);
}

// ── KeyPackage upkeep ─────────────────────────────────────────────────────
// The KeyPackage on the server is how anyone adds this device. It expires 84
// days after it was generated and serves one Welcome (mls-crypto's
// key_package_usable_impl), and registering it is also the only thing that
// moves user_devices.last_seen_at, which the server revokes devices over after
// 90 days (deviceController). So a device that only ever registered once falls
// out of every new group, however often it's used: republish on a schedule,
// and straight after a Welcome uses the current one up.
const KEY_PACKAGE_REFRESH_MS = 7 * 24 * 60 * 60_000;
const KEY_PACKAGE_RETRY_MS = 5 * 60_000;
const keyPackageRefreshedKey = (userId) => `specter_mls_kp_refreshed:${userId}`;
let keyPackageNextCheckAt = 0;
let keyPackageRefreshing = false;

/** Fire and forget; cheap enough for ensureIdentity's hot path. */
function maybeRefreshKeyPackage(api, userId, { force = false } = {}) {
  if (!userId || !ownCredential || keyPackageRefreshing) return;
  const now = Date.now();
  if (!force) {
    if (now < keyPackageNextCheckAt) return;
    const dueAt = Number(storageGet(keyPackageRefreshedKey(userId)) ?? 0) + KEY_PACKAGE_REFRESH_MS;
    if (now < dueAt) { keyPackageNextCheckAt = dueAt; return; }
  }
  keyPackageRefreshing = true;
  keyPackageNextCheckAt = now + KEY_PACKAGE_RETRY_MS;
  refreshKeyPackage(api, userId)
    .catch((err) => mlsLog('warn', 'KeyPackage refresh failed; retrying later', { error: err }))
    .finally(() => { keyPackageRefreshing = false; });
}

async function refreshKeyPackage(api, userId) {
  // Durable first: the private half must survive a crash before anyone can
  // be added with the public half (I5).
  const identity = await withStateLock(async () => {
    const res = generate_key_package(currentState());
    const fresh = { device_state: res.device_state, key_package: res.key_package };
    await commitDurableLocked(fresh.device_state);
    return fresh;
  });
  const res = await registerDevice(api, deviceIdOfLabel(ownCredential), identity, ownCredential);
  if (res?.error) throw new Error(res.error);
  const now = Date.now();
  storageSet(keyPackageRefreshedKey(userId), String(now));
  keyPackageNextCheckAt = now + KEY_PACKAGE_REFRESH_MS;
}

async function initIdentity(api, currentUserId, gen) {
  await ensureWasm();

  let state;
  try {
    state = await loadState();
  } catch (err) {
    // MLS_NO_SESSION: not signed in yet — "not ready", retried after login.
    // Anything else: a state exists but can't be read — never replaced.
    mlsLog(err.code === 'MLS_NO_SESSION' ? 'warn' : 'error',
      'MLS state unavailable; refusing to create a new identity over it', { code: err.code, error: err });
    throw err;
  }
  if (gen !== sessionGen) throw accountSwitched();

  if (state.length > 0) {
    let credential;
    try {
      credential = device_credential(state);
    } catch (err) {
      const e = new MlsStateUnavailableError(`MLS_STATE_CORRUPT: ${String(err?.message ?? err)}`);
      mlsLog('error', 'loaded MLS state has no readable credential', { error: err });
      throw e;
    }
    if (currentUserId && userIdOfLabel(credential) !== currentUserId) {
      // Pre-MR3 per-PC state of another account: never use its identity.
      mlsLog('error', 'loaded MLS state belongs to another account', { owner: userIdOfLabel(credential) });
      throw new MlsStateUnavailableError('MLS_ACCOUNT_MISMATCH: the MLS state on this PC belongs to another account');
    }
    if (currentUserId) {
      const deviceId = deviceIdOfLabel(credential);
      if (storageGet(LEGACY_DEVICE_ID_KEY) === deviceId) mlsLog('info', 'adopting the legacy per-PC device id for its owner', {});
      storageSet(deviceIdKey(currentUserId), deviceId);
    }
    ownCredential = credential;
    deviceStateCache = state;
    stateVersion += 1;
    persistedVersion = durableVersion = stateVersion; // it came from disk
    return deviceStateCache;
  }

  // Fresh device for this account (Rust confirmed no state file exists, or
  // not in Tauri). A device id owned by another account (409
  // DEVICE_ID_TAKEN, MR3) gets regenerated once.
  let identity = null;
  let credential = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const deviceId = getOrCreateDeviceId(currentUserId);
    credential = credentialFor(currentUserId, deviceId);
    identity = generate_identity(credential);
    const res = await registerDevice(api, deviceId, identity, credential);
    if (res?.code === 'DEVICE_ID_TAKEN' && attempt === 0) {
      mlsLog('warn', 'device id belongs to another account; generating a new one', {});
      storageRemove(deviceIdKey(currentUserId));
      continue;
    }
    if (res?.error) mlsLog('error', 'device registration failed', { error: res.error, code: res.code });
    break;
  }
  if (gen !== sessionGen) throw accountSwitched();
  try {
    await withStateLock(() => commitDurableLocked(identity.device_state));
  } catch (err) {
    // Not on disk: don't keep using an identity a restart would lose.
    deviceStateCache = null;
    mlsLog('error', 'new MLS identity could not be persisted', { error: err });
    throw err;
  }
  ownCredential = credential;
  storageSet(keyPackageRefreshedKey(currentUserId), String(Date.now()));
  return deviceStateCache;
}

// ── Own commits (the single lock-across-network exception, see I3) ────────

function isEpochConflict(error) {
  return /epoch conflict/i.test(String(error ?? ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A submit that failed for any reason other than an explicit epoch conflict
 * (network drop, timeout, 5xx after the DB transaction committed…) is
 * ambiguous: the server may have accepted it. Treating an accepted commit
 * as rejected strands this device one epoch behind for good (it can never
 * process its own commit), so check the durable commit log.
 */
async function wasOwnCommitAccepted(fetchCatchUp, targetEpoch, commitB64) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await fetchCatchUp();
    if (!error && data) {
      return (data.commits ?? []).some((c) => Number(c.epoch) === targetEpoch && c.commit === commitB64);
    }
    await sleep(500 * (attempt + 1));
  }
  mlsLog('error', 'could not determine whether an own commit was accepted; assuming not', { targetEpoch });
  return false;
}

/**
 * build(currentState) → null (nothing to do any more) or
 *   { state, commit, welcome|null, targetEpoch, welcomedUserIds?, groupInfo? }
 * where `state` is currentState with the commit already merged (what
 * add_member/remove_member/join_external/resync_external return) and
 * `groupInfo` the GroupInfo for the epoch it produces (uploaded with it).
 * Runs entirely under the state lock, so `state` is only adopted if the
 * server accepted the commit AND nothing else touched the device state since
 * `build` read it. → { accepted, skipped?, conflict?, error? }
 */
async function runOwnCommit(build, submit, fetchCatchUp, groupIdStr = null) {
  let removed = null;
  const out = await withStateLock(async () => {
    const base = currentState();
    const plan = build(base);
    if (!plan) return { accepted: false, skipped: true };

    // The server is about to see a commit derived from `base` — make sure
    // `base` itself (and everything before it) survives a crash first.
    await waitDurable(stateVersion);

    const commitB64 = toB64(plan.commit);
    const welcomeB64 = plan.welcome && plan.welcome.length ? toB64(plan.welcome) : null;
    const groupInfoB64 = plan.groupInfo && plan.groupInfo.length ? toB64(plan.groupInfo) : null;
    const { error } = await submit(plan.targetEpoch, commitB64, welcomeB64, plan.welcomedUserIds ?? [], groupInfoB64);

    let accepted = !error;
    if (error && !isEpochConflict(error)) {
      mlsLog('warn', 'commit submit failed; checking the commit log', { groupId: groupIdStr, epoch: plan.targetEpoch, error });
      accepted = await wasOwnCommitAccepted(fetchCatchUp, plan.targetEpoch, commitB64);
    }
    // On a conflict, leave state untouched: the winner's commit is applied by
    // the caller's next catch-up, and a retry re-derives from that state.
    if (!accepted) return { accepted: false, conflict: isEpochConflict(error), error: error ?? null };

    if (deviceStateCache !== base) {
      // Unreachable while I1–I3 hold; refuse rather than drop another write.
      throw new Error('[mls] invariant violated: device state changed during own commit');
    }
    if (groupIdStr) {
      const gid = textEncoder.encode(groupIdStr);
      removed = anyRemoved(labelsIn(base, gid), labelsIn(plan.state, gid));
    }
    await commitDurableLocked(plan.state);
    return { accepted: true };
  });
  if (out.accepted && groupIdStr) emitGroupChange(groupIdStr, removed);
  return out;
}

// ── Group contexts ───────────────────────────────────────────────────────
// Everything needed to catch up / heal one group without the caller's help
// (decryptChannel only knows a channel id; a heal triggered by decrypt
// failures needs the org). Registered by every ensure*/sync*/heal entry
// point; dropped on resetForUser.

const groupCtx = new Map(); // groupIdStr -> ctx

const hasFn = (api, name) => typeof api?.[name] === 'function';

function channelContext(api, orgId, chanId) {
  const ctx = {
    kind: 'channel', api, groupIdStr: chanId, orgId,
    fetchCatchUp: () => api.getChannelMlsCatchUp(orgId, chanId),
    fetchMemberIds: () => fetchChannelMemberIds(api, orgId, chanId),
    submitCommit: (epoch, c, w, ids, gi) => (hasFn(api, 'submitChannelMlsCommit')
      ? api.submitChannelMlsCommit(orgId, chanId, epoch, c, w, ids, gi)
      : api.submitChannelCommit(orgId, chanId, epoch, c, w, ids)),
    getGroupInfo: hasFn(api, 'getChannelMlsGroupInfo') ? () => api.getChannelMlsGroupInfo(orgId, chanId) : null,
    putGroupInfo: hasFn(api, 'putChannelMlsGroupInfo') ? (epoch, gi) => api.putChannelMlsGroupInfo(orgId, chanId, epoch, gi) : null,
    submitExternal: hasFn(api, 'submitChannelMlsExternalCommit') ? (epoch, c, gi) => api.submitChannelMlsExternalCommit(orgId, chanId, epoch, c, gi) : null,
  };
  groupCtx.set(chanId, ctx);
  return ctx;
}

function eventContext(api, orgId, eventId) {
  const ctx = {
    kind: 'event', api, groupIdStr: eventId, orgId,
    fetchCatchUp: () => api.getEventGroupMlsCatchUp(orgId, eventId),
    fetchMemberIds: async () => {
      const { data, error } = await api.getEventParticipants(orgId, eventId);
      if (!Array.isArray(data?.participants)) throw new Error(`[mls] event participant list unavailable: ${error || 'no data'}`);
      return new Set(data.participants.map((p) => p.user_id));
    },
    submitCommit: (epoch, c, w, ids, gi) => (hasFn(api, 'submitEventGroupMlsCommit')
      ? api.submitEventGroupMlsCommit(orgId, eventId, epoch, c, w, ids, gi)
      : api.submitEventGroupCommit(orgId, eventId, epoch, c, w, ids)),
    getGroupInfo: hasFn(api, 'getEventGroupMlsGroupInfo') ? () => api.getEventGroupMlsGroupInfo(orgId, eventId) : null,
    putGroupInfo: hasFn(api, 'putEventGroupMlsGroupInfo') ? (epoch, gi) => api.putEventGroupMlsGroupInfo(orgId, eventId, epoch, gi) : null,
    submitExternal: hasFn(api, 'submitEventGroupMlsExternalCommit') ? (epoch, c, gi) => api.submitEventGroupMlsExternalCommit(orgId, eventId, epoch, c, gi) : null,
  };
  groupCtx.set(eventId, ctx);
  return ctx;
}

function dmContext(api, otherUserId, convId) {
  const ctx = {
    kind: 'dm', api, groupIdStr: convId, otherUserId,
    fetchCatchUp: () => api.getDmMlsCatchUp(otherUserId),
    fetchMemberIds: null, // fixed: the two participants
    submitCommit: (epoch, c, w, _ids, gi) => (hasFn(api, 'submitDmMlsCommit')
      ? api.submitDmMlsCommit(otherUserId, epoch, c, w, gi)
      : api.submitDmCommit(otherUserId, epoch, c, w)),
    getGroupInfo: hasFn(api, 'getDmMlsGroupInfo') ? () => api.getDmMlsGroupInfo(otherUserId) : null,
    putGroupInfo: hasFn(api, 'putDmMlsGroupInfo') ? (epoch, gi) => api.putDmMlsGroupInfo(otherUserId, epoch, gi) : null,
    submitExternal: hasFn(api, 'submitDmMlsExternalCommit') ? (epoch, c, gi) => api.submitDmMlsExternalCommit(otherUserId, epoch, c, gi) : null,
  };
  groupCtx.set(convId, ctx);
  return ctx;
}

// ── Catch-up ──────────────────────────────────────────────────────────────

// mls_commit/mls_welcome are relayed over plain NATS core pub/sub (see
// nats.ts) with no replay — a device that isn't connected via SSE at the
// exact publish instant loses that Commit/Welcome forever, with nothing to
// self-heal from. mlsGroupController.ts's catch-up endpoints durably log
// every commit/welcome server-side; this pulls whatever this device hasn't
// applied yet, so a device that's simply been offline (or never received a
// live event at all — the common case for a fresh install/migrated
// machine) can catch itself up instead of relying on being online at the
// right millisecond. Called at the top of every ensure*Group.
//
// → { ok, held, localEpoch, serverEpoch, groupInfoEpoch, diverged }
// `diverged`: this device holds the group but can't get to the server's
// epoch from its copy (a commit in the log doesn't apply) — heal by resync.
async function catchUpGroup(ctx) {
  const groupIdStr = ctx.groupIdStr;
  const groupId = textEncoder.encode(groupIdStr);
  const { data, error } = await ctx.fetchCatchUp(); // network: outside the lock (I3)
  if (!data) {
    if (error) mlsLog('warn', 'catch-up fetch failed', { groupId: groupIdStr, error });
    const held = !!deviceStateCache && group_exists(deviceStateCache, groupId);
    return { ok: false, held, localEpoch: held ? Number(group_epoch(deviceStateCache, groupId)) : null, serverEpoch: null, groupInfoEpoch: null, diverged: false };
  }
  let removed = false;
  let welcomed = false;
  const result = await withStateLock(async () => {
    // Applied to the CURRENT state, not whatever existed before the fetch (I2).
    let state = currentState();
    const before = labelsIn(state, groupId);
    let changed = false;

    // Evicted copy: dropped so that ensureReconciledGroup / healGroup re-join
    // (and a usable Welcome applies below). Checked again after the commit
    // loop: the removal may be in this batch.
    const dropIfEvicted = () => {
      const kept = withoutEvictedCopy(state, groupId);
      if (kept === state) return false;
      state = kept;
      changed = true;
      return true;
    };
    dropIfEvicted();

    if (data.welcome && !group_exists(state, groupId)) {
      try {
        state = join_from_welcome(state, fromB64(data.welcome.welcome));
        changed = true;
        welcomed = true;
      } catch (err) {
        // Usually not meant for this device (another device of this account,
        // or a KeyPackage it no longer holds) — the external join covers it.
        mlsLog('debug', 'catch-up welcome not usable by this device', { groupId: groupIdStr, error: err });
      }
    }

    let epoch = null;
    let failedAt = null;
    let applied = 0; // S3: commits this catch-up applied (mlsHealth)
    if (group_exists(state, groupId)) {
      epoch = Number(group_epoch(state, groupId));
      const commits = [...(data.commits ?? [])].sort((a, b) => Number(a.epoch) - Number(b.epoch));
      for (const c of commits) {
        // A logged commit's epoch is the epoch it produces; anything at or
        // below ours is already applied (or predates our welcome).
        if (Number(c.epoch) <= epoch) continue;
        try {
          state = process_commit(state, groupId, fromB64(c.commit));
          epoch = Number(group_epoch(state, groupId));
          changed = true;
          applied += 1;
          if (!group_is_active(state, groupId)) break; // evicted: nothing later applies
        } catch (err) {
          if (Number(c.epoch) === epoch + 1 && failedAt === null) {
            failedAt = Number(c.epoch);
            mlsLog('warn', 'logged commit does not apply to this device\'s copy', { groupId: groupIdStr, commitEpoch: c.epoch, localEpoch: epoch, error: err });
          }
        }
      }
      if (dropIfEvicted()) epoch = null;
    }

    if (changed) {
      removed = anyRemoved(before, labelsIn(state, groupId));
      await commitDurableLocked(state);
    }
    return { changed, epoch, applied };
  });
  if (result.changed) emitGroupChange(groupIdStr, removed);
  // S3: a catch-up that applied commits arms stuck-group detection.
  if (result.epoch !== null && result.applied > 0) {
    try {
      setMlsHealthLogger(mlsLog);
      noteHealthCatchUp(groupIdStr, { commitsApplied: result.applied });
    } catch { /* health tracking is best-effort */ }
  }
  if (welcomed) maybeRefreshKeyPackage(ctx.api, boundUserId, { force: true });

  const held = result.epoch !== null;
  const logged = (data.commits ?? []).map((c) => Number(c.epoch));
  const hasServerEpoch = typeof data.current_epoch === 'number';
  const serverEpoch = hasServerEpoch ? data.current_epoch : (logged.length ? Math.max(...logged) : null);
  // With the server's own epoch, any mismatch is divergence; from the log
  // alone (an older server) only "behind" is certain.
  const diverged = held && serverEpoch !== null && serverEpoch > 0
    && (hasServerEpoch ? result.epoch !== serverEpoch : result.epoch < serverEpoch);
  const status = {
    ok: true, held, localEpoch: result.epoch, serverEpoch,
    groupInfoEpoch: data.group_info_epoch ?? null, diverged,
  };
  if (diverged) mlsLog('warn', 'group diverged from the server', { groupId: groupIdStr, localEpoch: result.epoch, serverEpoch });
  else if (hasServerEpoch) await maybeRefreshGroupInfo(ctx, status);
  return status;
}

// A group whose last commit came from a pre-2.0.1 client has no current
// GroupInfo on the server, so nobody could external-join it. Any member that
// is at the server's epoch re-uploads one (once per group+epoch).
const groupInfoRefreshed = new Set();
async function maybeRefreshGroupInfo(ctx, status) {
  if (!ctx.putGroupInfo || !status.held || status.serverEpoch === null || status.serverEpoch === 0) return;
  if (status.groupInfoEpoch === status.serverEpoch || status.localEpoch !== status.serverEpoch) return;
  const key = `${ctx.groupIdStr}:${status.serverEpoch}`;
  if (groupInfoRefreshed.has(key)) return;
  groupInfoRefreshed.add(key);
  try {
    const groupId = textEncoder.encode(ctx.groupIdStr);
    const state = deviceStateCache; // read-only (I4)
    if (!state || !group_exists(state, groupId) || Number(group_epoch(state, groupId)) !== status.serverEpoch) return;
    const { error } = await ctx.putGroupInfo(status.serverEpoch, toB64(export_group_info(state, groupId)));
    if (error) mlsLog('debug', 'GroupInfo re-upload refused', { groupId: ctx.groupIdStr, epoch: status.serverEpoch, error });
    else mlsLog('info', 're-uploaded a stale GroupInfo', { groupId: ctx.groupIdStr, epoch: status.serverEpoch });
  } catch (err) {
    mlsLog('warn', 'GroupInfo re-upload failed', { groupId: ctx.groupIdStr, error: err });
  }
}

// ── External join / resync ───────────────────────────────────────────────

const EXTERNAL_JOIN_ATTEMPTS = 5;
const JOIN_RETRY_BASE_MS = 100;

/**
 * Joins (not held) or resyncs (held, diverged or forced) one group from the
 * server's current GroupInfo by an external commit. Retries a lost epoch
 * race with a spread-out backoff. → { action: 'joined'|'resynced'|'none'|'absent'|'failed', reason? }
 *   absent: the server has no such group (genesis is the caller's call)
 *   none:   nothing done (unsupported server, or the race made it unnecessary)
 */
async function externalJoinOrResync(ctx, { force = false } = {}) {
  const groupIdStr = ctx.groupIdStr;
  const groupId = textEncoder.encode(groupIdStr);
  if (!ctx.getGroupInfo || !ctx.submitExternal) return { action: 'none', reason: 'unsupported' };

  for (let attempt = 0; attempt < EXTERNAL_JOIN_ATTEMPTS; attempt++) {
    const { data, error } = await ctx.getGroupInfo();
    if (error) {
      if (/^HTTP 404\b/.test(String(error))) return { action: 'none', reason: 'unsupported' };
      const reason = /not (a member|assigned|a participant|friends)|forbidden|403/i.test(String(error)) ? 'not_member' : 'group_info_error';
      mlsLog('warn', 'GroupInfo fetch failed', { groupId: groupIdStr, error, reason });
      return { action: 'failed', reason };
    }
    if (!data?.exists) return { action: 'absent' };
    if (!data.group_info) {
      mlsLog('warn', 'no current GroupInfo on the server yet; cannot join/resync', { groupId: groupIdStr, epoch: data.epoch, groupInfoEpoch: data.group_info_epoch });
      return { action: 'failed', reason: 'group_info_unavailable' };
    }
    const groupInfo = fromB64(data.group_info);
    const targetEpoch = Number(data.epoch) + 1;
    let resync = false;
    let r;
    try {
      r = await runOwnCommit((state) => {
        resync = group_exists(state, groupId);
        // A welcome/catch-up may have made us current while GroupInfo was in
        // flight — then there's nothing to heal (unless forced). An evicted
        // copy tracks the epoch too, but needs the re-join.
        if (resync && !force && group_is_active(state, groupId) && Number(group_epoch(state, groupId)) === Number(data.epoch)) return null;
        const res = resync
          ? resync_external(state, groupId, groupInfo)
          : join_external(state, groupInfo, ownCredential ?? device_credential(state));
        return { state: res.device_state, commit: res.commit, welcome: null, targetEpoch, groupInfo: res.group_info };
      }, (epoch, commitB64, _w, _ids, groupInfoB64) => ctx.submitExternal(epoch, commitB64, groupInfoB64), ctx.fetchCatchUp, groupIdStr);
    } catch (err) {
      if (err instanceof MlsStateUnavailableError) throw err;
      mlsLog('error', 'building the external commit failed', { groupId: groupIdStr, epoch: data.epoch, error: err });
      return { action: 'failed', reason: 'join_failed' };
    }
    if (r.skipped) return { action: 'none' };
    if (r.accepted) {
      mlsLog('info', resync ? 'resynced group by external commit' : 'joined group by external commit', { groupId: groupIdStr, epoch: targetEpoch });
      await removeOwnStaleLeaves(ctx);
      return { action: resync ? 'resynced' : 'joined' };
    }
    if (!r.conflict) {
      mlsLog('warn', 'external commit rejected', { groupId: groupIdStr, epoch: targetEpoch, error: r.error });
      return { action: 'failed', reason: 'rejected' };
    }
    // Lost the epoch race: a held, healthy copy may simply catch up now.
    const status = await catchUpGroup(ctx);
    if (status.held && !status.diverged && !force) return { action: 'none' };
    // Everyone joining a just-launched channel races for each epoch; spread
    // out, or the same devices lose every round.
    await sleep(JOIN_RETRY_BASE_MS * (attempt + 1) * (0.5 + Math.random()));
  }
  return { action: 'failed', reason: 'epoch_conflict' };
}

/**
 * After a re-join by a device that lost its state (new signature key, same
 * device id), the dead leaf with this device's label is still in the tree —
 * remove it (remove_member never removes our own leaf).
 */
async function removeOwnStaleLeaves(ctx) {
  const groupId = textEncoder.encode(ctx.groupIdStr);
  try {
    await runOwnCommit((state) => {
      if (!ownCredential || !group_exists(state, groupId)) return null;
      const copies = group_member_labels(state, groupId).filter((l) => l === ownCredential).length;
      if (copies <= 1) return null;
      const res = remove_member(state, groupId, [ownCredential]);
      return {
        state: res.device_state, commit: res.commit, welcome: null,
        targetEpoch: Number(group_epoch(state, groupId)) + 1, groupInfo: res.group_info,
      };
    }, ctx.submitCommit, ctx.fetchCatchUp, ctx.groupIdStr);
  } catch (err) {
    mlsLog('warn', 'removing this device\'s stale leaf failed', { groupId: ctx.groupIdStr, error: err });
  }
}

// ── Group setup / reconciliation ─────────────────────────────────────────

async function fetchDevicesOf(api, userIds) {
  const out = []; // { userId, deviceId, keyPackage }: devices that can be added now
  for (const userId of userIds) {
    const { data, error } = await api.getUserDeviceKeyPackages(userId);
    if (error) mlsLog('warn', 'key-package fetch failed', { userId, error });
    for (const d of data?.devices ?? []) {
      const keyPackage = fromB64(d.key_package);
      // One expired KeyPackage fails the whole add, which on a fresh channel
      // means no group for anyone. Left out, that device joins by itself.
      if (!key_package_usable(keyPackage)) {
        mlsLog('warn', 'skipping a device with an expired or invalid KeyPackage', { userId, deviceId: d.device_id });
        continue;
      }
      out.push({ userId, deviceId: d.device_id, keyPackage });
    }
  }
  return out;
}

/** The epoch-0→1 commit that starts a group: everyone addable, else just this device. */
function buildGenesis(state, groupId, devices) {
  if (devices.length > 0) {
    try {
      const soloState = create_group(state, groupId);
      const addResult = add_member(soloState, groupId, frame_key_packages(devices.map((d) => d.keyPackage)));
      return {
        state: addResult.device_state,
        commit: addResult.commit,
        welcome: addResult.welcome,
        targetEpoch: Number(group_epoch(soloState, groupId)) + 1,
        welcomedUserIds: [...new Set(devices.map((d) => d.userId))],
        groupInfo: addResult.group_info,
      };
    } catch (err) {
      mlsLog('warn', 'could not add the channel\'s other devices at genesis; starting the group alone', { groupId: textDecoder.decode(groupId), error: err });
    }
  }
  const solo = create_solo_group(state, groupId);
  return { state: solo.device_state, commit: solo.commit, welcome: null, targetEpoch: 1, groupInfo: solo.group_info };
}

/**
 * Creates a group from scratch. Only called once the server has said the
 * group doesn't exist (GET …/mls/group-info → exists:false) — or, against a
 * server without that route, as the old guess. Nothing is persisted unless
 * the server confirms epoch 0->1 landed; on a 409 (someone else created it
 * first) local state stays untouched and the caller external-joins instead.
 *
 * With nobody addable the group still starts, with this device alone:
 * otherwise the first member of a channel waits for a key forever, and the
 * others have no group to external-join when they arrive. Only a server
 * without GroupInfo (so without external joins) skips that.
 */
async function attemptGroupGenesis(api, ctx, otherMemberIds) {
  const groupId = textEncoder.encode(ctx.groupIdStr);
  const devices = await fetchDevicesOf(api, otherMemberIds);
  if (devices.length === 0 && !ctx.getGroupInfo) return { accepted: false, skipped: true };

  return runOwnCommit((state) => {
    // A welcome may have arrived while the key packages were being fetched.
    if (group_exists(state, groupId)) return null;
    return buildGenesis(state, groupId, devices);
  }, ctx.submitCommit, ctx.fetchCatchUp, ctx.groupIdStr);
}

/**
 * Reconciles an already-joined group's membership against `currentMemberIds`
 * — used by both channel and event groups (DM's 2-party case has its own
 * simpler version in ensureGroupWithMember). Diffs by (userId, deviceId),
 * not just userId: checking only "is this user represented by *any* device"
 * leaves a user's *second* device invisible forever once their first device
 * is already a member. Each diff is recomputed against the current state
 * inside runOwnCommit, so a commit/welcome processed while the key packages
 * were being fetched can't produce a stale or duplicate commit.
 */
async function reconcileGroupDevices(api, currentUserId, ctx, currentMemberIds) {
  const groupId = textEncoder.encode(ctx.groupIdStr);

  await runOwnCommit((state) => {
    if (!group_exists(state, groupId)) return null;
    const staleLabels = [...new Set(group_member_labels(state, groupId).filter((label) => !currentMemberIds.has(userIdOfLabel(label))))];
    if (staleLabels.length === 0) return null;
    const removeResult = remove_member(state, groupId, staleLabels);
    return {
      state: removeResult.device_state,
      commit: removeResult.commit,
      welcome: null,
      targetEpoch: Number(group_epoch(state, groupId)) + 1,
      welcomedUserIds: [],
      groupInfo: removeResult.group_info,
    };
  }, ctx.submitCommit, ctx.fetchCatchUp, ctx.groupIdStr);

  const otherMemberIds = [...currentMemberIds].filter((id) => id !== currentUserId);
  const devices = await fetchDevicesOf(api, otherMemberIds);
  if (devices.length === 0) return;

  await runOwnCommit((state) => {
    if (!group_exists(state, groupId)) return null;
    const currentLabels = new Set(group_member_labels(state, groupId));
    const missing = devices.filter((d) => !currentLabels.has(credentialFor(d.userId, d.deviceId)));
    if (missing.length === 0) return null;
    const addResult = add_member(state, groupId, frame_key_packages(missing.map((d) => d.keyPackage)));
    return {
      state: addResult.device_state,
      commit: addResult.commit,
      welcome: addResult.welcome,
      targetEpoch: Number(group_epoch(state, groupId)) + 1,
      welcomedUserIds: [...new Set(missing.map((d) => d.userId))],
      groupInfo: addResult.group_info,
    };
  }, ctx.submitCommit, ctx.fetchCatchUp, ctx.groupIdStr);
}

async function ensureGroupWithMember(api, currentUserId, ctx) {
  await ensureIdentity(api, currentUserId);
  const groupId = textEncoder.encode(ctx.groupIdStr);
  const otherUserId = ctx.otherUserId;

  const status = await catchUpGroup(ctx);

  // Not held, or diverged: join/resync from the server's GroupInfo. Creating
  // the group is only allowed once the server says it doesn't exist (or the
  // server predates GroupInfo — the old guess, guarded by its 409).
  let mayCreate = true;
  if (!group_exists(deviceStateCache, groupId) || status.diverged) {
    const heal = await externalJoinOrResync(ctx);
    mayCreate = heal.action === 'absent' || heal.reason === 'unsupported';
  }

  const devices = await fetchDevicesOf(api, [otherUserId]);
  if (devices.length === 0) return;

  // Only adopt the new state if the server actually accepted this Commit —
  // a 409 here means the other side already established this group with us
  // (or beat us to genesis in a concurrent race); state stays untouched and
  // the next call external-joins instead of forking.
  const r = await runOwnCommit((state) => {
    if (!group_exists(state, groupId)) {
      if (!mayCreate) return null;
      const soloState = create_group(state, groupId);
      const addResult = add_member(soloState, groupId, frame_key_packages(devices.map((d) => d.keyPackage)));
      return {
        state: addResult.device_state,
        commit: addResult.commit,
        welcome: addResult.welcome,
        targetEpoch: Number(group_epoch(soloState, groupId)) + 1,
        groupInfo: addResult.group_info,
      };
    }
    // Already a member — add any of the other side's devices that aren't
    // represented yet (their second device, never added).
    const labels = group_member_labels(state, groupId);
    const missing = devices.filter((d) => !labels.includes(credentialFor(otherUserId, d.deviceId)));
    if (missing.length === 0) return null;
    const addResult = add_member(state, groupId, frame_key_packages(missing.map((d) => d.keyPackage)));
    return {
      state: addResult.device_state,
      commit: addResult.commit,
      welcome: addResult.welcome,
      targetEpoch: Number(group_epoch(state, groupId)) + 1,
      groupInfo: addResult.group_info,
    };
  }, ctx.submitCommit, ctx.fetchCatchUp, ctx.groupIdStr);

  if (r.conflict && !group_exists(deviceStateCache, groupId)) {
    // Lost the genesis race: the group exists now — join it.
    await catchUpGroup(ctx);
    if (!group_exists(deviceStateCache, groupId)) await externalJoinOrResync(ctx);
  }
}

/**
 * Shared body of ensureChannelGroup/ensureEventGroup.
 * → { held, reason } — `held` means a key can be exported now; otherwise
 * `reason` says why not: not_on_list, or externalJoinOrResync's reason.
 */
async function ensureReconciledGroup(api, currentUserId, ctx) {
  await ensureIdentity(api, currentUserId);
  const groupId = textEncoder.encode(ctx.groupIdStr);

  const status = await catchUpGroup(ctx);
  const currentMemberIds = await ctx.fetchMemberIds();

  // EVMLS: a user outside the group's membership list (not signed up to the
  // event, or removed from it) never commits: no join, no genesis (it would
  // create a group nobody else may join), no reconcile (it would try to
  // remove everyone else, or itself). The server refuses such commits anyway.
  if (!currentMemberIds.has(currentUserId)) return { held: false, reason: 'not_on_list' };

  let reason = null;
  for (let round = 0; round < 2; round++) {
    const held = group_exists(deviceStateCache, groupId);
    if (held && !(round === 0 && status.diverged)) break;
    const heal = await externalJoinOrResync(ctx);
    reason = heal.reason ?? null;
    if (group_exists(deviceStateCache, groupId) || held) break;
    if (heal.action !== 'absent' && heal.reason !== 'unsupported') break;
    // The server has no such group (or predates GroupInfo): create it. On a
    // lost race (409) the next round joins the winner's group.
    const toAdd = [...currentMemberIds].filter((id) => id !== currentUserId);
    const g = await attemptGroupGenesis(api, ctx, toAdd);
    if (!g.conflict) break;
    await catchUpGroup(ctx);
    if (heal.reason === 'unsupported') break; // old server: wait for the winner's Welcome
  }

  if (group_exists(deviceStateCache, groupId)) {
    // This device's key doesn't depend on who else gets added: whatever goes
    // wrong for another device must not stop the caller exporting its own.
    try {
      await reconcileGroupDevices(api, currentUserId, ctx, currentMemberIds);
    } catch (err) {
      if (err instanceof MlsStateUnavailableError) throw err;
      mlsLog('warn', 'reconcile failed; the group is unchanged', { groupId: ctx.groupIdStr, error: err });
    }
  }
  // If our commit lost a race (409), the winner's commit advanced the epoch —
  // pull it in so the local state matches the server before secret export.
  await catchUpGroup(ctx);
  const held = group_exists(deviceStateCache, groupId);
  return { held, reason: held ? null : reason ?? 'no_group' };
}

// ── Healing ──────────────────────────────────────────────────────────────

const HEAL_MIN_INTERVAL_MS = 60_000;
const lastHealAt = new Map(); // groupIdStr -> ms

/**
 * One group: catch up, then (if on its member list) external-join when not
 * held, resync when diverged or forced. Never creates a group.
 * → { action, reason? } (see externalJoinOrResync; plus 'skipped' when not
 * on the member list)
 */
async function healGroup(currentUserId, ctx, { force = false } = {}) {
  const groupId = textEncoder.encode(ctx.groupIdStr);
  lastHealAt.set(ctx.groupIdStr, Date.now());
  const status = await catchUpGroup(ctx);
  if (ctx.fetchMemberIds) {
    const members = await ctx.fetchMemberIds();
    if (!members.has(currentUserId)) return { action: 'skipped', reason: 'not_on_list' };
  }
  const held = group_exists(deviceStateCache, groupId);
  if (held && !status.diverged && !force) return { action: 'none' };
  return externalJoinOrResync(ctx, { force });
}

/** Debounced background heal of one group (decrypt failures, unappliable live commit). */
function scheduleHeal(groupIdStr, why) {
  const ctx = groupCtx.get(groupIdStr);
  if (!ctx || !boundUserId) {
    mlsLog('warn', 'group needs healing but its context is unknown on this device yet', { groupId: groupIdStr, why });
    return;
  }
  const last = lastHealAt.get(groupIdStr) ?? 0;
  if (Date.now() - last < HEAL_MIN_INTERVAL_MS) return;
  lastHealAt.set(groupIdStr, Date.now());
  const userId = boundUserId;
  const gen = sessionGen;
  mlsLog('warn', 'healing group', { groupId: groupIdStr, why });
  setTimeout(() => {
    if (gen !== sessionGen) return;
    healGroup(userId, ctx)
      .then((r) => {
        if (r.action === 'failed') mlsLog('error', 'group heal failed', { groupId: groupIdStr, why, reason: r.reason });
        reportDeviceStatus(ctx.api, [{ groupIdStr, status: healStatus(r) }]);
      })
      .catch((err) => mlsLog('error', 'group heal threw', { groupId: groupIdStr, why, error: err }));
  }, 0);
}

function healStatus(r) {
  if (r.action === 'failed') return `${r.action}:${r.reason ?? 'unknown'}`.slice(0, 120);
  return r.reason ? `${r.action}:${r.reason}` : r.action;
}

/** Diagnostics: this device's epoch per group → POST /mls/device-status (fire and forget). */
function reportDeviceStatus(api, entries) {
  if (!hasFn(api, 'reportMlsDeviceStatus') || !ownCredential || entries.length === 0) return;
  const groups = entries.slice(0, 500).map(({ groupIdStr, status }) => ({
    group_id: groupIdStr, epoch: groupEpoch(groupIdStr), status: status ?? null,
  }));
  Promise.resolve(api.reportMlsDeviceStatus(deviceIdOfLabel(ownCredential), groups))
    .then((r) => { if (r?.error) mlsLog('debug', 'device status report failed', { error: r.error }); })
    .catch(() => {});
}

const inflightOrgHeals = new Map(); // `${orgId}:${force}` -> promise

/**
 * For each channel of the org the user can access, and each launched event's
 * group they're in: catch up, and if not a member or diverged (or `force`)
 * external-join / resync. Sequential, through the state lock like every other
 * MLS write. Concurrent identical calls share one run.
 * → { healed: [groupId], failed: [{ groupId, reason }], checked: n }
 */
export function healOrgEncryption(api, userId, orgId, { force = false } = {}) {
  const key = `${orgId}:${force}`;
  const existing = inflightOrgHeals.get(key);
  if (existing) return existing;
  const run = healOrgImpl(api, userId, orgId, force).finally(() => {
    if (inflightOrgHeals.get(key) === run) inflightOrgHeals.delete(key);
  });
  inflightOrgHeals.set(key, run);
  return run;
}

async function healOrgImpl(api, userId, orgId, force) {
  const result = { healed: [], failed: [], checked: 0 };
  try {
    await ensureIdentity(api, userId);
  } catch (err) {
    result.failed.push({ groupId: orgId, reason: 'state_unavailable' });
    mlsLog('error', 'org heal: no usable MLS identity', { orgId, code: err?.code, error: err });
    return result;
  }

  const contexts = [];
  const seenChannels = new Set();
  const addChannel = (chanId) => {
    if (!chanId || seenChannels.has(chanId)) return;
    seenChannels.add(chanId);
    contexts.push(channelContext(api, orgId, chanId));
  };
  const { data: chData, error: chError } = await api.getChannels(orgId);
  if (Array.isArray(chData?.channels)) {
    for (const ch of chData.channels) addChannel(ch?.id);
  } else {
    result.failed.push({ groupId: orgId, reason: 'channel_list_unavailable' });
    mlsLog('warn', 'org heal: channel list unavailable', { orgId, error: chError });
  }
  if (hasFn(api, 'getOrgEvents')) {
    const { data: evData } = await api.getOrgEvents(orgId);
    for (const ev of evData?.events ?? []) {
      if (!ev?.id || !ev.launched) continue;
      contexts.push(eventContext(api, orgId, ev.id));
      // The channel list hides frequency channels; this user's are on their
      // assignment.
      if (hasFn(api, 'getMyEventAssignment')) {
        const { data } = await api.getMyEventAssignment(orgId, ev.id);
        for (const a of data?.assignments ?? []) addChannel(a?.channel_id);
        for (const f of data?.frequencies ?? []) addChannel(f?.channel_id);
      }
    }
  }

  const report = [];
  for (const ctx of contexts) {
    try {
      const r = await healGroup(userId, ctx, { force });
      if (r.action === 'skipped') continue;
      result.checked += 1;
      if (r.action === 'joined' || r.action === 'resynced') result.healed.push(ctx.groupIdStr);
      else if (r.action === 'failed') result.failed.push({ groupId: ctx.groupIdStr, reason: r.reason ?? 'unknown' });
      report.push({ groupIdStr: ctx.groupIdStr, status: healStatus(r) });
    } catch (err) {
      if (err instanceof MlsStateUnavailableError) {
        result.failed.push({ groupId: ctx.groupIdStr, reason: 'state_unavailable' });
        break;
      }
      result.checked += 1;
      result.failed.push({ groupId: ctx.groupIdStr, reason: String(err?.message ?? err).slice(0, 120) });
      mlsLog('error', 'org heal: group failed', { orgId, groupId: ctx.groupIdStr, error: err });
    }
  }
  if (result.healed.length || result.failed.length) {
    mlsLog(result.failed.length ? 'warn' : 'info', 'org encryption heal finished', {
      orgId, force, checked: result.checked, healed: result.healed.length, failed: result.failed.length,
    });
  }
  reportDeviceStatus(api, report);
  return result;
}

// ── Per-group repair ladder steps (S4, driven by engine/mlsRepair.js) ─────

/** Drops this device's copy of one group (I1/I2: under the lock; I5: durable). → dropped? */
async function dropLocalGroupCopy(groupIdStr) {
  const groupId = textEncoder.encode(groupIdStr);
  const dropped = await withStateLock(async () => {
    const state = currentState();
    if (!group_exists(state, groupId)) return false;
    await commitDurableLocked(delete_group(state, groupId));
    return true;
  });
  if (dropped) emitGroupChange(groupIdStr, false);
  return dropped;
}

/**
 * One step of the automatic repair ladder for ONE group this device already
 * has a context for (it was opened / synced / decrypted this session). Never
 * touches another group.
 *   'sync'   catch up to the server's epoch (a diverged copy goes to the
 *            normal heal), then re-export: every key consumer re-derives on
 *            a group change.
 *   'ensure' the full ensure*Group path (join / resync if diverged, reconcile).
 *   'reset'  forced re-join: publish a fresh KeyPackage, then resync_external
 *            (drops the local copy and, in the same external commit, removes
 *            our old leaf). If the local copy is too broken to build that
 *            (join_failed) or the server rejected it, delete the copy, apply
 *            the newest Welcome if one is for us, else join fresh by external
 *            commit (which also removes our stale leaf). A copy is never
 *            dropped when the server can't take an external commit at all
 *            (unsupported / no GroupInfo / not on the member list): nothing
 *            would re-add this device then.
 * → { action, reason? } (see externalJoinOrResync), or 'synced'/'ensured'.
 */
export async function repairGroupStep(api, currentUserId, groupIdStr, step) {
  await ensureIdentity(api, currentUserId);
  const ctx = groupCtx.get(groupIdStr);
  if (!ctx) {
    mlsLog('warn', 'repair: group context unknown on this device', { groupId: groupIdStr, step });
    return { action: 'failed', reason: 'no_context' };
  }
  const groupId = textEncoder.encode(groupIdStr);
  lastHealAt.set(groupIdStr, Date.now()); // the background heal stays out of the way

  if (step === 'sync') {
    const status = await catchUpGroup(ctx);
    if (status.diverged) return healGroup(currentUserId, ctx);
    emitGroupChange(groupIdStr, false);
    return { action: 'synced', reason: status.held ? null : 'not_held' };
  }

  if (step === 'ensure') {
    const r = ctx.kind === 'dm'
      ? await ensureDmGroup(api, currentUserId, ctx.otherUserId, groupIdStr).then(() => ({ held: group_exists(deviceStateCache, groupId) }))
      : await ensureReconciledGroup(api, currentUserId, ctx);
    emitGroupChange(groupIdStr, false);
    return { action: 'ensured', reason: r?.held ? null : (r?.reason ?? 'not_held') };
  }

  if (step !== 'reset') return { action: 'failed', reason: 'unknown_step' };

  if (ctx.fetchMemberIds) {
    let members;
    try {
      members = await ctx.fetchMemberIds();
    } catch (err) {
      mlsLog('warn', 'repair reset: member list unavailable; keeping the local copy', { groupId: groupIdStr, error: err });
      return { action: 'failed', reason: 'member_list_unavailable' };
    }
    if (!members.has(currentUserId)) return { action: 'skipped', reason: 'not_on_list' };
  }
  maybeRefreshKeyPackage(api, currentUserId, { force: true });

  const r = await externalJoinOrResync(ctx, { force: true });
  if (r.action === 'resynced' || r.action === 'joined') {
    await catchUpGroup(ctx);
    return r;
  }
  if (r.reason !== 'join_failed' && r.reason !== 'rejected') {
    mlsLog('warn', 'repair reset: forced re-join not possible; keeping the local copy', { groupId: groupIdStr, action: r.action, reason: r.reason });
    return r;
  }
  mlsLog('warn', 'repair reset: dropping this device\'s copy of the group and re-joining', { groupId: groupIdStr, reason: r.reason });
  await dropLocalGroupCopy(groupIdStr);
  await catchUpGroup(ctx); // the newest Welcome, if one is meant for this device
  if (group_exists(deviceStateCache, groupId)) return { action: 'welcomed' };
  const j = await externalJoinOrResync(ctx);
  await catchUpGroup(ctx);
  return { ...j, dropped: true };
}

// ── Local epoch ──────────────────────────────────────────────────────────

let epochMemo = { version: -1, map: new Map() };

/** This device's epoch for a group (number), or null if it doesn't hold it / no state. Read-only (I4). */
export function groupEpoch(groupIdStr) {
  if (!deviceStateCache) return null;
  if (epochMemo.version !== stateVersion) epochMemo = { version: stateVersion, map: new Map() };
  if (epochMemo.map.has(groupIdStr)) return epochMemo.map.get(groupIdStr);
  let epoch = null;
  try {
    const groupId = textEncoder.encode(groupIdStr);
    if (group_exists(deviceStateCache, groupId)) epoch = Number(group_epoch(deviceStateCache, groupId));
  } catch { /* null */ }
  epochMemo.map.set(groupIdStr, epoch);
  return epoch;
}

// ── Application messages ─────────────────────────────────────────────────

async function encryptGroup(api, currentUserId, groupIdStr, plaintext) {
  await ensureIdentity(api, currentUserId);
  const groupId = textEncoder.encode(groupIdStr);
  // S7: a v2 envelope (engine/frank.js) is passed as bytes; text as a string.
  const plainBytes = plaintext instanceof Uint8Array ? plaintext : textEncoder.encode(plaintext);
  // Durable before the ciphertext is returned (and therefore sent): a crash
  // must never make this device reuse a sender-ratchet generation.
  const ciphertext = await withStateLock(async () => {
    const result = encrypt(currentState(), groupId, plainBytes);
    await commitDurableLocked(result.device_state);
    return result.ciphertext;
  });
  return toB64(ciphertext);
}

// Current-epoch decrypt failures per group: a few in a row from other
// accounts mean this device's copy forked (same epoch number, different
// keys) — heal it.
const DIVERGENCE_FAILURES = 3;
const DIVERGENCE_WINDOW_MS = 120_000;
const decryptFailures = new Map(); // groupIdStr -> { count, since }

function noteCurrentEpochFailure(groupIdStr) {
  const now = Date.now();
  const f = decryptFailures.get(groupIdStr);
  const entry = f && now - f.since < DIVERGENCE_WINDOW_MS ? { count: f.count + 1, since: f.since } : { count: 1, since: now };
  decryptFailures.set(groupIdStr, entry);
  if (entry.count >= DIVERGENCE_FAILURES) {
    decryptFailures.delete(groupIdStr);
    scheduleHeal(groupIdStr, 'current_epoch_decrypt_failures');
  }
}

/** One locked decrypt attempt → { plaintext } | { error, localEpoch } (never throws for MLS failures). */
function tryDecryptLocked(groupId, ciphertext) {
  return withStateLock(() => {
    const state = currentState();
    if (!group_exists(state, groupId)) return { error: 'group not held', localEpoch: null };
    const localEpoch = Number(group_epoch(state, groupId));
    try {
      const result = decrypt(state, groupId, ciphertext);
      commitState(result.device_state); // decrypt-only: lazily persisted (I5)
      return { plaintext: plaintextFromBytes(result.plaintext), localEpoch };
    } catch (err) {
      return { error: err, localEpoch };
    }
  });
}

/**
 * Epoch-aware decrypt. A message from an epoch this device hasn't reached
 * yet (it outran its commit) → catch up, then retry; still ahead →
 * epoch_ahead_unresolved. Older epochs decrypt within the kept window
 * (mls-crypto MAX_PAST_EPOCHS), else epoch_too_old. Throws MlsDecryptError.
 */
async function decryptGroupTyped(api, currentUserId, groupIdStr, ciphertextB64) {
  try {
    await ensureIdentity(api, currentUserId);
  } catch (err) {
    throw new MlsDecryptError('state_unavailable', String(err?.message ?? err), { groupId: groupIdStr, code: err?.code });
  }
  const groupId = textEncoder.encode(groupIdStr);
  let ciphertext;
  let msgEpoch;
  try {
    ciphertext = fromB64(ciphertextB64);
    msgEpoch = Number(message_epoch(ciphertext));
  } catch (err) {
    throw new MlsDecryptError('corrupt', 'not an MLS message', { groupId: groupIdStr });
  }

  let attempt;
  try {
    attempt = await tryDecryptLocked(groupId, ciphertext);
  } catch (err) {
    throw new MlsDecryptError('state_unavailable', String(err?.message ?? err), { groupId: groupIdStr, code: err?.code });
  }
  if (attempt.plaintext !== undefined) {
    decryptFailures.delete(groupIdStr);
    return attempt.plaintext;
  }

  // Not held, or the message is ahead of us: catch up (if we know how) and retry.
  const ctx = groupCtx.get(groupIdStr);
  if (attempt.localEpoch === null || msgEpoch > attempt.localEpoch) {
    if (ctx) {
      let status = null;
      try {
        status = await catchUpGroup(ctx);
      } catch (err) {
        mlsLog('warn', 'catch-up before retrying a decrypt failed', { groupId: groupIdStr, error: err });
      }
      if (status?.diverged) scheduleHeal(groupIdStr, 'catch_up_cannot_reach_server_epoch');
      else if (status && !status.held) scheduleHeal(groupIdStr, 'not_member');
      try {
        attempt = await tryDecryptLocked(groupId, ciphertext);
      } catch (err) {
        throw new MlsDecryptError('state_unavailable', String(err?.message ?? err), { groupId: groupIdStr, code: err?.code });
      }
      if (attempt.plaintext !== undefined) {
        decryptFailures.delete(groupIdStr);
        return attempt.plaintext;
      }
    }
    if (attempt.localEpoch === null) {
      throw new MlsDecryptError('not_member', 'this device does not hold the group', { groupId: groupIdStr, messageEpoch: msgEpoch });
    }
    if (msgEpoch > attempt.localEpoch) {
      throw new MlsDecryptError('epoch_ahead_unresolved', 'message is from an epoch this device has not reached',
        { groupId: groupIdStr, messageEpoch: msgEpoch, localEpoch: attempt.localEpoch });
    }
  }

  if (msgEpoch < attempt.localEpoch) {
    throw new MlsDecryptError('epoch_too_old', 'message epoch secrets are no longer held',
      { groupId: groupIdStr, messageEpoch: msgEpoch, localEpoch: attempt.localEpoch });
  }
  throw new MlsDecryptError('corrupt', String(attempt.error?.message ?? attempt.error ?? 'decrypt failed'),
    { groupId: groupIdStr, messageEpoch: msgEpoch, localEpoch: attempt.localEpoch });
}

// ── Recognizing a device's own echoed-back message ──────────────────────
// MLS does not let a device decrypt an application message it authored
// itself (the sender-ratchet secret isn't retained for decryption on the
// same leaf — see mls-crypto's sender_cannot_decrypt_own_message test).
// Every account's own multi-device relay echoes a just-sent message back to
// the sender's *account*, though — including this exact device, not just
// the sender's other devices. The server-generated message id isn't known
// until that echo arrives, so there's nothing to key an optimistic local
// insert on; instead, remember recently-sent plaintexts per group and
// recall one (FIFO) when decrypt fails for a message whose sender_id is our
// own account. A different device on the same account sending concurrently
// would decrypt normally instead of hitting this path at all.
const pendingSent = new Map(); // groupIdStr -> string[] (oldest first)

export function notePendingSent(groupIdStr, plaintext) {
  const queue = pendingSent.get(groupIdStr) ?? [];
  queue.push(plaintext);
  pendingSent.set(groupIdStr, queue);
}

function takePendingSent(groupIdStr) {
  const queue = pendingSent.get(groupIdStr);
  if (!queue || queue.length === 0) return null;
  return queue.shift();
}

async function decryptGroupOrRecallOwn(api, currentUserId, groupIdStr, ciphertextB64, isOwnAccount) {
  try {
    return await decryptGroupTyped(api, currentUserId, groupIdStr, ciphertextB64);
  } catch (err) {
    if (isOwnAccount) {
      const recalled = takePendingSent(groupIdStr);
      if (recalled !== null) return recalled;
    }
    if (err instanceof MlsDecryptError) {
      // Own-account echoes fail by design; only other senders' failures at
      // our current epoch say anything about our copy of the group.
      if (err.reason === 'corrupt' && !isOwnAccount && err.localEpoch != null) noteCurrentEpochFailure(groupIdStr);
      mlsLog(err.reason === 'corrupt' || err.reason === 'state_unavailable' ? 'warn' : 'debug', 'decrypt failed', {
        groupId: groupIdStr, reason: err.reason, messageEpoch: err.messageEpoch, localEpoch: err.localEpoch,
      });
    }
    throw err;
  }
}

async function handleGroupWelcome(api, currentUserId, groupIdStr, welcomeB64) {
  await ensureIdentity(api, currentUserId);
  const groupId = textEncoder.encode(groupIdStr);
  const welcome = fromB64(welcomeB64);
  const joined = await withStateLock(async () => {
    const state = currentState();
    if (group_exists(state, groupId)) return false;
    let newState;
    try {
      newState = join_from_welcome(state, welcome);
    } catch (err) {
      mlsLog('debug', 'welcome not usable by this device', { groupId: groupIdStr, error: err });
      return false; // Not meant for this device — discard.
    }
    await commitDurableLocked(newState);
    return true;
  });
  if (joined) {
    emitGroupChange(groupIdStr, false);
    maybeRefreshKeyPackage(api, currentUserId, { force: true });
  }
}

async function handleGroupCommit(api, currentUserId, groupIdStr, commitB64) {
  await ensureIdentity(api, currentUserId);
  const groupId = textEncoder.encode(groupIdStr);
  const commit = fromB64(commitB64);
  let removed = false;
  const outcome = await withStateLock(async () => {
    const state = currentState();
    if (!group_exists(state, groupId)) return 'not_held';
    const localEpoch = Number(group_epoch(state, groupId));
    let newState;
    try {
      newState = process_commit(state, groupId, commit);
    } catch (err) {
      let commitEpoch = null;
      try { commitEpoch = Number(message_epoch(commit)); } catch { /* unparseable */ }
      // Older than our epoch: already applied (incl. our own echo) — fine.
      if (commitEpoch !== null && commitEpoch < localEpoch) return 'stale';
      mlsLog('warn', 'live commit could not be applied', { groupId: groupIdStr, commitEpoch, localEpoch, error: err });
      return commitEpoch !== null && commitEpoch > localEpoch ? 'behind' : 'unappliable';
    }
    newState = withoutEvictedCopy(newState, groupId);
    removed = anyRemoved(labelsIn(state, groupId), labelsIn(newState, groupId));
    await commitDurableLocked(newState);
    return 'applied';
  });
  if (outcome === 'applied') emitGroupChange(groupIdStr, removed);
  else if (outcome === 'behind' || outcome === 'unappliable') {
    // Missed commits (behind) are in the log; if they don't get us there
    // either, catch-up reports divergence and the group is resynced.
    const ctx = groupCtx.get(groupIdStr);
    if (!ctx) { scheduleHeal(groupIdStr, 'live_commit_unappliable'); return; }
    try {
      const status = await catchUpGroup(ctx);
      if (status.diverged || outcome === 'unappliable') scheduleHeal(groupIdStr, 'live_commit_unappliable');
    } catch (err) {
      mlsLog('warn', 'catch-up after an unappliable commit failed', { groupId: groupIdStr, error: err });
    }
  }
}

// ── DM-scoped wrappers (groupIdStr = the DM's conversation_id) ───────────

export async function ensureDmGroup(api, currentUserId, otherUserId, convId) {
  await ensureGroupWithMember(api, currentUserId, dmContext(api, otherUserId, convId));
}

export function encryptDm(api, currentUserId, convId, plaintext) {
  return encryptGroup(api, currentUserId, convId, plaintext);
}

export function decryptDmOrRecallOwn(api, currentUserId, convId, ciphertextB64, isOwnAccount) {
  return decryptGroupOrRecallOwn(api, currentUserId, convId, ciphertextB64, isOwnAccount);
}

export function handleDmWelcome(api, currentUserId, convId, welcomeB64) {
  return handleGroupWelcome(api, currentUserId, convId, welcomeB64);
}

export function handleDmCommit(api, currentUserId, convId, commitB64) {
  return handleGroupCommit(api, currentUserId, convId, commitB64);
}

// ── Channel-scoped wrappers (groupIdStr = channel_id) ────────────────────

// EVMLS: an older server has no /mls/members route (Express' default 404, no
// JSON body → "HTTP 404: …"). Only that falls back to the org member list; any
// other failure must not widen an event channel's group to the whole org.
const isMissingMembersRoute = (error) => typeof error === 'string' && /^HTTP 404\b/.test(error);

/**
 * EVMLS: the user ids a channel's MLS group should hold. Event channels (the
 * server classifies them) → only the members signed up to the event with
 * access to that channel; every other channel → the org's members, as before.
 * Reconciling against this list adds newly accepted members and removes
 * anyone who left the event / lost the role, so the key rotates with the roster.
 */
async function fetchChannelMemberIds(api, orgId, chanId) {
  if (typeof api.getChannelMlsMembers === 'function') {
    const { data, error } = await api.getChannelMlsMembers(orgId, chanId);
    if (Array.isArray(data?.user_ids)) return new Set(data.user_ids);
    if (!isMissingMembersRoute(error)) {
      throw new Error(`[mls] channel member list unavailable: ${error || 'no data'}`);
    }
  }
  const { data } = await api.getOrgMembers(orgId);
  return new Set((data?.members ?? []).map((m) => m.user_id));
}

/**
 * Establishes (or reconciles) the MLS group backing an org text channel.
 * Unlike a DM's fixed 2 participants, a channel's membership is the org's
 * current member list (see getOrgMembers) and can change at any time — so
 * this doesn't just create-once like ensureDmGroup, it also reconciles an
 * *existing* group: any org member/device not yet represented gets added,
 * and any group member whose account is no longer an org member gets
 * removed. Both happen in a single Commit each call, applied only if
 * there's actually a discrepancy — cheap to call every time a channel is
 * opened. A device that isn't in the group joins it itself by external
 * commit (v2.0.1), so it no longer waits for someone else's reconcile.
 *
 * EVMLS: for an event channel the membership list is not the org but the
 * channel's signed-up audience (fetchChannelMemberIds above) — WarRoom also
 * re-runs this for the event channels it holds on every event_roster_changed,
 * so an accept/leave rotates the key promptly rather than on the next open.
 * → { held, reason } (see ensureReconciledGroup).
 */
export function ensureChannelGroup(api, currentUserId, orgId, chanId) {
  return ensureReconciledGroup(api, currentUserId, channelContext(api, orgId, chanId));
}

export function encryptChannel(api, currentUserId, chanId, plaintext) {
  return encryptGroup(api, currentUserId, chanId, plaintext);
}

/**
 * Decrypts a channel message (MR1 frozen interface). Throws MlsDecryptError
 * with `.reason` (see the class). An own-account echo this device sent itself
 * is recalled from notePendingSent instead (isOwnAccount).
 */
export function decryptChannel(api, currentUserId, chanId, ciphertextB64, isOwnAccount) {
  return decryptGroupOrRecallOwn(api, currentUserId, chanId, ciphertextB64, isOwnAccount);
}

/** Pre-2.0.1 name of decryptChannel. */
export const decryptChannelOrRecallOwn = decryptChannel;

export function handleChannelWelcome(api, currentUserId, chanId, welcomeB64) {
  return handleGroupWelcome(api, currentUserId, chanId, welcomeB64);
}

export function handleChannelCommit(api, currentUserId, chanId, commitB64) {
  return handleGroupCommit(api, currentUserId, chanId, commitB64);
}

/**
 * Syncs the local group state to the server's current epoch by applying any
 * pending commits, without attempting any new membership commits. Use this
 * in key-refresh paths where you need the latest epoch but don't want to
 * trigger reconciliation (which would race against other clients and 409-loop).
 * A diverged group is handed to the (debounced, background) heal.
 */
export async function syncChannelGroupEpoch(api, currentUserId, orgId, chanId) {
  await ensureIdentity(api, currentUserId);
  const status = await catchUpGroup(channelContext(api, orgId, chanId));
  if (status.diverged) scheduleHeal(chanId, 'catch_up_cannot_reach_server_epoch');
}

/** Derives a fixed-length secret from a group's current epoch (see export_secret in mls-crypto). Read-only (I4). */
export async function exportGroupSecret(api, currentUserId, groupIdStr, label, length) {
  await ensureIdentity(api, currentUserId);
  return export_secret(deviceStateCache, textEncoder.encode(groupIdStr), label, length);
}

/**
 * Signs `messageBytes` with this device's Ed25519 MLS signature key — see
 * AudioFrame.sender_signature. Independent of group membership/encryption;
 * doesn't touch any group's ratchet state (read-only, I4).
 */
export async function signBytes(api, currentUserId, messageBytes) {
  await ensureIdentity(api, currentUserId);
  return sign_bytes(deviceStateCache, messageBytes);
}

/** Verifies a signBytes signature against a claimed sender's public key. Pure — no identity needed. */
export function verifySignature(publicKeyBytes, messageBytes, signatureBytes) {
  return verify_bytes(publicKeyBytes, messageBytes, signatureBytes);
}

// ── Event-scoped wrappers (groupIdStr = event_id) ────────────────────────
// Exists so a priority speaker's voice-cascade audio can be decrypted by
// every event participant, not just members of the speaker's own channel —
// see submitEventGroupCommit's doc comment (mlsGroupController.ts) for why
// "every accepted event_group_members row across the event's groups" is the
// membership set. No encrypt/decrypt wrappers: this group backs
// exportGroupSecret(..., eventId, 'audio-cascade', 32) directly (already
// fully generic over groupIdStr), not MLS application messages.

/**
 * Establishes (or reconciles) the MLS group backing an event's voice-cascade
 * key. Structurally identical to ensureChannelGroup — same catch-up-first,
 * external-join, genesis-only-when-absent, per-device reconcile design — just
 * sourced from event participants (api.getEventParticipants) and committed
 * via the event-group endpoints instead of org members / channel endpoints.
 */
export function ensureEventGroup(api, currentUserId, orgId, eventId) {
  return ensureReconciledGroup(api, currentUserId, eventContext(api, orgId, eventId));
}

/**
 * E2EV: event-group counterpart of syncChannelGroupEpoch — apply any pending
 * Welcome/commits for the event group WITHOUT submitting anything, so a
 * re-export of the 'audio-cascade' key reflects the server's current epoch.
 */
export async function syncEventGroupEpoch(api, currentUserId, orgId, eventId) {
  await ensureIdentity(api, currentUserId);
  const status = await catchUpGroup(eventContext(api, orgId, eventId));
  if (status.diverged) scheduleHeal(eventId, 'catch_up_cannot_reach_server_epoch');
}

export function handleEventGroupWelcome(api, currentUserId, eventId, welcomeB64) {
  return handleGroupWelcome(api, currentUserId, eventId, welcomeB64);
}

export function handleEventGroupCommit(api, currentUserId, eventId, commitB64) {
  return handleGroupCommit(api, currentUserId, eventId, commitB64);
}

// ── Read-only diagnostics (S2) ───────────────────────────────────────────

/**
 * What this device's local MLS state says about every group it holds:
 * { loaded, ownLabel, stateVersion, groups: [{ groupId, epoch, memberCount,
 * memberLabels, selfIsMember } | { groupId, error }] }.
 *
 * Read-only (I4): it takes ONE snapshot of the committed `deviceStateCache`
 * reference (states are replaced on commit, never mutated in place) and runs
 * only group_ids / group_epoch / group_member_labels on it — so the result is
 * a consistent view of a single committed version without queueing behind
 * (possibly network-bound) lock work. Nothing is written or persisted, and
 * only ids, epochs and credential labels (`${userId}:${deviceId}`) leave this
 * function — never key material. One unreadable group yields
 * { groupId, error } instead of failing the whole report.
 */
export async function getMlsDiagnostics() {
  const state = deviceStateCache; // single snapshot (I4)
  const version = stateVersion;
  const own = ownCredential;
  if (!state) return { loaded: false, ownLabel: own, stateVersion: version, groups: [] };
  await ensureWasm();
  let ids;
  try {
    ids = group_ids(state);
  } catch (err) {
    return { loaded: true, ownLabel: own, stateVersion: version, groups: [], error: logValue(err) };
  }
  const groups = [];
  for (const groupIdStr of Array.from(ids || [])) {
    try {
      const gid = textEncoder.encode(groupIdStr);
      const memberLabels = Array.from(group_member_labels(state, gid) || []).map(String);
      groups.push({
        groupId: String(groupIdStr),
        epoch: Number(group_epoch(state, gid)),
        memberCount: memberLabels.length,
        memberLabels,
        selfIsMember: !!own && memberLabels.includes(own),
      });
    } catch (err) {
      groups.push({ groupId: String(groupIdStr), error: logValue(err) });
    }
  }
  return { loaded: true, ownLabel: own, stateVersion: version, groups };
}

// ── S5: Reset encryption identity (last-resort manual repair) ─────────────
// (import kept here so this section stays append-only; ES imports hoist)
import { runResetSteps } from './utils/resetIdentity.js';

/**
 * Makes this PC a brand-new MLS device for the signed-in account: every group
 * it held is dropped, and other members' reconcile re-adds the new device
 * (keys arrive when another member opens each channel). The caller must
 * reload the engine afterwards — nothing in this window may keep using the
 * old groups.
 *
 * Why a NEW device id and not just an empty state: reconcile keys membership
 * on `${userId}:${deviceId}`, so a fresh keypair under the old id would look
 * already present to everyone and never be re-added (permanent lockout).
 * Why a fresh identity instead of an empty file: mls_save_state refuses empty
 * bodies (and the old devtools `{ state: [] }` call isn't a raw body, so
 * current builds reject it) — writing a fresh identity is exactly what a
 * first start does, minus the restart.
 *
 * Order (each step stops the sequence on failure, except register):
 *   1. load     — this window must hold the current state (Rust only accepts
 *                 writes from the window that loaded it).
 *   2. wipe     — forget the KeyPackage-refresh marker, then durably replace
 *                 the state with a fresh identity under a new device id,
 *                 and (still holding the lock) resetForUser: every
 *                 in-memory cache is dropped and queued lock work fails with
 *                 MLS_ACCOUNT_SWITCHED instead of writing. On load,
 *                 initIdentity re-derives the device id from the state's
 *                 credential, so a crash after this step is safe.
 *   3. deviceId — store the new device id (drop the legacy per-PC id if it
 *                 was the old one).
 *   4. register — publish the new device + KeyPackage (optional: if it fails
 *                 the next start re-registers, the refresh marker is gone).
 * The server has no endpoint to remove a device, so the OLD device row stays
 * (its leaf lingers in groups with no key behind it, until the server's
 * 90-day inactive-device revocation).
 *
 * → { oldLabel, newLabel, registered, oldDeviceDropped: false, warnings }
 */
export async function resetEncryptionIdentity(api, currentUserId) {
  const userId = currentUserId || boundUserId;
  if (!userId) throw new Error('Not signed in');
  if (!isTauri()) throw new Error('Only available in the SpecterComs desktop app');
  let oldLabel = null;
  let newDeviceId = null;
  let newLabel = null;
  let identity = null;
  mlsLog('warn', 'resetting this device\'s encryption identity (user action)', {});
  const { warnings } = await runResetSteps([
    {
      id: 'load', label: 'Load this device\'s encryption state',
      run: async () => {
        await ensureIdentity(api, userId);
        oldLabel = ownCredential;
      },
    },
    {
      id: 'wipe', label: 'Replace the encryption state with a new identity',
      run: async () => {
        await ensureWasm();
        storageRemove(keyPackageRefreshedKey(userId));
        newDeviceId = crypto.randomUUID();
        newLabel = credentialFor(userId, newDeviceId);
        identity = generate_identity(newLabel);
        await withStateLock(async () => {
          await commitDurableLocked(identity.device_state);
          // Still inside the lock: nothing queued behind us may run against
          // the fresh state with the old groups' bookkeeping (I7 semantics).
          resetForUser(userId);
        });
      },
    },
    {
      id: 'deviceId', label: 'Switch to the new device id',
      run: () => {
        const oldDeviceId = oldLabel ? deviceIdOfLabel(oldLabel) : null;
        if (oldDeviceId && storageGet(LEGACY_DEVICE_ID_KEY) === oldDeviceId) storageRemove(LEGACY_DEVICE_ID_KEY);
        storageSet(deviceIdKey(userId), newDeviceId);
      },
    },
    {
      id: 'register', label: 'Register the new device', optional: true,
      run: async () => {
        const res = await registerDevice(api, newDeviceId, identity, newLabel);
        if (res?.error) throw new Error(res.error);
        storageSet(keyPackageRefreshedKey(userId), String(Date.now()));
      },
    },
  ]);
  const registered = !warnings.some((w) => w.startsWith('Register'));
  mlsLog('warn', 'encryption identity reset', { oldLabel, newLabel, registered });
  return { oldLabel, newLabel, registered, oldDeviceDropped: false, warnings };
}
