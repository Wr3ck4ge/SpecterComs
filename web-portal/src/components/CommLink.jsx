import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import initWasm, { SFrameCrypto, RelayAudioSender, RelayAudioReceiver } from 'wasm-crypto';
import { saveChannelMessage, getChannelMessages } from '../messageStore';
import { ensureChannelGroup, syncChannelGroupEpoch, syncEventGroupEpoch, exportGroupSecret, ensureEventGroup, signBytes, verifySignature } from '../mlsSession';
// MR4: onGroupStateChange / healOrgEncryption are MR1's (v2.0.1) additions —
// read off the namespace so this still loads against an older mlsSession.
import * as mlsSession from '../mlsSession';
import { decodeAudioFrameProto, encodeAudioFrameProto, openAudioFrame, retainOrReplaceRelayCipher, relayLaneStreamId, duckGainForLevel, onGroupKeyChange, createKeyGraceSlot, sameSFrameKey, withGraceKeys, installGroupKey, noteGroupMemberRemoved, consumeGroupMemberRemoval, claimOrgHeal, EVENT_CASCADE_LANE, OP_VIDEO_KEY_LABEL, DROP_NO_KEY, DROP_REPLAY, DROP_STALE, DROP_DECRYPT_FAILED } from '../voiceRelayAudio';
import { getClientVersion, isUpgradeRequiredError } from '../clientVersion'; // E2EV
import { VAD_KEYS, applyNativeVadConfig, readManualThreshold, serverThresholdFor } from '../engine/voiceActivation';
// SV: the strip's stream viewer is fed decrypted frames over the engine bridge.
import { EV as BRIDGE_EV, STREAM_STATUS, STRIP_WINDOW, createOrderedEmitter } from '../engine/bridge';
import { createLiveVoiceLevels, useSampledVoiceLevels } from '../engine/voiceLevels';
// Keyframe-on-request: viewers that lost sync ask the sharer for an IDR.
import { bridgeListen } from '../engine/bridge';
import {
  OVERLAY_KEYFRAME_REQUEST_EVENT, VIEWER_REQUEST_INTERVAL_MS, PUBLISHER_FORCE_INTERVAL_MS,
  PUBLISHER_CONGESTION_FORCE_INTERVAL_MS, createThrottledTrigger, keyframeRequestDatagram, isKeyframeRequestSignal,
} from '../engine/keyframeRequest';
import { createVideoSendPump } from '../engine/videoSendPump';
// NET: connect-failure classification + the alternate-port decision (pure).
import {
  chooseMediaUrl, classifyConnectFailure, connectIssueFrom, portOfUrl, readAltPref, writeAltPref,
} from '../engine/connectionRepair';
import { createTransport } from '../engine/transportFactory'; // native WebTransport fallback
import { spsDimsFromAnnexB } from '../engine/h264Sps';
import { decideVideoRecovery, RECOVERY_STABLE_MS } from '../engine/videoRecovery';
import { nativeCaptureLimits } from '../engine/captureLimits';
// S2/S3: screen-share audio, as datagrams on the video sessions (in-stream fallback).
import {
  SHARE_AUDIO_FRAME_EVENT, OVERLAY_SHARE_AUDIO_VOLUME_EVENT, SHARE_AUDIO_STATE_CONTROL,
  isShareAudioFlags, isShareAudioCapableSignal, isShareAudioDgramCapableSignal, decodeShareAudioInner,
  shareAudioSubscribeParams, createShareAudioSender, readShareAudioDatagrams, datagramSizeLimit,
  SHARE_AUDIO_DATAGRAM_MAX_AGE_MS, SHARE_AUDIO_DATAGRAM_HIGH_WATER_MARK,
  createShareAudioNative, createShareAudioPlayer, loadShareAudioEnabled, saveShareAudioEnabled,
  loadSharerAudioPref, saveSharerAudioPref,
} from '../engine/shareAudio';
import { createLaneGainSync } from '../engine/userVolume'; // PM: per-user voice volume
import { routeMicFrame, ROUTE_GROUP } from '../engine/activeNet'; // frequency overlay: active-net TX

// ── Diagnostic trace logging (debrief/reconnect-storm investigation) ────────
// See WarRoom.jsx's traceLog for the full rationale — same mechanism (writes
// to setup_errors.log via client_log so it survives a renderer hang).
function traceLog(msg) {
  const line = `[trace] ${msg}`;
  if (window.__TAURI__) {
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('client_log', { msg: line })).catch(() => {});
  } else {
    console.log(line);
  }
}

// specter.v1.AudioFrame encode/decode, the fail-closed relay-mode decrypt gate,
// per-ssrc dedup and lane ids live in ../voiceRelayAudio.js — shared with
// useMonitorChannel so monitored channels open frames exactly the same way.

function hashUserId(id) {
  if (!id) return 1;
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) >>> 0 || 1;
}

// Installs (or keeps, if `secret` is unchanged) the relay-audio receiver +
// sender pair for one lane (channel 'audio' or event 'audio-cascade' export).
// MR4: `rxSlot` is a createKeyGraceSlot — a replaced receiver stays usable as
// the lane's previous key for KEY_GRACE_MS (the slot frees it then), while
// the sender switches immediately and the old one is freed at once.
// `groupId` is the MLS group the secret was exported from: after a commit
// that removed a member of it the replaced receiver gets no grace window
// (installGroupKey / noteGroupMemberRemoved in voiceRelayAudio.js).
function installRelayAudioPair(rxSlot, txRef, secret, isCascade, groupId) {
  const nextRx = retainOrReplaceRelayCipher(rxSlot.current, secret, () => new RelayAudioReceiver(secret, isCascade));
  const nextTx = retainOrReplaceRelayCipher(txRef.current, secret, () => new RelayAudioSender(secret, isCascade));
  const oldTx = txRef.current;
  installGroupKey(rxSlot, nextRx, groupId);
  txRef.current = nextTx;
  if (oldTx && oldTx !== nextTx) { try { oldTx.free(); } catch { /* best-effort */ } }
}

// E2EV: drop one lane's pair (no longer a member / switched channel) — the
// send path then stays silent and the receive path drops, fail closed. No
// grace window: the slot frees its previous key too.
function clearRelayAudioPair(rxSlot, txRef) {
  const oldTx = txRef.current;
  rxSlot.clear();
  txRef.current = null;
  if (oldTx) { try { oldTx.free(); } catch { /* best-effort */ } }
}

// E2EV: voice key recovery while keyless (backoff) and stale-key recovery on
// sustained decrypt failures.
const VOICE_KEY_RETRY_BASE_MS = 1000;
const VOICE_KEY_RETRY_MAX_MS = 30_000;
// Keyless retries (about 30 s in) before the user is told why, not just "waiting".
const VOICE_KEY_PROBLEM_ATTEMPT = 5;
const VOICE_DECRYPT_FAIL_THRESHOLD = 25; // ≈0.5 s of one sender's frames
// MR4: stale-key recovery escalates by how many recoveries in a row have run
// without a single frame decrypting since: 0 → catch-up + re-export (as
// before), 1 → ensureChannelGroup / ensureEventGroup (external join when not a
// member, once MR1 lands), ≥ 2 → mlsSession.healOrgEncryption for the org
// (throttled per org — claimOrgHeal), then re-export.
const KEY_HEAL_ENSURE_LEVEL = 1;
const KEY_HEAL_ORG_LEVEL = 2;
// ─────────────────────────────────────────────────────────────────────────────

function concatU8(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}

// Convert H.264 Annex-B byte stream (start codes) to AVCC (4-byte length prefix) format.
// WebCodecs VideoDecoder for avc1.* expects AVCC-framed NAL units.
// libx264 (used in Tauri native capture) outputs Annex-B format.
function annexBToAvcc(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const nalUnits = [];
  let i = 0;
  const len = data.length;

  while (i < len) {
    // Find start code: 0x000001 (3-byte) or 0x00000001 (4-byte)
    let startCodeLen = 0;
    if (i + 3 < len && view.getUint32(i) === 0x00000001) {
      startCodeLen = 4;
    } else if (i + 2 < len && data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) {
      startCodeLen = 3;
    } else {
      i++;
      continue;
    }
    const nalStart = i + startCodeLen;

    // Find next start code to determine NAL unit boundary
    let nalEnd = len;
    for (let j = nalStart; j < len - 2; j++) {
      if (data[j] === 0 && data[j+1] === 0 && data[j+2] === 1) {
        nalEnd = (j > 0 && data[j-1] === 0) ? j - 1 : j;
        break;
      }
    }

    const nalUnit = data.slice(nalStart, nalEnd);
    if (nalUnit.length > 0) nalUnits.push(nalUnit);
    i = nalEnd;
  }

  if (nalUnits.length === 0) return data; // fallback: pass through unchanged

  // Assemble AVCC: each NAL unit prefixed with 4-byte big-endian length
  let totalLen = 0;
  for (const nal of nalUnits) totalLen += 4 + nal.length;
  const out = new Uint8Array(totalLen);
  const outView = new DataView(out.buffer);
  let offset = 0;
  for (const nal of nalUnits) {
    outView.setUint32(offset, nal.length);
    out.set(nal, offset + 4);
    offset += 4 + nal.length;
  }
  return out;
}

// Stream quality profiles — indexed by org tier (0 = Free, 1 = Premium, 2 = Ultra)
// Tier 2 is wired and ready; gate it via org.tier = 2 in the DB when billing is ready.
//
// Hard-capped at 1080p for now: this feed exists to seed the overlay's situational-
// awareness view, not to deliver a pristine full-res stream — the in-app preview is
// a secondary perk. Encoding/capturing above 1080p only burns GPU and bandwidth on
// weaker machines/connections without improving the thing that actually matters
// (the overlay). Revisit once the transport-side adaptive bitrate work lands.
const STREAM_PROFILES = [
  { fps: 30, bitrate:  5_000_000, width: 1920, height: 1080 }, // Tier 0: Free     — 1080p 30fps  5 Mbps
  { fps: 60, bitrate: 10_000_000, width: 1920, height: 1080 }, // Tier 1: Premium  — 1080p 60fps 10 Mbps
  { fps: 60, bitrate: 20_000_000, width: 1920, height: 1080 }, // Tier 2: Ultra    — 1080p 60fps 20 Mbps
];

// Hard ceiling applied everywhere a profile's resolution reaches the capture/encode
// pipeline, regardless of tier table above or any future profileOverride — belt and
// suspenders so nothing can push the encoder past 1080p while this cap is in effect.
const MAX_STREAM_WIDTH = 1920;
const MAX_STREAM_HEIGHT = 1080;
function capProfileResolution(profile) {
  return {
    ...profile,
    width: Math.min(profile.width, MAX_STREAM_WIDTH),
    height: Math.min(profile.height, MAX_STREAM_HEIGHT),
  };
}

// Aspect-preserving cap for actual captured track dimensions (browser getDisplayMedia
// fallback path) — `ideal` constraints in getUserMedia/getDisplayMedia are non-binding,
// so the browser can still hand back a native-resolution track. This is the JS-side
// equivalent of enc_dims() in the Rust capture pipeline (capture/mod.rs), which downscales
// via GPU VideoProcessorBlt before NVENC/AMF; here VideoEncoder does the same scaling
// internally when configured with a smaller width/height than the input VideoFrame.
function capEncodeDims(w, h) {
  if (w <= MAX_STREAM_WIDTH && h <= MAX_STREAM_HEIGHT) return { w, h };
  const scale = Math.min(MAX_STREAM_WIDTH / w, MAX_STREAM_HEIGHT / h);
  return {
    w: Math.max(2, Math.round(w * scale) & ~1),
    h: Math.max(2, Math.round(h * scale) & ~1),
  };
}

// Reads media-rust's one-byte signal streams on a publish transport and hands
// each first byte to `onSignal`: 0xAC = a viewer subscribed (go live), 0xDE =
// last viewer left (keepalive mode), KEYFRAME_REQUEST_BYTE = a viewer needs a
// keyframe (see keyframeRequest.js). Unknown bytes are ignored, which is what
// lets the server add signals without breaking older clients.
function listenPublishSignals(transport, onSignal) {
  (async () => {
    try {
      const reader = transport.incomingUnidirectionalStreams.getReader();
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        const sr = stream.getReader();
        try {
          const { value: bytes } = await sr.read();
          if (bytes?.length > 0) onSignal(bytes);
        } finally { sr.releaseLock(); }
      }
    } catch {}
  })();
}

// Matches OVERLAY_MAX_DECODE_QUEUE in GameOverlayWindow.jsx — same rationale:
// WebCodecs has no built-in way to skip ahead once its internal decode queue
// backs up, so past this depth, drop non-key frames until the next keyframe
// rather than letting a struggling machine fall further behind on every tick.
const MAIN_MAX_DECODE_QUEUE = 2;
// SV: when the strip's viewer takes over a running stream, the current GOP is
// replayed to it so it shows a picture at once instead of waiting up to a GOP
// for the next keyframe — but only a short one (a long GOP is a burst of IPC
// and decode work for a frame that's about to be replaced anyway).
const SV_GOP_REPLAY_MAX = 60;

// SV: base64 for the local IPC relay. Chunk size must be a multiple of 3 so
// no chunk but the last is padded (see the overlay relay's note).
function bytesToBase64(bytes) {
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 6144) b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 6144)));
  return b64;
}

// ── Stream encryption declaration ───────────────────────────────────────────
// A video frame on the wire is [4B size][1B type][4B ts_ms][payload], where the
// type byte is 0 = keyframe, 1 = delta. Nothing in that framing said whether
// the payload was encrypted, so a receiver had to guess from its own state:
// "I hold a key, so this must be ciphertext". When the guess was wrong the
// ciphertext went straight into VideoDecoder.decode() and the stream died with
// an opaque decoder error — the sender's crypto state is completely independent
// of the receiver's (either side can fail WASM init, or not be an MLS group
// member yet), so the guess was wrong routinely rather than exceptionally.
//
// The declaration lives in the stream header, NOT in a spare bit of the type
// byte. Shipped clients parse that byte as `buffer[4] === 0 ? 'key' : 'delta'`,
// so any extra bit set on a keyframe makes every already-installed client read
// it as a delta, never resync, and sit black forever. The payload offset is
// fixed at byte 9, so there is also no room to append a per-frame flag without
// shifting what old clients slice. An unknown *header* field, by contrast, is
// silently ignored by every past version — it's the only backward-compatible
// place to put this.
//
// Because it is per stream rather than per frame, the sender must latch the
// decision for the stream's lifetime (see streamEncrypted) — otherwise a sharer
// that acquires a key mid-stream (refreshVideoKey on a roster Join) would start
// encrypting under a header that says it doesn't, reintroducing the exact bug.
const STREAM_ENCRYPTION_FIELD = 'encrypted';

// Key recovery backoff for an encrypted stream this device has no key for (see
// keyMissingFrames). Deliberately slower than the decrypt-failure refresh: that
// one re-derives a secret we can already export, whereas this one is waiting on
// another member to commit us into the MLS group, which is human-paced (someone
// has to open the channel) and involves real server round-trips per attempt.
const KEY_RECOVERY_FRAME_THRESHOLD = 10;
const KEY_RECOVERY_BASE_MS = 1500;
const KEY_RECOVERY_MAX_MS = 30_000;

// export_secret's error for a group this device was never added to (see
// export_secret_impl in mls-crypto). Distinguishing it from a genuine WASM load
// failure matters: the former is "wait to be welcomed", recoverable without user
// action, while the latter means E2E can't work on this device at all.
const ERR_NOT_A_GROUP_MEMBER = 'group not found in device state';
// OpenMLS UseAfterEviction: a commit removed this device but its copy hasn't
// been dropped yet (mlsSession drops it on the next commit or catch-up) —
// keyless all the same.
const ERR_EVICTED_FROM_GROUP = 'after being evicted from it';
const isNotAGroupMemberError = (err) => {
  const msg = String(err?.message ?? err ?? '');
  return msg.includes(ERR_NOT_A_GROUP_MEMBER) || msg.includes(ERR_EVICTED_FROM_GROUP);
};

// What to tell a user still keyless after VOICE_KEY_PROBLEM_ATTEMPT tries;
// `reason` is ensureChannelGroup's (mlsSession.js). Recovery keeps running.
const voiceKeyProblemText = (reason) => {
  if (reason === 'not_on_list') return 'Your account is not on this channel\'s access list, so it gets no encryption key.';
  if (reason === 'group_info_unavailable') return 'This channel\'s encryption needs one of its members online. Your voice stays silent until then.';
  return 'Could not get this channel\'s encryption key. Still retrying; Resync encryption may help.';
};

// Rollout-period safety net for senders predating STREAM_ENCRYPTION_FIELD, where
// "is this encrypted?" has to be guessed. Every codec this app decodes is fed
// as a bytestream (Annex-B for H.264/HEVC — see annexBToAvcc's comment — and
// VP8/VP9 keyframes likewise have fixed magic), so a *keyframe* payload that
// doesn't begin with an Annex-B start code is not plaintext video. Ciphertext
// begins with 12 random nonce bytes and so passes this test with probability
// ~2^-24, making a false "plaintext" verdict vanishingly unlikely.
//
// Only ever used to *reject* a frame we were about to guess was plaintext —
// never to claim one is encrypted when the flag says otherwise. Deltas are not
// checked: a mid-GOP slice has no reliable leading magic.
const looksLikeAnnexB = (data) =>
  data.length >= 4 &&
  data[0] === 0x00 && data[1] === 0x00 &&
  (data[2] === 0x01 || (data[2] === 0x00 && data[3] === 0x01));

function getAdaptiveStreamProfile(orgTier = 0, concurrentSharers = 1) {
  const base = capProfileResolution(STREAM_PROFILES[orgTier] ?? STREAM_PROFILES[0]);
  if (concurrentSharers >= 4) {
    return {
      ...base,
      fps: Math.min(base.fps, 24),
      bitrate: Math.min(base.bitrate, 2_500_000),
      width: Math.min(base.width, 1280),
      height: Math.min(base.height, 720),
    };
  }
  if (concurrentSharers >= 3) {
    return {
      ...base,
      fps: Math.min(base.fps, 30),
      bitrate: Math.min(base.bitrate, 4_000_000),
      width: Math.min(base.width, 1280),
      height: Math.min(base.height, 720),
    };
  }
  // Two sharers keep the full frame rate (owner review 2026-11-08: a 37-min
  // tier-1 share ran at 30 fps / 6 Mbps only because the watcher was sharing
  // too). Each sharer uploads just their own stream and a viewer watches one
  // at a time, so halving fps bought nothing; a light bitrate trim is enough.
  if (concurrentSharers >= 2) {
    return {
      ...base,
      bitrate: Math.min(base.bitrate, 8_000_000),
    };
  }
  return base;
}

// Probe best HW-accelerated codec available in this browser/driver in priority order.
// H.264 High Profile (avc1.640033) enables CABAC entropy coding, ~20% more efficient
// than Baseline at the same bitrate. Falls back gracefully on older drivers.
async function probeVideoCodec(w, h, fps) {
  const candidates = [
    'avc1.640033',   // H.264 High Profile L5.1 — CABAC, hardware on modern Windows drivers
    'avc1.42E01E',   // H.264 Baseline — fallback for older drivers
    'vp09.00.10.08', // VP9 Profile 0
    'vp8',           // Software fallback
  ];
  for (const codec of candidates) {
    try {
      const result = await VideoEncoder.isConfigSupported({
        codec, width: w, height: h, bitrate: 3_000_000, framerate: fps,
      });
      if (result.supported) return codec;
    } catch {}
  }
  return 'vp8';
}

// ── Source picker components (Tauri capture path) ─────────────────────────────

