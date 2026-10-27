import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  saveChannelMessage, saveChannelMessages, getChannelMessages, getChannelMessagesSince,
  setMessageStoreUser,
  saveDmMessage, saveDmMessages, getDmMessages, getDmMessagesSince, // MR2: DMs
} from '../messageStore';
import {
  ensureChannelGroup, encryptChannel, decryptChannel, notePendingSent,
  healOrgEncryption, onGroupStateChange, groupEpoch, MlsDecryptError,
  encryptDm, decryptDmOrRecallOwn,
} from '../mlsSession';
import {
  SYNC_REPLY_MAX, chunkBundle, computeSyncSince, describeHealResult, isChannelRelay, isReadable,
  parseBundle, pickRetryRows, selectReplyRows, syncReplyDelay, toBundleItem,
  bundleRowsToDm, dmConversationId, dmRelayMessage,
} from './chatSyncCore';

// Channel-chat delivery for the engine (P2A, reworked for 2.0.1 / MR2).
//
// Two layers:
//   - a module-level delivery engine that runs for EVERY text channel of
//     every server the user is in, whether or not it's open: live relays are
//     decrypted and stored as they arrive, unreadable ones are kept (pending)
//     and retried, peers' catch-up requests are answered from local history,
//     and this device asks peers to fill its own gaps at startup, on every SSE
//     (re)connect and when a server is joined;
//   - useChannelChat, the hook for the ONE channel the engine has open (the
//     strip's chat / the dev-only TextChat): its rows, live from the store,
//     plus send.
// There must only ever be ONE mounted hook (WarRoom owns it): it registers the
// module-level SSE handlers below, and a second instance would decrypt the
// same message twice — the second decrypt fails (the ratchet already
// consumed that generation).
//
// All MLS work goes through mlsSession.js (its FIFO queue): ensure, encrypt,
// decrypt (decryptChannel throws MlsDecryptError with a .reason), heal.
// Nothing here touches WASM or the stored MLS state directly. Plaintext never
// leaves this device except re-encrypted under the channel group's current
// epoch (backfill bundles, see answerOrgSync).
//
// ── No permanent loss ─────────────────────────────────────────────────────
// A message that can't be decrypted is stored as { plaintext: null, pending:
// true, encrypted_content, fail_reason, attempts } and shown as "Waiting for
// key…". It's retried whenever its channel's MLS group changes
// (onGroupStateChange — a commit, a welcome, a heal), unless the reason says
// a retry can't work (epoch_too_old / corrupt). Either way a peer's backfill
// for that id replaces it (chatSyncCore.mergeChannelRow), and a catch-up is
// asked for after a retry leaves rows unreadable.
//
// ── Catch-up (peer-to-peer; the server holds no history) ────────────────
//   ask     POST /orgs/:orgId/messages/sync-request { channels: [{ channel_id, since }] }
//           → everyone in the org gets org_sync_request (SSE, flat fields)
//   answer  each member that holds readable rows newer than `since` waits
//           0–1.5 s (jitter), then sends them to the requester as MLS
//           bundles: ONE application message per chunk of up to ~48 kB, each
//           carrying the original id / sender / callsign / timestamp, under
//           the group's CURRENT epoch (so the requester can read it whatever
//           epoch the original was sent in). Max 200 messages per channel.
//           The responder skips its own requests.
//   merge   the requester dedupes by id; a readable copy wins over a pending
//           one, and a readable stored row is never replaced.
// Authenticity: MLS authenticates the RESPONDER as a group member; that the
// original sender wrote a relayed message rests on the responder (accepted;
// rows keep relayed_by). The legacy per-channel sync_request (2.0.0 clients)
// is still answered the old way, with stored original ciphertext.

// Set by the mounted hook; WarRoom's useEventStream calls them.
export const channelChatRelayRef = { current: null };          // message_relay
export const channelChatSyncRequestRef = { current: null };    // sync_request (legacy, per channel)
export const channelChatOrgSyncRequestRef = { current: null }; // org_sync_request (MR2)
export const channelChatSyncResponseRef = { current: null };   // sync_response (bundle or legacy)
export const channelChatResyncRef = { current: null };         // SSE connected → catch up again

