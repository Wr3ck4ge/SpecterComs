/**
 * provisionNode() / destroyNodeInfrastructure() against a MOCKED DigitalOcean
 * API (global fetch stubbed — nothing leaves the process, no token is real, no
 * droplet is created). The mock keeps a set of live droplets/records, and every
 * failure path asserts that set is empty afterwards.
 *
 * Flow: create droplet → poll for public IP → create DNS A record; any failure
 * after the droplet exists deletes it (and the record) and throws a
 * ProvisionError carrying the droplet id. DB-side orchestration (credential,
 * request rows, teardown, migration) is in src/test/nodes/node-lifecycle.test.ts.
 */
import crypto from 'crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { provisionNode, destroyNodeInfrastructure, ProvisionError } from '../../../src/utils/doProvisioning.js';

interface Call { method: string; path: string; body: any; auth: string | null }
let calls: Call[];
type Handler = (c: Call) => { status: number; body?: unknown } | undefined;
let handler: Handler;
let liveDroplets: Set<number>;
let liveRecords: Set<number>;

const DROPLET_ID = 424242;
const RECORD_ID = 777;
const FULL_TOKEN = 'do-full-access-TEST';

function okHandler(opts: { ipAfterPolls?: number } = {}): Handler {
  let polls = 0;
  return (c) => {
    if (c.method === 'POST' && c.path === '/droplets') { liveDroplets.add(DROPLET_ID); return { status: 202, body: { droplet: { id: DROPLET_ID } } }; }
    if (c.method === 'DELETE' && c.path === `/droplets/${DROPLET_ID}`) { liveDroplets.delete(DROPLET_ID); return { status: 204 }; }
    if (c.method === 'GET' && c.path === `/droplets/${DROPLET_ID}`) {
      polls++;
      const v4 = polls > (opts.ipAfterPolls ?? 0)
        ? [{ type: 'private', ip_address: '10.0.0.9' }, { type: 'public', ip_address: '203.0.113.7' }]
        : [];
      return { status: 200, body: { droplet: { id: DROPLET_ID, networks: { v4 } } } };
    }
    if (c.method === 'POST' && c.path === '/domains/spectercoms.net/records') { liveRecords.add(RECORD_ID); return { status: 201, body: { domain_record: { id: RECORD_ID } } }; }
    if (c.method === 'DELETE' && c.path === `/domains/spectercoms.net/records/${RECORD_ID}`) { liveRecords.delete(RECORD_ID); return { status: 204 }; }
    return undefined;
  };
}

