/**
 * Media-ticket signing (config/mediaTicketKey.ts, contract C1).
 *
 * media-rust verifies ONLY media tickets (purpose media_voice/media_video from
 * POST /orgs/:id/media-ticket) — never the user access token. With
 * MEDIA_TICKET_PRIVATE_KEY set they are ES256 (kid media-v1, aud
 * specter-media) so nodes need only the public key; without it, the legacy
 * HS256/JWT_SECRET tickets continue for the rollout.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  signMediaTicket, mediaTicketAlgorithm, getMediaTicketPublicKeyPem, MEDIA_TICKET_AUDIENCE, MEDIA_TICKET_KID,
} from '../../../src/config/mediaTicketKey.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const CLAIMS = { sub: 'u1', org_id: 'o1', channel_id: 'c1', purpose: 'media_voice', media_role: 'voice', priority_level: 5, jti: 'j1' };

beforeEach(() => { process.env.JWT_SECRET = 'platform-master-secret-TEST'; });
afterEach(() => { for (const k of ['JWT_SECRET', 'MEDIA_TICKET_PRIVATE_KEY', 'MEDIA_TICKET_PUBLIC_KEY']) delete process.env[k]; });

describe('ES256 media tickets (MEDIA_TICKET_PRIVATE_KEY set)', () => {
  beforeEach(() => { process.env.MEDIA_TICKET_PRIVATE_KEY = PRIV; });

  it('header alg ES256 + kid media-v1; aud specter-media; every existing claim kept; exp set', () => {
    const t = signMediaTicket(CLAIMS, 90);
    const { header, payload } = jwt.decode(t, { complete: true }) as any;
    expect(header).toMatchObject({ alg: 'ES256', kid: MEDIA_TICKET_KID });
    expect(payload).toMatchObject({ ...CLAIMS, aud: MEDIA_TICKET_AUDIENCE });
    expect(payload.exp - payload.iat).toBe(90);
    expect(mediaTicketAlgorithm()).toBe('ES256');
  });

  it('verifies with the public key alone, and NOT with JWT_SECRET (a node no longer needs the master secret)', () => {
    const t = signMediaTicket(CLAIMS, 90);
    expect(jwt.verify(t, PUB, { algorithms: ['ES256'], audience: 'specter-media' })).toMatchObject({ purpose: 'media_voice' });
    expect(() => jwt.verify(t, 'platform-master-secret-TEST', { algorithms: ['HS256'] })).toThrow();
  });

  it('accepts a PEM with literal \\n (single-line .env) and derives the public key nodes get', () => {
    process.env.MEDIA_TICKET_PRIVATE_KEY = PRIV.trim().replace(/\n/g, '\\n');
    expect(getMediaTicketPublicKeyPem()).toBe(PUB);
    const t = signMediaTicket(CLAIMS, 90);
    expect(() => jwt.verify(t, PUB, { algorithms: ['ES256'] })).not.toThrow();
  });

  it('a configured MEDIA_TICKET_PUBLIC_KEY that does not match the private key is an error, not a silent outage', () => {
    process.env.MEDIA_TICKET_PUBLIC_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => getMediaTicketPublicKeyPem()).toThrow(/does not match/);
    process.env.MEDIA_TICKET_PUBLIC_KEY = PUB;
    expect(getMediaTicketPublicKeyPem()).toBe(PUB);
  });

  it('rejects a non-P-256 key loudly', () => {
    process.env.MEDIA_TICKET_PRIVATE_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signMediaTicket(CLAIMS, 90)).toThrow(/P-256/);
    process.env.MEDIA_TICKET_PRIVATE_KEY = 'garbage';
    expect(() => signMediaTicket(CLAIMS, 90)).toThrow(/not a valid PEM/);
  });
});

describe('legacy HS256 (MEDIA_TICKET_PRIVATE_KEY unset — transition only)', () => {
  it('signs with JWT_SECRET, no kid, aud added, claims unchanged', () => {
    const t = signMediaTicket(CLAIMS, 90);
    const { header, payload } = jwt.decode(t, { complete: true }) as any;
    expect(header.alg).toBe('HS256');
    expect(header.kid).toBeUndefined();
    expect(payload).toMatchObject({ ...CLAIMS, aud: MEDIA_TICKET_AUDIENCE });
    expect(jwt.verify(t, 'platform-master-secret-TEST')).toBeTruthy();
    expect(mediaTicketAlgorithm()).toBe('HS256');
  });

  it('has no public key to hand a remote node (provisioning refuses in this state)', () => {
    expect(getMediaTicketPublicKeyPem()).toBeNull();
  });
});

describe('the ticket endpoint uses the media-ticket signer, not the platform secret directly', () => {
  it('orgController.issueOrgMediaTicket signs through signMediaTicket', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/controllers/orgController.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export const issueOrgMediaTicket'), src.indexOf('export const updateOrgSettings'));
    expect(fn).toContain('signMediaTicket(');
    expect(fn).not.toContain('getJwtSecret()');
    expect(fn).toMatch(/purpose,/);
  });
});
