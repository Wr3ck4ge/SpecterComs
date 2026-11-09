// H.264 SPS → picture size, for the screen-share header and viewers.
//
// The stream header ({ codec, width, height }) used to carry the PROFILE's
// size (1920×1080) while the native encoder produced whatever enc_dims chose
// (3840×1080 for a 5120×1440 window). Nothing decodes from the header's
// size (WebCodecs reads it from the in-band SPS), but everything that sizes a
// picture does. So the sharer now writes the header from the first keyframe's
// SPS, and viewers re-read the SPS of every keyframe they get (cheap: one
// scan to the first SPS, every ~2 s) to cope with older sharers and with a
// capture restart at a different size.
//
// Only what's needed for the size is parsed (ITU-T H.264 §7.3.2.1.1); any
// malformed input returns null rather than throwing.

const NAL_SPS = 7;

/** Byte offset of the first SPS NAL's header byte in Annex-B `bytes`, or -1. */
export function findSpsOffset(bytes) {
  if (!bytes) return -1;
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if ((bytes[i + 3] & 0x1f) === NAL_SPS) return i + 3;
      i += 2;
    }
  }
  return -1;
}

/** The SPS NAL (header byte included) without emulation-prevention bytes. */
function spsRbsp(bytes, start) {
  const out = [];
  let zeros = 0;
  for (let i = start; i < bytes.length; i += 1) {
    const b = bytes[i];
    if (zeros >= 2 && b === 1) break;            // next start code (00 00 01)
    if (zeros >= 2 && b === 3) { zeros = 0; continue; } // 00 00 03 → drop the 03
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

function bitReader(buf) {
  let pos = 0; // bit position
  const bit = () => {
    if (pos >= buf.length * 8) throw new RangeError('sps truncated');
    const v = (buf[pos >> 3] >> (7 - (pos & 7))) & 1;
    pos += 1;
    return v;
  };
  const bits = (n) => { let v = 0; for (let i = 0; i < n; i += 1) v = (v * 2) + bit(); return v; };
  const ue = () => {
    let lz = 0;
    while (bit() === 0) { lz += 1; if (lz > 31) throw new RangeError('bad exp-golomb'); }
    return (2 ** lz) - 1 + bits(lz);
  };
  const se = () => { const k = ue(); return k % 2 ? (k + 1) / 2 : -(k / 2); };
  return { bit, bits, ue, se };
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * Picture size from one SPS NAL (starting at its header byte).
 * → { width, height, profileIdc, levelIdc } or null.
 */
export function parseSps(nal) {
  try {
    const r = bitReader(spsRbsp(nal, 0));
    r.bits(8); // NAL header
    const profileIdc = r.bits(8);
    r.bits(8); // constraint flags
    const levelIdc = r.bits(8);
    r.ue(); // seq_parameter_set_id
    let chromaFormatIdc = 1;
    let separateColourPlane = 0;
    if (HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) separateColourPlane = r.bit();
      r.ue(); r.ue(); // bit depths
      r.bit(); // qpprime_y_zero_transform_bypass
      if (r.bit()) { // seq_scaling_matrix_present
        const lists = chromaFormatIdc === 3 ? 12 : 8;
        for (let i = 0; i < lists; i += 1) {
          if (!r.bit()) continue;
          const size = i < 6 ? 16 : 64;
          let last = 8;
          let next = 8;
          for (let j = 0; j < size; j += 1) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.bit(); r.se(); r.se();
      const n = r.ue();
      for (let i = 0; i < n; i += 1) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.bit(); // gaps_in_frame_num_value_allowed
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field
    r.bit(); // direct_8x8_inference
    let cl = 0; let cr = 0; let ct = 0; let cb = 0;
    if (r.bit()) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue(); }
    const chromaArrayType = separateColourPlane ? 0 : chromaFormatIdc;
    const subW = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1;
    const subH = chromaArrayType === 1 ? 2 : 1;
    const cropX = chromaArrayType === 0 ? 1 : subW;
    const cropY = (chromaArrayType === 0 ? 1 : subH) * (2 - frameMbsOnly);
    const width = widthMbs * 16 - cropX * (cl + cr);
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropY * (ct + cb);
    if (!(width > 0 && height > 0)) return null;
    return { width, height, profileIdc, levelIdc };
  } catch {
    return null;
  }
}

/** Picture size from the first SPS in an Annex-B access unit, or null. */
export function spsDimsFromAnnexB(bytes) {
  const at = findSpsOffset(bytes);
  if (at < 0) return null;
  const sps = parseSps(bytes.subarray(at));
  return sps ? { width: sps.width, height: sps.height } : null;
}
