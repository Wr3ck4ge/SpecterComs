// Server welcome panel — limits, "seen" tracking and the auto-show rule.
// Pure (no React) so web-portal/test/welcome.test.js covers it.
//
// The welcome content is server-side org metadata, like the server name: it
// is NOT end-to-end encrypted (see identity-node controllers/orgWelcomeController.ts).

// Mirrors identity-node utils/validation.ts TEXT_LIMITS.welcome* and
// WELCOME_MAX_SECTIONS. The inputs' maxLength counts UTF-16 units and the
// server counts code points, so the client is never the looser of the two.
export const WELCOME_LIMITS = {
  subtitle: 200,
  sectionTitle: 80,
  sectionBody: 4000,
  maxSections: 10,
};

// ── "Seen" tracking ────────────────────────────────────────────────────────
// localStorage (the strip's own WebView2 profile):
//   specter_strip_welcome_seen  { [userId]: { [orgId]: <welcome_updated_at> } }
// The pane auto-opens once per (user, server, updated_at): the stored value is
// the updated_at last shown, so any later edit (new updated_at) shows it again.
export const WELCOME_SEEN_KEY = 'specter_strip_welcome_seen';
const MAX_ORGS_PER_USER = 100;

function readAll(storage) {
  try {
    const v = JSON.parse(storage?.getItem(WELCOME_SEEN_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function welcomeSeenAt(userId, orgId, storage = globalThis.localStorage) {
  if (!userId || !orgId) return null;
  const v = readAll(storage)[userId]?.[orgId];
  return typeof v === 'string' ? v : null;
}

export function markWelcomeSeen(userId, orgId, updatedAt, storage = globalThis.localStorage) {
  if (!userId || !orgId || !updatedAt) return;
  const all = readAll(storage);
  const mine = { ...(all[userId] && typeof all[userId] === 'object' ? all[userId] : {}) };
  delete mine[orgId]; // re-insert last: insertion order = recency for pruning
  mine[orgId] = updatedAt;
  const keys = Object.keys(mine);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ORGS_PER_USER))) delete mine[k];
  all[userId] = mine;
  try { storage?.setItem(WELCOME_SEEN_KEY, JSON.stringify(all)); } catch { /* not fatal */ }
}

/**
 * Should the welcome pane open by itself? Only for a server that has welcome
 * content (welcome_updated_at set) the user hasn't been shown at that
 * updated_at, and never over a game overlay, during the user's own share,
 * while the stream viewer / share picker is up, or over another open cabinet.
 *   org      the /orgs/me entry (welcome_updated_at)
 *   blockers { overlayOpen, sharing, viewerOpen, pickerOpen, cabinetOpen }
 */
export function shouldAutoShowWelcome({ org, userId, blockers = {}, storage = globalThis.localStorage }) {
  if (!org?.id || !userId || !org.welcome_updated_at) return false;
  if (blockers.overlayOpen || blockers.sharing || blockers.viewerOpen || blockers.pickerOpen || blockers.cabinetOpen) return false;
  return welcomeSeenAt(userId, org.id, storage) !== org.welcome_updated_at;
}

// ── Editor draft ───────────────────────────────────────────────────────────
let idSeq = 0;
export const newSectionId = () => `s_${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The API's welcome → an editable draft. */
export function draftFrom(welcome) {
  return {
    subtitle: welcome?.subtitle || '',
    sections: (welcome?.sections || []).map((s) => ({ id: s.id || newSectionId(), title: s.title || '', body: s.body || '' })),
  };
}

/** Client-side check before PUT (the server re-checks everything). Returns an error string or null. */
export function draftError(draft) {
  if ((draft.subtitle || '').length > WELCOME_LIMITS.subtitle) return `Subtitle can be at most ${WELCOME_LIMITS.subtitle} characters`;
  if (draft.sections.length > WELCOME_LIMITS.maxSections) return `A welcome page can have at most ${WELCOME_LIMITS.maxSections} sections`;
  for (let i = 0; i < draft.sections.length; i++) {
    const s = draft.sections[i];
    if (s.title.length > WELCOME_LIMITS.sectionTitle) return `Section ${i + 1} title can be at most ${WELCOME_LIMITS.sectionTitle} characters`;
    if (s.body.length > WELCOME_LIMITS.sectionBody) return `Section ${i + 1} body can be at most ${WELCOME_LIMITS.sectionBody} characters`;
    if (!s.title.trim() && !s.body.trim()) return `Section ${i + 1} needs a title or some text`;
  }
  return null;
}

export function moveSection(sections, index, delta) {
  const j = index + delta;
  if (j < 0 || j >= sections.length) return sections;
  const next = [...sections];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

/** "Copy from public page": a section prefilled from the org's landing_description. */
export function sectionFromLanding(landing) {
  const body = String(landing || '').replace(/\r\n?/g, '\n').trim().slice(0, WELCOME_LIMITS.sectionBody);
  return body ? { id: newSectionId(), title: 'About us', body } : null;
}

/** Show a counter once a field is this close to its limit. */
export const counterVisible = (len, max) => len >= Math.floor(max * 0.8);
