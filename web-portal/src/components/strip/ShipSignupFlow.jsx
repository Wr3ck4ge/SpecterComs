// EVVIEW: Star Citizen sign-up for a ship-composed group, inside the op
// view's roles cabinet: 1) assign a ship from your hangar, 2) pick your role,
// 3) confirm.
//
// Server model (eventsController claimShipSlot / joinEventRole), which this
// flow follows rather than reimplements:
//  - a ship group's composition has N slots per hull; you fill one by
//    claiming it with one of YOUR hangar ships — an exact match, or an
//    "approved similar" one (same scunpacked role) — getClaimableShips lists
//    which of your ships are eligible per hull;
//  - claiming also signs you up as the group's Captain/Pilot (best effort);
//    Pilot/Captain can't be joined any other way;
//  - crew roles need some hull claimed first, then a normal role join (with a
//    seat when the role has named seats; pending when it needs approval).
// So "assign a ship, then a role" = claim the slot, then (only when you
// choose a role other than the pilot seat) join that role. Crew without a
// ship skip step 1.
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Check, Plus, Search } from 'lucide-react';
import { Alert, Badge, Button } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { PILOT_ROLE_NAMES, getRoleJoinState } from '../../utils/eventGroups';
import { SectionLabel, ShipBadge } from './stripOpsUi';
import { inputClass } from './stripOpsLayout';

const STEPS = [['ship', 'Ship'], ['role', 'Role'], ['confirm', 'Confirm']];