// ── Delivery engine state (module-level, one account at a time) ──────────
const engine = {
  user: null,                  // { id, callsign, global_tag }
  ownSentIds: new Set(),       // ids sent from this device this session
  channelOrg: new Map(),       // channelId → orgId (for follow-up catch-ups)
  orgPhase: new Map(),         // orgId → 'starting' | 'ready'
  listeners: new Map(),        // channelId → Set<() => void>
  failedBundles: new Map(),    // channelId → [sync_response payload] (retried on group change)
  recentAnswers: new Map(),    // `${requester}|${channel}|${since}` → ms
  followUps: new Map(),        // channelId → ms of the last gap-triggered catch-up
  retrying: new Map(),         // channelId → Promise (coalesces retries)
};
let decryptChain = Promise.resolve(); // every decrypt, strictly in arrival order
let answerChain = Promise.resolve();  // our answers to peers, one at a time
let startupChain = Promise.resolve(); // heal + catch-up per server, sequential

const userId = () => engine.user?.id ?? null;
const STORE_WINDOW = 500;             // rows looked at to compute `since`
const ANSWER_DEDUPE_MS = 10_000;
const FOLLOW_UP_MIN_MS = 30_000;
const MAX_FAILED_BUNDLES = 5;

const runDecrypt = (fn) => {
  const p = decryptChain.then(fn, fn);
  decryptChain = p.catch(() => {});
  return p;
};

const failReason = (err) => (err instanceof MlsDecryptError || typeof err?.reason === 'string' ? err.reason : 'unknown');

function notifyChannel(channelId) {
  for (const cb of engine.listeners.get(channelId) || []) {
    try { cb(); } catch { /* listener bug: not ours to break on */ }
  }
}

function subscribeChannel(channelId, cb) {
  if (!engine.listeners.has(channelId)) engine.listeners.set(channelId, new Set());
  engine.listeners.get(channelId).add(cb);
  return () => engine.listeners.get(channelId)?.delete(cb);
}

/** Switch the engine to another account (or none): forget everything per-user. */
function resetEngine(user) {
  engine.user = user || null;
  engine.ownSentIds.clear();
  engine.channelOrg.clear();
  engine.orgPhase.clear();
  engine.failedBundles.clear();
  engine.recentAnswers.clear();
  engine.followUps.clear();
  engine.retrying.clear();
}

// ── Live relay ────────────────────────────────────────────────────────────
function handleRelay(payload) {
  if (!isChannelRelay(payload) || !userId()) return;
  const me = userId();
  const channelId = payload.channel_id;
  if (payload.org_id) engine.channelOrg.set(channelId, payload.org_id);
  runDecrypt(async () => {
    if (me !== userId()) return; // account switched meanwhile
    const isOwnAccount = payload.sender_id === me;
    let plaintext = null;
    let reason = null;
    try {
      plaintext = await decryptChannel(api, me, channelId, payload.encrypted_content, isOwnAccount);
    } catch (err) {
      reason = failReason(err);
    }
    // Own sends are already stored from send() — the decrypt above still had
    // to run to drain the FIFO own-echo recall queue in order; skip so a
    // stray failed recall can't touch the good local copy.
    if (isOwnAccount && engine.ownSentIds.has(payload.id)) return;
    const row = await saveChannelMessage({
      id:                payload.id,
      channel_id:        channelId,
      sender_id:         payload.sender_id,
      callsign:          payload.callsign ?? null,
      global_tag:        payload.global_tag ?? null,
      encrypted_content: payload.encrypted_content,
      plaintext,
      image_url:         payload.image_url ?? null,
      timestamp:         payload.timestamp,
      fail_reason:       reason,
      attempts:          plaintext == null ? 1 : 0,
    }).catch(() => null);
    if (row) notifyChannel(channelId);
  });
}

// ── Retry pending rows ─────────────────────────────────────────────────────
// Channels and DMs (MR2) follow the same rules; KIND says where their rows
// live and how they decrypt.
const KIND = {
  channel: {
    rows: (id) => getChannelMessages(id, STORE_WINDOW),
    save: (row) => saveChannelMessage(row),
    // isOwnAccount=false: the recall queue belongs to live echoes only.
    decrypt: (me, id, ct) => decryptChannel(api, me, id, ct, false),
    followUp: (id) => followUpCatchUp(id),
  },
  dm: {
    rows: (id) => getDmMessages(id, STORE_WINDOW),
    save: (row) => saveDmMessage(row),
    decrypt: (me, id, ct) => decryptDmOrRecallOwn(api, me, id, ct, false),
    followUp: (id) => followUpDmCatchUp(id),
  },
};

