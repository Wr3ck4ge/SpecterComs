// Screen-share frames, wire format v2 — the receive side's glue (Wave 3 S7;
// design docs/WAVE3_FORMAT_V2_FRANKING_DESIGN.md §3, crypto in
// wasm-crypto/src/share_frame.rs).
//
// A stream declares v2 in its header JSON ("fv": 2, "kind": "share"); without
// it the stream is v1 (SFrameCrypto: random nonce, no AAD) exactly as before.
// The frame's first byte can't tell them apart (a v1 frame starts with a random
// nonce byte), so the opener is chosen from the header.
//
// CommLink's video key slot (cryptoRef, a key grace slot) holds a VideoKey
// from createVideoKey(): the v1 SFrameCrypto (encrypt/decrypt, unchanged for
// v1 senders and receivers) plus a ShareFrameReceiver under the same 'video'
// export, so every existing install / grace / clear path covers both.

/** Header JSON value of `fv` that selects v2. */
export const SHARE_FRAME_FORMAT_V2 = 2;
/** share_frame.rs kinds. */
export const SHARE_KIND_VIDEO = 0x01;
export const SHARE_KIND_AUDIO = 0x02;
/** Error codes that mean "authentic but refused" — a drop, not a key problem. */
export const SHARE_DROP_CODES = Object.freeze(['replay', 'stale-timestamp']);

/** The wire format a stream header declares: 2, or 1 (absent / anything else). */
export const streamFrameVersion = (header) => (header && header.fv === SHARE_FRAME_FORMAT_V2 ? 2 : 1);

/**
 * The 'video' export → the object installed in the video key slot.
 * SFrameCrypto / ShareFrameReceiver are injected (wasm-crypto classes).
 */
export function createVideoKey(secret, { SFrameCrypto, ShareFrameReceiver }) {
  const sframe = new SFrameCrypto(secret);
  let shareRx = null;
  try {
    shareRx = ShareFrameReceiver ? new ShareFrameReceiver(secret) : null;
  } catch { /* v1 keeps working without it */ }
  return {
    encrypt: (payload) => sframe.encrypt(payload),
    decrypt: (frame) => sframe.decrypt(frame),
    shareRx,
    free() {
      try { sframe.free(); } catch { /* already freed */ }
      try { shareRx?.free(); } catch { /* already freed */ }
    },
  };
}

const errCode = (err) => String(err?.message ?? err ?? '');

/**
 * Opens one v2 payload with the slot's current key, then — only on an
 * authentication failure, inside the rekey grace window — the previous one.
 * Throws an Error whose message is the share_frame.rs code ('replay',
 * 'stale-timestamp', 'auth-failed', 'no-key', ...).
 *   flags / tsMs: the wire unit's (or datagram's) flags byte and u32 timestamp
 *   sharerUserId: the sharer this subscription targets (UUID)
 *   kind:         SHARE_KIND_VIDEO | SHARE_KIND_AUDIO
 */
export function openShareV2(slot, frame, { flags, tsMs, sharerUserId, kind }) {
  const { current, previous } = slot;
  if (!current?.shareRx) throw new Error('no-key');
  if (!sharerUserId) throw new Error('no-sharer');
  const open = (k) => k.shareRx.open(frame, flags & 0xff, tsMs >>> 0, sharerUserId, kind);
  try {
    return open(current);
  } catch (err) {
    if (errCode(err) !== 'auth-failed' || !previous?.shareRx || previous === current) throw new Error(errCode(err));
    try { return open(previous); } catch { throw new Error(errCode(err)); }
  }
}

/** A new subscription starts with fresh replay windows (media-rust re-sends its cached keyframe). */
export function resetShareWindows(slot) {
  for (const k of [slot.current, slot.previous]) {
    try { k?.shareRx?.reset(); } catch { /* freed */ }
  }
}

/** Is this open error a plain drop (replay / stale) rather than a decrypt failure? */
export const isShareDrop = (err) => SHARE_DROP_CODES.includes(errCode(err));