function Steps({ step, noShip }) {
  return (
    <ol className="flex items-center gap-1.5 text-ui-xs" aria-label="Sign-up steps">
      {STEPS.map(([id, label], i) => {
        const active = id === step;
        const idx = STEPS.findIndex(([s]) => s === step);
        const done = i < idx;
        const skipped = id === 'ship' && noShip && step !== 'ship';
        return (
          <li key={id} className="flex items-center gap-1.5" aria-current={active ? 'step' : undefined}>
            {i > 0 && <span aria-hidden="true" className="w-3 h-px bg-specter-border" />}
            <span className={cx('inline-flex items-center gap-1 h-6 px-2 rounded-pill border',
              active ? 'border-specter-primary-cyan/60 bg-specter-primary-cyan/15 text-specter-primary-neon font-semibold'
                : done ? 'border-specter-state-success/40 text-emerald-300' : 'border-specter-border text-specter-text-subtle')}>
              {done && !skipped && <Check size={11} aria-hidden="true" />}
              {i + 1} {skipped ? 'No ship' : label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Your hangar ships against the group's hulls: the hull each one may fill
// (exact first), and whether a slot of it is still free.
function rankHangar(hangarShips, entries, myUserId) {
  return (hangarShips || []).map((ship) => {
    const matches = (entries || []).flatMap((entry) => {
      const el = entry.eligible_user_ships.find((e) => e.user_ship_id === ship.id);
      if (!el) return [];
      const free = entry.slots.filter((s) => !s.user_id || s.user_id === myUserId);
      return [{ entry, exact: el.exact, freeSlot: free.find((s) => s.user_id === myUserId) || free[0] || null }];
    }).sort((a, b) => (b.exact - a.exact) || ((b.freeSlot ? 1 : 0) - (a.freeSlot ? 1 : 0)));
    return { ship, match: matches[0] || null };
  }).sort((a, b) => {
    const score = (r) => (r.match ? (r.match.freeSlot ? (r.match.exact ? 3 : 2) : 1) : 0);
    return score(b) - score(a);
  });
}

function HangarRow({ ship, match, selected, onPick }) {
  const usable = !!match?.freeSlot;
  const note = !match ? 'Not a match for this group'
    : !match.freeSlot ? `All ${match.entry.ship_name} slots are taken`
      : match.exact ? `Fills a ${match.entry.ship_name} slot` : `Similar to ${match.entry.ship_name} (approved)`;
  return (
    <li>
      <button
        type="button"
        disabled={!usable}
        aria-pressed={selected}
        onClick={onPick}
        className={cx('w-full flex items-center gap-2.5 p-2 rounded-ui-md border text-left transition-colors', focusRing,
          selected ? 'border-specter-primary-neon bg-specter-primary-cyan/15'
            : usable ? (match.exact ? 'border-specter-state-success/50 bg-specter-state-success/[0.06] hover:bg-specter-state-success/10' : 'border-specter-primary-cyan/40 hover:bg-white/5')
              : 'border-specter-border-divider opacity-50 cursor-not-allowed')}
      >
        <ShipBadge name={ship.ship_name} url={ship.ship_icon_url} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-sm font-semibold text-specter-text-main">{ship.nickname || ship.ship_name}</span>
          <span className={cx('block truncate text-ui-xs', usable ? (match.exact ? 'text-emerald-300' : 'text-specter-primary-neon') : 'text-specter-text-subtle')}>
            {ship.nickname ? `${ship.ship_name} · ` : ''}{note}
          </span>
        </span>
        {selected && <Check size={16} aria-hidden="true" className="shrink-0 text-specter-primary-neon" />}
      </button>
    </li>
  );
}

// "I own it but haven't added it": one-click add for each hull the group
// flies, plus a catalogue search for an approved-similar ship.
function QuickAdd({ group, hangar, onAdded }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const owned = new Set((hangar.ships || []).map((s) => s.ship_slug));
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return undefined; }
    let stale = false;
    const t = setTimeout(() => {
      hangar.search(q).then((r) => { if (!stale) setResults(r.slice(0, 6)); }).catch(() => { if (!stale) setResults([]); });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q, hangar]);
  const add = async (slug) => {
    setBusy(slug);
    setError(null);
    const { error: err } = await hangar.add(slug);
    setBusy(null);
    if (err) { setError(typeof err === 'string' ? err : 'Could not add that ship'); return; }
    setQ('');
    onAdded?.();
  };
  const hulls = (group.ships || []).filter((s) => !owned.has(s.ship_slug));
  return (
    <div className="space-y-2 p-2.5 rounded-ui-md border border-dashed border-specter-border bg-white/[0.02]">
      <p className="text-ui-xs text-specter-text-muted">Own one but haven&apos;t added it to your hangar?</p>
      {hulls.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {hulls.map((s) => (
            <button key={s.ship_slug} type="button" disabled={!!busy} onClick={() => add(s.ship_slug)}
              className={cx('inline-flex items-center gap-1.5 h-8 pl-1 pr-2.5 rounded-pill border border-specter-border bg-white/[0.03] text-ui-xs text-specter-text-main hover:border-specter-primary-cyan/60 disabled:opacity-50', focusRing)}>
              <ShipBadge name={s.ship_name} url={s.ship_icon_url} size={22} />
              <Plus size={12} aria-hidden="true" />{busy === s.ship_slug ? 'Adding…' : `Add ${s.ship_name}`}
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        <Search size={13} aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-specter-text-subtle" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search another ship to add…"
          aria-label="Search ships to add to your hangar" className={cx(inputClass, 'pl-8 !h-7')} />
      </div>
      {results.length > 0 && (
        <ul className="space-y-0.5" aria-label="Ships to add">
          {results.map((s) => (
            <li key={s.slug}>
              <button type="button" disabled={!!busy || owned.has(s.slug)} onClick={() => add(s.slug)}
                className={cx('w-full flex items-center gap-2 px-1.5 py-1 rounded-ui-sm text-left text-ui-sm hover:bg-white/5 disabled:opacity-50', focusRing)}>
                <ShipBadge name={s.name} url={s.icon_url} size={22} />
                <span className="flex-1 min-w-0 truncate">{s.name}</span>
                <span className="text-ui-xs text-specter-text-subtle">{owned.has(s.slug) ? 'In hangar' : busy === s.slug ? 'Adding…' : 'Add'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}

/**
 * group, plan (useOpPlan), myUserId
 * claims       useShipSlotClaims() result for this group ({ entries, reload })
 * hangar       useHangar() result
 * onDone(), onCancel()
 * initial      dev preview: { step, shipId, roleId, seat }
 */
export default function ShipSignupFlow({ group, plan, myUserId, claims, hangar, onDone, onCancel, initial = null }) {
  const [step, setStep] = useState(initial?.step || 'ship');
  const [shipId, setShipId] = useState(initial?.shipId ?? null); // null = crew without a ship
  const [roleChoice, setRoleChoice] = useState(initial?.roleId ? { roleId: initial.roleId, seat: initial.seat || null } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const ranked = useMemo(() => rankHangar(hangar.ships, claims.entries, myUserId), [hangar.ships, claims.entries, myUserId]);
  // Only a ship with a free slot counts as picked (entries load async, and a
  // reload may have taken the slot meanwhile).
  const pickedRow = ranked.find((r) => r.ship.id === shipId) || null;
  const picked = pickedRow?.match?.freeSlot ? pickedRow : null;
  const pickPending = !!shipId && !picked && (claims.entries === null || hangar.ships === null);
  const roles = group.roles || [];
  const pilotRole = roles.find((r) => r.name === 'Captain') || roles.find((r) => r.name === 'Pilot') || null;
  const pilotJs = pilotRole ? getRoleJoinState(group, pilotRole, myUserId) : null;
  const pilotFree = !!pilotJs && (pilotJs.hasSlot || pilotJs.amAcceptedInRole || pilotJs.amPendingInRole);
  const anyHull = (group.ships || []).some((s) => (s.claims || []).length > 0);

  // Crew roles you could take (open, not the pilot seats).
  const crewRoles = roles.filter((r) => r.id && r.assignment_mode === 'open' && !PILOT_ROLE_NAMES.has(r.name));
  const selectedRole = roleChoice?.roleId === 'pilot' ? pilotRole : roles.find((r) => r.id === roleChoice?.roleId) || null;
  const seatMissing = !!selectedRole && roleChoice.roleId !== 'pilot' && !roleChoice.seat
    && getRoleJoinState(group, selectedRole, myUserId).needsSeatChoice;
  // A ship into a role-less group just claims the slot.
  const canNext = (!!roleChoice && !seatMissing) || (!!picked && !pilotRole && crewRoles.length === 0);

  const pickShip = (id) => { setShipId(id); setRoleChoice(pilotRole && pilotFree ? { roleId: 'pilot', seat: null } : null); setStep('role'); };
  const crewOnly = () => { setShipId(null); setRoleChoice(null); setStep('role'); };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    if (picked) {
      const { entry, freeSlot } = picked.match;
      const res = await plan.claimShipSlot(group.id, entry.ship_slug, freeSlot.slot_index, picked.ship.id);
      if (res?.error) { setBusy(false); setError(typeof res.error === 'string' ? res.error : 'Could not claim that slot'); return; }
      claims.reload?.();
    }
    if (selectedRole && roleChoice.roleId !== 'pilot') {
      const res = await plan.joinRole(group.id, selectedRole.id, roleChoice.seat);
      if (res?.error) { setBusy(false); setError(typeof res.error === 'string' ? res.error : 'Could not join that role'); return; }
    }
    setBusy(false);
    onDone?.();
  };

  const onKeyDown = (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (step === 'confirm') setStep('role');
    else if (step === 'role') setStep('ship');
    else onCancel?.();
  };

  return (
    <div className="space-y-3" onKeyDown={onKeyDown} role="group" aria-label="Sign up with a ship">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" className="!h-7 !px-1.5" icon={<ArrowLeft size={14} />}
          onClick={() => (step === 'ship' ? onCancel?.() : setStep(step === 'confirm' ? 'role' : 'ship'))}>
          {step === 'ship' ? 'Roles' : 'Back'}
        </Button>
        <div className="flex-1" />
      </div>
      <Steps step={step} noShip={!picked} />

      {step === 'ship' && (
        <div className="space-y-2.5">
          <div>
            <SectionLabel className="mb-1">Assign a ship from your hangar</SectionLabel>
            <div className="flex flex-wrap items-center gap-1.5 text-ui-xs text-specter-text-subtle">
              <span>This group flies</span>
              {(group.ships || []).map((s) => {
                const taken = (s.claims || []).length;
                return (
                  <span key={s.ship_slug} className="inline-flex items-center gap-1 h-6 pl-0.5 pr-2 rounded-pill bg-white/[0.04] border border-specter-border text-specter-text-muted">
                    <ShipBadge name={s.ship_name} url={s.ship_icon_url} size={18} />
                    {s.ship_name} <span className="tabular-nums text-specter-text-subtle">{taken}/{s.quantity || 1}</span>
                  </span>
                );
              })}
            </div>
          </div>
          {hangar.error && <Alert variant="error">{hangar.error}</Alert>}
          {hangar.ships === null || claims.entries === null ? (
            <p className="text-ui-sm text-specter-text-subtle">Loading your hangar…</p>
          ) : ranked.length === 0 ? (
            <p className="text-ui-sm text-specter-text-subtle">Your hangar is empty.</p>
          ) : (
            <ul className="space-y-1.5" aria-label="Your hangar">
              {ranked.map(({ ship, match }) => (
                <HangarRow key={ship.id} ship={ship} match={match} selected={shipId === ship.id} onPick={() => pickShip(ship.id)} />
              ))}
            </ul>
          )}
          {hangar.ships !== null && <QuickAdd group={group} hangar={hangar} onAdded={() => claims.reload?.()} />}
          <button type="button" onClick={crewOnly}
            className={cx('w-full text-left text-ui-xs text-specter-text-muted hover:text-specter-text-main underline-offset-2 hover:underline', focusRing)}>
            No ship? Join as crew on someone else&apos;s →
          </button>
        </div>
      )}

      {step !== 'ship' && pickPending && <p className="text-ui-sm text-specter-text-subtle">Loading your hangar…</p>}
      {step !== 'ship' && !pickPending && shipId && !picked && (
        <Alert variant="warning">That ship no longer has a free slot here — pick another.</Alert>
      )}

      {step === 'role' && !pickPending && (
        <div className="space-y-2">
          <SectionLabel>Select your role{picked ? ` (bringing ${picked.ship.nickname || picked.ship.ship_name})` : ' (crew)'}</SectionLabel>
          {!picked && !anyHull && (
            <Alert variant="warning">No one has brought a ship to this group yet — crew seats open once a hull is claimed.</Alert>
          )}
          <ul className="space-y-1.5" role="radiogroup" aria-label="Role">
            {picked && pilotRole && (
              <RoleOption
                label={`${pilotRole.name} — you fly your ${picked.ship.ship_name}`}
                detail={pilotFree ? `${pilotJs.filled}/${pilotJs.max} filled${pilotRole.auto_approve === false ? ' · needs approval' : ''}` : 'Full — pick a crew role instead'}
                checked={roleChoice?.roleId === 'pilot'}
                disabled={!pilotFree}
                onPick={() => setRoleChoice({ roleId: 'pilot', seat: null })}
              />
            )}
            {crewRoles.map((r) => {
              const js = getRoleJoinState(group, r, myUserId);
              const hullReady = !!picked || anyHull;
              const disabled = !hullReady || (!js.hasSlot && !js.amAcceptedInRole);
              const checked = roleChoice?.roleId === r.id;
              return (
                <RoleOption
                  key={r.id}
                  label={r.name || 'Unnamed role'}
                  detail={`${js.filled}/${js.max} filled${r.auto_approve === false ? ' · needs approval' : ''}${!js.hasSlot ? ' · full' : ''}`}
                  checked={checked}
                  disabled={disabled}
                  onPick={() => setRoleChoice({ roleId: r.id, seat: js.needsSeatChoice ? (js.availableSeats[0] || null) : null })}
                >
                  {checked && js.needsSeatChoice && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1" role="radiogroup" aria-label={`${r.name} seat`}>
                      {(r.seat_labels || []).map((seat) => {
                        const taken = js.takenSeats.find((ts) => ts.seat_label === seat);
                        return (
                          <button key={seat} type="button" role="radio" aria-checked={roleChoice.seat === seat} disabled={!!taken}
                            onClick={() => setRoleChoice({ roleId: r.id, seat })}
                            className={cx('h-6 px-2 rounded-pill border text-ui-xs', focusRing,
                              roleChoice.seat === seat ? 'border-specter-primary-neon bg-specter-primary-cyan/20 text-specter-primary-neon'
                                : taken ? 'border-specter-border-divider text-specter-text-subtle line-through' : 'border-specter-border text-specter-text-muted hover:text-specter-text-main')}>
                            {seat}{taken ? ` · ${taken.callsign}` : ''}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </RoleOption>
              );
            })}
          </ul>
          {picked && !pilotRole && crewRoles.length === 0 && (
            <p className="text-ui-xs text-specter-text-subtle">This group has no roles — your ship is listed and you join the group.</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" disabled={!canNext} onClick={() => setStep('confirm')}>Next</Button>
          </div>
        </div>
      )}

      {step === 'confirm' && !pickPending && (
        <div className="space-y-2.5">
          <SectionLabel>Confirm</SectionLabel>
          <div className="p-2.5 rounded-ui-md border border-specter-border bg-specter-bg-deep/50 space-y-2">
            {picked ? (
              <div className="flex items-center gap-2.5">
                <ShipBadge name={picked.ship.ship_name} url={picked.ship.ship_icon_url} size={40} />
                <div className="min-w-0">
                  <div className="text-ui-sm font-semibold text-specter-text-main truncate">{picked.ship.nickname || picked.ship.ship_name}</div>
                  <div className="text-ui-xs text-specter-text-subtle">
                    {picked.match.exact ? '' : 'Approved substitute · '}{picked.match.entry.ship_name} slot {picked.match.freeSlot.slot_index + 1} of {picked.match.entry.quantity || picked.match.entry.slots.length}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-ui-sm text-specter-text-muted">Crew on a ship someone else brings</p>
            )}
            <div className="text-ui-sm text-specter-text-main">
              Role: <strong>{selectedRole ? selectedRole.name : 'Group member'}</strong>
              {roleChoice?.seat && <> · seat <strong>{roleChoice.seat}</strong></>}
            </div>
            {selectedRole?.auto_approve === false && (
              <div className="flex items-center gap-1.5"><Badge variant="warning">Needs approval</Badge><span className="text-ui-xs text-specter-text-subtle">A planner approves the sign-up.</span></div>
            )}
            {picked && roleChoice?.roleId !== 'pilot' && pilotRole && (
              <p className="text-ui-xs text-specter-text-subtle">Your ship fills the slot; you crew as {selectedRole?.name} instead of flying it.</p>
            )}
          </div>
          {error && <Alert variant="error">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setStep('role')}>Back</Button>
            <Button size="sm" disabled={busy || (!!shipId && !picked) || (!picked && roleChoice?.roleId === 'pilot')} onClick={confirm}>{busy ? 'Signing up…' : selectedRole?.auto_approve === false ? 'Request sign-up' : 'Confirm sign-up'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RoleOption({ label, detail, checked, disabled, onPick, children }) {
  return (
    <li className={cx('p-2 rounded-ui-md border transition-colors',
      checked ? 'border-specter-primary-neon bg-specter-primary-cyan/10' : 'border-specter-border-divider bg-specter-bg-deep/40',
      disabled && 'opacity-50')}>
      <button type="button" role="radio" aria-checked={checked} disabled={disabled} onClick={onPick}
        className={cx('w-full flex items-center gap-2 text-left disabled:cursor-not-allowed', focusRing)}>
        <span aria-hidden="true" className={cx('h-3.5 w-3.5 shrink-0 rounded-pill border-2', checked ? 'border-specter-primary-neon bg-specter-primary-neon/40' : 'border-specter-border-strong')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui-sm text-specter-text-main">{label}</span>
          <span className="block text-ui-xs text-specter-text-subtle">{detail}</span>
        </span>
      </button>
      {children}
    </li>
  );
}
