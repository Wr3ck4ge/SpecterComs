import crypto from 'crypto';
import { nkeys, StringCodec, type NatsConnection } from 'nats';
import { verifyNodeCredential } from './nodeCredentials.js';
import { legacyNodeIds, legacyTokenPermissions, nodePermissions, isNatsNodeId, type NatsPermissions } from './natsSubjects.js';

/**
 * NATS 2.10 auth callout, served by identity-node (contract C2).
 *
 * Why callout (vs a generated authorization file + reload, or operator-mode
 * JWTs): adding or revoking a node is a DB row, with no NATS restart or reload,
 * so existing connections are never dropped; the NATS server can't hold token
 * auth and a users list at the same time, but a callout sees both, so the
 * legacy NATS_AUTH_TOKEN (node-1 mid-rollout) and per-node user/password work
 * side by side; and the permission policy lives in one tested TS module
 * (natsSubjects.ts) instead of a config file deploy.ps1 doesn't ship.
 *
 * Server side (docker-compose.prod.yml, NATS_AUTH_MODE=callout): account
 * SPECTER holds the static user `specter-control` (this process — it bypasses
 * the callout, so identity-node can always connect), and every other
 * connection is sent to $SYS.REQ.USER.AUTH, answered here. The answer is a user
 * JWT, signed by NATS_CALLOUT_ISSUER_SEED, that puts the client in SPECTER with
 * the permissions below.
 *
 * Trade-off: while identity-node is down, NEW node connections are refused
 * (existing ones stay up). media-rust must therefore retry its initial NATS
 * connect (it already reconnects forever after a disconnect).
 */

export const CALLOUT_SUBJECT = '$SYS.REQ.USER.AUTH';
export const CALLOUT_ACCOUNT = 'SPECTER';

const sc = StringCodec();
const enc = new TextEncoder();
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');

export interface ConnectOpts {
  user?: string;
  pass?: string;
  auth_token?: string;
  [k: string]: unknown;
}

export type AuthDecision =
  | { ok: true; name: string; permissions: NatsPermissions }
  | { ok: false; error: string };

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Policy: who is this connection, and what may it do. Pure apart from the credential lookup. */
export async function authorizeConnection(opts: ConnectOpts): Promise<AuthDecision> {
  const user = typeof opts.user === 'string' ? opts.user : '';
  const pass = typeof opts.pass === 'string' ? opts.pass : '';
  if (user) {
    if (!isNatsNodeId(user)) return { ok: false, error: 'unknown user' };
    if (!(await verifyNodeCredential(user, pass))) return { ok: false, error: 'bad credentials' };
    return { ok: true, name: user, permissions: nodePermissions(user) };
  }
  const token = typeof opts.auth_token === 'string' ? opts.auth_token : '';
  const legacy = process.env.NATS_AUTH_TOKEN || '';
  if (token && legacy && safeEqual(token, legacy)) {
    return { ok: true, name: 'legacy-token', permissions: legacyTokenPermissions(legacyNodeIds()) };
  }
  return { ok: false, error: 'authentication required' };
}

// ── nkey-signed JWTs (the NATS JWT v2 wire format) ────────────────────────────

type KeyPair = ReturnType<typeof nkeys.fromSeed>;

export function encodeNatsJwt(claims: Record<string, unknown>, kp: KeyPair): string {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ed25519-nkey' }));
  const body = b64u(JSON.stringify(claims));
  const sig = kp.sign(enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64u(sig)}`;
}

/** Decodes a JWT the NATS server sent and checks it was signed by its `iss` (the server's nkey). */
export function decodeServerJwt(token: string): any {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('malformed JWT');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const iss = claims?.iss;
  if (typeof iss !== 'string' || !iss.startsWith('N')) throw new Error('request not issued by a server key');
  const ok = nkeys.fromPublic(iss).verify(enc.encode(`${h}.${p}`), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad request signature');
  return claims;
}

const jti = () => crypto.randomBytes(16).toString('hex');

export function buildCalloutResponse(request: any, decision: AuthDecision, issuer: KeyPair): string {
  const now = Math.floor(Date.now() / 1000);
  const userNkey = request?.nats?.user_nkey;
  const serverId = request?.nats?.server_id?.id;
  const iss = issuer.getPublicKey();
  let natsClaims: Record<string, unknown>;
  if (decision.ok) {
    const user = encodeNatsJwt({
      jti: jti(), iat: now, iss, name: decision.name, sub: userNkey, aud: CALLOUT_ACCOUNT,
      // No exp: the server disconnects a client when its user JWT expires.
      nats: { ...decision.permissions, subs: -1, data: -1, payload: -1, type: 'user', version: 2 },
    }, issuer);
    natsClaims = { jwt: user, type: 'authorization_response', version: 2 };
  } else {
    natsClaims = { error: decision.error, type: 'authorization_response', version: 2 };
  }
  return encodeNatsJwt({ jti: jti(), iat: now, iss, sub: userNkey, aud: serverId, nats: natsClaims }, issuer);
}

export function loadIssuer(): KeyPair {
  const seed = process.env.NATS_CALLOUT_ISSUER_SEED?.trim();
  if (!seed || !seed.startsWith('SA')) {
    throw new Error('NATS_AUTH_MODE=callout needs NATS_CALLOUT_ISSUER_SEED (an account nkey seed, "SA…")');
  }
  return nkeys.fromSeed(enc.encode(seed));
}

/** Serves $SYS.REQ.USER.AUTH on `nc` (which must be the static callout auth user). */
export function startAuthCallout(nc: NatsConnection): void {
  const issuer = loadIssuer();
  const sub = nc.subscribe(CALLOUT_SUBJECT);
  console.log(`[nats-auth] auth callout serving ${CALLOUT_SUBJECT} (issuer ${issuer.getPublicKey()})`);
  (async () => {
    for await (const msg of sub) {
      let request: any;
      try {
        request = decodeServerJwt(sc.decode(msg.data));
      } catch (e) {
        console.warn('[nats-auth] dropped an invalid callout request:', (e as Error).message);
        continue;
      }
      let decision: AuthDecision;
      try {
        decision = await authorizeConnection(request?.nats?.connect_opts ?? {});
      } catch (e) {
        decision = { ok: false, error: 'internal error' };
        console.error('[nats-auth] authorize failed:', e);
      }
      if (!decision.ok) {
        const who = request?.nats?.connect_opts?.user || (request?.nats?.connect_opts?.auth_token ? 'token' : 'anonymous');
        console.warn(`[nats-auth] denied ${who} from ${request?.nats?.client_info?.host ?? '?'}: ${decision.error}`);
      }
      try {
        msg.respond(sc.encode(buildCalloutResponse(request, decision, issuer)));
      } catch (e) {
        console.error('[nats-auth] respond failed:', e);
      }
    }
  })();
}
