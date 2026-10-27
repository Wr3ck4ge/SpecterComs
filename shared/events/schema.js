// SSE event contracts — the single source of truth for the shape of every
// event identity-node publishes onto a NATS subject that sseController.ts
// forwards to clients.
//
// Why this exists: in 2.0.0 the server published channel message_relay /
// sync_request / sync_response with their fields nested under `payload`
// while every client handler read them at the top level, so every message
// from another user was silently dropped (fixed in 9ef7ea3). Nothing failed
// — the handlers just saw `payload.channel_id === undefined` and returned.
// The contract tests (services/identity-node/src/test/event-contracts.test.ts
// and web-portal/test/event-contracts.test.js) check both sides against this
// file, so that class of mismatch now fails CI instead of production.
//
// Envelope as the client sees it (sseController.ts's `forward`):
//   { subject: <NATS subject>, ...<published object> }
// useEventStream.js dispatches on `type` and hands handlers the whole
// envelope, so every field a handler reads MUST be at the top level. A nested
// copy (`payload`) is only kept where something else reads it — today that's
// background_sync.rs, for channel message_relay and sync_request.
//
// Field specs:
//   'string' | 'number' | 'boolean' | 'array' | 'object' | 'any'
//   '<type>|null'          — that type, or null (the key must still be present)
//   'literal:<value>'      — exactly that string
//   { ...fields }          — a nested object with these required fields
//   { $array: spec }       — an array whose every element matches spec
// `required` keys must be present (and match); `optional` keys may be absent
// but must match when present. Extra keys are allowed.
//
// Adding an event: add it here first (with every subject it's published on),
// then publish it with a literal `type` and an object literal (spreads of a
// locally declared object literal are fine) so the static server test can
// read it. Plain JS on purpose: importable by Vite, Node and the TS server
// tests alike (see schema.d.ts).

/** NATS subjects sseController.ts forwards to clients ('*' = one token). */
export const SSE_SUBJECTS = [
  'specter.event.user.*',
  'specter.event.org.*',
  'specter.msg.channel.*',
];

/**
 * Subjects identity-node publishes that never reach a client over SSE
 * (media-rust commands, audit, JetStream DM buffer, relay hierarchy).
 * NATS wildcards: '*' = one token, '>' = one or more trailing tokens.
 */
export const INTERNAL_SUBJECTS = [
  'specter.cmd.>',             // media-rust moderation / drain commands
  'specter.user.login',
  'specter.moderation.ban',
  'specter.event.tree.*',      // media-rust channel hierarchy (not subscribed by SSE)
  'specter.msg.dm.*',          // JetStream offline DM buffer (raw relay payload, no `type`)
  'UserPresenceUpdated',
];

const CHANNEL = 'specter.msg.channel.*';
const USER = 'specter.event.user.*';
const ORG = 'specter.event.org.*';

// Fields every channel message carries — the live relay and backfill rows.
const CHANNEL_MESSAGE = {
  id: 'string',
  channel_id: 'string',
  org_id: 'string',
  sender_id: 'string',
  callsign: 'string|null',
  global_tag: 'string|null',
  encrypted_content: 'string',
  image_url: 'string|null',
  timestamp: 'string',
};

const SYNC_REQUEST = {
  channel_id: 'string',
  org_id: 'string',
  requester_id: 'string',
  since: 'string|null',
};

/**
 * type → { shapes: [{ subject, required, optional? }], handledBy, note? }
 * An event matches when ANY shape whose subject pattern matches its subject
 * validates. handledBy lists the client files whose useEventStream handler
 * map has this key (empty = published but nothing on the client listens).
 */
