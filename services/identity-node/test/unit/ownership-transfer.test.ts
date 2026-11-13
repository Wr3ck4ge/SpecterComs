/**
 * L13: ownership transfer + abandonment. The DB is an in-memory fake that
 * understands exactly the statements utils/ownershipTransfer.ts issues
 * (BEGIN/ROLLBACK snapshot the state, so atomicity is real).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as argon2 from 'argon2';

const S: any = {};
const day = 86_400_000;
const now = () => Date.now();
const mkErr = (code: string) => Object.assign(new Error(code), { code });

function fresh(hash: string) {
  Object.assign(S, {
    owner: 'owner', failSwap: false,
    members: { owner: { role: 'cmd', joined: 1 }, admin: { role: 'cmd2', joined: 2 }, mem: { role: 'op', joined: 3 } } as Record<string, any>,
    roles: [{ id: 'cmd', level: 100 }, { id: 'cmd2', level: 80 }, { id: 'op', level: 10 }],
    users: {
      owner: { hash, erased: null, created: new Date(now() - 900 * day), last: new Date(now() - day) },
      admin: { hash, erased: null, created: new Date(now() - 900 * day), last: new Date(now() - day) },
      mem: { hash, erased: null, created: new Date(now() - 900 * day), last: new Date(now() - day) },
    } as Record<string, any>,
    transfers: [] as any[], claims: [] as any[], audit: [] as any[], events: [] as any[], seq: 0,
  });
}

let snap: any = null;
async function q(sql: string, p: any[] = []) {
  const T = () => S.transfers, C = () => S.claims;
  const pend = (r: any) => r.status === 'pending';
  if (sql === 'BEGIN') { snap = structuredClone({ owner: S.owner, members: S.members, transfers: S.transfers, claims: S.claims, audit: S.audit }); return { rows: [] }; }
  if (sql === 'COMMIT') { snap = null; return { rows: [] }; }
  if (sql === 'ROLLBACK') { if (snap) Object.assign(S, snap); snap = null; return { rows: [] }; }
  if (sql.startsWith('SELECT owner_id FROM organizations')) return { rows: [{ owner_id: S.owner }] };
  if (sql.startsWith('SELECT password_hash')) return { rows: [{ password_hash: S.users[p[0]]?.hash }] };
  if (sql.startsWith('SELECT 1 FROM org_members')) return { rows: S.members[p[1]] ? [{}] : [] };
  if (sql.startsWith('SELECT 1 FROM users')) return { rows: S.users[p[0]] && !S.users[p[0]].erased ? [{}] : [] };
  if (sql.includes("SET status = 'expired'") && sql.includes('org_ownership_transfers')) {
    const hit = T().filter((t: any) => pend(t) && t.expires <= now() && (sql.includes('org_id = $1 AND') ? true : true) && (!sql.includes('WHERE id = $1') || t.id === p[0]));
    hit.forEach((t: any) => { t.status = 'expired'; });
    return { rows: hit.map((t: any) => ({ org_id: 'org', from_user_id: t.from, to_user_id: t.to })) };
  }
  if (sql.includes("SET status = 'expired'") ) { // by id
    return { rows: [] };
  }
  if (sql.includes('INSERT INTO org_ownership_transfers')) {
    if (T().some(pend)) throw mkErr('23505');
    const r = { id: `t${++S.seq}`, from: p[1], to: p[2], status: 'pending', expires: now() + p[3] * day, created: now() };
    T().push(r);
    return { rows: [{ id: r.id, expires_at: new Date(r.expires) }] };
  }
  if (sql.includes("SET status = 'cancelled'") && sql.includes('org_ownership_transfers')) {
    const r = T().find((t: any) => pend(t) && t.from === p[1]);
    if (!r) return { rows: [] }; r.status = 'cancelled'; return { rows: [{ id: r.id, to_user_id: r.to }] };
  }
  if (sql.includes("SET status = 'declined'")) {
    const r = T().find((t: any) => pend(t) && t.to === p[1]);
    if (!r) return { rows: [] }; r.status = 'declined'; return { rows: [{ id: r.id, from_user_id: r.from }] };
  }
  if (sql.includes("SET status = 'accepted'")) {
    const r = T().find((t: any) => t.id === p[0] && pend(t) && t.expires > now());
    if (!r) return { rows: [] }; r.status = 'accepted'; return { rows: [{ id: r.id }] };
  }
  if (sql.includes('FROM org_ownership_transfers') && sql.includes('ORDER BY created_at DESC')) {
    const r = T().filter(pend).slice(-1)[0];
    return { rows: r ? [{ id: r.id, from_user_id: r.from, to_user_id: r.to, status: r.status, expires_at: new Date(r.expires) }] : [] };
  }
  if (sql.startsWith('UPDATE organizations SET owner_id')) {
    if (S.failSwap) throw new Error('boom');
    if (S.owner !== p[1]) return { rows: [] }; S.owner = p[2]; return { rows: [{ id: p[0] }] };
  }
  if (sql.includes('FROM org_roles')) { const r = [...S.roles].sort((a: any, b: any) => b.level - a.level)[0]; return { rows: [{ id: r.id }] }; }
  if (sql.startsWith('UPDATE org_members SET role_id')) { if (S.members[p[1]]) S.members[p[1]].role = p[2]; return { rows: [] }; }
  if (sql.includes('INSERT INTO org_audit_log')) { S.audit.push({ action: p[2] }); return { rows: [] }; }
  if (sql.includes("SET status = 'cancelled'") && sql.includes("'transferred'")) { C().filter(pend).forEach((c: any) => { c.status = 'cancelled'; }); return { rows: [] }; }
  if (sql.includes('SELECT erased_at, created_at')) {
    const u = S.users[p[0]]; return { rows: u ? [{ erased_at: u.erased, created_at: u.created, last_seen: u.last }] : [] };
  }
  if (sql.includes('FROM org_members m') && sql.includes('ORDER BY COALESCE')) {
    const lvl = (id: string) => S.roles.find((r: any) => r.id === S.members[id].role)?.level ?? 0;
    const ids = Object.keys(S.members).filter((id) => id !== S.owner && !S.users[id].erased)
      .sort((a, b) => lvl(b) - lvl(a) || S.members[a].joined - S.members[b].joined);
    return { rows: ids[0] ? [{ user_id: ids[0] }] : [] };
  }
  if (sql.includes('INSERT INTO org_abandonment_claims')) {
    if (C().some(pend)) throw mkErr('23505');
    const r = { id: `c${++S.seq}`, claimant: p[1], orig: p[2], reason: p[3], status: 'pending', effective: now() + p[4] * day };
    C().push(r); return { rows: [{ id: r.id, effective_at: new Date(r.effective) }] };
  }
  if (sql.includes("resolved_reason = 'owner_returned'") && sql.includes('original_owner_id')) {
    const hit = C().filter((c: any) => pend(c) && c.orig === p[0]); hit.forEach((c: any) => { c.status = 'cancelled'; });
    return { rows: hit.map((c: any) => ({ org_id: 'org', claimant_id: c.claimant })) };
  }
  if (sql.includes('FROM org_abandonment_claims WHERE status')) {
    return { rows: C().filter(pend).map((c: any) => ({ id: c.id, org_id: 'org', claimant_id: c.claimant, original_owner_id: c.orig, effective_at: new Date(c.effective) })) };
  }
  if (sql.includes("SET status = 'cancelled', resolved_at = NOW(), resolved_reason = $2")) { C().find((c: any) => c.id === p[0]).status = 'cancelled'; return { rows: [] }; }
  if (sql.includes("SET status = 'completed'")) { const c = C().find((x: any) => x.id === p[0] && pend(x)); if (!c) return { rows: [] }; c.status = 'completed'; return { rows: [{ id: c.id }] }; }
  throw new Error('unhandled SQL: ' + sql.slice(0, 80));
}

vi.mock('../../src/config/db.js', () => ({
  pool: { query: (s: string, p?: any[]) => q(s, p), connect: async () => ({ query: (s: string, p?: any[]) => q(s, p), release() {} }) },
}));
vi.mock('../../src/config/nats.js', () => ({ publishEvent: async (s: string, d: any) => { S.events.push([s, d]); } }));
// L3 hook: the 2FA store is mocked; TF.enabled lists users with 2FA on, '246810' is their valid code.
const TF = { enabled: new Set<string>() };
vi.mock('../../src/utils/twoFactorStore.js', () => ({
  isEnabled: async (s: { id: string }) => TF.enabled.has(s.id),
  takeAccountAttempt: () => true,
  verifyFactor: async (_s: unknown, input: { code?: string }) => ({ ok: input.code === '246810' }),
}));

const m = await import('../../src/utils/ownershipTransfer.js');
let hash = '';
const PW = 'TestPass_1!';

beforeEach(async () => {
  hash = hash || await argon2.hash(PW);
  vi.useRealTimers();
  fresh(hash);
  TF.enabled.clear();
});
afterEach(() => vi.useRealTimers());

const reject = async (p: Promise<unknown>) => p.then(() => null, (e) => e);

describe('transfer', () => {
  it('only the owner initiates', async () => {
    const e = await reject(m.initiateTransfer('org', 'admin', 'mem', PW));
    expect(e.status).toBe(403);
  });
  it('requires the password and a member target', async () => {
    expect((await reject(m.initiateTransfer('org', 'owner', 'mem', 'wrong'))).code).toBe('REAUTH_FAILED');
    expect((await reject(m.initiateTransfer('org', 'owner', 'mem', undefined))).code).toBe('REAUTH_REQUIRED');
    expect((await reject(m.initiateTransfer('org', 'owner', 'stranger', PW))).status).toBe(400);
    expect(S.transfers).toHaveLength(0);
  });
  it('with 2FA on, the hand-off needs a valid code too (L3)', async () => {
    TF.enabled.add('owner');
    expect((await reject(m.initiateTransfer('org', 'owner', 'mem', PW))).code).toBe('SECOND_FACTOR_REQUIRED');
    expect((await reject(m.initiateTransfer('org', 'owner', 'mem', PW, '111111'))).code).toBe('SECOND_FACTOR_FAILED');
    expect(S.transfers).toHaveLength(0);
    await m.initiateTransfer('org', 'owner', 'mem', PW, '246810');
    expect(S.transfers).toHaveLength(1);
  });
  it('only the recipient accepts, and must re-authenticate', async () => {
    await m.initiateTransfer('org', 'owner', 'mem', PW);
    expect((await reject(m.acceptTransfer('org', 'admin', PW))).status).toBe(404);
    expect((await reject(m.acceptTransfer('org', 'owner', PW))).status).toBe(404);
    expect((await reject(m.acceptTransfer('org', 'mem', 'nope'))).code).toBe('REAUTH_FAILED');
    expect(S.owner).toBe('owner');
  });
  it('accept swaps ownership atomically; old owner keeps the top rank; both notified; audited', async () => {
    await m.initiateTransfer('org', 'owner', 'mem', PW);
    await m.acceptTransfer('org', 'mem', PW);
    expect(S.owner).toBe('mem');
    expect(S.members.owner.role).toBe('cmd');
    expect(S.audit.map((a: any) => a.action)).toContain('ownership.transferred');
    const subs = S.events.map((e: any) => e[0]);
    expect(subs).toContain('specter.event.user.owner');
    expect(subs).toContain('specter.event.user.mem');
  });
  it('a failure mid-swap rolls everything back', async () => {
    await m.initiateTransfer('org', 'owner', 'mem', PW);
    S.failSwap = true;
    await reject(m.acceptTransfer('org', 'mem', PW));
    expect(S.owner).toBe('owner');
    expect(S.transfers[0].status).toBe('pending');
  });
  it('expires after 7 days', async () => {
    await m.initiateTransfer('org', 'owner', 'mem', PW);
    vi.useFakeTimers(); vi.setSystemTime(now() + 8 * day);
    expect((await reject(m.acceptTransfer('org', 'mem', PW))).status).toBe(410);
    expect(S.owner).toBe('owner');
  });
  it('the owner cancels; then accept fails; decline works for the recipient', async () => {
    await m.initiateTransfer('org', 'owner', 'mem', PW);
    expect((await reject(m.cancelTransfer('org', 'mem'))).status).toBe(404);
    await m.cancelTransfer('org', 'owner');
    expect((await reject(m.acceptTransfer('org', 'mem', PW))).status).toBe(404);
    await m.initiateTransfer('org', 'owner', 'mem', PW);
    await m.declineTransfer('org', 'mem');
    expect(S.owner).toBe('owner');
  });
  it('only one pending transfer at a time', async () => {
    await m.initiateTransfer('org', 'owner', 'mem', PW);
    expect((await reject(m.initiateTransfer('org', 'owner', 'admin', PW))).code).toBe('TRANSFER_PENDING');
  });
  it('sweep expires stale transfers', async () => {
    await m.initiateTransfer('org', 'owner', 'mem', PW);
    vi.useFakeTimers(); vi.setSystemTime(now() + 8 * day);
    expect((await m.sweepOwnership()).expired).toBe(1);
  });
});

describe('abandonment', () => {
  it('pure helpers', () => {
    expect(m.isInactive(null)).toBe(true);
    expect(m.isInactive(new Date(Date.now() - 100 * day))).toBe(false);
    expect(m.isInactive(new Date(Date.now() - 400 * day))).toBe(true);
    expect(m.transferIsLive({ status: 'pending', expires_at: new Date(Date.now() + 1000) })).toBe(true);
    expect(m.transferIsLive({ status: 'cancelled', expires_at: new Date(Date.now() + 1000) })).toBe(false);
  });
  it('refuses while the owner is active, and for anyone but the top admin', async () => {
    expect((await reject(m.startClaim('org', 'admin', PW))).code).toBe('OWNER_ACTIVE');
    S.users.owner.last = new Date(now() - 400 * day);
    expect((await reject(m.startClaim('org', 'mem', PW))).code).toBe('NOT_TOP_ADMIN');
    expect((await reject(m.startClaim('org', 'admin', 'bad'))).code).toBe('REAUTH_FAILED');
  });
  it('claim posts a 30-day notice; sweep transfers ownership only after it', async () => {
    S.users.owner.erased = new Date();
    const c = await m.startClaim('org', 'admin', PW);
    expect(c.reason).toBe('owner_deleted');
    expect((await m.sweepOwnership()).completed).toBe(0);
    expect(S.owner).toBe('owner');
    vi.useFakeTimers(); vi.setSystemTime(now() + 31 * day);
    expect((await m.sweepOwnership()).completed).toBe(1);
    expect(S.owner).toBe('admin');
    expect(S.audit.map((a: any) => a.action)).toContain('ownership.claimed');
  });
  it('inactive owner: claim works; the owner returning cancels it', async () => {
    S.users.owner.last = new Date(now() - 400 * day);
    const c = await m.startClaim('org', 'admin', PW);
    expect(c.reason).toBe('owner_inactive');
    expect((await reject(m.startClaim('org', 'admin', PW))).code).toBe('CLAIM_PENDING');
    expect(await m.cancelClaimsForReturningOwner('owner')).toBe(1);
    vi.useFakeTimers(); vi.setSystemTime(now() + 31 * day);
    S.users.owner.last = new Date(now());
    expect((await m.sweepOwnership()).completed).toBe(0);
    expect(S.owner).toBe('owner');
  });
  it('sweep cancels a claim whose owner became active again', async () => {
    S.users.owner.last = new Date(now() - 400 * day);
    await m.startClaim('org', 'admin', PW);
    S.users.owner.last = new Date(now());
    expect((await m.sweepOwnership()).cancelled).toBe(1);
  });
});
