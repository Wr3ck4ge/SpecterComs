// Message franking, client side (Wave 3 S7; design
// docs/WAVE3_FORMAT_V2_FRANKING_DESIGN.md §4).
//
// Envelope v2 — the MLS plaintext of a franked chat message or DM:
//
//   MAGIC "\x00SF" || 0x02 || fk(32) || content_json (UTF-8)
//   content_json = {"k":"text","body":"…"}
//
// fk is a fresh random 32-byte franking key per message. Typed text never
// contains NUL (the composer strips it), so a v1 message (raw UTF-8 text) and
// a v2 envelope are told apart without trusting the relay.
//
// Commitment (the sender attaches it as `frank: { v: 1, c }`; the server sees
// only c, tags it and relays `frank: { v, c, kid, tag }`):
//
//   c = HMAC-SHA256(fk, "specter/frank/v1" || scope(1) || lp(conversation_id)
//                       || lp(sender_user_id) || content_json)
//   scope 0x01 channel (conversation_id = channel id), 0x02 DM (the sorted
//   "<uuid>-<uuid>" conversation id); lp() = 2-byte big-endian length + UTF-8.
//
// A receiver recomputes c with the SERVER-SUPPLIED sender_id and compares it in
// constant time with the relayed frank.c. Mismatch, or an envelope without a
// frank, is shown hidden behind "This message couldn't be verified" (D2).
//
// String form. mlsSession hands plaintexts around as strings (own-echo recall,
// the stored row). An envelope's binary header can't survive UTF-8 decoding,
// so its string form is: the 36 header bytes as code units U+0000–U+00FF
// (latin1), then content_json decoded as UTF-8. plaintextFromBytes /
// envelopeToString produce it, decodeEnvelope reads it (or raw bytes).
// background_sync.rs builds the same form.

export const ENVELOPE_VERSION = 0x02;
export const FRANK_VERSION = 1;
export const FK_LEN = 32;
export const SCOPE_CHANNEL = 0x01;
export const SCOPE_DM = 0x02;
const MAGIC = [0x00, 0x53, 0x46]; // "\x00SF"
export const HEADER_LEN = MAGIC.length + 1 + FK_LEN; // 36
const COMMIT_LABEL = 'specter/frank/v1';
/** Row.verify values (stored with the message). */
export const VERIFY_OK = 'ok';
export const VERIFY_FAILED = 'failed';
export const UNVERIFIED_TEXT = "This message couldn't be verified";

const enc = new TextEncoder();
const dec = new TextDecoder();

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto unavailable');
  return s;
};

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function lp(str) {
  const b = enc.encode(String(str ?? ''));
  if (b.length > 0xffff) throw new Error('franking field too long');
  return concat([Uint8Array.of(b.length >> 8, b.length & 0xff), b]);
}

const isEnvelopeBytes = (b) => b instanceof Uint8Array && b.length >= HEADER_LEN
  && b[0] === MAGIC[0] && b[1] === MAGIC[1] && b[2] === MAGIC[2] && b[3] === ENVELOPE_VERSION;

/** True when a decrypted plaintext (string form or bytes) is a v2 envelope. */
export function isEnvelope(p) {
  if (p instanceof Uint8Array) return isEnvelopeBytes(p);
  return typeof p === 'string' && p.length >= HEADER_LEN
    && p.charCodeAt(0) === MAGIC[0] && p.charCodeAt(1) === MAGIC[1] && p.charCodeAt(2) === MAGIC[2]
    && p.charCodeAt(3) === ENVELOPE_VERSION;
}

/** Decrypted MLS plaintext bytes → string (UTF-8; an envelope keeps its binary header, see above). */
export function plaintextFromBytes(bytes) {
  if (!isEnvelopeBytes(bytes)) return dec.decode(bytes);
  let head = '';
  for (let i = 0; i < HEADER_LEN; i++) head += String.fromCharCode(bytes[i]);
  return head + dec.decode(bytes.subarray(HEADER_LEN));
}

/** Envelope bytes → their string form (for the own-echo recall queue). */
export const envelopeToString = (bytes) => plaintextFromBytes(bytes);

/** content_json for a text message. */
export const textContentJson = (body) => JSON.stringify({ k: 'text', body: String(body ?? '') });

/** fk (32 bytes) + content_json → envelope bytes. */
export function encodeEnvelope(fk, contentJson) {
  if (!(fk instanceof Uint8Array) || fk.length !== FK_LEN) throw new Error('fk must be 32 bytes');
  return concat([Uint8Array.from(MAGIC), Uint8Array.of(ENVELOPE_VERSION), fk, enc.encode(contentJson)]);
}

/**
 * Envelope (string form or bytes) → { fk: Uint8Array(32), contentJson, content }
 * or null when it isn't a well-formed v2 envelope. `content` is the parsed
 * content_json (null if it doesn't parse).
 */
