/**
 * Contract test: every publishEvent(...) call site in identity-node/src is
 * checked statically against shared/events/schema.js — a new event type, a
 * new subject, or a renamed / nested field fails here. See publishScanner.ts.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTree, scanSource, type CallSite } from './publishScanner.js';
import { SSE_EVENTS, KNOWN_VIOLATIONS } from '../../../../shared/events/schema.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
const sites = scanTree(SRC);
const fmt = (s: CallSite) => `  ${s.file}:${s.line} [${s.subject}] ${s.types.join('|')}\n    - ${s.errors.join('\n    - ')}`;
const isKnown = (s: CallSite) => s.types.length > 0 && s.types.every((t) => t in KNOWN_VIOLATIONS);

// Schema entries nothing in this tree publishes yet (sseController emits
// `connected` itself; the rest land with other work packages).
const NOT_PUBLISHED_HERE = new Set(['connected', 'org_sync_request' /* added by MR2 */]);

describe('publishEvent call sites vs shared/events/schema.js', () => {
  it('finds the call sites (scanner sanity)', () => {
    expect(sites.length).toBeGreaterThan(50);
    const files = new Set(sites.map((s) => s.file));
    for (const f of ['controllers/messageController.ts', 'controllers/mlsGroupController.ts', 'controllers/dmController.ts']) {
      expect(files, `no publishEvent found in ${f}`).toContain(f);
    }
  });

  it('every publish is on a known subject with a schema-valid shape', () => {
    const bad = sites.filter((s) => s.errors.length && !isKnown(s));
    expect(bad.map(fmt).join('\n'), 'publishes that break the event contract').toBe('');
  });

  it('known violations are still violations (remove them from KNOWN_VIOLATIONS once fixed)', () => {
    for (const type of Object.keys(KNOWN_VIOLATIONS)) {
      const of = sites.filter((s) => s.types.includes(type));
      expect(of.length, `${type} is no longer published at all`).toBeGreaterThan(0);
      expect(of.some((s) => s.errors.length), `${type} now matches the schema — delete it from KNOWN_VIOLATIONS`).toBe(true);
    }
  });

  it('every schema event type is actually published (no stale entries)', () => {
    const published = new Set(sites.flatMap((s) => s.types));
    const stale = Object.keys(SSE_EVENTS).filter((t) => !published.has(t) && !NOT_PUBLISHED_HERE.has(t));
    expect(stale).toEqual([]);
  });
});

describe('scanner catches the 2.0.0 nested-payload regression', () => {
  // Verbatim shape of the pre-9ef7ea3 messageController publish.
  const legacy = `
    export const sendMessage = async () => {
      const relayPayload = { id: 'x', channel_id: chanId, org_id: orgId, sender_id: userId,
        callsign: null, global_tag: null, encrypted_content, image_url: null, timestamp };
      await publishEvent(\`specter.msg.channel.\${chanId}\`, { type: 'message_relay', payload: relayPayload });
    };
    export const requestChannelSync = async () => {
      await publishEvent(\`specter.msg.channel.\${chanId}\`, {
        type: 'sync_request', payload: { channel_id: chanId, org_id: orgId, requester_id: userId, since },
      });
    };`;

  it('flags nested-only message_relay / sync_request', () => {
    const [relay, sync] = scanSource('legacy.ts', legacy);
    expect(relay.errors.join('\n')).toMatch(/message_relay: channel_id: missing/);
    expect(sync.errors.join('\n')).toMatch(/sync_request: requester_id: missing/);
  });

  it('accepts the current flat + nested-copy shape', () => {
    const fixed = legacy
      .replace("{ type: 'message_relay', payload", "{ type: 'message_relay', ...relayPayload, payload")
      .replace(`type: 'sync_request', payload: { channel_id: chanId, org_id: orgId, requester_id: userId, since },`,
        `type: 'sync_request', channel_id: chanId, org_id: orgId, requester_id: userId, since,
         payload: { channel_id: chanId, org_id: orgId, requester_id: userId, since },`);
    const res = scanSource('fixed.ts', fixed);
    expect(res.map((s) => s.errors).flat()).toEqual([]);
  });

  it('flags an unknown event type and an unrouted subject', () => {
    const src = `
      publishEvent(\`specter.event.org.\${o}\`, { type: 'brand_new_event', foo: 1 });
      publishEvent('specter.something.else', { type: 'orgs_changed' });
      publishEvent(subjectVar, { type: 'orgs_changed' });`;
    const [unknown, unrouted, dynamic] = scanSource('new.ts', src);
    expect(unknown.errors[0]).toMatch(/brand_new_event: no entry/);
    expect(unrouted.errors[0]).toMatch(/neither an SSE subject nor in INTERNAL_SUBJECTS/);
    expect(dynamic.errors[0]).toMatch(/subject must be a string or template literal/);
  });
});