/** Re-decrypt a channel's retryable unreadable rows (oldest first); coalesced per channel. */
export function retryPendingChannel(channelId) {
  return retryPending('channel', channelId);
}

function retryPending(kindName, id) {
  if (!id || !userId()) return Promise.resolve();
  const kind = KIND[kindName];
  const key = `${kindName}:${id}`;
  const running = engine.retrying.get(key);
  // A change while a pass is running may have come after it read its rows:
  // run one more pass when it finishes.
  if (running) { running.again = true; return running.promise; }
  const me = userId();
  const entry = { promise: null, again: false };
  const p = runDecrypt(async () => {
    const rows = await kind.rows(id).catch(() => []);
    const retry = pickRetryRows(rows);
    let changed = false;
    for (const row of retry) {
      if (me !== userId()) return;
      let plaintext = null;
      let reason = null;
      try {
        plaintext = await kind.decrypt(me, id, row.encrypted_content);
      } catch (err) {
        reason = failReason(err);
      }
      const written = await kind.save(plaintext != null
        ? { ...row, plaintext }
        : { ...row, fail_reason: reason, attempts: (row.attempts ?? 0) + 1 }).catch(() => null);
      if (written) changed = true;
    }
    if (changed) notifyChannel(id);
    const stillUnreadable = (await kind.rows(id).catch(() => [])).some((r) => !isReadable(r));
    if (stillUnreadable) kind.followUp(id);
  }).finally(() => {
    if (engine.retrying.get(key) === entry) engine.retrying.delete(key);
    if (entry.again && me === userId()) retryPending(kindName, id).catch(() => {});
  });
  entry.promise = p;
  engine.retrying.set(key, entry);
  return p;
}

/** Rows a retry couldn't fix wait for a backfill: ask for one (throttled per channel). */
function followUpCatchUp(channelId) {
  const orgId = engine.channelOrg.get(channelId);
  if (!orgId || engine.orgPhase.get(orgId) !== 'ready') return;
  const last = engine.followUps.get(channelId) || 0;
  if (Date.now() - last < FOLLOW_UP_MIN_MS) return;
  engine.followUps.set(channelId, Date.now());
  requestCatchUp(orgId, [channelId]).catch(() => {});
}

/** A DM conversation id ("<uuid>-<uuid>") of mine → the partner's user id, else null. */
function dmPartnerOf(convId) {
  const me = userId();
  if (!me || typeof convId !== 'string' || convId.length !== me.length * 2 + 1) return null;
  const other = convId.startsWith(`${me}-`) ? convId.slice(me.length + 1)
    : convId.endsWith(`-${me}`) ? convId.slice(0, convId.length - me.length - 1) : null;
  return other && dmConversationId(me, other) === convId ? other : null;
}

function onGroupChanged(groupIdStr) {
  if (!groupIdStr || !userId()) return;
  // A DM conversation of mine, else a channel (for any other group id — an
  // event cascade — the store simply has nothing pending).
  const isDm = Boolean(dmPartnerOf(groupIdStr));
  retryPending(isDm ? 'dm' : 'channel', groupIdStr).catch(() => {});
  const bundles = engine.failedBundles.get(groupIdStr);
  if (bundles?.length) {
    engine.failedBundles.delete(groupIdStr);
    for (const b of bundles) (isDm ? handleDmSyncResponse : handleSyncResponse)(b, { isRetry: true });
  }
}

// ── Asking peers (catch-up) ────────────────────────────────────────────────
/** Ask the org's online members for anything these channels are missing. */
export async function requestCatchUp(orgId, channelIds) {
  if (!orgId || !channelIds?.length || !userId()) return;
  const channels = [];
  for (const channelId of channelIds) {
    engine.channelOrg.set(channelId, orgId);
    const rows = await getChannelMessages(channelId, STORE_WINDOW).catch(() => []);
    channels.push({ channel_id: channelId, since: computeSyncSince(rows) });
  }
  for (let i = 0; i < channels.length; i += 500) {
    const { error } = await api.requestOrgSync(orgId, channels.slice(i, i + 500));
    if (error) console.warn(`[chat] catch-up request for server ${orgId} failed: ${error}`);
  }
}

