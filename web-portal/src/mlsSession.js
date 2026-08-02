// mlsSession.js — client-side MLS (RFC 9420) session management.
//
// Wraps the mls-crypto WASM module with device-identity bootstrap, local
// persistence, and group setup for both DMs and org text channels. This
// device's MLS identity private key and every group's ratchet state live in
// a single opaque blob, encrypted at rest via the OS keyring (see
// mls_save_state/mls_load_state in web-portal/src-tauri/src/lib.rs) — Tauri
// desktop only for now; outside Tauri, identity never persists across
// restarts, so E2E doesn't establish.
import initMls, {
  generate_identity,
  group_exists,
  group_epoch,
  group_member_labels,
  create_group,
  add_member,
  remove_member,
  join_from_welcome,
  process_commit,
  encrypt,
  decrypt,
  export_secret,
  frame_key_packages,
} from 'mls-crypto';

let wasmReady = null;
function ensureWasm() {
  if (!wasmReady) wasmReady = initMls();
  return wasmReady;
}

const DEVICE_ID_KEY = 'specter_mls_device_id';

function getOrCreateDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

// Credential content is `${userId}:${deviceId}`, not an opaque label — group
// membership reconciliation (see reconcileChannelMembers below) needs to map
// an MLS group's current members back to real accounts (e.g. "this user left
// the org, remove all their devices"), which an arbitrary per-device label
// can't support on its own.
function credentialFor(userId, deviceId) {
  return `${userId}:${deviceId}`;
}

async function loadState() {
  if (!window.__TAURI__) return new Uint8Array(0);
  const bytes = await window.__TAURI__.core.invoke('mls_load_state');
  return new Uint8Array(bytes);
}

async function saveState(bytes) {
  if (!window.__TAURI__) return;
  await window.__TAURI__.core.invoke('mls_save_state', { state: Array.from(bytes) });
}

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

let deviceStateCache = null; // Uint8Array — in-memory copy of the last-persisted state

async function persist(newState) {
  deviceStateCache = newState;
  await saveState(newState);
}

/**
 * Loads (or, on first run, generates and registers) this device's MLS
 * identity. Safe to call repeatedly — a no-op once already established for
 * this session.
 */
export async function ensureIdentity(api, currentUserId) {
  await ensureWasm();
  if (deviceStateCache) return deviceStateCache;

  let state = await loadState();
  if (state.length === 0) {
    const deviceId = getOrCreateDeviceId();
    const credential = credentialFor(currentUserId, deviceId);
    const identity = generate_identity(credential);
    state = identity.device_state;
    await api.registerDevice(deviceId, toB64(identity.key_package), toB64(new TextEncoder().encode(credential)));
    await persist(state);
  } else {
    deviceStateCache = state;
  }
  return deviceStateCache;
}

// ── Generic group operations (shared by DM and channel wrappers below) ───

async function ensureGroupWithMember(api, currentUserId, groupIdStr, otherUserId, submitCommit) {
  const state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(groupIdStr);
  if (group_exists(state, groupId)) return;

  // Group genesis has no server-side commit (only the first add does), so
  // it's always safe to persist immediately as a checkpoint — the add below
  // is only persisted if the server actually accepted its Commit.
  const soloState = create_group(state, groupId);
  await persist(soloState);

  const { data } = await api.getUserDeviceKeyPackages(otherUserId);
  const devices = data?.devices ?? [];
  if (devices.length === 0) {
    // Other side has no registered device yet (hasn't opened the app since
    // this feature shipped) — leave the group solo for now; a later call
    // (once they do have a device) performs the real add.
    return;
  }

  const keyPackages = devices.map((d) => fromB64(d.key_package));
  const framed = frame_key_packages(keyPackages);
  const targetEpoch = Number(group_epoch(soloState, groupId)) + 1;
  const addResult = add_member(soloState, groupId, framed);

  // Only persist the add if the server actually accepted this Commit (i.e.
  // not a 409 epoch conflict from a concurrent commit elsewhere) — applying
  // it locally regardless would desync this device from everyone else, who
  // never received a Commit that was never actually relayed.
  const { error } = await submitCommit(targetEpoch, toB64(addResult.commit), toB64(addResult.welcome));
  if (!error) await persist(addResult.device_state);
}

async function encryptGroup(api, currentUserId, groupIdStr, plaintext) {
  const state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(groupIdStr);
  const result = encrypt(state, groupId, new TextEncoder().encode(plaintext));
  await persist(result.device_state);
  return toB64(result.ciphertext);
}

async function decryptGroup(api, currentUserId, groupIdStr, ciphertextB64) {
  const state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(groupIdStr);
  const result = decrypt(state, groupId, fromB64(ciphertextB64));
  await persist(result.device_state);
  return new TextDecoder().decode(result.plaintext);
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
    return await decryptGroup(api, currentUserId, groupIdStr, ciphertextB64);
  } catch (err) {
    if (!isOwnAccount) throw err;
    const recalled = takePendingSent(groupIdStr);
    if (recalled === null) throw err;
    return recalled;
  }
}

async function handleGroupWelcome(api, currentUserId, groupIdStr, welcomeB64) {
  const state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(groupIdStr);
  if (group_exists(state, groupId)) return;
  try {
    const newState = join_from_welcome(state, fromB64(welcomeB64));
    await persist(newState);
  } catch {
    // Not meant for this device — discard.
  }
}

