/**
 * MR2: org-wide catch-up (messageController requestOrgSync / respondOrgSync).
 * Unit-level: the DB, NATS and the event-channel rule are mocked, so this
 * needs no database. Checks the access filtering and that every published
 * event is flat (top-level fields, no nested `payload` — the 9ef7ea3 bug).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
const publishEvent = vi.fn(async (_subject: string, _data: any) => {});
const getChannelScope = vi.fn();
const canUseChannel = vi.fn();
const channelMemberUserIds = vi.fn();

vi.mock('../config/db.js', () => ({ pool: { query: (...a: any[]) => query(...a) } }));
vi.mock('../config/nats.js', () => ({ publishEvent: (s: string, d: any) => publishEvent(s, d) }));
vi.mock('../utils/eventChannelAccess.js', () => ({
  getChannelScope: (...a: any[]) => getChannelScope(...a),
  canUseChannel: (...a: any[]) => canUseChannel(...a),
  channelMemberUserIds: (...a: any[]) => channelMemberUserIds(...a),
}));

const { filterSyncChannels, requestOrgSync, respondOrgSync } = await import('../controllers/messageController.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const PEER = '33333333-3333-4333-8333-333333333333';
const CH_ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CH_EVENT_OK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CH_EVENT_NO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CH_OTHER_ORG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

beforeEach(() => {
  query.mockReset();
  publishEvent.mockClear();
  getChannelScope.mockReset();
  canUseChannel.mockReset();
  channelMemberUserIds.mockReset();
});

describe('filterSyncChannels', () => {
  it('keeps org channels, allowed event channels; drops unknown, denied and duplicates', async () => {
    const out = await filterSyncChannels(
      [
        { channel_id: CH_ORG, since: '2026-10-25T00:00:00.000Z' },
        { channel_id: CH_EVENT_OK },
        { channel_id: CH_EVENT_NO, since: null },
        { channel_id: CH_OTHER_ORG },
        { channel_id: CH_ORG },
      ],
      [
        { id: CH_ORG, event_id: null },
        { id: CH_EVENT_OK, event_id: 'e1' },
        { id: CH_EVENT_NO, event_id: 'e1' },
      ],
      async (id) => id === CH_EVENT_OK,
    );
    expect(out).toEqual([
      { channel_id: CH_ORG, since: '2026-10-25T00:00:00.000Z' },
      { channel_id: CH_EVENT_OK, since: null },
    ]);
  });
});

describe('POST /orgs/:orgId/messages/sync-request', () => {
  it('publishes a flat org_sync_request with only the channels the caller may use', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // org member
      .mockResolvedValueOnce({ rows: [{ id: CH_ORG, event_id: null }, { id: CH_EVENT_OK, event_id: 'e1' }, { id: CH_EVENT_NO, event_id: 'e1' }] });
    getChannelScope.mockImplementation(async (id: string) => ({ scope: 'event', orgId: ORG, channelId: id, eventId: 'e1', kind: 'command', groupId: null, frequencyId: null }));
    canUseChannel.mockImplementation(async (scope: any) => scope.channelId === CH_EVENT_OK);

    const res = mockRes();
    await requestOrgSync({
      user: { id: ME }, params: { orgId: ORG },
      body: { channels: [{ channel_id: CH_ORG, since: null }, { channel_id: CH_EVENT_OK }, { channel_id: CH_EVENT_NO }, { channel_id: CH_OTHER_ORG }] },
    } as any, res);

    expect(res.statusCode).toBe(202);
    expect(res.body.channels).toEqual([CH_ORG, CH_EVENT_OK]);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    const [subject, data] = publishEvent.mock.calls[0];
    expect(subject).toBe(`specter.event.org.${ORG}`);
    expect(data).toEqual({
      type: 'org_sync_request', org_id: ORG, requester_id: ME,
      channels: [{ channel_id: CH_ORG, since: null }, { channel_id: CH_EVENT_OK, since: null }],
    });
    expect(data.payload).toBeUndefined();
  });

  it('refuses a non-member and publishes nothing when no channel survives the filter', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = mockRes();
    await requestOrgSync({ user: { id: ME }, params: { orgId: ORG }, body: { channels: [{ channel_id: CH_ORG }] } } as any, res);
    expect(res.statusCode).toBe(403);

    query
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [] });
    const res2 = mockRes();
    await requestOrgSync({ user: { id: ME }, params: { orgId: ORG }, body: { channels: [{ channel_id: CH_OTHER_ORG }] } } as any, res2);
    expect(res2.statusCode).toBe(202);
    expect(res2.body.channels).toEqual([]);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    const res = mockRes();
    await requestOrgSync({ user: { id: ME }, params: { orgId: ORG }, body: { channels: [] } } as any, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /orgs/:orgId/messages/sync-response', () => {
  const body = { to_user_id: PEER, channel_id: CH_EVENT_OK, bundle: 'AAAA', count: 3 };

  it('relays a flat sync_response bundle to the requester with relayed_by', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: ME }, { user_id: PEER }] });
    getChannelScope.mockResolvedValueOnce({ scope: 'event', orgId: ORG, channelId: CH_EVENT_OK, eventId: 'e1', kind: 'group', groupId: 'g', frequencyId: null });
    channelMemberUserIds.mockResolvedValueOnce([ME, PEER]);
    const res = mockRes();
    await respondOrgSync({ user: { id: ME }, params: { orgId: ORG }, body } as any, res);
    expect(res.statusCode).toBe(202);
    const [subject, data] = publishEvent.mock.calls[0];
    expect(subject).toBe(`specter.event.user.${PEER}`);
    expect(data).toEqual({ type: 'sync_response', org_id: ORG, channel_id: CH_EVENT_OK, relayed_by: ME, bundle: 'AAAA', count: 3 });
  });

  it('refuses when the recipient is not on the event channel', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: ME }, { user_id: PEER }] });
    getChannelScope.mockResolvedValueOnce({ scope: 'event', orgId: ORG, channelId: CH_EVENT_OK, eventId: 'e1', kind: 'group', groupId: 'g', frequencyId: null });
    channelMemberUserIds.mockResolvedValueOnce([ME]);
    const res = mockRes();
    await respondOrgSync({ user: { id: ME }, params: { orgId: ORG }, body } as any, res);
    expect(res.statusCode).toBe(403);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('refuses answering yourself and a recipient outside the org', async () => {
    const res = mockRes();
    await respondOrgSync({ user: { id: ME }, params: { orgId: ORG }, body: { ...body, to_user_id: ME } } as any, res);
    expect(res.statusCode).toBe(400);

    query.mockResolvedValueOnce({ rows: [{ user_id: ME }] });
    const res2 = mockRes();
    await respondOrgSync({ user: { id: ME }, params: { orgId: ORG }, body } as any, res2);
    expect(res2.statusCode).toBe(403);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
