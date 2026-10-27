// Group tree for the strip's op panel, laid out with the shared tidy-tree
// algorithm (utils/treeLayout) and drawn upside down: the top tier (command)
// sits at the bottom, next to the bar, and each new tier stacks above it, so
// the tree grows upward. A branch that would clash with a neighbour slides
// sideways — the layout guarantees no same-tier overlap.
//
// Two sizes: 'compact' (small nodes) and 'wide' (the wide planner / op view:
// bigger nodes with tier, slots, ship and link colour). With `onReparent`,
// nodes can be dragged onto another group to report to it, or onto the
// "top tier" strip under the tree. Dragging uses pointer events rather than
// HTML5 drag-and-drop, which the webview's own file-drop handling can swallow.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Star, Users } from 'lucide-react';
import { ShipBadge } from './stripOpsUi';
import { layoutTree } from '../../utils/treeLayout';
import { buildGroupTree, computeDepth, wouldCreateCycle } from '../../utils/eventGroups';
import { cx, focusRing } from '../ui/styles';
// OPGROW: node sizes are shared so the op panel can size itself to the tree.
import { GROUP_TREE_SIZES as SIZES, groupSeatFill as groupFill } from './stripOpsLayout';
const DRAG_THRESHOLD = 5;
const ROOT_ZONE_ROOM = 52;

/**
 * EVT2: a group's seats as dots — filled (accepted), amber (pending
 * approval), hollow (open). Groups without role slots show their members.
 */
const MAX_DOTS = 10;
function SeatDots({ g, members, total }) {
  const statuses = g.member_statuses || {};
  const pending = (g.member_user_ids || []).filter((u) => statuses[u] === 'pending').length;
  const accepted = Math.max(0, members - pending);
  const seats = Math.max(total, members);
  if (!seats) return <span aria-hidden="true" className="h-2" />;
  const shown = Math.min(seats, MAX_DOTS);
  const kinds = Array.from({ length: shown }, (_, i) => (i < accepted ? 'on' : i < accepted + pending ? 'pending' : 'open'));
  return (
    <span aria-hidden="true" className="flex items-center justify-center gap-[3px] h-2">
      {kinds.map((k, i) => (
        <span key={i} className={cx('h-[7px] w-[7px] rounded-pill',
          k === 'on' ? 'bg-specter-primary-neon' : k === 'pending' ? 'bg-amber-300' : 'border border-specter-text-subtle/70')} />
      ))}
      {seats > MAX_DOTS && <span className="ml-0.5 text-[9px] leading-none tabular-nums text-specter-text-subtle">+{seats - MAX_DOTS}</span>}
    </span>
  );
}

/**
 * EVVIEW: a group node's face (ship icon, name, tier, slots), shared by this
 * tree and the op view's pan/zoom tree (OpTreeView).
 * EVT2: wide nodes are near-square cards laid out top to bottom — name (two
 * lines), ship icon ×N, ship name, tier · slots, seat dots.
 */