async function orgChannelIds(orgId) {
  const { data, error } = await api.getChannels(orgId);
  if (error) throw new Error(error);
  return (data?.channels || []).map((c) => c.id).filter(Boolean);
}

/** Catch up every channel of a server (all kinds: voice channels carry in-call chat too). */
export async function catchUpOrg(orgId) {
  const ids = await orgChannelIds(orgId);
  await requestCatchUp(orgId, ids);
}

/**
 * Engine start / server joined: for each server not seen yet, heal its
 * encryption (mlsSession, MR1), retry what was waiting for a key, then catch
 * up. Sequential across servers (healing goes through the mlsSession queue).
 */
export function startOrgSync(orgIds) {
  const me = userId();
  if (!me) return startupChain;
  for (const orgId of orgIds || []) {
    if (!orgId || engine.orgPhase.has(orgId)) continue;
    engine.orgPhase.set(orgId, 'starting');
    startupChain = startupChain.then(async () => {
      if (me !== userId()) return;
      let ids = [];
      try { ids = await orgChannelIds(orgId); } catch { /* catch-up below retries the list */ }
      for (const id of ids) engine.channelOrg.set(id, orgId);
      try {
        await healOrgEncryption(api, me, orgId);
      } catch (err) {
        console.warn(`[chat] encryption heal for server ${orgId} failed:`, err?.message || err);
      }
      for (const id of ids) await retryPendingChannel(id).catch(() => {});
      if (me !== userId()) return;
      engine.orgPhase.set(orgId, 'ready');
      await (ids.length ? requestCatchUp(orgId, ids) : catchUpOrg(orgId)).catch((err) => {
        console.warn(`[chat] catch-up for server ${orgId} failed:`, err?.message || err);
      });
    });
  }
  return startupChain;
}

/** SSE (re)connected: catch up every server whose startup already ran (the rest do it then). */
export function catchUpReadyOrgs() {
  for (const [orgId, phase] of engine.orgPhase) {
    if (phase === 'ready') catchUpOrg(orgId).catch(() => {});
  }
}

/** Forget servers the user left (a re-join runs startup again). */
export function forgetOrgs(keepOrgIds) {
  const keep = new Set(keepOrgIds || []);
  for (const orgId of [...engine.orgPhase.keys()]) if (!keep.has(orgId)) engine.orgPhase.delete(orgId);
}

/**
 * Bridge server.resyncEncryption: force-heal every group of a server, then
 * catch up. → { healed, failed, checked, failures: [{ groupId, reason }], message, ok }
 */
export async function resyncOrgEncryption(orgId) {
  const me = userId();
  if (!me) throw new Error('Not logged in');
  if (!orgId) throw new Error('No server selected');
  const r = await healOrgEncryption(api, me, orgId, { force: true });
  const summary = {
    healed: r?.healed?.length ?? 0,
    failed: r?.failed?.length ?? 0,
    checked: r?.checked ?? 0,
    failures: (r?.failed || []).slice(0, 5).map((f) => ({ groupId: f.groupId, reason: String(f.reason ?? '') })),
  };
  engine.orgPhase.set(orgId, 'ready');
  catchUpOrg(orgId).catch(() => {});
  return { ...summary, ...describeHealResult(summary) };
}

// ── Answering peers ────────────────────────────────────────────────────────
/** org_sync_request: answer for any channel I hold readable history of. */
function handleOrgSyncRequest(payload) {
  const me = userId();
  if (!me || !payload?.org_id || !payload.requester_id || payload.requester_id === me) return;
  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  if (!channels.length) return;
  const now = Date.now();
  for (const [k, t] of engine.recentAnswers) if (now - t > ANSWER_DEDUPE_MS) engine.recentAnswers.delete(k);
  const todo = channels.filter((c) => {
    if (!c?.channel_id) return false;
    // Not in this channel's group on this device: nothing I could encrypt for it.
    if (groupEpoch(c.channel_id) == null) return false;
    const key = `${payload.requester_id}|${c.channel_id}|${c.since ?? ''}`;
    if (engine.recentAnswers.has(key)) return false;
    engine.recentAnswers.set(key, now);
    return true;
  });
  if (!todo.length) return;
  setTimeout(() => {
    answerChain = answerChain.then(() => answerOrgSync(me, payload.org_id, payload.requester_id, todo)).catch(() => {});
  }, syncReplyDelay());
}