export const SSE_EVENTS = {
  // Emitted by sseController.ts itself on every (re)connect, not via NATS.
  connected: {
    shapes: [{ subject: 'sse', required: { orgIds: 'array' } }],
    handledBy: ['WarRoom.jsx', 'useStripOps.js'],
  },

  // ── Org list / org membership ──────────────────────────────────────────
  orgs_changed: {
    shapes: [{ subject: USER, required: {} }, { subject: ORG, required: {} }],
    handledBy: ['WarRoom.jsx'],
  },
  org_created: {
    shapes: [{ subject: USER, required: { org: { id: 'string', callsign: 'string' } } }],
    handledBy: ['WarRoom.jsx'],
  },
  member_joined: {
    shapes: [{ subject: ORG, required: { userId: 'string', orgId: 'string' } }],
    handledBy: ['WarRoom.jsx'],
  },
  member_removed: {
    shapes: [{ subject: ORG, required: { userId: 'string', reason: 'string' } }],
    handledBy: ['WarRoom.jsx'],
  },
  member_updated: {
    shapes: [{ subject: ORG, required: { userId: 'string' } }],
    handledBy: ['WarRoom.jsx'],
  },
  role_created: {
    shapes: [{ subject: ORG, required: { role: 'object' } }],
    handledBy: ['WarRoom.jsx'],
  },
  role_updated: {
    shapes: [{ subject: ORG, required: { role: 'object' } }],
    handledBy: ['WarRoom.jsx'],
  },
  role_deleted: {
    shapes: [{ subject: ORG, required: { roleId: 'string' } }],
    handledBy: ['WarRoom.jsx'],
  },

  // ── Channels / presence ────────────────────────────────────────────────
  // eventsController publishes both without a body (handlers just refetch).
  channel_created: {
    shapes: [{ subject: ORG, required: {}, optional: { channel: 'object' } }],
    handledBy: ['WarRoom.jsx'],
  },
  channel_deleted: {
    shapes: [{ subject: ORG, required: {}, optional: { channelId: 'string' } }],
    handledBy: ['WarRoom.jsx'],
  },
  channel_presence_changed: {
    shapes: [{ subject: ORG, required: { channelId: 'string', occupants: 'array' } }],
    handledBy: ['WarRoom.jsx'],
  },
  presence_changed: {
    shapes: [{ subject: ORG, required: { channelId: 'string' } }],
    handledBy: [],
  },
  channel_kicked: {
    shapes: [{ subject: USER, required: { channelId: 'string' } }],
    handledBy: [],
  },

  // ── Operations / events ────────────────────────────────────────────────
  planner_presence: {
    shapes: [{ subject: ORG, required: { event_id: 'string', editors: 'array' } }],
    handledBy: ['OperationPlanner.jsx', 'useStripOps.js'],
  },
  event_launched: {
    shapes: [{ subject: ORG, required: { eventId: 'string' } }],
    handledBy: ['WarRoom.jsx', 'useStripOps.js'],
  },
  event_roster_changed: {
    shapes: [{ subject: ORG, required: { event_id: 'string' } }],
    handledBy: ['WarRoom.jsx', 'OperationPlanner.jsx', 'useStripOps.js'],
  },
  operation_ended: {
    shapes: [{
      subject: ORG,
      required: {
        eventId: 'string',
        mode: 'string',
        target_channel_id: 'string|null',
        target_channel_name: 'string|null',
      },
    }],
    handledBy: ['WarRoom.jsx', 'useStripOps.js'],
  },

  // ── Messaging ──────────────────────────────────────────────────────────
  dm_received: {
    shapes: [{ subject: USER, required: { from_user_id: 'string', from_callsign: 'string' } }],
    handledBy: ['WarRoom.jsx'],
  },
  message_relay: {
    shapes: [
      // Channel: flat for the client (useChannelChat / unread / CommLink) AND
      // nested under `payload` for background_sync.rs's decrypt_and_cache.
      { subject: CHANNEL, required: { ...CHANNEL_MESSAGE, payload: { ...CHANNEL_MESSAGE } } },
      // DM: DmCabinet reads context/partner_id and the message object.
      {
        subject: USER,
        required: {
          context: 'literal:dm',
          partner_id: 'string',
          message: {
            id: 'string',
            conversation_id: 'string',
            sender_id: 'string',
            encrypted_content: 'string',
            timestamp: 'string',
          },
        },
      },
    ],
    handledBy: ['WarRoom.jsx'],
  },
  sync_request: {
    shapes: [{
      subject: CHANNEL,
      // Flat for useChannelChat, nested for background_sync.rs's answer_sync_request.
      required: { ...SYNC_REQUEST, payload: { ...SYNC_REQUEST } },
    }],
    handledBy: ['WarRoom.jsx'],
  },
  sync_response: {
    shapes: [
      // 2.0.1+: one MLS-encrypted bundle re-encrypted under the current epoch
      // (POST /orgs/:orgId/messages/sync-response).
      {
        subject: USER,
        required: { org_id: 'string', channel_id: 'string', relayed_by: 'string', bundle: 'string' },
        optional: { count: 'number|null' },
      },
      // Legacy per-channel answer (2.0.0 clients' requests): stored ciphertext.
      {
        subject: USER,
        required: {
          channel_id: 'string',
          messages: {
            $array: {
              id: 'string',
              sender_id: 'string',
              encrypted_content: 'string',
              timestamp: 'string',
            },
          },
        },
        optional: { org_id: 'string', relayed_by: 'string' },
      },
    ],
    handledBy: ['WarRoom.jsx'],
  },
  // Startup / reconnect catch-up for every channel of an org, fanned out on
  // the org subject (POST /orgs/:orgId/messages/sync-request).
  org_sync_request: {
    shapes: [{
      subject: ORG,
      required: {
        org_id: 'string',
        requester_id: 'string',
        channels: { $array: { channel_id: 'string', since: 'string|null' } },
      },
    }],
    handledBy: ['WarRoom.jsx'],
  },
  // DM peer backfill (flat since 2.0.1; it never worked while nested).
  dm_sync_request: {
    shapes: [{
      subject: USER,
      required: { conversation_id: 'string', requester_id: 'string', since: 'string|null' },
    }],
    handledBy: ['WarRoom.jsx'],
  },
  dm_sync_response: {
    shapes: [{
      subject: USER,
      required: { conversation_id: 'string', relayed_by: 'string', bundle: 'string' },
      optional: { count: 'number|null' },
    }],
    handledBy: ['WarRoom.jsx'],
  },

  // ── MLS group management ───────────────────────────────────────────────
  mls_commit: {
    shapes: [
      { subject: USER, required: { conversation_id: 'string', commit: 'string' } },
      { subject: USER, required: { event_group_id: 'string', commit: 'string' } },
      { subject: CHANNEL, required: { channel_id: 'string', commit: 'string' } },
    ],
    handledBy: ['WarRoom.jsx'],
  },
  mls_welcome: {
    shapes: [
      { subject: USER, required: { conversation_id: 'string', welcome: 'string' } },
      { subject: USER, required: { event_group_id: 'string', welcome: 'string' } },
      { subject: USER, required: { channel_id: 'string', welcome: 'string' } },
    ],
    handledBy: ['WarRoom.jsx'],
  },
};

