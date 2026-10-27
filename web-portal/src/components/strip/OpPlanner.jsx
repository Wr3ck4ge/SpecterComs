// The strip's wide op planner. It opens as a large panel in the free work
// area beside/above the bar (WideOpFrame, sized by wideOpLayout), with a slim
// secondary bar directly above the main bar holding the page steps
// (Details / Groups / Roles / Ships / Comms / Review) on the left and the
// actions (Save / Launch / Next / Done / Close) together on the right. EVT2:
// a page's optional tools (presets, linked groups, add group, add frequency)
// sit in a sub-row under that main row, shown only on pages that have them.
// The Map page is gated off (PLANNER_MAP_ENABLED in plannerPages).
//
// Data operations are the full planner's: the event body comes from
// buildEventBody (via OpPanel), the plan from useOpPlan (mapEventGroups /
// buildEventGroupsPayload), presets / ships from utils/plannerHooks.
import { useEffect, useRef, useState } from 'react';
import {
  Check, ChevronLeft, ChevronRight, FolderOpen, Link2, Plus, Rocket, Save, Trash2, X,
} from 'lucide-react';
import { Button, IconButton, Alert } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { computeLinkColors, groupsFromPresetLayout, newFrequency, newGroup, nextGroupName } from '../../utils/eventGroups';
import { BarPopover, Chip, WideOpFrame } from './stripOpsUi';
import {
  inputClass, DURATIONS, groupTreeSize, OPGROW, PLANNER_MAP_ENABLED, toLocalInput, WIDE,
} from './stripOpsLayout';
import {
  CommsPage, DetailsPage, GroupsPage, MapPage, ReviewPage, RolesPage, ShipsPage,
} from './plannerPages';

const ALL_PLANNER_STEPS = [
  { id: 'details', label: 'Details' },
  { id: 'groups', label: 'Groups' },
  { id: 'roles', label: 'Roles' },
  { id: 'ships', label: 'Ships' },
  { id: 'comms', label: 'Comms' },
  { id: 'map', label: 'Map' },
  { id: 'review', label: 'Review' },
];
// EVT2: the Map step is out of scope for now; its code stays for later.
const PLANNER_STEPS = ALL_PLANNER_STEPS.filter((s) => s.id !== 'map' || PLANNER_MAP_ENABLED);

function initialForm(event, initialDate) {
  const start = event?.start_time ? toLocalInput(event.start_time) : initialDate ? `${initialDate}T08:00` : '';
  let duration = 0;
  let customEnd = '';
  if (event?.end_time) {
    const hrs = (new Date(event.end_time) - new Date(event.start_time)) / 3600000;
    if (DURATIONS.includes(hrs)) duration = hrs;
    else { duration = 'custom'; customEnd = toLocalInput(event.end_time); }
  }
  return {
    name: event?.name || '',
    startNow: !event?.id && !initialDate,
    startTime: start,
    duration,
    customEnd,
    accessMode: event?.access_mode || 'open',
    game: event?.game || 'none',
    plannerIds: (event?.planners || []).map((p) => p.user_id),
    meetup: event?.meetup_location || '',
  };
}

// The details form → what OperationPlanner's EventHeader submits.
function formToEventInput(f) {
  let endTime = '';
  if (f.duration === 'custom') endTime = f.customEnd;
  else if (f.duration > 0) {
    const start = f.startNow ? new Date() : new Date(f.startTime);
    endTime = toLocalInput(new Date(start.getTime() + f.duration * 3600000).toISOString());
  }
  return {
    name: f.name, startNow: f.startNow, startTime: f.startTime, endTime,
    accessMode: f.accessMode, game: f.game, plannerIds: f.plannerIds,
    meetupLocation: f.meetup.trim() ? f.meetup : null,
  };
}