async function answerOrgSync(me, orgId, requesterId, channels) {
  for (const { channel_id: channelId, since } of channels) {
    if (me !== userId()) return;
    const rows = since
      ? await getChannelMessagesSince(channelId, since, SYNC_REPLY_MAX * 3).catch(() => [])
      : await getChannelMessages(channelId, SYNC_REPLY_MAX * 2).catch(() => []);
    const reply = selectReplyRows(rows, since);
    if (!reply.length) continue;
    for (const chunk of chunkBundle(reply.map(toBundleItem))) {
      let bundle;
      try {
        bundle = await encryptChannel(api, me, channelId, chunk.json);
      } catch {
        break; // can't encrypt for this group right now: skip the channel
      }
      const { error } = await api.respondOrgSync(orgId, requesterId, channelId, bundle, chunk.count);
      if (error) break;
    }
  }
}

/** Legacy per-channel sync_request (2.0.0 clients): stored original ciphertext, any channel. */
function handleLegacySyncRequest(payload) {
  const me = userId();
  if (!me || !payload?.channel_id || !payload.org_id || payload.requester_id === me) return;
  getChannelMessagesSince(payload.channel_id, payload.since).then((rows) => {
    const out = rows
      .filter((r) => r.encrypted_content)
      .map(({ id, sender_id, callsign, global_tag, encrypted_content, image_url, timestamp }) => (
        { id, sender_id, callsign, global_tag, encrypted_content, image_url, timestamp }
      ));
    if (out.length === 0) return;
    api.respondChannelSync(payload.org_id, payload.channel_id, payload.requester_id, out).catch(() => {});
  }).catch(() => {});
}

// ── Merging a peer's answer ────────────────────────────────────────────────
function handleSyncResponse(payload, { isRetry = false } = {}) {
  const me = userId();
  const channelId = payload?.channel_id;
  if (!me || !channelId) return;
  if (payload.org_id) engine.channelOrg.set(channelId, payload.org_id);
  if (typeof payload.bundle === 'string') {
    runDecrypt(async () => {
      if (me !== userId()) return;
      let json;
      try {
        json = await decryptChannel(api, me, channelId, payload.bundle, false);
      } catch (err) {
        // Possibly fixable by a group change (e.g. the responder is an epoch
        // ahead and our catch-up hasn't landed): keep it for one retry.
        const reason = failReason(err);
        if (!isRetry && reason !== 'corrupt' && reason !== 'epoch_too_old') {
          const list = engine.failedBundles.get(channelId) || [];
          if (list.length < MAX_FAILED_BUNDLES) engine.failedBundles.set(channelId, [...list, payload]);
        }
        return;
      }
      const rows = parseBundle(json, { channelId, relayedBy: payload.relayed_by ?? null });
      const written = await saveChannelMessages(channelId, rows).catch(() => []);
      if (written.length) notifyChannel(channelId);
    });
    return;
  }
  // Legacy format (2.0.0 responders / background_sync.rs): one original
  // ciphertext per message. Each is decrypted once, oldest first; a message
  // already readable here is skipped (a second decrypt would fail — the
  // ratchet already consumed that generation).
  if (!Array.isArray(payload.messages) || !payload.messages.length) return;
  runDecrypt(async () => {
    if (me !== userId()) return;
    const stored = await getChannelMessages(channelId, Number.MAX_SAFE_INTEGER).catch(() => []);
    const known = new Map(stored.map((m) => [m.id, m]));
    const ordered = [...payload.messages].sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
    const out = [];
    for (const m of ordered) {
      if (!m?.id || !m.timestamp) continue;
      if (isReadable(known.get(m.id))) continue;
      let plaintext = null;
      let reason = null;
      try {
        plaintext = await decryptChannel(api, me, channelId, m.encrypted_content, false);
      } catch (err) {
        reason = failReason(err);
      }
      out.push({ ...m, channel_id: channelId, plaintext, fail_reason: reason, attempts: plaintext == null ? 1 : 0, relayed_by: payload.relayed_by ?? null });
    }
    const written = await saveChannelMessages(channelId, out).catch(() => []);
    if (written.length) notifyChannel(channelId);
  });
}

