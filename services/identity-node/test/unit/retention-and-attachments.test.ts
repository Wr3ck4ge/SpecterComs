import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
const publishEvent = vi.fn();
vi.mock('../../src/config/db.js', () => ({ pool: { query: (...a: any[]) => query(...a) } }));
vi.mock('../../src/config/nats.js', () => ({ publishEvent: (...a: any[]) => publishEvent(...a) }));
vi.mock('../../src/utils/eventChannelAccess.js', () => ({
  getChannelScope: async () => ({ scope: 'org', minLevel: 0 }),
  canUseChannel: async () => true,
  channelMemberUserIds: async () => [],
}));

import { bugReportRetentionDays, pruneOldBugReports, BUG_REPORT_PURGE_SQL } from '../../src/routes/bugReport.js';
import { TS_REPORT_PURGE_SQL, dismissedRetentionDays, retentionDays } from '../../src/utils/tsReport.js';
import { pruneClosedTsReports } from '../../src/routes/tsReport.js';
import { sendMessage, respondChannelSync } from '../../src/controllers/messageController.js';

const mkRes = () => {
  const r: any = { statusCode: 0, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
};

beforeEach(() => { query.mockReset(); publishEvent.mockReset(); });

describe('bug report retention', () => {
  it('defaults to 30 days, floors at 1, honours the env', () => {
    expect(bugReportRetentionDays({} as any)).toBe(30);
    expect(bugReportRetentionDays({ BUG_REPORT_RETENTION_DAYS: '0' } as any)).toBe(30);
    expect(bugReportRetentionDays({ BUG_REPORT_RETENTION_DAYS: '7' } as any)).toBe(7);
    expect(bugReportRetentionDays({ BUG_REPORT_TTL_DAYS: '14' } as any)).toBe(14);
  });
  it('deletes by created_at only, with the cutoff as a parameter', async () => {
    expect(BUG_REPORT_PURGE_SQL).toMatch(/DELETE FROM bug_reports WHERE created_at < NOW\(\) - make_interval\(days => \$1::int\)/);
    query.mockResolvedValue({ rowCount: 3 });
    expect(await pruneOldBugReports(30)).toBe(3);
    expect(query).toHaveBeenCalledWith(BUG_REPORT_PURGE_SQL, [30]);
  });
});

describe('T&S report retention', () => {
  it('dismissed default 30, floor 1; general stays 180', () => {
    expect(dismissedRetentionDays({} as any)).toBe(30);
    expect(dismissedRetentionDays({ TS_REPORT_DISMISSED_RETENTION_DAYS: '0' } as any)).toBe(30);
    expect(dismissedRetentionDays({ TS_REPORT_DISMISSED_RETENTION_DAYS: '10' } as any)).toBe(10);
    expect(retentionDays({} as any)).toBe(180);
  });
  it('SQL: legal hold blocks, CSAM wins over dismissed, dismissed uses $2', () => {
    expect(TS_REPORT_PURGE_SQL).toMatch(/NOT legal_hold/);
    expect(TS_REPORT_PURGE_SQL).toMatch(/closed_at IS NOT NULL/);
    const m = TS_REPORT_PURGE_SQL.match(/CASE (.*) END\)/)![1];
    expect(m.indexOf("category = 'csam'")).toBeLessThan(m.indexOf("state = 'dismissed'"));
    expect(m).toMatch(/GREATEST\(\$1::int, 365\)/);
    expect(m).toMatch(/state = 'dismissed' THEN \$2::int/);
  });
  it('passes both cutoffs to the query', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await pruneClosedTsReports(180, 30);
    expect(query).toHaveBeenCalledWith(TS_REPORT_PURGE_SQL, [180, 30]);
  });
});

describe('image_url is refused on the relay', () => {
  const params = { orgId: 'o', chanId: 'c' };
  it('sendMessage: 400 ATTACHMENTS_NOT_SUPPORTED for a non-null image_url', async () => {
    const res = mkRes();
    await sendMessage({ user: { id: 'u' }, params, body: { encrypted_content: 'x', image_url: 'data:image/png;base64,AAAA' } } as any, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('ATTACHMENTS_NOT_SUPPORTED');
    expect(publishEvent).not.toHaveBeenCalled();
  });
  it('sendMessage: null / absent still relays, with image_url always null', async () => {
    query.mockImplementation(async (sql: string) =>
      sql.includes('org_members') ? { rows: [{}] } : { rows: [{ callsign: 'a', global_tag: 'b' }] });
    for (const body of [{ encrypted_content: 'x', image_url: null }, { encrypted_content: 'x' }]) {
      publishEvent.mockReset();
      const res = mkRes();
      await sendMessage({ user: { id: 'u' }, params, body } as any, res);
      expect(res.statusCode).toBe(201);
      const evt = publishEvent.mock.calls[0][1];
      expect(evt.image_url).toBeNull();
      expect(evt.payload.image_url).toBeNull();
    }
  });
  it('respondChannelSync: 400 on a non-null image_url, strips null ones', async () => {
    const msg = { id: '1', sender_id: 's', encrypted_content: 'x', timestamp: 't' };
    const to = '11111111-1111-4111-8111-111111111111';
    let res = mkRes();
    await respondChannelSync({ user: { id: 'u' }, params, body: { to_user_id: to, messages: [{ ...msg, image_url: 'http://x' }] } } as any, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('ATTACHMENTS_NOT_SUPPORTED');
    query.mockResolvedValue({ rows: [{}] });
    res = mkRes();
    await respondChannelSync({ user: { id: 'u' }, params, body: { to_user_id: to, messages: [{ ...msg, image_url: null }] } } as any, res);
    expect(res.statusCode).toBe(202);
    expect('image_url' in publishEvent.mock.calls[0][1].messages[0]).toBe(false);
  });
});
