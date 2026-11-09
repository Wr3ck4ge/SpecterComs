/**
 * Netprobe (server-assisted network diagnosis): POST/GET /diag/netprobe and
 * the relay-answer ingestion in controllers/netprobeController.ts. NATS is
 * stubbed: publishEvent records the arm command and (optionally) plays the
 * relay's "armed" answer back into the store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const holder = vi.hoisted(() => ({
  published: [] as Array<{ subject: string; data: any }>,
  onPublish: null as null | ((subject: string, data: any) => void),
}));
vi.mock('../../src/config/nats.js', () => ({
  publishEvent: async (subject: string, data: any) => {
    holder.published.push({ subject, data });
    holder.onPublish?.(subject, data);
  },
  connectNats: async () => null,
  getNatsConnection: () => null,
}));

import {
  createNetprobeStore, makeStartNetprobe, makeGetNetprobe, NETPROBE_ARM_SUBJECT, NETPROBE_RATE, NETPROBE_TTL_SECS,
} from '../../src/controllers/netprobeController.js';

let store: ReturnType<typeof createNetprobeStore>;
let currentUser = 'u1';

function buildApp() {
  const app = express();
  app.use(express.json());
  const fakeAuth = (req: any, _res: any, next: any) => { req.user = currentUser ? { id: currentUser } : undefined; next(); };
  app.post('/diag/netprobe', fakeAuth, makeStartNetprobe(store, 300) as any);
  app.get('/diag/netprobe/:token', fakeAuth, makeGetNetprobe(store) as any);
  return app;
}

const armedBy = (nodeId: string, extra: any = {}) => (subject: string, data: any) => {
  if (subject !== NETPROBE_ARM_SUBJECT) return;
  store.ingest(`specter.diag.netprobe.${nodeId}`, {
    type: 'armed', node_id: nodeId, token: data.token, ports: [3478, 40443], public_url: 'https://spectercoms.net', ...extra,
  });
};

beforeEach(() => {
  store = createNetprobeStore();
  holder.published = [];
  holder.onPublish = null;
  currentUser = 'u1';
});

describe('POST /diag/netprobe', () => {
  it('mints a single-use token + key, arms the relays and returns the armed targets', async () => {
    holder.onPublish = armedBy('node-1');
    const r = await request(buildApp()).post('/diag/netprobe').send({});
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body.key).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.ttl_secs).toBe(NETPROBE_TTL_SECS);
    expect(r.body.targets).toEqual([{ node_id: 'node-1', public_url: 'https://spectercoms.net', ports: [3478, 40443] }]);
    expect(holder.published).toHaveLength(1);
    expect(holder.published[0].subject).toBe(NETPROBE_ARM_SUBJECT);
    expect(holder.published[0].data).toMatchObject({ token: r.body.token, key: r.body.key, ttl_secs: NETPROBE_TTL_SECS });
  });

  it('answers with no targets when no relay armed it (UDP probes then just skip)', async () => {
    const r = await request(buildApp()).post('/diag/netprobe').send({});
    expect(r.status).toBe(200);
    expect(r.body.targets).toEqual([]);
  });

  it(`is rate-limited to ${NETPROBE_RATE.max} per window per user`, async () => {
    const app = buildApp();
    for (let i = 0; i < NETPROBE_RATE.max; i++) expect((await request(app).post('/diag/netprobe')).status).toBe(200);
    expect((await request(app).post('/diag/netprobe')).status).toBe(429);
    currentUser = 'u2';
    expect((await request(app).post('/diag/netprobe')).status).toBe(200);
  });

  it('requires a user', async () => {
    currentUser = '';
    expect((await request(buildApp()).post('/diag/netprobe')).status).toBe(401);
  });

  it('tokens are unique per start', async () => {
    const app = buildApp();
    const a = await request(app).post('/diag/netprobe');
    const b = await request(app).post('/diag/netprobe');
    expect(a.body.token).not.toBe(b.body.token);
    expect(a.body.key).not.toBe(b.body.key);
  });
});

describe('GET /diag/netprobe/:token', () => {
  it('returns what the relay reported, to the owner only', async () => {
    const app = buildApp();
    holder.onPublish = armedBy('node-1');
    const { body } = await request(app).post('/diag/netprobe');
    expect(store.ingest('specter.diag.netprobe.node-1', {
      type: 'report', node_id: 'node-1', token: body.token, ports: [3478],
      packets: [{ port: 3478, size: 200, seq: 0, at_ms: 12, src: '203.0.113.7:5000', replied: true }],
      replies_sent: 1, dropped_over_cap: 0, webtransport: [{ at_ms: 40, src: '203.0.113.7:5001' }],
      client_ip_matched: true, final_report: false,
    })).toBe('ok');
    const r = await request(app).get(`/diag/netprobe/${body.token}`);
    expect(r.status).toBe(200);
    expect(r.body.key).toBeUndefined();
    expect(r.body.reports).toHaveLength(1);
    expect(r.body.reports[0]).toMatchObject({ node_id: 'node-1', replies_sent: 1, client_ip_matched: true });
    expect(r.body.reports[0].packets[0]).toEqual({ port: 3478, size: 200, seq: 0, at_ms: 12, src: '203.0.113.7:5000', replied: true });
    currentUser = 'someone-else';
    expect((await request(app).get(`/diag/netprobe/${body.token}`)).status).toBe(404);
    expect((await request(app).get('/diag/netprobe/not-a-token')).status).toBe(404);
  });
});

describe('relay answer ingestion', () => {
  it('drops answers whose node_id disagrees with the subject, unknown tokens and foreign subjects', async () => {
    const p = store.create('u1', null)!;
    expect(store.ingest('specter.diag.netprobe.node-1', { type: 'armed', node_id: 'node-2', token: p.token })).toBe('node_mismatch');
    expect(store.ingest('specter.diag.netprobe.node-1', { type: 'armed', node_id: 'node-1', token: 'f'.repeat(32) })).toBe('unknown_token');
    expect(store.ingest('specter.diag.netprobe', { type: 'armed', node_id: 'node-1', token: p.token })).toBe('bad_subject');
    expect(store.ingest('media.heartbeat.node-1', { type: 'armed', node_id: 'node-1', token: p.token })).toBe('bad_subject');
    expect(store.ingest('specter.diag.netprobe.node-1', { type: 'other', node_id: 'node-1', token: p.token })).toBe('bad_type');
    expect(p.targets.size).toBe(0);
  });

  it('bounds what it keeps from a report', () => {
    const p = store.create('u1', null)!;
    store.ingest('specter.diag.netprobe.node-1', {
      type: 'report', node_id: 'node-1', token: p.token, ports: [1, 2, 3, 4, 5, 0, 70000],
      packets: Array.from({ length: 500 }, (_, i) => ({ port: 1, size: 100, seq: i, at_ms: i, src: 'x'.repeat(500), replied: true })),
    });
    const rep = p.reports.get('node-1')!;
    expect(rep.packets.length).toBe(64);
    expect(rep.packets[0].src.length).toBe(64);
    expect(p.targets.get('node-1')!.ports).toEqual([1, 2, 3, 4]);
  });

  it('forgets a probe a minute after it expires', () => {
    let t = 1_000_000;
    const s = createNetprobeStore(() => t);
    const p = s.create('u1', null)!;
    t += NETPROBE_TTL_SECS * 1000 + 30_000;
    expect(s.get(p.token)).toBeDefined();
    t += 60_000;
    expect(s.get(p.token)).toBeUndefined();
  });
});