// ── DMs (MR2) ─────────────────────────────────────────────────────────────
// The same rules for 1:1 DMs, whose MLS group id is the conversation id
// (dmController.ts / mlsSession's DM wrappers). Live DMs are stored whether
// or not the DM is open; DmCabinet (WarRoom) only renders the store and asks
// for a catch-up when opened. Requests/answers go to the partner's user
// subject: dm_sync_request { conversation_id, requester_id, since } →
// POST /dm/:userId/sync-response { bundle, count } → dm_sync_response
// { conversation_id, relayed_by, bundle, count }.
export const dmChatRelayRef = { current: null };        // message_relay with context 'dm'
export const dmChatSyncRequestRef = { current: null };  // dm_sync_request
export const dmChatSyncResponseRef = { current: null }; // dm_sync_response

function handleDmRelay(payload) {
  const msg = dmRelayMessage(payload);
  const me = userId();
  if (!msg || !me) return;
  const convId = msg.conversation_id;
  if (!dmPartnerOf(convId)) return;
  runDecrypt(async () => {
    if (me !== userId()) return;
    // isOwnAccount: this device's own echo (recalled from the pending-sent
    // queue — see decryptDmOrRecallOwn) or another device of this account.
    const isOwnAccount = msg.sender_id === me;
    let plaintext = null;
    let reason = null;
    try {
      plaintext = await decryptDmOrRecallOwn(api, me, convId, msg.encrypted_content, isOwnAccount);
    } catch (err) {
      reason = failReason(err);
    }
    const row = await saveDmMessage({
      id: msg.id,
      conversation_id: convId,
      sender_id: msg.sender_id,
      to_user_id: msg.to_user_id ?? null,
      callsign: msg.callsign ?? null,
      encrypted_content: msg.encrypted_content,
      plaintext,
      timestamp: msg.timestamp,
      fail_reason: reason,
      attempts: plaintext == null ? 1 : 0,
    }).catch(() => null);
    if (row) notifyChannel(convId);
  });
}

/** Ask the DM partner for anything this conversation is missing. */
export async function requestDmCatchUp(partnerId) {
  const me = userId();
  if (!me || !partnerId) return;
  const convId = dmConversationId(me, partnerId);
  const rows = await getDmMessages(convId, STORE_WINDOW).catch(() => []);
  const { error } = await api.requestDmSync(partnerId, computeSyncSince(rows));
  if (error) console.warn(`[chat] DM catch-up request failed: ${error}`);
}

function followUpDmCatchUp(convId) {
  const partnerId = dmPartnerOf(convId);
  if (!partnerId) return;
  const last = engine.followUps.get(convId) || 0;
  if (Date.now() - last < FOLLOW_UP_MIN_MS) return;
  engine.followUps.set(convId, Date.now());
  requestDmCatchUp(partnerId).catch(() => {});
}

function handleDmSyncRequest(payload) {
  const me = userId();
  const requesterId = payload?.requester_id;
  const convId = payload?.conversation_id;
  if (!me || !requesterId || requesterId === me || dmPartnerOf(convId) !== requesterId) return;
  if (groupEpoch(convId) == null) return; // not in this DM's group on this device
  const since = payload.since ?? null;
  const key = `${requesterId}|${convId}|${since ?? ''}`;
  const now = Date.now();
  if (engine.recentAnswers.has(key) && now - engine.recentAnswers.get(key) < ANSWER_DEDUPE_MS) return;
  engine.recentAnswers.set(key, now);
  setTimeout(() => {
    answerChain = answerChain.then(async () => {
      if (me !== userId()) return;
      const rows = since
        ? await getDmMessagesSince(convId, since, SYNC_REPLY_MAX * 3).catch(() => [])
        : await getDmMessages(convId, SYNC_REPLY_MAX * 2).catch(() => []);
      const reply = selectReplyRows(rows, since);
      for (const chunk of chunkBundle(reply.map(toBundleItem))) {
        let bundle;
        try {
          bundle = await encryptDm(api, me, convId, chunk.json);
        } catch {
          return;
        }
        const { error } = await api.respondDmSyncBundle(requesterId, bundle, chunk.count);
        if (error) return;
      }
    }).catch(() => {});
  }, syncReplyDelay());
}

