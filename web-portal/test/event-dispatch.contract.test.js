// Client contract test, part 1: useEventStream's dispatch and the handler
// maps registered with it, checked against shared/events/schema.js.
//  - Every schema event, sent as a schema-valid SSE frame through a fake
//    EventSource, reaches the handler for its `type` with every field at the
//    top level (the 2.0.0 incident was fields arriving nested).
//  - Every handler key in the app's useEventStream({...}) maps names a schema
//    event, and every schema `handledBy` claim is real.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SSE_EVENTS, sampleEvent, validateEvent } from '../../shared/events/schema.js';

vi.mock('react', () => import('./helpers/reactShim.js'));
vi.mock('../src/apiBase.js', () => ({ API_BASE_URL: 'http://contract.test' }));
vi.mock('../src/auth/tokenStore.js', () => ({
  getToken: vi.fn(async () => 'access-token'),
  refreshAfterUnauthorized: vi.fn(async () => null),
}));

const { renderHook, resetShim } = await import('./helpers/reactShim.js');
const { default: useEventStream } = await import('../src/useEventStream.js');

class FakeEventSource {
  static instances = [];
  constructor(url) { this.url = url; FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ticket: 'sse-ticket' }) })));
});
afterEach(() => { resetShim(); vi.unstubAllGlobals(); });

async function openStream(handlers) {
  renderHook(() => useEventStream(handlers));
  await vi.waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
  return FakeEventSource.instances[0];
}

describe('useEventStream dispatch', () => {
  const variants = Object.entries(SSE_EVENTS).flatMap(([type, def]) => def.shapes.map((_, i) => [type, i]));

  it.each(variants)('%s (shape %i): schema-valid frame reaches its handler flat', async (type, i) => {
    const handlers = { [type]: vi.fn() };
    const es = await openStream(handlers);
    const frame = sampleEvent(type, {}, i);
    expect(validateEvent(frame)).toEqual([]);
    es.emit(frame);
    expect(handlers[type]).toHaveBeenCalledTimes(1);
    const got = handlers[type].mock.calls[0][0];
    // What the handler receives must itself satisfy the contract.
    expect(validateEvent(got)).toEqual([]);
  });

  it('routes only to the matching type', async () => {
    const handlers = { message_relay: vi.fn(), sync_request: vi.fn() };
    const es = await openStream(handlers);
    es.emit(sampleEvent('sync_request'));
    expect(handlers.sync_request).toHaveBeenCalledTimes(1);
    expect(handlers.message_relay).not.toHaveBeenCalled();
  });

  it('a nested-only (2.0.0) frame is not schema-valid and its fields are not top-level', async () => {
    const handlers = { message_relay: vi.fn() };
    const es = await openStream(handlers);
    const flat = sampleEvent('message_relay');
    const legacy = { subject: flat.subject, type: 'message_relay', payload: flat.payload };
    expect(validateEvent(legacy).length).toBeGreaterThan(0);
    es.emit(legacy);
    expect(handlers.message_relay.mock.calls[0][0].channel_id).toBeUndefined();
  });
});

// ── Static: the app's handler maps vs the schema ─────────────────────────────
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** Keys of the first object literal passed to each useEventStream( call. */
function handlerKeys(text) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('useEventStream({', from);
    if (at === -1) break;
    let i = at + 'useEventStream('.length; let depth = 0; let top = '';
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; if (depth === 1) top += '\n'; continue; }
      if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; continue; }
      if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; } continue; }
      if (c === '{') { depth++; if (depth === 1) top += '\n'; continue; }
      if (c === '}') { depth--; if (depth === 0) break; continue; }
      if (depth === 1) top += c;
    }
    out.push([...top.matchAll(/\n[ \t]*([A-Za-z_$][\w$]*)[ \t]*:/g)].map((m) => m[1]));
    from = i;
  }
  return out.flat();
}

const CONSUMERS = {
  'WarRoom.jsx': 'components/WarRoom.jsx',
  'OperationPlanner.jsx': 'components/OperationPlanner.jsx',
  'useStripOps.js': 'components/strip/useStripOps.js',
};

describe('handler maps vs schema', () => {
  const keysByFile = Object.fromEntries(Object.entries(CONSUMERS).map(([name, rel]) => (
    [name, handlerKeys(fs.readFileSync(path.join(SRC, rel), 'utf8'))]
  )));

  it('finds the handler maps (scanner sanity)', () => {
    expect(keysByFile['WarRoom.jsx']).toContain('message_relay');
    expect(keysByFile['WarRoom.jsx']).toContain('mls_commit');
    expect(keysByFile['OperationPlanner.jsx']).toContain('planner_presence');
  });

  it.each(Object.keys(CONSUMERS))('%s only listens for events the schema defines', (file) => {
    const unknown = keysByFile[file].filter((k) => !(k in SSE_EVENTS));
    expect(unknown, `handler keys with no shared/events/schema.js entry in ${file}`).toEqual([]);
  });

  it('every handledBy claim in the schema is a real handler', () => {
    const missing = Object.entries(SSE_EVENTS).flatMap(([type, def]) => (
      def.handledBy.filter((f) => !keysByFile[f]?.includes(type)).map((f) => `${type} → ${f}`)
    ));
    expect(missing).toEqual([]);
  });
});
