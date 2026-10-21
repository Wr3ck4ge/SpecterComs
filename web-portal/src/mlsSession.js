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
  sign_bytes,
  own_public_key,
  verify_bytes,
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
    await api.registerDevice(
      deviceId,
      toB64(identity.key_package),
      toB64(new TextEncoder().encode(credential)),
      toB64(own_public_key(state)),
    );
    await persist(state);
  } else {
    deviceStateCache = state;
  }
  return deviceStateCache;
}

// ── Generic group operations (shared by DM, channel and event wrappers) ──

// mls_commit/mls_welcome are relayed over plain NATS core pub/sub (see
// nats.ts) with no replay — a device that isn't connected via SSE at the
// exact publish instant loses that Commit/Welcome forever, with nothing to
// self-heal from. mlsGroupController.ts's catch-up endpoints durably log
// every commit/welcome server-side; this pulls whatever this device hasn't
// applied yet, so a device that's simply been offline (or never received a
// live event at all — the common case for a fresh install/migrated
// machine) can catch itself up instead of relying on being online at the
// right millisecond. Called at the top of every ensure*Group, before
// deciding whether "no local group state" means "this group has never
// existed" or "I'm just late" — getting that wrong is exactly what used to
// fork a device into a rogue duplicate group (see attemptGroupGenesis).
async function catchUpGroup(state, groupId, fetchCatchUp) {
  const { data } = await fetchCatchUp();
  if (!data) return state;

  if (data.welcome && !group_exists(state, groupId)) {
    try {
      state = join_from_welcome(state, fromB64(data.welcome.welcome));
      await persist(state);
    } catch {
      // Not meant for this device after all — discard, same as
      // handleGroupWelcome below.
    }
  }

  if (group_exists(state, groupId)) {
    for (const c of data.commits ?? []) {
      try {
        state = process_commit(state, groupId, fromB64(c.commit));
        await persist(state);
      } catch {
        // Already applied, or not actionable — discard, same as
        // handleGroupCommit below.
      }
    }
  }

  return state;
}

/**
 * Attempts to create a group from scratch, for when this device has no
 * local state for it at all. This is only ever a GUESS: no local group
 * state is ambiguous between "this group has genuinely never existed" (we
 * really are first) and "a real group already exists elsewhere and this
 * device has simply never joined it" (any fresh install, reinstall, or
 * migrated machine looks exactly like this) — there's no way to tell them
 * apart locally. Guessing wrong used to be permanent: the solo group was
 * persisted immediately as a "checkpoint", so even though the server
 * correctly rejects the follow-up add commit with a 409 (the real epoch
 * isn't 0), this device's local state was already forked from the real
 * group before that response came back, and nothing ever revisited it —
 * exportGroupSecret would keep deriving from a one-person group nobody
 * else has, permanently and silently.
 *
 * Now nothing is persisted until the server actually confirms epoch 0->1
 * landed. On a 409, this function does nothing and returns false — this
 * device's local state stays untouched (group_exists stays false), so the
 * next call's catchUpGroup, or an existing member's next
 * reconcileGroupDevices pass, can add it properly instead of it
 * self-forking.
 */
async function attemptGroupGenesis(api, state, groupId, otherMemberIds, submitCommit) {
  const keyPackages = [];
  for (const userId of otherMemberIds) {
    const { data } = await api.getUserDeviceKeyPackages(userId);
    for (const d of data?.devices ?? []) keyPackages.push(fromB64(d.key_package));
  }
  // Nothing to add yet (everyone else has no registered device) — also
  // nothing to persist: an unconfirmed solo group isn't useful state, and
  // skipping it costs nothing since the next call just recomputes it.
  if (keyPackages.length === 0) return;

  const soloState = create_group(state, groupId);
  const framed = frame_key_packages(keyPackages);
  const targetEpoch = Number(group_epoch(soloState, groupId)) + 1;
  const addResult = add_member(soloState, groupId, framed);
  const { error } = await submitCommit(targetEpoch, toB64(addResult.commit), toB64(addResult.welcome), otherMemberIds);
  if (!error) await persist(addResult.device_state);
}

/**
 * Reconciles an already-joined group's membership against `currentMemberIds`
 * — used by both channel and event groups (DM's 2-party case has its own
 * simpler inline version in ensureGroupWithMember). Diffs by
 * (userId, deviceId), not just userId: checking only "is this user
 * represented by *any* device" leaves a user's *second* device invisible
 * forever once their first device is already a member (deviceController.ts's
 * getUserDeviceKeyPackages doc comment already flags this same user-vs-device
 * gap from the opposite, security, angle). A migrated laptop, a reinstall, or
 * just a second device is exactly this case: the account is "represented",
 * but this specific device's key package was never added.
 */
