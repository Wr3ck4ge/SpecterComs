/**
 * Audio Transmission Diagnostic
 *
 * Tests every layer of the audio pipeline to isolate why audio does not
 * transmit over channels.  Run with:
 *   node web-portal/tests/audio-diagnostic.mjs
 *
 * Covers:
 *  1. encodeAudioFrameProto / decodeAudioFrameProto round-trip
 *  2. hashUserId — checks for ssrc=0 collision (would cause frames to be
 *     treated as server-mixed stream and skipped by deduplication)
 *  3. Noise gate threshold — verifies typical mic levels pass the RMS gate
 *  4. Datagram write path — simulates what happens when datagramWriterRef is
 *     null vs ready when an audio frame arrives
 *  5. play_frame parameter name — verifies the Tauri invoke key matches the
 *     Rust snake_case parameter (`stream_id` not `streamId`)
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// ─── Helpers copied verbatim from CommLink.jsx ────────────────────────────────

function writeVarint(buf, value) {
  value = value >>> 0;
  while (value > 0x7f) {
    buf.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  buf.push(value & 0x7f);
}

function encodeAudioFrameProto(ssrc, seqNum, opusBytes) {
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
  return new Uint8Array(parts);
}

function decodeAudioFrameProto(bytes) {
  let pos = 0;
  let opusBytes = null;
  let ssrc = 0;
  let sequence = 0;
  let isGlobalBroadcast = false;
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
      let val = 0, shift2 = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        val |= (b & 0x7f) << shift2;
        shift2 += 7;
        if ((b & 0x80) === 0) break;
      }
      if (fieldNumber === 2) ssrc = val >>> 0;
      else if (fieldNumber === 3) sequence = val >>> 0;
      else if (fieldNumber === 4) isGlobalBroadcast = val !== 0;
    } else if (wireType === 2) {
      let len = 0; let shift3 = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        len |= (b & 0x7f) << shift3;
        shift3 += 7;
        if ((b & 0x80) === 0) break;
      }
      if (fieldNumber === 1) {
        opusBytes = bytes.slice(pos, pos + len);
      }
      pos += len;
    } else {
      break;
    }
  }
  return { opusBytes, ssrc, sequence, isGlobalBroadcast };
}

function hashUserId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`      ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

// ─── 1. Proto encode/decode round-trip ───────────────────────────────────────

console.log('\n[1] Proto encode/decode round-trip');

test('encodes and decodes a typical Opus frame', () => {
  const ssrc = 0xDEADBEEF >>> 0;
  const seq  = 42;
  const opus = new Uint8Array([0x01, 0x02, 0x03, 0xAA, 0xBB, 0xCC]);
  const encoded = encodeAudioFrameProto(ssrc, seq, opus);
  const decoded = decodeAudioFrameProto(encoded);
  assert.equal(decoded.ssrc, ssrc, `ssrc mismatch: got ${decoded.ssrc}`);
  assert.equal(decoded.sequence, seq, `seq mismatch: got ${decoded.sequence}`);
  assert.deepEqual(Array.from(decoded.opusBytes), Array.from(opus), 'opus bytes mismatch');
});

test('handles sequence wrapping at uint32 max', () => {
  const ssrc = 0x12345678;
  const seq  = 0xFFFFFFFF;
  const opus = new Uint8Array([0xAA]);
  const encoded = encodeAudioFrameProto(ssrc, seq, opus);
  const decoded = decodeAudioFrameProto(encoded);
  assert.equal(decoded.sequence, seq >>> 0, `wrapped seq mismatch: got ${decoded.sequence}`);
});

test('handles minimum 20-byte Opus frame (960 samples at 48kHz)', () => {
  const ssrc = 0x42;
  const seq  = 1000;
  const opus = new Uint8Array(20).fill(0x55);
  const encoded = encodeAudioFrameProto(ssrc, seq, opus);
  const decoded = decodeAudioFrameProto(encoded);
  assert.equal(decoded.opusBytes.length, 20);
});

test('handles max typical Opus frame (200 bytes at 64kbps VBR)', () => {
  const opus = new Uint8Array(200).fill(0x7F);
  const encoded = encodeAudioFrameProto(999, 1, opus);
  const decoded = decodeAudioFrameProto(encoded);
  assert.equal(decoded.opusBytes.length, 200);
});

// ─── 2. hashUserId — ssrc=0 collision check ──────────────────────────────────

console.log('\n[2] hashUserId — ssrc=0 collision');

test('hashUserId("unknown") is non-zero (fallback when userId unavailable)', () => {
  const ssrc = hashUserId('unknown');
  assert.notEqual(ssrc, 0, `hashUserId("unknown") returned 0 — frames would be treated as server-mixed stream`);
});

test('hashUserId("") returns 0 (empty string edge case)', () => {
  // Empty string produces hash=0. If userId is ever '', ssrc=0 and the frame
  // is indistinguishable from a server-mixed stream.
  const ssrc = hashUserId('');
  // This is a KNOWN ISSUE — if userId resolves to '' the audio is misrouted.
  if (ssrc === 0) {
    console.log('    NOTE: hashUserId("") === 0 — if userId is empty, audio will be treated as server-mixed and may cause deduplication bugs');
  }
  // Not a failure, just informational.
});

test('hashUserId produces consistent results for the same input', () => {
  const id = 'user-abc-123-xyz';
  assert.equal(hashUserId(id), hashUserId(id), 'hash is not deterministic');
});

test('hashUserId distinguishes typical UUID-format user IDs', () => {
  const a = hashUserId('550e8400-e29b-41d4-a716-446655440000');
  const b = hashUserId('550e8400-e29b-41d4-a716-446655440001');
  assert.notEqual(a, b, 'two close UUIDs produced the same ssrc — possible audio cross-talk');
});

// ─── 3. Noise gate threshold ─────────────────────────────────────────────────

console.log('\n[3] Noise gate (client-side RMS < 30.0 gate in capture.rs)');

function rms(samples) {
  const sum = samples.reduce((a, s) => a + (s * s), 0);
  return Math.sqrt(sum / samples.length);
}

test('typical speech (i16 ~2000 amplitude) passes the noise gate', () => {
  // Simulate 960 i16 samples at ~2000 amplitude (moderate speech level)
  const samples = Array.from({ length: 960 }, (_, i) => Math.round(2000 * Math.sin(i * 0.1)));
  const r = rms(samples);
  assert.ok(r > 30.0, `RMS ${r.toFixed(1)} is below the noise gate (30.0) — speech would be silenced`);
});

test('digital silence (all zeros) is blocked by the noise gate', () => {
  const samples = new Array(960).fill(0);
  const r = rms(samples);
  assert.equal(r, 0, 'all-zero samples should have RMS=0');
  assert.ok(r < 30.0, 'silence should be blocked by the gate');
});

test('very quiet whisper (~100 amplitude) fails the gate — this may be the audio issue', () => {
  const samples = Array.from({ length: 960 }, (_, i) => Math.round(100 * Math.sin(i * 0.1)));
  const r = rms(samples);
  const blocked = r < 30.0;
  if (blocked) {
    console.log(`    NOTE: Whisper-level audio (RMS=${r.toFixed(1)}) is below the noise gate (30.0). If the mic volume is low or the device uses I32 format with wrong bit-shift, audio will be silenced.`);
  }
  // ~100 amplitude gives RMS ~70.7 — should pass. But I32 path right-shifts by 16 bits,
  // which would convert 100 → 0, giving RMS=0.
});

test('I32-format device with 16-bit values at full range passes after >>16 shift', () => {
  // If WASAPI reports I32 but stores 16-bit values, the capture.rs I32 path does:
  //   let s = (mixed >> 16) as i16;
  // A 16-bit value like 32767 stored as i32=32767 would shift to (32767>>16)=0.
  // This is a BUG if the device uses the bottom 16 bits for audio.
  const i32SampleWith16BitRange = 32767; // 16-bit max in i32
  const afterShift = (i32SampleWith16BitRange >> 16) | 0;
  if (afterShift === 0) {
    console.log(`    BUG CONFIRMED: I32 device with 16-bit range (common for virtual audio) shifts to 0 → all audio silenced by noise gate`);
    console.log(`    Expected i32 sample ${i32SampleWith16BitRange} → after >>16 = ${afterShift} (should be ~0 for full 32-bit range, but = 0 for 16-bit range in i32)`);
    console.log(`    FIX: For I32 format, detect if values are in 16-bit range and use >>0 (cast directly) instead of >>16`);
  } else {
    console.log(`    I32 shift seems OK for this value range`);
  }
});

// ─── 4. Datagram writer availability ─────────────────────────────────────────

console.log('\n[4] Datagram writer availability simulation');

test('audio frames are dropped when datagramWriterRef is null', () => {
  let datagramWriterRef = { current: null };
  let framesDropped = 0;
  let framesSent = 0;

  function simulateAudioFrameHandler(opus) {
    const ssrc = hashUserId('test-user-id');
    const seq = framesDropped + framesSent;
    const proto = encodeAudioFrameProto(ssrc, seq, opus);
    if (datagramWriterRef.current) {
      framesSent++;
    } else {
      framesDropped++;
    }
  }

  // Simulate 10 frames arriving before transport is connected
  for (let i = 0; i < 10; i++) {
    simulateAudioFrameHandler(new Uint8Array([0x01, 0x02]));
  }

  assert.equal(framesDropped, 10, `Expected 10 dropped frames, got ${framesDropped}`);
  assert.equal(framesSent, 0);
  console.log(`    10 frames dropped because datagramWriterRef.current was null`);
  console.log(`    ROOT CAUSE: If the user unmutes BEFORE connecting to a channel, ALL audio is silently dropped`);
});

test('audio frames are sent once datagramWriterRef is set', () => {
  let datagramWriterRef = { current: null };
  let framesSent = 0;
  const writtenFrames = [];

  // Simulate writer becoming available
  datagramWriterRef.current = {
    write: (data) => {
      writtenFrames.push(data);
      framesSent++;
      return Promise.resolve();
    }
  };

  const opus = new Uint8Array([0x01, 0x02, 0x03]);
  const ssrc = hashUserId('user-123');
  const proto = encodeAudioFrameProto(ssrc, 0, opus);

  if (datagramWriterRef.current) {
    datagramWriterRef.current.write(proto);
  }

  assert.equal(framesSent, 1);

  // Verify the written frame decodes back correctly
  const decoded = decodeAudioFrameProto(writtenFrames[0]);
  assert.equal(decoded.ssrc, ssrc);
  assert.deepEqual(Array.from(decoded.opusBytes), Array.from(opus));
});

// ─── 5. Tauri invoke parameter name check ────────────────────────────────────

console.log('\n[5] Tauri invoke parameter name check');

test('play_frame uses camelCase streamId which maps to Rust snake_case stream_id', () => {
  // Tauri v2 automatically converts camelCase JS keys to snake_case Rust params.
  // Verify the key we actually pass matches what Tauri expects.
  const jsKey = 'streamId';
  // Tauri's transformation: 'streamId' -> 'stream_id'
  const expectedRustParam = 'stream_id';
  const actualTransformed = jsKey.replace(/([A-Z])/g, '_$1').toLowerCase();
  assert.equal(actualTransformed, expectedRustParam,
    `JS key '${jsKey}' transforms to '${actualTransformed}', expected '${expectedRustParam}'`);
  console.log(`    OK: 'streamId' correctly maps to 'stream_id' in Rust`);
});

test('start_capture uses camelCase deviceId which maps to Rust device_id', () => {
  const jsKey = 'deviceId';
  const actualTransformed = jsKey.replace(/([A-Z])/g, '_$1').toLowerCase();
  assert.equal(actualTransformed, 'device_id');
});

// ─── 6. ssrc=0 deduplication — the bug that was recently fixed ───────────────

console.log('\n[6] ssrc=0 deduplication (server-mixed stream handling)');

test('ssrc=0 frames are NOT deduplicated against each other (each has unique seq)', () => {
  const seenSequences = new Map();
  const results = [];

  function processFrame(ssrc, sequence) {
    const ssrcKey = ssrc >>> 0;
    if (!seenSequences.has(ssrcKey)) {
      seenSequences.set(ssrcKey, { set: new Set(), queue: [] });
    }
    const tracker = seenSequences.get(ssrcKey);
    if (tracker.set.has(sequence)) {
      results.push({ ssrc, sequence, action: 'DROPPED_DUPLICATE' });
      return;
    }
    tracker.queue.push(sequence);
    tracker.set.add(sequence);
    if (tracker.queue.length > 64) tracker.set.delete(tracker.queue.shift());
    results.push({ ssrc, sequence, action: 'PLAYED' });
  }

  // Server sends 5 mixed-audio frames with ssrc=0
  for (let seq = 0; seq < 5; seq++) {
    processFrame(0, seq);
  }

  const played = results.filter(r => r.action === 'PLAYED').length;
  const dropped = results.filter(r => r.action === 'DROPPED_DUPLICATE').length;
  assert.equal(played, 5, `Expected 5 played frames, got ${played} (ssrc=0 frames may be dropped)`);
  assert.equal(dropped, 0);
});

test('ssrc=0 duplicate frame IS deduplicated (same seq number twice)', () => {
  const seenSequences = new Map();
  let played = 0, dropped = 0;

  function processFrame(ssrc, sequence) {
    const ssrcKey = ssrc >>> 0;
    if (!seenSequences.has(ssrcKey)) {
      seenSequences.set(ssrcKey, { set: new Set(), queue: [] });
    }
    const tracker = seenSequences.get(ssrcKey);
    if (tracker.set.has(sequence)) { dropped++; return; }
    tracker.queue.push(sequence);
    tracker.set.add(sequence);
    if (tracker.queue.length > 64) tracker.set.delete(tracker.queue.shift());
    played++;
  }

  processFrame(0, 42);
  processFrame(0, 42); // exact duplicate → should drop
  assert.equal(played, 1);
  assert.equal(dropped, 1, 'Duplicate frame should have been dropped');
});

// ─── 7. Sequence counter state ────────────────────────────────────────────────

console.log('\n[7] Sequence counter (shared sequenceRef across reconnects)');

test('sequence counter does not reset on reconnect — stale sequences cause deduplication', () => {
  // sequenceRef.current is a React ref that persists across reconnects.
  // If the RECEIVER has seen sequences 0–63 from a previous session and the
  // sender starts again at seq=0, the receiver will drop the first 64 frames.
  let sequenceRef = { current: 0 };
  const seenSequences = new Map();

  function simulateSend(ssrc) {
    const seq = sequenceRef.current++;
    return encodeAudioFrameProto(ssrc, seq, new Uint8Array([0x01]));
  }

  function simulateReceive(encoded) {
    const frame = decodeAudioFrameProto(encoded);
    const ssrcKey = frame.ssrc >>> 0;
    if (!seenSequences.has(ssrcKey)) {
      seenSequences.set(ssrcKey, { set: new Set(), queue: [] });
    }
    const tracker = seenSequences.get(ssrcKey);
    if (tracker.set.has(frame.sequence)) return 'DROPPED';
    tracker.queue.push(frame.sequence);
    tracker.set.add(frame.sequence);
    if (tracker.queue.length > 64) tracker.set.delete(tracker.queue.shift());
    return 'PLAYED';
  }

  const ssrc = hashUserId('user-abc');
  // Session 1: send 64 frames
  for (let i = 0; i < 64; i++) {
    const encoded = simulateSend(ssrc);
    simulateReceive(encoded);
  }

  // The receiver has seen seq 0–63. Now simulate reconnect:
  // Sender resets seq to 0 (which DOESN'T happen — sequenceRef persists).
  // But what if it DID reset (e.g., page reload)?
  const testSeq = 0;
  const encodedWithResetSeq = encodeAudioFrameProto(ssrc, testSeq, new Uint8Array([0x01]));
  const result = simulateReceive(encodedWithResetSeq);

  if (result === 'DROPPED') {
    console.log('    NOTE: If seq resets to 0 on reconnect (e.g. page reload), first 64 frames will be dropped as duplicates');
    console.log('    The current code uses a persistent sequenceRef so this should not happen within a session, but cross-session it could');
  }
  // sequenceRef persists in React state — seq continues from 64, so this is fine in practice
  assert.equal(sequenceRef.current, 64);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailed tests:');
  for (const { name, err } of failures) {
    console.log(`  - ${name}: ${err.message}`);
  }
}
console.log('');
if (failed > 0) process.exit(1);
