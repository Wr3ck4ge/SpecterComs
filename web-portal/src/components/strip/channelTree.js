// OPTREE: the Channels cabinet's sections, built from EngineState.channels
// (engine/bridge.js). Pure, so the dev preview and tests share it.
//
// A launched operation is ONE entry: a heading with its name, which nobody
// joins, and the op's group channels beneath it as a tree that follows the
// event's group tree (the server parents each group channel to its parent
// group's channel, root groups to the command channel). Command and the
// frequencies are never rows in this list: `command` below only names the
// heading and keeps its channel out of the tree, and the server hides
// frequency channels. Any other channel of the op (a debrief, a planner-made
// one) sits at the top level of that tree.
//
// An older server sends no annotations (eventKind/eventName): then the op's
// root channel (no parent, with children) is taken as its command channel.

const COMMAND_SUFFIX = /\s+[—-]\s+COMMAND$/;

/** "Op Name — COMMAND" → "Op Name" (fallback when the server sends no event_name). */
export function opNameFromCommand(name) {
  return String(name || '').replace(COMMAND_SUFFIX, '') || 'Operation';
}

/**
 * Frequency overlay phase 2: may this channel appear as a row in a channel
 * list? Frequencies are nets (never rows) and there is no command channel —
 * a command-kind row (only an old server could send one) is hidden too.
 * Accepts a raw server row (event_kind / is_frequency) or an EngineState
 * channel (eventKind / isFrequency).
 */
export function isListedChannel(ch) {
  if (!ch) return false;
  if (ch.event_kind === 'command' || ch.eventKind === 'command') return false;
  if (ch.is_frequency === true || ch.isFrequency === true) return false;
  return true;
}

/**
 * Why this channel can't be joined (null = it can). `channel` is an
 * EngineState.channels entry. Mirrors the server's rule, which the media ticket
 * enforces; shown on the row and the Join button, and the engine refuses with
 * it before connecting.
 */
export function joinBlockedReason(channel) {
  if (channel?.eventKind === 'command') return "Command isn't a channel you join";
  if (!channel || channel.canJoin !== false) return null;
  if (channel.pendingMine) return 'Your sign-up for this group is still pending';
  if (channel.eventKind === 'group') return 'Only members of this group can join';
  return "You're not signed up for this operation";
}

/**
 * channels: EngineState.channels
 * → { voice: Channel[], text: Channel[], ops: [{ eventId, name, command: Channel|null,
 *      nodes: [{ channel, depth }], mineId: string|null }] }
 * `ops` keeps the order the op first appears in `channels` (created_at order).
 */
export function buildChannelSections(channels = []) {
  const voice = [];
  const text = [];
  const opsById = new Map();
  for (const ch of channels) {
    if (ch.kind === 'text') { text.push(ch); continue; }
    if (!ch.eventId) { voice.push(ch); continue; }
    if (!opsById.has(ch.eventId)) opsById.set(ch.eventId, []);
    opsById.get(ch.eventId).push(ch);
  }

  const ops = [];
  for (const [eventId, list] of opsById) {
    const ids = new Set(list.map((c) => c.id));
    let command = list.find((c) => c.eventKind === 'command') || null;
    if (!command && !list.some((c) => c.eventKind)) {
      command = list.find((c) => !c.parentId && list.some((o) => o.parentId === c.id)) || null;
    }
    const children = new Map(); // parentId → channels
    const roots = [];
    for (const c of list) {
      if (command && c.id === command.id) continue;
      const parent = c.parentId && ids.has(c.parentId) && (!command || c.parentId !== command.id) ? c.parentId : null;
      if (parent) {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(c);
      } else {
        roots.push(c);
      }
    }
    const nodes = [];
    const seen = new Set();
    const walk = (c, depth) => {
      if (seen.has(c.id)) return; // a malformed (cyclic) tree can't loop
      seen.add(c.id);
      nodes.push({ channel: c, depth });
      for (const k of children.get(c.id) || []) walk(k, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    // Anything only reachable through a cycle: show it flat rather than lose it.
    for (const c of list) if (!seen.has(c.id) && (!command || c.id !== command.id)) walk(c, 0);

    const name = list.find((c) => c.eventName)?.eventName || (command ? opNameFromCommand(command.name) : 'Operation');
    ops.push({ eventId, name, command, nodes, mineId: list.find((c) => c.mine)?.id || null });
  }
  return { voice, text, ops };
}