function handleDmSyncResponse(payload, { isRetry = false } = {}) {
  const me = userId();
  const convId = payload?.conversation_id;
  const partnerId = dmPartnerOf(convId);
  // Only the partner can answer (the server derives the conversation from
  // the authenticated responder, so relayed_by must be that partner).
  if (!me || !partnerId || payload.relayed_by !== partnerId || typeof payload.bundle !== 'string') return;
  runDecrypt(async () => {
    if (me !== userId()) return;
    let json;
    try {
      json = await decryptDmOrRecallOwn(api, me, convId, payload.bundle, false);
    } catch (err) {
      const reason = failReason(err);
      if (!isRetry && reason !== 'corrupt' && reason !== 'epoch_too_old') {
        const list = engine.failedBundles.get(convId) || [];
        if (list.length < MAX_FAILED_BUNDLES) engine.failedBundles.set(convId, [...list, payload]);
      }
      return;
    }
    const rows = bundleRowsToDm(parseBundle(json, { channelId: null, relayedBy: partnerId }), { convId, me, partnerId });
    const written = await saveDmMessages(convId, rows).catch(() => []);
    if (written.length) notifyChannel(convId);
  });
}

/** Rows of one DM conversation for a UI: live from the store. → unsubscribe */
export function subscribeChatRows(id, cb) {
  return subscribeChannel(id, cb);
}

/** The delivery engine's handlers, for scripts/test-chat-engine.mjs (no React needed). */
export const __chatEngineForTests = {
  setUser: (user) => resetEngine(user),
  setOrgReady: (orgId) => engine.orgPhase.set(orgId, 'ready'),
  handleRelay, handleSyncResponse, handleOrgSyncRequest, handleLegacySyncRequest, onGroupChanged,
  handleDmRelay, handleDmSyncRequest, handleDmSyncResponse, requestDmCatchUp,
  subscribeChannel,
  idle: async () => { await decryptChain; await answerChain; await startupChain; },
};

/**
 * orgId, channel (a text channel object or null), user
 * → { channelId, messages, loading, send(text, channel?) }
 * send resolves with the stored message or throws (nothing was sent then).
 */