function StepTabs({ step, onStep, created, compact }) {
  const at = PLANNER_STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="flex items-center gap-0.5 shrink-0" aria-label="Planner pages">
      {PLANNER_STEPS.map((s, i) => {
        const enabled = created || i === 0;
        const current = s.id === step;
        return (
          <li key={s.id}>
            <button
              type="button"
              disabled={!enabled}
              onClick={() => onStep(s.id)}
              aria-current={current ? 'step' : undefined}
              title={s.label}
              className={cx('inline-flex items-center gap-1.5 h-8 rounded-pill pl-1 pr-2.5 transition-colors', focusRing,
                current ? 'bg-specter-primary-cyan/15' : 'hover:bg-white/5', 'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent')}
            >
              <span className={cx('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill text-[11px] font-bold',
                i < at ? 'bg-specter-primary-cyan/25 text-specter-primary-neon'
                  : current ? 'bg-specter-primary-cyan text-specter-bg-deep' : 'bg-white/10 text-specter-text-subtle')}>
                {i < at ? <Check size={12} /> : i + 1}
              </span>
              {(!compact || current) && (
                <span className={cx('text-ui-sm', current ? 'text-specter-text-main font-semibold' : 'text-specter-text-muted')}>{s.label}</span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function PresetsPopover({ grow, offset, presets, groups, onLoad, onClose }) {
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState(null);
  const save = async () => {
    if (!name.trim()) return;
    const { error: err } = await presets.save(name, groups);
    if (err) setError(typeof err === 'string' ? err : 'Could not save');
    else { setName(''); setError(null); }
  };
  return (
    <BarPopover grow={grow} offset={offset} align="right" /* POLISH: tools sit right */ label="Group presets" onClose={onClose}>
      <div className="flex items-center mb-2">
        <h3 className="flex-1 text-ui-base font-semibold">Presets</h3>
        <IconButton size="sm" icon={<X size={14} />} label="Close presets" onClick={onClose} />
      </div>
      <p className="mb-2 text-ui-xs text-specter-text-subtle">A preset is a group skeleton (names, sizes, tree, links). Loading one replaces the current groups.</p>
      {error && <Alert variant="error">{error}</Alert>}
      {presets.presets.length === 0 ? (
        <p className="text-ui-sm text-specter-text-subtle">No presets saved yet.</p>
      ) : (
        <ul className="space-y-1">
          {presets.presets.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-2 py-1.5 rounded-ui-row bg-white/[0.03]">
              <span className="flex-1 min-w-0 truncate text-ui-sm">{p.name} <span className="text-specter-text-subtle">· {(p.layout || []).length} groups</span></span>
              {confirm === p.id ? (
                <>
                  <Button size="sm" className="!h-7 whitespace-nowrap shrink-0" onClick={() => { onLoad(p); setConfirm(null); }}>Replace groups</Button>
                  <IconButton size="sm" icon={<X size={13} />} label="Cancel" onClick={() => setConfirm(null)} />
                </>
              ) : (
                <>
                  <Button size="sm" variant="secondary" className="!h-7 whitespace-nowrap shrink-0" onClick={() => (groups.length ? setConfirm(p.id) : onLoad(p))}>Load</Button>
                  <IconButton size="sm" variant="danger" icon={<Trash2 size={13} />} label={`Delete preset ${p.name}`} onClick={() => presets.remove(p.id)} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 pt-3 border-t border-specter-border-divider flex items-center gap-2">
        <input className={inputClass} value={name} maxLength={64} placeholder="Save current groups as…" aria-label="Preset name"
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} />
        <Button className="whitespace-nowrap shrink-0" size="sm" disabled={!name.trim() || presets.saving || !groups.length} onClick={save}>Save</Button>
      </div>
    </BarPopover>
  );
}

function LinkPopover({ grow, offset, groups, selectedIdx, linkColors, onLink, onClose }) {
  const g = groups[selectedIdx];
  return (
    <BarPopover grow={grow} offset={offset} align="right" /* POLISH: tools sit right */ label="Linked group" onClose={onClose}>
      <div className="flex items-center mb-2">
        <h3 className="flex-1 min-w-0 truncate text-ui-base font-semibold">Link {g.name}</h3>
        <IconButton size="sm" icon={<X size={14} />} label="Close" onClick={onClose} />
      </div>
      <p className="mb-2 text-ui-xs text-specter-text-subtle">Linked groups share a colour in the tree, to mark groups that work together.</p>
      <div className="flex flex-wrap gap-1.5">
        <Chip selected={g.linked_index === null || g.linked_index === undefined} onClick={() => onLink(null)}>Not linked</Chip>
        {groups.map((x, i) => (i === selectedIdx ? null : (
          <Chip key={i} selected={g.linked_index === i} onClick={() => onLink(i)}>
            {linkColors[i] && <span aria-hidden="true" className="h-2 w-2 rounded-pill" style={{ background: linkColors[i] }} />}
            {x.name}
          </Chip>
        )))}
      </div>
    </BarPopover>
  );
}

/**
 * event          the op (null while creating)
 * initialDate    "YYYY-MM-DD" when created from a calendar day
 * orgId
 * plan           useOpPlan() result (empty while creating)
 * presets        useEventPresets() result
 * members        org members ([{ user_id, callsign }])
 * canLaunch, launching, editors
 * onSaveDetails(input) → Promise<{ error }>  (input for buildEventBody)
 * onLaunch(), onDelete(), onDone() (back to the op view), onClose()
 * layout         wideOpLayout() result
 * initialStep, initialSelected, initialPopover, initialMapOpen   dev preview only
 */
export default function OpPlanner({
  event, initialDate, orgId, plan, presets, members = [], user, canLaunch, launching, editors = [],
  onSaveDetails, onLaunch, onDelete, onDone, onClose, layout,
  initialStep = 'details', initialSelected = null, initialPopover = null, initialMapOpen = false,
}) {
  const created = !!event?.id;
  const [step, setStep] = useState(created && PLANNER_STEPS.some((s) => s.id === initialStep) ? initialStep : 'details');
  const [form, setForm] = useState(() => initialForm(event, initialDate));
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(() => initialSelected ?? (plan.groups.length ? 0 : null));
  const [pop, setPop] = useState(initialPopover); // 'presets' | 'link' | null
  const [mapOpen, setMapOpen] = useState(initialMapOpen); // OPGROW: the opened map sizes the panel
  // What the details form last matched on the server (to know if it's dirty).
  const [baseline, setBaseline] = useState(() => JSON.stringify(form));
  // Just created: the saved op is the new baseline for the details form.
  useEffect(() => {
    if (!event?.id) return;
    const f = initialForm(event, initialDate);
    setForm(f);
    setBaseline(JSON.stringify(f));
  }, [event?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- once per op
  // Changing page closes any bar popover (not on mount: the preview opens one).
  const stepRef = useRef(step);
  useEffect(() => {
    if (stepRef.current !== step) { stepRef.current = step; setPop(null); }
  }, [step]);
  // Keep the selection valid as groups come and go.
  useEffect(() => {
    if (selectedIdx !== null && selectedIdx >= plan.groups.length) setSelectedIdx(plan.groups.length ? 0 : null);
    else if (selectedIdx === null && plan.groups.length) setSelectedIdx(0);
  }, [plan.groups.length, selectedIdx]);

  const detailsDirty = JSON.stringify(form) !== baseline;
  const others = editors.filter((e) => e.userId !== user?.id);
  const at = PLANNER_STEPS.findIndex((s) => s.id === step);
  const valid = form.name.trim() && (form.startNow || form.startTime) && (form.duration !== 'custom' || form.customEnd);
  const linkColors = computeLinkColors(plan.groups);
  // OPGROW: the page's preferred panel width (WideOpFrame clamps it to the
  // max): compact forms stay narrow, the tree / tables / map widen toward the
  // free side. Padding: body px-5 (40) + border (2).
  const PAD = 42;
  let want;
  if (step === 'details') want = 800;
  else if (step === 'review') want = 720;
  else if (step === 'groups') {
    const tree = groupTreeSize(plan.groups, 'wide');
    want = plan.groups.length ? Math.max(380, tree.width + 34) + 16 + 300 + PAD : 640;
  } else if (step === 'roles') {
    const n = Math.min(3, Math.max(2, (plan.groups[selectedIdx ?? 0]?.roles || []).length));
    want = 220 + 16 + n * 290 + PAD;
  } else if (step === 'ships') want = 220 + 16 + 660 + PAD;
  else if (step === 'comms') want = Math.max(640, Math.min(4, plan.frequencies.length) * 272 + PAD);
  else if (step === 'map' && PLANNER_MAP_ENABLED) want = mapOpen ? Infinity : 720;
  // The secondary bar is exactly as wide as the panel (WideOpFrame), so the
  // full labelled bar (~1120px) only shows when the panel is that wide;
  // narrower pages use the compact bar (current step labelled, icon actions).
  const panelWidth = Math.min(want ?? layout.panel.width, layout.panel.width);
  const compact = layout.compact || panelWidth < 1120;
  const grow = layout.grow;
  // EVT2: tools live in the bar's sub-row; their popovers open past the main row.
  const popOffset = 10 + WIDE.bar2;

  const saveDetails = async () => {
    if (!valid) { setDetailsError('Give it a name and a start time.'); return false; }
    setDetailsSaving(true);
    setDetailsError(null);
    const { error } = await onSaveDetails(formToEventInput(form));
    setDetailsSaving(false);
    if (error) { setDetailsError(typeof error === 'string' ? error : 'Could not save'); return false; }
    setBaseline(JSON.stringify(form));
    return true;
  };

  const goTo = async (id) => {
    if (step === 'details' && created && detailsDirty && id !== 'details') {
      if (!(await saveDetails())) return;
    }
    setStep(id);
  };
  const next = async () => {
    if (step === 'details' && (!created || detailsDirty)) {
      if (!(await saveDetails())) return;
    }
    setStep(PLANNER_STEPS[Math.min(at + 1, PLANNER_STEPS.length - 1)].id);
  };
  const saveAll = async () => {
    if (step === 'details' && detailsDirty) await saveDetails();
    if (plan.dirty) await plan.save();
  };
  const finish = async () => {
    if (plan.dirty) { const res = await plan.save(); if (res?.error) return; }
    onDone();
  };
  const loadPreset = (p) => {
    plan.setGroups(groupsFromPresetLayout(p.layout));
    plan.setMsg({ type: 'ok', text: `Preset "${p.name}" loaded — add roles and save.` });
    setSelectedIdx(p.layout?.length ? 0 : null);
    setPop(null);
  };
  const addTopGroup = () => {
    const idx = plan.groups.length;
    plan.setGroups((prev) => [...prev, newGroup(prev.length ? nextGroupName(prev) : 'Command')]);
    setSelectedIdx(idx);
  };
  const setLink = (target) => {
    plan.setGroups((prev) => prev.map((g, i) => (i === selectedIdx ? { ...g, linked_index: target } : g)));
    setPop(null);
  };

  const dirty = plan.dirty || (created && detailsDirty);
  const status = others.length ? `Also editing: ${others.map((e) => e.callsign).join(', ')}`
    : plan.dirty ? 'Unsaved changes' : created && detailsDirty ? 'Details changed' : '';

  // EVT2: page tools, shown in the secondary bar's sub-row (null = no sub-row).
  const toolLabel = (text) => <span className="shrink-0 pr-1 text-ui-xs font-semibold text-specter-text-subtle">{text}</span>;
  let tools = null;
  if (step === 'groups' && created) {
    tools = (
      <div className="relative flex items-center gap-1">
        {toolLabel('Group tools')}
        <Button className="whitespace-nowrap shrink-0" size="sm" variant={pop === 'presets' ? 'secondary' : 'ghost'} icon={<FolderOpen size={14} />} aria-expanded={pop === 'presets'} title="Group presets"
          onClick={() => setPop((p) => (p === 'presets' ? null : 'presets'))}>Presets</Button>
        <Button className="whitespace-nowrap shrink-0" size="sm" variant={pop === 'link' ? 'secondary' : 'ghost'} icon={<Link2 size={14} />} aria-expanded={pop === 'link'} title="Link the selected group"
          disabled={selectedIdx === null || plan.groups.length < 2}
          onClick={() => setPop((p) => (p === 'link' ? null : 'link'))}>Link group</Button>
        <Button className="whitespace-nowrap shrink-0" size="sm" variant="ghost" icon={<Plus size={14} />} onClick={addTopGroup} aria-label="Add a top-tier group" title="Add a top-tier group">Top-tier group</Button>
        {pop === 'presets' && presets && (
          <PresetsPopover grow={grow} offset={popOffset} presets={presets} groups={plan.groups} onLoad={loadPreset} onClose={() => setPop(null)} />
        )}
        {pop === 'link' && selectedIdx !== null && plan.groups[selectedIdx] && (
          <LinkPopover grow={grow} offset={popOffset} groups={plan.groups} selectedIdx={selectedIdx} linkColors={linkColors} onLink={setLink} onClose={() => setPop(null)} />
        )}
      </div>
    );
  } else if (step === 'comms') {
    tools = (
      <div className="flex items-center gap-1">
        {toolLabel('Comms tools')}
        <Button className="whitespace-nowrap shrink-0" size="sm" variant="ghost" icon={<Plus size={14} />} aria-label="Add a frequency" title="Add a frequency" onClick={() => plan.setFrequencies((prev) => [...prev, newFrequency(prev)])}>
          Frequency
        </Button>
      </div>
    );
  }

  // EVT2: main row = step tabs on the left, every action together on the
  // right (status text just before them); page tools go to the sub-row
  // (POLISH: also anchored right, under the actions).
  // POLISH: the actions are one group pinned to the bar's right edge
  // (ml-auto, never shrinks); the tabs give way first (they clip rather than
  // push the actions off the bar when it's very narrow), and the status text
  // fills the space between them.
  const bar = (
    <>
      <div className="min-w-0 shrink overflow-hidden py-1 -my-1 pl-0.5 -ml-0.5">
        <StepTabs step={step} onStep={goTo} created={created} compact={compact} />
      </div>
      <span className="flex-1 min-w-0 truncate text-right text-ui-xs text-specter-text-subtle px-1">{compact ? '' : status}</span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5" role="group" aria-label="Planner actions">
        {at > 0 && !compact && (
          <IconButton size="sm" icon={<ChevronLeft size={15} />} label="Previous page" onClick={() => goTo(PLANNER_STEPS[at - 1].id)} />
        )}
        {created && dirty && (
          <Button className="whitespace-nowrap shrink-0" size="sm" variant="secondary" icon={<Save size={14} />} disabled={plan.saving || detailsSaving} onClick={saveAll}>
            {plan.saving || detailsSaving ? 'Saving…' : 'Save'}
          </Button>
        )}
        {created && canLaunch && (
          <Button className="whitespace-nowrap shrink-0" size="sm" variant="secondary" icon={<Rocket size={14} />} disabled={dirty || launching} onClick={onLaunch} aria-label="Launch"
            title={dirty ? 'Save the plan first' : undefined}>
            {launching ? 'Launching…' : compact ? '' : 'Launch'}
          </Button>
        )}
        {step === 'review' ? (
          <Button className="whitespace-nowrap shrink-0" size="sm" onClick={finish} disabled={plan.saving}>Done</Button>
        ) : (
          <Button className="whitespace-nowrap shrink-0" size="sm" onClick={next} disabled={detailsSaving}>
            {step === 'details' && !created ? (detailsSaving ? 'Creating…' : 'Create & plan')
              : step === 'details' && detailsDirty ? (detailsSaving ? 'Saving…' : 'Save & next') : 'Next'}
            <ChevronRight size={14} aria-hidden="true" />
          </Button>
        )}
        <span className="w-px h-6 mx-0.5 bg-specter-border shrink-0" aria-hidden="true" />
        <IconButton size="sm" icon={<X size={16} />} label={plan.dirty ? 'Save and close the planner' : 'Close the planner'} onClick={onClose} />
      </div>
    </>
  );

  const stepLabel = PLANNER_STEPS[at].label;

  return (
    <WideOpFrame layout={layout} want={want} label="Operation planner" bar={bar} barLabel="Planner pages and actions"
      subBar={tools} subLabel={`${stepLabel} tools`}>
      <header className="flex items-baseline gap-3 px-5 pt-4 pb-3 shrink-0 border-b border-specter-border-divider">
        <h2 className="min-w-0 truncate text-ui-xl font-semibold text-specter-text-main">{created ? event.name : 'New operation'}</h2>
        <span className="text-ui-sm text-specter-text-subtle shrink-0">
          {created ? `Planning · ${stepLabel}` : 'Step 1 — the basics'}
        </span>
        {compact && status && <span className="ml-auto truncate text-ui-xs text-amber-300">{status}</span>}
      </header>
      <div className="strip-scroll min-h-0 px-5 py-4 flex flex-col gap-3" style={{ '--op-body-max': `calc(var(--op-max) - ${OPGROW.headerH + OPGROW.bodyPad}px)` }}>
        {step !== 'details' && plan.msg && <div className="shrink-0"><Alert variant={plan.msg.type === 'error' ? 'error' : 'success'}>{plan.msg.text}</Alert></div>}
        {step === 'details' && detailsError && <div className="shrink-0"><Alert variant="error">{detailsError}</Alert></div>}
        <div>
          {step === 'details' && <DetailsPage form={form} setForm={setForm} members={members} />}
          {step === 'groups' && (
            <GroupsPage groups={plan.groups} setGroups={plan.setGroups} selectedIdx={selectedIdx} setSelectedIdx={setSelectedIdx} linkColors={linkColors} />
          )}
          {step === 'roles' && (
            <RolesPage groups={plan.groups} setGroups={plan.setGroups} selectedIdx={selectedIdx} setSelectedIdx={setSelectedIdx}
              members={members} frequencies={plan.frequencies} setFrequencies={plan.setFrequencies} />
          )}
          {step === 'ships' && (
            <ShipsPage game={event?.game || form.game} groups={plan.groups} setGroups={plan.setGroups} selectedIdx={selectedIdx} setSelectedIdx={setSelectedIdx} />
          )}
          {step === 'comms' && (
            <CommsPage groups={plan.groups} frequencies={plan.frequencies} setFrequencies={plan.setFrequencies} members={members} />
          )}
          {step === 'map' && PLANNER_MAP_ENABLED && (
            <MapPage orgId={orgId} eventId={event?.id} groups={plan.groups} canEdit onBack={() => setStep('groups')} opened={mapOpen} onOpen={() => setMapOpen(true)} />
          )}
          {step === 'review' && (
            <ReviewPage event={event} groups={plan.groups} frequencies={plan.frequencies} onDelete={onDelete} />
          )}
        </div>
      </div>
    </WideOpFrame>
  );
}
