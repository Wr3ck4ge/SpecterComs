// Read-only op view for the strip's op panel (anyone who can see the op).
//
// EVVIEW: tree-first. The panel holds only the group tree (OpTreeView), sized
// to the tree's natural size (clamped to the panel max; past that the tree
// pans / zooms inside). The secondary bar keeps the title, Details, Edit plan
// / Launch where permitted, and Close. Details open as a drawer beside the
// panel (WideOpFrame's drawer, OpDetails). Selecting a group zooms to it and
// opens its roles in a cabinet inside the tree view (OpRolesCabinet) — the
// same join decisions as OperationPlanner's view-only panel
// (getRoleJoinState) and the plan's actions (useOpPlan); planners also get
// pending-approval actions there.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info, Pencil, Rocket, X } from 'lucide-react';
import { Alert, Button, IconButton } from '../ui';
import { cx, focusRing } from '../ui/styles';
import { fmtEventTime } from '../../utils/format';
import { computeLinkColors, getMyPlacement } from '../../utils/eventGroups';
import OpTreeView from './OpTreeView';
import OpRolesCabinet from './OpRolesCabinet';
import OpDetails from './OpDetails';
import { WideOpFrame } from './stripOpsUi';
import { EVVIEW, OPGROW, groupTreeSize, opViewWant, prefersReducedMotion, relTime } from './stripOpsLayout';

/**
 * event, user, plan (useOpPlan), canEdit, canLaunch, launching
 * onLaunch(), onEdit(), onClose(), editors ([{ userId, callsign }])
 * layout        wideOpLayout(kind 'view') result
 * orgId         for the post-launch channel tree
 * Dev preview only: channels (channel tree rows), hangar (useHangar-shaped),
 *   initialSelected (group index), initialDetails, initialFlow
 */
