/**
 * Message franking — the server's "relay record" (Wave 3 S7, design
 * docs/WAVE3_FORMAT_V2_FRANKING_DESIGN.md §4, owner decision D1 = R1).
 *
 * A v2 chat/DM sender attaches `frank: { v: 1, c }`, where `c` is a 32-byte
 * HMAC commitment to the message (keyed by a random per-message key that only
 * travels inside the MLS ciphertext — this service never sees content). On
 * relay the server MACs the commitment together with who sent it, where and
 * when:
 *
 *   tag = HMAC-SHA256(K_frank[kid],
 *           "specter/frank-tag/v1" || c(32) || lp(sender_id) || lp(conversation_id)
 *           || lp(msg_id) || lp(timestamp_iso))          lp() = 2-byte BE length + UTF-8
 *
 * and relays `frank: { v, c, kid, tag }` with the message. Recipients keep the
 * tag; NOTHING is stored here per message (hard owner rule: the server never
 * stores messages or transmissions). A report later carries the tag back and
 * the admin verify endpoint (S10) recomputes it.
 *
 * Keys: FRANK_KEYS = "kid1:base64,kid2:base64,…" (each key ≥ 32 bytes). The
 * LAST entry signs (append the new key on rotation, every 90 days); every
 * listed key verifies (keep them one year, D3). Unset → messages are relayed
 * with the commitment but no tag, and a warning is logged once.
 */
import crypto from 'crypto';

export const FRANK_VERSION = 1;
export const FRANK_COMMITMENT_LEN = 32;
const TAG_LABEL = Buffer.from('specter/frank-tag/v1', 'utf8');
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
// Standard base64 of exactly 32 bytes: 43 chars + one '='.
const C_RE = /^[A-Za-z0-9+/]{43}=$/;

export interface FrankKey { kid: string; key: Buffer }
export interface FrankKeyring { signing: FrankKey | null; byKid: Map<string, Buffer> }

/** Client-supplied part of `frank`. */
export interface FrankInput { v: number; c: string }
/** What gets relayed. kid/tag are absent when no key is configured. */
export interface FrankRelay { v: number; c: string; kid?: string; tag?: string }

/** Parses FRANK_KEYS. Malformed entries throw (a misconfigured key must not be silently skipped). */
export function parseFrankKeys(raw: string | undefined | null): FrankKeyring {
  const byKid = new Map<string, Buffer>();
  let signing: FrankKey | null = null;
  const text = (raw || '').trim();
  if (!text) return { signing, byKid };
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const kid = i > 0 ? part.slice(0, i) : '';
    const b64 = i > 0 ? part.slice(i + 1) : '';
    if (!KID_RE.test(kid)) throw new Error(`FRANK_KEYS: bad kid in entry ${byKid.size + 1}`);
    const key = Buffer.from(b64, 'base64');
    if (key.length < 32) throw new Error(`FRANK_KEYS: key "${kid}" must be at least 32 bytes`);
    if (byKid.has(kid)) throw new Error(`FRANK_KEYS: duplicate kid "${kid}"`);
    byKid.set(kid, key);
    signing = { kid, key };
  }
  return { signing, byKid };
}

let cached: { raw: string | undefined; ring: FrankKeyring } | null = null;
let warnedUnset = false;

/** The keyring from process.env.FRANK_KEYS (re-parsed only when the value changes). */
export function frankKeyring(): FrankKeyring {
  const raw = process.env.FRANK_KEYS;
  if (!cached || cached.raw !== raw) {
    let ring: FrankKeyring;
    try {
      ring = parseFrankKeys(raw);
    } catch (err) {
      // Never take message relay down over a bad key: relay untagged, loudly.
      console.error(`[franking] ${(err as Error).message}: ignoring FRANK_KEYS, messages are relayed without a server tag`);
      ring = { signing: null, byKid: new Map() };
    }
    cached = { raw, ring };
  }
  return cached.ring;
}

/** Test hook. */
export function _resetFrankingForTests() {
  cached = null;
  warnedUnset = false;
}

/**
 * Validates the optional client `frank` field.
 * → { ok: true, frank: null } when absent; { ok: false, message } when present but invalid.
 */
export function parseFrankInput(v: unknown): { ok: true; frank: FrankInput | null } | { ok: false; message: string } {
  if (v === undefined || v === null) return { ok: true, frank: null };
  if (typeof v !== 'object' || Array.isArray(v)) return { ok: false, message: 'frank must be an object' };
  const { v: ver, c } = v as Record<string, unknown>;
  if (ver !== FRANK_VERSION) return { ok: false, message: `frank.v must be ${FRANK_VERSION}` };
  if (typeof c !== 'string' || !C_RE.test(c) || Buffer.from(c, 'base64').length !== FRANK_COMMITMENT_LEN) {
    return { ok: false, message: 'frank.c must be 32 bytes, base64' };
  }
  return { ok: true, frank: { v: ver, c } };
}

function lp(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  if (b.length > 0xffff) throw new Error('franking field too long');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

export interface FrankContext {
  senderId: string;
  conversationId: string;
  msgId: string;
  timestamp: string;
}

/** The tag input (exported for the verify endpoint and tests). */
export function frankTagInput(c: string, ctx: FrankContext): Buffer {
  return Buffer.concat([
    TAG_LABEL,
    Buffer.from(c, 'base64'),
    lp(ctx.senderId),
    lp(ctx.conversationId),
    lp(ctx.msgId),
    lp(ctx.timestamp),
  ]);
}

export function computeFrankTag(key: Buffer, c: string, ctx: FrankContext): string {
  return crypto.createHmac('sha256', key).update(frankTagInput(c, ctx)).digest('base64');
}

/**
 * The `frank` object to relay for a validated input: tagged with the signing
 * key, or untagged (and a one-time warning) when FRANK_KEYS is unset.
 */
export function issueFrank(input: FrankInput, ctx: FrankContext, ring: FrankKeyring = frankKeyring()): FrankRelay {
  if (!ring.signing) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.warn('[franking] FRANK_KEYS is not set: relaying franked messages without a server tag (reports of them will show as unverified)');
    }
    return { v: input.v, c: input.c };
  }
  return { v: input.v, c: input.c, kid: ring.signing.kid, tag: computeFrankTag(ring.signing.key, input.c, ctx) };
}

/** Constant-time check of a relayed tag against any configured key (S10 verify). */
export function verifyFrankTag(
  frank: { c: string; kid: string; tag: string },
  ctx: FrankContext,
  ring: FrankKeyring = frankKeyring(),
): boolean {
  const key = ring.byKid.get(frank.kid);
  if (!key || typeof frank.tag !== 'string') return false;
  if (parseFrankInput({ v: FRANK_VERSION, c: frank.c }).ok !== true) return false;
  const want = Buffer.from(computeFrankTag(key, frank.c, ctx), 'base64');
  const got = Buffer.from(frank.tag, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
