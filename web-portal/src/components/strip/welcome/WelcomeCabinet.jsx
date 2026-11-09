// The tray strip's server welcome panel — Discord's "Welcome to <server>"
// plus a rules/info channel, as a cabinet: banner, the server logo and
// "Welcome to <name>", the subtitle, then each section as a titled card of
// rendered markdown. Owners / admins (can_edit from the API) get an editor.
//
// Data: GET/PUT /orgs/:id/welcome (identity-node orgWelcomeController.ts).
// This is server-side org metadata, like the server name — it is NOT
// end-to-end encrypted, and the editor says so.
//
// Opened by StripApp: automatically once per (user, server, updated_at)
// when the strip is opened onto a server (welcomeModel.js
// shouldAutoShowWelcome), or from the "Welcome page" row in the server
// switcher cabinet.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, BookOpen, Copy, Eye, Info, Pencil, Plus, Trash2, X,
} from 'lucide-react';
import { Alert, Button, IconButton } from '../../ui';
import { cx, focusRing } from '../../ui/styles';
import HexBadge from '../../HexBadge';
import { getOrgColor } from '../../../utils/orgColors';
import { api as realApi, UPLOADS_BASE_URL } from '../../../api';
import { renderMarkdown, safeHref } from '../../../utils/safeMarkdown';
import { openExternal } from '../../../utils/openExternal';
import {
  WELCOME_LIMITS, counterVisible, draftError, draftFrom, moveSection, newSectionId, sectionFromLanding,
} from './welcomeModel';

const BANNER_H = 112;
const LOGO = 60;
const PANEL_BG = '#0b1d2e'; // .strip-panel's background (strip.css)

const logoSrc = (url) => (url ? `${UPLOADS_BASE_URL}${url}` : null);
// banner_url is a free-form URL from the website's landing settings; only
// http(s) (or an /uploads path) is used, and the window's CSP decides what
// actually loads — a blocked image falls back to the gradient.
function bannerSrc(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/uploads/')) return `${UPLOADS_BASE_URL}${url}`;
  return safeHref(url);
}

function fmtUpdated(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function Markdown({ source, onLinkError }) {
  const nodes = useMemo(() => renderMarkdown(source, {
    onOpenLink: (href) => { openExternal(href).catch((err) => onLinkError?.(`Couldn't open the browser: ${err?.message || err}`)); },
  }), [source, onLinkError]);
  return <div className="text-ui-sm text-specter-text-muted break-words [overflow-wrap:anywhere]">{nodes}</div>;
}

function Counter({ len, max }) {
  if (!counterVisible(len, max)) return null;
  const tone = len >= max ? 'text-red-300' : len >= max * 0.95 ? 'text-specter-state-warning' : 'text-specter-text-subtle';
  return <span className={cx('text-ui-xs tabular-nums', tone)} aria-live="polite">{len}/{max}</span>;
}

// ── View ───────────────────────────────────────────────────────────────────

function Banner({ url, children }) {
  const src = bannerSrc(url);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const showImg = src && !failed;
  return (
    <div className="relative shrink-0 overflow-hidden rounded-t-[13px]" style={{ height: BANNER_H }}>
      {showImg ? (
        <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} draggable={false} />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-specter-primary-dim/70 via-specter-bg-panel to-specter-bg-deep">
          <div className="absolute inset-0 bg-grid-pattern opacity-40 [background-size:22px_22px]" />
          <div className="absolute -right-10 -top-12 h-40 w-40 rounded-full bg-specter-primary-cyan/20 blur-2xl" />
        </div>
      )}
      {/* Fades into the panel so the logo and title sit on it cleanly. */}
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-14" style={{ background: `linear-gradient(to top, ${PANEL_BG}, transparent)` }} />
      {children}
    </div>
  );
}

function SectionCard({ section, onLinkError }) {
  return (
    <section className="rounded-ui-md border border-specter-border-divider bg-specter-bg-panel/50 px-3 py-2.5">
      {section.title && (
        <h3 className="mb-1.5 flex items-center gap-2 text-ui-base font-semibold text-specter-text-main">
          <span aria-hidden="true" className="h-4 w-1 shrink-0 rounded-pill bg-specter-primary-cyan" />
          <span className="min-w-0 break-words">{section.title}</span>
        </h3>
      )}
      {section.body && <Markdown source={section.body} onLinkError={onLinkError} />}
    </section>
  );
}