beforeEach(() => {
  calls = [];
  liveDroplets = new Set();
  liveRecords = new Set();
  handler = okHandler();
  process.env.DO_API_TOKEN = FULL_TOKEN;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    expect(u.origin + '/v2').toBe('https://api.digitalocean.com/v2');
    const headers = (init.headers || {}) as Record<string, string>;
    const c: Call = {
      method: init.method || 'GET',
      path: u.pathname.replace(/^\/v2/, ''),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization ?? null,
    };
    calls.push(c);
    const r = handler(c) ?? { status: 404, body: { id: 'not_found' } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.DO_API_TOKEN;
});

const PUBLIC_KEY = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
const base = {
  region: 'nyc3', natsUrl: 'nats://10.0.0.2:4223', natsPassword: 'node-secret-TEST', vpcUuid: 'vpc-TEST',
  mediaTicketPublicKey: PUBLIC_KEY, mediaImageRef: 'ghcr.io/owner/specter-media:v1.10.50',
  ghcrPullToken: 'ghp_pull_TEST', ghcrPullUser: 'owner',
};
const summary = () => calls.map((c) => `${c.method} ${c.path}`);
const nothingLeft = () => { expect(liveDroplets.size, 'droplets left behind').toBe(0); expect(liveRecords.size, 'A records left behind').toBe(0); };

describe('provisionNode — happy path', () => {
  it('creates the droplet, polls for its public IP, then creates the A record (the CONTROL PLANE writes DNS, contract C4)', async () => {
    vi.useFakeTimers();
    handler = okHandler({ ipAfterPolls: 2 });
    const p = provisionNode({ ...base, nodeId: 'node-abc' });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p).resolves.toEqual({ nodeId: 'node-abc', dropletId: DROPLET_ID, dnsRecordId: RECORD_ID, publicUrl: 'https://node-abc.spectercoms.net' });
    expect(summary()).toEqual([
      'POST /droplets',
      `GET /droplets/${DROPLET_ID}`, `GET /droplets/${DROPLET_ID}`, `GET /droplets/${DROPLET_ID}`,
      'POST /domains/spectercoms.net/records',
    ]);
    expect(calls.at(-1)!.body).toEqual({ type: 'A', name: 'node-abc', data: '203.0.113.7', ttl: 300 });
  });

  it('sends the expected droplet spec (size, image, tags, VPC) with the control-plane token', async () => {
    await provisionNode({ ...base, nodeId: 'node-abc' });
    const create = calls[0];
    expect(create.auth).toBe(`Bearer ${FULL_TOKEN}`);
    expect(create.body).toMatchObject({
      name: 'node-abc', region: 'nyc3', size: 's-2vcpu-4gb', image: 'docker-20-04',
      tags: ['specter-node', 'specter-managed'], vpc_uuid: 'vpc-TEST',
    });
    expect(create.body.user_data).toContain('NODE_ID=node-abc');
    expect(create.body.user_data).toContain('PUBLIC_URL=https://node-abc.spectercoms.net');
  });

  it('no DigitalOcean token of any kind appears in user_data (eval C2 fixed)', async () => {
    await provisionNode({ ...base, nodeId: 'node-abc' });
    expect(calls[0].body.user_data).not.toContain(FULL_TOKEN);
    expect(calls[0].body.user_data).not.toMatch(/digitalocean|DO_DNS|do-dns/i);
  });

  it('omits vpc_uuid when not configured', async () => {
    await provisionNode({ ...base, vpcUuid: undefined, nodeId: 'node-abc' });
    expect(calls[0].body).not.toHaveProperty('vpc_uuid');
  });

  it('generates a valid node id when none is given', async () => {
    const r = await provisionNode(base);
    expect(r.nodeId).toMatch(/^node-[0-9a-f]{8}$/);
    expect(calls[0].body.name).toBe(r.nodeId);
  });

  it('a transient 5xx while polling is retried, not fatal (eval H4)', async () => {
    vi.useFakeTimers();
    const h = okHandler();
    let first = true;
    handler = (c) => {
      if (c.method === 'GET' && first) { first = false; return { status: 503, body: {} }; }
      return h(c);
    };
    const p = provisionNode({ ...base, nodeId: 'node-abc' });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(p).resolves.toMatchObject({ dropletId: DROPLET_ID });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('provisionNode — refuses before spending money', () => {
  it('invalid node id → throws with zero API calls', async () => {
    await expect(provisionNode({ ...base, nodeId: 'BAD_ID' })).rejects.toThrow(/Invalid node_id/);
    expect(calls).toHaveLength(0);
  });

  it('unsafe or invalid cloud-init input (unpinned image, bad key, newline in a secret) → zero API calls', async () => {
    for (const bad of [
      { mediaImageRef: 'ghcr.io/owner/specter-media:latest' },
      { mediaTicketPublicKey: 'nope' },
      { natsPassword: 'a\nENV_EOF' },
      { ghcrPullToken: '' },
    ]) {
      await expect(provisionNode({ ...base, nodeId: 'node-abc', ...bad })).rejects.toThrow(/Refusing to build cloud-init/);
    }
    expect(calls).toHaveLength(0);
  });

  it('missing control-plane token → throws on the first call, nothing created', async () => {
    delete process.env.DO_API_TOKEN;
    await expect(provisionNode({ ...base, nodeId: 'node-abc' })).rejects.toThrow(/DO_API_TOKEN/);
    expect(calls).toHaveLength(0);
  });

  it('droplet create rejected (e.g. 422 quota) → error surfaces, no further calls', async () => {
    handler = (c) => (c.path === '/droplets' ? { status: 422, body: { message: 'droplet limit exceeded' } } : undefined);
    await expect(provisionNode({ ...base, nodeId: 'node-abc' })).rejects.toThrow(/POST \/droplets failed: 422/);
    expect(summary()).toEqual(['POST /droplets']);
  });
});

describe('provisionNode — failures after the droplet exists: rollback (eval H4 fixed)', () => {
  it('IP poll times out after 120s → droplet deleted, ProvisionError carries its id', async () => {
    vi.useFakeTimers();
    handler = okHandler({ ipAfterPolls: Number.POSITIVE_INFINITY });
    const p = provisionNode({ ...base, nodeId: 'node-abc' }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(125_000);
    const err = await p;
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err).toMatchObject({ dropletId: DROPLET_ID, cleanedUp: true });
    expect(err.message).toMatch(/Timed out waiting for droplet 424242/);
    expect(summary().at(-1)).toBe(`DELETE /droplets/${DROPLET_ID}`);
    nothingLeft();
  });

  it('DNS record creation fails → droplet deleted, error names the droplet', async () => {
    const h = okHandler();
    handler = (c) => (c.method === 'POST' && c.path.startsWith('/domains') ? { status: 500, body: { message: 'boom' } } : h(c));
    const err = await provisionNode({ ...base, nodeId: 'node-abc' }).catch((e) => e);
    expect(String(err)).toMatch(/domains\/spectercoms.net\/records failed: 500/);
    expect(err.message).toContain(String(DROPLET_ID));
    expect(err.dropletId).toBe(DROPLET_ID);
    nothingLeft();
  });

  it('a non-transient error while polling (403) → droplet deleted', async () => {
    const h = okHandler();
    handler = (c) => (c.method === 'GET' ? { status: 403, body: {} } : h(c));
    const err = await provisionNode({ ...base, nodeId: 'node-abc' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProvisionError', dropletId: DROPLET_ID, cleanedUp: true });
    nothingLeft();
  });

  it('if the cleanup DELETE fails too, the error says CLEANUP INCOMPLETE with the droplet id (and it is logged)', async () => {
    const h = okHandler();
    handler = (c) => (c.method === 'POST' && c.path.startsWith('/domains') ? { status: 500 } : c.method === 'DELETE' ? { status: 500 } : h(c));
    const err = await provisionNode({ ...base, nodeId: 'node-abc' }).catch((e) => e);
    expect(err).toMatchObject({ cleanedUp: false, dropletId: DROPLET_ID });
    expect(err.message).toMatch(/CLEANUP INCOMPLETE — check droplet 424242/);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('destroyNodeInfrastructure', () => {
  it('deletes the A record then the droplet; 404s count as already gone', async () => {
    liveDroplets.add(DROPLET_ID); liveRecords.add(RECORD_ID);
    const r = await destroyNodeInfrastructure({ nodeId: 'node-abc', dropletId: DROPLET_ID, dnsRecordId: RECORD_ID });
    expect(r).toEqual({ dropletDeleted: true, dnsDeleted: true, errors: [] });
    nothingLeft();
    const again = await destroyNodeInfrastructure({ nodeId: 'node-abc', dropletId: DROPLET_ID, dnsRecordId: RECORD_ID });
    expect(again).toMatchObject({ dropletDeleted: true, errors: [] });
  });

  it('with verifyTag, refuses a droplet that is not specter-managed', async () => {
    handler = (c) => (c.method === 'GET' ? { status: 200, body: { droplet: { id: 5, name: 'node-abc', tags: ['prod'] } } } : undefined);
    const r = await destroyNodeInfrastructure({ nodeId: 'node-abc', dropletId: 5, verifyTag: true });
    expect(r.dropletDeleted).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
