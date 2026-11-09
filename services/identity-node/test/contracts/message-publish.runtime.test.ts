/**
 * Contract test (runtime): drive messageController's handlers with a mocked
 * pool and a capturing publishEvent, and validate every published object
 * with shared/events/schema.js's validateEvent — the same check the client
 * test runs on the receiving side. This is the path the 2.0.0 incident broke.
 *
 * No database or NATS: pool.query answers every query with one permissive
 * row, and the event-channel access helpers are stubbed to "org channel,
 * allowed". If messageController grows a new guard that needs a different
 * row shape, extend `row` below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateEvent } from '../../../../shared/events/schema.js';

const published: { subject: string; data: any }[] = [];

vi.mock('../../src/config/nats.js', () => ({
  publishEvent: vi.fn(async (subject: string, data: any) => { published.push({ subject, data }); }),
  connectNats: vi.fn(async () => null),
}));

const row = { '?column?': 1, callsign: 'alpha', global_tag: null, org_id: 'org-1', user_id: 'user-1' };
vi.mock('../../src/config/db.js', () => {
  const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
  return { pool: { query, connect: vi.fn(async () => ({ query, release: () => {} })) } };
});

vi.mock('../../src/utils/eventChannelAccess.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChannelScope: vi.fn(async (channelId: string, orgId: string) => ({ scope: 'org', orgId, channelId })),
  canUseChannel: vi.fn(async () => true),
}));

const mc = await import('../../src/controllers/messageController.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const CHAN = '22222222-2222-4222-8222-222222222222';
const ME = '33333333-3333-4333-8333-333333333333';
const PEER = '44444444-4444-4444-8444-444444444444';

function call(handler: (req: any, res: any) => any, req: Record<string, unknown>) {
  let status = 200; let body: unknown;
  const res: any = {
    status(s: number) { status = s; return res; },
    json(b: unknown) { body = b; return res; },
    send(b: unknown) { body = b; return res; },
    end() { return res; },
  };
  return Promise.resolve(handler({ user: { id: ME, callsign: 'alpha' }, params: {}, body: {}, ...req }, res))
    .then(() => ({ status, body }));
}

function expectValid() {
  expect(published.length, 'nothing was published').toBeGreaterThan(0);
  for (const { subject, data } of published) {
    expect(validateEvent(data, subject), `${data?.type} on ${subject}`).toEqual([]);
  }
}

beforeEach(() => { published.length = 0; });

describe('messageController publishes schema-valid events', () => {
  it('sendMessage → message_relay (flat, plus nested copy for background_sync.rs)', async () => {
    const r = await call(mc.sendMessage, {
      params: { orgId: ORG, chanId: CHAN },
      body: { encrypted_content: 'Y2lwaGVydGV4dA==' },
    });
    expect(r.status).toBe(201);
    expectValid();
    const { subject, data } = published[0];
    expect(subject).toBe(`specter.msg.channel.${CHAN}`);
    expect(data).toMatchObject({ type: 'message_relay', channel_id: CHAN, sender_id: ME, encrypted_content: 'Y2lwaGVydGV4dA==' });
    expect(data.payload).toMatchObject({ channel_id: CHAN, encrypted_content: 'Y2lwaGVydGV4dA==' });
  });

  it('requestChannelSync → sync_request', async () => {
    const r = await call(mc.requestChannelSync, {
      params: { orgId: ORG, chanId: CHAN },
      body: { since: '2026-10-25T00:00:00.000Z' },
    });
    expect(r.status).toBe(202);
    expectValid();
    expect(published[0].data).toMatchObject({ type: 'sync_request', channel_id: CHAN, requester_id: ME });
  });

  it('respondChannelSync → sync_response', async () => {
    const r = await call(mc.respondChannelSync, {
      params: { orgId: ORG, chanId: CHAN },
      body: {
        to_user_id: PEER,
        messages: [{ id: 'm1', sender_id: ME, encrypted_content: 'eA==', timestamp: '2026-10-25T00:00:00.000Z' }],
      },
    });
    expect(r.status).toBe(202);
    expectValid();
    expect(published[0].subject).toBe(`specter.event.user.${PEER}`);
  });

  it('a nested-only relay (the 2.0.0 shape) is rejected by validateEvent', () => {
    const legacy = { type: 'message_relay', payload: { channel_id: CHAN, encrypted_content: 'x' } };
    expect(validateEvent(legacy, `specter.msg.channel.${CHAN}`).join('\n')).toMatch(/channel_id: missing/);
  });
});
