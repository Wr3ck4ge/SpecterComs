/**
 * NATS subject layout and per-principal permissions (contract C2).
 *
 * Node → control plane (scoped by the publishing node's id, so the NATS server
 * can restrict each node to its own subjects):
 *   media.heartbeat.<NODE_ID>                  heartbeat (C3 payload)
 *   specter.usage.session_start.<NODE_ID>      usage start (not consumed yet)
 *   specter.usage.session_end.<NODE_ID>        usage end → billing + presence
 * Legacy unscoped forms (media.heartbeat, specter.usage.session_*) are still
 * consumed during the rollout, but only from the legacy-token principal.
 *
 * What media-rust does on the bus (read from services/media-rust/src/main.rs):
 *   sub  specter.cmd.>            kick / mute / unmute / move / drain_org / duck
 *   sub  specter.event.tree.>     live event-tree pushes
 *   req  specter.event.tree.request (startup backfill; reply on _INBOX.<NODE_ID>.>)
 *   pub  specter.cmd.duck.<room>  relay → relay priority ducking (main.rs:574, :2112)
 *   pub  specter.diag.netprobe.<NODE_ID>  netprobe answers (netdiag.rs; arm cmd is specter.cmd.netprobe.arm)
 * so a node may publish specter.cmd.duck.> — the ONLY specter.cmd subject a
 * node may publish. Everything else under specter.cmd.> is control-plane only.
 */

export const HEARTBEAT_SUBJECT = 'media.heartbeat';
export const SESSION_END_SUBJECT = 'specter.usage.session_end';
export const SESSION_START_SUBJECT = 'specter.usage.session_start';
/** Netprobe answers, scoped like the heartbeat: specter.diag.netprobe.<NODE_ID>. */
export const NETPROBE_RESULT_SUBJECT = 'specter.diag.netprobe';

/** NATS user name of identity-node itself (static user in the server config). */
export const CONTROL_PLANE_USER = 'specter-control';

/** Same rule media-rust enforces (config.rs): one subject token, no dots or wildcards. */
const NODE_ID_TOKEN = /^[a-z0-9-]{1,32}$/;
export const isNatsNodeId = (id: string): boolean => NODE_ID_TOKEN.test(id) && id !== CONTROL_PLANE_USER;

export interface NatsPermissions {
  pub: { allow: string[]; deny?: string[] };
  sub: { allow: string[]; deny?: string[] };
}

// A node must not be able to answer (and so poison) other nodes' backfill requests.
const NODE_SUBSCRIBE_DENY = ['specter.event.tree.request'];

/**
 * Permissions for a node authenticated as NATS user <nodeId>. Mirrors
 * services/media-rust/src/nats.rs: media-rust sets its request/reply inbox
 * prefix to _INBOX.<NODE_ID>, so a node only sees its own replies.
 * specter.usage.session_start is still published UNSCOPED by media-rust (its
 * payload carries node_id; identity-node doesn't consume it yet), so the
 * unscoped form is allowed for every node; the scoped form is allowed too, for
 * when media-rust moves it.
 */
export function nodePermissions(nodeId: string): NatsPermissions {
  return {
    pub: {
      allow: [
        `${HEARTBEAT_SUBJECT}.${nodeId}`,
        SESSION_START_SUBJECT,
        `${SESSION_START_SUBJECT}.${nodeId}`,
        `${SESSION_END_SUBJECT}.${nodeId}`,
        'specter.cmd.duck.>',
        'specter.event.tree.request',
        `${NETPROBE_RESULT_SUBJECT}.${nodeId}`, // netprobe answers (src/netdiag.rs)
      ],
    },
    sub: {
      allow: ['specter.cmd.>', 'specter.event.tree.>', `_INBOX.${nodeId}.>`],
      deny: [...NODE_SUBSCRIBE_DENY],
    },
  };
}

/**
 * Permissions for the legacy shared NATS_AUTH_TOKEN (node-1 during rollout).
 * It may use the unscoped legacy subjects, and the scoped ones only for the
 * configured legacy node ids — so even the legacy token can't impersonate a
 * provisioned node.
 */
export function legacyTokenPermissions(legacyNodeIds: string[]): NatsPermissions {
  const scoped = legacyNodeIds.flatMap((id) => [
    `${HEARTBEAT_SUBJECT}.${id}`, `${SESSION_START_SUBJECT}.${id}`, `${SESSION_END_SUBJECT}.${id}`,
    `${NETPROBE_RESULT_SUBJECT}.${id}`,
  ]);
  return {
    pub: {
      allow: [
        HEARTBEAT_SUBJECT, SESSION_START_SUBJECT, SESSION_END_SUBJECT, ...scoped,
        'specter.cmd.duck.>', 'specter.event.tree.request',
      ],
    },
    // Pre-hardening binaries use the default _INBOX prefix.
    sub: { allow: ['specter.cmd.>', 'specter.event.tree.>', '_INBOX.>'], deny: [...NODE_SUBSCRIBE_DENY] },
  };
}

/**
 * The node id a scoped subject names, `null` for the legacy unscoped subject,
 * or `undefined` if the subject isn't one of ours (or the suffix is not a
 * valid node id).
 */
export function scopedNodeId(subject: string, base: string): string | null | undefined {
  if (subject === base) return null;
  if (!subject.startsWith(`${base}.`)) return undefined;
  const suffix = subject.slice(base.length + 1);
  return isNatsNodeId(suffix) ? suffix : undefined;
}

/** NATS_LEGACY_NODE_IDS (comma list), default node-1,node-1-green. */
export function legacyNodeIds(): string[] {
  const raw = process.env.NATS_LEGACY_NODE_IDS ?? 'node-1,node-1-green';
  return raw.split(',').map((s) => s.trim()).filter(isNatsNodeId);
}

/**
 * Whether a message on a node subject is acceptable:
 *  - scoped: the payload's node_id must equal the subject suffix (a node can
 *    only publish its own suffix, so this binds the payload to the sender);
 *  - unscoped legacy: accepted for any node id while NATS auth is off (today's
 *    behaviour); once NATS_AUTH_MODE=callout only for the legacy node ids,
 *    since only the legacy-token principal can publish unscoped.
 */
export function acceptNodeMessage(subject: string, base: string, payloadNodeId: unknown): { ok: true; nodeId: string | null } | { ok: false; reason: string } {
  const scoped = scopedNodeId(subject, base);
  if (scoped === undefined) return { ok: false, reason: `unexpected subject ${subject}` };
  if (scoped !== null) {
    if (payloadNodeId !== scoped) {
      return { ok: false, reason: `payload node_id ${JSON.stringify(payloadNodeId)} does not match subject ${subject}` };
    }
    return { ok: true, nodeId: scoped };
  }
  if (process.env.NATS_AUTH_MODE === 'callout' && typeof payloadNodeId === 'string' && !legacyNodeIds().includes(payloadNodeId)) {
    return { ok: false, reason: `legacy unscoped ${base} for non-legacy node ${payloadNodeId}` };
  }
  return { ok: true, nodeId: typeof payloadNodeId === 'string' ? payloadNodeId : null };
}

/** Rate-limited warn so a misbehaving publisher can't flood the log. */
const lastWarn = new Map<string, number>();
export function warnRejected(kind: string, reason: string): void {
  const now = Date.now();
  if ((lastWarn.get(reason) ?? 0) > now - 60_000) return;
  lastWarn.set(reason, now);
  console.warn(`[nats] rejected ${kind}: ${reason}`);
}
