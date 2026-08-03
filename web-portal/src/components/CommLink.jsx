import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import initWasm, { SFrameCrypto } from 'wasm-crypto';
import { saveChannelMessage, getChannelMessages } from '../messageStore';
import { ensureChannelGroup, exportGroupSecret, ensureEventGroup, signBytes, verifySignature } from '../mlsSession';

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

// ── Protobuf helpers for specter.v1.AudioFrame ────────────────────────────────
// Manual proto3 encoding — avoids adding a full protobuf runtime to the bundle.
// Fields encoded: encrypted_payload (1, bytes), ssrc (2, uint32), sequence (3, int32)

function writeVarint(buf, value) {
  value = value >>> 0;
  while (value > 0x7f) {
    buf.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  buf.push(value & 0x7f);
}

function encodeAudioFrameProto(ssrc, seqNum, opusBytes, isGlobalBroadcast = false, senderSignature = null) {
  const parts = [];
  // Field 1: encrypted_payload (bytes) — tag 0x0A
  parts.push(0x0a);
  writeVarint(parts, opusBytes.length);
  for (let i = 0; i < opusBytes.length; i++) parts.push(opusBytes[i]);
  // Field 2: ssrc (uint32) — tag 0x10
  parts.push(0x10);
  writeVarint(parts, ssrc >>> 0);
  // Field 3: sequence (int32) — tag 0x18
  parts.push(0x18);
  writeVarint(parts, seqNum >>> 0);
  // Field 4: is_global_broadcast (bool) — tag 0x20. Only written when true
  // (proto3 default is false either way, omitting keeps the common-case frame
  // a few bytes smaller). Marks a priority speaker's cascade-encrypted copy —
  // see media-rust's relay path.
  if (isGlobalBroadcast) {
    parts.push(0x20);
    writeVarint(parts, 1);
  }
  // Field 5: sender_signature (bytes) — tag 0x2A. Ed25519 signature over
  // encrypted_payload (see mlsSession.js's signBytes) — proves this exact
  // ciphertext came from this specific device, on top of (not instead of)
  // SFrame's own AEAD confidentiality/integrity. Only written when relay mode
  // has a signature ready (see voiceRelayModeRef gating at the call site).
  if (senderSignature && senderSignature.length > 0) {
    parts.push(0x2a);
    writeVarint(parts, senderSignature.length);
    for (let i = 0; i < senderSignature.length; i++) parts.push(senderSignature[i]);
  }
  return new Uint8Array(parts);
}

function decodeAudioFrameProto(bytes) {
  let pos = 0;
  let opusBytes = null;
  let ssrc = 0;
  let sequence = 0;
  let isGlobalBroadcast = false;
  let senderSignature = null;
  while (pos < bytes.length) {
    let tag = 0, shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      let val = 0; shift = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        val |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      if (fieldNumber === 2) ssrc = val >>> 0;
      else if (fieldNumber === 3) sequence = val >>> 0;
      else if (fieldNumber === 4) isGlobalBroadcast = val !== 0;
    } else if (wireType === 2) {
      let len = 0; shift = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const data = bytes.slice(pos, pos + len);
      pos += len;
      if (fieldNumber === 1) opusBytes = data;
      else if (fieldNumber === 5) senderSignature = data;
    } else {
      break;
    }
  }
  return { opusBytes, ssrc, sequence, isGlobalBroadcast, senderSignature };
}

function hashUserId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) >>> 0;
}
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

// Backpressure-aware sender for a video NAL relay stream: at most one write in
// flight and at most one frame queued behind it (always the freshest). Without
// this, each NAL event handler independently awaits its own writer.write() call
// with no coordination — under a congested/slow QUIC stream, writes pile up
// unboundedly (the WHATWG streams spec queues them internally with no bound),
// so latency only grows and the video keeps "buffering" further behind live.
// A dropped delta frame breaks the GOP's P-frame reference chain, so once one
// is dropped every subsequent delta is dropped too (needsResync) until the next
// keyframe — mirroring the identical resync pattern already used by the
// receiver (processVideoData) and by media-rust's subscriber relay loops.
// `onDrop`, if given, fires once per delta frame dropped due to backpressure —
// used as the congestion signal for real-time bitrate adaptation (see
// startScreenShare). Optional so the overlay/self-view pump (which has no
// adaptation hooked up) can omit it.
function createVideoSendPump(writerRef, onDrop) {
  let queued = null;
  let sending = false;
  let needsResync = false;

  const pump = async () => {
    if (sending) return;
    sending = true;
    try {
      while (queued) {
        const frameBuf = queued;
        queued = null;
        try { await writerRef.current.write(frameBuf); } catch { break; }
      }
    } finally {
      sending = false;
    }
  };

  return function submit(frameBuf, isKeyframe) {
    if (sending) {
      if (!isKeyframe) { needsResync = true; onDrop?.(); return; }
      queued = frameBuf; // keyframe always wins — becomes the sole pending item
      needsResync = false;
    } else {
      if (needsResync) {
        if (!isKeyframe) { onDrop?.(); return; }
        needsResync = false;
      }
      queued = frameBuf;
    }
    pump();
  };
}