function WelcomeView({ welcome, org, orgIndex, onEdit, onClose }) {
  const [linkError, setLinkError] = useState(null);
  const name = welcome?.name || org?.callsign || 'this server';
  const logo = logoSrc(welcome?.logo_url ?? org?.logo_url);
  const sections = welcome?.sections || [];
  const empty = !welcome?.subtitle && sections.length === 0;
  const updated = fmtUpdated(welcome?.updated_at);
  return (
    <>
      <Banner url={welcome?.banner_url ?? org?.banner_url}>
        <div className="absolute right-2 top-2 flex items-center gap-1 rounded-ui-row bg-specter-bg-deep/60 p-0.5 backdrop-blur-sm">
          {welcome?.can_edit && !empty && (
            <Button size="sm" variant="ghost" className="!h-7 !px-2" icon={<Pencil size={13} />} onClick={onEdit}>Edit</Button>
          )}
          <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
        </div>
      </Banner>
      <div className="relative z-[1] -mt-9 px-4">
        <HexBadge letter={name[0] || '?'} colorKey={getOrgColor(Math.max(0, orgIndex))} size={LOGO} imageUrl={logo} active />
        <h2 className="mt-2 text-ui-xl font-bold leading-tight text-specter-text-main break-words">
          Welcome to <span className="text-specter-primary-neon">{name}</span>
        </h2>
        {welcome?.subtitle && <p className="mt-1 text-ui-sm text-specter-text-subtle break-words">{welcome.subtitle}</p>}
      </div>
      <div className="space-y-2 px-3 pt-3 pb-3">
        {linkError && <Alert variant="error">{linkError}</Alert>}
        {empty && welcome?.can_edit && (
          <div className="rounded-ui-md border border-dashed border-specter-border px-4 py-4 text-center">
            <BookOpen size={20} className="mx-auto text-specter-primary-neon" aria-hidden="true" />
            <p className="mt-1.5 text-ui-base font-semibold text-specter-text-main">Set up your welcome page</p>
            <p className="mt-0.5 text-ui-sm text-specter-text-subtle">
              Rules, links and info members see when they open this server.
            </p>
            <Button size="sm" className="mt-3" icon={<Pencil size={13} />} onClick={onEdit}>Set up your welcome page</Button>
          </div>
        )}
        {sections.map((s) => <SectionCard key={s.id} section={s} onLinkError={setLinkError} />)}
        {updated && !empty && (
          <p className="px-1 pt-0.5 text-ui-xs text-specter-text-subtle">Updated {updated}</p>
        )}
      </div>
    </>
  );
}

// ── Editor ─────────────────────────────────────────────────────────────────

const fieldCls = cx(
  'w-full rounded-ui-row border border-specter-border bg-specter-bg-deep/60 px-3 text-ui-base text-specter-text-main',
  'placeholder:text-specter-text-subtle hover:border-specter-border-strong focus:border-specter-primary-cyan focus:outline-none',
);

function FieldLabel({ htmlFor, children, len, max }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-ui-sm font-medium text-specter-text-muted">{children}</label>
      <Counter len={len} max={max} />
    </div>
  );
}

