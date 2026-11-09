/**
 * MR2: DM peer backfill events (dmController requestDmSync / respondDmSync)
 * are published FLAT — the nested `payload` shape they used to have was never
 * read by any client. DB and NATS mocked; no database needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
const publishEvent = vi.fn(async (_subject: string, _data: any) => {});
vi.mock('../config/db.js', () => ({ pool: { query: (...a: any[]) => query(...a) } }));
vi.mock('../config/nats.js', () => ({ publishEvent: (s: string, d: any) => publishEvent(s, d) }));

const { requestDmSync, respondDmSync } = await import('../controllers/dmController.js');

const ME = '22222222-2222-4222-8222-222222222222';
const PEER = '33333333-3333-4333-8333-333333333333';
const CONV = [ME, PEER].sort().join('-');

function mockRes() {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

beforeEach(() => { query.mockReset(); publishEvent.mockClear(); });

describe('DM sync events', () => {
  it('dm_sync_request is flat: conversation_id, requester_id, since', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });
    const res = mockRes();
    await requestDmSync({ user: { id: ME }, params: { userId: PEER }, body: { since: '2026-10-25T00:00:00.000Z' } } as any, res);
    expect(res.statusCode).toBe(202);
    expect(publishEvent).toHaveBeenCalledWith(`specter.event.user.${PEER}`, {
      type: 'dm_sync_request', conversation_id: CONV, requester_id: ME, since: '2026-10-25T00:00:00.000Z',
    });
  });

  it('dm_sync_response is flat: conversation_id, relayed_by, bundle, count', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });
    const res = mockRes();
    await respondDmSync({ user: { id: ME }, params: { userId: PEER }, body: { bundle: 'QUJD', count: 2 } } as any, res);
    expect(res.statusCode).toBe(202);
    const [subject, data] = publishEvent.mock.calls[0];
    expect(subject).toBe(`specter.event.user.${PEER}`);
    expect(data).toEqual({ type: 'dm_sync_response', conversation_id: CONV, relayed_by: ME, bundle: 'QUJD', count: 2 });
  });

  it('rejects a missing/oversized bundle, a bad count, non-friends and self', async () => {
    for (const body of [{}, { bundle: '' }, { bundle: 'x'.repeat(95_001) }, { bundle: 'x', count: -1 }, { bundle: 'x', count: 1.5 }]) {
      const res = mockRes();
      await respondDmSync({ user: { id: ME }, params: { userId: PEER }, body } as any, res);
      expect(res.statusCode).toBe(400);
    }
    const self = mockRes();
    await respondDmSync({ user: { id: ME }, params: { userId: ME }, body: { bundle: 'x' } } as any, self);
    expect(self.statusCode).toBe(400);
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const nf = mockRes();
    await respondDmSync({ user: { id: ME }, params: { userId: PEER }, body: { bundle: 'x' } } as any, nf);
    expect(nf.statusCode).toBe(403);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});