// Matches OVERLAY_MAX_DECODE_QUEUE in GameOverlayWindow.jsx — same rationale:
// WebCodecs has no built-in way to skip ahead once its internal decode queue
// backs up, so past this depth, drop non-key frames until the next keyframe
// rather than letting a struggling machine fall further behind on every tick.
const MAIN_MAX_DECODE_QUEUE = 2;

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
  if (concurrentSharers >= 2) {
    return {
      ...base,
      fps: Math.min(base.fps, 30),
      bitrate: Math.min(base.bitrate, 6_000_000),
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

const CommLink = ({ org, channel, onBack, embedded = false, onRosterChange, onSpeakingChange, onSharersChange, watchStreamTarget, onWatchFailed, onStreamCanvas, onMuteChange, onLocalLevelChange, onRemoteLevelsChange, onSharingChange, externalControlsRef, hideMuteButton, overlayActive = false, channelVolume = 1.0, onRelayRef, localMutedUserIds, onConnectionQualityChange }) => {
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

  // Instance of our Rust WASM Cryptography bindings
  const cryptoRef = useRef(null);
  // Same primitive, independent 'audio'-labeled MLS export — derived and kept
  // fresh alongside cryptoRef/refreshVideoKey below, but not yet wired into the
  // actual audio send/receive path: media-rust still mixes voice server-side
  // (see voiceEncryptionEnabled above), so encrypting frames now would just
  // break playback against a mixer expecting plain Opus. This ref exists so the
  // key is ready and rotating correctly before the relay path that consumes it
  // ships.
  const cryptoAudioRef = useRef(null);
  // Event-scoped cascade key (see mlsSession.js's ensureEventGroup) — only
  // derived when this channel belongs to an event (channel.event_id set).
  // Used for the priority-speaker cross-channel cascade path (Track B), not
  // this channel's own audio.
  const cryptoAudioCascadeRef = useRef(null);
  // ssrc (number) -> user_id, from the server's RosterMessage::SsrcMap — the
  // authoritative mapping for attributing an incoming relay-mode audio lane to
  // a real speaker (a client can't independently recompute another user's
  // hashUserId, since it only knows their callsign, not their true user_id).
  // Unused until the per-lane playback refactor consumes it; harmless to keep
  // populated in mixed-mode rooms too, where every audio datagram is still
  // server-mixed to ssrc=0 regardless.
  const ssrcToUserIdRef = useRef(new Map());
  // Whether the CURRENT channel's media-rust room is running the E2E relay
  // path (per-sender SFrame-encrypted, see media-rust's RoomState::voice_relay_mode)
  // vs. today's server-mixed TLS-only voice. Set from the org-token response
  // (data.voice_relay) at the top of connect(), before any audio is sent —
  // encrypting into a still-mixed-mode room would break voice for everyone in
  // it, so every encrypt-on-send/decrypt-on-receive call below is gated on this.
  const voiceRelayModeRef = useRef(false);
  // Relay-mode ducking state, driven by the server's RosterMessage::Duck /
  // DuckRelease (see main.rs's relay-mode ducking block) — replaces the old
  // "server scales PCM gain" approach, which is impossible once the server
  // never decodes audio. Every lane except the active speaker's own gets
  // attenuated; see applyDuckState below for where this is actually consumed
  // by both playback paths.
  const duckStateRef = useRef({ active: false, activeSsrc: null, level: 0 });
  // Matches the proto's PriorityLevel comment (specter.proto): tier 1
  // ("-MAX dB") is near-silence, tier 2 ("-20dB") mirrors the legacy 0.1 gain
  // already used elsewhere in this file for the old single-bus duck.
  const duckGainForLevel = (level) => (level <= 1 ? 0.05 : 0.1);
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

  // Cache Tauri invoke import so high-frequency paths (audio playback) do not
  // allocate a new dynamic-import promise per frame.
  const tauriInvokeRef = useRef(null);
  const ensureTauriInvoke = async () => {
    if (tauriInvokeRef.current) return tauriInvokeRef.current;
    const { invoke } = await import('@tauri-apps/api/core');
    tauriInvokeRef.current = invoke;
    return invoke;
  };

  const connect = async () => {
    traceLog(`CommLink connect() called for channelRef.current.id=${channelRef.current?.id} name=${channelRef.current?.name}`);
    // Any call to connect() — manual, auto-connect-on-mount, or one of our own
    // scheduled retries — represents a fresh attempt to be back online, so a
    // future unexpected drop should be free to auto-recover again.
    intentionalDisconnectRef.current = false;
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    setStatus('connecting');
    addMsg(`Initiating handshake with ${org.callsign} [${channelRef.current.name}]...`);

    // Voice is mixed server-side by media-rust (priority ducking needs plaintext
    // PCM to mix), which is fundamentally incompatible with E2E without dropping
    // that feature — so voice stays TLS-on-WebTransport only. Video is a pure
    // relay server-side (media-rust never decodes it), so it's keyed from this
    // channel's real MLS group below instead.
    const voiceEncryptionEnabled = false;

    try {
      // Initialize WASM cryptography engine for this session (non-fatal — video
      // just stays unencrypted, same as voice, if this fails or the MLS group
      // can't be established for any reason)
      try {
        await initWasm();
        const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
        await ensureChannelGroup(api, currentUserId, org.id, channelRef.current.id);
        const videoKey = await exportGroupSecret(api, currentUserId, channelRef.current.id, 'video', 32);
        cryptoRef.current = new SFrameCrypto(videoKey);
        // Independent key, same group/epoch, 'audio' label — see cryptoAudioRef's
        // doc comment for why this isn't used to encrypt anything yet.
        const audioKey = await exportGroupSecret(api, currentUserId, channelRef.current.id, 'audio', 32);
        cryptoAudioRef.current = new SFrameCrypto(audioKey);
        // Event-scoped cascade key — only relevant for event channels (priority
        // ducking/cascade doesn't exist for casual channels, see orgController.ts's
        // getOrgToken). Best-effort: a casual channel or a brand-new event whose
        // group hasn't reconciled yet just leaves this null, same non-fatal
        // pattern as the rest of this block.
        if (channel?.event_id) {
          await ensureEventGroup(api, currentUserId, org.id, channel.event_id);
          const cascadeKey = await exportGroupSecret(api, currentUserId, channel.event_id, 'audio-cascade', 32);
          cryptoAudioCascadeRef.current = new SFrameCrypto(cascadeKey);
        }
        addMsg('WASM Cryptography Engine Initialized (ChaCha20Poly1305, MLS-derived key)');
      } catch (err) {
        console.warn('WASM SFrame init failed (non-fatal, video E2E is disabled):', err);
        addMsg('WASM Crypto unavailable (non-fatal, video runs over TLS only).', 'system');
      }
      
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

      // 1. Get Token
      const { data, error } = await api.getOrgToken(org.id, channelRef.current.id);
      if (error) throw new Error(error);
      const token = data.token;
      const mediaUrl = data.media_url || 'https://localhost:4434';
      mediaUrlRef.current = mediaUrl;
      voiceRelayModeRef.current = data.voice_relay === true;
      
      addMsg('Token acquired: ' + token.substring(0, 10) + '...');

      // 2. Connect WebTransport
      // Make sure the mediaUrl has no trailing slash before appending /specter
      const base = mediaUrl.replace(/\/$/, '');
      const url = `${base}/specter?token=${token}&channel_id=${channelRef.current.id}`;
      const transport = new WebTransport(url);
      transportRef.current = transport;

      await transport.ready;
      setStatus('connected');
      // Reset backoff now that we're actually back online — otherwise a
      // connection that fails again much later (unrelated to this streak)
      // would inherit an already-escalated delay instead of starting fresh.
      reconnectAttemptRef.current = 0;
      // Bound the outgoing datagram queue: without this, a stalled/slow-ACKing
      // connection lets audio frames queue indefinitely (no expiry by default),
      // so delay only grows and never recovers — worst under low/steady traffic,
      // where nothing else forces the congestion window open. Capping the queue
      // to ~4 frames (80ms) and expiring anything older than 200ms means a stale
      // frame gets dropped instead of piling up behind it.
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
      // Clear any "not connected" mic error that fired while transport was connecting.
      setMicError(null);
      // Tell the mixer our preferred activation threshold right away so it applies
      // from the first frame instead of defaulting to 150 until the user drags the slider.
      sendAudioThreshold(micThreshold);
      addMsg('Uplink established. Channel secure.');
        // Register presence so all org members can see who is in this channel
        api.joinChannelPresence(org.id, channelRef.current.id).catch(() => {});
        // Keep channel presence fresh so abrupt closes are auto-cleaned server-side.
        if (presenceHeartbeatRef.current) clearInterval(presenceHeartbeatRef.current);
        presenceHeartbeatRef.current = setInterval(() => {
          api.pingChannelPresence(org.id, channelRef.current.id).catch(() => {});
        }, 20_000);
      readDatagrams(transport);
      readIncomingStreams(transport); // Roster + Video streams
      monitorClosure(transport);

    } catch (err) {
      console.error(err);
      setStatus('error');
      addMsg(`Connection failed: ${err.message}`, 'error');
      // Failed before monitorClosure was ever attached (token fetch, WebTransport
      // handshake, etc.) — that path won't fire on its own, so retry from here.
      if (!intentionalDisconnectRef.current) recordConnectionDrop();
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
              }
          }
      } else if (msg.type === 'Leave') {
          setRoster(prev => {
              const updated = prev.filter(u => u !== msg.data);
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
          setRemoteLevels(prev => ({ ...prev, [callsign]: { level, ts: now } }));
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

  const refreshVideoKey = async () => {
      try {
          const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
          const videoKey = await exportGroupSecret(api, currentUserId, channelRef.current.id, 'video', 32);
          cryptoRef.current = new SFrameCrypto(videoKey);
      } catch (err) {
          console.error("Video key refresh failed", err);
      }
  };

  // Same opportunistic re-derive as refreshVideoKey, kept separate since it's
  // a different label/key — see cryptoAudioRef's doc comment.
  const refreshAudioKey = async () => {
      try {
          const currentUserId = JSON.parse(localStorage.getItem('specter_user') || '{}')?.id;
          const audioKey = await exportGroupSecret(api, currentUserId, channelRef.current.id, 'audio', 32);
          cryptoAudioRef.current = new SFrameCrypto(audioKey);
      } catch (err) {
          console.error("Audio key refresh failed", err);
      }
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

  const processVideoData = async (reader, initialBytes, session = videoSessionRef.current) => {
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
      return;
    }
    console.log('[video] stream header received:', JSON.stringify(header));
    buffer = buffer.slice(4 + headerLen);

    if (typeof VideoDecoder === 'undefined') {
      addMsg('Remote screen share detected but WebCodecs unavailable.', 'error');
      return;
    }

    setRemoteShare(header);

    const codec = header.codec || 'vp8';
    const isH264 = codec.startsWith('avc1') || codec.startsWith('avc3');

    // Store header so we can re-send it if the overlay opens mid-stream.
    // NOTE: We no longer fire a separate header-only emit here.  Instead the header
    // is sent atomically with each keyframe in the relay loop below — this guarantees
    // the overlay decoder is always (re-)configured before its first keyframe arrives,
    // eliminating the race where a stale separate header arrives after the keyframe.
    remoteStreamHeaderRef.current = { codec, width: header.width, height: header.height };

    let framesRelayed = 0;
    let framesDecoded = 0;
    let stallWarned = false;
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
    let mainNeedsResync = false;

    const decoder = new VideoDecoder({
      output: (frame) => {
        if (videoSessionRef.current !== session) { frame.close(); return; }
        const pendingKey = frame.timestamp;
        const enqueuedAt = decodePendingRef.current.get(pendingKey);
        if (typeof enqueuedAt === 'number') {
          decodePendingRef.current.delete(pendingKey);
          const stats = videoStageStatsRef.current;
          stats.decodeCount += 1;
          stats.decodeMs += (performance.now() - enqueuedAt);
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
        addMsg(`Stream decode error: ${e?.message || e} — sharer may need to restart their share.`, 'error');
      }
    });
    try {
      decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    } catch (cfgErr) {
      console.error('[processVideoData] decoder.configure failed for codec', codec, cfgErr);
      if (window.__TAURI__) import('@tauri-apps/api/event').then(({ emit }) => emit('overlay-video-status', { message: `Decoder config failed: ${cfgErr?.message || cfgErr}` })).catch(() => {});
      return;
    }

    // Read frames: [4B frame_size][1B type][4B timestamp_ms][data]
    let _firstFrameLogged = false;
    try {
      while (true) {
        while (buffer.length < 4) if (!(await readMore())) throw 'eof';
        const frameSize = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
        if (frameSize === 0) break;
        while (buffer.length < 4 + frameSize) if (!(await readMore())) throw 'eof';

        const frameType = buffer[4] === 0 ? 'key' : 'delta';
        const tsMs = new DataView(buffer.buffer, buffer.byteOffset + 5, 4).getUint32(0);
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
        // only this [size][type][timestamp] header plus opaque bytes. A
        // decrypt failure (stale key mid-rotation, or crypto init failed and
        // the sender never encrypted at all) drops just this one frame rather
        // than feeding garbage into the decoder.
        let frameUndecryptable = false;
        if (cryptoRef.current) {
          try {
            frameData = cryptoRef.current.decrypt(frameData);
          } catch (err) {
            frameUndecryptable = true;
          }
        }
        if (!frameUndecryptable) {
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
        if (overlayActiveRef.current) {
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
          } else {
            mainNeedsResync = false;
            const timestampUs = tsMs * 1000;
            const chunk = new EncodedVideoChunk({ type: frameType, timestamp: timestampUs, data: frameData });
            if (decoder.state !== 'closed') {
              decodePendingRef.current.set(timestampUs, performance.now());
              decoder.decode(chunk);
            }
          }
        }
        } // !frameUndecryptable
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

        if (!frameUndecryptable) {
        // Relay raw H.264 NAL bytes to overlay for its own decoder — no extra
        // network cost, just local IPC. Overlay decodes at native stream quality.
        // On keyframes we re-send the header atomically (same .then() callback) so
        // the overlay decoder is always re-configured before the keyframe arrives,
        // eliminating the race condition where delta frames reach the overlay before
        // the header and leave decoderSyncedRef permanently false.
        if (overlayActiveRef.current && window.__TAURI__) {
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
        if (!overlayActiveRef.current && !stallWarned && framesRelayed === 30 && framesDecoded === 0) {
          stallWarned = true;
          const stallMsg = 'No video output after 30 frames — streamer may need to STOP and RESTART share.';
          addMsg(stallMsg, 'error');
          console.warn('[video] stall detected: relayed=', framesRelayed, 'decoded=', framesDecoded);
          if (window.__TAURI__) {
            import('@tauri-apps/api/event').then(({ emit }) => {
              emit('overlay-video-status', { message: 'No signal — streamer must restart share' });
            }).catch(() => {});
          }
        }
        } // !frameUndecryptable
      }
    } catch {}
    if (decoder.state !== 'closed') decoder.close();
    decodePendingRef.current.clear();
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
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [micError, setMicError] = useState(null);
  const [comsFilterEnabled, setComsFilterEnabled] = useState(localStorage.getItem('specter_audio_coms_filter') === 'true');
  const [localLevel, setLocalLevel] = useState(0); // 0-100 mic amplitude
  const [remoteLevels, setRemoteLevels] = useState({}); // { [callsign]: { level: 0-100, ts: number } }
  // Rolling log of 'Speaking' events (not just the latest snapshot like
  // remoteLevels above) — feeds voice misconduct reports with a real,
  // server-computed "who was actually talking, and when" timeline. Bounded
  // to the same ~15-minute window as the native MisconductReportBuffer;
  // see submitVoiceReport below for how it's consumed.
  const speakingHistoryRef = useRef([]); // [{ callsign, level, ts }]
  const SPEAKING_HISTORY_WINDOW_MS = 15 * 60 * 1000;
  const [micRms, setMicRms] = useState(0); // raw PCM RMS (0-32767ish scale) from the Rust capture callback
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
  const captureOverlayUnlistenRef = useRef(null);
  const capturePreviewUnlistenRef = useRef(null);
  const capturePreviewCanvasRef = useRef(null);
  const overlayShareStreamRef = useRef(null);
  const stopShareInProgressRef = useRef(false);
  // Real-time bitrate adaptation state for the native capture path — see
  // startScreenShare. Null when not sharing / not applicable (browser fallback
  // uses VideoEncoder.configure() reconfiguration instead, no ref needed there).
  const adaptiveBitrateRef = useRef(null);
  const sequenceRef = useRef(0);
  // Playback backpressure guards for Tauri invoke bridge.
  const playFrameInFlightRef = useRef(0);
  const playFrameDroppedRef = useRef(0);
  const outputFallbackAttemptedRef = useRef(false);
  // Browser-path (non-Tauri) playback: one independent lane per incoming ssrc,
  // keyed exactly like seenSequencesRef below (the pre-existing per-ssrc
  // dedup map this mirrors). Each lane owns its own Opus decoder (Opus decode
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
  // Sequence deduplication: tracks last 64 sequence numbers per SSRC to drop duplicate datagrams.
  const seenSequencesRef = useRef(new Map()); // Map<ssrc, { set: Set<number>, queue: number[] }>

  // Audio Mixer Refs
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const duckingGainRef = useRef(null);
  // Tracks the current channel volume for both Web Audio and Tauri paths.
  const channelVolumeRef = useRef(channelVolume);
  const cleanGainRef = useRef(null);
  const radioGainRef = useRef(null);
  const noiseGainRef = useRef(null);
  const noiseTimeoutRef = useRef(null);
  const duckingTimeoutRef = useRef(null);

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
      // Simulate Priority Ducking (-20dB equivalent = ~0.1 gain)
      if (duckingGainRef.current && audioCtxRef.current) {
          const now = audioCtxRef.current.currentTime;
          setIsDucking(true);
          // Rapid duck (100ms fade)
          duckingGainRef.current.gain.setTargetAtTime(0.1, now, 0.1); 

          // Auto-release after 2 seconds of silence (simulated envelope release)
          if (duckingTimeoutRef.current) clearTimeout(duckingTimeoutRef.current);
          duckingTimeoutRef.current = setTimeout(() => {
              const releaseNow = audioCtxRef.current.currentTime;
              // Smooth release over 500ms
              duckingGainRef.current.gain.setTargetAtTime(1.0, releaseNow, 0.5);
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
        const decryptKey = frame.isGlobalBroadcast ? cryptoAudioCascadeRef.current : cryptoAudioRef.current;
        if (voiceRelayModeRef.current && decryptKey) {
          try {
            frame.opusBytes = decryptKey.decrypt(frame.opusBytes);
          } catch (e) {
            console.warn('[Audio] decrypt failed, dropping frame:', e);
            continue;
          }
        }

        // Sequence deduplication: drop frames with a sequence number we've seen recently
        // (rolling window of last 64 per SSRC). Guards against double-play from multi-path.
        {
          const ssrcKey = frame.ssrc >>> 0;
          // ssrc=0 = server-mixed stream (proto3 default for unset field).
          // Do NOT dedupe this path; mixer packets may reuse sequence values.
          if (ssrcKey !== 0) {
            if (!seenSequencesRef.current.has(ssrcKey)) {
              seenSequencesRef.current.set(ssrcKey, { set: new Set(), queue: [] });
            }
            const tracker = seenSequencesRef.current.get(ssrcKey);
            if (tracker.set.has(frame.sequence)) continue; // duplicate — skip
            tracker.queue.push(frame.sequence);
            tracker.set.add(frame.sequence);
            if (tracker.queue.length > 64) tracker.set.delete(tracker.queue.shift());
          }
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
          const laneStreamId = `${channelRef.current.id}:${frame.ssrc >>> 0}`;
          activeNativeLaneIdsRef.current.add(laneStreamId);
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
    if (captureOverlayUnlistenRef.current) {
      captureOverlayUnlistenRef.current();
      captureOverlayUnlistenRef.current = null;
    }
    if (capturePreviewUnlistenRef.current) {
      capturePreviewUnlistenRef.current();
      capturePreviewUnlistenRef.current = null;
    }
    if (overlayShareStreamRef.current) {
      safeCloseWriter(overlayShareStreamRef.current);
      overlayShareStreamRef.current = null;
    }
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
    seenSequencesRef.current = new Map();
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

  const handleMicThresholdChange = (value) => {
    setMicThreshold(value);
    localStorage.setItem('specter_audio_threshold', String(value));
    sendAudioThreshold(value);
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

    const { data } = await api.getOrgToken(org.id, channel.id);
    const base = (mediaUrlRef.current || data.media_url).replace(/\/$/, '');
    const pubUrl = `${base}/specter/video?token=${data.token}&channel_id=${channel.id}&role=publish`;
    const vt = new WebTransport(pubUrl);
    publishTransportRef.current = vt;
    await vt.ready;

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
    const header = JSON.stringify({
      codec, width: w, height: h,
      user_id: user.id || user.user_id || user.callsign || 'Unknown',
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
        if (cryptoRef.current) {
          try {
            data = cryptoRef.current.encrypt(rawData);
          } catch (err) {
            console.warn('[share] video frame encryption failed, sending unencrypted:', err);
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

    submitVideoFrame = createVideoSendPump(writerRef, onVideoFrameDropped);

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
          const isKeyframeSlot = fc % gop === 0;
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

  const startScreenShare = async () => {
    if (isSharing) { stopScreenShare(); return; }
    const isTauriWindows = window.__TAURI__ && navigator.userAgent.toLowerCase().includes('windows');
    // Browser getDisplayMedia on Tauri shows a system "tauri.localhost is sharing"
    // banner. Keep native capture as the default and allow browser fallback only
    // when explicitly requested via localStorage for troubleshooting.
    const forceBrowserCaptureOnWindows = isTauriWindows && localStorage.getItem('specter_capture_mode') === 'browser-fallback';
    if (isTauriWindows && !forceBrowserCaptureOnWindows) {
      try {
        const orgTier = org?.tier ?? 0;
        const concurrentSharers = Math.max(1, (availableSharersRef.current?.length || 0) + 1);
        const profile = getEffectiveStreamProfile(orgTier, concurrentSharers);

        // Enumerate sources (monitors + windows) and show picker
        addMsg('Enumerating capture sources…', 'system');
        const sources = await window.__TAURI__.core.invoke('capture_list_sources');
        if (!sources || sources.length === 0) {
          addMsg('No capture sources found.', 'error');
          return;
        }
        const selectedSource = await new Promise(resolve => {
          setSourcePickerState({ sources, resolve });
        });
        if (!selectedSource) return; // user cancelled

        const effectiveSource = selectedSource;

        const { data } = await api.getOrgToken(org.id, channel.id);
        const base = (mediaUrlRef.current || data.media_url).replace(/\/$/, '');
        const pubUrl = `${base}/specter/video?token=${data.token}&channel_id=${channel.id}&role=publish`;
        console.log('[share] publish transport connecting, base=', base);
        const vt = new WebTransport(pubUrl);
        publishTransportRef.current = vt;
        await vt.ready;
        console.log('[share] publish transport ready');

        // Listen for activation signals from the server on the publish transport.
        // 0xAC = a viewer subscribed (go live), 0xDE = last viewer left (keepalive mode).
        captureActiveRef.current = false;
        lastKeyframeSentRef.current = 0;
        (async () => {
          try {
            const reader = vt.incomingUnidirectionalStreams.getReader();
            while (true) {
              const { value: stream, done } = await reader.read();
              if (done) break;
              const sr = stream.getReader();
              try {
                const { value: bytes } = await sr.read();
                if (bytes?.length > 0) {
                  if (bytes[0] === 0xAC) { captureActiveRef.current = true; captureNeedsKeyframeRef.current = true; console.log('[share] activated by viewer'); }
                  else if (bytes[0] === 0xDE) { captureActiveRef.current = false; console.log('[share] deactivated — no viewers'); }
                }
              } finally { sr.releaseLock(); }
            }
          } catch {}
        })();

        const uniStream = await vt.createUnidirectionalStream();
        const writer = uniStream.getWriter();
        shareStreamRef.current = writer;
        await writer.write(new Uint8Array([0x02]));
        const user = JSON.parse(localStorage.getItem('specter_user') || '{}');
        // Use the actual encoded dimensions (profile.width/height) not the source capture
        // dimensions — the server and viewer decoder need the encoded resolution.
        // probeVideoCodec returns the best hardware-accelerated H.264 codec string the
        // viewer's browser supports (avc1.640033 = High Profile L5.1 on modern drivers);
        // this must match what NVENC actually encodes (High Profile by default).
        const tauriCodec = await probeVideoCodec(profile.width, profile.height, profile.fps);
        console.log('[share] probeVideoCodec result:', tauriCodec, 'profile=', profile, 'concurrentSharers=', concurrentSharers);
        const tauriHeader = {
          codec: tauriCodec, width: profile.width, height: profile.height,
          user_id: user.id || user.user_id || user.callsign || 'Unknown',
          stream_type: 'full',
        };
        // Store codec/dims so the overlay VideoDecoder can be seeded if self-view
        // is selected after capture is already running.
        captureHeaderRef.current = { codec: tauriHeader.codec, width: tauriHeader.width, height: tauriHeader.height };
        const header = JSON.stringify(tauriHeader);
        const headerBytes = new TextEncoder().encode(header);
        const hlenBuf = new ArrayBuffer(4);
        new DataView(hlenBuf).setUint32(0, headerBytes.length);
        await writer.write(new Uint8Array(hlenBuf));
        await writer.write(headerBytes);
        console.log('[share] header written to server:', JSON.stringify(tauriHeader));

        console.log('[share] calling capture_start...');
        await window.__TAURI__.core.invoke('capture_start', {
          // Flat profile.bitrate for the hard-capped 1080p output resolution — not
          // scaled up for high-res source monitors (e.g. 4K), since the encode
          // target is downscaled to the same 1080p either way and a weak
          // connection on a 4K monitor shouldn't pay extra bits for zero extra
          // quality. Native capture is always at the monitor's full resolution
          // (DXGI/WGC don't support a lower-res request) — enc_dims() on the Rust
          // side downscales to max_height via GPU VideoProcessorBlt before
          // NVENC/AMF sees it.
          config: {
            source_id: effectiveSource.id,
            fps: profile.fps,
            bitrate: profile.bitrate,
            max_height: profile.height,
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
              config: { source_id: effectiveSource.id, fps: profile.fps, bitrate: newBitrate, max_height: profile.height },
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
            return;
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
        const submitVideoFrame = createVideoSendPump(shareStreamRef, onVideoFrameDropped);
        const unlistenNal = await listen('specter://capture-nal', async (event) => {
          const { data_b64, is_keyframe, timestamp_ms } = event.payload;
          if (!_nalLoggedOnce && is_keyframe) {
            _nalLoggedOnce = true;
            if (captureWatchdogRef.current) { clearTimeout(captureWatchdogRef.current); captureWatchdogRef.current = null; }
            const bin = atob(data_b64); console.log('[share] first keyframe NAL arrived, bytes=', bin.length, 'captureActive=', captureActiveRef.current);
          }

          // Self-view must stay low-latency even when there are no remote viewers.
          // Relay to overlay BEFORE network keepalive gating so local preview never
          // waits for the 10s keyframe throttle.
          if (overlayActiveRef.current && overlayWantsSelfViewRef.current && window.__TAURI__) {
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
          const bin = atob(data_b64);
          const nalData = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) nalData[i] = bin.charCodeAt(i);
          // Encrypt with this channel's MLS-derived key before it leaves this
          // process — media-rust relays it opaquely (see cryptoRef/refreshVideoKey
          // above). The overlay self-view relay above uses nalData pre-encryption
          // deliberately: that's local Tauri IPC to this same device, never
          // touching the network or media-rust.
          let payload = nalData;
          if (cryptoRef.current) {
            try {
              payload = cryptoRef.current.encrypt(nalData);
            } catch (err) {
              console.warn('[share] video frame encryption failed, sending unencrypted:', err);
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

        // Open overlay uni stream (0x03) for simulcast low-res stream
        // The codec string is determined by the Rust encoder (hevc_nvenc or h264_nvenc fallback)
        // and emitted via specter://overlay-codec before the first NAL, so we wait for it.
        try {
          const overlayUniStream = await vt.createUnidirectionalStream();
          const overlayWriter = overlayUniStream.getWriter();
          overlayShareStreamRef.current = overlayWriter;
          await overlayWriter.write(new Uint8Array([0x03]));

          // Map encoder codec name → WebCodecs codec string
          const toWebCodecsCodec = (name) => {
            if (name === 'hevc_nvenc') return 'hev1.1.6.L120.90';
            return 'avc1.640033'; // h264_nvenc → High Profile L5.1 (must match NVENC default)
          };

          let overlayHeaderSent = false;
          let overlayCodecName = 'h264_nvenc';
          const sendOverlayHeader = async (codecName) => {
            if (overlayHeaderSent) return;
            overlayHeaderSent = true;
            const overlayHdr = JSON.stringify({
              codec: toWebCodecsCodec(codecName),
              width: 768, height: 432,
              user_id: user.id || user.user_id || user.callsign || 'Unknown',
              stream_type: 'overlay',
            });
            const overlayHdrBytes = new TextEncoder().encode(overlayHdr);
            const overlayHlenBuf = new ArrayBuffer(4);
            new DataView(overlayHlenBuf).setUint32(0, overlayHdrBytes.length);
            try {
              await overlayWriter.write(new Uint8Array(overlayHlenBuf));
              await overlayWriter.write(overlayHdrBytes);
            } catch {}
          };

          // Listen for codec announcement from Rust (emitted before first overlay NAL)
          const { listen: listenTauri } = await import('@tauri-apps/api/event');
          const unlistenCodec = await listenTauri('specter://overlay-codec', async (event) => {
            if (typeof event.payload === 'string' && event.payload.trim().length > 0) {
              overlayCodecName = event.payload.trim();
            }
            await sendOverlayHeader(overlayCodecName);
            unlistenCodec();
          });

          // Separate pump/queue from the main video stream above — its own
          // congestion state, distinct writer.
          const submitOverlayFrame = createVideoSendPump(overlayShareStreamRef);
          const unlistenOverlayNal = await listen('specter://capture-nal-overlay', async (event) => {
            // Fallback: if codec event races, use deterministic native default (h264_nvenc).
            if (!overlayHeaderSent) await sendOverlayHeader(overlayCodecName);
            const { data_b64, is_keyframe, timestamp_ms } = event.payload;
            const bin = atob(data_b64);
            const nalData = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) nalData[i] = bin.charCodeAt(i);
            // Same channel key as the main video stream above — this is a
            // second, independent network stream to the same server.
            let payload = nalData;
            if (cryptoRef.current) {
              try {
                payload = cryptoRef.current.encrypt(nalData);
              } catch (err) {
                console.warn('[simulcast] overlay frame encryption failed, sending unencrypted:', err);
              }
            }
            const frameSize = 1 + 4 + payload.length;
            const frameBuf = new ArrayBuffer(4 + frameSize);
            const v = new DataView(frameBuf);
            v.setUint32(0, frameSize);
            v.setUint8(4, is_keyframe ? 0 : 1);
            v.setUint32(5, timestamp_ms >>> 0);
            new Uint8Array(frameBuf, 9).set(payload);
            submitOverlayFrame(new Uint8Array(frameBuf), is_keyframe);
          });
          captureOverlayUnlistenRef.current = unlistenOverlayNal;
        } catch (ovErr) {
          console.warn('[simulcast] overlay stream setup failed:', ovErr);
        }

        // Listen for preview frames → draw to preview canvas
        const unlistenPreview = await listen('specter://capture-preview', (event) => {
          // When overlay self-view is active, avoid duplicate CPU conversion work
          // for the in-app preview canvas.
          if (overlayActiveRef.current && overlayWantsSelfViewRef.current) return;
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
      }
      return;
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
      if (captureOverlayUnlistenRef.current) {
        captureOverlayUnlistenRef.current();
        captureOverlayUnlistenRef.current = null;
      }
      if (overlayShareStreamRef.current) {
        safeCloseWriter(overlayShareStreamRef.current);
        overlayShareStreamRef.current = null;
      }
      if (capturePreviewUnlistenRef.current) {
        capturePreviewUnlistenRef.current();
        capturePreviewUnlistenRef.current = null;
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
    // Close any existing video transport
    if (videoTransportRef.current) {
      safeCloseTransport(videoTransportRef.current);
      videoTransportRef.current = null;
    }

    const { data } = await api.getOrgToken(org.id, channel.id);
    const base = (mediaUrlRef.current || data.media_url).replace(/\/$/, '');
    console.log('[subscribe] transport connecting, base=', base, 'sharer=', callsign);
    // Always subscribe to the full-res stream. The overlay window is fed via local IPC
    // (overlay-video-nal emit in processVideoData), so subscribe_overlay / simulcast is
    // not needed — and would silently stall when the sharer's overlay encoder isn't
    // running (e.g. CPU capture mode or D3D11VA overlay encoder init failure).
    const role = 'subscribe';
    const url = `${base}/specter/video?token=${data.token}&channel_id=${channel.id}&role=${role}&sharer=${encodeURIComponent(callsign)}`;

    const vt = new WebTransport(url);
    videoTransportRef.current = vt;
    await vt.ready;
    console.log('[subscribe] transport ready for sharer=', callsign);

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
      setIsWatching(false);
      setWatchingSharer(null);
      setRemoteShare(null);
      videoTransportRef.current = null;
      remoteStreamHeaderRef.current = null; // clear so a stale header isn't re-sent to a new overlay session
      gopBufferRef.current = [];             // clear GOP buffer — no longer valid after stream ends
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
          processVideoData(streamReader, firstChunk.slice(1), mySession);
        }
      }
    } catch (e) {
      if (e?.message === 'stream_timeout') {
        addMsg('Stream unavailable — sharer may have stopped.', 'error');
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
        setIsSpeaking(false);
        setLocalLevel(0);
        setMicRms(0);
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
      setIsSpeaking(false);
      setLocalLevel(0);
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
        // Seed the native send-gate with this session's current threshold before
        // capture starts — AudioState's default (150) may not match a value the
        // user previously set (persisted in localStorage/React state, not on the
        // Rust side) if the slider hasn't been touched yet this app launch.
        invoke('plugin:specter-audio|set_send_threshold', { value: micThresholdRef.current }).catch(() => {});
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
          const seq = sequenceRef.current++;
          // Only encrypt when the server actually relays instead of mixing —
          // see voiceRelayModeRef's doc comment. Falls back to plain Opus
          // (today's behavior) if encryption fails, same non-fatal pattern
          // used for video's cryptoRef.
          let payload = opusBytes;
          if (voiceRelayModeRef.current && cryptoAudioRef.current) {
            try {
              payload = cryptoAudioRef.current.encrypt(opusBytes);
            } catch (e) {
              console.warn('[Audio] encrypt failed, sending unencrypted:', e);
            }
          }
          // Signs the ciphertext actually being sent, not the raw Opus — proves
          // this exact frame came from this device, on top of (not instead of)
          // SFrame's own AEAD confidentiality/integrity. Best-effort: a signing
          // failure still sends the frame unsigned rather than dropping it, same
          // non-fatal philosophy as encryption above.
          let signature = null;
          if (voiceRelayModeRef.current) {
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
          if (voiceRelayModeRef.current && cryptoAudioCascadeRef.current) {
            try {
              const cascadePayload = cryptoAudioCascadeRef.current.encrypt(opusBytes);
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
          setMicRms(rms);
          setLocalLevel(Math.min(100, Math.round((rms / 500) * 100)));
          // "Transmitting" only means something if the server mixer would actually
          // mix this level in right now — i.e. it clears the user's own threshold.
          setIsSpeaking(rms >= micThresholdRef.current);
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
        setLocalLevel(level);
        setIsSpeaking(prev => {
          if (prev !== currentlySpeaking) {
            import('@tauri-apps/api/event').then(({ emit }) => {
              emit('local-vad', { speaking: currentlySpeaking, muted: false });
            }).catch(() => {});
            return currentlySpeaking;
          }
          return prev;
        });
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
  useEffect(() => { onSpeakingChange?.(isSpeaking); }, [isSpeaking]);
  useEffect(() => { onSharersChange?.(availableSharers); }, [availableSharers]);
  useEffect(() => { onMuteChange?.(isMuted); }, [isMuted]);
  useEffect(() => { onLocalLevelChange?.(localLevel); }, [localLevel]);
  useEffect(() => { onRemoteLevelsChange?.(remoteLevels); }, [remoteLevels]);
  useEffect(() => { onSharingChange?.(isSharing); }, [isSharing]);
  useEffect(() => { isSharingRef.current = isSharing; }, [isSharing]);
  useEffect(() => { onConnectionQualityChange?.(connectionQuality); }, [connectionQuality]);
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
      setVideoFrameCallback: (fn) => { videoFrameCallbackRef.current = fn; },
      get isMuted() { return isMuted; },
      get isSharing() { return isSharing; },
      get micError() { return micError; },
      get isSpeaking() { return isSpeaking; },
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
  useEffect(() => { onLocalLevelChange?.(localLevel); }, [localLevel]);
  useEffect(() => { onRemoteLevelsChange?.(remoteLevels); }, [remoteLevels]);

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

  useEffect(() => {
    if (!window.__TAURI__) return;
    let unlistens = [];

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');

      unlistens.push(await listen('specter://ptt-active', (event) => {
        const { active } = event.payload;
        if (active && isMutedRef.current) toggleMicRef.current();
        else if (!active && !isMutedRef.current) toggleMicRef.current();
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
    <div className={`h-full flex flex-col overflow-hidden ${embedded ? '' : 'bg-specter-bg-panel border border-specter-primary-dim rounded-lg'}`}>
      {/* Header — hidden in embedded mode (WarRoom provides its own) */}
      {!embedded && (
        <div className="bg-specter-bg-surface p-4 border-b border-specter-primary-dim flex justify-between items-center">
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
        <div className="flex items-center gap-3 px-4 py-2 flex-shrink-0" style={{ borderBottom: '1px solid #0e2233', background: '#040c17' }}>
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
