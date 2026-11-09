import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from './jwtSecret.js';

/**
 * Media-ticket signing (contract C1, eval C1).
 *
 * media-rust verifies ONLY media tickets (`purpose` = media_voice/media_video,
 * minted by POST /orgs/:id/media-ticket), never the user access token. Those
 * tickets used to be HS256 over JWT_SECRET — the same secret that signs every
 * user access token and admin token — so every media node had to hold the
 * platform's master signing secret.
 *
 *   MEDIA_TICKET_PRIVATE_KEY set   → ES256, header kid "media-v1", aud
 *                                    "specter-media". Nodes verify with
 *                                    MEDIA_TICKET_PUBLIC_KEY and hold no secret.
 *   MEDIA_TICKET_PRIVATE_KEY unset → legacy HS256 over JWT_SECRET (transition
 *                                    only; node-1 still has JWT_SECRET). The aud
 *                                    claim is added here too; no kid.
 *
 * PEM values may carry literal "\n" sequences instead of newlines (single-line
 * .env values); both are accepted.
 */

export const MEDIA_TICKET_KID = 'media-v1';
export const MEDIA_TICKET_AUDIENCE = 'specter-media';

export function normalizePem(raw: string): string {
  return raw.trim().replace(/^"|"$/g, '').replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim() + '\n';
}

interface Signer {
  algorithm: 'ES256' | 'HS256';
  key: crypto.KeyObject | string;
  keyid?: string;
}

let cached: { raw: string | undefined; signer: Signer } | null = null;

function loadPrivateKey(raw: string): crypto.KeyObject {
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(normalizePem(raw));
  } catch (e) {
    throw new Error(`MEDIA_TICKET_PRIVATE_KEY is not a valid PEM private key: ${(e as Error).message}`);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('MEDIA_TICKET_PRIVATE_KEY must be an EC P-256 (prime256v1) key for ES256');
  }
  return key;
}

function getSigner(): Signer {
  const raw = process.env.MEDIA_TICKET_PRIVATE_KEY?.trim() || undefined;
  if (cached && cached.raw === raw) return cached.signer;
  const signer: Signer = raw
    ? { algorithm: 'ES256', key: loadPrivateKey(raw), keyid: MEDIA_TICKET_KID }
    : { algorithm: 'HS256', key: getJwtSecret() };
  // Never cache the HS256 secret across env changes (tests flip it); cheap to re-read.
  cached = raw ? { raw, signer } : null;
  return signer;
}

/** 'ES256' once MEDIA_TICKET_PRIVATE_KEY is configured, else the legacy 'HS256'. */
export function mediaTicketAlgorithm(): 'ES256' | 'HS256' {
  return getSigner().algorithm;
}

/** Signs a media ticket. All claims are passed through unchanged; `aud` is added. */
export function signMediaTicket(claims: Record<string, unknown>, expiresInSeconds: number): string {
  const s = getSigner();
  return jwt.sign(claims, s.key as jwt.Secret, {
    algorithm: s.algorithm,
    expiresIn: expiresInSeconds,
    audience: MEDIA_TICKET_AUDIENCE,
    ...(s.keyid ? { keyid: s.keyid } : {}),
  });
}

/**
 * The PEM public key remote nodes need (MEDIA_TICKET_PUBLIC_KEY). Derived from
 * the private key so the two can never disagree; an explicitly set
 * MEDIA_TICKET_PUBLIC_KEY must match it. Null while still on legacy HS256 —
 * provisioning refuses to create a remote node in that state, since the only
 * way such a node could verify tickets is by holding JWT_SECRET.
 */
export function getMediaTicketPublicKeyPem(): string | null {
  const s = getSigner();
  if (s.algorithm !== 'ES256') return null;
  const derived = crypto.createPublicKey(s.key as crypto.KeyObject).export({ type: 'spki', format: 'pem' }).toString();
  const explicit = process.env.MEDIA_TICKET_PUBLIC_KEY?.trim();
  if (explicit) {
    const given = crypto.createPublicKey(normalizePem(explicit)).export({ type: 'spki', format: 'pem' }).toString();
    if (given !== derived) {
      throw new Error('MEDIA_TICKET_PUBLIC_KEY does not match MEDIA_TICKET_PRIVATE_KEY');
    }
  }
  return derived;
}
