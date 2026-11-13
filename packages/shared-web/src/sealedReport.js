// D1: bug-report descriptions, sealed to the owner's public key.
//
// The client cleans the text (sanitizeReportText → redactSecrets), then seals
// it to the owner's report key (sealToPublicKey). The server stores only the
// sealed blob; nothing server-side — and none of Claude's tools — can read
// it. The owner's admin browser unlocks the private key with a passphrase
// (unlockOwnerKey) and opens reports there (openSealed). The private key is
// stored server-side only wrapped under that passphrase (createOwnerKey).
//
// Scheme (v1): ephemeral ECDH P-256 → HKDF-SHA-256 → AES-256-GCM, the key id
// bound as AAD. WebCrypto only (Tauri webview, admin browser, Node ≥ 19).

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const REPORT_MAX_CHARS = 2000;
export const REPORT_CATEGORIES = Object.freeze([
  { id: 'voice', label: 'Voice' },
  { id: 'video', label: 'Screen share / video' },
  { id: 'hotkeys', label: 'Hotkeys' },
  { id: 'hud', label: 'Game HUD' },
  { id: 'chat', label: 'Chat' },
  { id: 'other', label: 'Something else' },
]);
const SEAL_ALG = 'ECDH-P256+HKDF-SHA256+A256GCM';
const WRAP_ITERATIONS = 600_000;

// ── base64 ────────────────────────────────────────────────────────────────
export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  const s = atob(String(b64));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ── Cleaning ──────────────────────────────────────────────────────────────

// C0/C1 controls except tab and newline; bidi embeddings/overrides/isolates
// and marks; zero-width characters and the BOM.
const STRIP_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/** NFC, invisible/control characters removed, line endings unified, ≤ REPORT_MAX_CHARS. */
export function sanitizeReportText(input) {
  let s = String(input ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(STRIP_RE, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return Array.from(s).slice(0, REPORT_MAX_CHARS).join('');
}

// Ordered: specific token shapes before the generic long-string catch-alls.
const REDACTIONS = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted token]'], // JWT
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, '[redacted key]'], // Stripe
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, '[redacted key]'], // GitHub
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, '[redacted key]'], // Slack
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted key]'], // AWS access key id
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(bearer\s+)[\w.~+/-]{10,}=*/gi, '$1[redacted]'],
  [/\b(token|password|passwd|pwd|secret|api[_-]?key)(\s*[:=]\s*)("[^"\n]+"|'[^'\n]+'|\S+)/gi, '$1$2[redacted]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[redacted IP]'], // IPv4
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '[redacted IP]'], // IPv6 (full-ish)
  [/\b[0-9a-f]{32,}\b/gi, '[redacted hex]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]'], // long base64-ish blobs
];

/** Replaces tokens, keys and IP addresses. → { text, count } */
export function redactSecrets(input) {
  let text = String(input ?? '');
  let count = 0;
  for (const [re, rep] of REDACTIONS) {
    text = text.replace(re, (...m) => {
      count += 1;
      return rep.replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? '');
    });
  }
  return { text, count };
}

/** Cleaned and redacted, ready to seal. → { text, redactions } */
export function prepareReportText(input) {
  const { text, count } = redactSecrets(sanitizeReportText(input));
  return { text, redactions: count };
}

/** Warning flags for the reader (they warn, never block). Computed after opening. */
export function reportFlags(text) {
  const s = String(text ?? '');
  return {
    has_urls: /\b(?:https?:\/\/|www\.)\S+/i.test(s),
    looks_like_instructions: /\b(ignore (all |any )?(previous|prior|above)|disregard (the|all|previous)|system prompt|you are (now )?(an? |the )?(ai|assistant|model|claude)|as an ai|new instructions|run (this|the following)|execute (this|the following))\b/i.test(s),
    has_code: /```|<script|\b(?:curl|wget|powershell|bash|sudo)\b/i.test(s),
    redacted: /\[redacted[^\]]*\]/.test(s),
  };
}

// ── Owner key ─────────────────────────────────────────────────────────────

/** Short stable id for a public key: first 16 hex chars of SHA-256(x‖y). */
export async function keyIdFor(publicJwk) {
  const h = await subtle().digest('SHA-256', enc.encode(`${publicJwk.x}.${publicJwk.y}`));
  return [...new Uint8Array(h).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function wrapKeyFromPassphrase(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

/**
 * A new owner key pair, the private half wrapped under `passphrase`.
 * → { keyId, publicKey (JWK), wrapped: { v, kdf, iterations, salt, iv, ct } }
 */
export async function createOwnerKey(passphrase) {
  if (!passphrase || passphrase.length < 12) throw new Error('Use a passphrase of at least 12 characters');
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = await subtle().exportKey('jwk', pair.publicKey);
  const publicKey = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y };
  const keyId = await keyIdFor(publicKey);
  const pkcs8 = await subtle().exportKey('pkcs8', pair.privateKey);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const wk = await wrapKeyFromPassphrase(passphrase, salt, WRAP_ITERATIONS);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(keyId) }, wk, pkcs8);
  return {
    keyId,
    publicKey,
    wrapped: { v: 1, kdf: 'PBKDF2-SHA256', iterations: WRAP_ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) },
  };
}

/** The private key (non-extractable) from its wrapped form. Throws 'Wrong passphrase'. */
export async function unlockOwnerKey({ keyId, wrapped }, passphrase) {
  const wk = await wrapKeyFromPassphrase(passphrase, fromB64(wrapped.salt), wrapped.iterations);
  let pkcs8;
  try {
    pkcs8 = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(wrapped.iv), additionalData: enc.encode(keyId) }, wk, fromB64(wrapped.ct));
  } catch {
    throw new Error('Wrong passphrase');
  }
  return subtle().importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

// ── Seal / open ───────────────────────────────────────────────────────────

async function contentKey(privateKey, publicKey, keyId) {
  const bits = await subtle().deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const ikm = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(`specter-bug-report-v1|${keyId}`) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

const importPublic = (jwk) => subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

/** Seals `plaintext` to the owner's public key. → { v, alg, keyId, epk, iv, ct } */
export async function sealToPublicKey({ keyId, publicKey }, plaintext) {
  const recipient = await importPublic(publicKey);
  const eph = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epkJwk = await subtle().exportKey('jwk', eph.publicKey);
  const key = await contentKey(eph.privateKey, recipient, keyId);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(keyId) }, key, enc.encode(String(plaintext)));
  return { v: 1, alg: SEAL_ALG, keyId, epk: { x: epkJwk.x, y: epkJwk.y }, iv: toB64(iv), ct: toB64(ct) };
}

/** Opens a sealed report with the owner's private key. Throws if it was tampered with. */
export async function openSealed(privateKey, sealed) {
  if (sealed?.v !== 1 || sealed.alg !== SEAL_ALG) throw new Error('Unknown report format');
  const epk = await importPublic(sealed.epk);
  const key = await contentKey(privateKey, epk, sealed.keyId);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(sealed.iv), additionalData: enc.encode(sealed.keyId) }, key, fromB64(sealed.ct));
  return dec.decode(pt);
}
