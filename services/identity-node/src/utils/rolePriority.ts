/**
 * Two priority scales meet at the media ticket, and they run opposite ways.
 *
 *   planner (event_group_roles.priority)  1 LOW ... 5 CRITICAL: higher outranks
 *   media-rust (ticket priority_level)    1 and 2 are priority speakers (1 the
 *                                         deeper duck); 3+ are ordinary speakers
 *
 * Owner decision: 1 is the lowest priority and 5 the highest. So the ticket
 * converts here and media-rust's meaning stays put: CRITICAL → level 1, HIGH →
 * level 2, the rest speak normally. Saved roles keep their numbers.
 */
export const RELAY_LEVEL_COMMANDER = 1;
export const RELAY_LEVEL_NONE = 5;

/** A role's planner priority (1..5, 5 highest) → media-rust's level. A missing value counts as the default, 3. */
export function rolePriorityToRelayLevel(priority: unknown): number {
  const p = Math.trunc(Number(priority));
  const clamped = Number.isFinite(p) && p !== 0 ? Math.min(5, Math.max(1, p)) : 3;
  return 6 - clamped;
}

/**
 * FREQPRIO: a frequency has its OWN per-member priority
 * (event_frequency_members, planner scale 1..5), fully independent of
 * the member's group role priority — a 5 in their group can be a 2 on a net.
 * Never inherited, maxed or mixed. Unset = this default (everyone equal, no
 * ducking), and the op's commander is NOT raised automatically on a frequency.
 */
export const FREQUENCY_DEFAULT_PRIORITY = 3;

/** Validates a planner-sent priority: an integer 1..5, else null. */
export function parsePlannerPriority(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && !/^\s*\d+\s*$/.test(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates every frequency's optional `member_priorities` ({ user_id: 1..5 },
 * FREQWL: its keys are the frequency's whitelist)
 * in a planner save. Returns an error message, or null when valid. Pure.
 */
export function frequencyMemberPrioritiesError(frequencies: unknown): string | null {
  if (!Array.isArray(frequencies)) return null;
  for (const f of frequencies) {
    const mp = (f as any)?.member_priorities;
    if (mp === undefined || mp === null) continue;
    if (typeof mp !== 'object' || Array.isArray(mp)) return 'member_priorities must be an object';
    const entries = Object.entries(mp);
    if (entries.length > 500) return 'Too many member priorities';
    for (const [uid, p] of entries) {
      if (!UUID_RE.test(uid)) return 'member_priorities keys must be user ids';
      if (parsePlannerPriority(p) === null) return 'Frequency priority must be an integer from 1 to 5';
    }
  }
  return null;
}

/**
 * The media ticket's priority_level for an event channel. Pure.
 *   frequency  ONLY the member's frequency priority (default if unset)
 *   group/etc  commander → 1; else the highest accepted role's priority; else none
 */
export function eventTicketPriorityLevel(o: {
  kind: string | null;
  isEventCommander: boolean;
  groupRolePriority: number | null;
  frequencyPriority: number | null;
}): number {
  if (o.kind === 'frequency') return rolePriorityToRelayLevel(o.frequencyPriority ?? FREQUENCY_DEFAULT_PRIORITY);
  if (o.isEventCommander) return RELAY_LEVEL_COMMANDER;
  if (o.groupRolePriority != null) return rolePriorityToRelayLevel(o.groupRolePriority);
  return RELAY_LEVEL_NONE;
}