export function GroupNodeBody({ g, idx, groups, wide, isCommanderGroup }) {
  const { members, total } = groupFill(g);
  const ships = g.ships || [];
  const shipCount = ships.reduce((s, x) => s + (x.quantity || 1), 0);
  if (wide) {
    const full = total && members >= total;
    return (
      <span className="flex h-full w-full flex-col items-center justify-between gap-1 px-2 pt-2.5 pb-2 text-center">
        <span className="flex min-h-[32px] max-w-full items-center justify-center gap-1">
          {isCommanderGroup && <Star size={12} className="shrink-0 text-emerald-300" aria-hidden="true" />}
          <span className="line-clamp-2 break-words text-ui-sm font-semibold leading-4 text-specter-text-main">{g.name || 'Unnamed'}</span>
        </span>
        {ships.length > 0 ? (
          <ShipBadge name={ships[0].ship_name} url={ships[0].ship_icon_url} size={56} w={120} count={shipCount} />
        ) : (
          <span aria-hidden="true" className="inline-flex h-14 w-14 items-center justify-center rounded-ui-sm border border-dashed border-specter-border text-specter-text-subtle">
            <Users size={18} />
          </span>
        )}
        <span className="flex max-w-full items-center gap-1 text-[11px] leading-[14px] text-specter-text-muted">
          {ships.length > 0 ? (
            <>
              <span className="truncate">{ships[0].ship_name}</span>
              {ships.length > 1 && <span className="shrink-0 tabular-nums">+{ships.length - 1}</span>}
            </>
          ) : <span className="truncate text-specter-text-subtle">No ships</span>}
        </span>
        <span className="max-w-full truncate text-ui-xs leading-[14px] tabular-nums">
          <span className="text-specter-text-subtle">Tier {computeDepth(idx, groups)} · </span>
          <span className={full ? 'text-specter-text-subtle' : 'text-specter-primary-neon'}>
            {total ? `${members}/${total}` : `${members}`} {total ? 'slots' : 'in group'}
          </span>
        </span>
        <SeatDots g={g} members={members} total={total} />
      </span>
    );
  }
  return (
    <>
      {/* Ship icon of the group's primary ship (wide nodes), as the
          full planner's ShipIcon; initials badge when it's missing
          or fails to load. */}
      {wide && ships.length > 0 && (
        <ShipBadge name={ships[0].ship_name} url={ships[0].ship_icon_url} size={34} count={shipCount} />
      )}
      <span className={cx('flex flex-col items-center min-w-0', wide && ships.length > 0 && 'flex-1 items-start text-left')}>
        <span className="flex items-center gap-1 max-w-full">
          {isCommanderGroup && <Star size={wide ? 12 : 10} className="shrink-0 text-emerald-300" aria-hidden="true" />}
          <span className={cx('truncate font-semibold text-specter-text-main', wide ? 'text-ui-sm' : 'text-ui-xs')}>{g.name || 'Unnamed'}</span>
        </span>
        <span className={cx('tabular-nums max-w-full truncate', wide ? 'text-ui-xs' : 'text-[10px]', total && members >= total ? 'text-specter-text-subtle' : 'text-specter-primary-neon')}>
          {wide && <span className="text-specter-text-subtle">{ships.length ? 'T' : 'Tier '}{computeDepth(idx, groups)} · </span>}
          {total ? `${members}/${total}` : `${members}`} {total ? 'slots' : 'in group'}
        </span>
        {wide && ships.length > 0 && (
          <span className="flex items-center gap-1 max-w-full text-[11px] text-specter-text-muted">
            <span className="truncate">{ships[0].ship_name}</span>
            {ships.length > 1 && <span className="shrink-0 tabular-nums">+{ships.length - 1}</span>}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * groups       planner-shape groups (utils/eventGroups)
 * selectedIdx  highlighted node
 * onSelect(i)
 * myUserId     marks the group you're in
 * maxHeight    px (or a CSS length); taller trees scroll (starting at the bottom tier). Omit
 *              with fill to take the parent's height.
 * variant      'compact' | 'wide'
 * fill         take the parent's full height
 * linkColors   { [idx]: colour } (computeLinkColors)
 * onReparent(idx, parentIdx | null)   enables drag-and-drop re-parenting
 */
export default function StripGroupTree({
  groups, selectedIdx, onSelect, myUserId, maxHeight = 220, variant = 'compact', fill = false, linkColors = {}, onReparent = null,
}) {
  const { node: NODE, options } = SIZES[variant] || SIZES.compact;
  const wide = variant === 'wide';
  const scrollRef = useRef(null);
  const canvasRef = useRef(null);
  const rootZoneRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState(null); // { idx, x, y, over: idx | 'root' | null }

  const layout = useMemo(() => {
    const { roots, childrenMap } = buildGroupTree(groups);
    return layoutTree({
      roots,
      childrenOf: (i) => childrenMap[i] || [],
      sizeOf: () => NODE,
      options,
    });
  }, [groups, NODE, options]);

  // Start (and stay, as tiers are added) scrolled to the bottom — the root
  // tier — and centred sideways.
  const depth = layout.height;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, [depth, layout.width]);

  if (!groups.length) return null;
  const { width, height } = layout;
  const flipY = (n) => height - n.y - n.h;
  const commanderGroup = groups.findIndex((g) => (g.roles || []).some((r) => r.is_commander));

  // What's under the pointer while dragging group `idx`: a valid new parent,
  // 'root' (the top-tier strip), or null.
  const hitTest = (clientX, clientY, idx) => {
    const z = rootZoneRef.current?.getBoundingClientRect();
    if (z && clientX >= z.left && clientX <= z.right && clientY >= z.top && clientY <= z.bottom) {
      return groups[idx].parent_index === null || groups[idx].parent_index === undefined ? null : 'root';
    }
    const c = canvasRef.current?.getBoundingClientRect();
    if (!c) return null;
    const px = clientX - c.left;
    const py = clientY - c.top;
    const n = layout.nodes.find((k) => px >= k.x && px <= k.x + k.w && py >= flipY(k) && py <= flipY(k) + k.h);
    if (!n || n.id === idx || groups[idx].parent_index === n.id || wouldCreateCycle(n.id, idx, groups)) return null;
    return n.id;
  };

  const dragHandlers = (idx) => (!onReparent ? {} : {
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      dragRef.current = { idx, sx: e.clientX, sy: e.clientY, active: false };
      try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* synthetic / inactive pointer */ }
    },
    onPointerMove: (e) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_THRESHOLD) return;
        d.active = true;
      }
      const c = canvasRef.current?.getBoundingClientRect();
      if (!c) return;
      setDrag({ idx: d.idx, x: e.clientX - c.left, y: e.clientY - c.top, over: hitTest(e.clientX, e.clientY, d.idx) });
    },
    onPointerUp: (e) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d?.active) return;
      suppressClickRef.current = true;
      const over = hitTest(e.clientX, e.clientY, d.idx);
      setDrag(null);
      if (over === 'root') onReparent(d.idx, null);
      else if (over !== null) onReparent(d.idx, over);
    },
    onPointerCancel: () => { dragRef.current = null; setDrag(null); },
    onKeyDown: (e) => { if (e.key === 'Escape' && dragRef.current) { dragRef.current = null; setDrag(null); } },
  });

  const scrollStyle = fill ? { height: '100%' } : { maxHeight };

  return (
    <div className={cx('relative', fill && 'h-full')}>
      <div
        ref={scrollRef}
        className={cx(
          'strip-scroll overflow-auto flex flex-col rounded-ui-md border border-specter-border-divider bg-specter-bg-deep/40',
          wide ? 'p-4' : 'p-2',
        )}
        style={{ ...scrollStyle, paddingBottom: drag ? ROOT_ZONE_ROOM + 8 : undefined }}
      >
        <div ref={canvasRef} className="relative mt-auto mx-auto shrink-0" style={{ width, height }}>
          <svg width={width} height={height} className="absolute inset-0 pointer-events-none" aria-hidden="true">
            <g transform={`translate(0 ${height}) scale(1 -1)`} fill="none" stroke="rgba(103,218,245,0.45)" strokeWidth={wide ? 2 : 1.5}>
              {layout.paths.map((d, i) => <path key={i} d={d} />)}
            </g>
          </svg>
          {layout.nodes.map((n) => {
            const g = groups[n.id];
            const { members, total } = groupFill(g);
            const selected = selectedIdx === n.id;
            const mine = myUserId && (g.member_user_ids || []).includes(myUserId);
            const link = linkColors[n.id];
            const dragging = drag?.idx === n.id;
            const dropTarget = drag && drag.over === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                  onSelect(n.id);
                }}
                {...dragHandlers(n.id)}
                aria-pressed={selected}
                aria-label={`${g.name}, tier ${n.depth + 1}, ${members}${total ? ` of ${total}` : ''} members${onReparent ? '. Drag onto another group to move it' : ''}`}
                className={cx(
                  'absolute flex rounded-ui-sm border text-center transition-colors overflow-hidden touch-none',
                  wide ? 'flex-col items-stretch' : 'items-center justify-center gap-1.5 px-1.5', // EVT2
                  focusRing,
                  onReparent && 'cursor-grab active:cursor-grabbing',
                  dropTarget ? 'bg-specter-primary-cyan/30 border-specter-primary-neon ring-2 ring-specter-primary-neon/60'
                    : selected ? 'bg-specter-primary-cyan/20 border-specter-primary-neon'
                      : mine ? 'bg-specter-state-success/10 border-specter-state-success/60 hover:bg-specter-state-success/15'
                        : 'bg-[#0b1d2e] border-specter-border hover:border-specter-border-strong',
                  dragging && 'opacity-40',
                )}
                style={{ left: n.x, top: flipY(n), width: n.w, height: n.h }}
              >
                {link && <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px]" style={{ background: link }} />}
                <GroupNodeBody g={g} idx={n.id} groups={groups} wide={wide} isCommanderGroup={commanderGroup === n.id} />
              </button>
            );
          })}
          {drag && (
            <div
              aria-hidden="true"
              className={cx('pointer-events-none absolute z-10 px-2 py-1 rounded-ui-sm border text-ui-xs font-semibold shadow-lg -translate-x-1/2 -translate-y-1/2 whitespace-nowrap',
                drag.over !== null ? 'bg-specter-primary-cyan text-specter-bg-deep border-specter-primary-neon' : 'bg-[#0d2236] text-specter-text-main border-specter-border-strong')}
              style={{ left: drag.x, top: drag.y }}
            >
              {groups[drag.idx]?.name}
              {drag.over === 'root' ? ' → top tier' : drag.over !== null ? ` → reports to ${groups[drag.over]?.name}` : ''}
            </div>
          )}
        </div>
      </div>
      {drag && (
        <div
          ref={rootZoneRef}
          className={cx('absolute left-2 right-2 bottom-2 flex items-center justify-center rounded-ui-sm border-2 border-dashed text-ui-xs font-semibold',
            drag.over === 'root' ? 'border-specter-primary-neon bg-specter-primary-cyan/15 text-specter-primary-neon' : 'border-specter-border-strong text-specter-text-subtle bg-[#0b1d2e]/90')}
          style={{ height: ROOT_ZONE_ROOM - 12 }}
        >
          Drop here to make it a top-tier group
        </div>
      )}
    </div>
  );
}
