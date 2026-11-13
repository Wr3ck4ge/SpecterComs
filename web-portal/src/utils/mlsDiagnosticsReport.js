// S2: plain-text form of mlsSession.getMlsDiagnostics() — shown by the
// Settings → About → Encryption panel's "Copy" and attached to the Submit
// diagnostics bundle. Pure (no WASM, no state) so it's unit-testable.
// Carries only ids, epochs and `${userId}:${deviceId}` labels — never keys.

/** Groups in a stable order: errors last, then by group id. */
export function sortMlsGroups(groups) {
  return [...(groups || [])].sort((a, b) => {
    const ea = a?.error ? 1 : 0;
    const eb = b?.error ? 1 : 0;
    if (ea !== eb) return ea - eb;
    return String(a?.groupId ?? '').localeCompare(String(b?.groupId ?? ''));
  });
}

/** Display name for a group: names[groupId] when known, else the raw id. */
export function mlsGroupName(groupId, names) {
  const n = names && typeof names === 'object' ? names[groupId] : null;
  return n ? `${n} (${groupId})` : String(groupId);
}

/**
 * The diagnostics as a plain-text report.
 * `diag` = { loaded, ownLabel, stateVersion, groups, error? };
 * `opts` = { names?: { [groupId]: string }, now?: Date }.
 */
export function formatMlsDiagnostics(diag, opts = {}) {
  const lines = [];
  const now = opts.now instanceof Date ? opts.now : new Date();
  lines.push(`MLS diagnostics — ${now.toISOString()}`);
  if (!diag) {
    lines.push('No diagnostics available.');
    return lines.join('\n');
  }
  lines.push(`This device: ${diag.ownLabel || '(unknown — identity not loaded)'}`);
  if (!diag.loaded) {
    lines.push('Local MLS state is not loaded (not signed in yet, or encryption not started).');
    return lines.join('\n');
  }
  if (diag.stateVersion != null) lines.push(`State version: ${diag.stateVersion}`);
  if (diag.error) lines.push(`Error listing groups: ${diag.error}`);
  const groups = sortMlsGroups(diag.groups);
  const notMember = groups.filter((g) => !g.error && !g.selfIsMember).length;
  const errored = groups.filter((g) => g.error).length;
  lines.push(`Groups held: ${groups.length}${notMember ? ` (${notMember} without this device as a member)` : ''}${errored ? ` (${errored} unreadable)` : ''}`);
  for (const g of groups) {
    lines.push('');
    lines.push(`Group ${mlsGroupName(g.groupId, opts.names)}`);
    if (g.error) {
      lines.push(`  error: ${g.error}`);
      continue;
    }
    lines.push(`  epoch: ${g.epoch}`);
    lines.push(`  members: ${g.memberCount}`);
    lines.push(`  this device is a member: ${g.selfIsMember ? 'yes' : 'NO'}`);
    for (const label of g.memberLabels || []) {
      lines.push(`    - ${label}${label === diag.ownLabel ? '  (this device)' : ''}`);
    }
  }
  return lines.join('\n');
}