async function handleGroupCommit(api, currentUserId, groupIdStr, commitB64) {
  const state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(groupIdStr);
  if (!group_exists(state, groupId)) return;
  try {
    const newState = process_commit(state, groupId, fromB64(commitB64));
    await persist(newState);
  } catch {
    // Already applied, or otherwise not actionable — discard.
  }
}

// ── DM-scoped wrappers (groupIdStr = the DM's conversation_id) ───────────

export async function ensureDmGroup(api, currentUserId, otherUserId, convId) {
  await ensureGroupWithMember(api, currentUserId, convId, otherUserId, (epoch, commitB64, welcomeB64) =>
    api.submitDmCommit(otherUserId, epoch, commitB64, welcomeB64));
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

/**
 * Establishes (or reconciles) the MLS group backing an org text channel.
 * Unlike a DM's fixed 2 participants, a channel's membership is the org's
 * current member list (see getOrgMembers) and can change at any time — so
 * this doesn't just create-once like ensureDmGroup, it also reconciles an
 * *existing* group: any org member not yet represented gets added, and any
 * group member whose account is no longer an org member gets removed. Both
 * happen in a single Commit each call, applied only if there's actually a
 * discrepancy — cheap to call every time a channel is opened. This is a
 * deliberately lazy design: membership updates propagate the next time
 * *anyone* opens the channel, not the instant someone joins/leaves the org.
 */
export async function ensureChannelGroup(api, currentUserId, orgId, chanId) {
  const state0 = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(chanId);

  const { data: memberData } = await api.getOrgMembers(orgId);
  const currentMemberIds = new Set((memberData?.members ?? []).map((m) => m.user_id));

  if (!group_exists(state0, groupId)) {
    // Group genesis has no server-side commit (only the first add does), so
    // it's always safe to persist immediately as a checkpoint.
    const soloState = create_group(state0, groupId);
    await persist(soloState);

    const toAdd = [...currentMemberIds].filter((id) => id !== currentUserId);
    const keyPackages = [];
    for (const userId of toAdd) {
      const { data } = await api.getUserDeviceKeyPackages(userId);
      for (const d of data?.devices ?? []) keyPackages.push(fromB64(d.key_package));
    }
    if (keyPackages.length > 0) {
      const framed = frame_key_packages(keyPackages);
      const targetEpoch = Number(group_epoch(soloState, groupId)) + 1;
      const addResult = add_member(soloState, groupId, framed);
      // Only persist if the server actually accepted this Commit — see the
      // identical note in ensureGroupWithMember.
      const { error } = await api.submitChannelCommit(orgId, chanId, targetEpoch, toB64(addResult.commit), toB64(addResult.welcome), toAdd);
      if (!error) await persist(addResult.device_state);
    }
    return;
  }

  // Reconcile an existing group: labels are "userId:deviceId" (see
  // credentialFor), so the userId prefix is enough to tell who a member
  // credential belongs to without a separate lookup. Each step only
  // persists locally once the server confirms it accepted the Commit —
  // otherwise this device would apply a change nobody else ever received.
  let state = state0;
  const labels = group_member_labels(state, groupId);
  const memberUserIdOf = (label) => label.slice(0, label.lastIndexOf(':'));

  const staleLabels = labels.filter((label) => !currentMemberIds.has(memberUserIdOf(label)));
  if (staleLabels.length > 0) {
    const targetEpoch = Number(group_epoch(state, groupId)) + 1;
    const removeResult = remove_member(state, groupId, staleLabels);
    const { error } = await api.submitChannelCommit(orgId, chanId, targetEpoch, toB64(removeResult.commit));
    if (!error) {
      state = removeResult.device_state;
      await persist(state);
    }
  }

  const representedUserIds = new Set(labels.map(memberUserIdOf));
  const missingUserIds = [...currentMemberIds].filter((id) => id !== currentUserId && !representedUserIds.has(id));
  if (missingUserIds.length > 0) {
    const keyPackages = [];
    for (const userId of missingUserIds) {
      const { data } = await api.getUserDeviceKeyPackages(userId);
      for (const d of data?.devices ?? []) keyPackages.push(fromB64(d.key_package));
    }
    if (keyPackages.length > 0) {
      const framed = frame_key_packages(keyPackages);
      const targetEpoch = Number(group_epoch(state, groupId)) + 1;
      const addResult = add_member(state, groupId, framed);
      const { error } = await api.submitChannelCommit(orgId, chanId, targetEpoch, toB64(addResult.commit), toB64(addResult.welcome), missingUserIds);
      if (!error) await persist(addResult.device_state);
    }
  }
}

export function encryptChannel(api, currentUserId, chanId, plaintext) {
  return encryptGroup(api, currentUserId, chanId, plaintext);
}

export function decryptChannelOrRecallOwn(api, currentUserId, chanId, ciphertextB64, isOwnAccount) {
  return decryptGroupOrRecallOwn(api, currentUserId, chanId, ciphertextB64, isOwnAccount);
}

export function handleChannelWelcome(api, currentUserId, chanId, welcomeB64) {
  return handleGroupWelcome(api, currentUserId, chanId, welcomeB64);
}

export function handleChannelCommit(api, currentUserId, chanId, commitB64) {
  return handleGroupCommit(api, currentUserId, chanId, commitB64);
}

/** Derives a fixed-length secret from a group's current epoch (see export_secret in mls-crypto). */
export async function exportGroupSecret(api, currentUserId, groupIdStr, label, length) {
  const state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(groupIdStr);
  return export_secret(state, groupId, label, length);
}
