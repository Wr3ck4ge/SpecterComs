// Test double for MR1's frozen mlsSession.js interface. A "ciphertext" is
// `enc:<epoch>:<plaintext>`; it decrypts only while this device holds that
// epoch for the group (`keys`), and each ciphertext only once (like an MLS
// generation).
export class MlsDecryptError extends Error {
  constructor(reason, message = reason) { super(message); this.name = 'MlsDecryptError'; this.reason = reason; }
}

export const keys = new Map();   // groupId → Set<epoch> this device can decrypt
export const epochs = new Map(); // groupId → current local epoch
const consumed = new Set();
const listeners = new Set();
export const heals = [];

export function giveKey(groupId, epoch) {
  if (!keys.has(groupId)) keys.set(groupId, new Set());
  keys.get(groupId).add(epoch);
  epochs.set(groupId, Math.max(epochs.get(groupId) ?? 0, epoch));
  for (const cb of listeners) cb(groupId);
}

export function onGroupStateChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function groupEpoch(groupId) { return epochs.has(groupId) ? epochs.get(groupId) : null; }
export function resetForUser() {}
export async function ensureChannelGroup() {}
export function notePendingSent() {}

export async function encryptChannel(_api, _u, groupId, plaintext) {
  const e = epochs.get(groupId);
  if (e == null) throw new MlsDecryptError('not_member');
  return `enc:${e}:${plaintext}`;
}

export async function decryptChannel(_api, _u, groupId, ciphertext) {
  const m = /^enc:(\d+):([\s\S]*)$/.exec(ciphertext || '');
  if (!m) throw new MlsDecryptError('corrupt');
  if (!epochs.has(groupId)) throw new MlsDecryptError('not_member');
  const epoch = Number(m[1]);
  if (!keys.get(groupId)?.has(epoch)) {
    throw new MlsDecryptError(epoch > epochs.get(groupId) ? 'epoch_ahead_unresolved' : 'epoch_too_old');
  }
  if (consumed.has(ciphertext)) throw new MlsDecryptError('corrupt', 'generation already consumed');
  consumed.add(ciphertext);
  return m[2];
}
export const decryptChannelOrRecallOwn = decryptChannel;
// DM groups use the same model (group id = conversation id).
export const encryptDm = encryptChannel;
export const decryptDmOrRecallOwn = decryptChannel;

export async function healOrgEncryption(_api, _u, orgId, opts = {}) {
  heals.push({ orgId, ...opts });
  return { healed: [], failed: [], checked: 0 };
}