export default function useChannelChat({ orgId, channel, user }) {
  const channelId = channel?.id ?? null;
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(Boolean(channelId));
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const orgIdRef = useRef(orgId);
  orgIdRef.current = orgId;
  const userRef = useRef(user);
  userRef.current = user;

  // ── The delivery engine follows the logged-in account ────────────────────
  // (and so does the per-account message store, MR2). Declared before
  // WarRoom's startup effects, so they run with the right account.
  if (user?.id && engine.user?.id === user.id) engine.user = user; // fresh callsign etc.
  const accountId = user?.id ?? null;
  useEffect(() => {
    if (!accountId) return undefined;
    if (engine.user?.id !== accountId) resetEngine(userRef.current);
    setMessageStoreUser(accountId);
    return () => {
      // Logged out / switched / engine gone: nothing may write to this
      // account's history any more (App.jsx's next drain follows the next login).
      resetEngine(null);
      setMessageStoreUser(null);
    };
  }, [accountId]);

  // ── Module-level SSE handlers + group-change retries (mount only) ────────
  useEffect(() => {
    channelChatRelayRef.current = handleRelay;
    channelChatSyncRequestRef.current = handleLegacySyncRequest;
    channelChatOrgSyncRequestRef.current = handleOrgSyncRequest;
    channelChatSyncResponseRef.current = handleSyncResponse;
    channelChatResyncRef.current = catchUpReadyOrgs;
    dmChatRelayRef.current = handleDmRelay;
    dmChatSyncRequestRef.current = handleDmSyncRequest;
    dmChatSyncResponseRef.current = handleDmSyncResponse;
    const unsubscribe = onGroupStateChange(onGroupChanged);
    return () => {
      if (dmChatRelayRef.current === handleDmRelay) dmChatRelayRef.current = null;
      if (dmChatSyncRequestRef.current === handleDmSyncRequest) dmChatSyncRequestRef.current = null;
      if (dmChatSyncResponseRef.current === handleDmSyncResponse) dmChatSyncResponseRef.current = null;
      if (channelChatRelayRef.current === handleRelay) channelChatRelayRef.current = null;
      if (channelChatSyncRequestRef.current === handleLegacySyncRequest) channelChatSyncRequestRef.current = null;
      if (channelChatOrgSyncRequestRef.current === handleOrgSyncRequest) channelChatOrgSyncRequestRef.current = null;
      if (channelChatSyncResponseRef.current === handleSyncResponse) channelChatSyncResponseRef.current = null;
      if (channelChatResyncRef.current === catchUpReadyOrgs) channelChatResyncRef.current = null;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // ── The open channel: rows from the store, reloaded on every change ──────
  useEffect(() => {
    setMessages([]);
    if (!channelId) { setLoading(false); return undefined; }
    let cancelled = false;
    let timer = null;
    setLoading(true);
    const load = () => {
      getChannelMessages(channelId, 200).then((rows) => {
        if (!cancelled) { setMessages(rows); setLoading(false); }
      }).catch(() => { if (!cancelled) setLoading(false); });
    };
    load();
    // Bursts (a backfill, a retry pass) settle into one reload.
    const unsubscribe = subscribeChannel(channelId, () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; load(); }, 30);
    });
    return () => { cancelled = true; if (timer) clearTimeout(timer); unsubscribe(); };
  }, [channelId, user?.id]);

  // Sends go out strictly one after another: the own-echo recall queue
  // (notePendingSent) is FIFO per channel and must be filled in the order the
  // server publishes, which overlapping sends could reorder.
  const sendChainRef = useRef(Promise.resolve());
  const send = useCallback((rawText, target) => {
    const text = String(rawText ?? '').trim();
    const ch = target || (channelIdRef.current ? { id: channelIdRef.current } : null);
    const run = async () => {
      const org = orgIdRef.current;
      const u = userRef.current;
      if (!text) throw new Error('Nothing to send');
      if (!org || !ch?.id) throw new Error('No channel selected');
      await ensureChannelGroup(api, u?.id, org, ch.id);
      const ciphertext = await encryptChannel(api, u?.id, ch.id, text);
      const { data, error: sendApiError } = await api.sendMessage(org, ch.id, ciphertext);
      // api.js never throws on a failed request — it always resolves to
      // {data, error} (see fetchWithAuth) — so a failed send (expired token,
      // network drop, etc.) would fall through here silently unless checked
      // explicitly. Promote it to a thrown error so the caller restores the
      // input and surfaces it, same as a thrown MLS error.
      if (sendApiError) throw new Error(sendApiError);

      // Only queue the plaintext for MLS's own-echo recall (see
      // decryptGroupOrRecallOwn's doc comment in mlsSession.js) once the send
      // actually succeeded — queueing it earlier would leave a stale entry
      // in the FIFO on failure, silently mislabeling a later, unrelated
      // message with this text.
      notePendingSent(ch.id, text);

      // Store this message immediately rather than waiting on the SSE echo —
      // if our own SSE connection isn't live at the exact instant the server
      // publishes (reconnect backoff, ticket refresh), the echo may never
      // arrive and the message would otherwise vanish, sender included.
      const msg = {
        id:                data.id,
        channel_id:        ch.id,
        sender_id:         u?.id,
        callsign:          u?.callsign ?? null,
        global_tag:        u?.global_tag ?? null,
        encrypted_content: ciphertext,
        plaintext:         text,
        image_url:         null,
        timestamp:         data.timestamp,
        received_at:       new Date().toISOString(),
      };
      engine.ownSentIds.add(msg.id);
      engine.channelOrg.set(ch.id, org);
      await saveChannelMessage(msg).catch(() => {});
      notifyChannel(ch.id);
      return msg;
    };
    // A thrown MLS error (e.g. an epoch conflict from another client
    // committing to the group at the same time) or the promoted api error
    // above means api.sendMessage never succeeded — the caller restores the
    // text and shows the error.
    const p = sendChainRef.current.then(run, run);
    sendChainRef.current = p.catch(() => {});
    return p;
  }, []);

  return { channelId, messages, loading, send };
}
