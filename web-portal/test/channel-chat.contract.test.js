// Client contract test, part 2: useChannelChat's SSE handlers (the relay /
// sync_request / sync_response refs WarRoom's useEventStream forwards to) fed
// schema-valid envelopes from shared/events/schema.js. The assertions are on
// behaviour — a relayed message gets decrypted and stored, a sync request
// gets answered, a backfill gets stored — not on internal call order, so
// they keep holding while MR2 reworks the delivery path.
//
// deliver*() first checks the envelope against the schema, then that the
// handler acted on it; a wrong-shape event fails either check (see the last
// describe block, which proves both fire on the 2.0.0 nested shape).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sampleEvent, validateEvent } from '../../shared/events/schema.js';

const ORG = 'org-1';
const CHAN = 'chan-1';
const ME = 'user-me';
const PEER = 'user-peer';

const h = vi.hoisted(() => ({ storedRows: [] }));

vi.mock('react', () => import('./helpers/reactShim.js'));
vi.mock('../src/api.js', async () => {
  const { permissive } = await import('./helpers/permissiveModule.js');
  return {
    api: permissive({}, (name) => (name === 'sendMessage'
      ? { data: { id: 'sent-1', timestamp: '2026-10-25T12:00:00.000Z' }, error: null }
      : { data: {}, error: null })),
  };
});
vi.mock('../src/messageStore.js', async () => {
  const { permissive } = await import('./helpers/permissiveModule.js');
  return permissive({}, (name) => {
    if (name === 'getChannelMessagesSince') return h.storedRows;
    if (/^get.*Messages/.test(name)) return [];
    if (/^get/.test(name)) return null;
    return undefined;
  });
});
vi.mock('../src/mlsSession.js', async () => {
  const { permissive } = await import('./helpers/permissiveModule.js');
  class MlsDecryptError extends Error { constructor(reason) { super(reason); this.reason = reason; } }
  return permissive({ MlsDecryptError, onGroupStateChange: vi.fn(() => () => {}) }, (name) => {
    if (/^decrypt/.test(name)) return 'hello';
    if (/^encrypt/.test(name)) return 'Y2lwaGVy';
    return undefined;
  });
});

const { renderHook, resetShim } = await import('./helpers/reactShim.js');
const chat = await import('../src/engine/useChannelChat.js');
const { api } = await import('../src/api.js');
const store = await import('../src/messageStore.js');
const mls = await import('../src/mlsSession.js');

const SAVE_FNS = ['saveChannelMessage', 'saveChannelMessages'];
const savedRecords = () => SAVE_FNS.flatMap((n) => store[n].mock.calls.flatMap((args) => (
  args.flatMap((a) => (Array.isArray(a) ? a : (a && typeof a === 'object' ? [a] : [])))
)));
const decryptCalls = () => ['decryptChannel', 'decryptChannelOrRecallOwn'].flatMap((n) => mls[n].mock.calls);

beforeEach(() => {
  vi.clearAllMocks();
  h.storedRows = [];
  renderHook(chat.default, { orgId: ORG, channel: { id: CHAN }, user: { id: ME, callsign: 'me' } });
});
afterEach(() => resetShim());

function assertContract(env) {
  expect(validateEvent(env), 'envelope breaks shared/events/schema.js').toEqual([]);
}

async function deliverRelay(env) {
  assertContract(env);
  chat.channelChatRelayRef.current(env);
  await vi.waitFor(() => {
    expect(decryptCalls().some((args) => args.includes(env.encrypted_content)), 'relay was never decrypted').toBe(true);
    expect(savedRecords().some((r) => r.id === env.id && r.channel_id === CHAN), 'relay was never stored').toBe(true);
  }, { timeout: 1000 });
}

describe('useChannelChat handles schema-valid envelopes', () => {
  it('registers its relay / sync handlers for the open channel', () => {
    expect(typeof chat.channelChatRelayRef.current).toBe('function');
    expect(typeof chat.channelChatSyncRequestRef.current).toBe('function');
    expect(typeof chat.channelChatSyncResponseRef.current).toBe('function');
  });

  it('message_relay from a peer is decrypted and stored', async () => {
    await deliverRelay(sampleEvent('message_relay', {
      id: 'm-1', channel_id: CHAN, org_id: ORG, sender_id: PEER, encrypted_content: 'Y3Q=',
    }));
    const rec = savedRecords().find((r) => r.id === 'm-1');
    expect(rec).toMatchObject({ channel_id: CHAN, sender_id: PEER, plaintext: 'hello' });
  });

  it('sync_request from a peer is answered to that peer', async () => {
    h.storedRows = [{
      id: 'old-1', channel_id: CHAN, sender_id: ME, callsign: 'me', global_tag: null,
      encrypted_content: 'b2xk', plaintext: 'old', image_url: null, timestamp: '2026-10-25T11:00:00.000Z',
    }];
    const env = sampleEvent('sync_request', { channel_id: CHAN, org_id: ORG, requester_id: PEER, since: null });
    assertContract(env);
    chat.channelChatSyncRequestRef.current(env);
    // MR2 adds a 0–1.5 s response jitter.
    await vi.waitFor(() => {
      const answered = ['respondChannelSync', 'respondOrgSync']
        .flatMap((n) => api[n].mock.calls)
        .some((args) => args.includes(PEER));
      expect(answered, 'sync_request was never answered').toBe(true);
    }, { timeout: 2500 });
  });

  it('sync_request from ourselves is ignored', async () => {
    const env = sampleEvent('sync_request', { channel_id: CHAN, org_id: ORG, requester_id: ME, since: null });
    chat.channelChatSyncRequestRef.current(env);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getChannelMessagesSince).not.toHaveBeenCalled();
  });

  it('sync_response backfill (legacy per-message shape) is decrypted and stored', async () => {
    const env = sampleEvent('sync_response', {
      channel_id: CHAN,
      messages: [{ id: 'b-1', sender_id: PEER, encrypted_content: 'YmFjaw==', timestamp: '2026-10-25T10:00:00.000Z' }],
    }, 1);
    assertContract(env);
    chat.channelChatSyncResponseRef.current(env);
    await vi.waitFor(() => {
      expect(savedRecords().some((r) => r.id === 'b-1' && r.plaintext === 'hello')).toBe(true);
    }, { timeout: 1000 });
  });
});

describe('a wrong-shape event fails the contract', () => {
  // The 2.0.0 server shape: everything under `payload`, nothing top-level.
  const flat = () => sampleEvent('message_relay', {
    id: 'm-legacy', channel_id: CHAN, org_id: ORG, sender_id: PEER, encrypted_content: 'bGVn',
  });
  const legacy = () => {
    const f = flat();
    return { subject: f.subject, type: 'message_relay', payload: { ...f.payload, id: 'm-legacy', channel_id: CHAN, encrypted_content: 'bGVn' } };
  };

  it('deliverRelay rejects it', async () => {
    await expect(deliverRelay(legacy())).rejects.toThrow(/schema/);
  });

  it('…and the handler itself drops it (so the behavioural check fails too)', async () => {
    chat.channelChatRelayRef.current(legacy());
    await new Promise((r) => setTimeout(r, 50));
    expect(savedRecords()).toEqual([]);
    expect(decryptCalls()).toEqual([]);
  });
});
