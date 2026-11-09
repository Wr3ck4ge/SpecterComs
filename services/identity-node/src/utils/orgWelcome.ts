// Server welcome panel: input validation and the edit-permission rule for
// GET/PUT /orgs/:id/welcome (controllers/orgWelcomeController.ts).
//
// The welcome content is server-side org metadata (like the server name),
// NOT end-to-end encrypted: members read it over REST, and the strip renders
// its markdown with a no-HTML renderer (web-portal/src/utils/safeMarkdown.js).
import crypto from 'crypto';
import { TEXT_LIMITS, WELCOME_MAX_SECTIONS, tooLong } from './validation.js';

export interface WelcomeSection {
  id: string;
  title: string;
  body: string;
}

export type WelcomeUpdate =
  | { ok: true; subtitle?: string | null; sections?: WelcomeSection[] }
  | { ok: false; error: string };

const SECTION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const newSectionId = () => `s_${crypto.randomBytes(6).toString('hex')}`;

/**
 * Validate a PUT body. Only the fields sent change (`subtitle`, `sections`);
 * at least one is required. Strings are trimmed; a blank subtitle is stored
 * as null. Section ids are kept when they're short and [A-Za-z0-9_-] and
 * unique within the list, otherwise replaced; unknown keys are dropped.
 */
export function parseWelcomeUpdate(body: unknown): WelcomeUpdate {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object' };
  const { subtitle, sections } = body as Record<string, unknown>;
  if (subtitle === undefined && sections === undefined) {
    return { ok: false, error: 'Nothing to update: send subtitle and/or sections' };
  }
  const out: { ok: true; subtitle?: string | null; sections?: WelcomeSection[] } = { ok: true };

  if (subtitle !== undefined) {
    if (subtitle !== null && typeof subtitle !== 'string') return { ok: false, error: 'Subtitle must be text' };
    const s = typeof subtitle === 'string' ? subtitle.trim() : '';
    const err = tooLong('Subtitle', s, TEXT_LIMITS.welcomeSubtitle);
    if (err) return { ok: false, error: err };
    out.subtitle = s || null;
  }

  if (sections !== undefined) {
    if (!Array.isArray(sections)) return { ok: false, error: 'Sections must be a list' };
    if (sections.length > WELCOME_MAX_SECTIONS) {
      return { ok: false, error: `A welcome page can have at most ${WELCOME_MAX_SECTIONS} sections` };
    }
    const seen = new Set<string>();
    const list: WelcomeSection[] = [];
    for (let i = 0; i < sections.length; i++) {
      const raw = sections[i];
      const n = i + 1;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `Section ${n} is not valid` };
      const { id, title, body: text } = raw as Record<string, unknown>;
      if (title != null && typeof title !== 'string') return { ok: false, error: `Section ${n}: title must be text` };
      if (text != null && typeof text !== 'string') return { ok: false, error: `Section ${n}: body must be text` };
      const t = (title ?? '').trim();
      const b = (text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
      const err = tooLong(`Section ${n} title`, t, TEXT_LIMITS.welcomeSectionTitle)
        ?? tooLong(`Section ${n} body`, b, TEXT_LIMITS.welcomeSectionBody);
      if (err) return { ok: false, error: err };
      if (!t && !b.trim()) return { ok: false, error: `Section ${n} needs a title or some text` };
      let sid = typeof id === 'string' && SECTION_ID_RE.test(id) ? id : newSectionId();
      while (seen.has(sid)) sid = newSectionId();
      seen.add(sid);
      list.push({ id: sid, title: t, body: b });
    }
    out.sections = list;
  }
  return out;
}

/** Stored sections → the API shape (tolerates anything odd in the column). */
export function readSections(v: unknown): WelcomeSection[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s) => s && typeof s === 'object')
    .map((s: any) => ({
      id: typeof s.id === 'string' ? s.id : newSectionId(),
      title: typeof s.title === 'string' ? s.title : '',
      body: typeof s.body === 'string' ? s.body : '',
    }));
}

/**
 * Who may edit the welcome panel: the org's admins in WarRoom's sense — the
 * owner, the Commander role, or any role with can_manage_channels. Same rule
 * as the client's utils/opsPermissions.js isOrgCommander.
 */
export function canEditWelcome(
  userId: string,
  org: { owner_id: string | null },
  role: { name?: string | null; permissions?: Record<string, unknown> | null } | null,
): boolean {
  if (org.owner_id === userId) return true;
  if (!role) return false;
  return role.name === 'Commander' || role.permissions?.can_manage_channels === true;
}