/**
 * Event types whose server publish currently breaks the contract. The server
 * test expects each of these to STILL fail (so fixing one forces removing it
 * here) and every other publish to pass. Never add to this list to make CI
 * green — fix the publisher.
 */
export const KNOWN_VIOLATIONS = {};

// ── Validation ──────────────────────────────────────────────────────────────

/** NATS-style subject match: '*' = one token, '>' = one or more trailing tokens. */
export function subjectMatches(pattern, subject) {
  if (pattern === subject) return true;
  const p = pattern.split('.');
  const s = String(subject ?? '').split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

export const isSseSubject = (subject) => SSE_SUBJECTS.some((p) => subjectMatches(p, subject));
export const isInternalSubject = (subject) => INTERNAL_SUBJECTS.some((p) => subjectMatches(p, subject));

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function checkValue(spec, value, path, errors) {
  if (typeof spec === 'string') {
    if (spec.startsWith('literal:')) {
      const want = spec.slice('literal:'.length);
      if (value !== want) errors.push(`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(value)}`);
      return;
    }
    if (spec === 'any') return;
    const allowed = spec.split('|');
    const actual = typeOf(value);
    if (!allowed.includes(actual)) errors.push(`${path}: expected ${spec}, got ${actual}`);
    return;
  }
  if (spec && typeof spec === 'object' && '$array' in spec) {
    if (!Array.isArray(value)) { errors.push(`${path}: expected array, got ${typeOf(value)}`); return; }
    value.forEach((el, i) => checkValue(spec.$array, el, `${path}[${i}]`, errors));
    return;
  }
  // Nested object spec.
  if (typeOf(value) !== 'object') { errors.push(`${path}: expected object, got ${typeOf(value)}`); return; }
  checkFields(spec, {}, value, `${path}.`, errors);
}

function checkFields(required, optional, obj, prefix, errors) {
  for (const [key, spec] of Object.entries(required)) {
    if (!(key in obj) || obj[key] === undefined) { errors.push(`${prefix}${key}: missing`); continue; }
    checkValue(spec, obj[key], `${prefix}${key}`, errors);
  }
  for (const [key, spec] of Object.entries(optional || {})) {
    if (key in obj && obj[key] !== undefined) checkValue(spec, obj[key], `${prefix}${key}`, errors);
  }
}

/**
 * Validates one event as published or as received over SSE.
 *   validateEvent({ subject, type, ...fields })  (SSE envelope), or
 *   validateEvent(publishedObject, subject)       (server side)
 * → [] when valid, otherwise human-readable errors (from the closest shape).
 */
export function validateEvent(event, subject = event?.subject) {
  if (!event || typeof event !== 'object') return ['event is not an object'];
  const def = SSE_EVENTS[event.type];
  if (!def) return [`unknown event type ${JSON.stringify(event.type)} — add it to shared/events/schema.js`];
  const candidates = def.shapes.filter((s) => subject == null || subjectMatches(s.subject, subject));
  if (candidates.length === 0) {
    return [`${event.type}: not expected on subject ${subject} (allowed: ${def.shapes.map((s) => s.subject).join(', ')})`];
  }
  let best = null;
  for (const shape of candidates) {
    const errors = [];
    checkFields(shape.required, shape.optional, event, '', errors);
    if (errors.length === 0) return [];
    if (!best || errors.length < best.length) best = errors;
  }
  return best.map((e) => `${event.type}: ${e}`);
}

// ── Samples (for client tests) ─────────────────────────────────────────────

function sampleValue(spec, key) {
  if (typeof spec === 'string') {
    if (spec.startsWith('literal:')) return spec.slice('literal:'.length);
    const t = spec.split('|')[0];
    if (t === 'string') return key === 'timestamp' ? '2026-10-25T12:00:00.000Z' : `sample-${key}`;
    if (t === 'number') return 1;
    if (t === 'boolean') return true;
    if (t === 'array') return [];
    if (t === 'object') return {};
    return `sample-${key}`;
  }
  if ('$array' in spec) return [sampleValue(spec.$array, key)];
  return Object.fromEntries(Object.entries(spec).map(([k, s]) => [k, sampleValue(s, k)]));
}

/**
 * A schema-valid SSE envelope for `type` (shape `shapeIndex`), with
 * `overrides` merged on top (top-level only) — e.g. to point it at a channel.
 */
export function sampleEvent(type, overrides = {}, shapeIndex = 0) {
  const shape = SSE_EVENTS[type]?.shapes[shapeIndex];
  if (!shape) throw new Error(`no shape ${shapeIndex} for ${type}`);
  const subject = shape.subject === 'sse' ? undefined : shape.subject.replace(/\*/g, 'sample');
  const fields = sampleValue(shape.required, '');
  return { ...(subject ? { subject } : {}), type, ...fields, ...overrides };
}
