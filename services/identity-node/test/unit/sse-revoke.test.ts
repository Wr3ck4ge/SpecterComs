/**
 * B5: a user who loses access to a channel stops receiving its SSE relays
 * immediately, on every open stream (device), without being told anything.
 * The registry on fake streams, then the real eventStream over a fake NATS.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type FakeSub = { subject: string; unsubscribed: boolean; push: (data: unknown) => void; unsubscribe: () => void; [Symbol.asyncIterator]: () => AsyncIterator<any> };

const holder = vi.hoisted(() => ({
  subs: [] as any[],
  orgRows: [] as { org_id: string }[],
  chanRows: [] as { id: string; org_id: string }[],
  allowed: new Set<string>(),
}));

function fakeSub(subject: string): FakeSub {
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  const sub: FakeSub = {
    subject,
    unsubscribed: false,
    push(data) { queue.push({ subject, data: new TextEncoder().encode(JSON.stringify(data)) }); wake?.(); },
    unsubscribe() { sub.unsubscribed = true; wake?.(); },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          while (queue.length === 0 && !sub.unsubscribed) await new Promise<void>((r) => { wake = r; });
          if (queue.length) return { value: queue.shift(), done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
  return sub;
}

vi.mock('../../src/config/db.js', () => {
  const query = async (text: string) => {
    if (/FROM org_members WHERE user_id/.test(text)) return { rows: holder.orgRows };
    if (/FROM channels c/.test(text)) return { rows: holder.chanRows };
    return { rows: [] };
  };
  return { pool: { query }, query };
});
vi.mock('../../src/config/nats.js', () => ({
  connectNats: async () => ({ subscribe: (subject: string) => { const s = fakeSub(subject); holder.subs.push(s); return s; } }),
  publishEvent: async () => {},
}));
vi.mock('../../src/utils/eventChannelAccess.js', () => ({
  getChannelScope: async (channelId: string, orgId: string) => ({ scope: 'org', orgId, channelId, minLevel: 50 }),
  canUseChannel: async (scope: any) => holder.allowed.has(scope.channelId),
}));
vi.mock('../../src/utils/onlineUsers.js', () => ({ markStreamOpen: () => {}, markStreamClosed: () => {} }));

const sse = await import('../../src/controllers/sseController.js');

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('live-stream registry', () => {
  it('no open stream → a no-op', () => {
    expect(sse.revokeChannelSubscriptions('nobody', ['c1'])).toBe(0);
    expect(sse.revokeOrgSubscriptions('nobody', 'o1')).toBe(0);
  });
  it('every stream (device) of that user, and only that user, is revoked; unregister is idempotent', () => {
    const a1 = { revokeChannels: vi.fn(), revokeOrg: vi.fn() };
    const a2 = { revokeChannels: vi.fn(), revokeOrg: vi.fn() };
    const b = { revokeChannels: vi.fn(), revokeOrg: vi.fn() };
    const offA1 = sse.registerLiveStream('ua', a1);
    const offA2 = sse.registerLiveStream('ua', a2);
    const offB = sse.registerLiveStream('ub', b);
    expect(sse.revokeChannelSubscriptions('ua', ['c1', 'c2', 'c1'])).toBe(2);
    expect(a1.revokeChannels).toHaveBeenCalledWith(['c1', 'c2']);
    expect(a2.revokeChannels).toHaveBeenCalledWith(['c1', 'c2']);
    expect(b.revokeChannels).not.toHaveBeenCalled();
    expect(sse.revokeChannelSubscriptions('ua', [])).toBe(0);
    sse.revokeOrgSubscriptions('ua', 'o1');
    expect(a1.revokeOrg).toHaveBeenCalledWith('o1');
    offA1(); offA1();
    expect(sse.liveStreamCount('ua')).toBe(1);
    offA2(); offB();
    expect(sse.liveStreamCount('ua')).toBe(0);
  });
  it('one stream throwing does not stop the others', () => {
    const bad = { revokeChannels: () => { throw new Error('boom'); }, revokeOrg: () => {} };
    const good = { revokeChannels: vi.fn(), revokeOrg: vi.fn() };
    const off1 = sse.registerLiveStream('uc', bad);
    const off2 = sse.registerLiveStream('uc', good);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(sse.revokeChannelSubscriptions('uc', ['c1'])).toBe(2);
    expect(good.revokeChannels).toHaveBeenCalled();
    err.mockRestore();
    off1(); off2();
  });
});

describe('eventStream (fake NATS)', () => {
  beforeEach(() => {
    holder.subs = [];
    holder.orgRows = [{ org_id: 'org1' }];
    holder.chanRows = [{ id: 'general', org_id: 'org1' }, { id: 'officers', org_id: 'org1' }];
    holder.allowed = new Set();
  });

  async function open(userId: string) {
    const closeHandlers: (() => void)[] = [];
    const writes: string[] = [];
    const req: any = { user: { id: userId }, on: (ev: string, fn: () => void) => { if (ev === 'close') closeHandlers.push(fn); } };
    const res: any = { writeHead: () => {}, flushHeaders: () => {}, write: (s: string) => { writes.push(s); return true; } };
    await sse.eventStream(req, res);
    return { writes, close: () => closeHandlers.forEach((f) => f()) };
  }
  const subFor = (subject: string) => holder.subs.filter((s) => s.subject === subject);
  const live = (subject: string) => subFor(subject).filter((s) => !s.unsubscribed);

  it('a revoked channel is unsubscribed on every device; the rest stay; nothing is written', async () => {
    const d1 = await open('u1');
    const d2 = await open('u1');
    expect(live('specter.msg.channel.officers')).toHaveLength(2);
    const before = d1.writes.length + d2.writes.length;
    expect(sse.revokeChannelSubscriptions('u1', ['officers'])).toBe(2);
    expect(live('specter.msg.channel.officers')).toHaveLength(0);
    expect(live('specter.msg.channel.general')).toHaveLength(2);
    expect(live('specter.event.org.org1')).toHaveLength(2);
    await tick();
    expect(d1.writes.length + d2.writes.length).toBe(before);
    d1.close(); d2.close();
    expect(sse.liveStreamCount('u1')).toBe(0);
  });

  it('a resync does not re-add a revoked channel until the rule allows it again', async () => {
    const d = await open('u2');
    sse.revokeChannelSubscriptions('u2', ['officers']);
    const org = live('specter.event.org.org1')[0];
    org.push({ type: 'channel_updated' });
    await tick();
    expect(live('specter.msg.channel.officers')).toHaveLength(0);
    holder.allowed.add('officers'); // promoted back
    org.push({ type: 'member_updated' });
    await tick();
    expect(live('specter.msg.channel.officers')).toHaveLength(1);
    d.close();
  });

  it("member_removed for this user (kick / ban) drops the org's subject and all its channels", async () => {
    const d = await open('u3');
    const org = live('specter.event.org.org1')[0];
    org.push({ type: 'member_removed', userId: 'someone-else' });
    await tick();
    expect(live('specter.msg.channel.general')).toHaveLength(1);
    org.push({ type: 'member_removed', userId: 'u3', reason: 'kick' });
    await tick();
    expect(live('specter.event.org.org1')).toHaveLength(0);
    expect(live('specter.msg.channel.general')).toHaveLength(0);
    expect(live('specter.msg.channel.officers')).toHaveLength(0);
    expect(live('specter.event.user.u3')).toHaveLength(1); // still told about orgs_changed
    d.close();
    expect(live('specter.event.user.u3')).toHaveLength(0);
  });
});