export function decodeEnvelope(p) {
  if (!isEnvelope(p)) return null;
  const fk = new Uint8Array(FK_LEN);
  let contentJson;
  if (p instanceof Uint8Array) {
    fk.set(p.subarray(4, HEADER_LEN));
    contentJson = dec.decode(p.subarray(HEADER_LEN));
  } else {
    for (let i = 0; i < FK_LEN; i++) {
      const code = p.charCodeAt(4 + i);
      if (code > 0xff) return null;
      fk[i] = code;
    }
    contentJson = p.slice(HEADER_LEN);
  }
  let content = null;
  try { content = JSON.parse(contentJson); } catch { content = null; }
  return { fk, contentJson, content };
}

/** The commitment c (32 bytes) for one message. */
export async function computeCommitment({ fk, scope, conversationId, senderId, contentJson }) {
  if (scope !== SCOPE_CHANNEL && scope !== SCOPE_DM) throw new Error('bad franking scope');
  const key = await subtle().importKey('raw', fk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = concat([enc.encode(COMMIT_LABEL), Uint8Array.of(scope), lp(conversationId), lp(senderId), enc.encode(contentJson)]);
  return new Uint8Array(await subtle().sign('HMAC', key, data));
}

/** Constant-time equality of two byte arrays (length leaks only). */
export function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** A fresh franking key (S8 senders). */
export function newFrankingKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(FK_LEN));
}

/**
 * Sender side (S8): text → { envelope: Uint8Array, envelopeString, frank: { v, c } }.
 */
export async function frankText({ body, scope, conversationId, senderId, fk = newFrankingKey() }) {
  const contentJson = textContentJson(body);
  const c = await computeCommitment({ fk, scope, conversationId, senderId, contentJson });
  const envelope = encodeEnvelope(fk, contentJson);
  return { envelope, envelopeString: envelopeToString(envelope), frank: { v: FRANK_VERSION, c: toB64(c) } };
}

const sanitizeFrank = (f) => {
  if (!f || typeof f !== 'object' || f.v !== FRANK_VERSION || typeof f.c !== 'string' || f.c.length > 64) return null;
  const out = { v: f.v, c: f.c };
  if (typeof f.kid === 'string' && f.kid.length <= 32) out.kid = f.kid;
  if (typeof f.tag === 'string' && f.tag.length <= 64) out.tag = f.tag;
  return out;
};

/**
 * Receiver side: a decrypted plaintext (string form) + the relayed frank →
 * the fields to store with the row.
 *   v1 raw text            → { plaintext }
 *   v2, commitment matches → { plaintext: body, content_json, fk (b64), frank, verify: 'ok' }
 *   v2, mismatch / no frank / bad content
 *                          → { plaintext: body (or ''), content_json, fk, frank, verify: 'failed' }
 * senderId MUST be the server-supplied sender_id; conversationId the channel
 * id (scope channel) or the DM conversation id (scope dm).
 */
export async function openFranked(plaintext, { frank, scope, conversationId, senderId }) {
  if (typeof plaintext !== 'string' || !isEnvelope(plaintext)) return { plaintext };
  const env = decodeEnvelope(plaintext);
  if (!env) return { plaintext: '', verify: VERIFY_FAILED };
  const body = env.content && env.content.k === 'text' && typeof env.content.body === 'string' ? env.content.body : null;
  const relayed = sanitizeFrank(frank);
  const out = {
    plaintext: body ?? '',
    content_json: env.contentJson,
    fk: toB64(env.fk),
    frank: relayed,
    verify: VERIFY_FAILED,
  };
  if (body === null || !relayed) return out;
  try {
    const c = await computeCommitment({ fk: env.fk, scope, conversationId, senderId, contentJson: env.contentJson });
    let relayedC;
    try { relayedC = fromB64(relayed.c); } catch { return out; }
    if (constantTimeEqual(c, relayedC)) out.verify = VERIFY_OK;
  } catch { /* no WebCrypto / bad input: unverified */ }
  return out;
}

/**
 * A stored or backfilled row that carries franking fields → the same row with
 * plaintext / verify recomputed from content_json + fk + frank (never trusting
 * a relayer's `text`). Rows without content_json / fk are returned unchanged.
 */
export async function reverifyRow(row, { scope, conversationId }) {
  if (!row || typeof row.content_json !== 'string' || typeof row.fk !== 'string') return row;
  let fk;
  try { fk = fromB64(row.fk); } catch { return { ...row, verify: VERIFY_FAILED }; }
  if (fk.length !== FK_LEN) return { ...row, verify: VERIFY_FAILED };
  const asString = envelopeToString(encodeEnvelope(fk, row.content_json));
  const opened = await openFranked(asString, { frank: row.frank, scope, conversationId, senderId: row.sender_id });
  return { ...row, ...opened };
}

/** Is this row hidden behind "couldn't be verified" (D2)? */
export const isUnverified = (row) => row?.verify === VERIFY_FAILED;