export default function OpView({
  event, user, plan, canEdit, canLaunch, launching, onLaunch, onEdit, onClose, editors = [], layout, orgId,
  channels, hangar = null, initialSelected = null, initialDetails = false, initialFlow = null,
}) {
  const now = new Date();
  const groups = plan.groups;
  const myUserId = user?.id;
  const placement = getMyPlacement(groups, plan.myAssignment, myUserId);
  const isOpen = (event.access_mode || 'open') === 'open';
  const launched = !!event.launched;
  const reduced = prefersReducedMotion();

  // Selection by group id so a plan reload keeps it.
  const [selectedId, setSelectedId] = useState(() => (initialSelected !== null ? (groups[initialSelected]?.id ?? `idx:${initialSelected}`) : null));
  const selIdx = selectedId === null ? -1 : groups.findIndex((g, i) => (g.id ?? `idx:${i}`) === selectedId);
  const selectedIdx = selIdx >= 0 ? selIdx : null;
  useEffect(() => { if (selectedId !== null && selIdx < 0 && groups.length) setSelectedId(null); }, [selectedId, selIdx, groups.length]);
  const onSelect = useCallback((idx) => {
    setSelectedId(idx === null ? null : (groups[idx]?.id ?? `idx:${idx}`));
  }, [groups]);

  const [detailsOpen, setDetailsOpen] = useState(initialDetails);
  const needsResponse = placement.groupName && placement.status === 'pending' && !isOpen;

  // Panel size: the tree's natural size, bigger while a cabinet is open;
  // the same clamp WideOpFrame applies, so the tree's viewport is exact.
  const tree = useMemo(() => groupTreeSize(groups, 'wide'), [groups]);
  const hasTree = groups.length > 0;
  const wantInner = opViewWant(tree, selectedIdx !== null);
  const maxW = layout.panel.width;
  const panelW = Math.round(Math.max(Math.min(OPGROW.minW, maxW), Math.min(wantInner.w + 2, maxW)));
  // A tree wider than the panel is fitted smaller — size the height to that
  // scale too, so a wide, shallow tree doesn't leave an empty band.
  const fitK = Math.max(EVVIEW.minFitK, Math.min(1, (panelW - 2 - 2 * EVVIEW.padX) / Math.max(1, tree.width)));
  const scaledH = Math.max(EVVIEW.minH, Math.ceil(tree.height * fitK) + EVVIEW.padTop + EVVIEW.padBottom);
  const wantH = selectedIdx !== null ? Math.max(scaledH, EVVIEW.selMinH) : scaledH;
  const vp = useMemo(() => ({ w: panelW - 2, h: Math.max(EVVIEW.minH, Math.min(wantH, layout.panel.maxHeight - 2)) }),
    [panelW, wantH, layout.panel.maxHeight]);
  const linkColors = useMemo(() => computeLinkColors(groups), [groups]);

  const msg = plan.msg ? (
    <Alert variant={plan.msg.type === 'error' ? 'error' : 'success'}>
      <span className="flex items-start gap-2">
        <span className="flex-1">{plan.msg.text}</span>
        {plan.setMsg && <button type="button" className={cx('text-ui-xs underline', focusRing)} onClick={() => plan.setMsg(null)}>Dismiss</button>}
      </span>
    </Alert>
  ) : null;
  // A ship-seat confirmation for a group whose cabinet isn't open.
  const strayConfirm = plan.shipConfirm && (selectedIdx === null || groups[selectedIdx]?.id !== plan.shipConfirm.groupId) ? (
    <div className="p-2.5 rounded-ui-md border border-specter-state-warning/40 bg-[#1d1a10] space-y-2">
      <p className="text-ui-sm text-specter-text-main">Bring your <strong>{plan.shipConfirm.shipName}</strong>? Joining with it also reserves its locked seats.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => plan.confirmShipJoin(true)}>Join with ship</Button>
        <Button size="sm" variant="secondary" onClick={() => plan.confirmShipJoin(false)}>Join without</Button>
        <Button size="sm" variant="ghost" onClick={plan.cancelShipJoin}>Cancel</Button>
      </div>
    </div>
  ) : null;
  const overlay = selectedIdx === null && (msg || strayConfirm) ? <div className="space-y-2">{msg}{strayConfirm}</div> : strayConfirm;

  return (
    <WideOpFrame
      layout={layout}
      want={hasTree ? panelW : 460}
      floating={hasTree /* POLISH: the tree floats over the desktop; empty / loading states stay a solid panel */}
      label={`Operation ${event.name}`}
      barLabel="Operation"
      drawer={{
        open: detailsOpen,
        width: EVVIEW.drawerW,
        label: `${event.name} details`,
        content: (
          <OpDetails event={event} user={user} plan={plan} placement={placement} editors={editors} orgId={orgId}
            channels={channels} onClose={() => setDetailsOpen(false)} />
        ),
      }}
      bar={(
        // OPGROW: the op's title and actions live in the secondary bar.
        <>
          {/* POLISH: the title gives way (clips) before the actions move; the
              actions are one group pinned to the right edge. */}
          <div className="min-w-0 flex-1 overflow-hidden pl-2 flex items-baseline gap-2">
            <h2 className="min-w-0 truncate text-ui-base font-semibold text-specter-text-main">{event.name}</h2>
            <span className="min-w-0 truncate text-ui-xs text-specter-text-subtle">{fmtEventTime(event.start_time)} · {relTime(event.start_time, now)}</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5" role="group" aria-label="Operation actions">
            <span className="relative shrink-0">
              <Button className="whitespace-nowrap" size="sm" variant={detailsOpen ? 'primary' : 'secondary'} icon={<Info size={14} />}
                aria-expanded={detailsOpen} onClick={() => setDetailsOpen((o) => !o)}>
                Details
              </Button>
              {needsResponse && !detailsOpen && (
                <span aria-label="Your response is needed" role="img" className="pointer-events-none absolute -top-1 -right-1 h-3 w-3 rounded-pill bg-specter-state-warning border-2 border-[#0b1d2e]" />
              )}
            </span>
            {canEdit && !launched && (
              <Button className="whitespace-nowrap shrink-0" size="sm" variant="secondary" icon={<Pencil size={14} />} onClick={onEdit}>Edit plan</Button>
            )}
            {canLaunch && (
              <Button className="whitespace-nowrap shrink-0" size="sm" icon={<Rocket size={14} />} disabled={launching} onClick={onLaunch}>
                {launching ? 'Launching…' : 'Launch'}
              </Button>
            )}
            <span className="w-px h-6 mx-0.5 bg-specter-border shrink-0" aria-hidden="true" />
            <IconButton size="sm" icon={<X size={16} />} label="Close operation" onClick={onClose} />
          </div>
        </>
      )}
    >
      {!hasTree ? (
        <div className="px-4 py-4 space-y-3">
          {msg}
          <p className="text-ui-sm text-specter-text-subtle">{plan.loading ? 'Loading the plan…' : 'No groups planned yet.'}</p>
          {!plan.loading && !detailsOpen && <Button size="sm" variant="secondary" icon={<Info size={14} />} onClick={() => setDetailsOpen(true)}>Show details</Button>}
        </div>
      ) : (
        <OpTreeView
          groups={groups}
          myUserId={myUserId}
          linkColors={linkColors}
          vp={vp}
          reduced={reduced}
          selectedIdx={selectedIdx}
          onSelect={onSelect}
          overlay={overlay}
          renderCabinet={(idx, { side, style, headingRef, onClose: closeCab }) => (
            <OpRolesCabinet
              key={`${groups[idx].id ?? idx}:${side}`}
              ref={headingRef}
              group={groups[idx]}
              groupIdx={idx}
              groups={groups}
              event={event}
              plan={plan}
              myUserId={myUserId}
              canEdit={canEdit}
              side={side}
              style={style}
              onClose={closeCab}
              hangar={hangar}
              initialFlow={idx === initialSelected ? initialFlow : null}
            />
          )}
        />
      )}
    </WideOpFrame>
  );
}