function SourceThumbnail({ source, selected, onSelect }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source.thumb_b64 || !source.thumb_width) return;
    canvas.width = source.thumb_width;
    canvas.height = source.thumb_height;
    const ctx = canvas.getContext('2d');
    const raw = atob(source.thumb_b64);
    const bgra = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bgra[i] = raw.charCodeAt(i);
    // BGRA → RGBA for ImageData
    const rgba = new Uint8ClampedArray(source.thumb_width * source.thumb_height * 4);
    for (let i = 0; i < bgra.length; i += 4) {
      rgba[i]   = bgra[i + 2];
      rgba[i+1] = bgra[i + 1];
      rgba[i+2] = bgra[i];
      rgba[i+3] = 255;
    }
    ctx.putImageData(new ImageData(rgba, source.thumb_width, source.thumb_height), 0, 0);
  }, [source.thumb_b64, source.thumb_width, source.thumb_height]);

  return (
    <div
      onClick={onSelect}
      style={{
        border: `2px solid ${selected ? '#0e7490' : '#1e3a5f'}`,
        borderRadius: 4,
        cursor: 'pointer',
        background: '#060d1a',
        transition: 'border-color 0.15s',
        // Without this, a grid item's implicit min-width:auto is driven by the
        // label's nowrap text below — a long window title blows this item's
        // 1fr column out past its fair share, distorting the whole grid (and
        // the ellipsis truncation on the label never kicks in).
        minWidth: 0,
      }}
    >
      <div style={{ position: 'relative', paddingBottom: '56.25%', background: '#030810' }}>
        {source.thumb_b64 ? (
          <canvas
            ref={canvasRef}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1e3a5f', fontSize: 10, fontFamily: 'monospace' }}>
            NO PREVIEW
          </div>
        )}
      </div>
      <div style={{ padding: '5px 8px', fontSize: 13, color: selected ? '#22d3ee' : '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'monospace', letterSpacing: '0.03em' }}>
        {source.name}
      </div>
    </div>
  );
}

function SourcePickerModal({ sources, onSelect, onCancel }) {
  const [tab, setTab] = useState('monitor');
  const [selected, setSelected] = useState(null);
  const filtered = sources.filter(s => s.kind === tab);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(2,8,16,0.92)' }}>
      <div className="border border-specter-primary-dim rounded" style={{ background: '#0a1628', width: 860, maxWidth: '95vw', maxHeight: 580, display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid rgba(14,116,144,0.2)' }}>
          <span style={{ fontSize: 10, color: '#0e7490', letterSpacing: '0.3em', fontFamily: 'monospace' }}>SELECT CAPTURE SOURCE</span>
          <button onClick={onCancel} style={{ color: '#64748b', fontSize: 16, lineHeight: 1, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>
        {/* Tabs */}
        <div className="flex" style={{ borderBottom: '1px solid rgba(14,116,144,0.2)' }}>
          {[['monitor', 'MONITORS'], ['window', 'APPLICATIONS']].map(([val, label]) => (
            <button
              key={val}
              onClick={() => { setTab(val); setSelected(null); }}
              style={{
                padding: '8px 20px', fontSize: 9, letterSpacing: '0.25em', fontFamily: 'monospace',
                color: tab === val ? '#0e7490' : '#475569',
                borderBottom: tab === val ? '2px solid #0e7490' : '2px solid transparent',
                background: 'transparent', border: 'none', cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Grid */}
        <div style={{ overflowY: 'auto', padding: 14, display: 'grid', gridTemplateColumns: tab === 'window' ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)', gap: 12, flex: 1 }}>
          {filtered.length === 0 && (
            <div style={{ gridColumn: '1/-1', color: '#475569', fontSize: 10, textAlign: 'center', padding: 24, fontFamily: 'monospace' }}>
              NO SOURCES AVAILABLE
            </div>
          )}
          {filtered.map(source => (
            <SourceThumbnail
              key={source.id}
              source={source}
              selected={selected?.id === source.id}
              onSelect={() => setSelected(source)}
            />
          ))}
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: '1px solid rgba(14,116,144,0.2)' }}>
          <span style={{ fontSize: 9, color: '#475569', fontFamily: 'monospace', letterSpacing: '0.1em' }}>
            {selected ? selected.name.toUpperCase() : 'SELECT A SOURCE TO BEGIN'}
          </span>
          <button
            onClick={() => selected && onSelect(selected)}
            disabled={!selected}
            style={{
              padding: '6px 18px', fontSize: 9, letterSpacing: '0.25em', fontFamily: 'monospace',
              background: selected ? '#0e7490' : '#0d1f2d',
              color: selected ? '#fff' : '#334155',
              border: `1px solid ${selected ? '#0e7490' : '#1e3a5f'}`,
              borderRadius: 3, cursor: selected ? 'pointer' : 'default', transition: 'all 0.15s',
            }}
          >
            START SHARING
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const CommLink = ({ org, channel, onBack, embedded = false, onRosterChange, onSharersChange, onShareAudioChange, watchStreamTarget, onWatchFailed, onStreamCanvas, onMuteChange, levelsRef, uiVisible = false, onSharingChange, externalControlsRef, hideMuteButton, overlayActive = false, stripViewerActive = false /* SV */, channelVolume = 1.0, onRelayRef, onMlsCommitRef, localMutedUserIds, onConnectionQualityChange, onStatusChange, onE2eStateChange, onConnectStateChange /* NET */, userVolumes /* PM */, remoteSharerNets /* op-wide share */ }) => {
  const [status, setStatus] = useState('disconnected'); // disconnected, connecting, connected, error
  const [messages, setMessages] = useState([]);
  const [roster, setRoster] = useState([]);
  const transportRef = useRef(null);
  const videoTransportRef = useRef(null);  // subscribe transport (watching remote)
  const publishTransportRef = useRef(null); // publish transport (sharing own screen)
  const videoSessionRef = useRef(0); // incremented on each subscribe; stale processVideoData instances stop when theirs doesn't match
  const subscribeInFlightRef = useRef(false);
  const lastWatchSwitchMsRef = useRef(0);
  const watchSwitchTimerRef = useRef(null);
  const pendingWatchTargetRef = useRef(null);
  const videoConnectedRef = useRef(false);
  const datagramWriterRef = useRef(null);
  const videoRef = useRef(null);
  const endRef = useRef(null);
  const [isSharing, setIsSharing] = useState(false);
  const [remoteShare, setRemoteShare] = useState(null);
  const [shareViewerCount, setShareViewerCount] = useState(0);
  const [availableSharers, setAvailableSharers] = useState([]); // callsigns of all active sharers
  const [watchingSharer, setWatchingSharer] = useState(null);   // callsign we're currently watching
  const [isWatching, setIsWatching] = useState(false);
  const shareStreamRef = useRef(null);
  const shareTrackRef = useRef(null); // display track kept alive while sharing
  const remoteCanvasRef = useRef(null);
  const videoEncoderRef = useRef(null);
  const processorReaderRef = useRef(null);
  const autoConnectedRef = useRef(false);
  // Auto-reconnect state (see scheduleReconnect). Without it, a transient
  // network blip leaves the user silently stuck out of voice/video until
  // they notice and manually rejoin: monitorClosure on its own only sets
  // status to 'error'/'disconnected' and tears down state, with no retry.
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  // Set true immediately before any deliberate teardown (unmount, server Move)
  // so monitorClosure/connect's failure paths know not to schedule a retry.
  const intentionalDisconnectRef = useRef(false);
  // ── Connection quality tracking ────────────────────────────────────────
  // Rolling count of unexpected drops in the last 60s, exposed to the parent
  // (WarRoom) via onConnectionQualityChange for an at-a-glance signal
  // indicator — added after a support case where diagnosing a user's
  // flaky-network pattern required manually correlating server logs; this
  // makes the same signal visible in real time without that. Also feeds
  // getEffectiveStreamProfile (see below) so a share started/restarted
  // shortly after instability eases in at a lower bitrate instead of
  // immediately re-taxing a connection that just proved shaky.
  const connectionDropTimestampsRef = useRef([]);
  const [connectionQuality, setConnectionQuality] = useState('excellent'); // 'excellent' | 'good' | 'fair' | 'poor'
  // Points at the currently-active share's congestion-drop counter (see
  // startScreenShare's onVideoFrameDropped) so a connection-level drop can
  // nudge an already-running share's existing step-down logic immediately,
  // not just the bitrate picked the next time a share starts. Null when not
  // sharing.
  const activeShareCongestionSignalRef = useRef(null);
  // Mutable ref so connect() always uses the current voice channel, even after a
  // server-initiated Move.  Text-chat APIs continue to use the `channel` prop.
  //
  // This is deliberately never re-synced from the prop: WarRoom keys CommLink on
  // the channel id (see its `key={commChannel?.id}`), so an ordinary channel
  // switch remounts and re-seeds this ref. The one case where ref and prop
  // genuinely disagree is a server-initiated Move, which rewrites this ref
  // without WarRoom's voiceChannel (and therefore the prop) ever changing.
  //
  // Every media path must therefore use channelRef, not the prop: the MLS group
  // id is the channel id, so a path that derives a key, requests a ticket, or
  // opens a transport under the prop's id while cryptoRef holds a key derived
  // under the ref's id is operating on two different MLS groups. That used to
  // make subscribe-after-Move unrecoverable — the subscribe derived from the
  // prop, every refreshVideoKey (including the sustained-decrypt-failure auto
  // refresh) derived from the ref, so the key ping-ponged and never converged.
  const channelRef = useRef(channel);
  // Callback fired with each decoded VideoFrame (before frame.close()), used by overlay canvas
  const videoFrameCallbackRef = useRef(null);
  // Latest decoded VideoFrame buffered for the RAF render loop. Owned by the loop until drawn.
  const latestRemoteFrameRef = useRef(null);
  // Draw-loop scheduling: true while an rAF callback is pending. The decoder's output
  // callback "kicks" the loop awake by requesting a frame only when one isn't already
  // scheduled — this keeps the loop idle (0 rAF calls/sec) whenever nobody is sharing,
  // instead of spinning at the display's full refresh rate for the entire session.
  const rafScheduledRef = useRef(false);
  const drawLoopRef = useRef(null);
  // Lightweight client-side stage timings for stream diagnostics.
  const decodePendingRef = useRef(new Map()); // timestamp_us -> enqueue time
  const videoStageStatsRef = useRef({
    recvCount: 0,
    recvMs: 0,
    decodeCount: 0,
    decodeMs: 0,
    drawCount: 0,
    drawMs: 0,
    lastLogTs: performance.now(),
  });
  // Refs for share-announce re-broadcast
  const isSharingRef = useRef(false);
  // Pin all video operations to the same SFU instance used for voice.
  // Without this, each getOrgToken call may return a different media_url when
  // both media-blue and media-green are running (heartbeat races).
  const mediaUrlRef = useRef(null);
  // NET: consecutive transport timeouts per port, which port the last attempt
  // used, and what the strip is told (connectIssue, via, port). Everything
  // that opens a media session reads mediaUrlRef, so picking the alternate
  // port here moves voice AND video publish/subscribe to it.
  // Bumped by every connect() and disconnect(): a connect whose transport
  // race finishes after it was superseded closes what it got and stops.
  const connectGenRef = useRef(0);
  const netConnectRef = useRef({ timeouts: { main: 0, alt: 0 }, via: 'main', altUrl: null, apiOk: false, lastKind: null, attempts: 0 });
  const [voiceConnect, setVoiceConnect] = useState({ connectIssue: null, via: null, port: null });

  // Direct overlay emission — used when overlayActive=true to bypass the
  // WarRoom videoFrameCallback chain, which has timing-dependent setup.
  const overlayActiveRef = useRef(overlayActive);
  useEffect(() => {
    overlayActiveRef.current = overlayActive;
    // If the overlay just became active while a remote stream is already running,
    // pre-configure the decoder with the stream header so it's ready for the next
    // live keyframe. We intentionally do NOT replay the GOP here: the live delta
    // frames that are already queued in the IPC pipeline would arrive at the overlay
    // BEFORE this seed (JS microtask ordering), causing immediate P-frame decode
    // errors that permanently close the decoder. Instead, the atomic header+keyframe
    // relay below ensures the decoder syncs cleanly on the next live keyframe
    // (≤2s wait = one GOP interval).
    if (overlayActive && remoteStreamHeaderRef?.current && window.__TAURI__) {
      const hdr = remoteStreamHeaderRef.current;
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('overlay-video-header', hdr);
      }).catch(() => {});
    }
  }, [overlayActive]);
  // Tracks watchStreamTarget in a ref so the capture-nal listener (closed over on start)
  // can see the current value without stale closures.
  const watchStreamTargetRef = useRef(watchStreamTarget);
  useEffect(() => { watchStreamTargetRef.current = watchStreamTarget; }, [watchStreamTarget]);
  // Header info for the current Tauri capture session — used to seed the overlay
  // VideoDecoder when self-view is selected after capture is already running.
  const captureHeaderRef = useRef(null);
  // Set to true when the overlay's VideoDecoder has been configured for self-view
  // (i.e. we emitted overlay-video-header for our own capture). Used to gate the
  // NAL relay without relying on a fragile callsign string comparison.
  const overlayWantsSelfViewRef = useRef(false);
  // Stores the most-recently-seen remote stream header so we can re-seed the overlay's
  // VideoDecoder when (a) the overlay opens mid-stream or (b) overlay-ready fires after
  // processVideoData has already sent the header.
  const remoteStreamHeaderRef = useRef(null);
  // Rolling GOP buffer: every frame since the last keyframe (up to 150 frames).
  // Replaying the full GOP (not just the keyframe) is required because H.264 P-frames
  // reference each other in a chain: P50→P49→…→P1→I. Sending only I and then jumping
  // straight to the live P50 causes a decode error that permanently closes the decoder.
  const gopBufferRef = useRef([]); // [ { data: Uint8Array, tsMs: number, type: string } ]

  // ── SV: the strip's stream viewer ───────────────────────────────────────
  // Same Y-branch as the overlay (see processVideoData): while the strip's
  // viewer owns the watch, this window doesn't decode — it relays the frames
  // it has already decrypted to the strip (engine-stream-frame, local IPC
  // only; the key never leaves this window). The strip wins over the overlay
  // when both are up, so there's only ever one decoder per stream.
  const stripViewerActiveRef = useRef(stripViewerActive);
  const svEmitRef = useRef(null);
  if (!svEmitRef.current) svEmitRef.current = createOrderedEmitter(STRIP_WINDOW);
  // The last problem status, re-sent when the strip takes over mid-stream.
  const svStatusRef = useRef(null);
  const svStatus = (status, message = null) => {
    svStatusRef.current = status === STREAM_STATUS.OK ? null : { status, message };
    if (stripViewerActiveRef.current) {
      svEmitRef.current(BRIDGE_EV.STREAM_STATUS, { callsign: watchStreamTargetRef.current || null, status, message });
    }
  };
  const svFrame = (session, type, tsMs, data, config) => {
    svEmitRef.current(BRIDGE_EV.STREAM_FRAME, {
      session: String(session), key: type === 'key', ts: tsMs * 1000,
      data: typeof data === 'string' ? data : bytesToBase64(data),
      ...(type === 'key' && config ? { config } : null),
    });
  };
  useEffect(() => {
    stripViewerActiveRef.current = stripViewerActive;
    if (!stripViewerActive) return;
    if (svStatusRef.current) {
      svEmitRef.current(BRIDGE_EV.STREAM_STATUS, { callsign: watchStreamTarget || null, ...svStatusRef.current });
    }
    // Taking over a stream that is already running (from the overlay, or
    // the hidden engine): replay its current GOP. Synchronous, and the live
    // relay uses the same ordered emitter, so the replay can't interleave
    // with live frames.
    const gop = gopBufferRef.current;
    const hdr = remoteStreamHeaderRef.current;
    if (watchStreamTarget && watchStreamTarget === watchingSharerRef.current && !overlayWantsSelfViewRef.current
        && !subscribeInFlightRef.current && hdr && gop.length && gop[0].type === 'key' && gop.length <= SV_GOP_REPLAY_MAX) {
      for (const f of gop) svFrame(videoSessionRef.current, f.type, f.tsMs, f.data, hdr);
    }
  // Only on the strip viewer turning on; the target is read as of then.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripViewerActive]);
  // When the overlay window signals it has registered all its listeners, re-send the
  // current remote-stream header (if one is active) so the overlay's decoder configures
  // without missing the initial overlay-video-header event.
  useEffect(() => {
    if (!window.__TAURI__) return;
    let unlisten;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('overlay-ready', () => {
        // Remote stream: send only the header to pre-configure the overlay decoder.
        // We intentionally do NOT replay the GOP — the live relay's .then() microtasks
        // are already queued and would arrive at the overlay BEFORE this seed block,
        // injecting orphaned P-frames before the I-frame arrives, which causes an
        // immediate decode error and permanently closes the decoder in an infinite loop.
        // The live relay sends header+keyframe atomically on every live keyframe,
        // so the overlay decoder syncs cleanly within ≤2s (one GOP interval) with no
        // race conditions.
        // NOTE: overlay-ready already guarantees the overlay is open — skip the
        // overlayActiveRef.current guard so we don't lose the race if React hasn't
        // propagated setIsOverlay(true) yet when this callback fires.
        const hdr = remoteStreamHeaderRef.current;
        if (hdr && window.__TAURI__) {
          import('@tauri-apps/api/event').then(({ emit }) => {
            emit('overlay-video-header', hdr);
          }).catch(() => {});
        }
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // ── Keyframe-on-request (see engine/keyframeRequest.js) ──────────────────
  // Viewer side: whoever decodes the watched stream — this window's own
  // decoder (processVideoData), the overlay, or the strip — asks for a
  // keyframe when it has to drop deltas, and this window sends the request
  // datagram on the subscribe transport. Throttled here so a decoder that
  // keeps waiting re-asks every VIEWER_REQUEST_INTERVAL_MS at most (datagrams
  // can be lost), never per frame; media-rust coalesces across viewers.
  const videoDatagramWriterRef = useRef(null); // { transport, writer }
  const requestRemoteKeyframeRef = useRef(null);
  if (!requestRemoteKeyframeRef.current) {
    requestRemoteKeyframeRef.current = createThrottledTrigger((reason) => {
      const vt = videoTransportRef.current;
      if (!vt) return;
      let entry = videoDatagramWriterRef.current;
      if (!entry || entry.transport !== vt) {
        try { entry = { transport: vt, writer: vt.datagrams.writable.getWriter() }; } catch { return; }
        videoDatagramWriterRef.current = entry;
      }
      entry.writer.write(keyframeRequestDatagram()).catch(() => {});
      console.debug('[video] keyframe requested:', reason);
    }, VIEWER_REQUEST_INTERVAL_MS);
  }
  const requestRemoteKeyframe = (reason) => requestRemoteKeyframeRef.current(reason);
  // Publisher side: forces the next encoded frame of MY share to be a
  // keyframe. Set while sharing (native capture or the browser VideoEncoder
  // fallback), null otherwise. Takes (reason) and is already throttled.
  const forceShareKeyframeRef = useRef(null);
  // A viewer window (overlay or strip) lost sync. Self-view decodes my own
  // capture, so the keyframe has to come from my encoder; anything else is a
  // remote stream.
  const onViewerNeedsKeyframe = (reason) => {
    if (overlayWantsSelfViewRef.current) forceShareKeyframeRef.current?.(`self-view: ${reason}`);
    else requestRemoteKeyframe(reason);
  };
  const onViewerNeedsKeyframeRef = useRef(onViewerNeedsKeyframe);
  onViewerNeedsKeyframeRef.current = onViewerNeedsKeyframe;
  useEffect(() => {
    if (!window.__TAURI__) return undefined;
    const stopStrip = bridgeListen(BRIDGE_EV.STREAM_KEYFRAME_REQUEST, () => onViewerNeedsKeyframeRef.current('strip'));
    let unlistenOverlay;
    let stopped = false;
    import('@tauri-apps/api/event').then(({ listen }) => listen(OVERLAY_KEYFRAME_REQUEST_EVENT, () => {
      onViewerNeedsKeyframeRef.current('overlay');
    })).then((fn) => { if (stopped) fn(); else unlistenOverlay = fn; }).catch(() => {});
    return () => { stopped = true; stopStrip(); unlistenOverlay?.(); };
  }, []);
  // ── S2/S3: screen-share audio (engine/shareAudio.js) ────────────────────
  // Sender: the native loopback capture emits Opus packets
  // (SHARE_AUDIO_FRAME_EVENT); startScreenShare installs shareAudioCtxRef with
  // a send() (createShareAudioSender) that encrypts each one with the stream's
  // video key and sends it as a datagram on the publish session, or, on a
  // server without datagram support, into the share stream through the send
  // pump (audio before video).
  // Viewer: share-audio datagrams on the subscribe session (subscribeToRemoteStream)
  // and in-stream audio frames (processVideoData) of the watched stream both
  // go to shareAudioPlayerRef → native playback. Everything fails soft on a native
  // build without the share_audio_* commands (shareAudioSupported false: no
  // toggle, no audio subscription, no playback).
  const shareAudioNativeRef = useRef(null);
  if (!shareAudioNativeRef.current) {
    shareAudioNativeRef.current = createShareAudioNative((cmd, args) => import('@tauri-apps/api/core').then(({ invoke }) => invoke(cmd, args)));
  }
  const [shareAudioSupported, setShareAudioSupported] = useState(false);
  const shareAudioSupportedRef = useRef(false);
  useEffect(() => {
    if (!window.__TAURI__) return undefined;
    let alive = true;
    shareAudioNativeRef.current.probe().then((ok) => {
      if (!alive) return;
      shareAudioSupportedRef.current = ok;
      setShareAudioSupported(ok);
    });
    return () => { alive = false; };
  }, []);
  const [shareAudioEnabled, setShareAudioEnabledState] = useState(() => loadShareAudioEnabled());
  const shareAudioEnabledRef = useRef(shareAudioEnabled);
  // My share's audio: { active, mode, echoRisk, error }.
  const [shareAudioStatus, setShareAudioStatus] = useState({ active: false, mode: null, echoRisk: false, error: null });
  const shareAudioActiveRef = useRef(false);
  // Set by the publish session's SHARE_AUDIO_CAPABLE signal: only then may
  // audio frames go out (an older server would hand them to 2.0.x viewers).
  const shareAudioServerOkRef = useRef(false);
  // Set by SHARE_AUDIO_DGRAM_CAPABLE: the server takes (and converts) share
  // audio datagrams on the publish session, so datagrams are preferred.
  const shareAudioServerDgramOkRef = useRef(false);
  // The watched stream's declared encryption, per subscribe session — the
  // datagram path has no header of its own to read it from.
  const shareAudioStreamEncRef = useRef({ session: null, encrypted: false });
  const shareAudioCtxRef = useRef(null);     // { sourceId, send(payload) } while sharing natively
  const shareAudioUnlistenRef = useRef(null);
  const shareAudioOpRef = useRef(0);         // start/stop generation — a stale start backs out
  // Sharers whose share carries audio (SHARE_AUDIO_STATE control datagrams,
  // plus whoever we actually receive audio from) — the tile indicator.
  const [sharersWithAudio, setSharersWithAudio] = useState([]);
  const sharersWithAudioRef = useRef([]);
  useEffect(() => { sharersWithAudioRef.current = sharersWithAudio; }, [sharersWithAudio]);
  const setSharerHasAudio = (callsign, on) => {
    if (!callsign || sharersWithAudioRef.current.includes(callsign) === on) return;
    const next = on ? [...sharersWithAudioRef.current, callsign] : sharersWithAudioRef.current.filter((c) => c !== callsign);
    sharersWithAudioRef.current = next;
    setSharersWithAudio(next);
  };
  // Per-sharer volume/mute (persisted). Bumped to re-report prefs upward.
  const [shareAudioPrefsSeq, setShareAudioPrefsSeq] = useState(0);
  const shareAudioPlayerRef = useRef(null);
  if (!shareAudioPlayerRef.current) shareAudioPlayerRef.current = createShareAudioPlayer(shareAudioNativeRef.current);
  const stopShareAudioPlayback = () => shareAudioPlayerRef.current.stop();

  const startShareAudio = async () => {
    const ctx = shareAudioCtxRef.current;
    if (!ctx || shareAudioUnlistenRef.current || !window.__TAURI__) return;
    const op = ++shareAudioOpRef.current;
    const native = shareAudioNativeRef.current;
    if (!(await native.probe())) return;
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen(SHARE_AUDIO_FRAME_EVENT, (event) => shareAudioCtxRef.current?.send(event.payload));
    if (op !== shareAudioOpRef.current || shareAudioCtxRef.current !== ctx) { unlisten(); return; }
    shareAudioUnlistenRef.current = unlisten;
    try {
      const r = await native.start(ctx.sourceId);
      if (op !== shareAudioOpRef.current || shareAudioCtxRef.current !== ctx) { native.stop(); return; }
      shareAudioActiveRef.current = true;
      setShareAudioStatus({ active: true, mode: r?.mode ?? null, echoRisk: Boolean(r?.echoRisk), error: null });
      sendControlDatagram(SHARE_AUDIO_STATE_CONTROL, [1]);
      traceLog(`[share-audio] capture started mode=${r?.mode} echoRisk=${Boolean(r?.echoRisk)}`);
    } catch (err) {
      if (shareAudioUnlistenRef.current === unlisten) { unlisten(); shareAudioUnlistenRef.current = null; }
      const message = String(err?.message || err || 'Share audio could not start');
      console.warn('[share-audio] share_audio_start failed:', err);
      setShareAudioStatus({ active: false, mode: null, echoRisk: false, error: message });
    }
  };
  const stopShareAudio = () => {
    shareAudioOpRef.current++;
    if (shareAudioUnlistenRef.current) { shareAudioUnlistenRef.current(); shareAudioUnlistenRef.current = null; }
    if (shareAudioActiveRef.current) {
      shareAudioActiveRef.current = false;
      shareAudioNativeRef.current.stop();
      sendControlDatagram(SHARE_AUDIO_STATE_CONTROL, [0]);
    }
    setShareAudioStatus({ active: false, mode: null, echoRisk: false, error: null });
  };
  // The "Share audio" toggle: persisted, and applied to a running share.
  const setShareAudioEnabled = (enabled) => {
    const on = Boolean(enabled);
    shareAudioEnabledRef.current = on;
    setShareAudioEnabledState(on);
    saveShareAudioEnabled(on);
    if (on) startShareAudio(); else stopShareAudio();
  };
  const setSharerAudio = (callsign, pref) => {
    if (!callsign) return;
    const next = saveSharerAudioPref(callsign, pref || {});
    shareAudioPlayerRef.current.applyPref(callsign, next);
    setShareAudioPrefsSeq((n) => n + 1);
  };
  // One audio frame read off the subscribe stream or its datagrams (still encrypted). Played
  // only while this is the stream being watched; share audio is E2E only, so
  // a stream that doesn't declare encryption never plays any.
  const handleShareAudioFrame = (callsign, session, streamEncrypted, tsMs, data) => {
    if (!streamEncrypted || !cryptoRef.current || !callsign) return;
    if (videoSessionRef.current !== session || overlayWantsSelfViewRef.current) return;
    let inner = null;
    try { inner = decodeShareAudioInner(withGraceKeys(cryptoRef, (k) => k.decrypt(data)).value); } catch { return; }
    if (!inner) return; // not an audio payload (tampered flags) — never played
    setSharerHasAudio(callsign, true);
    if (!shareAudioSupportedRef.current || watchStreamTargetRef.current !== callsign) return;
    shareAudioPlayerRef.current.frame(callsign, { tsMs, seq: inner.seq, opus: inner.opus });
  };
  // The overlay's volume/mute controls (it has no engine bridge).
  const setSharerAudioRef = useRef(setSharerAudio);
  setSharerAudioRef.current = setSharerAudio;
  useEffect(() => {
    if (!window.__TAURI__) return undefined;
    let unlisten;
    let stopped = false;
    import('@tauri-apps/api/event').then(({ listen }) => listen(OVERLAY_SHARE_AUDIO_VOLUME_EVENT, (event) => {
      const { callsign, volume, muted } = event.payload || {};
      const pref = {};
      if (volume !== undefined) pref.volume = volume;
      if (muted !== undefined) pref.muted = muted;
      setSharerAudioRef.current(callsign, pref);
    })).then((fn) => { if (stopped) fn(); else unlisten = fn; }).catch(() => {});
    return () => { stopped = true; unlisten?.(); };
  }, []);
  // Report upward (WarRoom → bridge state.voice.shareAudio + overlay-update).
  useEffect(() => {
    const prefs = {};
    for (const cs of sharersWithAudio) prefs[cs] = loadSharerAudioPref(cs);
    onShareAudioChange?.({
      supported: shareAudioSupported,
      enabled: shareAudioEnabled,
      active: shareAudioStatus.active,
      mode: shareAudioStatus.mode,
      echoRisk: shareAudioStatus.echoRisk,
      error: shareAudioStatus.error,
      sharers: sharersWithAudio,
      prefs,
    });
  }, [shareAudioSupported, shareAudioEnabled, shareAudioStatus, sharersWithAudio, shareAudioPrefsSeq]);
  // Leaving the channel (unmount): no orphaned capture or playback.
  useEffect(() => () => {
    shareAudioOpRef.current++;
    shareAudioUnlistenRef.current?.();
    shareAudioUnlistenRef.current = null;
    if (shareAudioActiveRef.current) shareAudioNativeRef.current.stop();
    shareAudioActiveRef.current = false;
    shareAudioPlayerRef.current.stop();
  }, []);

  const overlayThumbCanvasRef = useRef(null);
  const overlayThrottleRef = useRef(0);

  // RAF render loop — decouples VideoDecoder output from display refresh to eliminate
  // burst redraws when WebTransport delivers multiple frames in one microtask cycle.
  // Does NOT self-reschedule: it only runs when the decoder's output callback "kicks"
  // it awake (see scheduleDraw below), so a pure-voice session with no active share
  // costs 0 rAF calls/sec instead of spinning at the display's full refresh rate for
  // the entire session.
  useEffect(() => {
    const drawLoop = () => {
      rafScheduledRef.current = false;
      const frame = latestRemoteFrameRef.current;
      if (frame) {
        latestRemoteFrameRef.current = null;
        const canvas = remoteCanvasRef.current;
        if (canvas) {
          const drawStart = performance.now();
          const cw = canvas.clientWidth || frame.displayWidth;
          const ch = canvas.clientHeight || frame.displayHeight;
          if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
          }
          const scale = Math.min(cw / frame.displayWidth, ch / frame.displayHeight);
          const dw = Math.round(frame.displayWidth * scale);
          const dh = Math.round(frame.displayHeight * scale);
          const dx = Math.round((cw - dw) / 2);
          const dy = Math.round((ch - dh) / 2);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(frame, dx, dy, dw, dh);
          const drawMs = performance.now() - drawStart;
          const stats = videoStageStatsRef.current;
          stats.drawCount += 1;
          stats.drawMs += drawMs;
        }
        frame.close();
      }
    };
    drawLoopRef.current = drawLoop;
    return () => {
      drawLoopRef.current = null;
      if (latestRemoteFrameRef.current) { latestRemoteFrameRef.current.close(); latestRemoteFrameRef.current = null; }
    };
  }, []);

  // Instance of our Rust WASM Cryptography bindings.
  // MR4: cryptoRef, cryptoAudioRef and cryptoAudioCascadeRef are key grace
  // slots (createKeyGraceSlot), not plain refs: `.current` is read-only (the
  // key to send/receive with) and `.previous` is the key it replaced, kept
  // for KEY_GRACE_MS after a rekey so receive can still open frames from
  // members that haven't switched yet. Install with installVideoKey /
  // installRelayAudioPair, drop with .clear(). Lazily created once per mount.
  const [cryptoRef] = useState(createKeyGraceSlot);
  // Relay-mode voice crypto (wire v2, see wasm-crypto/src/relay_audio.rs).
  // cryptoAudioRef is the RelayAudioReceiver for the 'audio'-labeled MLS
  // export; relayAudioTxRef is this device's RelayAudioSender for the same
  // export — a fresh random 128-bit session (own derived key + own 64-bit
  // counter) per instance, so reconnects / restarts / other devices of the
  // same user can never reuse a (key, nonce) pair. Both are only replaced
  // when the exported secret actually changes (installRelayAudioKey), so a
  // same-epoch refresh keeps the receiver's replay windows.
  const [cryptoAudioRef] = useState(createKeyGraceSlot);
  const relayAudioTxRef = useRef(null);
  // Event-scoped cascade key (see mlsSession.js's ensureEventGroup) — only
  // derived when this channel belongs to an event (channel.event_id set).
  // Used for the priority-speaker cross-channel cascade path (Track B), not
  // this channel's own audio. Receiver + sender, as above, on the cascade lane.
  const [cryptoAudioCascadeRef] = useState(createKeyGraceSlot);
  const relayAudioCascadeTxRef = useRef(null);
  const installRelayAudioKey = (secret, isCascade) => installRelayAudioPair(
    isCascade ? cryptoAudioCascadeRef : cryptoAudioRef,
    isCascade ? relayAudioCascadeTxRef : relayAudioTxRef,
    secret, isCascade,
    isCascade ? channelRef.current?.event_id : channelRef.current?.id);
  // MR4: install the channel 'video' export. A same-key re-export (every
  // Join/Leave refresh) keeps the current instance — otherwise the duplicate
  // would push the genuinely previous key out of the grace slot. A new key
  // takes over sending at once; the old one stays receive-only for the grace
  // window — unless the rekey removed a member of the channel group, then the
  // old key is freed at once (consumeGroupMemberRemoval).
  const installVideoKey = (secret, groupId = channelRef.current?.id) => {
      const next = new SFrameCrypto(secret);
      const removal = consumeGroupMemberRemoval(cryptoRef, groupId);
      videoKeyGroupRef.current = groupId;
      if (sameSFrameKey(cryptoRef.current, next)) {
          try { next.free(); } catch { /* best-effort */ }
          if (removal) cryptoRef.expire();
          return;
      }
      cryptoRef.install(next, { grace: !removal });
  };
  // Op-wide share: during a LAUNCHED op (the server's ticket says
  // video_key_scope 'op') every share in the op's group channels is encrypted
  // with one key exported from the event MLS group (label OP_VIDEO_KEY_LABEL),
  // so frequency partners in other groups can watch it. opVideoEventRef = that
  // event id (null = the channel's own 'video' key, as before);
  // videoKeyGroupRef = the group whose key cryptoRef holds now.
  const opVideoEventRef = useRef(null);
  const videoKeyGroupRef = useRef(null);
  const remoteSharerNetsRef = useRef({});
  remoteSharerNetsRef.current = remoteSharerNets || {};
  // mode: 'export' (re-export only), 'sync' (catch up the epoch first),
  // 'ensure' (join / catch up membership first). Returns { key, groupId }.
  const exportVideoKey = async (currentUserId, mode = 'export') => {
      const eventId = opVideoEventRef.current;
      const groupId = eventId || channelRef.current.id;
      if (eventId) {
          if (mode === 'ensure') await ensureEventGroup(api, currentUserId, org.id, eventId);
          else if (mode === 'sync') await syncEventGroupEpoch(api, currentUserId, org.id, eventId);
          return { key: await exportGroupSecret(api, currentUserId, eventId, OP_VIDEO_KEY_LABEL, 32), groupId };
      }
      if (mode === 'ensure') await ensureChannelGroup(api, currentUserId, org.id, groupId);
      else if (mode === 'sync') await syncChannelGroupEpoch(api, currentUserId, org.id, groupId);
      return { key: await exportGroupSecret(api, currentUserId, groupId, 'video', 32), groupId };
  };
  // Is the right video key in hand for this room's scope? (Op scope: never
  // publish or decrypt with anything but the op key.)
  const videoKeyReadyForScope = () => !!cryptoRef.current
      && videoKeyGroupRef.current === (opVideoEventRef.current || channelRef.current?.id);
  // Apply a ticket response's scope for MY group channel. A change swaps the
  // installed key (no grace for the old scope's key) and awaits the new one.
  const applyVideoKeyScope = async (data) => {
      const next = data?.video_key_scope === 'op' && data?.event_id ? String(data.event_id) : null;
      if (next === opVideoEventRef.current && videoKeyReadyForScope()) return;
      const changed = next !== opVideoEventRef.current;
      opVideoEventRef.current = next;
      if (changed) { cryptoRef.clear(); videoKeyGroupRef.current = null; }
      try {
          const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
          const { key, groupId } = await exportVideoKey(currentUserId, 'ensure');
          if (opVideoEventRef.current === next) installVideoKey(key, groupId);
          traceLog(`[video-key] scope=${next ? `op:${next}` : 'channel'} key installed`);
      } catch (err) {
          traceLog(`[video-key] scope=${next ? `op:${next}` : 'channel'} key unavailable: ${err?.message || err}`);
      }
  };
  // ssrc (number) -> user_id, from the server's RosterMessage::SsrcMap — the
  // authoritative mapping for attributing an incoming relay-mode audio lane to
  // a real speaker (a client can't independently recompute another user's
  // hashUserId, since it only knows their callsign, not their true user_id).
  // Used by relay-mode attribution/reporting and sender-key lookup paths.
  const ssrcToUserIdRef = useRef(new Map());
  // Whether the CURRENT channel's media-rust room is running the E2E relay
  // path (per-sender SFrame-encrypted, see media-rust's RoomState::voice_relay_mode)
  // vs. today's server-mixed TLS-only voice. Set from the org-token response
  // (data.voice_relay) at the top of connect(), before any audio is sent —
  // encrypting into a still-mixed-mode room would break voice for everyone in
  // it, so every encrypt-on-send/decrypt-on-receive call below is gated on this.
  // E2EV (2.0.0): relay is the ONLY voice mode — this is always true and is
  // never cleared. connect() refuses a ticket that isn't relay, the send path
  // has no plaintext branch at all, and the receive path never plays an
  // unauthenticated frame. Kept as a ref only so the remaining legacy
  // mixed-mode branches below read as dead code rather than being deleted in
  // the same change (follow-up: remove them).
  const voiceRelayModeRef = useRef(true);
  // E2EV: which channel the installed 'audio' pair was derived for — a
  // MOVE/reconnect to another channel must never keep sealing with the old
  // channel's key.
  const audioKeyChannelRef = useRef(null);
  // E2EV: key/UI state surfaced to the strip (via onE2eStateChange):
  // 'waiting' until this device can seal for the channel, then 'ready'.
  const [voiceKeyReady, setVoiceKeyReady] = useState(false);
  // E2EV: the server's version-gate refusal text, if any.
  const [voiceGateError, setVoiceGateError] = useState(null);
  const [voiceKeyProblem, setVoiceKeyProblem] = useState(null);
  const voiceKeyRetryRef = useRef({ timer: null, attempt: 0 });
  const decryptFailStreakRef = useRef({ channel: 0, cascade: 0, lastRecoveryAt: 0, attempt: 0 });
  // Relay-mode ducking state, driven by the server's RosterMessage::Duck /
  // DuckRelease (see main.rs's relay-mode ducking block) — replaces the old
  // "server scales PCM gain" approach, which is impossible once the server
  // never decodes audio. Every lane except the active speaker's own gets
  // attenuated; see applyDuckState below for where this is actually consumed
  // by both playback paths.
  const duckStateRef = useRef({ active: false, activeSsrc: null, level: 0 });
  // duckGainForLevel (tier 1 near-silence, tier 2 the legacy 0.1) is imported
  // from ../voiceRelayAudio — shared with useMonitorChannel.
  // user_id -> Uint8Array[] (one per registered device) — lazily fetched and
  // cached the first time a frame from that sender needs verifying. A user
  // can have multiple devices/keys; verification tries each until one
  // matches, since an incoming frame only identifies its sender by ssrc/user,
  // not which specific device captured the mic.
  const senderPublicKeysRef = useRef(new Map());
  const getSenderPublicKeys = async (userId) => {
    if (senderPublicKeysRef.current.has(userId)) return senderPublicKeysRef.current.get(userId);
    let keys = [];
    try {
      const { data } = await api.getUserDeviceKeyPackages(userId);
      keys = (data?.devices ?? [])
        .filter(d => d.public_key)
        .map(d => Uint8Array.from(atob(d.public_key), c => c.charCodeAt(0)));
    } catch (e) {
      console.warn('[Audio] failed to fetch sender public keys for', userId, e);
    }
    senderPublicKeysRef.current.set(userId, keys);
    return keys;
  };
  // Every composite `${channelId}:${ssrc}` native stream_id play_frame has been
  // called with this session, so channel-leave can clear_stream all of them —
  // clear_stream historically only knew about the bare channel id, which now
  // matches nothing and would leak a decoder+queue per distinct sender heard
  // this session. Per-sender-leave/idle cleanup (freeing a lane as soon as
  // that speaker leaves rather than waiting for the whole channel to be left)
  // is not yet implemented — every lane lives for the channel session's
  // duration.
  const activeNativeLaneIdsRef = useRef(new Set());
  // PM: per-user voice volume → per-lane native gain (engine/userVolume.js).
  // Synced on every played frame against ssrcToUserIdRef, so a new lane id
  // (rejoin, reconnect, move, ssrc reassignment) picks the volume up at once.
  const laneGainsRef = useRef(null);
  if (!laneGainsRef.current) {
    laneGainsRef.current = createLaneGainSync({
      invoke: (cmd, args) => import('@tauri-apps/api/core').then(({ invoke }) => invoke(cmd, args)),
      volumes: userVolumes || {},
    });
  }
  useEffect(() => { laneGainsRef.current.setVolumes(userVolumes || {}); }, [userVolumes]);

  // ── Join sound: cache<callsign → url|null> so we don't re-fetch on every join ──
  const introSoundCacheRef = useRef(new Map());

  // Play a short synthesised "ping" tone (no audio file required)
  const playDefaultJoinSound = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
      osc.onended = () => ctx.close();
    } catch {}
  };

  // Play a custom intro-sound URL fetched from the server
  const playIntroSoundUrl = (url) => {
    if (!url) return;
    try {
      const audio = new Audio(url);
      audio.volume = 0.7;
      audio.play().catch(() => {});
    } catch {}
  };

  // Resolve a joining callsign → play their intro sound (custom or default)
  const playJoinSoundForCallsign = (callsign) => {
    const cache = introSoundCacheRef.current;
    if (cache.has(callsign)) {
      const url = cache.get(callsign);
      if (url) playIntroSoundUrl(url);
      else playDefaultJoinSound();
      return;
    }
    // Not cached yet: play default immediately, then fetch and play custom if available
    playDefaultJoinSound();
    api.getIntroSoundByCallsign(callsign).then(({ data }) => {
      const url = data?.intro_sound_url ?? null;
      cache.set(callsign, url);
      if (url) playIntroSoundUrl(url);
    }).catch(() => {
      cache.set(callsign, null);
    });
  };

  // Pre-fetch intro sounds for all roster members (called on Snapshot)
  const prefetchIntroSounds = (callsigns) => {
    const cache = introSoundCacheRef.current;
    for (const cs of callsigns) {
      if (cache.has(cs)) continue;
      api.getIntroSoundByCallsign(cs).then(({ data }) => {
        cache.set(cs, data?.intro_sound_url ?? null);
      }).catch(() => {
        cache.set(cs, null);
      });
    }
  };


  const addMsg = (text, type = 'system') => {
    setMessages(prev => [...prev, { text, type, ts: new Date().toLocaleTimeString() }]);
  };

  // Cache Tauri invoke import for high-frequency audio paths.
  const tauriInvokeRef = useRef(null);
  const ensureTauriInvoke = async () => {
    if (tauriInvokeRef.current) return tauriInvokeRef.current;
    const { invoke } = await import('@tauri-apps/api/core');
    tauriInvokeRef.current = invoke;
    return invoke;
  };

  const getMediaTicket = async (kind, sharer = null, channelId = channelRef.current?.id) => {
    // E2EV: voice tickets need our version (server minimum-version gate).
    const clientVersion = kind === 'voice' ? await getClientVersion() : null;
    const { data, error } = await api.getOrgMediaTicket(org.id, channelId, kind, sharer, clientVersion);
    if (error || !data?.ticket) {
      throw new Error(error || 'Failed to acquire media ticket');
    }
    // Op-wide share: my group channel's tickets say which video key it uses.
    // Voice never waits on it (the event group may be slow to join).
    if (channelId === channelRef.current?.id) {
      const applied = applyVideoKeyScope(data);
      if (kind !== 'voice') await applied;
    }
    // In an op: never share in the clear or under the channel key (outside
    // an op the old behaviour stands).
    if (kind === 'video_publish' && opVideoEventRef.current && !videoKeyReadyForScope()) {
      throw new Error('Operation video key unavailable — not sharing until it is.');
    }
    return data;
  };

  // NET: one failed attempt → count it, and tell the strip once it's a likely
  // QUIC block (or auto-reconnect gave up). Traced for the diagnostics report.
  const reportConnectIssue = ({ gaveUp = false } = {}) => {
    const n = netConnectRef.current;
    const issue = connectIssueFrom({
      timeouts: n.timeouts.main + n.timeouts.alt, apiReachable: n.apiOk, gaveUp, lastKind: n.lastKind,
      attempts: n.attempts, via: n.via, altUntried: Boolean(n.altUrl) && n.timeouts.alt === 0,
    });
    if (issue) traceLog(`[net] connect issue kind=${issue.kind} gaveUp=${issue.gaveUp} timeouts=main:${n.timeouts.main},alt:${n.timeouts.alt} last=${n.lastKind} via=${n.via}`);
    setVoiceConnect((v) => ({ ...v, connectIssue: issue }));
  };
  const noteConnectFailure = (phase, elapsedMs, err) => {
    const n = netConnectRef.current;
    const kind = classifyConnectFailure({ phase, elapsedMs, message: err?.message });
    n.lastKind = kind;
    n.attempts += 1;
    n.apiOk = phase === 'transport'; // the ticket fetch is an HTTPS round trip
    if (kind === 'timeout') n.timeouts[n.via] += 1;
    traceLog(`[net] connect failed kind=${kind} phase=${phase} via=${n.via} after ${Math.round(elapsedMs)}ms: ${err?.message || err}`);
    reportConnectIssue();
  };
  const noteConnectSuccess = (url, via, hadPref, transportMode = 'webview') => {
    const n = netConnectRef.current;
    const switched = via === 'alt' && n.timeouts.main > 0;
    n.timeouts = { main: 0, alt: 0 };
    n.attempts = 0;
    n.lastKind = null;
    // Worked on the alternate port after 443 timed out: start there next time
    // on this network. Worked on 443 despite the preference: drop it.
    if (switched) writeAltPref(localStorage, { useAlt: true });
    else if (via === 'main' && hadPref) writeAltPref(localStorage, { useAlt: false });
    const port = portOfUrl(url);
    traceLog(`[net] connected via=${via} port=${port} transport=${transportMode}`);
    if (via === 'alt') addMsg(`Connected via alternate port ${port}.`, 'system');
    setVoiceConnect({ connectIssue: null, via, port, transport: transportMode });
  };

  const connect = async () => {
    traceLog(`CommLink connect() called for channelRef.current.id=${channelRef.current?.id} name=${channelRef.current?.name}`);
    // Any connect attempt resets the "intentional disconnect" guard.
    intentionalDisconnectRef.current = false;
    const myConnectGen = ++connectGenRef.current; // a later connect/disconnect supersedes this one
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    setStatus('connecting');
    addMsg(`Initiating handshake with ${org.callsign} [${channelRef.current.name}]...`);
    let connectPhase = 'setup'; // NET: 'transport' once the WebTransport attempt starts
    let transportStartedAt = 0;

    try {
      // Initialize WASM crypto (best-effort).
      //
      // The two ways this fails are not the same problem and must not report as
      // one. A WASM load failure means E2E can't work on this device at all. A
      // missing group membership (ERR_NOT_A_GROUP_MEMBER — any browser session,
      // since identity doesn't persist outside Tauri, or a fresh install before
      // another member has committed us in) is temporary and self-healing: the
      // key arrives with someone's Welcome. Lumping them together as "WASM
      // Crypto unavailable" sent every keyless viewer down a path that looked
      // like a local crypto fault, when the actionable state is "wait, or get
      // someone to open this channel".
      let wasmReady = true;
      try {
        await initWasm();
      } catch (err) {
        wasmReady = false;
        console.warn('WASM SFrame init failed (non-fatal, video E2E is disabled):', err);
        addMsg('WASM Crypto unavailable (non-fatal, video runs over TLS only).', 'system');
      }
      // Skipped outright when the cipher module itself didn't load — every
      // derivation below would throw on `new SFrameCrypto` and report a second,
      // misleading "key unavailable" on top of the real cause.
      // E2EV: never carry another channel's voice keys into this one (MOVE /
      // channel switch) — keyless is silent, a wrong key would be too, but
      // only keyless is visible as "Waiting for channel key…".
      if (audioKeyChannelRef.current !== channelRef.current.id) {
        clearRelayAudioPair(cryptoAudioRef, relayAudioTxRef);
        clearRelayAudioPair(cryptoAudioCascadeRef, relayAudioCascadeTxRef);
        // MR4: the old channel's video key gets no grace window here either.
        cryptoRef.clear();
        videoKeyGroupRef.current = null;
        opVideoEventRef.current = null; // the new channel's ticket sets it again
        audioKeyChannelRef.current = null;
        setVoiceKeyReady(false);
      }
      setVoiceGateError(null);
      if (wasmReady) try {
        const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
        await ensureChannelGroup(api, currentUserId, org.id, channelRef.current.id);
        // Op-wide share: the op key when the last ticket said so (the voice
        // ticket below re-applies the scope either way).
        // A missing op key must not cost the channel's audio key below.
        try {
          const { key: videoKey, groupId: videoGroupId } = await exportVideoKey(currentUserId, opVideoEventRef.current ? 'ensure' : 'export');
          installVideoKey(videoKey, videoGroupId);
        } catch (err) {
          if (!opVideoEventRef.current) throw err;
          traceLog(`[video-key] op key unavailable at connect: ${err?.message || err}`);
        }
        // Independent 'audio' label export for relay-mode audio crypto.
        const audioKey = await exportGroupSecret(api, currentUserId, channelRef.current.id, 'audio', 32);
        installRelayAudioKey(audioKey, false);
        audioKeyChannelRef.current = channelRef.current.id;
        setVoiceKeyReady(true);
        addMsg('WASM Cryptography Engine Initialized (ChaCha20Poly1305, MLS-derived key)');
      } catch (err) {
        if (isNotAGroupMemberError(err)) {
          // Not an error state to act on here — processVideoData's key recovery
          // (see keyMissingFrames) retries this with backoff the moment an
          // encrypted stream actually arrives, and until then there's nothing
          // to decrypt anyway.
          console.warn('[crypto] no MLS membership for this channel yet — key will be acquired when a Welcome lands');
          traceLog(`[crypto] channel key unavailable: not yet an MLS member of channel=${channelRef.current?.id}`);
          addMsg('Channel key not yet issued for this device — encrypted media will start once it is.', 'system');
        } else {
          console.warn('Channel key derivation failed (non-fatal, video E2E is disabled):', err);
          traceLog(`[crypto] channel key derivation FAILED for channel=${channelRef.current?.id}: ${err?.message || err}`);
          // E2EV: voice never falls back to plaintext — it waits for the key.
          addMsg('Channel key unavailable — voice stays silent until it is (retrying).', 'system');
        }
      }
      // Event-scoped cascade key used only for event channels. Separate try: an
      // event-group failure must not cost us the channel keys above (or vice
      // versa) — they're independent groups. Phase 2: lane retired
      // (EVENT_CASCADE_LANE), so this is skipped.
      if (EVENT_CASCADE_LANE && wasmReady) try {
        if (channelRef.current?.event_id) {
          const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
          await ensureEventGroup(api, currentUserId, org.id, channelRef.current.event_id);
          const cascadeKey = await exportGroupSecret(api, currentUserId, channelRef.current.event_id, 'audio-cascade', 32);
          installRelayAudioKey(cascadeKey, true);
        }
      } catch (err) {
        traceLog(`[crypto] event cascade key unavailable for event=${channelRef.current?.event_id}: ${err?.message || err}`);
      }
      // E2EV: keyless → silent ("Waiting for channel key…") and keep trying.
      scheduleVoiceKeyRetry();
      
      // Initialize Audio Mixer Core
      initAudioCore();

      // Configure the audio output device from stored preference (Tauri only).
      // This runs before the first play_frame so playback starts on the right device.
      if (window.__TAURI__) {
        const storedOutputDevice = localStorage.getItem('specter_audio_out');
        if (storedOutputDevice && storedOutputDevice !== 'default') {
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('plugin:specter-audio|set_output_device', { deviceId: storedOutputDevice })
              .catch(async (e) => {
                console.error('[Audio] set_output_device on init failed:', e);
                try {
                  await invoke('plugin:specter-audio|set_output_device', { deviceId: null });
                  console.warn('[Audio] output fallback to system default applied');
                } catch {}
              });
          });
        }
      }

      // 1) Get short-lived voice ticket
      const voiceTicket = await getMediaTicket('voice', null, channelRef.current.id);
      const token = voiceTicket.ticket;
      // NET: the main port, or the relay's alternate port (alt_media_url) when
      // this network's preference or repeated timeouts say so.
      const altPref = readAltPref(localStorage);
      const netChoice = chooseMediaUrl({
        mediaUrl: voiceTicket.media_url || 'https://localhost:4434',
        altMediaUrl: voiceTicket.alt_media_url || null,
        timeouts: netConnectRef.current.timeouts,
        pref: altPref,
      });
      const mediaUrl = netChoice.url;
      mediaUrlRef.current = mediaUrl;
      netConnectRef.current.via = netChoice.via;
      netConnectRef.current.altUrl = voiceTicket.alt_media_url || null;
      traceLog(`[net] connecting via=${netChoice.via} reason=${netChoice.reason} port=${portOfUrl(mediaUrl)}`);
      // E2EV: relay (end-to-end) is the only mode this client speaks. A
      // ticket for a mixed room means an out-of-date server; joining would
      // either send our audio somewhere it can't be played or tempt a
      // plaintext fallback — refuse instead.
      if (voiceTicket.voice_relay !== true) {
        throw new Error('This server does not support end-to-end encrypted voice yet — not connecting.');
      }
      voiceRelayModeRef.current = true;

      addMsg('Session token acquired.');

      // 2) Connect WebTransport
      const voiceUrl = (b) => `${b.replace(/\/$/, '')}/specter?token=${token}&channel_id=${channelRef.current.id}`;
      // Both ports and both transports (WebView2, then the native client)
      // race; the winner is remembered per network (engine/transportFactory.js).
      const mainBase = voiceTicket.media_url || mediaUrl;
      const altBase = voiceTicket.alt_media_url || null;
      connectPhase = 'transport';
      transportStartedAt = Date.now();
      const { transport, mode: transportMode, slot } = await createTransport(voiceUrl(mainBase), {
        altUrl: altBase ? voiceUrl(altBase) : null, label: 'voice', log: traceLog,
      });
      // Superseded while the race ran (disconnect, channel switch, a newer
      // connect): this transport belongs to nobody — close it and leave the
      // newer session's refs alone.
      if (myConnectGen !== connectGenRef.current || intentionalDisconnectRef.current) {
        traceLog('[net] connect superseded during the transport race; closing its transport');
        safeCloseTransport(transport);
        return;
      }
      transportRef.current = transport;
      const connectedVia = slot === 'alt' && altBase ? 'alt' : 'main';
      mediaUrlRef.current = connectedVia === 'alt' ? altBase : mainBase;
      netConnectRef.current.via = connectedVia;
      netConnectRef.current.transportMode = transportMode;

      await transport.ready;
      noteConnectSuccess(mediaUrlRef.current, connectedVia, Boolean(altPref), transportMode);
      setStatus('connected');
      // Reset backoff after a successful connect.
      reconnectAttemptRef.current = 0;
      // Bound outgoing datagram queue to limit latency growth under congestion.
      try {
        transport.datagrams.outgoingHighWaterMark = 4;
        transport.datagrams.outgoingMaxAge = 200;
      } catch (e) {
        console.warn('[WebTransport] outgoing datagram bounds not supported:', e);
      }
      datagramWriterRef.current = transport.datagrams.writable.getWriter();
      playFrameInFlightRef.current = 0;
      playFrameDroppedRef.current = 0;
      outputFallbackAttemptedRef.current = false;
      // Clear transient mic errors after transport is up.
      setMicError(null);
      // Apply threshold immediately instead of waiting for UI interaction.
      // Auto voice activation tells the mixer 0 (the client gate decides).
      sendAudioThreshold(serverThresholdFor());
      addMsg('Uplink established. Channel secure.');
        // Register presence so all org members can see who is in this channel
        api.joinChannelPresence(org.id, channelRef.current.id).catch(() => {});
        // Keep channel presence fresh so abrupt closes are auto-cleaned server-side.
        if (presenceHeartbeatRef.current) clearInterval(presenceHeartbeatRef.current);
        presenceHeartbeatRef.current = setInterval(async () => {
          // api.js's fetchWithAuth resolves {data, error} rather than
          // rejecting, so failures need an explicit check here, not .catch().
          // A stale/deleted channel returns 404 "Channel not found" (see
          // channelController's pingChannelPresence) — stop the heartbeat and
          // tear down the connection instead of retrying a dead channel forever.
          const { error } = await api.pingChannelPresence(org.id, channelRef.current.id);
          if (error === 'Channel not found') {
            if (presenceHeartbeatRef.current) {
              clearInterval(presenceHeartbeatRef.current);
              presenceHeartbeatRef.current = null;
            }
            disconnect();
          }
        }, 20_000);
      readDatagrams(transport);
      readIncomingStreams(transport); // Roster + Video streams
      monitorClosure(transport);

    } catch (err) {
      // A superseded attempt's failure is not this session's problem.
      if (myConnectGen !== connectGenRef.current) { traceLog(`[net] superseded connect failed: ${err?.message || err}`); return; }
      console.error(err);
      setStatus('error');
      addMsg(`Connection failed: ${err.message}`, 'error');
      // E2EV: the server's minimum-version refusal won't fix itself on retry.
      if (isUpgradeRequiredError(err?.message)) {
        setVoiceGateError(err.message);
        return;
      }
      // Failed before monitorClosure was ever attached (token fetch, WebTransport
      // handshake, etc.) — that path won't fire on its own, so retry from here.
      if (!intentionalDisconnectRef.current) {
        recordConnectionDrop();
        noteConnectFailure(connectPhase, transportStartedAt ? Date.now() - transportStartedAt : 0, err); // NET
      }
      scheduleReconnect();
    }
  };

  const handleRosterMsg = (msg) => {
      if (msg.type === 'Snapshot') {
          setRoster(msg.data);
          // Pre-warm the intro sound cache for all current members
          if (Array.isArray(msg.data)) prefetchIntroSounds(msg.data);
      } else if (msg.type === 'Sharers') {
          // Reliable delivery of active sharers on join (sent over uni stream).
          // Merge with existing list so a locally-added self callsign (set when
          // sharing starts) isn't overwritten by a server snapshot that arrives
          // slightly after (race condition when user starts sharing at join time).
          if (Array.isArray(msg.data) && msg.data.length > 0) {
              setAvailableSharers(prev => {
                const merged = [...msg.data];
                for (const cs of prev) {
                  if (!merged.includes(cs)) merged.push(cs);
                }
                return merged;
              });
          }
      } else if (msg.type === 'Join') {
          setRoster(prev => prev.includes(msg.data) ? prev : [...prev, msg.data]);
          // A joiner's own connect() bumps the channel's MLS epoch if they
          // weren't already represented in the group. Re-derive here too (not
          // just on Leave below) or we keep the pre-join key for the rest of
          // the session while they're on the post-join one — silent decrypt
          // mismatch (video black, audio silent).
          //
          // This roster "Join" arrives over the voice WebTransport connection,
          // completely independent of the mls_commit SSE event that carries the
          // actual epoch bump (a separate transport, identity-node not
          // media-rust). There's no ordering guarantee between them — if this
          // fires before the commit has actually landed and been applied
          // locally (see WarRoom.jsx's mls_commit handler, which correctly
          // waits for handleChannelCommit to resolve first), exportGroupSecret
          // derives from the *pre-commit* epoch: a real key gets set, just the
          // wrong one, indistinguishable from a correct refresh until decrypt
          // starts failing. Confirmed live via a diagnostic report: hasCryptoKey
          // was true and the key had "refreshed" twice, yet the very first
          // keyframe still failed to decrypt. Re-run once more after a delay
          // long enough for a same-request commit to have landed via SSE by
          // then, correcting the race in the common case without removing this
          // immediate attempt as a fallback for when SSE itself is what's slow.
          refreshVideoKey();
          refreshAudioKey();
          setTimeout(() => { refreshVideoKey(); refreshAudioKey(); }, 1500);
          // Play join sound for remote users only (not for ourselves)
          const localUser = JSON.parse(localStorage.getItem('specter_user') || '{}');
          const localCallsign = localUser.callsign || localUser.username || '';
          if (msg.data && msg.data !== localCallsign) {
              playJoinSoundForCallsign(msg.data);
          }
          // Re-announce our share to the newly joined user via SHARE_ANNOUNCE datagram
          if (isSharingRef.current) {
              const localUser = JSON.parse(localStorage.getItem('specter_user') || '{}');
              const cs = localUser.callsign || localUser.username || '';
              if (cs) {
                  const csBytes = new TextEncoder().encode(cs);
                  sendControlDatagram(0x01, [1, ...csBytes]);
                  if (shareAudioActiveRef.current) sendControlDatagram(SHARE_AUDIO_STATE_CONTROL, [1]); // S2: tile indicator
              }
          }
      } else if (msg.type === 'Leave') {
          // msg.data is { callsign, user_id } (server v1.10.23+).
          const leavingCallsign = typeof msg.data === 'string' ? msg.data : msg.data?.callsign;
          const leavingUserId   = typeof msg.data === 'string' ? null      : msg.data?.user_id;
          setRoster(prev => {
              const updated = prev.filter(u => u !== leavingCallsign);
              // Leaving the voice roster is presence, not group membership — an
              // org member who steps out of the call for a minute still holds a
              // legitimate copy of the MLS group secret, so there's nothing to
              // revoke here. This just re-derives from whatever the group's
              // current epoch actually is, picking up a real rotation if one
              // happened concurrently (e.g. another client's commit landed) —
              // a no-op key-for-key if it didn't.
              refreshVideoKey();
              refreshAudioKey();
              return updated;
          });
          // Clean up this user's audio lane(s) immediately rather than waiting
          // for the local user to disconnect — prevents Opus decoder/GainNode
          // accumulation in channels with repeated join/leave cycles.
          if (leavingUserId) {
              const leavingSsrcs = [];
              for (const [ssrc, uid] of ssrcToUserIdRef.current) {
                  if (uid === leavingUserId) leavingSsrcs.push(ssrc);
              }
              for (const ssrc of leavingSsrcs) {
                  ssrcToUserIdRef.current.delete(ssrc);
                  const lane = audioLanesRef.current.get(ssrc);
                  if (lane) { lane.decoder.free?.(); clearAudioLane(ssrc, lane); }
                  const laneId = relayLaneStreamId(channelRef.current.id, ssrc);
                  if (activeNativeLaneIdsRef.current.has(laneId)) {
                      activeNativeLaneIdsRef.current.delete(laneId);
                      import('@tauri-apps/api/core').then(({ invoke }) => {
                          invoke('plugin:specter-audio|clear_stream', { streamId: laneId }).catch(() => {});
                      });
                  }
              }
          }
      } else if (msg.type === 'Move') {
          // Admin has forcibly moved this client to a different channel.
          // Leave presence on the OLD channel before updating the ref, then reconnect.
          const newChannelId = msg.data;
          const oldChannelId = channelRef.current.id;
          addMsg(`[MOVE] You have been moved to channel: ${newChannelId}`, 'system');
          api.leaveChannelPresence(org.id, oldChannelId).catch(() => {});
          channelRef.current = { ...channelRef.current, id: newChannelId, name: newChannelId };
          // This is a deliberate teardown, not a drop — don't let monitorClosure's
          // own transport.closed handler schedule a competing auto-reconnect on
          // top of the explicit one below (connect() clears this flag again once
          // it runs).
          intentionalDisconnectRef.current = true;
          disconnect(true); // presence already handled above
          // Brief delay to let the transport close cleanly before opening a new one.
          setTimeout(() => connect(), 600);
      } else if (msg.type === 'Speaking') {
          const { callsign, level } = msg.data;
          const now = Date.now();
          // Engine phase 0: a live ref, not state — see engine/voiceLevels.js.
          const live = liveLevels;
          live.remoteLevels = { ...live.remoteLevels, [callsign]: { level, ts: now } };
          live.version++;
          live.remoteVersion++;
          const log = speakingHistoryRef.current;
          log.push({ callsign, level, ts: now });
          const cutoff = now - SPEAKING_HISTORY_WINDOW_MS;
          while (log.length > 0 && log[0].ts < cutoff) log.shift();
      } else if (msg.type === 'SsrcMap') {
          // { "12345": "user-uuid", ... } — JSON object keys are always strings,
          // even though the server's map is keyed by a numeric ssrc.
          const next = new Map();
          for (const [ssrcStr, userId] of Object.entries(msg.data || {})) {
              next.set(Number(ssrcStr), userId);
          }
          ssrcToUserIdRef.current = next;
      } else if (msg.type === 'Duck') {
          duckStateRef.current = { active: true, activeSsrc: msg.data?.ssrc >>> 0, level: msg.data?.level ?? 2 };
          setIsDucking(true);
          applyDuckStateToLanes();
      } else if (msg.type === 'DuckRelease') {
          duckStateRef.current = { active: false, activeSsrc: null, level: 0 };
          setIsDucking(false);
          applyDuckStateToLanes();
      }
  };

  // Browser-path only — applies duckStateRef to every currently-known lane's
  // GainNode except the active speaker's own (see duckStateRef's doc
  // comment). Called on every Duck/DuckRelease transition, and also
  // consulted when a lane is first created (getOrCreateAudioLane) so a lane
  // that appears mid-duck starts at the right gain instead of a beat of full
  // volume. The Tauri native path doesn't need an equivalent — its volume is
  // computed per-frame at send time in readDatagrams instead, since play_frame
  // takes volume as a per-call argument rather than a persistent node.
  const applyDuckStateToLanes = () => {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const { active, activeSsrc, level } = duckStateRef.current;
      const targetGain = active ? duckGainForLevel(level) : 1.0;
      const fadeSeconds = active ? 0.1 : 0.5; // matches the legacy single-bus triggerDucking's fade timings
      for (const [ssrc, lane] of audioLanesRef.current) {
          const gain = (active && ssrc !== activeSsrc) ? targetGain : 1.0;
          lane.gainNode.gain.setTargetAtTime(gain, ctx.currentTime, fadeSeconds);
      }
  };

  // sync=false only re-exports (MR4: onGroupStateChange — mlsSession has just
  // changed the group's local state itself).
  const refreshVideoKey = async ({ sync = true } = {}) => {
      try {
          const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
          const chanId = channelRef.current.id;
          // Sync-only: apply any pending server commits to advance deviceStateCache to
          // the current epoch WITHOUT attempting a new membership commit (which would
          // race against other clients and cause a 409 → retry → infinite 409 loop).
          // Op-wide share: the event group's op key while in a live op.
          const { key: videoKey, groupId } = await exportVideoKey(currentUserId, sync ? 'sync' : 'export');
          if (channelRef.current?.id !== chanId) return; // moved meanwhile
          if (groupId !== (opVideoEventRef.current || chanId)) return; // scope changed meanwhile
          installVideoKey(videoKey, groupId);
          traceLog(`[video-key] refreshed for channel=${channelRef.current?.id}`);
      } catch (err) {
          console.error("Video key refresh failed", err);
          traceLog(`[video-key] refresh FAILED for channel=${channelRef.current?.id}: ${err?.message || err}`);
      }
  };

  // Stronger than refreshVideoKey, for the case where this device holds no key
  // for the channel at all rather than a stale one (see keyMissingFrames).
  //
  // refreshVideoKey only syncs the epoch and re-exports; that cannot help a
  // device that isn't an MLS group member, because there is no group to export
  // from. This runs the full ensureChannelGroup first, which catches up any
  // pending Welcome (the thing that actually grants membership) and, if this
  // device really is the first one here, attempts genesis. Resolves true once a
  // key is in hand.
  //
  // Not merged into refreshVideoKey: ensureChannelGroup can submit membership
  // commits, and running that on every roster Join/Leave is exactly the
  // concurrent-commit 409 storm that syncChannelGroupEpoch exists to avoid. It
  // is only safe here because this path is rate-limited by backoff and only
  // reached when the alternative is a permanently undecodable stream.
  // MR4: heal=true first runs the throttled org-wide heal (see healOrgKeys).
  const recoverVideoKey = async ({ heal = false } = {}) => {
      try {
          const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
          if (heal) await healOrgKeys('video key recovery');
          const chanId = channelRef.current.id;
          await ensureChannelGroup(api, currentUserId, org.id, chanId);
          // Op-wide share: ensures the event group too while in a live op.
          const { key: videoKey, groupId } = await exportVideoKey(currentUserId, 'ensure');
          if (channelRef.current?.id !== chanId) return false; // moved meanwhile
          if (groupId !== (opVideoEventRef.current || chanId)) return false; // scope changed meanwhile
          installVideoKey(videoKey, groupId);
          traceLog(`[video-key] recovered for channel=${channelRef.current?.id}`);
          // The audio key shares the same group — if video just became
          // available, audio almost certainly did too.
          refreshAudioKey();
          return true;
      } catch (err) {
          if (isNotAGroupMemberError(err)) {
              traceLog(`[video-key] recovery: still not a member of channel=${channelRef.current?.id}`);
          } else {
              console.error('Video key recovery failed', err);
              traceLog(`[video-key] recovery FAILED for channel=${channelRef.current?.id}: ${err?.message || err}`);
          }
          return false;
      }
  };

  // Same opportunistic re-derive as refreshVideoKey, kept separate since it's
  // a different label/key — see cryptoAudioRef's doc comment.
  // E2EV: syncs the channel group's epoch first (like refreshVideoKey and the
  // monitor hook) — exporting from un-synced local state could keep sealing
  // with a pre-commit key everyone else has moved past. sync=false only
  // re-exports, for callers that just applied the commit themselves.
  // Also refreshes the event cascade key, so one call keeps both lanes current.
  const refreshAudioKey = async ({ sync = true } = {}) => {
      const chanId = channelRef.current?.id;
      if (!chanId) return;
      const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
      try {
          if (sync) {
              try { await syncChannelGroupEpoch(api, currentUserId, org.id, chanId); }
              catch (e) { console.warn('[Audio] channel epoch sync failed (re-exporting from local state):', e); }
          }
          const audioKey = await exportGroupSecret(api, currentUserId, chanId, 'audio', 32);
          if (channelRef.current?.id !== chanId) return; // moved meanwhile
          installRelayAudioPair(cryptoAudioRef, relayAudioTxRef, audioKey, false, chanId);
          audioKeyChannelRef.current = chanId;
          setVoiceKeyReady(true);
      } catch (err) {
          if (isNotAGroupMemberError(err)) {
              // Not (or no longer) a member: fail closed, show waiting, retry.
              clearRelayAudioPair(cryptoAudioRef, relayAudioTxRef);
              audioKeyChannelRef.current = null;
              setVoiceKeyReady(false);
          } else {
              console.error("Audio key refresh failed", err);
          }
      }
      await refreshCascadeKey({ sync });
      scheduleVoiceKeyRetry();
  };

  // E2EV: the event-scoped 'audio-cascade' pair. Previously derived only at
  // connect(), so an event-group epoch change (someone accepted/left a slot)
  // left this client sealing priority-cascade copies — and opening others' —
  // under a stale key for the rest of the session. Now refreshed on every
  // event-group commit/Welcome (onGroupKeyChange below), on sustained cascade
  // decrypt failures, and alongside every channel refresh.
  const refreshCascadeKey = async ({ sync = true } = {}) => {
      const eventId = channelRef.current?.event_id;
      if (!EVENT_CASCADE_LANE || !eventId) {
          clearRelayAudioPair(cryptoAudioCascadeRef, relayAudioCascadeTxRef);
          return;
      }
      const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
      try {
          if (sync) {
              try { await syncEventGroupEpoch(api, currentUserId, org.id, eventId); }
              catch (e) { console.warn('[Audio] event epoch sync failed (re-exporting from local state):', e); }
          }
          const key = await exportGroupSecret(api, currentUserId, eventId, 'audio-cascade', 32);
          if (channelRef.current?.event_id !== eventId) return;
          installRelayAudioKey(key, true);
      } catch (err) {
          if (isNotAGroupMemberError(err)) clearRelayAudioPair(cryptoAudioCascadeRef, relayAudioCascadeTxRef);
          else traceLog(`[crypto] cascade key refresh failed for event=${eventId}: ${err?.message || err}`);
      }
  };

  // E2EV: while this device holds no channel voice key, or on an event channel
  // no cascade key, retry with backoff (1 s → 30 s). Each attempt runs the full
  // ensure*Group (picks up a pending Welcome, external-joins, starts a group
  // nobody has) like recoverVideoKey — rate-limited by the backoff, and only
  // while keyless, so it can't turn into a commit storm. A voice-only listener
  // has no video frames to trigger that path, so from KEY_HEAL_ORG_LEVEL a
  // failed attempt escalates here too; past VOICE_KEY_PROBLEM_ATTEMPT the user
  // is told why, and the retries carry on.
  const hasChannelVoiceKey = () => !!relayAudioTxRef.current && audioKeyChannelRef.current === channelRef.current?.id;
  const needsCascadeKey = () => EVENT_CASCADE_LANE && !!channelRef.current?.event_id && !relayAudioCascadeTxRef.current;
  const scheduleVoiceKeyRetry = () => {
      const r = voiceKeyRetryRef.current;
      if (r.timer) return;
      if (hasChannelVoiceKey() && !needsCascadeKey()) {
          r.attempt = 0;
          setVoiceKeyProblem(null);
          return;
      }
      if (intentionalDisconnectRef.current) return;
      const delay = Math.min(VOICE_KEY_RETRY_BASE_MS * 2 ** r.attempt, VOICE_KEY_RETRY_MAX_MS);
      r.attempt = Math.min(r.attempt + 1, 10);
      r.timer = setTimeout(async () => {
          r.timer = null;
          if (intentionalDisconnectRef.current) return;
          const chanId = channelRef.current?.id;
          const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
          if (!hasChannelVoiceKey()) {
              let status = null;
              try {
                  status = await ensureChannelGroup(api, currentUserId, org.id, chanId);
                  const audioKey = await exportGroupSecret(api, currentUserId, chanId, 'audio', 32);
                  if (channelRef.current?.id === chanId) {
                      installRelayAudioPair(cryptoAudioRef, relayAudioTxRef, audioKey, false, chanId);
                      audioKeyChannelRef.current = chanId;
                      setVoiceKeyReady(true);
                      addMsg('Channel key acquired — voice is end-to-end encrypted.', 'system');
                      traceLog(`[audio-key] recovered for channel=${chanId}`);
                  }
              } catch (err) {
                  traceLog(`[audio-key] still keyless for channel=${chanId} (attempt ${r.attempt}, ${status?.reason ?? 'no status'}): ${err?.message || err}`);
                  if (r.attempt > KEY_HEAL_ORG_LEVEL) await healOrgKeys('voice key recovery');
                  if (r.attempt === VOICE_KEY_PROBLEM_ATTEMPT) {
                      const text = voiceKeyProblemText(status?.reason);
                      setVoiceKeyProblem(text);
                      addMsg(text, 'system');
                  }
              }
          }
          const eventId = channelRef.current?.event_id;
          if (eventId && needsCascadeKey()) {
              try {
                  await ensureEventGroup(api, currentUserId, org.id, eventId);
                  await refreshCascadeKey({ sync: false });
              } catch (err) {
                  traceLog(`[audio-key] no cascade key yet for event=${eventId}: ${err?.message || err}`);
              }
          }
          scheduleVoiceKeyRetry();
      }, delay);
  };

  // MR4: mlsSession.healOrgEncryption for this org (catch up every group,
  // external-join / resync any this device isn't in or has diverged from),
  // at most once per org per ORG_HEAL_MIN_INTERVAL_MS across CommLink and
  // every monitor. Never forced — a forced resync of every channel from an
  // automatic path would bump epochs for everyone and could feed a rekey
  // storm; that stays the user's "Resync encryption" button. Resolves true if
  // a heal actually ran. Its group changes reach us via onGroupStateChange.
  const healOrgKeys = async (why) => {
      const heal = mlsSession.healOrgEncryption;
      if (typeof heal !== 'function' || !org?.id || !claimOrgHeal(org.id)) return false;
      const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
      traceLog(`[e2e-heal] ${why} — healing org encryption for org=${org.id}`);
      try {
          const r = await heal(api, currentUserId, org.id);
          traceLog(`[e2e-heal] done: healed=${r?.healed?.length ?? 0} failed=${r?.failed?.length ?? 0} checked=${r?.checked ?? '?'}`);
          return true;
      } catch (err) {
          traceLog(`[e2e-heal] FAILED for org=${org.id}: ${err?.message || err}`);
          return false;
      }
  };

  // MR4: one rung of the stale-key recovery ladder for a voice lane (see
  // KEY_HEAL_*_LEVEL). Every rung ends in a re-export, so a heal that fixed
  // things takes effect even if its onGroupStateChange is missed.
  const recoverVoiceLane = async (isCascade, level) => {
      if (isCascade && !EVENT_CASCADE_LANE) return; // lane retired: nothing to recover
      const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
      if (level < KEY_HEAL_ENSURE_LEVEL) {
          if (isCascade) await refreshCascadeKey({ sync: true });
          else await refreshAudioKey({ sync: true });
          return;
      }
      if (level >= KEY_HEAL_ORG_LEVEL) await healOrgKeys(`sustained ${isCascade ? 'cascade' : 'channel'} voice decrypt failures`);
      try {
          if (isCascade) {
              const eventId = channelRef.current?.event_id;
              if (eventId) await ensureEventGroup(api, currentUserId, org.id, eventId);
          } else {
              await ensureChannelGroup(api, currentUserId, org.id, channelRef.current?.id);
          }
      } catch (err) {
          traceLog(`[audio-key] ensure group during recovery failed: ${err?.message || err}`);
      }
      if (isCascade) await refreshCascadeKey({ sync: false });
      else await refreshAudioKey({ sync: false });
  };

  // E2EV: called per dropped relay frame — MR4: one that failed both the
  // current and the grace (previous) key. Sustained AEAD failures on one lane
  // mean a stale key (missed commit) or a diverged group — recover with
  // backoff, per lane, so a healthy channel key can't mask a stale cascade
  // key or vice versa, escalating each time recovery didn't help.
  const noteVoiceDecryptFailure = (isCascade) => {
      const s = decryptFailStreakRef.current;
      const lane = isCascade ? 'cascade' : 'channel';
      s[lane] += 1;
      if (s[lane] < VOICE_DECRYPT_FAIL_THRESHOLD) return;
      const backoff = Math.min(VOICE_KEY_RETRY_BASE_MS * 2 ** s.attempt, VOICE_KEY_RETRY_MAX_MS);
      if (Date.now() - s.lastRecoveryAt < backoff) return;
      const level = s.attempt;
      s[lane] = 0;
      s.lastRecoveryAt = Date.now();
      s.attempt = Math.min(s.attempt + 1, 10);
      traceLog(`[audio-key] sustained ${lane} decrypt failures — recovery level ${level}`);
      recoverVoiceLane(isCascade, level).catch(() => {});
  };
  const noteVoiceDecryptSuccess = (isCascade) => {
      const s = decryptFailStreakRef.current;
      s[isCascade ? 'cascade' : 'channel'] = 0;
      s.attempt = 0;
  };

  // Encodes the snipped frames as a 4B magic tag ("SEV2") followed by repeated
  // [8B ts u64 LE][4B ssrc u32 LE][4B opus_len u32 LE][opus bytes] — see the
  // matching decoder in AdminPortal's voice report review UI. Kept in lockstep
  // with that decoder; both sides are this app's own code, there's no external
  // format to match. The magic tag lets the decoder tell this format apart
  // from the older (pre-attribution) framing without an ssrc field, so
  // already-submitted reports stay decodable.
  const REPORT_CLIP_MAGIC = 0x53455632; // "SEV2" as a big-endian u32
  const frameReportClip = (frames) => {
    const decoded = frames.map(([ts, ssrc, b64]) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { ts, ssrc: ssrc >>> 0, bytes };
    });
    let totalLen = 4;
    for (const f of decoded) totalLen += 8 + 4 + 4 + f.bytes.length;
    const buf = new Uint8Array(totalLen);
    const view = new DataView(buf.buffer);
    let offset = 0;
    view.setUint32(offset, REPORT_CLIP_MAGIC, false);
    offset += 4;
    for (const f of decoded) {
      view.setUint32(offset, f.ts >>> 0, true);
      view.setUint32(offset + 4, Math.floor(f.ts / 4294967296), true);
      offset += 8;
      view.setUint32(offset, f.ssrc, true);
      offset += 4;
      view.setUint32(offset, f.bytes.length, true);
      offset += 4;
      buf.set(f.bytes, offset);
      offset += f.bytes.length;
    }
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return btoa(bin);
  };

  /**
   * Reports `accusedUserId` for misconduct heard during this call, attaching
   * the last `clipDurationMs` of actual call audio (the mixed stream this
   * client received — see submitReportFrame above) plus the real,
   * server-computed speaking-activity log for that window. Built for
   * exactly the case where "someone said this" needs to be actionable, not
   * just alleged — e.g. CSAM/CSE and similar bad-actor behavior that needs
   * a real evidence trail to ban on.
   */
  const submitVoiceReport = async (accusedUserId, note, orgId, clipDurationMs = 60_000) => {
    try {
      const frames = await api.snipReportClip(clipDurationMs);
      if (!frames || frames.length === 0) {
        return { ok: false, error: 'No recent call audio available to attach.' };
      }
      const audioClipB64 = frameReportClip(frames);

      const cutoff = Date.now() - clipDurationMs;
      const speakingHistory = speakingHistoryRef.current.filter((e) => e.ts >= cutoff);

      // ssrc (string key — JSON object keys are always strings) -> user_id,
      // scoped to only the ssrcs actually present in this clip. In a still
      // mixed-mode channel this is empty (every frame is ssrc=0, nothing
      // meaningful to attribute); the server treats a missing/empty map the
      // same way.
      const clipSsrcs = new Set(frames.map(([, ssrc]) => ssrc >>> 0));
      const speakerMap = {};
      for (const [ssrc, userId] of ssrcToUserIdRef.current) {
        if (clipSsrcs.has(ssrc)) speakerMap[String(ssrc)] = userId;
      }

      const { error } = await api.sendVoiceReport({
        accused_id: accusedUserId,
        org_id: orgId ?? null,
        channel_id: channelRef.current?.id ?? null,
        reported_at: new Date().toISOString(),
        reporter_note: note || null,
        audio_clip: audioClipB64,
        speaking_history: speakingHistory,
        speaker_map: speakerMap,
      });
      if (error) return { ok: false, error };
      return { ok: true };
    } catch (err) {
      console.error('[report] submitVoiceReport failed:', err);
      return { ok: false, error: err?.message || String(err) };
    }
  };

  const isExpectedTransportClose = (err) => {
    const msg = String(err?.message || err || '').toLowerCase();
    return msg.includes('session is closed') || msg.includes('connection closed') || msg.includes('stream aborted');
  };

  const readIncomingStreams = async (transport) => {
    try {
      const reader = transport.incomingUnidirectionalStreams.getReader();
      while (true) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        routeIncomingStream(stream, transport);
      }
    } catch (err) {
      if (transportRef.current !== transport || isExpectedTransportClose(err)) return;
      console.error("Incoming stream monitor error", err);
    }
  };

  const routeIncomingStream = async (stream, transport) => {
    const reader = stream.getReader();
    const { value: firstChunk, done } = await reader.read();
    if (done || !firstChunk || firstChunk.length === 0) return;
    const typeByte = firstChunk[0];
    const remainder = firstChunk.slice(1);
    if (typeByte === 0x01) {
      readRosterFromReader(reader, remainder, transport);
    } else if (typeByte === 0x02) {
      processVideoData(reader, remainder);
    } else {
      // Legacy stream without type prefix — treat as roster
      readRosterFromReader(reader, firstChunk, transport);
    }
  };

  const readRosterFromReader = async (reader, initialBytes, transport) => {
    try {
      let buffer = new TextDecoder().decode(initialBytes);
      const processBuffer = () => {
        const parts = buffer.split('\n');
        buffer = parts.pop();
        for (const part of parts) {
          if (part.trim()) {
            try {
               const msg = JSON.parse(part);
               handleRosterMsg(msg);
            } catch(e) { /* ignore parse errors */ }
          }
        }
      };
      
      // Process any complete messages in the initial chunk
      processBuffer();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        processBuffer();
      }
    } catch (err) {
      if (transportRef.current !== transport || isExpectedTransportClose(err)) return;
      console.error("Error reading roster stream", err);
    }
  };

  // `callsign`: the sharer this subscription watches (S3 share-audio routing).
  const processVideoData = async (reader, initialBytes, session = videoSessionRef.current, callsign = null) => {
    let buffer = initialBytes;
    const readMore = async () => {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer = concatU8(buffer, value);
      return true;
    };

    // Read header: [4B header_len][header JSON]
    while (buffer.length < 4) if (!(await readMore())) return;
    const headerLen = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
    while (buffer.length < 4 + headerLen) if (!(await readMore())) return;

    let header;
    try { header = JSON.parse(new TextDecoder().decode(buffer.slice(4, 4 + headerLen))); }
    catch (e) {
      console.error('[processVideoData] header JSON parse failed, headerLen=', headerLen, e);
      if (window.__TAURI__) import('@tauri-apps/api/event').then(({ emit }) => emit('overlay-video-status', { message: 'Stream header corrupt — restart share' })).catch(() => {});
      svStatus(STREAM_STATUS.ERROR, 'The stream header was corrupt. The sharer should restart their share.'); // SV
      return;
    }
    console.log('[video] stream header received:', JSON.stringify(header), 'hasCryptoKey=', !!cryptoRef.current);
    traceLog(`[video] stream header received codec=${header.codec} ${header.width}x${header.height} hasCryptoKey=${!!cryptoRef.current}`);
    buffer = buffer.slice(4 + headerLen);

    if (typeof VideoDecoder === 'undefined') {
      addMsg('Remote screen share detected but WebCodecs unavailable.', 'error');
      traceLog('[video] aborting: WebCodecs VideoDecoder unavailable in this webview');
      return;
    }

    setRemoteShare(header);

    const codec = header.codec || 'vp8';
    // Against an older sender we fall back to the legacy guess (decrypt iff we
    // hold a key), which is what this receiver did for every sender before the
    // declaration existed.
    // Whether this stream is encrypted is the sender's fact, declared once in
    // the header (see STREAM_ENCRYPTION_FIELD). `undefined` means a sender from
    // before the field existed, which leaves nothing to do but the old guess.
    const declaredEncryption = header[STREAM_ENCRYPTION_FIELD];
    const senderDeclaresEncryption = typeof declaredEncryption === 'boolean';
    shareAudioStreamEncRef.current = { session, encrypted: declaredEncryption === true }; // S2: datagram audio
    // looksLikeAnnexB only means anything for the bytestream codecs whose
    // keyframes start with a start code; VP8/VP9 use different magic, so don't
    // apply that heuristic to them at all.
    const isAnnexBCodec = /^(avc|hev|hvc|h264|h265)/i.test(codec);
    traceLog(`[video] sender encryption declared=${senderDeclaresEncryption ? declaredEncryption : 'absent'} annexB=${isAnnexBCodec}`);

    // Store header so we can re-send it if the overlay opens mid-stream.
    // NOTE: We no longer fire a separate header-only emit here.  Instead the header
    // is sent atomically with each keyframe in the relay loop below — this guarantees
    // the overlay decoder is always (re-)configured before its first keyframe arrives,
    // eliminating the race where a stale separate header arrives after the keyframe.
    remoteStreamHeaderRef.current = { codec, width: header.width, height: header.height };

    let framesRelayed = 0;
    let framesDecoded = 0;
    let stallWarned = false;
    // Separate from framesRelayed/framesDecoded below, which only count
    // successfully-decrypted frames — a 100%-decrypt-failure stream would
    // otherwise never trip the stall warning (relayed stays 0) and would
    // just render black with no signal to the user.
    let consecutiveDecryptFailures = 0;
    let decryptFailWarned = false;
    let decryptRecoveryLevel = 0;
    // Decode-rate telemetry: log FPS + drop rate every 5 seconds
    let statsWindowStart = Date.now();
    let statsRelayedWindow = 0;
    let statsDecodedWindow = 0;
    // Y-branch, not parallel roads: only one decoder should ever be doing work
    // for this stream. While the overlay is open it owns the decode (and the
    // hardware decode session that comes with it) — this window just relays
    // raw NAL bytes to it. Set whenever the overlay is seen active so that,
    // once it closes, we wait for the next keyframe before resuming decode
    // here instead of feeding a decoder P-frames for a GOP it never saw.
    let mainNeedsResync = true; // wait for first keyframe before decoding anything

    // Recovery state (engine/videoRecovery.js decideVideoRecovery). The decoder
    // is recreated in place on error/closed/stall; the transport stays up.
    let decoderBroken = false;
    let decodePending = false; // input has gone in since the last output
    let progressTs = 0; // last output, or first input since it
    let lastPacketTs = null;
    let lastRecoverTs = null;
    let recoverAttempts = 0;
    let resubscribing = false;
    const makeDecoder = () => {
      const self = new VideoDecoder({
      output: (frame) => {
        if (videoSessionRef.current !== session || decoder !== self) { frame.close(); return; }
        decodePending = false;
        progressTs = performance.now();
        if (recoverAttempts > 0 && lastRecoverTs !== null && progressTs - lastRecoverTs > RECOVERY_STABLE_MS) {
          recoverAttempts = 0;
          traceLog('[video-recover] stable, attempts reset');
        }
        const pendingKey = frame.timestamp;
        const enqueuedAt = decodePendingRef.current.get(pendingKey);
        if (typeof enqueuedAt === 'number') {
          decodePendingRef.current.delete(pendingKey);
          const stats = videoStageStatsRef.current;
          const decodeMs = performance.now() - enqueuedAt;
          stats.decodeCount += 1;
          stats.decodeMs += decodeMs;
          shareAudioPlayerRef.current.videoDecodeMs(decodeMs); // S3: A/V delay estimate
        }
        framesDecoded++;
        statsDecodedWindow++;
        const now = Date.now();
        if (now - statsWindowStart >= 5000) {
          const elapsed = (now - statsWindowStart) / 1000;
          const relayFps = (statsRelayedWindow / elapsed).toFixed(1);
          const decodeFps = (statsDecodedWindow / elapsed).toFixed(1);
          const dropPct = statsRelayedWindow > 0
            ? (((statsRelayedWindow - statsDecodedWindow) / statsRelayedWindow) * 100).toFixed(1)
            : '0.0';
          console.log(`[video] relay=${relayFps}fps decode=${decodeFps}fps drop=${dropPct}%`);
          statsWindowStart = now;
          statsRelayedWindow = 0;
          statsDecodedWindow = 0;
        }
        // Buffer the latest frame for the RAF render loop; close any pending un-drawn frame.
        if (latestRemoteFrameRef.current) { latestRemoteFrameRef.current.close(); }
        latestRemoteFrameRef.current = frame;
        videoFrameCallbackRef.current?.(frame);
        // NOTE: do not close frame here — the RAF render loop owns and closes it.
        // Kick the draw loop awake if it isn't already scheduled — see rafScheduledRef.
        if (!rafScheduledRef.current && drawLoopRef.current) {
          rafScheduledRef.current = true;
          requestAnimationFrame(drawLoopRef.current);
        }
      },
      error: (e) => {
        console.error('VideoDecoder error:', e);
        traceLog(`[video] VideoDecoder error: ${e?.message || e}`);
        if (decoder === self) decoderBroken = true; // recovered on the next frame
      }
      });
      return self;
    };
    let decoder = makeDecoder();
    // Configure lazily, on the first frame we actually intend to decode rather
    // than here — configure() opens a real (often hardware) decode session, and
    // a stream we can't decrypt must never get one. Returns false once it has
    // exhausted both hardware preferences, which is terminal for this stream.
    //
    // Try hardware-accelerated decode first; if the browser/driver rejects it
    // (e.g. integrated GPU with no VP9 HW decoder), fall back to no-preference
    // so the browser picks software decode rather than erroring out entirely.
    let configured = false;
    let configureFailed = false;
    const ensureConfigured = () => {
      if (configured) return decoder.state !== 'closed';
      if (configureFailed) return false;
      for (const hwPref of ['prefer-hardware', 'no-preference']) {
        try {
          decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: hwPref });
          traceLog(`[video] decoder.configure OK codec=${codec} hwPref=${hwPref}`);
          configured = true;
          return true;
        } catch (cfgErr) {
          traceLog(`[video] decoder.configure FAILED codec=${codec} hwPref=${hwPref}: ${cfgErr?.message || cfgErr}`);
          if (hwPref === 'no-preference') {
            console.error('[processVideoData] decoder.configure failed on all hw preferences', codec, cfgErr);
            if (window.__TAURI__) import('@tauri-apps/api/event').then(({ emit }) => emit('overlay-video-status', { message: `Decoder config failed: ${cfgErr?.message || cfgErr}` })).catch(() => {});
          }
        }
      }
      configureFailed = true;
      return false;
    };

    // Reset the decoder in place, drop deltas until a keyframe, ask for one.
    // Past the attempt budget, resubscribe (what a manual refresh does).
    const recoverIfNeeded = () => {
      if (resubscribing) return;
      const nowT = performance.now();
      const d = decideVideoRecovery({
        broken: decoderBroken, state: decoder.state, queueSize: decoder.decodeQueueSize,
        lastDecodedTs: decodePending ? progressTs : null, lastPacketTs, lastRecoverTs,
        attempts: recoverAttempts, now: nowT,
      });
      if (d.action === 'none') return;
      if (d.action === 'resubscribe') {
        resubscribing = true;
        traceLog(`[video-recover] ${d.reason}; ${recoverAttempts} resets failed — full resubscribe`);
        const target = callsign || watchStreamTargetRef.current;
        if (target) subscribeToRemoteStream(target);
        return;
      }
      recoverAttempts++;
      lastRecoverTs = nowT;
      traceLog(`[video-recover] ${d.reason}; resetting decoder (attempt ${recoverAttempts}), awaiting keyframe`);
      const old = decoder;
      decoderBroken = false;
      decodePending = false;
      configured = false;
      configureFailed = false;
      mainNeedsResync = true;
      decodePendingRef.current.clear();
      decoder = makeDecoder();
      try { if (old.state !== 'closed') old.close(); } catch { /* already gone */ }
      requestRemoteKeyframe('decoder recovery');
    };

    // Read frames: [4B frame_size][1B flags][4B timestamp_ms][data]
    let _firstFrameLogged = false;
    // Set while the sender declares it is encrypting (see
    // STREAM_ENCRYPTION_FIELD) and this device holds no key for the channel.
    // Previously this exact state fed ciphertext straight into
    // decoder.decode(), and it is also the one failure mode the old
    // decrypt-failure counters could not
    // see, because decrypt was never attempted: consecutiveDecryptFailures
    // stayed 0, so the 30-frame auto-refresh never ran and the stream sat black
    // behind an opaque decoder error forever. Recovery is its own backoff loop
    // below rather than the decrypt-failure path, since the fix is to *obtain* a
    // key (an MLS Welcome has to arrive) rather than to re-derive one.
    let keyMissingFrames = 0;
    let keyMissingWarned = false;
    let keyRecoveryInFlight = false;
    let keyRecoveryAttempts = 0;
    try {
      while (true) {
        while (buffer.length < 4) if (!(await readMore())) throw 'eof';
        const frameSize = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
        if (frameSize === 0) break;
        while (buffer.length < 4 + frameSize) if (!(await readMore())) throw 'eof';

        // S2: a share-audio frame (engine/shareAudio.js) — never video. Only
        // reaches us because we asked for it (SHARE_AUDIO_SUBSCRIBE_PARAM).
        // Handled entirely aside: it must not touch the decoder, the GOP
        // buffer, the overlay relay, or the decrypt-failure/stall counters.
        if (frameSize >= 5 && isShareAudioFlags(buffer[4])) {
          const audioTsMs = new DataView(buffer.buffer, buffer.byteOffset + 5, 4).getUint32(0);
          handleShareAudioFrame(callsign, session, declaredEncryption === true, audioTsMs, buffer.slice(9, 4 + frameSize));
          buffer = buffer.slice(4 + frameSize);
          continue;
        }

        const frameType = buffer[4] === 0 ? 'key' : 'delta';
        const tsMs = new DataView(buffer.buffer, buffer.byteOffset + 5, 4).getUint32(0);
        lastPacketTs = performance.now();
        if (!overlayActiveRef.current && !stripViewerActiveRef.current && videoSessionRef.current === session) recoverIfNeeded();
        const recvStageStart = performance.now();
        if (!_firstFrameLogged) {
          _firstFrameLogged = true;
          console.log('[video] first frame received, type=', frameType, 'frameSize=', frameSize, 'ts=', tsMs);
        }
        // H.264 data arrives in Annex-B format (FFmpeg/native encoder output).
        // VideoDecoder configured WITHOUT a description operates in Annex-B
        // (bytestream) mode per the WebCodecs AVC spec — do NOT convert to AVCC.
        let frameData = buffer.slice(9, 4 + frameSize);
        // The wire payload is this channel's MLS-keyed ciphertext (see
        // cryptoRef/refreshVideoKey above) — media-rust never sees plaintext,
        // only this [size][flags][timestamp] header plus opaque bytes. A
        // decrypt failure (stale key mid-rotation) drops just this one frame
        // rather than feeding garbage into the decoder.
        //
        // Whether the payload is encrypted is the sender's fact, not ours: take
        // the header's declaration when there is one, and only fall back to
        // inferring it from our own key for senders that predate the field
        // (see STREAM_ENCRYPTION_FIELD).
        let frameEncrypted = senderDeclaresEncryption
          ? declaredEncryption
          : !!cryptoRef.current;
        // Undeclared sender and we hold no key, so the guess above said
        // "plaintext" and we were about to decode it. Verify that claim on
        // keyframes before trusting it (see looksLikeAnnexB) — this is the one
        // place the old code fed ciphertext to the decoder, and against an old
        // sender there is no declaration to save us.
        if (!senderDeclaresEncryption && !frameEncrypted && frameType === 'key'
            && isAnnexBCodec && !looksLikeAnnexB(frameData)) {
          frameEncrypted = true;
        }
        let frameUndecryptable = false;
        let frameKeyMissing = false;
        if (frameEncrypted && !cryptoRef.current) {
          // Encrypted, and we have nothing to decrypt it with. Never decode it.
          frameKeyMissing = true;
        } else if (frameEncrypted) {
          // MR4: current key, then (inside the rekey grace window) the
          // previous one — a sharer that hasn't switched yet keeps playing.
          try {
            const encrypted = frameData;
            frameData = withGraceKeys(cryptoRef, (k) => k.decrypt(encrypted)).value;
          } catch (err) {
            frameUndecryptable = true;
          }
        }
        if (frameKeyMissing) {
          keyMissingFrames++;
          if (!keyMissingWarned) {
            keyMissingWarned = true;
            const msg = 'Stream is encrypted but this device has no channel key yet — acquiring.';
            console.warn('[video] encrypted stream, no local key:', 'frameType=', frameType, 'frameSize=', frameSize);
            traceLog(`[video] encrypted frame with no local key (type=${frameType}) — decode suppressed, attempting key recovery`);
            addMsg(msg, 'system');
            if (window.__TAURI__) import('@tauri-apps/api/event').then(({ emit }) => emit('overlay-video-status', { message: 'Waiting for channel key…' })).catch(() => {});
            svStatus(STREAM_STATUS.WAITING_KEY, 'Waiting for channel key…'); // SV
          }
          // Backoff key recovery. refreshVideoKey alone is not enough here: the
          // usual cause is that this device isn't an MLS group member at all
          // (fresh install, or any browser session — identity doesn't persist
          // outside Tauri), so it has to wait for another member's Welcome to
          // land and then catch up. recoverVideoKey retries both paths; the
          // backoff keeps a channel nobody can add us to from spinning.
          if (!keyRecoveryInFlight && keyMissingFrames >= KEY_RECOVERY_FRAME_THRESHOLD) {
            keyMissingFrames = 0;
            keyRecoveryInFlight = true;
            const attempt = ++keyRecoveryAttempts;
            const delay = Math.min(KEY_RECOVERY_BASE_MS * 2 ** (attempt - 1), KEY_RECOVERY_MAX_MS);
            traceLog(`[video] key recovery attempt ${attempt} scheduled in ${delay}ms`);
            setTimeout(() => {
              // MR4: from the third attempt, also heal the org's encryption
              // (external join when nobody has added this device).
              recoverVideoKey({ heal: attempt > KEY_HEAL_ORG_LEVEL }).then((got) => {
                keyRecoveryInFlight = false;
                if (got) {
                  traceLog(`[video] key recovery attempt ${attempt} succeeded — resuming decode`);
                  addMsg('Channel key acquired — stream resuming.', 'system');
                  svStatus(STREAM_STATUS.WAITING_KEYFRAME, 'Channel key acquired. Waiting for the next keyframe…'); // SV
                  keyMissingWarned = false;
                  keyRecoveryAttempts = 0;
                  // Force a resync: the GOP this device sat out is unusable, so
                  // wait for the sharer's next keyframe before decoding again
                  // (and ask for it now rather than waiting out the GOP).
                  mainNeedsResync = true;
                  requestRemoteKeyframe('channel key acquired');
                } else {
                  traceLog(`[video] key recovery attempt ${attempt} failed — still no group membership`);
                }
              });
            }, delay);
          }
        } else if (frameUndecryptable) {
          consecutiveDecryptFailures++;
          if (consecutiveDecryptFailures === 1) {
            // Log the first failure immediately rather than waiting for the
            // 30-frame sustained-failure threshold below — a stream that
            // decrypts fine after a brief rotation blip never hits 30 and
            // would otherwise leave zero trace of the failure ever happening.
            traceLog(`[video] decrypt failure (frame type=${frameType}, hasCryptoKey=${!!cryptoRef.current})`);
            // Log raw bytes to detect unencrypted Annex-B (sharer WASM init failed)
            if (consecutiveDecryptFailures === 1) {
              console.warn('[video] first decrypt failure — frameType=', frameType, 'frameSize=', frameData.length, 'firstBytes=', Array.from(frameData.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' '));
            }
          }
          if (!decryptFailWarned && consecutiveDecryptFailures === 30) {
            decryptFailWarned = true;
            // MR4: escalate per episode that recovery didn't fix (reset by any
            // frame that decrypts): re-sync → ensureChannelGroup → org heal.
            const level = decryptRecoveryLevel++;
            console.warn('[video] sustained decrypt failure: consecutiveDecryptFailures=', consecutiveDecryptFailures);
            traceLog(`[video] sustained decrypt failure: consecutiveDecryptFailures=${consecutiveDecryptFailures} — auto-refreshing key (level ${level})`);
            (level < KEY_HEAL_ENSURE_LEVEL ? refreshVideoKey() : recoverVideoKey({ heal: level >= KEY_HEAL_ORG_LEVEL })).then(() => {
              // Reset so we get a fresh warning + another auto-refresh attempt if the
              // new key still doesn't match (e.g. another epoch commit mid-stream).
              consecutiveDecryptFailures = 0;
              decryptFailWarned = false;
            });
          }
        } else {
          if (consecutiveDecryptFailures > 0) {
            traceLog(`[video] decrypt recovered after ${consecutiveDecryptFailures} failure(s)`);
          }
          consecutiveDecryptFailures = 0;
          decryptRecoveryLevel = 0;
          keyMissingFrames = 0;
        }
        // A frame we couldn't decrypt, or had no key for, is plaintext to nobody:
        // it must not reach the decoder, the GOP buffer, or the overlay relay.
        const frameUsable = !frameUndecryptable && !frameKeyMissing;
        if (frameUsable) {
        // Accumulate GOP buffer so we can replay a complete reference chain when seeding
        // the overlay decoder — sending only a keyframe causes P-frame decode errors.
        if (frameType === 'key') {
          gopBufferRef.current = [{ data: frameData, tsMs, type: 'key' }];
        } else {
          gopBufferRef.current.push({ data: frameData, tsMs, type: 'delta' });
          // Cap well above max GOP (fps*2=120 frames) to prevent unbounded growth.
          if (gopBufferRef.current.length > 150) gopBufferRef.current.shift();
        }
        if (videoSessionRef.current !== session) break; // superseded by a newer subscribe — stop decoding
        shareAudioPlayerRef.current.video(callsign, tsMs); // S3: A/V delay estimate
        if (svStatusRef.current) svStatus(STREAM_STATUS.OK); // SV: frames are flowing again
        if (overlayActiveRef.current || stripViewerActiveRef.current /* SV */) {
          // Overlay owns the decode while it's open — see the relay below.
          // Reset the stall counters too: zero decode output here is expected
          // for as long as the overlay is up, not a sign of a broken stream.
          mainNeedsResync = true;
          framesRelayed = 0;
          framesDecoded = 0;
          stallWarned = false;
        } else if (!mainNeedsResync || frameType === 'key') {
          // Guard against the decoder falling behind (e.g. a weaker machine
          // that can't keep up with the incoming rate): check decodeQueueSize
          // before calling decoder.decode() on every arriving frame, so a
          // network burst releasing a backlog doesn't make the local decoder
          // try to chew through everything at once and pile extra CPU/GPU
          // load onto the exact machine that's already the bottleneck. Drop
          // non-keyframe frames when the queue is backed up instead, and
          // resync on the next keyframe — same pattern as mainNeedsResync's
          // existing overlay-handoff logic, and the same threshold as
          // OVERLAY_MAX_DECODE_QUEUE.
          if (frameType !== 'key' && decoder.decodeQueueSize > MAIN_MAX_DECODE_QUEUE) {
            mainNeedsResync = true;
            requestRemoteKeyframe('main decode queue overflow');
          } else if (ensureConfigured()) {
            mainNeedsResync = false;
            const timestampUs = tsMs * 1000;
            const chunk = new EncodedVideoChunk({ type: frameType, timestamp: timestampUs, data: frameData });
            if (decoder.state !== 'closed') {
              decodePendingRef.current.set(timestampUs, performance.now());
              if (!decodePending) { decodePending = true; progressTs = performance.now(); }
              try { decoder.decode(chunk); }
              catch (decErr) {
                traceLog(`[video-recover] decode() threw: ${decErr?.message || decErr}`);
                decoderBroken = true;
              }
            }
          }
        } else {
          // This window decodes and is dropping a delta while it waits for a
          // keyframe (first frames of a subscription, the overlay/strip just
          // handed the decode back, a key-recovery gap): ask for one. Throttled
          // — this branch runs for every dropped frame.
          requestRemoteKeyframe('main waiting for keyframe');
        }
        } // frameUsable
        const recvMs = performance.now() - recvStageStart;
        const stats = videoStageStatsRef.current;
        stats.recvCount += 1;
        stats.recvMs += recvMs;
        const nowPerf = performance.now();
        if (nowPerf - stats.lastLogTs >= 5000 && (stats.recvCount > 0 || stats.decodeCount > 0 || stats.drawCount > 0)) {
          const recvAvg = stats.recvCount > 0 ? (stats.recvMs / stats.recvCount).toFixed(2) : '0.00';
          const decodeAvg = stats.decodeCount > 0 ? (stats.decodeMs / stats.decodeCount).toFixed(2) : '0.00';
          const drawAvg = stats.drawCount > 0 ? (stats.drawMs / stats.drawCount).toFixed(2) : '0.00';
          console.log(`[video-stage] recv_avg=${recvAvg}ms decode_avg=${decodeAvg}ms draw_avg=${drawAvg}ms`);
          stats.recvCount = 0;
          stats.recvMs = 0;
          stats.decodeCount = 0;
          stats.decodeMs = 0;
          stats.drawCount = 0;
          stats.drawMs = 0;
          stats.lastLogTs = nowPerf;
        }
        buffer = buffer.slice(4 + frameSize);

        if (frameUsable) {
        // Relay raw H.264 NAL bytes to overlay for its own decoder — no extra
        // network cost, just local IPC. Overlay decodes at native stream quality.
        // On keyframes we re-send the header atomically (same .then() callback) so
        // the overlay decoder is always re-configured before the keyframe arrives,
        // eliminating the race condition where delta frames reach the overlay before
        // the header and leave decoderSyncedRef permanently false.
        if (stripViewerActiveRef.current && window.__TAURI__) {
          // SV: the strip's viewer owns this stream (it wins over the overlay).
          svFrame(session, frameType, tsMs, frameData, frameType === 'key' ? remoteStreamHeaderRef.current : null);
        } else if (overlayActiveRef.current && window.__TAURI__) {
          // Chunk size MUST be a multiple of 3 so each btoa() call produces no
          // padding characters.  If any chunk except the last ends with '=' or
          // '==', the concatenated string is invalid base64 and atob() in
          // Chromium truncates everything after the first '=', silently
          // discarding the rest of the keyframe and crashing the overlay decoder.
          // 6144 = 3 × 2048  →  exactly 8192 base64 chars, zero padding.
          let b64 = '';
          for (let i = 0; i < frameData.length; i += 6144)
            b64 += btoa(String.fromCharCode.apply(null, frameData.subarray(i, i + 6144)));
          const hdrForKey = frameType === 'key' ? remoteStreamHeaderRef.current : null;
          import('@tauri-apps/api/event').then(({ emit }) => {
            if (hdrForKey) emit('overlay-video-header', hdrForKey);
            emit('overlay-video-nal', { data: b64, type: frameType, timestamp_us: tsMs * 1000 });
          }).catch(() => {});
        }

        // Stall detection: if frames have been relayed but the decoder has
        // never produced output, something is wrong upstream. Skipped while the
        // overlay owns decoding — zero output here is expected in that case.
        framesRelayed++;
        statsRelayedWindow++;
        if (!overlayActiveRef.current && !stripViewerActiveRef.current /* SV */ && !stallWarned && framesRelayed === 30 && framesDecoded === 0) {
          stallWarned = true;
          const stallMsg = 'No video output after 30 frames — streamer may need to STOP and RESTART share.';
          addMsg(stallMsg, 'error');
          console.warn('[video] stall detected: relayed=', framesRelayed, 'decoded=', framesDecoded);
          traceLog(`[video] stall detected: relayed=${framesRelayed} decoded=${framesDecoded} decoderState=${decoder.state}`);
          if (window.__TAURI__) {
            import('@tauri-apps/api/event').then(({ emit }) => {
              emit('overlay-video-status', { message: 'No signal — streamer must restart share' });
            }).catch(() => {});
          }
        }
        } // frameUsable
      }
    } catch (err) {
      // Was a bare `catch {}` — 'eof' (deliberate, thrown above to break the
      // read loop on stream end) is the expected/silent case, but anything
      // else here is a real exception (decoder.decode() throwing on a
      // malformed chunk, a DataView range error, etc.) that was previously
      // discarded with zero trace anywhere — the stream would just silently
      // stop with no error and no diagnostic evidence of why.
      // 'eof' is the deliberate sentinel thrown above to break the read loop at
      // stream end. Switching watch targets is equally deliberate: subscribing
      // to a new sharer closes the previous transport, which surfaces here as a
      // WebTransportError. Both are routine, so neither should be logged as an
      // error — cycling sharers during a multi-stream test was filling the
      // console with red "read loop exited on exception" stack traces that
      // looked like crashes. Same guard the roster reader already uses, plus a
      // session check for the case where a newer subscribe superseded this one.
      const superseded = videoSessionRef.current !== session;
      if (err !== 'eof' && !superseded && !isExpectedTransportClose(err)) {
        console.error('[processVideoData] read loop exited on exception:', err);
        traceLog(`[video] read loop exited on exception: ${err?.message || err}`);
      }
    }
    if (decoder.state !== 'closed') decoder.close();
    decodePendingRef.current.clear();
    if (videoSessionRef.current === session) stopShareAudioPlayback(); // S3: stream over
    setRemoteShare(null);
  };

  const QUALITY_WINDOW_MS = 60_000;

  // Prunes drops older than the window and recomputes the exposed quality
  // tier. Called both on every new drop and on a periodic timer (see the
  // mount effect below) so quality recovers back to 'excellent' over time
  // even if nothing else happens to re-trigger the calculation.
  const recomputeConnectionQuality = () => {
    const now = Date.now();
    const recent = connectionDropTimestampsRef.current.filter(ts => now - ts <= QUALITY_WINDOW_MS);
    connectionDropTimestampsRef.current = recent;
    const quality = recent.length === 0 ? 'excellent' : recent.length === 1 ? 'good' : recent.length === 2 ? 'fair' : 'poor';
    setConnectionQuality(prev => (prev === quality ? prev : quality));
  };

  const recordConnectionDrop = () => {
    connectionDropTimestampsRef.current.push(Date.now());
    recomputeConnectionQuality();
    // Let an already-active share's existing congestion step-down react to
    // this immediately, not just the bitrate a future share picks.
    activeShareCongestionSignalRef.current?.();
  };

  // A share that starts (or restarts) shortly after connection instability
  // eases in at a reduced bitrate instead of immediately re-taxing a
  // connection that just proved shaky — the existing step-up-after-30s-
  // healthy logic further down in startScreenShare restores full quality
  // once things prove stable, same as it already does for mid-share
  // congestion. Wraps getAdaptiveStreamProfile (which only knows about org
  // tier / concurrent sharers) rather than changing it, since that function
  // is also called from places with no connection-quality context.
  const RECENT_INSTABILITY_BITRATE_CAP = 2_500_000;
  const getEffectiveStreamProfile = (orgTier, concurrentSharers) => {
    const profile = getAdaptiveStreamProfile(orgTier, concurrentSharers);
    if (connectionQuality === 'fair' || connectionQuality === 'poor') {
      return { ...profile, bitrate: Math.min(profile.bitrate, RECENT_INSTABILITY_BITRATE_CAP) };
    }
    return profile;
  };

  // Caps total automatic retries so a genuinely dead channel (deleted, token
  // permanently rejected, etc.) doesn't retry forever in the background —
  // after this many failures in a row the user has to manually rejoin.
  const MAX_AUTO_RECONNECT_ATTEMPTS = 8;

  const scheduleReconnect = () => {
    if (intentionalDisconnectRef.current) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= MAX_AUTO_RECONNECT_ATTEMPTS) {
      traceLog(`CommLink giving up auto-reconnect after ${attempt} attempts for channelRef.current.id=${channelRef.current?.id}`);
      addMsg('Reconnect failed repeatedly — rejoin the channel manually.', 'error');
      reportConnectIssue({ gaveUp: true }); // NET: "Voice can't connect" in the strip
      return;
    }
    // Exponential backoff with jitter, capped at 15s: fast enough to recover
    // from a brief blip, but won't hammer the server (or rack up a duplicate-
    // session/kill-signal cycle server-side) if the network is still down.
    const base = Math.min(1000 * 2 ** attempt, 15000);
    const delay = base + base * 0.3 * Math.random();
    reconnectAttemptRef.current = attempt + 1;
    traceLog(`CommLink scheduling reconnect attempt ${attempt + 1}/${MAX_AUTO_RECONNECT_ATTEMPTS} in ${Math.round(delay)}ms for channelRef.current.id=${channelRef.current?.id}`);
    addMsg(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_AUTO_RECONNECT_ATTEMPTS})...`, 'system');
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!intentionalDisconnectRef.current) connect();
    }, delay);
  };

  const monitorClosure = async (transport) => {
    try {
      await transport.closed;
      setStatus('disconnected');
      addMsg('Connection closed.', 'error');
    } catch (err) {
      setStatus('error');
      addMsg(`Connection lost: ${err.message}`, 'error');
    }
    // Always tear down share state when the connection closes unexpectedly.
    // Without this, isSharing stays true even though nothing is transmitting,
    // and the capture track is never released — preventing re-sharing the same source.
    // If we're about to auto-retry, keep the mic warm and skip the presence
    // leave ping too — a successful quick reconnect should look like nothing
    // happened, not a leave/rejoin flicker in the roster for everyone else.
    if (!intentionalDisconnectRef.current) recordConnectionDrop();
    const willRetry = !intentionalDisconnectRef.current && reconnectAttemptRef.current < MAX_AUTO_RECONNECT_ATTEMPTS;
    disconnect(willRetry, willRetry);
    scheduleReconnect();
  };

  const [isDucking, setIsDucking] = useState(false); // UI State for Active Ducking
  const [isMuted, setIsMuted] = useState(true);
  const [micError, setMicError] = useState(null);
  const [comsFilterEnabled, setComsFilterEnabled] = useState(localStorage.getItem('specter_audio_coms_filter') === 'true');
  // Engine phase 0: the mic level (every ~20 ms), the local speaking flag
  // and remote speakers' levels live in this mutable object, not in state —
  // as state they re-rendered CommLink and the whole hidden WarRoom up to
  // ~80×/s. WarRoom reads it through `levelsRef` (strip levels frame,
  // overlay feed); this component's own (legacy, dev-only) UI samples it at
  // 10 Hz only while the engine window is on screen (`uiVisible`).
  // See engine/voiceLevels.js.
  const [liveLevels] = useState(createLiveVoiceLevels);
  // Returns true when the speaking flag flipped.
  const setLiveLocalLevels = (localLevel, micRms, localSpeaking) => {
      const live = liveLevels;
      if (live.localLevel === localLevel && live.micRms === micRms && live.localSpeaking === localSpeaking) return false;
      const speakingChanged = live.localSpeaking !== localSpeaking;
      live.localLevel = localLevel;
      live.micRms = micRms;
      live.localSpeaking = localSpeaking;
      live.version++;
      if (speakingChanged) live.remoteVersion++;
      return speakingChanged;
  };
  useEffect(() => {
      if (!levelsRef) return undefined;
      levelsRef.current = liveLevels;
      return () => { if (levelsRef.current === liveLevels) levelsRef.current = null; };
  }, [levelsRef]);
  const shownLevels = useSampledVoiceLevels(() => liveLevels, uiVisible);
  const isSpeaking = shownLevels.localSpeaking;
  const micRms = shownLevels.micRms; // raw PCM RMS (0-32767ish scale) from the Rust capture callback
  // Rolling log of 'Speaking' events (not just the latest snapshot like
  // liveLevels.remoteLevels above) — feeds voice misconduct reports with a real,
  // server-computed "who was actually talking, and when" timeline. Bounded
  // to the same ~15-minute window as the native MisconductReportBuffer;
  // see submitVoiceReport below for how it's consumed.
  const speakingHistoryRef = useRef([]); // [{ callsign, level, ts }]
  const SPEAKING_HISTORY_WINDOW_MS = 15 * 60 * 1000;
  // Server mixer activation threshold (raw PCM RMS, same scale as micRms). Below this,
  // the mixer drops the sender's audio — this is what actually gates "do I get heard."
  const [micThreshold, setMicThreshold] = useState(() => {
    const stored = parseFloat(localStorage.getItem('specter_audio_threshold'));
    return Number.isFinite(stored) ? stored : 150;
  });

  // Text channel state
  const isTextChannel = channel.channel_kind === 1;
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [chatImageAttachment, setChatImageAttachment] = useState(null); // data URL or null
  const [chatAttachError, setChatAttachError] = useState(null);
  const chatFileInputRef = useRef(null);
  const [sourcePickerState, setSourcePickerState] = useState(null);
  const [usingTauriCapture, setUsingTauriCapture] = useState(false);
  const chatRelayRef = useRef(null);

  // Expose relay handler to parent (WarRoom) for SSE message_relay events
  useEffect(() => {
    if (onRelayRef) onRelayRef.current = (payload) => chatRelayRef.current?.(payload);
    return () => { if (onRelayRef) onRelayRef.current = null; };
  }, [onRelayRef]);

  // Authoritative "epoch changed" hook for WarRoom's global mls_commit SSE
  // handler, complementing the Join-triggered re-derive above — Join can
  // race ahead of the SSE delivery that actually applies the commit
  // locally, so whichever signal lands second just re-derives (a no-op if
  // the other already caught it).
  useEffect(() => {
    // E2EV: WarRoom has just applied the commit locally — re-export only.
    if (onMlsCommitRef) onMlsCommitRef.current = () => { refreshVideoKey(); refreshAudioKey({ sync: false }); };
    return () => { if (onMlsCommitRef) onMlsCommitRef.current = null; };
  }, [onMlsCommitRef]);

  // E2EV: event-group epoch changes (WarRoom's SSE handler applies the
  // event commit/Welcome, then notifyGroupKeyChange(eventId)) re-export the
  // cascade key — it used to be derived once at connect and never refreshed.
  useEffect(() => {
    const eventId = channel?.event_id;
    if (!eventId) return undefined;
    return onGroupKeyChange(eventId, () => {
      refreshCascadeKey({ sync: false });
      if (opVideoEventRef.current === eventId) refreshVideoKey({ sync: false }); // op-wide share key
    });
  }, [channel?.event_id]);

  // MR4: mlsSession reports every local epoch/membership change (a heal at
  // startup or from the "Resync encryption" button, a catch-up run by chat or
  // a monitor, an external join) — re-export at once instead of waiting for
  // frames to fail. Re-export only: mlsSession has already applied the
  // change. Same-key re-exports keep the installed instances (no churn).
  useEffect(() => {
    if (typeof mlsSession.onGroupStateChange !== 'function') return undefined;
    const unsub = mlsSession.onGroupStateChange((groupId, change) => {
      if (!groupId) return;
      // A member was removed: their frames must stop opening now, not after
      // the grace window. Frees the lanes' previous keys and makes the next
      // install of this group's key grace-less, whichever path installs it.
      // Op-wide share: while in a live op the video key is the event group's.
      const opVideo = opVideoEventRef.current;
      if (change?.removed) {
        if (groupId === channelRef.current?.id) noteGroupMemberRemoved(groupId, cryptoAudioRef, ...(opVideo ? [] : [cryptoRef]));
        else if (groupId === channelRef.current?.event_id || groupId === opVideo) {
          noteGroupMemberRemoved(groupId, cryptoAudioCascadeRef, ...(groupId === opVideo ? [cryptoRef] : []));
        }
      }
      if (intentionalDisconnectRef.current) return;
      if (groupId === channelRef.current?.id) {
        if (!opVideo) refreshVideoKey({ sync: false });
        refreshAudioKey({ sync: false }); // also re-exports the cascade lane
      } else if (groupId === channelRef.current?.event_id || groupId === opVideo) {
        if (groupId === opVideo) refreshVideoKey({ sync: false });
        refreshCascadeKey({ sync: false });
      }
    });
    return typeof unsub === 'function' ? unsub : undefined;
  }, []);

  // E2EV: surface the voice key / version-gate state (strip joined view).
  useEffect(() => {
    onE2eStateChange?.({
      keyState: voiceKeyReady ? 'ready' : 'waiting',
      error: voiceGateError,
      keyProblem: voiceKeyReady ? null : voiceKeyProblem,
    });
  }, [voiceKeyReady, voiceGateError, voiceKeyProblem, onE2eStateChange]);
  // NET: which port voice uses and any classified connect problem.
  useEffect(() => { onConnectStateChange?.(voiceConnect); }, [voiceConnect, onConnectStateChange]);
  useEffect(() => () => { onConnectStateChange?.(null); }, [onConnectStateChange]);
  useEffect(() => () => {
    const r = voiceKeyRetryRef.current;
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    onE2eStateChange?.(null);
    // MR4: free every key (and any grace-window previous key + its timer).
    clearRelayAudioPair(cryptoAudioRef, relayAudioTxRef);
    clearRelayAudioPair(cryptoAudioCascadeRef, relayAudioCascadeTxRef);
    cryptoRef.clear();
  }, []);
  
  const audioStreamRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const vadThresholdRef = useRef(parseFloat(localStorage.getItem('specter_vad_threshold') || '15'));

  // Native audio (Tauri) refs
  const audioUnlistenRef = useRef(null);
  const audioLevelUnlistenRef = useRef(null);
  const presenceHeartbeatRef = useRef(null);
  const micThresholdRef = useRef(micThreshold);
  useEffect(() => { micThresholdRef.current = micThreshold; }, [micThreshold]);
  const captureUnlistenRef = useRef(null);
  const captureWatchdogRef = useRef(null);
  // true when the server has confirmed ≥1 viewer is watching our stream.
  // false = keepalive mode: only 1 keyframe per 10 s is sent over the network.
  const captureActiveRef = useRef(false);
  // When activation fires mid-GOP (captureActive flips true), skip P-frames until
  // the next NVENC keyframe so the subscriber decoder always starts clean.
  const captureNeedsKeyframeRef = useRef(false);
  const lastKeyframeSentRef = useRef(0);
  const capturePreviewUnlistenRef = useRef(null);
  const capturePreviewCanvasRef = useRef(null);
  const stopShareInProgressRef = useRef(false);
  const stopScreenShareRef = useRef(null);       // latest stopScreenShare, for listeners created at share start
  const captureEndedUnlistenRef = useRef(null);  // 'specter://capture-ended' listener
  // Real-time bitrate adaptation state for the native capture path — see
  // startScreenShare. Null when not sharing / not applicable (browser fallback
  // uses VideoEncoder.configure() reconfiguration instead, no ref needed there).
  const adaptiveBitrateRef = useRef(null);
  // Proto AudioFrame.sequence for outgoing frames. Unauthenticated and
  // informational only; relay-mode nonces come from the RelayAudioSender's own
  // 64-bit counter, never from this (which restarts at 0 on every mount).
  const sequenceRef = useRef(0);
  // Playback backpressure guards for Tauri invoke bridge.
  const playFrameInFlightRef = useRef(0);
  const playFrameDroppedRef = useRef(0);
  const outputFallbackAttemptedRef = useRef(false);
  // Browser-path (non-Tauri) playback: one independent lane per incoming ssrc,
  // keyed by ssrc. Each lane owns its own Opus decoder (Opus decode
  // state is stream-specific — one decoder cannot safely interleave frames
  // from different senders), its own jitter queue + gapless-scheduling clock,
  // and its own GainNode for independent per-speaker volume/ducking — all N
  // lanes' GainNodes feed into the single shared duckingGainRef bus below, so
  // the existing radio-effect chain downstream of it is never duplicated.
  // In mixed-mode rooms (or the cross-channel priority broadcast path, which
  // always carries ssrc=0 regardless of mode) every frame arrives on ssrc=0,
  // which collapses this back to exactly one lane — identical to today's
  // single-stream behavior.
  //   Map<ssrc, { decoder, queue: AudioBuffer[], jitterActive, isDraining,
  //               nextPlayTime, gainNode }>
  const audioLanesRef = useRef(new Map());

  // Audio Mixer Refs
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const duckingGainRef = useRef(null);
  // Tracks the current channel volume for both Web Audio and Tauri paths.
  const channelVolumeRef = useRef(channelVolume);
  const cleanGainRef = useRef(null);
  const radioGainRef = useRef(null);
  const noiseGainRef = useRef(null);
  const duckingTimeoutRef = useRef(null);
  const isDuckingRef = useRef(false);

  // Generates a distortion curve for the military radio effect
  const makeDistortionCurve = (amount = 50) => {
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      let x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  };

  const initAudioCore = () => {
      if (!audioCtxRef.current) {
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          // Fix 1: force 48 kHz to match Opus encoding; avoids OS resampling artefacts.
          audioCtxRef.current = new AudioContext({ sampleRate: 48000 });
          
          masterGainRef.current = audioCtxRef.current.createGain();
          masterGainRef.current.gain.value = channelVolumeRef.current;
          duckingGainRef.current = audioCtxRef.current.createGain();
          cleanGainRef.current = audioCtxRef.current.createGain();
          radioGainRef.current = audioCtxRef.current.createGain();
          
          // Initial Route states
          cleanGainRef.current.gain.value = comsFilterEnabled ? 0.0 : 1.0;
          radioGainRef.current.gain.value = comsFilterEnabled ? 1.0 : 0.0;
          
          // Setup Radio Effect Chain
          // 1. Tighter Highpass to remove bass (gives exact tinny/nasal walkie-talkie feel)
          const hpf = audioCtxRef.current.createBiquadFilter();
          hpf.type = 'highpass';
          hpf.frequency.value = 600;

          // 2. WaveShaper for clipping/distortion (Clone Wars style heavy saturation)
          const distortion = audioCtxRef.current.createWaveShaper();
          distortion.curve = makeDistortionCurve(150); // Increased crunch
          distortion.oversample = '4x';
          
          // 3. Peaking filter to boost the mid-high range (adds the intercom "bite")
          const peak = audioCtxRef.current.createBiquadFilter();
          peak.type = 'peaking';
          peak.frequency.value = 1500;
          peak.gain.value = 10;
          
          // 4. Narrow Lowpass to cut off all high-end presence
          const lpf = audioCtxRef.current.createBiquadFilter();
          lpf.type = 'lowpass';
          lpf.frequency.value = 2000;
          
          // Background "Static/Hiss" Generator common in older analog channels
          const bufferSize = audioCtxRef.current.sampleRate * 2; // 2 seconds
          const noiseBuffer = audioCtxRef.current.createBuffer(1, bufferSize, audioCtxRef.current.sampleRate);
          const output = noiseBuffer.getChannelData(0);
          for (let i = 0; i < bufferSize; i++) {
              output[i] = Math.random() * 2 - 1; // White noise
          }
          const whiteNoiseSource = audioCtxRef.current.createBufferSource();
          whiteNoiseSource.buffer = noiseBuffer;
          whiteNoiseSource.loop = true;
          
          const staticFilter = audioCtxRef.current.createBiquadFilter();
          staticFilter.type = 'bandpass';
          staticFilter.frequency.value = 1200;
          staticFilter.Q.value = 1.0;
          
          const noiseGain = audioCtxRef.current.createGain();
          noiseGain.gain.value = 0; // Silent until audio is received
          noiseGainRef.current = noiseGain;
          
          whiteNoiseSource.connect(staticFilter);
          staticFilter.connect(noiseGain);
          noiseGain.connect(radioGainRef.current);
          whiteNoiseSource.start();

          hpf.connect(distortion);
          distortion.connect(peak);
          peak.connect(lpf);
          lpf.connect(radioGainRef.current);

          // Mixer Chain Main Source -> Ducking -> Master
          duckingGainRef.current.connect(masterGainRef.current);
          
          // Split from Master
          masterGainRef.current.connect(cleanGainRef.current);
          masterGainRef.current.connect(hpf); // Into radio chain
          
          // Re-merge at Destination
          cleanGainRef.current.connect(audioCtxRef.current.destination);
          radioGainRef.current.connect(audioCtxRef.current.destination);
          
          duckingGainRef.current.gain.value = 1.0;
          addMsg('Client Audio Mixer initialized with Coms Filter capacity.', 'system');
      }
  };

  // Listen for audio settings changes from SettingsUI and hot-swap the mic device
  useEffect(() => {
    const handleSettingsChange = (e) => {
      if (e.key === 'specter_audio_gain') {
        // Apply live gain change to the master output node
        const v = parseFloat(localStorage.getItem('specter_audio_gain') || '1.0');
        channelVolumeRef.current = v;
        if (masterGainRef.current && audioCtxRef.current) {
          masterGainRef.current.gain.setTargetAtTime(v, audioCtxRef.current.currentTime, 0.05);
        }
        return;
      }
      if (e.key === 'specter_audio_coms_filter') {
        const enabled = localStorage.getItem('specter_audio_coms_filter') === 'true';
        setComsFilterEnabled(enabled);
        return;
      }
      if (e.key === 'specter_vad_threshold') {
        vadThresholdRef.current = parseFloat(localStorage.getItem('specter_vad_threshold') || '15');
        return;
      }
      // Voice activation (mode / suppression / sensitivity / manual threshold /
      // PTT) changed — e.g. from the strip's Settings cabinet via the settings
      // bridge. Re-push to the native gate and the server mixer threshold.
      if (VAD_KEYS.includes(e.key)) {
        if (e.key === 'specter_audio_threshold') {
          const v = readManualThreshold();
          micThresholdRef.current = v;
          setMicThreshold(v);
        }
        sendAudioThresholdRef.current?.(serverThresholdFor());
        if (window.__TAURI__) {
          import('@tauri-apps/api/core').then(({ invoke }) => applyNativeVadConfig(invoke)).catch(() => {});
        }
        return;
      }
      if (e.key !== 'specter_audio_in' && e.key !== 'specter_audio_out') return;
      // If output device changed, switch playback to the new device
      if (e.key === 'specter_audio_out' && window.__TAURI__) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          const newDeviceId = localStorage.getItem('specter_audio_out');
          invoke('plugin:specter-audio|set_output_device', {
            deviceId: newDeviceId && newDeviceId !== 'default' ? newDeviceId : null,
          }).catch(err => console.error('[Audio] set_output_device failed:', err));
        });
        return;
      }
      // If mic is active, restart capture with the newly selected device
      if (!isMuted && window.__TAURI__) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          const newDeviceId = localStorage.getItem('specter_audio_in');
          invoke('plugin:specter-audio|stop_capture', {}).then(() => {
            invoke('plugin:specter-audio|start_capture', {
              deviceId: newDeviceId && newDeviceId !== 'default' ? newDeviceId : null,
            }).then(() => {
              addMsg('Audio input device switched.', 'system');
            }).catch(err => addMsg(`Device switch failed: ${err}`, 'error'));
          }).catch(() => {});
        });
      }
    };
    window.addEventListener('storage', handleSettingsChange);
    return () => window.removeEventListener('storage', handleSettingsChange);
  }, [isMuted]);

  // Toggle effect path safely
  useEffect(() => {
      if (cleanGainRef.current && radioGainRef.current) {
          cleanGainRef.current.gain.setTargetAtTime(comsFilterEnabled ? 0.0 : 1.0, audioCtxRef.current.currentTime, 0.05);
          radioGainRef.current.gain.setTargetAtTime(comsFilterEnabled ? 1.0 : 0.0, audioCtxRef.current.currentTime, 0.05);
      }
  }, [comsFilterEnabled]);

  // Sync channelVolume prop → ref + live gain node (allows WarRoom slider to drive volume in real-time)
  useEffect(() => {
    channelVolumeRef.current = channelVolume;
    if (masterGainRef.current && audioCtxRef.current) {
      masterGainRef.current.gain.setTargetAtTime(channelVolume, audioCtxRef.current.currentTime, 0.05);
    }
  }, [channelVolume]);

  const triggerDucking = () => {
      if (duckingGainRef.current && audioCtxRef.current) {
          const now = audioCtxRef.current.currentTime;
          // Only apply the gain transition once per duck onset — don't re-schedule
          // a new Web Audio automation segment on every incoming cascade frame
          // (called ~50/s in mixed mode). The timeout reset below still extends
          // the release window correctly regardless of this guard.
          if (!isDuckingRef.current) {
              duckingGainRef.current.gain.setTargetAtTime(0.1, now, 0.1);
          }
          isDuckingRef.current = true;
          setIsDucking(true);
          if (duckingTimeoutRef.current) clearTimeout(duckingTimeoutRef.current);
          duckingTimeoutRef.current = setTimeout(() => {
              const releaseNow = audioCtxRef.current.currentTime;
              duckingGainRef.current.gain.setTargetAtTime(1.0, releaseNow, 0.5);
              isDuckingRef.current = false;
              setIsDucking(false);
          }, 2000);
      }
  };

  // Lazily creates a lane's decoder + GainNode (feeding the shared ducking bus)
  // the first time a given ssrc is heard; returns the existing one otherwise.
  const getOrCreateAudioLane = async (ssrc) => {
    let lane = audioLanesRef.current.get(ssrc);
    if (lane) return lane;
    const { OpusDecoder } = await import('opus-decoder');
    const decoder = new OpusDecoder();
    await decoder.ready;
    const gainNode = audioCtxRef.current.createGain();
    // Start at the currently-active duck gain rather than always 1.0, so a
    // lane that first appears mid-duck (e.g. a new non-priority speaker keys
    // up while someone else is already the locked active speaker) doesn't
    // get a beat of full volume before the next Duck/DuckRelease transition
    // corrects it.
    const { active, activeSsrc, level } = duckStateRef.current;
    gainNode.gain.value = (active && ssrc !== activeSsrc) ? duckGainForLevel(level) : 1.0;
    gainNode.connect(duckingGainRef.current);
    lane = { decoder, gainNode, queue: [], jitterActive: false, isDraining: false, nextPlayTime: 0 };
    audioLanesRef.current.set(ssrc, lane);
    return lane;
  };

  // Disconnects and forgets a lane's GainNode/decoder/queue — called on full
  // disconnect for every lane heard this session (see disconnect()). As with
  // the Tauri native path's activeNativeLaneIdsRef, per-sender-leave/idle
  // cleanup (freeing a lane as soon as that speaker leaves, rather than
  // waiting for the whole channel to be left) is not yet implemented.
  const clearAudioLane = (ssrc, lane) => {
    try { lane.gainNode.disconnect(); } catch {}
    audioLanesRef.current.delete(ssrc);
  };

  // Drain one lane's pending AudioBuffers using gapless clock scheduling.
  const drainJitterQueue = (lane) => {
    if (lane.isDraining) return; // prevent re-entrant calls from the async datagram loop
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const LOOKAHEAD = 0.005;       // 5 ms minimum look-ahead
    const RESET_THRESHOLD = 0.15;  // 150 ms: if the clock has fallen this far behind, reset
    const now = ctx.currentTime;
    // Check for a transmission gap BEFORE draining. If the scheduled clock is stale,
    // discard all buffered frames and force re-pre-buffering on the next burst.
    // This prevents late frames from playing in the wrong time slot and avoids
    // running the drain loop with jitterActive=false mid-iteration.
    if (lane.nextPlayTime !== 0 && lane.nextPlayTime < now - RESET_THRESHOLD) {
      lane.nextPlayTime = 0;       // invalidate clock; will re-init from `now` on next drain
      lane.jitterActive = false;   // force re-pre-buffer on next transmission burst
      lane.queue = [];             // discard stale frames from before the gap
      return;
    }
    lane.isDraining = true;
    while (lane.queue.length > 0) {
      const audioBuffer = lane.queue.shift();
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(lane.gainNode);
      // If nextPlayTime is 0 (fresh start after a gap), anchor to now.
      const startTime = Math.max(lane.nextPlayTime || now, now + LOOKAHEAD);
      source.start(startTime);
      lane.nextPlayTime = startTime + audioBuffer.duration;
    }
    lane.isDraining = false;
  };

  const playOpusFrame = async (opusBytes, ssrc) => {
    if (!audioCtxRef.current) return;
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }
    let lane;
    try {
      lane = await getOrCreateAudioLane(ssrc);
    } catch (e) {
      console.warn('Failed to init opus-decoder:', e);
      return;
    }
    try {
      const { channelData, samplesDecoded, sampleRate } = lane.decoder.decodeFrame(opusBytes);
      if (!samplesDecoded) return;
      const audioBuffer = audioCtxRef.current.createBuffer(1, samplesDecoded, sampleRate || 48_000);
      audioBuffer.getChannelData(0).set(channelData[0]);

      // Fix 3: cap queue depth at 6 frames (120 ms) to prevent latency growth.
      if (lane.queue.length >= 6) lane.queue.shift();
      lane.queue.push(audioBuffer);

      // Fix 3: pre-buffer 3 frames (60 ms at 20 ms/frame) before starting playback to absorb initial jitter.
      if (!lane.jitterActive && lane.queue.length >= 3) {
        lane.jitterActive = true;
      }
      if (lane.jitterActive) {
        drainJitterQueue(lane);
      }
    } catch (_e) {
      // Silently skip malformed frames.
    }
  };

  const readDatagrams = async (transport) => {
    const reader = transport.datagrams.readable.getReader();
    let rxAudioCount = 0;
    let noKeyDropCount = 0;
    let staleDropCount = 0; // E2EV
    let failDropCount = 0;  // E2EV
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        // ── Control datagrams (0xFF prefix) ──────────────────────────────
        if (value.length >= 2 && value[0] === 0xFF) {
          const type = value[1];
          if (type === 0x01) {
            // SHARE_ANNOUNCE: [0xFF, 0x01, available, ...callsign_bytes]
            const available = value[2];
            const sharerCallsign = new TextDecoder().decode(value.slice(3));
            if (available === 1) {
              setAvailableSharers(prev => prev.includes(sharerCallsign) ? prev : [...prev, sharerCallsign]);
            } else {
              setAvailableSharers(prev => prev.filter(s => s !== sharerCallsign));
              setSharerHasAudio(sharerCallsign, false); // S2
              // If we were watching this sharer, clear watch state
              setWatchingSharer(prev => {
                if (prev === sharerCallsign) {
                  setIsWatching(false);
                  setRemoteShare(null);
                  return null;
                }
                return prev;
              });
            }
          } else if (type === 0x04) {
            // VIEWER_COUNT: [0xFF, 0x04, ...4B u32 BE]
            const count = new DataView(value.buffer, value.byteOffset + 2, 4).getUint32(0);
            setShareViewerCount(count);
          } else if (type === SHARE_AUDIO_STATE_CONTROL && value.length >= 4) {
            // S2 SHARE_AUDIO_STATE: [0xFF, 0x07, on, ...callsign_bytes]
            setSharerHasAudio(new TextDecoder().decode(value.slice(3)), value[2] === 1);
          }
          continue;
        }

        // ── Audio datagrams (proto3 AudioFrame) ──────────────────────────
        let frame;
        try {
          frame = decodeAudioFrameProto(value);
        } catch (parseErr) {
          console.warn('Failed to parse AudioFrame datagram', parseErr);
          continue;
        }

        if (!frame.opusBytes || frame.opusBytes.length === 0) continue;

        // Best-effort Ed25519 verification (see signBytes at the send site) —
        // signed over the still-encrypted payload, so this runs before decrypt.
        // Deliberately does NOT drop the frame on a missing/failed signature:
        // SFrame's AEAD already gives confidentiality+integrity against a
        // passive/compromised-but-not-actively-forging relay, so signing is
        // defense-in-depth, not the primary guarantee — failing open here
        // avoids breaking legitimate audio during a key-distribution race
        // (e.g. this sender's public key hasn't finished fetching yet) or for
        // a device that registered before this feature existed.
        if (voiceRelayModeRef.current && frame.senderSignature) {
          const senderUserId = ssrcToUserIdRef.current.get(frame.ssrc >>> 0);
          if (senderUserId) {
            try {
              const keys = await getSenderPublicKeys(senderUserId);
              const verified = keys.some(pk => verifySignature(pk, frame.opusBytes, frame.senderSignature));
              if (!verified && keys.length > 0) {
                console.warn('[Audio] signature verification failed for ssrc', frame.ssrc, '— playing anyway (defense-in-depth, not a hard gate)');
              }
            } catch (e) {
              console.warn('[Audio] signature verification error:', e);
            }
          }
        }

        // Mirror of the send-path's encrypt gate — see voiceRelayModeRef's doc
        // comment. A decrypt failure (wrong/stale key mid-rotation, or a stray
        // frame from before this session's key was ready) drops just this one
        // frame rather than feeding ciphertext to the Opus decoder as if it
        // were audio.
        // A cascade frame (priority speaker reaching a descendant channel) was
        // encrypted with the event-scoped cascade key, not this channel's own —
        // see cryptoAudioCascadeRef's doc comment and main.rs's relay-mode
        // cascade-forwarding block.
        //
        // Fail closed (see openAudioFrame): in relay mode a frame whose key
        // isn't derived yet is dropped too — previously it fell through and
        // the ciphertext was fed to the Opus decoder. In a mixed room an
        // ssrc≠0 frame can only be a relay-mode parent's encrypted cascade
        // copy, so it's dropped rather than decoded as Opus.
        {
          const opened = openAudioFrame(frame, {
            // E2EV: always relay — a plaintext (ssrc=0 mixed) frame is never played.
            relayMode: true,
            channelKey: cryptoAudioRef.current,
            cascadeKey: cryptoAudioCascadeRef.current,
            // MR4: each lane's previous key, during its rekey grace window.
            channelPrevKey: cryptoAudioRef.previous,
            cascadePrevKey: cryptoAudioCascadeRef.previous,
          });
          if (!opened.ok) {
            // Authenticated replay/duplicate (multi-path delivery, or a replay
            // attempt) — the wasm receiver's per-(ssrc, session) window
            // replaced the old unauthenticated (ssrc, proto sequence) dedup.
            if (opened.reason === DROP_REPLAY) continue;
            // E2EV: wire v3 skew rejection (replay into a restarted receiver,
            // or a sender whose clock is badly off) — rate-limited, not a
            // key problem.
            if (opened.reason === DROP_STALE) {
              if ((staleDropCount++ % 250) === 0) console.warn('[Audio] relay frame outside the ±30 s timestamp window dropped (replay, or a member\'s clock is wrong)');
              continue;
            }
            if (opened.reason === DROP_DECRYPT_FAILED) noteVoiceDecryptFailure(frame.isGlobalBroadcast);
            if (opened.reason === DROP_NO_KEY) {
              scheduleVoiceKeyRetry();
              if ((noKeyDropCount++ % 250) === 0) console.warn('[Audio] relay-mode key not ready, dropping frame');
            } else if (opened.error && (failDropCount++ % 250) === 0) {
              console.warn(`[Audio] relay frame dropped (${opened.reason}):`, opened.error);
            }
            continue;
          }
          noteVoiceDecryptSuccess(frame.isGlobalBroadcast);
          frame.opusBytes = opened.opusBytes;
        }

        // Duplicate suppression: relay mode — done above, authenticated, inside
        // openAudioFrame (DROP_REPLAY). Mixed mode — every frame is ssrc=0 (the
        // server mix, which may reuse sequence values), never deduplicated.
        if ((frame.ssrc >>> 0) === 0 && voiceRelayModeRef.current) {
          console.warn('[Audio] relay-mode frame arrived with ssrc=0 (frame is unattributed)');
        }

        // Mixed-mode cross-channel broadcast still ducks via this per-frame
        // heuristic (mixer_task is unchanged — see main.rs). Relay-mode rooms
        // use the precise RosterMessage::Duck/DuckRelease signal instead (see
        // duckStateRef); calling both would double-duck (this fires on every
        // cascade frame, not just the transition) and race two different
        // release timers against each other.
        if (frame.isGlobalBroadcast && !voiceRelayModeRef.current) triggerDucking();

        rxAudioCount++;
        if (rxAudioCount % 250 === 1) {
          console.log(`[Audio] received ${rxAudioCount} mixed frames from server`);
        }

        if (window.__TAURI__) {
          if (playFrameInFlightRef.current >= 4) {
            // Bound bridge backlog so an overloaded renderer cannot queue
            // unbounded play_frame invokes (which can destabilize the app).
            playFrameDroppedRef.current += 1;
            if (playFrameDroppedRef.current % 200 === 1) {
              console.warn('[Audio] dropping playback frame due to invoke backlog; dropped=', playFrameDroppedRef.current);
            }
            continue;
          }

          const b64 = btoa(String.fromCharCode(...frame.opusBytes));
          // Feed the native rolling misconduct-report buffer (see
          // web-portal/src-tauri/src/lib.rs's MisconductReportBuffer) — this
          // is the *mixed* stream actually being played (media-rust's mixer
          // always sends ssrc=0, see main.rs), same audio a report submits
          // via snip_report_clip. Fire-and-forget: a dropped frame here just
          // means a tiny gap in report evidence, never worth blocking or
          // retrying playback for.
          api.submitReportFrame(Date.now(), frame.ssrc >>> 0, b64);
          // Native path has no persistent per-lane gain node (play_frame takes
          // volume as a per-call argument, see lib.rs) — apply the duck
          // multiplier here instead, computed fresh per frame from
          // duckStateRef (see its doc comment / applyDuckStateToLanes, the
          // browser-path equivalent of this same state).
          const { active: duckActive, activeSsrc: duckActiveSsrc, level: duckLevel } = duckStateRef.current;
          const isDuckedLane = duckActive && (frame.ssrc >>> 0) !== duckActiveSsrc;
          const vol = channelVolumeRef.current * (isDuckedLane ? duckGainForLevel(duckLevel) : 1.0);
          // Composite id gives each sender their own native decoder+jitter queue —
          // the cpal output callback already sums every currently-registered
          // stream_id (see playback.rs), so this is all that's needed to play
          // multiple concurrent speakers correctly. In mixed-mode rooms every
          // packet is still ssrc=0, so this collapses back to one lane per
          // channel, identical to today's behavior.
          const laneStreamId = relayLaneStreamId(channelRef.current.id, frame.ssrc);
          activeNativeLaneIdsRef.current.add(laneStreamId);
          laneGainsRef.current.sync(laneStreamId, ssrcToUserIdRef.current.get(frame.ssrc >>> 0)); // PM
          playFrameInFlightRef.current += 1;
          ensureTauriInvoke().then(async (invoke) => {
            if (rxAudioCount % 100 === 0) {
              console.log('[Audio dbg] play_frame:', {
                opusLen: frame.opusBytes?.length,
                b64Len: b64.length,
                vol,
                streamId: laneStreamId,
              });
            }
            await invoke('plugin:specter-audio|play_frame', { data: b64, volume: vol, streamId: laneStreamId });
          }).catch(async (e) => {
            console.error('[Audio dbg] play_frame err:', e);
            const msg = String(e?.message || e || '');
            // One-shot safety fallback: if output device playback failed at runtime,
            // reset to system default and let subsequent frames recover.
            if (!outputFallbackAttemptedRef.current && /output|playback|device/i.test(msg)) {
              outputFallbackAttemptedRef.current = true;
              try {
                const invoke = await ensureTauriInvoke();
                await invoke('plugin:specter-audio|set_output_device', { deviceId: null });
                console.warn('[Audio] forced output fallback to system default after play_frame error');
              } catch (fallbackErr) {
                console.error('[Audio] output fallback failed:', fallbackErr);
              }
            }
          }).finally(() => {
            playFrameInFlightRef.current = Math.max(0, playFrameInFlightRef.current - 1);
          });
        } else {
          playOpusFrame(frame.opusBytes, frame.ssrc >>> 0);
        }
      }
    } catch (err) {
      if (transportRef.current !== transport || isExpectedTransportClose(err)) return;
      console.error('Reader error', err);
    }
  };

  const safeCloseWriter = (writer) => {
    if (!writer || typeof writer.close !== 'function') return;
    try {
      const maybePromise = writer.close();
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    } catch {}
  };

  const safeCloseTransport = (transport) => {
    if (!transport || typeof transport.close !== 'function') return;
    try { transport.close(); } catch {}
  };

  // keepMicWarm: used for a quick auto-reconnect retry (see monitorClosure) —
  // skips tearing down the native mic capture pipeline (cpal capture stays
  // running, audio-frame listener stays attached) so a brief drop doesn't
  // also cost a capture restart on top of the network reconnect. Safe to
  // leave running because the audio-frame handler already no-ops when
  // datagramWriterRef is null (see toggleMic's unmute listener) — frames
  // just resume flowing the instant the new transport's writer is set,
  // with no re-arm logic needed and no risk of isMuted/capture state
  // silently drifting apart the way it would if we stopped and forgot to
  // restart capture on reconnect.
  const disconnect = (skipPresence = false, keepMicWarm = false) => {
    traceLog(`CommLink disconnect() called for channelRef.current.id=${channelRef.current?.id}, hasTransport=${!!transportRef.current}, skipPresence=${skipPresence}, keepMicWarm=${keepMicWarm}`);
    connectGenRef.current++; // a connect still racing for a transport is now stale
    if (presenceHeartbeatRef.current) {
      clearInterval(presenceHeartbeatRef.current);
      presenceHeartbeatRef.current = null;
    }
    // Notify channel presence leave whenever we had an active transport
    if (!skipPresence && transportRef.current && org?.id && channelRef.current?.id) {
      api.leaveChannelPresence(org.id, channelRef.current.id).catch(() => {});
    }
    // Clean up screen share encoder + stream
    if (videoEncoderRef.current) {
      try { if (videoEncoderRef.current.state !== 'closed') videoEncoderRef.current.close(); } catch {}
      videoEncoderRef.current = null;
    }
    if (processorReaderRef.current) {
      try { processorReaderRef.current.cancel(); } catch {}
      processorReaderRef.current = null;
    }
    if (shareStreamRef.current) {
      safeCloseWriter(shareStreamRef.current);
      shareStreamRef.current = null;
    }
    if (shareTrackRef.current) {
      shareTrackRef.current.onended = null;
      shareTrackRef.current.stop();
      shareTrackRef.current = null;
    }
    if (captureWatchdogRef.current) {
      clearTimeout(captureWatchdogRef.current);
      captureWatchdogRef.current = null;
    }
    if (captureUnlistenRef.current) {
      captureUnlistenRef.current();
      captureUnlistenRef.current = null;
    }
    if (capturePreviewUnlistenRef.current) {
      capturePreviewUnlistenRef.current();
      capturePreviewUnlistenRef.current = null;
    }
    forceShareKeyframeRef.current = null;
    shareAudioCtxRef.current = null; // S2
    stopShareAudio();
    stopShareAudioPlayback();
    sharersWithAudioRef.current = [];
    setSharersWithAudio([]);
    if (window.__TAURI__) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('capture_stop').catch(() => {});
      });
    }
    if (adaptiveBitrateRef.current?.timer) clearInterval(adaptiveBitrateRef.current.timer);
    adaptiveBitrateRef.current = null;
    activeShareCongestionSignalRef.current = null;
    setIsSharing(false);
    setRemoteShare(null);
    setAvailableSharers([]);
    setWatchingSharer(null);
    setIsWatching(false);
    setShareViewerCount(0);

    if (datagramWriterRef.current) {
      safeCloseWriter(datagramWriterRef.current);
      datagramWriterRef.current = null;
    }
    if (transportRef.current) {
      safeCloseTransport(transportRef.current);
      transportRef.current = null;
    }
    if (videoTransportRef.current) {
      safeCloseTransport(videoTransportRef.current);
      videoTransportRef.current = null;
    }
    if (publishTransportRef.current) {
      safeCloseTransport(publishTransportRef.current);
      publishTransportRef.current = null;
    }
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    if (!keepMicWarm) {
      if (audioUnlistenRef.current) {
        audioUnlistenRef.current();
        audioUnlistenRef.current = null;
      }
      if (audioLevelUnlistenRef.current) {
        audioLevelUnlistenRef.current();
        audioLevelUnlistenRef.current = null;
      }
      if (window.__TAURI__) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('plugin:specter-audio|stop_capture', {}).catch(() => {});
        });
      }
    }
    if (window.__TAURI__) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        // Drop every native per-lane Opus decoder registered this session —
        // without this each one lives forever keyed by its composite stream_id,
        // and a much-later reconnect resumes decoding on a stale decoder
        // instead of a fresh one (see clear_stream doc comment in the Rust
        // plugin for the distortion failure mode). This is the
        // incoming-playback decoder, unrelated to keepMicWarm (which only
        // concerns our own outgoing mic capture), so it always runs.
        for (const laneId of activeNativeLaneIdsRef.current) {
          invoke('plugin:specter-audio|clear_stream', { streamId: laneId }).catch(() => {});
        }
        activeNativeLaneIdsRef.current.clear();
        laneGainsRef.current.reset(); // PM: next session's lanes re-send their gains
        // Legacy bare-channel-id form, harmless no-op once nothing is ever
        // registered under it, kept during rollout in case any lingering
        // mixed-mode session still used the old single-lane key.
        if (channelRef.current?.id) {
          invoke('plugin:specter-audio|clear_stream', { streamId: channelRef.current.id }).catch(() => {});
        }
      });
    }
    // Tear down every browser-path lane (decoder + GainNode + jitter state) so a
    // fresh connection starts clean, mirroring the native-path cleanup above.
    for (const [ssrc, lane] of audioLanesRef.current) {
      lane.decoder.free?.();
      clearAudioLane(ssrc, lane);
    }
  };

  // ── Lazy Screen Share: capture display but don't send until viewers subscribe ──

  const sendControlDatagram = (type, payload = []) => {
    if (!datagramWriterRef.current) return;
    const msg = new Uint8Array([0xFF, type, ...payload]);
    datagramWriterRef.current.write(msg).catch(() => {});
  };

  // SET_AUDIO_THRESHOLD (0x05): tells the server mixer the RMS level below which this
  // user's mic should be gated out of the room mix. `value` is the raw PCM RMS (u16 BE).
  const sendAudioThreshold = (value) => {
    const clamped = Math.max(0, Math.min(2000, Math.round(value)));
    sendControlDatagram(0x05, [(clamped >> 8) & 0xFF, clamped & 0xFF]);
  };
  // For the settings `storage` listener (subscribed once per mute state).
  const sendAudioThresholdRef = useRef(null);
  sendAudioThresholdRef.current = sendAudioThreshold;

  const handleMicThresholdChange = (value) => {
    setMicThreshold(value);
    localStorage.setItem('specter_audio_threshold', String(value));
    // Manual: this value, as before. Auto: 0 — the client gate decides.
    sendAudioThreshold(serverThresholdFor());
    // Keep the native capture plugin's own send-gate (which now decides whether a
    // window is transmitted at all, not just how the server mixer treats it — see
    // capture.rs's should_send) in sync with the same value. Best-effort: no native
    // plugin on the browser path, so a missing/failed invoke is expected there.
    if (window.__TAURI__) {
      ensureTauriInvoke()
        .then(invoke => invoke('plugin:specter-audio|set_send_threshold', { value }))
        .catch(() => {});
    }
  };

  // SET_LOCAL_MUTE (0x06): [muted(0/1), target_user_id_utf8...]. Listener-only
  // preference — the server mixer excludes the target from just this listener's
  // personal mix (see local_mutes in media-rust's RoomState/mixer_task); it has
  // no effect on what anyone else hears.
  const sendLocalMute = (targetUserId, muted) => {
    sendControlDatagram(0x06, [muted ? 1 : 0, ...new TextEncoder().encode(targetUserId)]);
  };

  // Diff the persisted local-mute set against what was last sent, so toggling
  // one user only sends one datagram rather than replaying the whole set.
  const prevLocalMutedRef = useRef(new Set());
  useEffect(() => {
    const next = localMutedUserIds || new Set();
    const prev = prevLocalMutedRef.current;
    for (const uid of next) if (!prev.has(uid)) sendLocalMute(uid, true);
    for (const uid of prev) if (!next.has(uid)) sendLocalMute(uid, false);
    prevLocalMutedRef.current = new Set(next);
  }, [localMutedUserIds]);

  // The server's local-mute state is per-session (room-scoped, in-memory) and
  // doesn't survive a reconnect — replay the full persisted set once connected
  // so a dropped/rejoined session doesn't silently start hearing muted users again.
  useEffect(() => {
    if (status === 'connected' && localMutedUserIds) {
      for (const uid of localMutedUserIds) sendLocalMute(uid, true);
    }
  }, [status]);

  const startEncodingPipeline = async (track, profileOverride = null, orgTier = 0) => {
    if (typeof VideoEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') return;

    // channelRef, not the `channel` prop — see channelRef's doc comment: the
    // two diverge after an admin Move, and the key this stream is encrypted
    // with is always derived from channelRef.
    const ticketData = await getMediaTicket('video_publish', null, channelRef.current.id);
    const base = (mediaUrlRef.current || ticketData.media_url).replace(/\/$/, '');
    const pubUrl = `${base}/specter/video?token=${ticketData.ticket}&channel_id=${channelRef.current.id}&role=publish`;
    const { transport: vt } = await createTransport(pubUrl, { label: 'publish', log: traceLog });
    publishTransportRef.current = vt;
    await vt.ready;

    // Keyframe on request (see keyframeRequest.js): the encode loop below makes
    // its next frame a keyframe while this is set. This path has no keepalive
    // gating, so of the server's signals only the keyframe request matters
    // (plus 0xAC: a first viewer arriving mid-GOP gets a keyframe at once).
    let forceNextKeyframe = false;
    const forceKeyframeOnRequest = createThrottledTrigger(() => { forceNextKeyframe = true; }, PUBLISHER_FORCE_INTERVAL_MS);
    const forceKeyframeOnCongestion = createThrottledTrigger(() => { forceNextKeyframe = true; }, PUBLISHER_CONGESTION_FORCE_INTERVAL_MS);
    forceShareKeyframeRef.current = forceKeyframeOnRequest;
    listenPublishSignals(vt, (bytes) => {
      if (bytes[0] === 0xAC || isKeyframeRequestSignal(bytes)) forceKeyframeOnRequest();
    });

    // Open uni stream to server for screen share relay
    const uniStream = await vt.createUnidirectionalStream();
    const writer = uniStream.getWriter();
    shareStreamRef.current = writer;

    await writer.write(new Uint8Array([0x02]));

    const settings = track.getSettings();
    // Browser `ideal` constraints on getDisplayMedia are non-binding — the track can
    // still come back at the display's native resolution. Cap what we actually encode
    // (and what the header advertises) at 1080p regardless of what the track reports.
    const { w, h } = capEncodeDims(settings.width || 1920, settings.height || 1080);
    const profile = capProfileResolution(profileOverride || STREAM_PROFILES[orgTier] || STREAM_PROFILES[0]);
    const codec = await probeVideoCodec(w, h, profile.fps);
    const user = JSON.parse(localStorage.getItem('specter_user') || '{}');
    // Latched for this publish stream — see STREAM_ENCRYPTION_FIELD.
    const streamEncrypted = !!cryptoRef.current;
    const header = JSON.stringify({
      codec, width: w, height: h,
      user_id: user.id || user.user_id || user.callsign || 'Unknown',
      [STREAM_ENCRYPTION_FIELD]: streamEncrypted,
    });
    const headerBytes = new TextEncoder().encode(header);
    const hlenBuf = new ArrayBuffer(4);
    new DataView(hlenBuf).setUint32(0, headerBytes.length);
    await writer.write(new Uint8Array(hlenBuf));
    await writer.write(headerBytes);

    const writerRef = { current: writer };
    // Assigned below, after the adaptive controller is set up — the encoder's
    // output callback is a closure only invoked once encoding is actually
    // underway, well after this synchronous setup finishes.
    let submitVideoFrame;
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const rawData = new Uint8Array(chunk.byteLength);
        chunk.copyTo(rawData);
        // Encrypt with this channel's MLS-derived key (see cryptoRef/refreshVideoKey
        // above) — media-rust relays this payload opaquely, never decoding it, so
        // this is the only place plaintext video ever exists off-device.
        let data = rawData;
        if (streamEncrypted) {
          try {
            data = cryptoRef.current.encrypt(rawData);
          } catch (err) {
            // Drop, never downgrade. This stream's header declares it
            // encrypted, so emitting a plaintext frame would both contradict
            // that declaration (the receiver would try to decrypt plaintext and
            // drop the whole GOP) and push unencrypted screen content through
            // the relay on a channel the user was told is end-to-end encrypted.
            console.warn('[share] video frame encryption failed, dropping frame:', err);
            return;
          }
        }
        const frameSize = 1 + 4 + data.length;
        const frameBuf = new ArrayBuffer(4 + frameSize);
        const v = new DataView(frameBuf);
        v.setUint32(0, frameSize);
        v.setUint8(4, chunk.type === 'key' ? 0 : 1);
        v.setUint32(5, Math.floor(chunk.timestamp / 1000) >>> 0);
        new Uint8Array(frameBuf, 9).set(data);
        submitVideoFrame(new Uint8Array(frameBuf), chunk.type === 'key');
      },
      error: (e) => console.error('VideoEncoder error:', e),
    });
    // Force Annex-B output for H.264 so that the subscriber decoder (no
    // description provided) receives bytestream-format NAL units as expected.
    const encoderConfig = { codec, width: w, height: h, bitrate: profile.bitrate, framerate: profile.fps };
    if (codec.startsWith('avc1') || codec.startsWith('avc3')) {
      encoderConfig.avc = { format: 'annexb' };
    }
    encoder.configure(encoderConfig);
    videoEncoderRef.current = encoder;

    // ── Real-time bitrate adaptation ────────────────────────────────────────
    // Lighter-weight than the native path's capture-restart approach (see
    // startScreenShare) — WebCodecs supports reconfiguring an already-open
    // VideoEncoder's bitrate directly, no restart needed. Same step-down/
    // step-up policy: step down under sustained send-queue congestion, step
    // back up after a sustained healthy period, capped at the profile target.
    const ADAPT_STEP_FACTOR = 0.65;
    const ADAPT_MIN_BITRATE = 1_500_000;
    const ADAPT_STEPDOWN_COOLDOWN_MS = 15_000;
    const ADAPT_STEPUP_HEALTHY_MS = 30_000;
    const ADAPT_DROP_TRIGGER_COUNT = 5;

    let currentBitrate = profile.bitrate;
    let dropsInWindow = 0;
    let lastDropAt = 0;
    let lastStepAt = 0;

    const reconfigureBitrate = (newBitrate, reason) => {
      if (encoder.state === 'closed') return;
      currentBitrate = newBitrate;
      lastStepAt = Date.now();
      try {
        encoder.configure({ ...encoderConfig, bitrate: newBitrate });
        addMsg(`Adjusted share bitrate to ${(newBitrate / 1_000_000).toFixed(1)} Mbps (${reason}).`, 'system');
      } catch (e) {
        console.error('[share] VideoEncoder bitrate reconfigure failed:', e);
      }
    };

    const adaptTimer = setInterval(() => {
      if (encoder.state === 'closed') { clearInterval(adaptTimer); return; }
      if (currentBitrate >= profile.bitrate) return;
      const now = Date.now();
      if (now - lastDropAt < ADAPT_STEPUP_HEALTHY_MS) return;
      if (now - lastStepAt < ADAPT_STEPDOWN_COOLDOWN_MS) return;
      reconfigureBitrate(Math.min(profile.bitrate, Math.round(currentBitrate / ADAPT_STEP_FACTOR)), 'connection recovered');
    }, 5000);

    const onVideoFrameDropped = () => {
      lastDropAt = Date.now();
      dropsInWindow += 1;
      if (dropsInWindow >= ADAPT_DROP_TRIGGER_COUNT) {
        dropsInWindow = 0;
        if (Date.now() - lastStepAt >= ADAPT_STEPDOWN_COOLDOWN_MS && currentBitrate > ADAPT_MIN_BITRATE) {
          reconfigureBitrate(Math.max(ADAPT_MIN_BITRATE, Math.round(currentBitrate * ADAPT_STEP_FACTOR)), 'congestion detected');
        }
      }
    };
    // Let a connection-level drop (see recordConnectionDrop) nudge this
    // share's own step-down immediately instead of only affecting the next
    // share's starting bitrate.
    activeShareCongestionSignalRef.current = onVideoFrameDropped;

    submitVideoFrame = createVideoSendPump(writerRef, onVideoFrameDropped, () => forceKeyframeOnCongestion());

    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    processorReaderRef.current = reader;
    (async () => {
      let fc = 0;
      try {
        while (true) {
          const { value: frame, done } = await reader.read();
          if (done) break;
          if (encoder.state === 'closed') { frame.close(); break; }
          const gop = Math.max(24, profile.fps * 2);
          // A requested keyframe (forceNextKeyframe) counts as a keyframe slot:
          // never dropped below, and encoded with { keyFrame: true }.
          const isKeyframeSlot = fc % gop === 0 || forceNextKeyframe;
          forceNextKeyframe = false;
          // Encoder falling behind (e.g. weak CPU on the software-encode fallback
          // path) — its own internal queue would otherwise grow unboundedly since
          // encode() is normally called unconditionally every captured frame.
          // Drop non-keyframe frames rather than let latency pile up; still enqueue
          // scheduled keyframes so the stream can resync.
          if (encoder.encodeQueueSize > 2 && !isKeyframeSlot) {
            frame.close();
            fc++;
            continue;
          }
          encoder.encode(frame, { keyFrame: isKeyframeSlot });
          frame.close();
          fc++;
        }
      } catch {}
    })();
  };

  const stopEncodingPipeline = () => {
    if (processorReaderRef.current) {
      try { processorReaderRef.current.cancel(); } catch {}
      processorReaderRef.current = null;
    }
    if (videoEncoderRef.current) {
      try { if (videoEncoderRef.current.state !== 'closed') videoEncoderRef.current.close(); } catch {}
      videoEncoderRef.current = null;
    }
    if (shareStreamRef.current) {
      safeCloseWriter(shareStreamRef.current);
      shareStreamRef.current = null;
    }
    if (publishTransportRef.current) {
      safeCloseTransport(publishTransportRef.current);
      publishTransportRef.current = null;
    }
  };

  // opts.presetSource ({ id, name }): a source already picked elsewhere (the
  // tray strip's picker, over the engine bridge — P2A), so the in-window
  // picker is skipped. Without it (or when called as a click handler, which
  // passes an event) the picker opens as before. Resolves to { ok, error? }
  // so the bridge can report the outcome; existing callers ignore it.
  const startScreenShare = async (opts) => {
    const presetSource = opts && typeof opts === 'object' && opts.presetSource?.id ? opts.presetSource : null;
    if (isSharing) { stopScreenShare(); return { ok: false, error: 'Already sharing' }; }
    const isTauriWindows = window.__TAURI__ && navigator.userAgent.toLowerCase().includes('windows');
    // Browser getDisplayMedia on Tauri shows a system "tauri.localhost is sharing"
    // banner. Keep native capture as the default and allow browser fallback only
    // when explicitly requested via localStorage for troubleshooting.
    const forceBrowserCaptureOnWindows = isTauriWindows && localStorage.getItem('specter_capture_mode') === 'browser-fallback';
    if (presetSource && !(isTauriWindows && !forceBrowserCaptureOnWindows)) {
      return { ok: false, error: 'Native screen capture is off on this device' };
    }
    if (isTauriWindows && !forceBrowserCaptureOnWindows) {
      try {
        const orgTier = org?.tier ?? 0;
        const concurrentSharers = Math.max(1, (availableSharersRef.current?.length || 0) + 1);
        const profile = getEffectiveStreamProfile(orgTier, concurrentSharers);

        let selectedSource = presetSource;
        if (!selectedSource) {
          // Enumerate sources (monitors + windows) and show picker
          addMsg('Enumerating capture sources…', 'system');
          const sources = await window.__TAURI__.core.invoke('capture_list_sources');
          if (!sources || sources.length === 0) {
            addMsg('No capture sources found.', 'error');
            return { ok: false, error: 'No capture sources found.' };
          }
          selectedSource = await new Promise(resolve => {
            setSourcePickerState({ sources, resolve });
          });
          if (!selectedSource) return { ok: false, cancelled: true }; // user cancelled
        }

        const effectiveSource = selectedSource;

        // channelRef, not the `channel` prop — see channelRef's doc comment.
        const ticketData = await getMediaTicket('video_publish', null, channelRef.current.id);
        const base = (mediaUrlRef.current || ticketData.media_url).replace(/\/$/, '');
        const pubUrl = `${base}/specter/video?token=${ticketData.ticket}&channel_id=${channelRef.current.id}&role=publish`;
        console.log('[share] publish transport connecting, base=', base);
        const { transport: vt } = await createTransport(pubUrl, { label: 'publish', log: traceLog });
        publishTransportRef.current = vt;
        shareAudioServerOkRef.current = false; // S2: until this session's server says so
        shareAudioServerDgramOkRef.current = false;
        await vt.ready;
        console.log('[share] publish transport ready');
        // S2: share-audio datagrams on this session. Bounded so a backed-up
        // queue drops stale audio instead of sending it late.
        try {
          vt.datagrams.outgoingMaxAge = SHARE_AUDIO_DATAGRAM_MAX_AGE_MS;
          vt.datagrams.outgoingHighWaterMark = SHARE_AUDIO_DATAGRAM_HIGH_WATER_MARK;
        } catch { /* older runtime: defaults */ }
        let shareDgramWriter;
        const getShareDgramWriter = () => {
          if (publishTransportRef.current !== vt) return null;
          if (shareDgramWriter === undefined) {
            try { shareDgramWriter = vt.datagrams.writable.getWriter(); } catch { shareDgramWriter = null; }
          }
          return shareDgramWriter;
        };

        // Keyframe on request: the native encoder makes its next frame an IDR
        // (capture_request_keyframe). Viewer requests (relayed and already
        // coalesced by media-rust) and my own send pump's congestion drops are
        // throttled separately — see keyframeRequest.js for the intervals.
        const forceNativeKeyframe = () => { window.__TAURI__.core.invoke('capture_request_keyframe').catch(() => {}); };
        const forceKeyframeOnRequest = createThrottledTrigger(forceNativeKeyframe, PUBLISHER_FORCE_INTERVAL_MS);
        const forceKeyframeOnCongestion = createThrottledTrigger(forceNativeKeyframe, PUBLISHER_CONGESTION_FORCE_INTERVAL_MS);
        forceShareKeyframeRef.current = forceKeyframeOnRequest;

        // Listen for signals from the server on the publish transport.
        // 0xAC = a viewer subscribed (go live), 0xDE = last viewer left (keepalive mode),
        // KEYFRAME_REQUEST_BYTE = a viewer needs a keyframe now.
        captureActiveRef.current = false;
        lastKeyframeSentRef.current = 0;
        listenPublishSignals(vt, (bytes) => {
          if (bytes[0] === 0xAC) {
            captureActiveRef.current = true;
            captureNeedsKeyframeRef.current = true;
            // Going live mid-GOP: the NAL listener holds deltas back until a
            // keyframe — make that the next frame instead of up to 2 s away.
            forceKeyframeOnRequest('activated');
            console.log('[share] activated by viewer');
          } else if (bytes[0] === 0xDE) { captureActiveRef.current = false; console.log('[share] deactivated — no viewers'); }
          else if (isKeyframeRequestSignal(bytes)) forceKeyframeOnRequest('viewer request');
          else if (isShareAudioCapableSignal(bytes) && publishTransportRef.current === vt) shareAudioServerOkRef.current = true; // S2
          else if (isShareAudioDgramCapableSignal(bytes) && publishTransportRef.current === vt) shareAudioServerDgramOkRef.current = true; // S2
        });

        const uniStream = await vt.createUnidirectionalStream();
        const writer = uniStream.getWriter();
        shareStreamRef.current = writer;
        await writer.write(new Uint8Array([0x02]));
        const user = JSON.parse(localStorage.getItem('specter_user') || '{}');
        // probeVideoCodec returns the best hardware-accelerated H.264 codec string the
        // viewer's browser supports (avc1.640033 = High Profile L5.1 on modern drivers);
        // this must match what NVENC/AMF actually encode (High Profile).
        const tauriCodec = await probeVideoCodec(profile.width, profile.height, profile.fps);
        console.log('[share] probeVideoCodec result:', tauriCodec, 'profile=', profile, 'concurrentSharers=', concurrentSharers);
        // Latched for this publish stream — see STREAM_ENCRYPTION_FIELD.
        const streamEncrypted = !!cryptoRef.current;
        // The header must advertise the size the encoder REALLY produces, and
        // only the encoder knows it (enc_dims picks it from the source — e.g.
        // 2714×762 for a 5120×1440 window — and the profile's 1920×1080 was
        // wrong for every non-16:9 source). So it is written from the first
        // keyframe's SPS (engine/h264Sps.js), just before that keyframe, and
        // nothing else goes on the stream before it. The profile size is
        // only the fallback for an SPS that won't parse. media-rust reads the
        // header without a deadline and registers the sharer once it has it.
        const tauriHeader = {
          codec: tauriCodec, width: profile.width, height: profile.height,
          user_id: user.id || user.user_id || user.callsign || 'Unknown',
          stream_type: 'full',
          [STREAM_ENCRYPTION_FIELD]: streamEncrypted,
        };
        // Store codec/dims so the overlay VideoDecoder can be seeded if self-view
        // is selected after capture is already running (real dims once known).
        captureHeaderRef.current = { codec: tauriHeader.codec, width: tauriHeader.width, height: tauriHeader.height };
        let shareHeaderSent = false;
        const writeShareHeader = (firstKeyframe) => {
          if (shareHeaderSent) return;
          shareHeaderSent = true;
          const dims = spsDimsFromAnnexB(firstKeyframe);
          if (dims) { tauriHeader.width = dims.width; tauriHeader.height = dims.height; }
          captureHeaderRef.current = { codec: tauriHeader.codec, width: tauriHeader.width, height: tauriHeader.height };
          const headerBytes = new TextEncoder().encode(JSON.stringify(tauriHeader));
          const hlenBuf = new ArrayBuffer(4);
          new DataView(hlenBuf).setUint32(0, headerBytes.length);
          // Not awaited: the writer queues writes in order, and every frame
          // write (the send pump) is issued after these two.
          writer.write(new Uint8Array(hlenBuf)).catch(() => {});
          writer.write(headerBytes).catch(() => {});
          console.log('[share] header written to server:', JSON.stringify(tauriHeader));
          traceLog(`[share] stream header ${tauriHeader.codec} ${tauriHeader.width}x${tauriHeader.height} (${dims ? 'from SPS' : `SPS unreadable, profile ${profile.width}x${profile.height}`})`);
        };

        console.log('[share] calling capture_start...');
        await window.__TAURI__.core.invoke('capture_start', {
          // Flat profile.bitrate for the hard-capped 1080p output resolution — not
          // scaled up for high-res source monitors (e.g. 4K), since the encode
          // target is downscaled to the same 1080p either way and a weak
          // connection on a 4K monitor shouldn't pay extra bits for zero extra
          // quality. Native capture is always at the monitor's full resolution
          // (DXGI/WGC don't support a lower-res request) — enc_dims() on the Rust
          // side downscales (height cap + pixel budget + width ceiling, aspect
          // kept — see engine/captureLimits.js) via GPU VideoProcessorBlt
          // before NVENC/AMF sees it.
          config: {
            source_id: effectiveSource.id,
            fps: profile.fps,
            bitrate: profile.bitrate,
            ...nativeCaptureLimits(profile),
          },
        });

        console.log('[share] capture_start succeeded');

        // ── Real-time bitrate adaptation ────────────────────────────────────────
        // Bitrate/resolution aren't just picked once from the static tier table
        // and left alone for the rest of the call — a connection that can't
        // sustain the tier's bitrate would stay stuck oversending for the whole
        // session otherwise. This steps bitrate down under sustained congestion
        // (signalled by the send pump's onDrop below) and back up after a
        // sustained healthy period, capped at the profile's original target.
        //
        // No dynamic NVENC bitrate reconfiguration is exposed through this
        // codebase's FFmpeg bindings, so a "step" is a full capture_stop +
        // capture_start with an updated bitrate — a brief (~100-300ms) gap in
        // NALs. The existing keyframe-resync logic (captureNeedsKeyframeRef /
        // needs_resync throughout the pipeline) already handles a gap like this
        // cleanly, same as any other transient stall.
        const ADAPT_STEP_FACTOR = 0.65;
        const ADAPT_MIN_BITRATE = 1_500_000;
        const ADAPT_STEPDOWN_COOLDOWN_MS = 15_000;
        const ADAPT_STEPUP_HEALTHY_MS = 30_000;
        const ADAPT_DROP_TRIGGER_COUNT = 5;

        const restartCaptureWithBitrate = async (newBitrate, reason) => {
          const st = adaptiveBitrateRef.current;
          if (!st || st.restarting || stopShareInProgressRef.current) return;
          st.restarting = true;
          st.lastStepAt = Date.now();
          try {
            await window.__TAURI__.core.invoke('capture_stop');
            await window.__TAURI__.core.invoke('capture_start', {
              config: { source_id: effectiveSource.id, fps: profile.fps, bitrate: newBitrate, ...nativeCaptureLimits(profile) },
            });
            st.currentBitrate = newBitrate;
            captureNeedsKeyframeRef.current = true;
            addMsg(`Adjusted share bitrate to ${(newBitrate / 1_000_000).toFixed(1)} Mbps (${reason}).`, 'system');
          } catch (e) {
            console.error('[share] adaptive bitrate restart failed:', e);
          } finally {
            st.restarting = false;
          }
        };

        adaptiveBitrateRef.current = {
          targetBitrate: profile.bitrate,
          currentBitrate: profile.bitrate,
          dropsInWindow: 0,
          lastDropAt: 0,
          lastStepAt: 0,
          restarting: false,
          timer: setInterval(() => {
            const st = adaptiveBitrateRef.current;
            if (!st || st.restarting || st.currentBitrate >= st.targetBitrate) return;
            const now = Date.now();
            if (now - st.lastDropAt < ADAPT_STEPUP_HEALTHY_MS) return;
            if (now - st.lastStepAt < ADAPT_STEPDOWN_COOLDOWN_MS) return;
            const newBitrate = Math.min(st.targetBitrate, Math.round(st.currentBitrate / ADAPT_STEP_FACTOR));
            restartCaptureWithBitrate(newBitrate, 'connection recovered');
          }, 5000),
        };

        const onVideoFrameDropped = () => {
          const st = adaptiveBitrateRef.current;
          if (!st) return;
          st.lastDropAt = Date.now();
          st.dropsInWindow += 1;
          if (st.dropsInWindow >= ADAPT_DROP_TRIGGER_COUNT) {
            st.dropsInWindow = 0;
            if (!st.restarting && Date.now() - st.lastStepAt >= ADAPT_STEPDOWN_COOLDOWN_MS && st.currentBitrate > ADAPT_MIN_BITRATE) {
              const newBitrate = Math.max(ADAPT_MIN_BITRATE, Math.round(st.currentBitrate * ADAPT_STEP_FACTOR));
              restartCaptureWithBitrate(newBitrate, 'congestion detected');
            }
          }
        };
        // Let a connection-level drop (see recordConnectionDrop) nudge this
        // share's own step-down immediately instead of only affecting the
        // next share's starting bitrate.
        activeShareCongestionSignalRef.current = onVideoFrameDropped;

        // Poll capture_get_errors once to surface any silent failures from the
        // capture thread (e.g. D3D11VA av_hwframe_ctx_init failure).  The thread
        // may have already exited by now; read the log before starting the NAL
        // listener so the user sees a clear error instead of a stuck "sharing" UI.
        try {
          const captureErrors = await window.__TAURI__.core.invoke('capture_get_errors');
          if (captureErrors && captureErrors.trim().length > 0) {
            console.error('[share] capture thread reported errors:\n', captureErrors);
            addMsg(`Screen capture failed: ${captureErrors.trim()}`, 'error');
            // Clean up: close the transport and reset sharing state
            if (shareStreamRef.current) { safeCloseWriter(shareStreamRef.current); shareStreamRef.current = null; }
            if (publishTransportRef.current) { safeCloseTransport(publishTransportRef.current); publishTransportRef.current = null; }
            setIsSharing(false);
            isSharingRef.current = false;
            return { ok: false, error: `Screen capture failed: ${captureErrors.trim()}` };
          }
        } catch {}

        // Delayed watchdog: capture failures (D3D11VA, DXGI init, etc.) happen
        // asynchronously after capture_start returns. If no NAL arrives in 5 s,
        // the capture thread failed — read the error log and clean up.
        captureWatchdogRef.current = setTimeout(async () => {
          captureWatchdogRef.current = null;
          try {
            const lateErrors = await window.__TAURI__.core.invoke('capture_get_errors');
            const errMsg = (lateErrors && lateErrors.trim().length > 0)
              ? `Screen capture failed: ${lateErrors.trim()}`
              : 'Screen capture timed out — no video received. If you selected a window, try selecting your monitor instead.';
            console.error('[share] watchdog fired (no NAL in 5s):', errMsg);
            addMsg(errMsg, 'error');
            if (captureUnlistenRef.current) { captureUnlistenRef.current(); captureUnlistenRef.current = null; }
            shareAudioCtxRef.current = null; // S2
            stopShareAudio();
            if (shareStreamRef.current) { safeCloseWriter(shareStreamRef.current); shareStreamRef.current = null; }
            if (publishTransportRef.current) { safeCloseTransport(publishTransportRef.current); publishTransportRef.current = null; }
            setIsSharing(false);
            isSharingRef.current = false;
            try { await window.__TAURI__.core.invoke('capture_stop'); } catch {}
          } catch {}
        }, 5000);

        const { listen } = await import('@tauri-apps/api/event');

        // Listen for NAL units → wire format → writer (and overlay self-view relay)
        let _nalLoggedOnce = false;
        const submitVideoFrame = createVideoSendPump(shareStreamRef, onVideoFrameDropped, () => forceKeyframeOnCongestion('send backpressure'));
        const unlistenNal = await listen('specter://capture-nal', async (event) => {
          const { data_b64, is_keyframe, timestamp_ms } = event.payload;
          // Nothing may precede the header on the stream, and the header
          // comes from the first keyframe (see writeShareHeader). The encoder
          // always opens with an IDR, so this drops nothing in practice.
          let nalData = null;
          const nalBytes = () => {
            if (!nalData) {
              const bin = atob(data_b64);
              nalData = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) nalData[i] = bin.charCodeAt(i);
            }
            return nalData;
          };
          if (!shareHeaderSent) {
            if (!is_keyframe) return;
            writeShareHeader(nalBytes());
          }
          if (!_nalLoggedOnce && is_keyframe) {
            _nalLoggedOnce = true;
            if (captureWatchdogRef.current) { clearTimeout(captureWatchdogRef.current); captureWatchdogRef.current = null; }
            console.log('[share] first keyframe NAL arrived, bytes=', nalBytes().length, 'captureActive=', captureActiveRef.current);
          }

          // Self-view must stay low-latency even when there are no remote viewers.
          // Relay to overlay BEFORE network keepalive gating so local preview never
          // waits for the 10s keyframe throttle.
          if (stripViewerActiveRef.current && overlayWantsSelfViewRef.current && window.__TAURI__) {
            // SV: self-view in the strip's viewer (capture NALs are plaintext
            // local frames — never encrypted, never left this device).
            svFrame('self', is_keyframe ? 'key' : 'delta', timestamp_ms, data_b64, captureHeaderRef.current);
          } else if (overlayActiveRef.current && overlayWantsSelfViewRef.current && window.__TAURI__) {
            const selfHdr = is_keyframe ? captureHeaderRef.current : null;
            import('@tauri-apps/api/event').then(({ emit: emitEv }) => {
              if (selfHdr) emitEv('overlay-video-header', selfHdr);
              emitEv('overlay-video-nal', { data: data_b64, type: is_keyframe ? 'key' : 'delta', timestamp_us: timestamp_ms * 1000 });
            }).catch(() => {});
          }

          // Keepalive mode: no active viewers — only forward one keyframe per 10 s
          // so the server has a sync point ready for when a viewer connects.
          if (!captureActiveRef.current) {
            if (!is_keyframe) return;
            const now = Date.now();
            if (now - lastKeyframeSentRef.current < 10_000) return;
            lastKeyframeSentRef.current = now;
          } else if (captureNeedsKeyframeRef.current) {
            // Activation fired mid-GOP: skip P-frames until the next clean keyframe
            // so the subscriber decoder always gets a complete reference chain.
            if (!is_keyframe) return;
            captureNeedsKeyframeRef.current = false;
          }

          // Decode base64 → binary (IPC sends compact string, not verbose integer array)
          // Encrypt with this channel's MLS-derived key before it leaves this
          // process — media-rust relays it opaquely (see cryptoRef/refreshVideoKey
          // above). The overlay self-view relay above uses the NAL pre-encryption
          // deliberately: that's local Tauri IPC to this same device, never
          // touching the network or media-rust.
          let payload = nalBytes();
          if (streamEncrypted) {
            try {
              payload = cryptoRef.current.encrypt(nalData);
            } catch (err) {
              // Drop, never downgrade — see the matching comment in
              // startEncodingPipeline's encoder output.
              console.warn('[share] video frame encryption failed, dropping frame:', err);
              return;
            }
          }
          const frameSize = 1 + 4 + payload.length;
          const frameBuf = new ArrayBuffer(4 + frameSize);
          const v = new DataView(frameBuf);
          v.setUint32(0, frameSize);
          v.setUint8(4, is_keyframe ? 0 : 1);
          v.setUint32(5, timestamp_ms >>> 0);
          new Uint8Array(frameBuf, 9).set(payload);
          submitVideoFrame(new Uint8Array(frameBuf), is_keyframe);
        });
        captureUnlistenRef.current = unlistenNal;

        // The native capture ended by itself (device lost, window closed,
        // encoder failure): end the share properly so viewers see it stop
        // instead of freezing on the last frame. Not sent for a stop we asked
        // for, nor for the bitrate restart (see capture_start in lib.rs).
        if (captureEndedUnlistenRef.current) { captureEndedUnlistenRef.current(); captureEndedUnlistenRef.current = null; }
        captureEndedUnlistenRef.current = await listen('specter://capture-ended', (event) => {
          if (!isSharingRef.current || stopShareInProgressRef.current) return;
          const reason = event?.payload?.reason || 'Screen capture stopped unexpectedly';
          console.warn('[share] native capture ended on its own:', reason);
          addMsg(`${reason}. Screen share ended.`, 'error');
          stopScreenShareRef.current?.();
        });

        // S2: share audio — same key as the video, same viewer gating. As a
        // datagram on this publish session when the server said it takes them
        // (never waits behind video), else into the share stream through the
        // pump (audio first, never a congestion signal). E2E only: a stream
        // that went out unencrypted carries no audio. Nothing is sent before
        // this server has confirmed it withholds audio from viewers that can't
        // handle it (SHARE_AUDIO_CAPABLE / SHARE_AUDIO_DGRAM_CAPABLE).
        const shareAudioSender = createShareAudioSender({
          encrypt: (inner) => cryptoRef.current.encrypt(inner),
          caps: () => ({
            datagramOk: shareAudioServerDgramOkRef.current,
            streamOk: shareAudioServerOkRef.current && !!shareStreamRef.current,
          }),
          datagramWriter: getShareDgramWriter,
          maxDatagramSize: () => datagramSizeLimit(vt.datagrams),
          submitStream: (frame) => submitVideoFrame.audio(frame),
        });
        let shareAudioRouteLogged = null;
        shareAudioCtxRef.current = {
          sourceId: effectiveSource.id,
          send: (payload) => {
            // !shareHeaderSent: nothing may go on the stream before the header.
            if (!streamEncrypted || !shareHeaderSent || !captureActiveRef.current || !shareStreamRef.current) return;
            const route = shareAudioSender.send(payload);
            if (route && route !== shareAudioRouteLogged) {
              shareAudioRouteLogged = route;
              traceLog(`[share-audio] sending via ${route} (stats ${JSON.stringify(shareAudioSender.stats)})`);
            }
          },
        };
        if (shareAudioEnabledRef.current) startShareAudio();

        // No second "overlay" upload any more. 2.0.x opened a 0x03 uni stream
        // here and sent every NAL a second time (the same full-res frames,
        // re-encrypted, and not gated on viewers like the main stream is) for a
        // "simulcast low-res overlay" nobody has subscribed to since 1.6.76 —
        // the overlay window decodes the main stream, relayed locally. That was
        // ~half the sharer's upload while watched and nearly all of it while
        // not. media-rust still accepts (and refuses) the stream from 2.0.x.

        // Listen for preview frames → draw to preview canvas
        const unlistenPreview = await listen('specter://capture-preview', (event) => {
          // When overlay self-view is active, avoid duplicate CPU conversion work
          // for the in-app preview canvas.
          if ((overlayActiveRef.current || stripViewerActiveRef.current /* SV */) && overlayWantsSelfViewRef.current) return;
          const { thumb_b64, width, height } = event.payload;
          const canvas = capturePreviewCanvasRef.current;
          if (!canvas || !thumb_b64 || !width) return;
          // Fast base64 → Uint8Array decode
          const bin = atob(thumb_b64);
          const bgra = Uint8Array.from(bin, c => c.charCodeAt(0));
          // BGRA → RGBA swap using a DataView to avoid branch per pixel
          const rgba = new Uint8ClampedArray(bgra.length);
          for (let i = 0; i < bgra.length; i += 4) {
            rgba[i]   = bgra[i + 2]; // R ← B
            rgba[i+1] = bgra[i + 1]; // G
            rgba[i+2] = bgra[i];     // B ← R
            rgba[i+3] = 255;
          }
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
        });
        capturePreviewUnlistenRef.current = unlistenPreview;

        setUsingTauriCapture(true);
        setIsSharing(true);
        const localUser = JSON.parse(localStorage.getItem('specter_user') || '{}');
        const cs = localUser.callsign || localUser.username || '';
        console.log('[share] broadcasting availability, callsign=', cs);
        sendControlDatagram(0x01, [1, ...new TextEncoder().encode(cs)]); // include callsign so other clients identify the sharer
        setAvailableSharers(prev => {
          const callsignToAdd = cs || 'You';
          return prev.includes(callsignToAdd) ? prev : [...prev, callsignToAdd];
        });
        // Overlay self-view is NAL-only: header+nals are relayed through overlay events.
        addMsg(`Sharing: ${selectedSource.name}`, 'tx');
      } catch (err) {
        addMsg(`Screen capture failed: ${err.message}`, 'error');
        return { ok: false, error: `Screen capture failed: ${err?.message || err}` };
      }
      return { ok: true };
    }
    if (isTauriWindows && forceBrowserCaptureOnWindows) {
      addMsg('Native capture compatibility mode enabled — using browser screen capture.', 'system');
      console.warn('[share] native capture bypassed: using browser getDisplayMedia fallback on Windows Tauri');
    }
    try {
      const orgTier = org?.tier ?? 0;
      const concurrentSharers = Math.max(1, (availableSharersRef.current?.length || 0) + 1);
      const profile = getEffectiveStreamProfile(orgTier, concurrentSharers);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // `ideal` is a hint, not a guarantee — browsers may still hand back a
        // native-resolution track. startEncodingPipeline() re-caps via capEncodeDims()
        // before configuring the actual encoder, so this is best-effort only.
        video: { width: { ideal: profile.width }, height: { ideal: profile.height }, frameRate: { ideal: profile.fps } },
        audio: false,
        surfaceSwitching: 'exclude',
        selfBrowserSurface: 'exclude',
      });
      const track = stream.getVideoTracks()[0];
      shareTrackRef.current = track;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setIsSharing(true);
      track.onended = () => stopScreenShare();

      // Start encoding first and AWAIT it so the header is fully written to the
      // relay stream (and cached server-side in video_headers) BEFORE the announce
      // datagram reaches other clients. This eliminates the race where a viewer
      // subscribes before the server has a cached header to replay (Cause 6).
      const localUser = JSON.parse(localStorage.getItem('specter_user') || '{}');
      const cs = localUser.callsign || localUser.username || '';
      await startEncodingPipeline(track, profile, orgTier);
      sendControlDatagram(0x01, [1, ...new TextEncoder().encode(cs)]); // available = 1, include callsign — sent after header is on the wire
      setAvailableSharers(prev => {
        const callsignToAdd = cs || 'You';
        return prev.includes(callsignToAdd) ? prev : [...prev, callsignToAdd];
      });
      addMsg('Streaming.', 'tx');
    } catch (err) {
      addMsg(`Screen capture failed: ${err.message}`, 'error');
    }
  };

  const stopScreenShare = async () => {
    if (stopShareInProgressRef.current) {
      console.log('[share] stopScreenShare ignored: already in progress');
      return;
    }
    stopShareInProgressRef.current = true;
    console.log('[share] stopScreenShare begin, usingTauriCapture=', usingTauriCapture);
    // Stop adaptive bitrate stepping immediately (before the capture_stop below)
    // so an in-flight or about-to-fire step never races a user-initiated stop —
    // both the ref clear and the stopShareInProgressRef check inside
    // restartCaptureWithBitrate guard against this from either direction.
    if (adaptiveBitrateRef.current?.timer) {
      clearInterval(adaptiveBitrateRef.current.timer);
    }
    adaptiveBitrateRef.current = null;
    activeShareCongestionSignalRef.current = null;
    forceShareKeyframeRef.current = null;
    shareAudioCtxRef.current = null; // S2
    stopShareAudio();
    try {
      if (window.__TAURI__ && usingTauriCapture) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('capture_stop');
        } catch {}
      }
      localStorage.removeItem('specter_capture_mode');
      if (captureWatchdogRef.current) {
        clearTimeout(captureWatchdogRef.current);
        captureWatchdogRef.current = null;
      }
      if (captureUnlistenRef.current) {
        captureUnlistenRef.current();
        captureUnlistenRef.current = null;
      }
      if (capturePreviewUnlistenRef.current) {
        capturePreviewUnlistenRef.current();
        capturePreviewUnlistenRef.current = null;
      }
      if (captureEndedUnlistenRef.current) {
        captureEndedUnlistenRef.current();
        captureEndedUnlistenRef.current = null;
      }
      setUsingTauriCapture(false);
      stopEncodingPipeline();
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(t => t.stop());
        videoRef.current.srcObject = null;
      }
      if (shareTrackRef.current) {
        shareTrackRef.current.onended = null;
        shareTrackRef.current.stop();
        shareTrackRef.current = null;
      }
      setIsSharing(false);
      setShareViewerCount(0);
      const stoppedCs = (() => {
        const localUser = JSON.parse(localStorage.getItem('specter_user') || '{}');
        return localUser.callsign || localUser.username || 'You';
      })();
      setAvailableSharers(prev => prev.filter(s => s !== stoppedCs));
      sendControlDatagram(0x01, [0, ...new TextEncoder().encode(stoppedCs)]); // available = 0, include callsign so peers can remove
      addMsg('Screen share stopped.', 'system');
      console.log('[share] stopScreenShare complete');
    } finally {
      stopShareInProgressRef.current = false;
    }
  };

  stopScreenShareRef.current = stopScreenShare;

  const changeShareSource = async () => {
    if (!isSharing) return;
    try {
      const orgTier = org?.tier ?? 0;
      const concurrentSharers = Math.max(1, (availableSharersRef.current?.length || 0) + 1);
      const profile = getEffectiveStreamProfile(orgTier, concurrentSharers);
      const newStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: profile.width }, height: { ideal: profile.height }, frameRate: { ideal: profile.fps } },
        audio: false,
        surfaceSwitching: 'exclude',
        selfBrowserSurface: 'exclude',
      });
      const newTrack = newStream.getVideoTracks()[0];

      // Stop old track and encoding
      stopEncodingPipeline();
      if (videoRef.current?.srcObject) {
        videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      }
      if (shareTrackRef.current) shareTrackRef.current.stop();

      // Set new track
      shareTrackRef.current = newTrack;
      if (videoRef.current) videoRef.current.srcObject = newStream;
      newTrack.onended = () => stopScreenShare();

      // Restart encoding with new source
      startEncodingPipeline(newTrack, profile, orgTier);
      addMsg('Screen share source changed.', 'system');
    } catch {
      // User cancelled picker — keep current source
    }
  };

  const subscribeToRemoteStream = async (callsign) => {
    if (subscribeInFlightRef.current) {
      pendingWatchTargetRef.current = callsign;
      return;
    }
    subscribeInFlightRef.current = true;
    console.log('[subscribe] called for callsign=', callsign);
    // Increment session counter FIRST — any in-flight processVideoData will see
    // the new value and stop drawing immediately, preventing dual-decoder flicker.
    const mySession = ++videoSessionRef.current;
    svStatus(STREAM_STATUS.CONNECTING); // SV
    // Close any existing video transport
    if (videoTransportRef.current) {
      safeCloseTransport(videoTransportRef.current);
      videoTransportRef.current = null;
    }

    // Sync epoch before subscribing — someone may have committed since connect(),
    // and if we're on a different epoch than the sharer we'll decrypt nothing.
    try {
      const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
      // Op-wide share: in a live op this syncs the event group's op key.
      const { key: videoKey, groupId } = await exportVideoKey(currentUserId, 'sync');
      installVideoKey(videoKey, groupId);
      traceLog(`[video-key] pre-subscribe epoch sync done`);
    } catch (err) {
      traceLog(`[video-key] pre-subscribe epoch sync failed (non-fatal): ${err?.message || err}`);
    }

    const role = 'subscribe';
    const kind = 'video_subscribe';
    // Op-wide share: a sharer listed from one of my frequency nets (not in my
    // group channel) is ticketed through that frequency; the server mints it
    // for the sharer's group channel, pinned to that sharer. A separate
    // video transport — my group voice connection is never touched.
    const viaFreq = !availableSharersRef.current.includes(callsign) ? (remoteSharerNetsRef.current[callsign] || null) : null;
    let ticketData;
    try {
      ticketData = await getMediaTicket(kind, callsign, viaFreq || channelRef.current.id);
    } catch (err) {
      if (!viaFreq) throw err;
      traceLog(`[subscribe] frequency share ticket refused for ${callsign}: ${err?.message || err}`);
      subscribeInFlightRef.current = false;
      svStatus(STREAM_STATUS.UNAVAILABLE, `${callsign}'s stream isn't available.`);
      onWatchFailed?.();
      return;
    }
    const videoChannelId = viaFreq ? ticketData.channel_id : channelRef.current.id;
    // Same op key or nothing: an old server (no channel_id / op scope), or
    // an op key not in hand yet, means no subscribe — never a guess.
    if (viaFreq && (!videoChannelId || ticketData.video_key_scope !== 'op'
        || String(ticketData.event_id) !== opVideoEventRef.current || !videoKeyReadyForScope())) {
      traceLog(`[subscribe] frequency share for ${callsign} skipped: scope=${ticketData.video_key_scope} event=${ticketData.event_id} mine=${opVideoEventRef.current} keyReady=${videoKeyReadyForScope()}`);
      subscribeInFlightRef.current = false;
      svStatus(STREAM_STATUS.UNAVAILABLE, `${callsign}'s stream isn't available yet (operation key).`);
      onWatchFailed?.();
      return;
    }
    const base = (mediaUrlRef.current || ticketData.media_url).replace(/\/$/, '');
    console.log('[subscribe] transport connecting, base=', base, 'sharer=', callsign);
    // Always subscribe to the full-res stream. The overlay window is fed via local IPC
    // (overlay-video-nal emit in processVideoData), so subscribe_overlay / simulcast is
    // not needed — and would silently stall when the sharer's overlay encoder isn't
    // running (e.g. CPU capture mode or D3D11VA overlay encoder init failure).
    // S2: ask for the share's audio only if this native build can play it —
    // the server withholds it otherwise (and from every 2.0.x viewer). Both
    // params: share_audio_dgram for datagrams, share_audio for a server that
    // predates them (it then sends in-stream frames, handled below too).
    const audioParam = shareAudioSubscribeParams(shareAudioSupportedRef.current);
    const url = `${base}/specter/video?token=${ticketData.ticket}&channel_id=${videoChannelId}&role=${role}&sharer=${encodeURIComponent(callsign)}${audioParam}`;

    const { transport: vt } = await createTransport(url, { label: 'subscribe', log: traceLog });
    videoTransportRef.current = vt;
    await vt.ready;
    console.log('[subscribe] transport ready for sharer=', callsign);
    // S2: share-audio datagrams of this subscription. Nothing reads this
    // session's datagrams otherwise (keyframe requests only go the other way).
    if (shareAudioSupportedRef.current) {
      readShareAudioDatagrams(vt.datagrams.readable, (tsMs, payload) => {
        const enc = shareAudioStreamEncRef.current;
        if (enc.session !== mySession) return; // header not read yet: encryption unknown
        handleShareAudioFrame(callsign, mySession, enc.encrypted, tsMs, payload);
      }, () => videoTransportRef.current === vt);
    }

    setIsWatching(true);
    setWatchingSharer(callsign);
    addMsg(`Watching ${callsign}...`, 'system');

    // Track whether we ever received a video frame from this subscribe attempt.
    // Used by vt.closed to distinguish "sharer stopped" from "sharer not found".
    let streamReceived = false;

    // Monitor for server-side close (share ended or sharer not found).
    // Guard: only act if this transport is still the active one.  Without the guard,
    // a stale vt.closed (from a transport closed by a newer subscribeToRemoteStream
    // call) would null out videoTransportRef and reset isWatching/watchingSharer even
    // though the NEW session is already running — orphaning the new transport.
    vt.closed.then(() => {
      if (videoTransportRef.current !== vt) return; // superseded by a newer subscribe
      stopShareAudioPlayback(); // S3
      setIsWatching(false);
      setWatchingSharer(null);
      setRemoteShare(null);
      videoTransportRef.current = null;
      remoteStreamHeaderRef.current = null; // clear so a stale header isn't re-sent to a new overlay session
      gopBufferRef.current = [];             // clear GOP buffer — no longer valid after stream ends
      // SV: tell the strip's viewer why its picture stopped.
      svStatus(streamReceived ? STREAM_STATUS.ENDED : STREAM_STATUS.UNAVAILABLE,
        streamReceived ? `${callsign}'s stream ended.` : `${callsign}'s stream isn't available.`);
      // If the connection closed before any frame arrived the server couldn't find
      // the sharer (race or wrong channel).  Notify WarRoom so it can clear watchTarget
      // and break the automatic retry loop.
      if (!streamReceived) {
        onWatchFailed?.();
      }
    }).catch(() => {});

    // Server immediately opens a uni stream with header + keyframe + live frames
    try {
      const reader = vt.incomingUnidirectionalStreams.getReader();
      // Time out if server never opens the stream (e.g. sharer disconnected before
      // subscribe was processed, or JWT rejected after accept).
      const streamTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('stream_timeout')), 8000)
      );
      const { value: stream } = await Promise.race([reader.read(), streamTimeout]);
      if (stream) {
        streamReceived = true;
        const streamReader = stream.getReader();
        const { value: firstChunk } = await streamReader.read();
        console.log('[subscribe] got first chunk from server, bytes=', firstChunk?.length, 'type byte=', firstChunk?.[0]);
        if (firstChunk && firstChunk.length > 0) {
          processVideoData(streamReader, firstChunk.slice(1), mySession, callsign);
        }
      }
    } catch (e) {
      if (e?.message === 'stream_timeout') {
        addMsg('Stream unavailable — sharer may have stopped.', 'error');
        svStatus(STREAM_STATUS.UNAVAILABLE, `${callsign}'s stream isn't available. They may have stopped sharing.`); // SV
        onWatchFailed?.();
      } else {
        console.error('Video stream error', e);
      }
      setIsWatching(false);
      setWatchingSharer(null);
    } finally {
      subscribeInFlightRef.current = false;
    }
  };

  const unsubscribeFromStream = () => {
    stopShareAudioPlayback(); // S3: no audio from a stream nobody is watching
    if (videoTransportRef.current) {
      safeCloseTransport(videoTransportRef.current);
      videoTransportRef.current = null;
    }
    setIsWatching(false);
    setWatchingSharer(null);
    setRemoteShare(null);
    addMsg('Stopped watching stream.', 'system');
  };

  // Guards against re-entrant calls: the "start unmuted on mount" effect and the
  // "auto-unmute on connect" effect can both fire toggleMic() around the same
  // render, each closing over a stale isMuted=true and both racing into the
  // unmute branch concurrently. That double-invoke of native start_capture can
  // throw on the native side, leaving isMuted stuck true (mic silently never
  // starts). Drop any call that arrives while one is already in flight,
  // without touching the mute/unmute logic itself.
  const toggleBusyRef = useRef(false);
  const toggleMic = async () => {
    if (toggleBusyRef.current) return;
    toggleBusyRef.current = true;
    try {
      await toggleMicInner();
    } finally {
      toggleBusyRef.current = false;
    }
  };
  const toggleMicInner = async () => {
    console.log('[toggleMic] called, isMuted=', isMuted, '__TAURI__=', !!window.__TAURI__);
    if (!isMuted) {
      // ── Mute ────────────────────────────────────────────────────────────────
      if (window.__TAURI__) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('plugin:specter-audio|stop_capture', {}).catch(() => {});
        });
        if (audioUnlistenRef.current) {
          audioUnlistenRef.current();
          audioUnlistenRef.current = null;
        }
        if (audioLevelUnlistenRef.current) {
          audioLevelUnlistenRef.current();
          audioLevelUnlistenRef.current = null;
        }
        setIsMuted(true);
        setLiveLocalLevels(0, 0, false);
        setMicError(null);
        addMsg('Native audio capture stopped.', 'system');
        return;
      }
      // Browser path
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach(t => t.stop());
        audioStreamRef.current = null;
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setIsMuted(true);
      setLiveLocalLevels(0, 0, false);
      setMicError(null);
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit('local-vad', { speaking: false, muted: true });
      }).catch(() => {});
      addMsg('Microphone muted.', 'system');
      return;
    }

    // ── Unmute ───────────────────────────────────────────────────────────────
    if (window.__TAURI__) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const { listen } = await import('@tauri-apps/api/event');

        const deviceId = localStorage.getItem('specter_audio_in');
        console.log('[toggleMic] calling start_capture, deviceId=', deviceId);
        const requestedDevice = deviceId && deviceId !== 'default' ? deviceId : null;
        // Seed the native send-gate with this session's current threshold and
        // voice-activation mode before capture starts — AudioState's defaults
        // (150, Auto) may not match what the user set (persisted in
        // localStorage, not on the Rust side). Push-to-talk forces Manual.
        // Not awaited (like the old set_send_threshold seed) so a PTT press
        // doesn't wait on an extra IPC round trip; both are sync commands, so
        // they're handled before the start_capture issued after them.
        applyNativeVadConfig(invoke);
        try {
          await invoke('plugin:specter-audio|start_capture', {
            deviceId: requestedDevice,
          });
        } catch (startErr) {
          if (requestedDevice) {
            console.warn('[toggleMic] selected input failed; retrying default input:', startErr);
            await invoke('plugin:specter-audio|start_capture', { deviceId: null });
          } else {
            throw startErr;
          }
        }
        console.log('[toggleMic] start_capture succeeded, deviceId=', deviceId);

        const userId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id || 'unknown';
        const ssrc = hashUserId(userId);

        let audioFrameCount = 0;
        const unlisten = await listen('specter://audio-frame', async (event) => {
          const { data } = event.payload;
          const opusBytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
          const seq = (sequenceRef.current++) & 0x7fffffff;
          // Frequency overlay: while a frequency is the active net the frame
          // goes to that net's own connection (sealed with its key there) or
          // is dropped — never to this group connection, so the group does
          // not hear frequency traffic. See engine/activeNet.js.
          if (routeMicFrame({ opusBytes, ssrc, seq }) !== ROUTE_GROUP) {
            audioFrameCount++;
            return;
          }
          // Only encrypt when the server actually relays instead of mixing —
          // see voiceRelayModeRef's doc comment. Relay mode is a confidentiality
          // promise to every listener in the channel, so this must fail CLOSED:
          // if the key isn't ready yet or seal() throws, drop the frame
          // rather than send it in the clear.
          // E2EV: there is no plaintext path. Every frame is sealed with this
          // channel's MLS-derived relay key (wire v3: session key, counter
          // nonce, AEAD-bound timestamp; ssrc bound as AAD and equal to
          // media-rust's canonical_ssrc), or it is not sent at all. While
          // keyless the strip shows "Waiting for channel key…" and
          // scheduleVoiceKeyRetry is recovering it.
          const tx = audioKeyChannelRef.current === channelRef.current?.id ? relayAudioTxRef.current : null;
          if (!tx) {
            scheduleVoiceKeyRetry();
            return; // key not ready — drop, never send plaintext
          }
          let payload;
          try {
            payload = tx.seal(opusBytes, ssrc);
          } catch (e) {
            console.warn('[Audio] encrypt failed, dropping frame (voice is end-to-end only):', e);
            return;
          }
          // Signs the ciphertext actually being sent, not the raw Opus — proves
          // this exact frame came from this device, on top of (not instead of)
          // SFrame's own AEAD confidentiality/integrity. Best-effort: a signing
          // failure still sends the frame unsigned rather than dropping it, same
          // non-fatal philosophy as encryption above.
          let signature = null;
          {
            try {
              const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
              signature = await signBytes(api, currentUserId, payload);
            } catch (e) {
              console.warn('[Audio] sign failed, sending unsigned:', e);
            }
          }
          const frameProto = encodeAudioFrameProto(ssrc, seq, payload, false, signature);

          // Priority-cascade copy: a second, separately-encrypted frame (the
          // event-scoped cascade key, only derived when this channel belongs to
          // an event — see cryptoAudioCascadeRef's doc comment) tagged
          // is_global_broadcast so media-rust knows to forward it to descendant
          // channels instead of this channel's own members, and only while the
          // server currently has this sender locked as the active priority
          // speaker (see main.rs's relay-mode ducking block — a non-priority or
          // not-currently-active sender's cascade copy is simply dropped
          // server-side, so sending it unconditionally here is wasteful but not
          // incorrect; gating it client-side on "am I the active speaker" isn't
          // done because the client has no low-latency way to know that without
          // waiting for the same Duck signal this frame's arrival would trigger).
          if (EVENT_CASCADE_LANE && relayAudioCascadeTxRef.current) {
            try {
              const cascadePayload = relayAudioCascadeTxRef.current.seal(opusBytes, ssrc);
              const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
              let cascadeSignature = null;
              try {
                cascadeSignature = await signBytes(api, currentUserId, cascadePayload);
              } catch (e) {
                console.warn('[Audio] cascade sign failed, sending unsigned:', e);
              }
              const cascadeProto = encodeAudioFrameProto(ssrc, seq, cascadePayload, true, cascadeSignature);
              datagramWriterRef.current?.write(cascadeProto).catch(() => {});
            } catch (e) {
              console.warn('[Audio] cascade encrypt failed, skipping this frame\'s cascade copy:', e);
            }
          }

          if (audioFrameCount === 0) {
            console.log('[Audio] FIRST frame received from Rust. opusBytes=', opusBytes.length, 'datagramWriter=', datagramWriterRef.current ? 'READY' : 'NULL (not connected!)');
          }

          if (datagramWriterRef.current) {
            datagramWriterRef.current.write(frameProto).catch((e) => {
              console.error('[Audio] datagram write failed:', e);
            });
            if (audioFrameCount % 50 === 0) {
              console.log(`[Audio] OK: ${audioFrameCount} frames sent, last frame ${opusBytes.length}B, ssrc=${ssrc}, seq=${seq}`);
            }
          } else {
            // datagramWriterRef is null: transport not connected yet.
            // Warn once (not every frame) so the user knows audio is not transmitting.
            if (audioFrameCount === 0) {
              console.warn('[Audio] datagramWriter is null — mic is on but not connected to a channel. Audio will not transmit until connected.');
              setMicError('Microphone active but not connected to a channel — audio will not transmit.');
            }
          }
          audioFrameCount++;
        });

        // Live mic-level meter, fed from the real PCM RMS computed in Rust on every
        // 20 ms window — independent of whether that window cleared the noise gate,
        // so the meter reflects true mic input, not encode/transmit outcome.
        const unlistenLevel = await listen('specter://audio-level', (event) => {
          const rms = event.payload.rms ?? 0;
          // Auto voice activation: "speaking" is the native gate itself (it is
          // what decides which frames are sent). Manual: unchanged — it clears
          // the user's own threshold, which is what the mixer would mix in.
          // Engine phase 0: ~50/s — written to liveLevels, never to state.
          setLiveLocalLevels(
            Math.min(100, Math.round((rms / 500) * 100)),
            rms,
            event.payload.mode === 'auto' ? Boolean(event.payload.speaking) : rms >= micThresholdRef.current);
        });

        audioUnlistenRef.current = unlisten;
        audioLevelUnlistenRef.current = unlistenLevel;
        setIsMuted(false);
        setMicError(null);
        addMsg('Native audio capture started (cpal/Opus).', 'system');
      } catch (err) {
        console.error('[toggleMic] FAILED:', err);
        const msg = err?.message ?? String(err);
        setMicError(msg);
        addMsg(`Native audio capture failed: ${msg}`, 'error');
      }
      return;
    }

    // Browser path (getUserMedia) — VAD only; Opus send path is Tauri-only.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

      initAudioCore();
      const source = audioCtxRef.current.createMediaStreamSource(stream);
      const analyser = audioCtxRef.current.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkAudioLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const average = sum / bufferLength;
        const currentlySpeaking = average > vadThresholdRef.current;
        const level = Math.min(100, Math.round(average * 1.5));
        if (setLiveLocalLevels(level, 0, currentlySpeaking)) {
          import('@tauri-apps/api/event').then(({ emit }) => {
            emit('local-vad', { speaking: currentlySpeaking, muted: false });
          }).catch(() => {});
        }
        rafRef.current = requestAnimationFrame(checkAudioLevel);
      };

      checkAudioLevel();
      setIsMuted(false);
      setMicError(null);
      addMsg('Microphone unmuted. VAD active.', 'system');
    } catch (err) {
      setMicError(err.message);
      addMsg(`Microphone access failed: ${err.message}`, 'error');
    }
  };

  useEffect(() => {
    traceLog(`CommLink MOUNTED for channel.id=${channel?.id} channel.name=${channel?.name}`);
    return () => {
      traceLog(`CommLink UNMOUNTING for channel.id=${channel?.id} channel.name=${channel?.name}`);
      // Mark this teardown as deliberate first — the transport.close() inside
      // disconnect() below resolves monitorClosure's `transport.closed` await,
      // which would otherwise schedule a reconnect for a component that's
      // already gone.
      intentionalDisconnectRef.current = true;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (presenceHeartbeatRef.current) {
        clearInterval(presenceHeartbeatRef.current);
        presenceHeartbeatRef.current = null;
      }
      disconnect();
    };
  }, []);

  // Auto-connect when mounted in embedded mode
  useEffect(() => {
    if (embedded && status === 'disconnected' && !autoConnectedRef.current) {
      autoConnectedRef.current = true;
      traceLog(`CommLink auto-connect firing for channelRef.current.id=${channelRef.current?.id}`);
      connect();
    }
  }, [embedded]);

  // Notify parent of roster and speaking state changes
  useEffect(() => { onRosterChange?.(roster); }, [roster]);
  useEffect(() => { onSharersChange?.(availableSharers); }, [availableSharers]);
  useEffect(() => { onMuteChange?.(isMuted); }, [isMuted]);
  useEffect(() => { onSharingChange?.(isSharing); }, [isSharing]);
  useEffect(() => { isSharingRef.current = isSharing; }, [isSharing]);
  useEffect(() => { onConnectionQualityChange?.(connectionQuality); }, [connectionQuality]);
  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);
  // Periodic re-check so quality recovers back to 'excellent' over time even
  // if nothing else happens to re-trigger recomputeConnectionQuality (it's
  // otherwise only called on a new drop, which — for a healthy connection —
  // may never happen again to clear out an old one).
  useEffect(() => {
    const t = setInterval(recomputeConnectionQuality, 10_000);
    return () => clearInterval(t);
  }, []);

  // Expose action functions to parent via ref (updated every render to stay fresh)
  const toggleMicCurrentRef = useRef(null);
  useEffect(() => { toggleMicCurrentRef.current = toggleMic; });
  useEffect(() => {
    if (!externalControlsRef) return;
    externalControlsRef.current = {
      toggleMic: () => toggleMicCurrentRef.current?.(),
      startScreenShare,
      stopScreenShare,
      changeShareSource,
      submitVoiceReport,
      // S2/S3: the "Share audio" toggle (persisted; applies to a running
      // share) and a watched sharer's volume / mute (persisted per sharer).
      setShareAudioEnabled,
      setSharerAudio,
      setVideoFrameCallback: (fn) => { videoFrameCallbackRef.current = fn; },
      // SV: the strip viewer's Retry — re-subscribe the current target (a
      // fresh session, so the strip resets its decoder). Self-view needs
      // nothing: capture keeps producing keyframes.
      restartWatch: () => {
        const target = watchStreamTargetRef.current;
        if (!target || overlayWantsSelfViewRef.current || subscribeInFlightRef.current || status !== 'connected') return false;
        lastWatchSwitchMsRef.current = Date.now();
        if (videoTransportRef.current) unsubscribeFromStream();
        subscribeToRemoteStream(target);
        return true;
      },
      // NET: the Repair panel. resetConnectState forgets the retry and timeout
      // bookkeeping; reconnectNow tears down whatever is there and connects
      // afresh (the same deliberate-teardown steps as the MOVE command).
      resetConnectState: () => {
        reconnectAttemptRef.current = 0;
        netConnectRef.current = { ...netConnectRef.current, timeouts: { main: 0, alt: 0 }, attempts: 0, lastKind: null, apiOk: false };
        setVoiceConnect((v) => ({ ...v, connectIssue: null }));
      },
      reconnectNow: () => {
        if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
        intentionalDisconnectRef.current = true;
        setStatus('connecting');
        disconnect(true, true);
        setTimeout(() => connect(), 600);
      },
      get connectInfo() { return { status, ...voiceConnect }; },
      get isMuted() { return isMuted; },
      get isSharing() { return isSharing; },
      get micError() { return micError; },
      get isSpeaking() { return liveLevels.localSpeaking; },
      get shareViewerCount() { return shareViewerCount; },
    };
  });

  // Auto-unmute on first connect (all modes — users joining a voice channel always want audio).
  const autoUnmutedRef = useRef(false);
  useEffect(() => {
    if (status === 'connected' && !autoUnmutedRef.current && isMuted) {
      autoUnmutedRef.current = true;
      toggleMicCurrentRef.current?.();
    }
  }, [status, isMuted]);
  useEffect(() => { onMuteChange?.(isMuted); }, [isMuted]);

  // Mutable refs to avoid stale closure bugs in watchStreamTarget effect
  const availableSharersRef = useRef([]);
  useEffect(() => { availableSharersRef.current = availableSharers; }, [availableSharers]);
  const watchingSharerRef = useRef(null);
  useEffect(() => { watchingSharerRef.current = watchingSharer; }, [watchingSharer]);

  // Watch a specific sharer when parent requests it via watchStreamTarget.
  // Uses refs instead of state captures to avoid stale closure bugs.
  // Also depends on `status` so that if watchStreamTarget is set before the
  // connection is ready, the subscribe is re-sent once 'connected' fires.
  useEffect(() => {
    if (!watchStreamTarget) {
      pendingWatchTargetRef.current = null;
      if (watchSwitchTimerRef.current) {
        clearTimeout(watchSwitchTimerRef.current);
        watchSwitchTimerRef.current = null;
      }
      overlayWantsSelfViewRef.current = false;
      unsubscribeFromStream();
      return;
    }
    // Already watching this target — no action needed.
    if (watchStreamTarget === watchingSharerRef.current) return;
    const localUser = JSON.parse(localStorage.getItem('specter_user') || '{}');
    const localCallsign = localUser.callsign || localUser.username;
    console.log('[watch] watchStreamTarget=', watchStreamTarget, 'localCallsign=', localCallsign, 'isSharing=', isSharingRef.current, 'status=', status);

    // Self-view: user selected their own callsign while sharing via Tauri capture.
    // Use the NVENC NAL relay path (overlay-video-nal) — no server subscription
    // is needed, and status may not be 'connected' while actively sharing.
    if (localCallsign && watchStreamTarget === localCallsign && isSharingRef.current) {
      pendingWatchTargetRef.current = null;
      if (watchSwitchTimerRef.current) {
        clearTimeout(watchSwitchTimerRef.current);
        watchSwitchTimerRef.current = null;
      }
      overlayWantsSelfViewRef.current = true;
      stopShareAudioPlayback(); // S3: never play my own share back to me
      setWatchingSharer(localCallsign);
      // Configure the overlay's VideoDecoder with our capture session header so
      // it's ready for the next NAL unit emitted by the specter://capture-nal listener.
      const hdr = captureHeaderRef.current;
      if (hdr && overlayActiveRef.current && window.__TAURI__) {
        import('@tauri-apps/api/event').then(({ emit }) => {
          emit('overlay-video-header', hdr);
        }).catch(() => {});
      }
      return;
    }

    // Remote stream: clear self-view relay flag so NALs are no longer relayed.
    overlayWantsSelfViewRef.current = false;
    // Wait until the transport is ready before sending the subscribe datagram.
    // If the user selects a stream before we're connected, this effect will
    // re-fire when status transitions to 'connected'.
    if (status !== 'connected') return;
    pendingWatchTargetRef.current = watchStreamTarget;

    const runWatchSwitch = () => {
      watchSwitchTimerRef.current = null;
      if (status !== 'connected') return;
      const target = pendingWatchTargetRef.current;
      if (!target || target === watchingSharerRef.current) return;

      const elapsed = Date.now() - lastWatchSwitchMsRef.current;
      const minIntervalMs = 700;
      if (elapsed < minIntervalMs || subscribeInFlightRef.current) {
        const waitMs = Math.max(minIntervalMs - elapsed, 150);
        watchSwitchTimerRef.current = setTimeout(runWatchSwitch, waitMs);
        return;
      }

      lastWatchSwitchMsRef.current = Date.now();
      if (watchingSharerRef.current) unsubscribeFromStream();
      subscribeToRemoteStream(target);
    };

    if (!watchSwitchTimerRef.current) runWatchSwitch();
  }, [watchStreamTarget, status]);

  // ── Global hotkey listeners (PTT & channel toggle) ────────────────────────
  const isMutedRef = useRef(isMuted);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  const toggleMicRef = useRef(toggleMic);
  useEffect(() => { toggleMicRef.current = toggleMic; });

  // PTT drives a DESIRED mic state that is reconciled whenever the mic settles
  // (owner report 2026-11-08: "global keybinds very spotty"). It used to toggle
  // straight from the edge, which lost edges: toggleMic drops a call while one
  // is in flight (unmute awaits start_capture), so a release during the unmute
  // was ignored, the mic stayed open, and the next press saw "unmuted" and did
  // nothing. isMuted / toggleMic's closure also lag until React re-renders.
  // pttWantRef: true = key held (want live), false = released (want muted, not
  // yet done), null = PTT isn't driving (manual mute/unmute is left alone).
  const pttWantRef = useRef(null);
  const reconcilePtt = () => {
    const want = pttWantRef.current;
    if (want === null || toggleBusyRef.current) return; // busy: re-run once it settles (effect below)
    if (isMutedRef.current === !want) {
      if (!want) pttWantRef.current = null; // released and muted: done
      return;
    }
    toggleMicRef.current();
  };
  const reconcilePttRef = useRef(reconcilePtt);
  useEffect(() => { reconcilePttRef.current = reconcilePtt; });
  // After each mute-state render the refs above are fresh: finish what PTT asked.
  useEffect(() => { reconcilePttRef.current(); }, [isMuted]);

  useEffect(() => {
    if (!window.__TAURI__) return;
    let unlistens = [];

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');

      unlistens.push(await listen('specter://ptt-active', (event) => {
        pttWantRef.current = Boolean(event.payload?.active);
        reconcilePttRef.current();
      }));

      unlistens.push(await listen('specter://toggle-mute', () => {
        toggleMicRef.current();
      }));
    })();

    return () => { unlistens.forEach(fn => fn()); };
  }, []);

  // ── Text channel functions ──────────────────────────────────────────────────

  const handleChatFileSelect = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const MAX = 512 * 1024;
    if (file.size > MAX) {
      setChatAttachError(`Image too large (${Math.round(file.size / 1024)} KB). Max 512 KB.`);
      setTimeout(() => setChatAttachError(null), 4000);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      setChatImageAttachment(ev.target.result);
      console.log('[Chat] Image attached:', file.name, Math.round(file.size / 1024) + ' KB');
    };
    reader.readAsDataURL(file);
  };

  const sendChatMessage = async (e) => {
    e.preventDefault();
    if ((!chatInput.trim() && !chatImageAttachment) || chatSending) return;
    const text = chatInput.trim();
    const imageUrl = chatImageAttachment;
    setChatSending(true);
    setChatInput('');
    setChatImageAttachment(null);
    console.log('[Chat] Sending to', channel.name, '| text:', text.length, 'chars | image:', imageUrl ? 'yes' : 'no');
    const { error } = await api.sendMessage(org.id, channel.id, text, imageUrl);
    if (error) console.error('[Chat] Send failed:', error);
    setChatSending(false);
    // Message arrives back via SSE message_relay
  };

  // Load from IndexedDB on channel change
  useEffect(() => {
    if (!isTextChannel) return;
    let cancelled = false;
    setChatMessages([]);
    setChatLoading(true);
    console.log('[Chat] Loading messages for channel', channel.id, channel.name);
    getChannelMessages(channel.id).then(rows => {
      if (!cancelled) {
        console.log('[Chat] Loaded', rows.length, 'messages from IndexedDB');
        setChatMessages(rows);
        setChatLoading(false);
      }
    }).catch((err) => {
      console.error('[Chat] IndexedDB load failed:', err);
      if (!cancelled) setChatLoading(false);
    });
    return () => { cancelled = true; };
  }, [channel.id, isTextChannel]);

  // Register SSE relay handler for text channel
  useEffect(() => {
    if (!isTextChannel) return;
    chatRelayRef.current = (payload) => {
      if (payload.channel_id !== channel.id) return;
      console.log('[Chat] Relay received:', payload.id, '|', payload.callsign, '|', payload.encrypted_content?.slice(0, 80), payload.image_url ? '| [image]' : '');
      const msg = {
        id:                payload.id,
        channel_id:        payload.channel_id,
        sender_id:         payload.sender_id,
        callsign:          payload.callsign ?? null,
        global_tag:        payload.global_tag ?? null,
        encrypted_content: payload.encrypted_content,
        image_url:         payload.image_url ?? null,
        timestamp:         payload.timestamp,
      };
      saveChannelMessage(msg).catch(() => {});
      setChatMessages(prev => {
        if (prev.some(m => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    };
    return () => { chatRelayRef.current = null; };
  }, [channel.id, isTextChannel]);

  useEffect(() => {
    if (isTextChannel && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  // ── Text channel early return ───────────────────────────────────────────────

  if (isTextChannel) {
    return (
      <div className="h-full flex flex-col bg-specter-bg-panel border border-specter-primary-dim rounded-lg overflow-hidden">
        {/* Header */}
        <div className="bg-specter-bg-surface p-4 border-b border-specter-primary-dim flex justify-between items-center">
          <div>
            <div className="text-xs text-specter-text-muted uppercase tracking-widest">Text Channel</div>
            <div className="text-lg font-bold text-specter-primary-cyan">{channel.name}</div>
          </div>
          <button onClick={onBack} className="text-specter-text-muted hover:text-specter-primary-cyan">&times; Close</button>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {chatLoading && chatMessages.length === 0 && (
            <div className="text-specter-text-muted text-xs text-center py-8">Loading messages...</div>
          )}
          {chatMessages.map(m => (
            <div key={m.id} className="group">
              <div className="flex items-baseline gap-2">
                <span className="text-specter-primary-cyan font-mono text-xs font-bold">{m.callsign}</span>
                {m.global_tag && <span className="text-specter-text-muted text-xs font-mono">[{m.global_tag}]</span>}
                <span className="text-specter-text-muted text-xs font-mono">
                  {new Date(m.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {m.encrypted_content && (
                <div className="text-specter-text-main text-sm font-mono pl-0 mt-0.5 break-words">{m.encrypted_content}</div>
              )}
              {m.image_url && (
                <img
                  src={m.image_url}
                  alt="attachment"
                  className="mt-1 rounded border border-specter-primary-dim/50 object-contain cursor-pointer"
                  style={{ maxHeight: 260, maxWidth: '100%' }}
                  onClick={() => window.open(m.image_url, '_blank')}
                />
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {/* Input form */}
        <form onSubmit={sendChatMessage} className="p-3 border-t border-specter-primary-dim space-y-2">
          {/* Attachment preview */}
          {chatImageAttachment && (
            <div className="relative inline-block">
              <img src={chatImageAttachment} alt="pending attachment" className="rounded border border-specter-primary-dim object-contain" style={{ maxHeight: 80, maxWidth: 200 }} />
              <button
                type="button"
                onClick={() => setChatImageAttachment(null)}
                className="absolute -top-1 -right-1 w-4 h-4 bg-specter-state-error text-white rounded-full text-xs leading-none flex items-center justify-center"
              >×</button>
            </div>
          )}
          {chatAttachError && (
            <div className="text-specter-state-error text-xs font-mono">{chatAttachError}</div>
          )}
          <div className="flex gap-2">
            <input type="file" ref={chatFileInputRef} className="hidden" accept="image/*" onChange={handleChatFileSelect} />
            <button
              type="button"
              onClick={() => chatFileInputRef.current?.click()}
              title="Attach image (max 512 KB)"
              className="px-2 py-2 border border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan rounded text-base transition-colors flex-shrink-0"
            >📎</button>
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              maxLength={4000}
              placeholder={`Message #${channel.name}`}
              className="flex-1 bg-black border border-specter-primary-dim rounded px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-specter-primary-cyan placeholder-specter-text-muted"
            />
            <button
              type="submit"
              disabled={chatSending || (!chatInput.trim() && !chatImageAttachment)}
              className="px-4 py-2 bg-specter-primary-cyan text-specter-bg-surface rounded text-xs font-bold uppercase tracking-wider font-mono disabled:opacity-50"
            >
              SEND
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ── Voice channel render ────────────────────────────────────────────────────

  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={!embedded ? {
        backdropFilter: 'blur(16px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.2)',
        background: 'linear-gradient(180deg, rgba(4,12,23,0.52), rgba(2,8,16,0.42))',
        border: '1px solid rgba(56,189,248,0.28)',
        borderRadius: 8,
        boxShadow: '0 0 0 1px rgba(34,211,238,0.10), 0 0 28px rgba(34,211,238,0.15)',
      } : undefined}
    >
      {/* Header — hidden in embedded mode (WarRoom provides its own) */}
      {!embedded && (
        <div className="p-4 border-b border-specter-primary-dim flex justify-between items-center" style={{ background: 'rgba(2,8,16,0.3)' }}>
          <div>
            <div className="text-xs text-specter-text-muted uppercase tracking-widest">Secure Channel</div>
            <div className="text-lg font-bold text-specter-primary-cyan">{org.callsign}</div>
          </div>
          <div className="flex items-center gap-4">
            {isDucking && (
              <div className="text-xs uppercase font-bold text-specter-state-warning animate-pulse border border-specter-state-warning px-2 py-1">
                [ Priority Ducking Active -20dB ]
              </div>
            )}
            <div className={`flex items-center gap-2 text-xs uppercase tracking-wider font-bold 
              ${status === 'connected' ? 'text-specter-state-success' : 
                status === 'connecting' ? 'text-specter-state-warning' : 
                status === 'error' ? 'text-specter-state-error' : 'text-specter-text-muted'}`}>
              <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-specter-state-success animate-pulse' : 
                               status === 'connecting' ? 'bg-specter-state-warning animate-bounce' : 
                               status === 'error' ? 'bg-specter-state-error' : 'bg-gray-500'}`} />
              {status}
            </div>
            <button onClick={onBack} className="text-specter-text-muted hover:text-specter-primary-cyan">
              &times; Close
            </button>
          </div>
        </div>
      )}

      {/* Embedded controls strip */}
      {embedded && (
        <div className="flex items-center gap-3 px-4 py-2 flex-shrink-0" style={{ borderBottom: '1px solid rgba(56,189,248,0.15)', background: 'rgba(2,8,16,0.45)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
          {isDucking && (
            <span style={{ fontSize: 13, color: '#f59e0b', letterSpacing: '0.15em' }} className="animate-pulse">
              [ DUCKING -20dB ]
            </span>
          )}
          <div className={`flex items-center gap-2 text-xs uppercase tracking-wider font-bold 
            ${status === 'connected' ? 'text-specter-state-success' : 
              status === 'connecting' ? 'text-specter-state-warning' : 
              status === 'error' ? 'text-specter-state-error' : 'text-specter-text-muted'}`}>
            <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-specter-state-success animate-pulse' : 
                             status === 'connecting' ? 'bg-specter-state-warning animate-bounce' : 
                             status === 'error' ? 'bg-specter-state-error' : 'bg-gray-500'}`} />
            {status}
          </div>
          {status === 'connected' && (
            <>
              {!hideMuteButton && (
                <button 
                  onClick={toggleMic}
                  title={micError ?? undefined}
                  className={`px-3 py-1 border text-xs uppercase tracking-widest transition-colors font-mono ${
                    micError
                      ? 'border-specter-state-error text-specter-state-error'
                      : isMuted 
                        ? 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan' 
                        : isSpeaking 
                            ? 'border-specter-state-success text-specter-state-success bg-specter-state-success/10 shadow-[0_0_10px_rgba(16,185,129,0.3)]' 
                            : 'border-specter-primary-cyan text-specter-primary-cyan'
                  }`}
                >
                  {micError ? '[ Mic Error — Click Retry ]' : isMuted ? '[ Audio Muted ]' : isSpeaking ? '[ Transmitting ]' : '[ Mic Open ]'}
                </button>
              )}
              {micError && (
                <span className="text-specter-state-error text-xs font-mono truncate max-w-xs" title={micError}>{micError}</span>
              )}
              {/* Mic level meter + activation-threshold slider — the yellow line/handle
                  is the real server mixer gate (micThreshold); the bar is live RMS. Dragging
                  it sends a SET_AUDIO_THRESHOLD control datagram so the server gate follows. */}
              {!hideMuteButton && !isMuted && (
                <div className="flex items-center gap-1" title="Mic level vs. server activation threshold — drag to adjust">
                  <div className="relative w-24 h-4 bg-black border border-specter-primary-dim/40 rounded overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0"
                      style={{
                        width: `${Math.min(100, (micRms / 500) * 100)}%`,
                        background: micRms >= micThreshold ? 'rgba(34,197,94,0.7)' : 'rgba(8,145,178,0.5)',
                        transition: 'width 75ms linear, background 100ms',
                      }}
                    />
                    <input
                      type="range"
                      min="0"
                      max="500"
                      step="5"
                      value={micThreshold}
                      onChange={(e) => handleMicThresholdChange(Number(e.target.value))}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                    <div
                      className="absolute inset-y-0 w-px bg-yellow-400 opacity-80 pointer-events-none"
                      style={{ left: `${Math.min(99, (micThreshold / 500) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
              {/* Screen share controls */}
              {!hideMuteButton && (
                <button 
                  onClick={isSharing ? stopScreenShare : startScreenShare}
                  className={`px-3 py-1 border text-xs uppercase tracking-widest transition-colors font-mono ${
                    isSharing
                      ? 'border-specter-state-error text-specter-state-error bg-specter-state-error/10'
                      : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                  }`}
                >
                  {isSharing ? '[ Stop Share ]' : '[ Screen Capture ]'}
                </button>
              )}
              {!hideMuteButton && isSharing && (
                <button
                  onClick={changeShareSource}
                  className="px-3 py-1 border text-xs uppercase tracking-widest transition-colors font-mono border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan"
                >
                  [ Change Source ]
                </button>
              )}
              {isSharing && (
                <span style={{ fontSize: 10, color: shareViewerCount > 0 ? '#22d3ee' : '#0e7490', letterSpacing: '0.1em' }}>
                  {shareViewerCount > 0 ? `◉ ${shareViewerCount} VIEWER${shareViewerCount > 1 ? 'S' : ''}` : '◯ NO VIEWERS'}
                </span>
              )}
              <button 
                onClick={() => {
                  const newState = !comsFilterEnabled;
                  setComsFilterEnabled(newState);
                  localStorage.setItem('specter_audio_coms_filter', newState);
                }}
                className={`px-3 py-1 border text-xs uppercase tracking-widest transition-colors font-mono ${
                  comsFilterEnabled 
                    ? 'border-specter-primary-neon text-specter-primary-neon bg-specter-primary-neon/10' 
                    : 'border-specter-primary-dim text-specter-text-muted hover:text-white hover:border-specter-primary-cyan'
                }`}
              >
                {comsFilterEnabled ? '[ Coms Filter: ON ]' : '[ Coms Filter: OFF ]'}
              </button>
            </>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 13, color: '#22d3ee', letterSpacing: '0.15em' }}>
            ◉ {channel.name}
          </span>
        </div>
      )}

      {/* Center content area */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Available stream notifications — one per sharer, excluding local user's own share */}
        {availableSharers.filter(cs => cs !== (JSON.parse(localStorage.getItem('specter_user') || '{}')?.callsign || '')).map(cs => (
          <div
            key={cs}
            className="flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors"
            style={{ background: '#041e2e', borderBottom: '1px solid #0e2233' }}
            onClick={() => subscribeToRemoteStream(cs)}
          >
            <span style={{ fontSize: 13, color: '#22d3ee', letterSpacing: '0.15em', flex: 1 }}>
              ◉ {cs} IS SHARING — CLICK TO WATCH
            </span>
            <button
              className="px-3 py-1 border text-xs uppercase tracking-widest font-mono border-specter-primary-cyan text-specter-primary-cyan hover:bg-specter-primary-cyan/10 transition-colors"
            >
              {watchingSharer === cs ? '[ Watching ]' : '[ Watch ]'}
            </button>
          </div>
        ))}

        {/* Stream viewer — fills center panel edge-to-edge */}
        {isWatching && remoteShare && !overlayActive && (
          <div className="relative flex-1 overflow-hidden" style={{ background: '#000', minHeight: 0 }}>
            {/* Canvas fills the full panel; frame is letterboxed inside it */}
            <canvas
              ref={el => { remoteCanvasRef.current = el; onStreamCanvas?.(el); }}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
            />
            {/* Stop button */}
            <button
              onClick={unsubscribeFromStream}
              className="absolute top-2 right-2 px-2 py-1 border text-xs font-mono uppercase tracking-widest border-specter-state-error text-specter-state-error bg-black/70 hover:bg-specter-state-error/20 transition-colors rounded"
            >
              ✕
            </button>
            {/* Sharer label */}
            <div className="absolute bottom-2 left-2 px-2 py-0.5 text-xs font-mono rounded" style={{ background: 'rgba(0,0,0,0.7)', color: '#22d3ee', letterSpacing: '0.1em' }}>
              {remoteShare.user_id}
            </div>
            {/* Voice roster — semi-transparent overlay bottom-right */}
            <div className="absolute bottom-2 right-10 flex gap-1.5 items-center flex-wrap justify-end" style={{ maxWidth: '60%' }}>
              {roster.map(r => (
                <div key={r} className="flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: 'rgba(0,0,0,0.65)' }}>
                  <div className="w-1.5 h-1.5 rounded-full" style={{
                    background: isSpeaking && r === (JSON.parse(localStorage.getItem('specter_user') || '{}')?.callsign) ? '#22c55e' : '#0e7490',
                  }} />
                  <span style={{ fontSize: 10, color: '#e5e7eb', fontFamily: 'monospace' }}>{r}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Watching but no frames yet (connecting) */}
        {isWatching && !remoteShare && !overlayActive && (
          <div className="flex-1 flex items-center justify-center" style={{ background: '#020810' }}>
            <span style={{ fontSize: 13, color: '#22d3ee', letterSpacing: '0.2em' }}>
              CONNECTING TO STREAM...
            </span>
          </div>
        )}

        {/* Remote share canvas (hidden — used by processVideoData) */}
        {!isWatching && remoteShare && (
          <canvas ref={remoteCanvasRef} className="hidden" />
        )}

        {/* Local screen share preview (small overlay when sharing) */}
        {/* Browser path: <video>; Tauri path: <canvas> updated by specter://capture-preview */}
        <video
          ref={videoRef}
          className={isSharing && !usingTauriCapture && !overlayActive ? 'absolute bottom-2 right-2 z-10 w-48 border border-specter-primary-dim rounded' : 'hidden'}
          autoPlay playsInline muted
        />
        <canvas
          ref={capturePreviewCanvasRef}
          className={isSharing && usingTauriCapture && !overlayActive ? 'absolute bottom-2 right-2 z-10 w-48 border border-specter-primary-dim rounded' : 'hidden'}
          style={{ imageRendering: 'pixelated' }}
        />

        {/* Source picker modal — monitors + application windows with live thumbnails.
            Portal'd to document.body: CommLink's own root is `position:absolute,
            zIndex:1` (see WarRoom.jsx), which forms its own stacking context —
            this modal's z-50 is meaningless outside that context, so WarRoom's
            zIndex:2 "Center content" wrapper (a sibling of CommLink, not a
            descendant) was painting over the modal's header/close button instead
            of the modal covering the app. A portal escapes CommLink's stacking
            context entirely instead of trying to out-number it. */}
        {sourcePickerState && createPortal(
          <SourcePickerModal
            sources={sourcePickerState.sources}
            onSelect={(source) => { setSourcePickerState(null); sourcePickerState.resolve(source); }}
            onCancel={() => { setSourcePickerState(null); sourcePickerState.resolve(null); }}
          />,
          document.body
        )}
      </div>
    </div>
  );
};

export default CommLink;
