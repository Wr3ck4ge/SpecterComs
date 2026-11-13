// S3: detection (only) of a stuck MLS group.
//
// The failure it looks for: this device's copy of a group is bad. It still
// holds a key (export_secret works), but every decrypt fails, forever, and the
// server is not at fault. The one combination no transient condition produces:
//   1. a catch-up for the group actually applied commits ("the server gave us
//      everything it has"), and AFTER it
//   2. at least FAIL_THRESHOLD consecutive decrypt failures with a key held,
//   3. spanning at least MIN_WINDOW_MS (one burst of stale packets from a
//      sender that hasn't switched epochs yet doesn't trip it).
// Any successful decrypt for the group clears it. Nothing here repairs
// anything: the strip shows a chip pointing at Settings → About & diagnostics
// → Resync encryption, and the resync resets these records.
//
// Pure logic, no React and no MLS imports. Hooks:
//   mlsSession.catchUpGroup             noteCatchUp
//   CommLink (video frames, voice lanes), useMonitorChannel (voice lanes),
//   useChannelChat (live channel/DM messages)                noteDecrypt
//   WarRoom                              subscribe → state.mls.stuck

export const FAIL_THRESHOLD = 20;
export const MIN_WINDOW_MS = 10_000;

const consoleLog = (level, msg, fields) => {
  const fn = level === 'warn' ? console.warn : console.log;
  fn(`[mls-health] ${msg} ${JSON.stringify(fields ?? {})}`);
};

/**
 * One tracker. `now` and `log` are injectable for tests; `log(level, msg,
 * fields)` has mlsLog's signature (fields: ids and counts only).
 */
export function createMlsHealth({ now = () => Date.now(), threshold = FAIL_THRESHOLD, windowMs = MIN_WINDOW_MS, log = null } = {}) {
  // groupId -> { armed, fails, firstFailAt, stuck }
  const groups = new Map();
  const listeners = new Set();
  let logger = log;

  const emitLog = (level, msg, fields) => {
    try { (logger || consoleLog)(level, msg, fields); } catch { /* logging must never throw */ }
  };
  const notify = () => {
    const stuck = stuckGroups();
    for (const cb of [...listeners]) {
      try { cb(stuck); } catch { /* a listener can't break tracking */ }
    }
  };
  const record = (groupId) => {
    let r = groups.get(groupId);
    if (!r) {
      r = { armed: false, fails: 0, firstFailAt: 0, stuck: false };
      groups.set(groupId, r);
    }
    return r;
  };

  function setLogger(fn) {
    if (typeof fn === 'function') logger = fn;
  }

  /** A catch-up for `groupId` finished; commitsApplied = commits it applied. */
  function noteCatchUp(groupId, { commitsApplied = 0 } = {}) {
    if (!groupId || !(commitsApplied > 0)) return;
    const r = record(String(groupId));
    // The group's state moved: count failures from here (a stuck flag stays
    // until a decrypt succeeds or the user resyncs).
    r.armed = true;
    r.fails = 0;
    r.firstFailAt = 0;
  }

  /** One decrypt attempt for `groupId`. Failures without a key held are ignored. */
  function noteDecrypt(groupId, ok, { keyHeld = true } = {}) {
    if (!groupId) return;
    const id = String(groupId);
    if (ok) {
      const r = groups.get(id);
      if (!r || (r.fails === 0 && !r.stuck)) return;
      r.fails = 0;
      r.firstFailAt = 0;
      if (r.stuck) {
        r.stuck = false;
        emitLog('info', 'group decrypts again; no longer flagged as out of sync', { groupId: id });
        notify();
      }
      return;
    }
    if (!keyHeld) return;
    const r = groups.get(id);
    if (!r || !r.armed || r.stuck) return;
    const t = now();
    if (r.fails === 0) r.firstFailAt = t;
    r.fails += 1;
    if (r.fails >= threshold && t - r.firstFailAt >= windowMs) {
      r.stuck = true;
      emitLog('warn', 'group looks stuck: decrypts keep failing with a key held after a catch-up applied commits; suggest Resync encryption', {
        groupId: id, failures: r.fails, spanMs: t - r.firstFailAt,
      });
      notify();
    }
  }

  /** Group ids currently flagged, sorted. */
  function stuckGroups() {
    const out = [];
    for (const [id, r] of groups) if (r.stuck) out.push(id);
    return out.sort();
  }

  /** cb(stuckGroupIds) on every change of the stuck set. Returns unsubscribe. */
  function subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  /** Forget one group's record (or every record without an id), e.g. after a resync. */
  function reset(groupId) {
    const wasStuck = groupId == null
      ? stuckGroups().length > 0
      : Boolean(groups.get(String(groupId))?.stuck);
    if (groupId == null) groups.clear();
    else groups.delete(String(groupId));
    if (wasStuck) notify();
  }

  return { noteCatchUp, noteDecrypt, stuckGroups, subscribe, reset, setLogger };
}

// The app-wide tracker. Every entry point swallows its own errors: health
// tracking must never break media or chat.
const shared = createMlsHealth();

export function noteCatchUp(groupId, info) {
  try { shared.noteCatchUp(groupId, info); } catch { /* best-effort */ }
}
export function noteDecrypt(groupId, ok, info) {
  try { shared.noteDecrypt(groupId, ok, info); } catch { /* best-effort */ }
}
export const stuckGroups = () => shared.stuckGroups();
export const subscribe = (cb) => shared.subscribe(cb);
export function reset(groupId) {
  try { shared.reset(groupId); } catch { /* best-effort */ }
}
export const setMlsHealthLogger = (fn) => shared.setLogger(fn);