function SegToggle({ value, onChange, idBase }) {
  const opt = (v, label, Icon) => (
    <button type="button" id={`${idBase}-${v}`} role="tab" aria-selected={value === v} onClick={() => onChange(v)}
      className={cx('inline-flex h-6 items-center gap-1 rounded-ui-sm px-2 text-ui-xs font-medium transition-colors', focusRing,
        value === v ? 'bg-specter-primary-cyan/15 text-specter-primary-neon' : 'text-specter-text-subtle hover:text-specter-text-main')}>
      <Icon size={12} aria-hidden="true" />{label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Editor mode" className="inline-flex gap-0.5 rounded-ui-row border border-specter-border-divider p-0.5">
      {opt('write', 'Write', Pencil)}
      {opt('preview', 'Preview', Eye)}
    </div>
  );
}

function SectionEditor({ section, index, count, onChange, onMove, onRemove }) {
  const [mode, setMode] = useState('write');
  const idBase = `welcome-sec-${section.id}`;
  return (
    <div className="rounded-ui-md border border-specter-border-divider bg-specter-bg-panel/50 p-2.5">
      <div className="mb-2 flex items-center gap-1">
        <span className="flex-1 text-ui-xs font-semibold uppercase tracking-wide text-specter-text-subtle">Section {index + 1}</span>
        <IconButton size="sm" icon={<ArrowUp size={14} />} label={`Move section ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)} />
        <IconButton size="sm" icon={<ArrowDown size={14} />} label={`Move section ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)} />
        <IconButton size="sm" variant="danger" icon={<Trash2 size={14} />} label={`Remove section ${index + 1}`} onClick={onRemove} />
      </div>
      <FieldLabel htmlFor={`${idBase}-title`} len={section.title.length} max={WELCOME_LIMITS.sectionTitle}>Title</FieldLabel>
      <input id={`${idBase}-title`} className={cx(fieldCls, 'h-9')} value={section.title} maxLength={WELCOME_LIMITS.sectionTitle}
        placeholder="Server Rules & Information" onChange={(e) => onChange({ ...section, title: e.target.value })} />
      <div className="mt-2.5 mb-1 flex items-center justify-between gap-2">
        <label htmlFor={`${idBase}-body`} className="text-ui-sm font-medium text-specter-text-muted">Text</label>
        <span className="flex items-center gap-2">
          <Counter len={section.body.length} max={WELCOME_LIMITS.sectionBody} />
          <SegToggle value={mode} onChange={setMode} idBase={idBase} />
        </span>
      </div>
      {mode === 'write' ? (
        <textarea id={`${idBase}-body`} className={cx(fieldCls, 'min-h-[120px] resize-y py-2 font-mono text-ui-sm leading-relaxed')} rows={6}
          value={section.body} maxLength={WELCOME_LIMITS.sectionBody}
          placeholder={'1. Be respectful\n2. No spam\n\n**Links:** [Website](https://example.com)'}
          onChange={(e) => onChange({ ...section, body: e.target.value })} />
      ) : (
        <div className="min-h-[120px] rounded-ui-row border border-specter-border-divider bg-specter-bg-deep/40 px-3 py-2" aria-label="Preview">
          {section.title && <p className="mb-1.5 text-ui-base font-semibold text-specter-text-main break-words">{section.title}</p>}
          {section.body.trim()
            ? <Markdown source={section.body} />
            : <p className="text-ui-sm italic text-specter-text-subtle">Nothing to preview yet.</p>}
        </div>
      )}
    </div>
  );
}

function WelcomeEditor({ welcome, draft, setDraft, saving, error, staleNotice, onCancel, onSave, onClose }) {
  const sections = draft.sections;
  const full = sections.length >= WELCOME_LIMITS.maxSections;
  const landingSection = sectionFromLanding(welcome?.landing_description);
  const setSection = (i, s) => setDraft((d) => ({ ...d, sections: d.sections.map((x, j) => (j === i ? s : x)) }));
  const addSection = (s = { id: newSectionId(), title: '', body: '' }) => setDraft((d) => (
    d.sections.length >= WELCOME_LIMITS.maxSections ? d : { ...d, sections: [...d.sections, s] }
  ));
  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <h2 className="text-ui-lg font-semibold text-specter-text-main">Edit welcome page</h2>
          <p className="flex items-center gap-1 text-ui-xs text-specter-text-subtle">
            <Info size={12} aria-hidden="true" className="shrink-0" />
            Visible to all members. Not end-to-end encrypted.
          </p>
        </div>
        <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
      </div>
      <div className="strip-scroll min-h-0 flex-1 space-y-3 px-3 pb-3">
        {staleNotice && <Alert variant="warning">Someone else saved this page while you were editing. Saving replaces their version.</Alert>}
        <div className="px-1">
          <FieldLabel htmlFor="welcome-subtitle" len={draft.subtitle.length} max={WELCOME_LIMITS.subtitle}>Subtitle</FieldLabel>
          <input id="welcome-subtitle" className={cx(fieldCls, 'h-9')} value={draft.subtitle} maxLength={WELCOME_LIMITS.subtitle}
            placeholder="One line under “Welcome to …”" onChange={(e) => setDraft((d) => ({ ...d, subtitle: e.target.value }))} />
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="text-ui-sm font-medium text-specter-text-muted">
            Sections <span className="text-specter-text-subtle tabular-nums">({sections.length}/{WELCOME_LIMITS.maxSections})</span>
          </span>
          {landingSection && (
            <Button size="sm" variant="ghost" className="!h-7 !px-2" icon={<Copy size={13} />} disabled={full}
              title="Add a section with your public server page's description" onClick={() => addSection(sectionFromLanding(welcome.landing_description))}>
              Copy from public page
            </Button>
          )}
        </div>
        {sections.length === 0 && (
          <p className="px-1 text-ui-sm text-specter-text-subtle">No sections yet. Add one for your rules, links or info.</p>
        )}
        {sections.map((s, i) => (
          <SectionEditor key={s.id} section={s} index={i} count={sections.length}
            onChange={(next) => setSection(i, next)}
            onMove={(delta) => setDraft((d) => ({ ...d, sections: moveSection(d.sections, i, delta) }))}
            onRemove={() => setDraft((d) => ({ ...d, sections: d.sections.filter((_, j) => j !== i) }))} />
        ))}
        <Button size="sm" variant="secondary" full icon={<Plus size={14} />} disabled={full} onClick={() => addSection()}>
          {full ? `At most ${WELCOME_LIMITS.maxSections} sections` : 'Add section'}
        </Button>
        <p className="px-1 text-ui-xs text-specter-text-subtle">
          Markdown: # heading, **bold**, *italic*, 1. numbered, - bullets, [link](https://…), `code`, &gt; quote, --- line. No HTML.
        </p>
      </div>
      <div className="shrink-0 border-t border-specter-border-divider px-3 py-2.5">
        {error && <div className="mb-2"><Alert variant="error">{error}</Alert></div>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </>
  );
}

