// DM toasts in the in-game overlay, with an inline reply — the shared parts.
//
// Data path (the overlay window has NO plugin capabilities, only core events):
//   engine → overlay   OVERLAY_DM_EVENT        { toast: OverlayDmToast }
//       emitted by the engine (WarRoom) to the overlay window only
//       (emitTo 'specter-overlay') when a live DM from a partner arrives, the
//       overlay is open and "Show DMs in overlay" is on. Plaintext, decrypted
//       in the engine; local IPC between two windows of this app, never sent
//       over the network.
//   overlay → engine   OVERLAY_DM_REPLY_EVENT  { requestId, userId, text }
//       the inline reply. The engine sends it through the same E2E (MLS) DM
//       path as the strip (useChannelChat.sendDm) — never plaintext — and
//       answers with
//   engine → overlay   OVERLAY_DM_REPLY_RESULT_EVENT { requestId, ok, error? }
//
// OverlayDmToast = { id, userId, callsign, text, timestamp }
//
// Privacy: the overlay window is excluded from screen capture
// (WDA_EXCLUDEFROMCAPTURE, src-tauri/src/lib.rs's overlay setup), so DM text shown in it
// doesn't leak into the user's own screen share. TODO(stream-safe mode): a
// future "stream-safe" mode (e.g. when that exclusion is unavailable, or for
// capture tools that ignore it) MUST hide these toasts entirely.

export const OVERLAY_WINDOW = 'specter-overlay';
export const OVERLAY_DM_EVENT = 'overlay-dm';
export const OVERLAY_DM_REPLY_EVENT = 'overlay-dm-reply';
export const OVERLAY_DM_REPLY_RESULT_EVENT = 'overlay-dm-reply-result';

/** "Show DMs in overlay" (engine localStorage; on by default). */
export const OVERLAY_DMS_KEY = 'specter_overlay_dms';
export function loadOverlayDmsEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(OVERLAY_DMS_KEY) !== '0'; } catch { return true; }
}
export function saveOverlayDmsEnabled(enabled, storage = globalThis.localStorage) {
  try { storage?.setItem(OVERLAY_DMS_KEY, enabled ? '1' : '0'); } catch { /* not fatal */ }
}

export const MAX_TOASTS = 3;
export const TOAST_TTL_MS = 8_000;
export const SENT_LINGER_MS = 1_500;
export const TOAST_TEXT_MAX = 600; // what crosses to the overlay (it clamps to 2 lines anyway)

// Layout (px, natural size — the toast area doesn't scale with the overlay).
export const TOAST_H = 58;       // one toast: sender + time line, two text lines
export const TOAST_GAP = 4;
export const TOAST_AREA_PAD = 4; // above and below the stack
export const REPLY_H = 38;       // the inline reply box under the open toast

/** Engine side: the toast for a live DM note (useChannelChat.onDmReceived). */
export function toastFromDm(note) {
  if (!note?.id || !note.partnerId) return null;
  const text = note.text == null ? null : String(note.text).slice(0, TOAST_TEXT_MAX);
  return { id: note.id, userId: note.partnerId, callsign: note.callsign || 'Someone', text, timestamp: note.timestamp || null };
}

/**
 * Overlay side: add a toast to the stack — newest first, at most MAX_TOASTS,
 * a repeat id replaces its old copy. Each entry: { ...toast, addedAt }.
 */
export function pushToast(stack, toast, now = Date.now()) {
  if (!toast?.id) return stack;
  const rest = (stack || []).filter((t) => t.id !== toast.id);
  return [{ ...toast, addedAt: now }, ...rest].slice(0, MAX_TOASTS);
}

/**
 * When a toast goes away (ms timestamp), or null = it stays for now:
 *   open for a reply (keepId) or the reply is sending   stays
 *   reply sent                                           sentAt + SENT_LINGER_MS
 *                                                        (also while interactive:
 *                                                        "sent", then it fades)
 *   otherwise, overlay interactive (passthrough off)     stays — the user can act on it
 *   otherwise                                            addedAt + TOAST_TTL_MS
 */
function expiresAt(t, { interactive, keepId }) {
  if (t.id === keepId || t.reply === 'sending') return null;
  if (t.reply === 'sent') return (t.sentAt || 0) + SENT_LINGER_MS;
  if (interactive) return null;
  return (t.addedAt || 0) + TOAST_TTL_MS;
}

/** Overlay side: drop expired toasts (same array back when nothing changed). */
export function expireToasts(stack, { now = Date.now(), interactive = false, keepId = null } = {}) {
  const list = stack || [];
  const next = list.filter((t) => {
    const at = expiresAt(t, { interactive, keepId });
    return at == null || now < at;
  });
  return next.length === list.length ? stack : next;
}

/** When expireToasts next has something to do (ms from now), or null. */
export function nextExpiryIn(stack, { now = Date.now(), interactive = false, keepId = null } = {}) {
  let next = Infinity;
  for (const t of stack || []) {
    const at = expiresAt(t, { interactive, keepId });
    if (at != null) next = Math.min(next, at - now);
  }
  return next === Infinity ? null : Math.max(0, next);
}

/**
 * Overlay side: when the overlay goes back to passthrough, waiting toasts get
 * a fresh TTL (they didn't fade while it was interactive, so they'd otherwise
 * vanish the instant it switches back).
 */
export function restartToastTimers(stack, now = Date.now()) {
  return (stack || []).map((t) => (t.reply === 'sent' || t.reply === 'sending' ? t : { ...t, addedAt: now }));
}

/** Height of the toast area for the window size: 0 when empty; bounded. */
export function toastAreaHeight(count, replyOpen = false) {
  const n = Math.min(MAX_TOASTS, Math.max(0, count | 0));
  if (!n) return 0;
  return TOAST_AREA_PAD * 2 + n * TOAST_H + (n - 1) * TOAST_GAP + (replyOpen ? REPLY_H + TOAST_GAP : 0);
}