async function reconcileGroupDevices(api, currentUserId, state, groupId, currentMemberIds, submitCommit) {
  const memberUserIdOf = (label) => label.slice(0, label.lastIndexOf(':'));

  const staleLabels = group_member_labels(state, groupId).filter((label) => !currentMemberIds.has(memberUserIdOf(label)));
  if (staleLabels.length > 0) {
    const targetEpoch = Number(group_epoch(state, groupId)) + 1;
    const removeResult = remove_member(state, groupId, staleLabels);
    const { error } = await submitCommit(targetEpoch, toB64(removeResult.commit), null, []);
    if (!error) {
      state = removeResult.device_state;
      await persist(state);
    }
  }

  const currentLabels = new Set(group_member_labels(state, groupId));
  const otherMemberIds = [...currentMemberIds].filter((id) => id !== currentUserId);
  const keyPackages = [];
  const welcomedUserIds = new Set();
  for (const userId of otherMemberIds) {
    const { data } = await api.getUserDeviceKeyPackages(userId);
    for (const d of data?.devices ?? []) {
      if (!currentLabels.has(credentialFor(userId, d.device_id))) {
        keyPackages.push(fromB64(d.key_package));
        welcomedUserIds.add(userId);
      }
    }
  }
  if (keyPackages.length > 0) {
    const framed = frame_key_packages(keyPackages);
    const targetEpoch = Number(group_epoch(state, groupId)) + 1;
    const addResult = add_member(state, groupId, framed);
    const { error } = await submitCommit(targetEpoch, toB64(addResult.commit), toB64(addResult.welcome), [...welcomedUserIds]);
    if (!error) {
      state = addResult.device_state;
      await persist(state);
    }
  }
  return state;
}