// ── Container ──────────────────────────────────────────────────────────────

/**
 * org         the active server's /orgs/me entry (name / logo / banner while loading)
 * orgIndex    its index in the server list (badge colour)
 * reloadKey   refetch when this changes (the org's welcome_updated_at, bumped by welcome_updated)
 * onSaved(updated_at)  after a successful save
 * maxHeight, onClose
 * A draft survives the strip hiding (cabinets stay mounted while hidden).
 */
export default function WelcomeCabinet({
  org, orgIndex = 0, reloadKey = null, onSaved, onClose, maxHeight = 560, api = realApi,
}) {
  const orgId = org?.id || null;
  const [welcome, setWelcome] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null); // non-null = editing
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [staleNotice, setStaleNotice] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const editingRef = useRef(false);
  editingRef.current = Boolean(draft);
  const lastSavedRef = useRef(null);

  useEffect(() => {
    if (!orgId) return undefined;
    // Our own save already has the fresh copy.
    if (reloadKey && reloadKey === lastSavedRef.current) return undefined;
    // Someone else saved mid-edit: keep the draft, say so.
    if (editingRef.current) { setStaleNotice(true); return undefined; }
    let stale = false;
    setLoading(true);
    api.getOrgWelcome(orgId).then(({ data, error }) => {
      if (stale) return;
      setLoading(false);
      if (error) { setLoadError(typeof error === 'string' ? error : 'Could not load the welcome page'); return; }
      setLoadError(null);
      setWelcome(data);
    }).catch(() => { if (!stale) { setLoading(false); setLoadError('Could not load the welcome page'); } });
    return () => { stale = true; };
  }, [orgId, reloadKey, reloadTick, api]);

  // Switching servers drops an open edit.
  useEffect(() => { setDraft(null); setSaveError(null); setStaleNotice(false); }, [orgId]);

  const startEdit = () => { setDraft(draftFrom(welcome)); setSaveError(null); setStaleNotice(false); };
  const cancelEdit = () => {
    // Fetch the other editor's version we skipped while the draft was open.
    if (staleNotice) setReloadTick((t) => t + 1);
    setDraft(null); setSaveError(null); setStaleNotice(false);
  };
  const save = async () => {
    const err = draftError(draft);
    if (err) { setSaveError(err); return; }
    setSaving(true);
    setSaveError(null);
    const { data, error } = await api.updateOrgWelcome(orgId, {
      subtitle: draft.subtitle,
      sections: draft.sections.map(({ id, title, body }) => ({ id, title, body })),
    });
    setSaving(false);
    if (error) { setSaveError(typeof error === 'string' ? error : 'Could not save'); return; }
    lastSavedRef.current = data?.updated_at || null;
    setWelcome(data);
    setDraft(null);
    setStaleNotice(false);
    onSaved?.(data?.updated_at || null);
  };

  let body;
  if (draft) {
    body = (
      <WelcomeEditor welcome={welcome} draft={draft} setDraft={setDraft} saving={saving} error={saveError}
        staleNotice={staleNotice} onCancel={cancelEdit} onSave={save} onClose={onClose} />
    );
  } else {
    body = (
      <div className="strip-scroll min-h-0 flex-1">
        <WelcomeView welcome={welcome} org={org} orgIndex={orgIndex} onEdit={startEdit} onClose={onClose} />
        {loading && !welcome && <p className="px-4 pb-3 text-ui-sm text-specter-text-subtle">Loading…</p>}
        {loadError && !welcome && <div className="px-3 pb-3"><Alert variant="error">{loadError}</Alert></div>}
      </div>
    );
  }
  return <div className="flex flex-col overflow-hidden rounded-[13px]" style={{ maxHeight }}>{body}</div>;
}
