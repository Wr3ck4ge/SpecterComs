/**
 * Contract test (runtime), S7 franking: messageController / dmController accept
 * an optional `frank { v, c }`, reject a malformed one, and relay
 * `frank { v, c, kid, tag }` top level and in the nested copy — or untagged
 * when FRANK_KEYS is unset. Every published event must still pass
 * shared/events validateEvent. Also: the mls/members endpoints return
 * device_caps. Mocked pool + capturing publishEvent (see
 * message-publish.runtime.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateEvent } from '../../../../shared/events/schema.js';

const published: { subject: string; data: any }[] = [];

vi.mock('../../src/config/nats.js', () => ({
  publishEvent: vi.fn(async (subject: string, data: any) => { published.push({ subject, data }); }),
  connectNats: vi.fn(async () => null),
}));

const row = { '?column?': 1, callsign: 'alpha', global_tag: null, org_id: 'org-1', user_id: 'user-1', id: 'dev-1', wire_caps: 3 };
vi.mock('../../src/config/db.js', () => {
  const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
  return { pool: { query, connect: vi.fn(async () => ({ query, release: () => {} })) } };
});

vi.mock('../../src/utils/eventChannelAccess.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChannelScope: vi.fn(async (channelId: string, orgId: string) => ({ scope: 'org', orgId, channelId })),
  canUseChannel: vi.fn(async () => true),
  channelMemberUserIds: vi.fn(async () => ['33333333-3333-4333-8333-333333333333']),
}));

const mc = await import('../../src/controllers/messageController.js');
const dc = await import('../../src/controllers/dmController.js');
const mls = await import('../../src/controllers/mlsGroupController.js');
const { verifyFrankTag, parseFrankKeys, _resetFrankingForTests } = await import('../../src/utils/franking.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const CHAN = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const PEER = '44444444-4444-4444-8444-444444444444';
const KEY = Buffer.alloc(32, 9).toString('base64');
const C = Buffer.alloc(32, 5).toString('base64');

function call(handler: (req: any, res: any) => any, req: Record<string, unknown>) {
  let status = 200; let body: any;
  const res: any = {
    status(s: number) { status = s; return res; },
    json(b: unknown) { body = b; return res; },
    send(b: unknown) { body = b; return res; },
    end() { return res; },
  };
  return Promise.resolve(handler({ user: { id: ME, callsign: 'alpha' }, params: {}, body: {}, headers: {}, ...req }, res))
    .then(() => ({ status, body }));
}

function expectValid() {
  for (const { subject, data } of published) {
    if (subject.startsWith('specter.msg.dm.')) continue; // internal JetStream buffer, no SSE contract
    expect(validateEvent(data, subject), `${data?.type} on ${subject}`).toEqual([]);
  }
}

beforeEach(() => {
  published.length = 0;
  _resetFrankingForTests();
  process.env.FRANK_KEYS = `k1:${KEY}`;
});

describe('channel messages', () => {
  it('frank accepted and relayed with a server tag (top level + nested)', async () => {
    const r = await call(mc.sendMessage, {
      params: { orgId: ORG, chanId: CHAN },
      body: { encrypted_content: 'Y2lwaGVy', frank: { v: 1, c: C } },
    });
    expect(r.status).toBe(201);
    expectValid();
    const { data } = published[0];
    expect(data.frank).toMatchObject({ v: 1, c: C, kid: 'k1' });
    expect(data.payload.frank).toEqual(data.frank);
    const ctx = { senderId: ME, conversationId: CHAN, msgId: data.id, timestamp: data.timestamp };
    expect(verifyFrankTag(data.frank, ctx, parseFrankKeys(`k1:${KEY}`))).toBe(true);
    expect(r.body).toEqual({ id: data.id, timestamp: data.timestamp });
  });

  it('a bad commitment is rejected and nothing is relayed', async () => {
    for (const frank of [{ v: 1, c: 'c2hvcnQ=' }, { v: 1 }, { v: 9, c: C }, 'x']) {
      const r = await call(mc.sendMessage, {
        params: { orgId: ORG, chanId: CHAN },
        body: { encrypted_content: 'Y2lwaGVy', frank },
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('BAD_FRANK');
    }
    expect(published).toHaveLength(0);
  });

  it('v1 senders (no frank) relay exactly as before', async () => {
    await call(mc.sendMessage, { params: { orgId: ORG, chanId: CHAN }, body: { encrypted_content: 'eA==' } });
    expectValid();
    expect('frank' in published[0].data).toBe(false);
    expect('frank' in published[0].data.payload).toBe(false);
  });

  it('no FRANK_KEYS → relayed untagged (no crash)', async () => {
    delete process.env.FRANK_KEYS;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await call(mc.sendMessage, {
      params: { orgId: ORG, chanId: CHAN },
      body: { encrypted_content: 'Y2lwaGVy', frank: { v: 1, c: C } },
    });
    expect(r.status).toBe(201);
    expectValid();
    expect(published[0].data.frank).toEqual({ v: 1, c: C });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('cap is 6400 characters', async () => {
    const ok = await call(mc.sendMessage, { params: { orgId: ORG, chanId: CHAN }, body: { encrypted_content: 'a'.repeat(6400) } });
    expect(ok.status).toBe(201);
    const big = await call(mc.sendMessage, { params: { orgId: ORG, chanId: CHAN }, body: { encrypted_content: 'a'.repeat(6401) } });
    expect(big.status).toBe(400);
  });

  it('legacy per-channel sync-response carries a relayed frank through', async () => {
    const frank = { v: 1, c: C, kid: 'k1', tag: Buffer.alloc(32, 1).toString('base64') };
    const r = await call(mc.respondChannelSync, {
      params: { orgId: ORG, chanId: CHAN },
      body: { to_user_id: PEER, messages: [{ id: 'm1', sender_id: ME, encrypted_content: 'eA==', timestamp: '2026-11-12T00:00:00.000Z', frank }] },
    });
    expect(r.status).toBe(202);
    expectValid();
    expect(published[0].data.messages[0].frank).toEqual(frank);
  });
});

describe('DMs', () => {
  it('frank accepted and relayed with a tag over the conversation id', async () => {
    const r = await call(dc.sendDirectMessage, { params: { userId: PEER }, body: { encrypted_content: 'Y2lwaGVy', frank: { v: 1, c: C } } });
    expect(r.status).toBe(201);
    expectValid();
    const relay = published.find((p) => p.data.type === 'message_relay')!.data.message;
    expect(relay.frank.kid).toBe('k1');
    const convId = [ME, PEER].sort().join('-');
    const ctx = { senderId: ME, conversationId: convId, msgId: relay.id, timestamp: relay.timestamp };
    expect(verifyFrankTag(relay.frank, ctx, parseFrankKeys(`k1:${KEY}`))).toBe(true);
    // The JetStream offline-buffer copy carries it too.
    expect(published.find((p) => p.subject.startsWith('specter.msg.dm.'))!.data.frank).toEqual(relay.frank);
  });

  it('a bad commitment is rejected', async () => {
    const r = await call(dc.sendDirectMessage, { params: { userId: PEER }, body: { encrypted_content: 'Y2lwaGVy', frank: { v: 1, c: 'AAAA' } } });
    expect(r.status).toBe(400);
    expect(published).toHaveLength(0);
  });
});

describe('device caps', () => {
  it('channel mls/members returns device_caps', async () => {
    const r = await call(mls.getChannelMlsMembers, { params: { orgId: ORG, chanId: CHAN } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: 'org', user_ids: [ME], device_caps: { 'dev-1': 3 } });
  });
  it('DM mls/members returns both participants and device_caps', async () => {
    const r = await call(mls.getDmMlsMembers, { params: { userId: PEER } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ scope: 'dm', user_ids: [ME, PEER], device_caps: { 'dev-1': 3 } });
  });
});
