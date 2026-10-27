// Self-test of the contract machinery (validator, subject matching, samples).
import { describe, it, expect } from 'vitest';
import {
  SSE_EVENTS, subjectMatches, validateEvent, sampleEvent, isSseSubject, isInternalSubject,
} from './schema.js';

describe('subjectMatches (NATS semantics)', () => {
  it.each([
    ['specter.event.org.*', 'specter.event.org.abc', true],
    ['specter.event.org.*', 'specter.event.org.abc.def', false],
    ['specter.event.org.*', 'specter.event.org', false],
    ['specter.cmd.>', 'specter.cmd.move.u.c', true],
    ['specter.cmd.>', 'specter.cmd', false],
    ['UserPresenceUpdated', 'UserPresenceUpdated', true],
  ])('%s vs %s → %s', (p, s, want) => expect(subjectMatches(p, s)).toBe(want));

  it('SSE and internal subjects never overlap', () => {
    for (const s of ['specter.event.tree.x', 'specter.msg.dm.a-b', 'specter.cmd.kick.u']) {
      expect(isInternalSubject(s) && !isSseSubject(s)).toBe(true);
    }
  });
});

describe('validateEvent', () => {
  const ok = sampleEvent('operation_ended', { target_channel_id: null, target_channel_name: null });

  it('accepts explicit null for |null fields but not a missing key', () => {
    expect(validateEvent(ok)).toEqual([]);
    const { target_channel_id, ...missing } = ok;
    expect(validateEvent(missing).join()).toMatch(/target_channel_id: missing/);
  });

  it('checks types, literals, nested objects and array elements', () => {
    expect(validateEvent({ ...ok, eventId: 5 }).join()).toMatch(/eventId: expected string, got number/);
    const dm = sampleEvent('message_relay', {}, 1);
    expect(validateEvent({ ...dm, context: 'channel' }).join()).toMatch(/context: expected "dm"/);
    expect(validateEvent({ ...dm, message: { id: 'x' } }).join()).toMatch(/message\.conversation_id: missing/);
    const sr = sampleEvent('sync_response', {}, 1); // legacy per-message shape
    const { sender_id, ...noSender } = sr.messages[0];
    expect(validateEvent({ ...sr, messages: [noSender] }).join()).toMatch(/messages\[0\]\.sender_id: missing/);
  });

  it('rejects unknown types and wrong subjects', () => {
    expect(validateEvent({ type: 'nope' }).join()).toMatch(/unknown event type/);
    expect(validateEvent({ ...sampleEvent('sync_request'), subject: 'specter.event.user.u' }).join())
      .toMatch(/not expected on subject/);
  });

  it('every sample of every shape is valid (sanity of the schema itself)', () => {
    for (const [type, def] of Object.entries(SSE_EVENTS)) {
      def.shapes.forEach((_, i) => expect(validateEvent(sampleEvent(type, {}, i)), `${type}#${i}`).toEqual([]));
    }
  });
});
