// Dev-only harness for the operation group tree — loaded by /tree-preview.html,
// which is not a production build input. Not imported anywhere in the app.
/* eslint-disable react-refresh/only-export-components -- entry module, not a component library */
import { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import { GroupTreeScroller, OrgChartTree } from '../components/OperationPlanner';
import { checkTreeLayout, layoutTree } from '../utils/treeLayout';

// Nested spec → flat groups array with parent_index, the shape GroupPlanner holds.
function flatten(spec) {
  const groups = [];
  const walk = (nodes, parent) => nodes.forEach(n => {
    const i = groups.length;
    groups.push({
      id: `g${i}`, name: n.name, parent_index: parent, linked_index: n.link ?? null,
      member_user_ids: n.members || [], roles: n.roles || [], ships: n.ships || [],
    });
    walk(n.children || [], i);
  });
  walk(spec, null);
  return groups;
}

const leaf = name => ({ name });
const ship = name => [{ ship_name: name, quantity: 1 }];

const CASES = [
  {
    title: 'Screenshot case — 3 roots (3 / 2 / 2 children)',
    spec: [
      { name: 'Idris M', ships: ship('Idris M'), children: [leaf('Percy 1'), leaf('Percy 2'), leaf('Gunship Alpha')] },
      { name: 'Idris P', ships: ship('Idris P'), children: [leaf('Fighter Wing Alpha'), leaf('Fighter Wing Bravo')] },
      { name: 'Ironclad Assault', ships: ship('Ironclad Assault'), children: [leaf('Boarding Team 1'), leaf('Boarding Team 2')] },
    ],
  },
  {
    title: '3 roots (3 / 0 / 2 children)',
    spec: [
      { name: 'Idris M', children: [leaf('Percy 1'), leaf('Percy 2'), leaf('Percy 3')] },
      { name: 'Idris P' },
      { name: 'Ironclad Assault', children: [leaf('Boarding 1'), leaf('Boarding 2')] },
    ],
  },
  {
    title: '4 tiers, uneven branching',
    spec: [
      {
        name: 'Fleet Command', children: [
          { name: 'Capital Wing', children: [
            { name: 'Idris Group', children: [leaf('Turret Crew A'), leaf('Turret Crew B'), leaf('Engineering')] },
            leaf('Hammerhead'),
          ] },
          { name: 'Fighter Wing', children: [leaf('Alpha Flight'), { name: 'Bravo Flight', children: [leaf('Bravo 1'), leaf('Bravo 2')] }] },
          leaf('Logistics'),
        ],
      },
      { name: 'Ground Ops', children: [leaf('Squad 1'), leaf('Squad 2')] },
    ],
  },
  {
    title: 'Asymmetric — one level-2 node with 4 children, neighbours with none',
    spec: [
      {
        name: 'Command', children: [
          leaf('Recon'),
          { name: 'Strike Lead', children: [leaf('Strike 1'), leaf('Strike 2'), leaf('Strike 3'), leaf('Strike 4')] },
          leaf('Medevac'),
          { name: 'Escort Lead', children: [leaf('Escort 1'), leaf('Escort 2')] },
        ],
      },
    ],
  },
  {
    title: '6 children wide',
    spec: [
      { name: 'Wing Lead', children: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(n => leaf(`Flight ${n}`)) },
    ],
  },
];

function buildTree(groups) {
  const roots = [];
  const childrenMap = {};
  groups.forEach((g, i) => {
    if (g.parent_index === null) roots.push(i);
    else (childrenMap[g.parent_index] ||= []).push(i);
  });
  return { roots, childrenMap };
}

// Checks the rendered DOM: no two same-depth boxes closer than the sibling gap,
// and every parent box centred between its first and last child (±1px for
// integer rounding).
function checkDom(container, groups, childrenMap) {
  const rect = {};
  container.querySelectorAll('[data-tree-node]').forEach(el => {
    rect[el.dataset.treeNode] = el.getBoundingClientRect();
  });
  const depth = i => (groups[i].parent_index === null ? 0 : depth(groups[i].parent_index) + 1);
  const problems = [];
  const rows = {};
  groups.forEach((g, i) => { (rows[depth(i)] ||= []).push(i); });
  Object.entries(rows).forEach(([d, row]) => {
    const sorted = row.filter(i => rect[i]).sort((a, b) => rect[a].left - rect[b].left);
    for (let k = 1; k < sorted.length; k++) {
      const gap = rect[sorted[k]].left - rect[sorted[k - 1]].right;
      if (gap < 15.5) problems.push(`depth ${d}: ${groups[sorted[k - 1]].name} / ${groups[sorted[k]].name} gap ${gap.toFixed(1)}`);
    }
  });
  Object.entries(childrenMap).forEach(([p, kids]) => {
    const c = r => (r.left + r.right) / 2;
    const mid = (c(rect[kids[0]]) + c(rect[kids[kids.length - 1]])) / 2;
    if (Math.abs(mid - c(rect[p])) > 1) problems.push(`${groups[p].name} off-centre by ${(c(rect[p]) - mid).toFixed(1)}`);
  });
  if (groups.some((g, i) => !rect[i])) problems.push('some nodes not rendered');
  return problems;
}

// Pure-module stress test: random forests with random box sizes.
function stressTest() {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const problems = [];
  for (let t = 0; t < 300; t++) {
    const n = 1 + Math.floor(rnd() * 40);
    const parent = [];
    for (let i = 0; i < n; i++) parent[i] = i === 0 || rnd() < 0.15 ? null : Math.floor(rnd() * i);
    const roots = [];
    const kids = {};
    parent.forEach((p, i) => (p === null ? roots.push(i) : (kids[p] ||= []).push(i)));
    const sizes = parent.map(() => ({ w: 110 + Math.floor(rnd() * 51), h: 60 + Math.floor(rnd() * 60) }));
    const childrenOf = i => kids[i] || [];
    const layout = layoutTree({ roots, childrenOf, sizeOf: i => sizes[i] });
    checkTreeLayout(layout, childrenOf).forEach(p => problems.push(`tree ${t}: ${p}`));
  }
  return problems;
}

const DRAG_PREVIEW = new URLSearchParams(window.location.search).has('drag');

function TreeCase({ title, spec, width = 720, previewDrag = false }) {
  const [groups, setGroups] = useState(() => flatten(spec));
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [dragIdx, setDragIdx] = useState(previewDrag ? 1 : null);
  const [dragOver, setDragOver] = useState(null);
  const [problems, setProblems] = useState(null);
  const ref = useRef(null);
  const { roots, childrenMap } = buildTree(groups);
  useEffect(() => {
    // After layout has settled (measure → re-layout happens before paint).
    const id = requestAnimationFrame(() => {
      const next = checkDom(ref.current, groups, childrenMap);
      setProblems(prev => (prev && prev.join('|') === next.join('|') ? prev : next));
    });
    return () => cancelAnimationFrame(id);
  });
  const noop = () => {};
  const ok = problems && problems.length === 0;
  return (
    <section style={{ marginBottom: 24 }} ref={ref}>
      <div style={{ position: 'relative', zIndex: 1, color: '#67e8f9', fontFamily: 'monospace', fontSize: 12, marginBottom: 6 }}>
        {title}{' '}
        {problems && <span style={{ color: ok ? '#4ade80' : '#ef4444' }}>[{ok ? 'PASS' : `FAIL: ${problems.join('; ')}`}]</span>}
      </div>
      {/* 720px ≈ the width the planner leaves the tree beside the node editor. */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', width }}>
        <GroupTreeScroller>
          <OrgChartTree
            roots={roots} groups={groups} childrenMap={childrenMap} linkColors={{}}
            selectedIdx={selectedIdx} onSelect={i => setSelectedIdx(s => (s === i ? null : i))}
            canEdit isLaunched={false} onAddChild={noop} onRemove={noop}
            myUserId="me" isOpen={false}
            handleJoinGroup={noop} handleLeaveGroup={noop} handleLeaveRole={noop}
            dragIdx={dragIdx} onDragStart={setDragIdx} onDragEnd={() => { setDragIdx(null); setDragOver(null); }}
            onDrop={target => {
              setGroups(gs => gs.map((g, i) => (i === dragIdx ? { ...g, parent_index: target } : g)));
              setDragIdx(null);
            }}
            dragOver={dragOver} onDragEnterZone={setDragOver} onDragLeaveZone={() => setDragOver(null)}
            justDropped={null}
          />
        </GroupTreeScroller>
      </div>
    </section>
  );
}

function Preview() {
  const [stress] = useState(stressTest);
  return (
    <div style={{ padding: 16, background: '#020617', minHeight: '100vh' }}>
      <div style={{ position: 'relative', zIndex: 1, fontFamily: 'monospace', fontSize: 12, marginBottom: 12, color: stress.length ? '#ef4444' : '#4ade80' }}>
        treeLayout stress test (300 random forests, random box sizes): {stress.length ? `FAIL — ${stress.slice(0, 5).join('; ')}` : 'PASS'}
      </div>
      {DRAG_PREVIEW && <TreeCase {...CASES[0]} title="Drag preview — dragging Percy 1 (drop zones shown)" previewDrag width={1300} />}
      {CASES.map(c => <TreeCase key={c.title} {...c} />)}
      <TreeCase {...CASES[0]} title={`${CASES[0].title} — wide frame (1300px)`} width={1300} />
      <TreeCase {...CASES[2]} title={`${CASES[2].title} — wide frame (1300px)`} width={1300} />
      <TreeCase {...CASES[3]} title={`${CASES[3].title} — wide frame (1300px)`} width={1300} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Preview />);