async function ensureGroupWithMember(api, currentUserId, groupIdStr, otherUserId, submitCommit, fetchCatchUp) {
  let state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(groupIdStr);

  state = await catchUpGroup(state, groupId, fetchCatchUp);

  if (!group_exists(state, groupId)) {
    const { data } = await api.getUserDeviceKeyPackages(otherUserId);
    const devices = data?.devices ?? [];
    if (devices.length === 0) return;

    const soloState = create_group(state, groupId);
    const keyPackages = devices.map((d) => fromB64(d.key_package));
    const framed = frame_key_packages(keyPackages);
    const targetEpoch = Number(group_epoch(soloState, groupId)) + 1;
    const addResult = add_member(soloState, groupId, framed);

    // Only persist if the server actually accepted this Commit — a 409
    // here means the other side already established this group with us
    // (or beat us to genesis in a concurrent race); leave state untouched
    // so their Welcome (caught up next call) adds us instead of forking.
    const { error } = await submitCommit(targetEpoch, toB64(addResult.commit), toB64(addResult.welcome));
    if (!error) await persist(addResult.device_state);
    return;
  }

  // Already a member — check whether the other side has a device that
  // isn't represented yet (their second device, never added; see
  // reconcileGroupDevices's doc comment for why per-user isn't enough).
  const labels = group_member_labels(state, groupId);
  const { data } = await api.getUserDeviceKeyPackages(otherUserId);
  const keyPackages = (data?.devices ?? [])
    .filter((d) => !labels.includes(credentialFor(otherUserId, d.device_id)))
    .map((d) => fromB64(d.key_package));
  if (keyPackages.length === 0) return;

  const framed = frame_key_packages(keyPackages);
  const targetEpoch = Number(group_epoch(state, groupId)) + 1;
  const addResult = add_member(state, groupId, framed);
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
  await ensureGroupWithMember(api, currentUserId, convId, otherUserId,
    (epoch, commitB64, welcomeB64) => api.submitDmCommit(otherUserId, epoch, commitB64, welcomeB64),
    () => api.getDmMlsCatchUp(otherUserId));
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
 * *existing* group: any org member/device not yet represented gets added,
 * and any group member whose account is no longer an org member gets
 * removed. Both happen in a single Commit each call, applied only if
 * there's actually a discrepancy — cheap to call every time a channel is
 * opened. This is a deliberately lazy design: membership updates propagate
 * the next time *anyone* opens the channel, not the instant someone
 * joins/leaves the org — catchUpGroup below is what makes that reliable
 * even for a device that wasn't online when that propagation happened.
 */
export async function ensureChannelGroup(api, currentUserId, orgId, chanId) {
  let state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(chanId);
  const submitCommit = (epoch, commitB64, welcomeB64, welcomedUserIds) =>
    api.submitChannelCommit(orgId, chanId, epoch, commitB64, welcomeB64, welcomedUserIds);

  state = await catchUpGroup(state, groupId, () => api.getChannelMlsCatchUp(orgId, chanId));

  const { data: memberData } = await api.getOrgMembers(orgId);
  const currentMemberIds = new Set((memberData?.members ?? []).map((m) => m.user_id));

  const fetchCatchUp = () => api.getChannelMlsCatchUp(orgId, chanId);

  if (!group_exists(state, groupId)) {
    const toAdd = [...currentMemberIds].filter((id) => id !== currentUserId);
    await attemptGroupGenesis(api, state, groupId, toAdd, submitCommit);
    // Catch up after genesis: if we got a 409 another client won — apply their
    // commit so deviceStateCache is at the current epoch before secret export.
    await catchUpGroup(deviceStateCache, groupId, fetchCatchUp);
    return;
  }

  await reconcileGroupDevices(api, currentUserId, state, groupId, currentMemberIds, submitCommit);
  // Catch up after reconcile: if our commit was rejected with a 409 the winner's
  // commit advanced the epoch — pull it in so deviceStateCache matches the server.
  await catchUpGroup(deviceStateCache, groupId, fetchCatchUp);
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

/**
 * Syncs the local group state to the server's current epoch by applying any
 * pending commits, without attempting any new membership commits. Use this
 * in key-refresh paths where you need the latest epoch but don't want to
 * trigger reconciliation (which would race against other clients and 409-loop).
 */
export async function syncChannelGroupEpoch(api, currentUserId, orgId, chanId) {
  const state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(chanId);
  await catchUpGroup(state, groupId, () => api.getChannelMlsCatchUp(orgId, chanId));
}

/** Derives a fixed-length secret from a group's current epoch (see export_secret in mls-crypto). */
export async function exportGroupSecret(api, currentUserId, groupIdStr, label, length) {
  const state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(groupIdStr);
  return export_secret(state, groupId, label, length);
}

/**
 * Signs `messageBytes` with this device's Ed25519 MLS signature key — see
 * AudioFrame.sender_signature. Independent of group membership/encryption;
 * doesn't touch any group's ratchet state.
 */
export async function signBytes(api, currentUserId, messageBytes) {
  const state = await ensureIdentity(api, currentUserId);
  return sign_bytes(state, messageBytes);
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
 * genesis-only-guessed-not-persisted, per-device reconcile design — just
 * sourced from event participants (api.getEventParticipants) and committed
 * via api.submitEventGroupCommit instead of org members / submitChannelCommit.
 */
export async function ensureEventGroup(api, currentUserId, orgId, eventId) {
  let state = await ensureIdentity(api, currentUserId);
  const groupId = new TextEncoder().encode(eventId);
  const submitCommit = (epoch, commitB64, welcomeB64, welcomedUserIds) =>
    api.submitEventGroupCommit(orgId, eventId, epoch, commitB64, welcomeB64, welcomedUserIds);

  state = await catchUpGroup(state, groupId, () => api.getEventGroupMlsCatchUp(orgId, eventId));

  const { data: participantData } = await api.getEventParticipants(orgId, eventId);
  const currentMemberIds = new Set((participantData?.participants ?? []).map((p) => p.user_id));

  const fetchCatchUp = () => api.getEventGroupMlsCatchUp(orgId, eventId);

  if (!group_exists(state, groupId)) {
    const toAdd = [...currentMemberIds].filter((id) => id !== currentUserId);
    await attemptGroupGenesis(api, state, groupId, toAdd, submitCommit);
    await catchUpGroup(deviceStateCache, groupId, fetchCatchUp);
    return;
  }

  await reconcileGroupDevices(api, currentUserId, state, groupId, currentMemberIds, submitCommit);
  await catchUpGroup(deviceStateCache, groupId, fetchCatchUp);
}

export function handleEventGroupWelcome(api, currentUserId, eventId, welcomeB64) {
  return handleGroupWelcome(api, currentUserId, eventId, welcomeB64);
}

export function handleEventGroupCommit(api, currentUserId, eventId, commitB64) {
  return handleGroupCommit(api, currentUserId, eventId, commitB64);
}
