/**
 * NATS per-node identity, control-plane side (contract C2):
 *   - the auth-callout policy (who may connect, with which permissions);
 *   - the nkey-signed JWT wire format the NATS server expects;
 *   - subject scoping (payload node_id must match the subject suffix).
 * The same callout runs against a real nats-server in the live harness
 * (src/test/nodes/multinode-live.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nkeys } from 'nats';

const db = vi.hoisted(() => ({ rows: new Map<string, string>() }));
vi.mock('../../../src/config/db.js', () => ({
  pool: {
    query: async (text: string, params: unknown[] = []) => {
      if (/SELECT secret_sha256/.test(text)) {
        const v = db.rows.get(params[0] as string);
        return { rows: v ? [{ secret_sha256: v }] : [], rowCount: v ? 1 : 0 };
      }
      if (/INSERT INTO media_node_credentials/.test(text)) { db.rows.set(params[0] as string, params[1] as string); return { rows: [], rowCount: 1 }; }
      if (/DELETE FROM media_node_credentials/.test(text)) { db.rows.delete(params[0] as string); return { rows: [], rowCount: 1 }; }
      throw new Error(`unexpected query ${text}`);
    },
  },
}));

import { authorizeConnection, buildCalloutResponse, encodeNatsJwt, decodeServerJwt, CALLOUT_ACCOUNT } from '../../../src/utils/natsAuthCallout.js';
import { storeNodeCredential, revokeNodeCredential, generateNodeSecret, verifyNodeCredential } from '../../../src/utils/nodeCredentials.js';
import { nodePermissions, legacyTokenPermissions, acceptNodeMessage, scopedNodeId, isNatsNodeId } from '../../../src/utils/natsSubjects.js';

const enc = new TextEncoder();
const dec = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

beforeEach(() => { db.rows.clear(); });
afterEach(() => { for (const k of ['NATS_AUTH_TOKEN', 'NATS_NODE_CREDENTIALS', 'NATS_LEGACY_NODE_IDS', 'NATS_AUTH_MODE']) delete process.env[k]; });

describe('authorizeConnection (callout policy)', () => {
  it('a provisioned node connects as its own user with its DB-stored secret; anything else is refused', async () => {
    const secret = generateNodeSecret();
    await storeNodeCredential('node-abc', secret);
    expect(await authorizeConnection({ user: 'node-abc', pass: secret })).toEqual({ ok: true, name: 'node-abc', permissions: nodePermissions('node-abc') });
    expect(await authorizeConnection({ user: 'node-abc', pass: 'wrong' })).toMatchObject({ ok: false });
    expect(await authorizeConnection({ user: 'node-other', pass: secret })).toMatchObject({ ok: false });
    expect(await authorizeConnection({ user: 'specter-control', pass: secret })).toMatchObject({ ok: false });
    expect(await authorizeConnection({ user: 'node.*', pass: secret })).toMatchObject({ ok: false });
    await revokeNodeCredential('node-abc');
    expect(await authorizeConnection({ user: 'node-abc', pass: secret })).toMatchObject({ ok: false });
  });

  it('node-1 / node-1-green authenticate from NATS_NODE_CREDENTIALS; empty entries are ignored', async () => {
    process.env.NATS_NODE_CREDENTIALS = 'node-1:pw-one,node-1-green:';
    expect(await authorizeConnection({ user: 'node-1', pass: 'pw-one' })).toMatchObject({ ok: true, name: 'node-1' });
    expect(await authorizeConnection({ user: 'node-1-green', pass: '' })).toMatchObject({ ok: false });
    expect(await verifyNodeCredential('node-1', 'pw-two')).toBe(false);
  });

  it('the legacy shared token still works (node-1 mid-rollout) but only with legacy permissions', async () => {
    process.env.NATS_AUTH_TOKEN = 'legacy-tok';
    expect(await authorizeConnection({ auth_token: 'legacy-tok' })).toEqual({
      ok: true, name: 'legacy-token', permissions: legacyTokenPermissions(['node-1', 'node-1-green']),
    });
    expect(await authorizeConnection({ auth_token: 'legacy-to' })).toMatchObject({ ok: false });
    delete process.env.NATS_AUTH_TOKEN;
    expect(await authorizeConnection({ auth_token: '' })).toMatchObject({ ok: false });
    expect(await authorizeConnection({})).toMatchObject({ ok: false });
  });
});

describe('permissions', () => {
  it('a node may publish only its own scoped subjects, ducking, the backfill request and unscoped session_start', () => {
    const p = nodePermissions('node-a');
    expect(p.pub.allow.sort()).toEqual([
      'media.heartbeat.node-a', 'specter.cmd.duck.>', 'specter.event.tree.request',
      'specter.usage.session_end.node-a', 'specter.usage.session_start', 'specter.usage.session_start.node-a',
      'specter.diag.netprobe.node-a',
    ].sort());
    expect(p.pub.allow.some((s) => s === 'specter.cmd.>' || s.startsWith('specter.cmd.kick') || s.startsWith('specter.cmd.drain_org'))).toBe(false);
    expect(p.pub.allow.some((s) => s.includes('node-b') || s === 'media.heartbeat' || s.endsWith('.*'))).toBe(false);
    expect(p.sub).toEqual({ allow: ['specter.cmd.>', 'specter.event.tree.>', '_INBOX.node-a.>'], deny: ['specter.event.tree.request'] });
    expect(p.sub.allow.some((s) => s.startsWith('specter.msg') || s === '>' || s === '_INBOX.>')).toBe(false);
  });

  it('the legacy token may use the unscoped subjects, and the scoped ones only for the legacy node ids', () => {
    const p = legacyTokenPermissions(['node-1']);
    expect(p.pub.allow).toEqual(expect.arrayContaining(['media.heartbeat', 'specter.usage.session_end', 'media.heartbeat.node-1']));
    expect(p.pub.allow.some((s) => s.includes('>') && s !== 'specter.cmd.duck.>')).toBe(false);
  });

  it('node ids follow media-rust\'s rule (^[a-z0-9-]{1,32}$) and can never be a wildcard', () => {
    for (const ok of ['node-1', 'node-1-green', 'node-ab12cd34']) expect(isNatsNodeId(ok)).toBe(true);
    for (const bad of ['', 'a.b', '*', '>', 'Node', 'x'.repeat(33), 'specter-control']) expect(isNatsNodeId(bad)).toBe(false);
  });
});

describe('subject scoping (identity-node side)', () => {
  it('scoped message: payload node_id must equal the subject suffix', () => {
    expect(acceptNodeMessage('media.heartbeat.node-a', 'media.heartbeat', 'node-a')).toEqual({ ok: true, nodeId: 'node-a' });
    expect(acceptNodeMessage('media.heartbeat.node-a', 'media.heartbeat', 'node-b')).toMatchObject({ ok: false });
    expect(acceptNodeMessage('media.heartbeat.node-a', 'media.heartbeat', undefined)).toMatchObject({ ok: false });
    expect(acceptNodeMessage('specter.usage.session_end.node-a', 'specter.usage.session_end', 'node-a')).toMatchObject({ ok: true });
    expect(scopedNodeId('media.heartbeat.a.b', 'media.heartbeat')).toBeUndefined();
    expect(scopedNodeId('media.heartbeatX', 'media.heartbeat')).toBeUndefined();
  });

  it('legacy unscoped message: any node while NATS auth is off; only legacy ids once it is on', () => {
    expect(acceptNodeMessage('media.heartbeat', 'media.heartbeat', 'node-x')).toMatchObject({ ok: true });
    process.env.NATS_AUTH_MODE = 'callout';
    expect(acceptNodeMessage('media.heartbeat', 'media.heartbeat', 'node-x')).toMatchObject({ ok: false });
    expect(acceptNodeMessage('media.heartbeat', 'media.heartbeat', 'node-1')).toMatchObject({ ok: true });
    // Older session_end payloads carry no node_id; only the legacy principal can publish unscoped.
    expect(acceptNodeMessage('specter.usage.session_end', 'specter.usage.session_end', undefined)).toMatchObject({ ok: true });
  });
});

describe('callout JWT wire format', () => {
  const issuer = nkeys.createAccount();
  const server = nkeys.createServer();
  const user = nkeys.createUser();

  function serverRequest(connect_opts: Record<string, unknown>) {
    return encodeNatsJwt({
      jti: 'x', iat: 1, iss: server.getPublicKey(), sub: issuer.getPublicKey(), aud: 'nats-authorization-request',
      nats: { server_id: { id: server.getPublicKey(), name: 's' }, user_nkey: user.getPublicKey(), connect_opts, type: 'authorization_request', version: 2 },
    }, server);
  }

  it('decodes and verifies a server-signed request; rejects a forged one', () => {
    const req = decodeServerJwt(serverRequest({ user: 'node-a' }));
    expect(req.nats.connect_opts.user).toBe('node-a');
    const forged = serverRequest({ user: 'node-a' }).split('.');
    forged[1] = Buffer.from(JSON.stringify({ ...dec(forged.join('.')), nats: { connect_opts: { user: 'evil' } } })).toString('base64url');
    expect(() => decodeServerJwt(forged.join('.'))).toThrow(/signature/);
    const notServer = encodeNatsJwt({ iss: issuer.getPublicKey() }, issuer);
    expect(() => decodeServerJwt(notServer)).toThrow(/server key/);
  });

  it('an allow response wraps a user JWT for the requesting nkey, in account SPECTER, signed by the issuer, with no expiry', () => {
    const req = decodeServerJwt(serverRequest({ user: 'node-a' }));
    const resp = buildCalloutResponse(req, { ok: true, name: 'node-a', permissions: nodePermissions('node-a') }, issuer);
    const [h, p, s] = resp.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ed25519-nkey' });
    expect(issuer.verify(enc.encode(`${h}.${p}`), Buffer.from(s, 'base64url'))).toBe(true);
    const r = dec(resp);
    expect(r).toMatchObject({ iss: issuer.getPublicKey(), sub: user.getPublicKey(), aud: server.getPublicKey(), nats: { type: 'authorization_response', version: 2 } });
    const u = dec(r.nats.jwt);
    expect(u).toMatchObject({ iss: issuer.getPublicKey(), sub: user.getPublicKey(), aud: CALLOUT_ACCOUNT, name: 'node-a', nats: { type: 'user', version: 2, pub: nodePermissions('node-a').pub } });
    expect(u.exp).toBeUndefined();
  });

  it('a deny response carries the error and no user JWT', () => {
    const req = decodeServerJwt(serverRequest({ user: 'node-a', pass: 'x' }));
    const r = dec(buildCalloutResponse(req, { ok: false, error: 'bad credentials' }, issuer));
    expect(r.nats).toEqual({ error: 'bad credentials', type: 'authorization_response', version: 2 });
  });
});
