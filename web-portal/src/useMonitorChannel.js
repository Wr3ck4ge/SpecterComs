/**
 * useMonitorChannel — lightweight RX-only audio monitor for a secondary channel.
 *
 * Connects to a channel via WebTransport and plays incoming audio at a reduced
 * volume.
 *
 * Usage:
 *   const { roster, currentSpeaker } = useMonitorChannel({ org, channel, volume: 0.3 });
 *
 * The hook is designed to be used multiple times in parallel — each instance
 * manages its own transport and AudioContext.
 *
 * Two wire modes, learned per connection from the media ticket's
 * `voice_relay` (same source of truth as CommLink — see voiceRelayAudio.js):
 *
 *  - mixed: one plaintext server-mixed Opus stream (ssrc=0). Played exactly as
 *    before: a single decoder (browser) / a single native stream keyed by the
 *    bare channel id (Tauri).
 *  - relay: every sender's frames are sealed (relay wire v2, per-session key)
 *    under the channel's MLS 'audio' export (cascade frames from a priority
 *    speaker in a parent channel under the event's 'audio-cascade' export).
 *    Each frame must authenticate, decrypt and pass the per-session replay
 *    window or it is dropped — ciphertext never reaches a decoder. Each sender ssrc gets its own
 *    decoder lane (browser) / native stream id `${channelId}:${ssrc}` (Tauri),
 *    the server's Duck/DuckRelease signal attenuates every lane except the
 *    active priority speaker's, and lanes are freed on Leave or when idle.
 *
 * Key lifecycle (relay only): this hook never creates, joins or commits to an
 * MLS group — that is CommLink/ensureChannelGroup's job (every sender in the
 * channel runs it on connect, which adds every org member's devices, ours
 * included). It only catches up (syncChannelGroupEpoch: applies a pending
 * Welcome/commits from the server's durable log, submits nothing) and exports.
 * While the key is missing frames are dropped and derivation is retried with
 * backoff; WarRoom's mls_commit/mls_welcome handler notifies us (via
 * onGroupKeyChange) after it applies an epoch change for this channel/event.
 * MR4: on a rekey the previous receiver stays usable for KEY_GRACE_MS
 * (createKeyGraceSlot), so members that switch a little later aren't cut off;
 * mlsSession's onGroupStateChange also triggers a re-export; and sustained
 * failures on both keys escalate to the (throttled) org-wide
 * healOrgEncryption — the one MLS write this hook can cause, routed through
 * mlsSession's own heal.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import initWasm, { RelayAudioReceiver } from 'wasm-crypto';
import { syncChannelGroupEpoch, syncEventGroupEpoch, exportGroupSecret, verifySignature } from './mlsSession';
// MR4: onGroupStateChange / healOrgEncryption are MR1's (v2.0.1) additions —
// read off the namespace so this module still loads against an older
// mlsSession (both are then simply skipped).
import * as mlsSession from './mlsSession';
import { getClientVersion } from './clientVersion'; // E2EV
import {
  routeAudioDatagram,
  retainOrReplaceRelayCipher,
  createKeyGraceSlot,
  claimOrgHeal,
  relayLaneStreamId,
  laneDuckMultiplier,
  onGroupKeyChange,
  DROP_NO_KEY,
  DROP_DECRYPT_FAILED,
} from './voiceRelayAudio';

// Key (re)derivation backoff — mirrors CommLink's KEY_RECOVERY_* values.
const KEY_RETRY_BASE_MS = 1500;
const KEY_RETRY_MAX_MS = 30_000;
// After this many unprompted retries with no keyless frames arriving, stop
// polling; the next dropped frame restarts the retry loop.
const KEY_RETRY_UNPROMPTED_ATTEMPTS = 3;
// Consecutive decrypt failures (with a key in hand) before assuming our key is
// stale and re-syncing the epoch. ~1 s of one speaker at 20 ms/frame.
const DECRYPT_FAIL_RECOVERY_THRESHOLD = 50;
// MR4: from this many back-to-back stale-key recoveries without a successful
// decrypt, the recovery also asks mlsSession to heal the org's encryption
// (external join / resync of diverged groups), throttled per org.
const DECRYPT_FAIL_HEAL_ATTEMPT = 2;
// Relay lanes unheard for this long are freed. Cascade lanes in particular
// never get a Leave here: the parent-channel speaker isn't in this room.
const LANE_IDLE_MS = 30_000;
const LANE_SWEEP_MS = 10_000;

// export_secret's error for a group this device was never added to — see
// CommLink.jsx's ERR_NOT_A_GROUP_MEMBER.
const ERR_NOT_A_GROUP_MEMBER = 'group not found in device state';
const isNotAGroupMemberError = (err) =>
  String(err?.message ?? err ?? '').includes(ERR_NOT_A_GROUP_MEMBER);

// Serialises this module's MLS calls across every monitor instance, so N
// monitored channels re-deriving at once don't interleave catch-up/persist
// cycles on the shared device state with each other.
let mlsChain = Promise.resolve();
function withMlsLock(fn) {
  const run = mlsChain.then(fn, fn);
  mlsChain = run.catch(() => {});
  return run;
}

const currentUserId = () => {
  try { return JSON.parse(localStorage.getItem('specter_user') || '{}')?.id; } catch { return undefined; }
};

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));

// ── Hook ─────────────────────────────────────────────────────────────────────
export default function useMonitorChannel({ org, channel, volume = 0.3, enabled = true }) {
  const [roster, setRoster] = useState([]);
  const [currentSpeaker, setCurrentSpeaker] = useState(null);
  const [connected, setConnected] = useState(false);

  // Connection-scoped state lives in one session object (see the connect
  // effect) so a stale async continuation from a previous connection can never
  // write into the current one.
  const sessionRef = useRef(null);
  const volumeRef = useRef(volume);
  useEffect(() => {
    volumeRef.current = volume;
    // Apply immediately to the gain node if it exists (browser path live update)
    const s = sessionRef.current;
    if (s?.masterGain && s.audioCtx) {
      s.masterGain.gain.setTargetAtTime(volume, s.audioCtx.currentTime, 0.02);
    }
  }, [volume]);

  // Fallback event id for servers whose media ticket predates `event_id`
  // (most callers' monitor channel objects don't carry it either).
  const channelEventIdRef = useRef(channel?.event_id ?? null);
  channelEventIdRef.current = channel?.event_id ?? null;

  // ── Connect / disconnect lifecycle ───────────────────────────────────────
  useEffect(() => {
    if (!enabled || !org?.id || !channel?.id) return;

    const channelId = channel.id;
    const s = {
      disposed: false,
      transport: null,
      orgId: org.id,
      channelId,
      eventId: null,
      relayMode: false,
      wasmReady: false,
      // MR4: receive keys with a rekey grace window (current + previous).
      channelRx: createKeyGraceSlot(),
      cascadeRx: createKeyGraceSlot(),
      // Relay-mode receive state
      ssrcToUserId: new Map(),    // from RosterMessage::SsrcMap
      duck: { active: false, activeSsrc: null, level: 0 },
      lanes: new Map(),           // browser: ssrc -> { ready, decoder, gainNode, nextPlayTime, lastHeard }
      nativeLanes: new Map(),     // Tauri: ssrc -> lastHeard
      senderKeys: new Map(),      // user_id -> Promise<Uint8Array[]>
      // Mixed-mode browser playback (unchanged single-decoder path)
      audioCtx: null,
      masterGain: null,
      mixedDecoder: null,
      // Key lifecycle
      deriving: false,
      derivePending: null,        // null | { sync: boolean }
      keyRetryTimer: null,
      keyRetryAttempt: 0,
      noKeyDropsSinceAttempt: 0,
      decryptFailStreak: { channel: 0, cascade: 0 },
      decryptRecoveryAt: 0,
      decryptRecoveryAttempt: 0,
      timers: new Set(),
      unsubs: [],
      sweepTimer: null,
      speakerTimer: null,
      currentSpeaker: null,
      invoke: null,
      dropLogCount: 0,
      sigWarnCount: 0,
    };
    sessionRef.current = s;

    const later = (fn, ms) => {
      const t = setTimeout(() => { s.timers.delete(t); if (!s.disposed) fn(); }, ms);
      s.timers.add(t);
      return t;
    };

    const getInvoke = async () => {
      if (s.invoke) return s.invoke;
      const { invoke } = await import('@tauri-apps/api/core');
      s.invoke = invoke;
      return invoke;
    };

    const ensureAudioCtx = () => {
      if (!s.audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        s.audioCtx = new AC();
        s.masterGain = s.audioCtx.createGain();
        s.masterGain.gain.value = volumeRef.current;
        s.masterGain.connect(s.audioCtx.destination);
      }
      if (s.audioCtx.state === 'suspended') s.audioCtx.resume().catch(() => {});
    };

    // ── Mixed mode: play exactly as before this hook knew about relay ─────
    const playMixedFrame = async (opusBytes) => {
      // Tauri path: invoke play_frame with volume
      if (window.__TAURI__) {
        const b64 = toBase64(opusBytes);
        try {
          const invoke = await getInvoke();
          invoke('plugin:specter-audio|play_frame', { data: b64, volume: volumeRef.current, streamId: channelId }).catch(() => {});
        } catch { /* best-effort */ }
        return;
      }

      // Browser path: Web Audio API with a GainNode
      ensureAudioCtx();
      s.masterGain.gain.value = volumeRef.current;

      if (!s.mixedDecoder) {
        try {
          const { OpusDecoder } = await import('opus-decoder');
          const dec = new OpusDecoder();
          await dec.ready;
          if (s.disposed) { dec.free?.(); return; }
          s.mixedDecoder = dec;
        } catch { return; }
      }
      try {
        const { channelData, samplesDecoded, sampleRate } = s.mixedDecoder.decodeFrame(opusBytes);
        if (!samplesDecoded) return;
        const buf = s.audioCtx.createBuffer(1, samplesDecoded, sampleRate || 48_000);
        buf.getChannelData(0).set(channelData[0]);
        const src = s.audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(s.masterGain);
        src.start();
      } catch { /* best-effort */ }
    };

    // ── Relay mode: one lane per sender ssrc ──────────────────────────────
    const getBrowserLane = (ssrc) => {
      let lane = s.lanes.get(ssrc);
      if (lane) return lane;
      ensureAudioCtx();
      const gainNode = s.audioCtx.createGain();
      // Start at the current duck gain so a lane appearing mid-duck doesn't get
      // a beat of full volume (same as CommLink's getOrCreateAudioLane).
      gainNode.gain.value = laneDuckMultiplier(s.duck, ssrc);
      gainNode.connect(s.masterGain);
      lane = { decoder: null, gainNode, nextPlayTime: 0, lastHeard: Date.now() };
      lane.ready = (async () => {
        const { OpusDecoder } = await import('opus-decoder');
        const dec = new OpusDecoder();
        await dec.ready;
        lane.decoder = dec;
        return dec;
      })();
      lane.ready.catch(() => { if (s.lanes.get(ssrc) === lane) clearLane(ssrc); });
      s.lanes.set(ssrc, lane);
      return lane;
    };

    const playRelayFrame = async (ssrc, opusBytes) => {
      if (window.__TAURI__) {
        // play_frame takes volume per call — fold the duck multiplier in here
        // (CommLink's native path does the same).
        s.nativeLanes.set(ssrc, Date.now());
        const vol = volumeRef.current * laneDuckMultiplier(s.duck, ssrc);
        const b64 = toBase64(opusBytes);
        try {
          const invoke = await getInvoke();
          invoke('plugin:specter-audio|play_frame', { data: b64, volume: vol, streamId: relayLaneStreamId(channelId, ssrc) }).catch(() => {});
        } catch { /* best-effort */ }
        return;
      }

      const lane = getBrowserLane(ssrc);
      lane.lastHeard = Date.now();
      let dec;
      try { dec = await lane.ready; } catch { return; }
      if (s.disposed || s.lanes.get(ssrc) !== lane) return;
      try {
        const { channelData, samplesDecoded, sampleRate } = dec.decodeFrame(opusBytes);
        if (!samplesDecoded) return;
        const ctx = s.audioCtx;
        const buf = ctx.createBuffer(1, samplesDecoded, sampleRate || 48_000);
        buf.getChannelData(0).set(channelData[0]);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(lane.gainNode);
        // Gapless per-lane scheduling; re-anchor after a gap (>150 ms behind).
        const now = ctx.currentTime;
        if (lane.nextPlayTime !== 0 && lane.nextPlayTime < now - 0.15) lane.nextPlayTime = 0;
        const startAt = Math.max(lane.nextPlayTime || now, now + 0.005);
        src.start(startAt);
        lane.nextPlayTime = startAt + buf.duration;
      } catch { /* best-effort */ }
    };

    // Frees one relay lane on both playback paths.
    const clearLane = (ssrc) => {
      const lane = s.lanes.get(ssrc);
      if (lane) {
        s.lanes.delete(ssrc);
        try { lane.gainNode.disconnect(); } catch { /* best-effort */ }
        if (lane.decoder) lane.decoder.free?.();
        else lane.ready?.then((d) => d.free?.()).catch(() => {});
      }
      if (s.nativeLanes.has(ssrc)) {
        s.nativeLanes.delete(ssrc);
        if (window.__TAURI__) {
          getInvoke().then((invoke) => invoke('plugin:specter-audio|clear_stream', { streamId: relayLaneStreamId(channelId, ssrc) }).catch(() => {})).catch(() => {});
        }
      }
      // Replay state is NOT cleared with the lane: it lives in the wasm
      // receiver (bounded, LRU) so an idle lane can't be re-fed old frames.
    };

    const sweepIdleLanes = () => {
      const cutoff = Date.now() - LANE_IDLE_MS;
      for (const [ssrc, lane] of [...s.lanes]) if (lane.lastHeard < cutoff) clearLane(ssrc);
      for (const [ssrc, lastHeard] of [...s.nativeLanes]) if (lastHeard < cutoff) clearLane(ssrc);
    };

    // Browser path: CommLink's applyDuckStateToLanes, same fade timings.
    const applyDuckToLanes = () => {
      if (!s.audioCtx) return;
      const fade = s.duck.active ? 0.1 : 0.5;
      for (const [ssrc, lane] of s.lanes) {
        lane.gainNode.gain.setTargetAtTime(laneDuckMultiplier(s.duck, ssrc), s.audioCtx.currentTime, fade);
      }
    };

    // ── Sender signature (best-effort, never gates playback — as CommLink) ─
    const getSenderKeys = (userId) => {
      let p = s.senderKeys.get(userId);
      if (!p) {
        p = api.getUserDeviceKeyPackages(userId)
          .then(({ data }) => (data?.devices ?? [])
            .filter((d) => d.public_key)
            .map((d) => Uint8Array.from(atob(d.public_key), (c) => c.charCodeAt(0))))
          .catch(() => []);
        s.senderKeys.set(userId, p);
      }
      return p;
    };

    const verifySenderSignature = (frame) => {
      if (!frame.senderSignature) return;
      const userId = s.ssrcToUserId.get(frame.ssrc >>> 0);
      if (!userId) return;
      // frame.opusBytes is still the ciphertext here — the signature covers
      // what was sent, not the decrypted Opus.
      getSenderKeys(userId).then((keys) => {
        if (s.disposed || keys.length === 0) return;
        let ok = false;
        try { ok = keys.some((pk) => verifySignature(pk, frame.opusBytes, frame.senderSignature)); } catch { /* best-effort */ }
        if (!ok && (s.sigWarnCount++ % 250) === 0) {
          console.warn('[Monitor] signature verification failed for ssrc', frame.ssrc, 'on channel', channelId, '— playing anyway (defense-in-depth, not a hard gate)');
        }
      });
    };

    // ── Key lifecycle (relay only) ────────────────────────────────────────
    const keysComplete = () => !!s.channelRx.current && (!s.eventId || !!s.cascadeRx.current);

    const scheduleKeyRetry = () => {
      if (s.disposed || !s.relayMode || !s.wasmReady || s.keyRetryTimer || keysComplete()) return;
      s.keyRetryAttempt += 1;
      const delay = Math.min(KEY_RETRY_BASE_MS * 2 ** (s.keyRetryAttempt - 1), KEY_RETRY_MAX_MS);
      s.keyRetryTimer = later(() => {
        s.keyRetryTimer = null;
        // Lazy: keep polling only while there's actually keyless audio to
        // recover (or for the first few attempts after connect).
        if (s.keyRetryAttempt > KEY_RETRY_UNPROMPTED_ATTEMPTS && s.noKeyDropsSinceAttempt === 0) return;
        s.noKeyDropsSinceAttempt = 0;
        deriveKeys({ sync: true });
      }, delay);
    };

    // sync=true first catches the device's local MLS state up to the server
    // (pending Welcome + commits, nothing submitted); sync=false only
    // re-exports from whatever local state already has — enough after
    // WarRoom's SSE handler just applied a commit for us.
    // heal=true (sustained decrypt failures only) first runs mlsSession's
    // org-wide healOrgEncryption — throttled per org, see claimOrgHeal.
    const deriveKeys = async ({ sync, heal = false }) => {
      if (s.disposed || !s.relayMode || !s.wasmReady) return;
      if (s.deriving) {
        s.derivePending = { sync: sync || !!s.derivePending?.sync, heal: heal || !!s.derivePending?.heal };
        return;
      }
      s.deriving = true;
      try {
        const uid = currentUserId();
        // Outside withMlsLock: healOrgEncryption serialises through
        // mlsSession's own queue, and holding our lock across an org-wide
        // heal would stall every other monitor's re-export behind it.
        if (heal && typeof mlsSession.healOrgEncryption === 'function' && claimOrgHeal(s.orgId)) {
          try {
            const r = await mlsSession.healOrgEncryption(api, uid, s.orgId);
            console.warn(`[Monitor] org encryption heal after sustained decrypt failures on ${channelId}: healed=${r?.healed?.length ?? 0} failed=${r?.failed?.length ?? 0}`);
          } catch (err) {
            console.warn('[Monitor] org encryption heal failed for', s.orgId, err?.message || err);
          }
        }
        await withMlsLock(async () => {
          if (s.disposed) return;
          if (sync) {
            try { await syncChannelGroupEpoch(api, uid, s.orgId, channelId); }
            catch (err) { console.warn('[Monitor] MLS catch-up failed for channel', channelId, err); }
          }
          // E2EV: catch the event group up too before re-exporting the cascade key.
          if (sync && s.eventId) {
            try { await syncEventGroupEpoch(api, uid, s.orgId, s.eventId); }
            catch (err) { console.warn('[Monitor] MLS catch-up failed for event', s.eventId, err); }
          }
          try {
            const key = await exportGroupSecret(api, uid, channelId, 'audio', 32);
            // Same-epoch re-export keeps the existing receiver (and with it
            // the authenticated replay windows) — see retainOrReplaceRelayCipher.
            // A new secret moves the old receiver into the grace slot.
            if (!s.disposed) s.channelRx.install(retainOrReplaceRelayCipher(s.channelRx.current, key, () => new RelayAudioReceiver(key, false)));
          } catch (err) {
            // Not (or no longer) a member: drop both keys, no grace, fail closed.
            if (isNotAGroupMemberError(err)) s.channelRx.clear();
            else console.warn('[Monitor] channel audio key derivation failed for', channelId, err);
          }
          if (s.eventId) {
            try {
              const key = await exportGroupSecret(api, uid, s.eventId, 'audio-cascade', 32);
              if (!s.disposed) s.cascadeRx.install(retainOrReplaceRelayCipher(s.cascadeRx.current, key, () => new RelayAudioReceiver(key, true)));
            } catch (err) {
              if (isNotAGroupMemberError(err)) s.cascadeRx.clear();
              else console.warn('[Monitor] event cascade key derivation failed for', s.eventId, err);
            }
          }
        });
      } finally {
        s.deriving = false;
      }
      if (s.disposed) return;
      if (keysComplete()) {
        s.keyRetryAttempt = 0;
        if (s.keyRetryTimer) { clearTimeout(s.keyRetryTimer); s.timers.delete(s.keyRetryTimer); s.keyRetryTimer = null; }
      }
      const pending = s.derivePending;
      s.derivePending = null;
      if (pending) deriveKeys(pending);
      else scheduleKeyRetry();
    };

    // ── Datagram → playback ───────────────────────────────────────────────
    const handleDatagram = (value) => {
      if (!s.relayMode) {
        // Mixed: unchanged semantics, except that an ssrc≠0 frame (a relay
        // parent's encrypted cascade copy — see DROP_UNEXPECTED_RELAY_FRAME)
        // is no longer decoded as if it were Opus.
        const r = routeAudioDatagram(value, { relayMode: false });
        if (r.action === 'play') playMixedFrame(r.opusBytes);
        return;
      }

      const r = routeAudioDatagram(value, {
        relayMode: true,
        channelKey: s.channelRx.current,
        cascadeKey: s.cascadeRx.current,
        channelPrevKey: s.channelRx.previous,
        cascadePrevKey: s.cascadeRx.previous,
      });
      if (r.action === 'play') {
        s.decryptFailStreak[r.frame.isGlobalBroadcast ? 'cascade' : 'channel'] = 0;
        s.decryptRecoveryAttempt = 0;
        verifySenderSignature(r.frame);
        playRelayFrame(r.ssrc, r.opusBytes);
        return;
      }
      if (r.action !== 'drop') return;

      if (r.reason === DROP_NO_KEY) {
        s.noKeyDropsSinceAttempt += 1;
        scheduleKeyRetry();
      } else if (r.reason === DROP_DECRYPT_FAILED) {
        // A stale key (missed commit) shows up as every frame failing both the
        // current and the grace key. Re-sync with backoff, escalating to an
        // org heal if re-syncing alone keeps failing; a single bad/forged
        // frame just gets dropped.
        // Tracked per key, so a healthy channel key can't mask a stale
        // cascade key (or vice versa).
        const which = r.frame?.isGlobalBroadcast ? 'cascade' : 'channel';
        s.decryptFailStreak[which] += 1;
        const backoff = Math.min(KEY_RETRY_BASE_MS * 2 ** s.decryptRecoveryAttempt, KEY_RETRY_MAX_MS);
        if (s.decryptFailStreak[which] >= DECRYPT_FAIL_RECOVERY_THRESHOLD && Date.now() - s.decryptRecoveryAt >= backoff) {
          s.decryptFailStreak[which] = 0;
          s.decryptRecoveryAt = Date.now();
          const heal = s.decryptRecoveryAttempt >= DECRYPT_FAIL_HEAL_ATTEMPT;
          s.decryptRecoveryAttempt = Math.min(s.decryptRecoveryAttempt + 1, 10);
          deriveKeys({ sync: true, heal });
        }
      }
      if ((s.dropLogCount++ % 250) === 0) {
        console.warn(`[Monitor] dropping relay frame on channel ${channelId} (${r.reason}, ssrc=${r.ssrc})`);
      }
    };

    const readDatagrams = async (transport) => {
      const reader = transport.datagrams.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done || s.disposed) break;
          try { handleDatagram(value); } catch { /* best-effort */ }
        }
      } catch { /* best-effort */ }
    };

    // ── Roster stream ─────────────────────────────────────────────────────
    const handleRosterMsg = (msg) => {
      if (msg.type === 'Snapshot') {
        setRoster(msg.data || []);
      } else if (msg.type === 'Join') {
        setRoster(prev => prev.includes(msg.data) ? prev : [...prev, msg.data]);
        if (s.relayMode) {
          // Same as CommLink's Join handler: a joiner may have bumped the
          // epoch; re-export now and again once the commit has likely landed.
          deriveKeys({ sync: false });
          later(() => deriveKeys({ sync: false }), 1500);
        }
      } else if (msg.type === 'Leave') {
        // msg.data is { callsign, user_id } (server v1.10.23+), a bare
        // callsign before that.
        const leavingCallsign = typeof msg.data === 'string' ? msg.data : msg.data?.callsign;
        const leavingUserId = typeof msg.data === 'string' ? null : msg.data?.user_id;
        setRoster(prev => prev.filter(u => u !== leavingCallsign));
        if (s.relayMode) {
          deriveKeys({ sync: false });
          if (leavingUserId) {
            for (const [ssrc, uid] of [...s.ssrcToUserId]) {
              if (uid !== leavingUserId) continue;
              s.ssrcToUserId.delete(ssrc);
              clearLane(ssrc);
            }
          }
        }
      } else if (msg.type === 'SsrcMap') {
        const next = new Map();
        for (const [ssrcStr, userId] of Object.entries(msg.data || {})) next.set(Number(ssrcStr), userId);
        s.ssrcToUserId = next;
      } else if (msg.type === 'Duck') {
        if (!s.relayMode) return; // mixed rooms: unchanged (no client-side ducking here)
        s.duck = { active: true, activeSsrc: msg.data?.ssrc >>> 0, level: msg.data?.level ?? 2 };
        applyDuckToLanes();
      } else if (msg.type === 'DuckRelease') {
        if (!s.relayMode) return;
        s.duck = { active: false, activeSsrc: null, level: 0 };
        applyDuckToLanes();
      } else if (msg.type === 'Speaking') {
        const { callsign, level } = msg.data || {};
        if (!callsign || level < 10) return;

        if (s.currentSpeaker !== callsign) {
          s.currentSpeaker = callsign;
          setCurrentSpeaker(callsign);
        }

        // Reset silence timer — clear speaker after 1.5 s of no Speaking messages
        if (s.speakerTimer) clearTimeout(s.speakerTimer);
        s.speakerTimer = setTimeout(() => {
          s.currentSpeaker = null;
          if (!s.disposed) setCurrentSpeaker(null);
        }, 1500);
      }
    };

    const readRosterStream = async (stream) => {
      const reader = stream.getReader();
      let buf = new Uint8Array(0);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done || s.disposed) break;
          // Concatenate chunks
          const next = new Uint8Array(buf.length + value.length);
          next.set(buf); next.set(value, buf.length);
          buf = next;
          // Parse newline-delimited JSON
          let nl;
          while ((nl = buf.indexOf(0x0a)) !== -1) {
            const line = new TextDecoder().decode(buf.slice(0, nl)).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { handleRosterMsg(JSON.parse(line)); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }
    };

    const readIncomingStreams = async (transport) => {
      try {
        const reader = transport.incomingUnidirectionalStreams.getReader();
        while (true) {
          const { value: stream, done } = await reader.read();
          if (done) break;
          // First byte identifies stream type: 0x01 = roster
          const probe = stream.getReader();
          const { value: firstChunk } = await probe.read();
          probe.releaseLock();
          if (firstChunk && firstChunk[0] === 0x01) {
            readRosterStream(stream);
          }
          // Other stream types (video etc.) are ignored for monitor channels
        }
      } catch { /* best-effort */ }
    };

    const connect = async () => {
      try {
        // E2EV: voice tickets carry our version (server minimum-version gate).
        const { data, error } = await api.getOrgMediaTicket(org.id, channelId, 'voice', null, await getClientVersion());
        if (s.disposed || error || !data?.ticket) return;
        // E2EV: end-to-end relay is the only mode; never monitor a mixed
        // (plaintext) room — that would mean an out-of-date server.
        if (data.voice_relay !== true) {
          console.warn('[Monitor] server offered a non-E2E voice room — not monitoring', channelId);
          return;
        }
        s.relayMode = true;
        s.eventId = data.event_id ?? channelEventIdRef.current ?? null;

        if (s.relayMode) {
          try {
            await initWasm();
            s.wasmReady = true;
          } catch (err) {
            // No SFrame on this device: every relay frame drops (fail closed).
            console.warn('[Monitor] WASM SFrame init failed — relay-mode audio on this channel will stay silent:', err);
          }
          if (s.disposed) return;
          s.unsubs.push(onGroupKeyChange(channelId, () => deriveKeys({ sync: false })));
          if (s.eventId) s.unsubs.push(onGroupKeyChange(s.eventId, () => deriveKeys({ sync: false })));
          // MR4: a heal or catch-up done anywhere else (startup, the resync
          // button, another channel's recovery) re-derives at once.
          if (typeof mlsSession.onGroupStateChange === 'function') {
            const unsub = mlsSession.onGroupStateChange((groupId) => {
              if (groupId === channelId || (s.eventId && groupId === s.eventId)) deriveKeys({ sync: false });
            });
            if (typeof unsub === 'function') s.unsubs.push(unsub);
          }
          s.sweepTimer = setInterval(sweepIdleLanes, LANE_SWEEP_MS);
          // Don't block the connection on MLS: frames arriving before the key
          // is ready are dropped, then audio starts as soon as it lands.
          deriveKeys({ sync: true });
        }

        const base = (data.media_url || 'https://localhost:4434').replace(/\/$/, '');
        const url = `${base}/specter?token=${data.ticket}&channel_id=${channelId}`;
        const transport = new WebTransport(url);
        s.transport = transport;
        await transport.ready;
        if (s.disposed) { try { transport.close(); } catch { /* best-effort */ } return; }
        setConnected(true);
        readDatagrams(transport);
        readIncomingStreams(transport);
        // Monitor closure
        transport.closed.then(() => {
          if (!s.disposed) setConnected(false);
        }).catch(() => { if (!s.disposed) setConnected(false); });
      } catch {
        if (!s.disposed) setConnected(false);
      }
    };

    connect();

    return () => {
      s.disposed = true;
      if (sessionRef.current === s) sessionRef.current = null;
      setConnected(false);
      setRoster([]);
      setCurrentSpeaker(null);
      if (s.speakerTimer) clearTimeout(s.speakerTimer);
      if (s.sweepTimer) clearInterval(s.sweepTimer);
      for (const t of s.timers) clearTimeout(t);
      s.timers.clear();
      for (const unsub of s.unsubs) unsub();
      try { s.transport?.close(); } catch { /* best-effort */ }
      s.transport = null;
      // Reset native decoder state so reconnects start with a fresh stream:
      // the bare channel id (mixed) plus every relay lane heard this session.
      for (const ssrc of [...s.lanes.keys(), ...s.nativeLanes.keys()]) clearLane(ssrc);
      if (window.__TAURI__) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('plugin:specter-audio|clear_stream', { streamId: channelId }).catch(() => {});
        }).catch(() => {});
      }
      if (s.mixedDecoder) { s.mixedDecoder.free?.(); s.mixedDecoder = null; }
      if (s.audioCtx) { s.audioCtx.close().catch(() => {}); s.audioCtx = null; s.masterGain = null; }
      s.channelRx.clear();
      s.cascadeRx.clear();
    };
  }, [enabled, org?.id, channel?.id]);

  return { roster, currentSpeaker, connected };
}
