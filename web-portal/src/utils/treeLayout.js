// Tidy-tree layout (Reingold–Tilford with Walker's even spacing), pure JS.
//
// Every node at the same depth sits on one row. Sibling subtrees are packed
// as tightly as their left/right contours allow at every depth, so a subtree
// only slides sideways by exactly as much as a clash at some deeper level
// needs. When a subtree is pushed by a clash with a non-adjacent sibling, the
// smaller subtrees in between are spread evenly across the extra room
// (Walker's apportion step). Parents are centred exactly between their first
// and last child. Multiple roots are laid out as children of a virtual root,
// so a forest packs like one tree.
//
// Contours are per-depth arrays, so placing a family costs O(siblings² ×
// depth) — trivially fast for the tens of nodes an operation plan holds, and
// the placements are the same as the linear-time Buchheim variant's.
//
// No React and no DOM: callers supply node sizes and render the result.

const DEFAULTS = {
  siblingGap: 16,  // min horizontal gap between siblings
  subtreeGap: 24,  // min horizontal gap between cousins (nodes of different families)
  levelGap: 48,    // vertical gap between the bottom of a row and the top of the next
  stub: 14,        // length of the vertical stub from a rail down to a child's top
};

// Required distance between the centres of sibling subtrees a and b so that
// no two same-depth nodes come closer than the gap.
function separation(a, b, opt) {
  let need = -Infinity;
  const n = Math.min(a.right.length, b.left.length);
  for (let d = 0; d < n; d++) {
    const gap = d === 0 ? opt.siblingGap : opt.subtreeGap;
    need = Math.max(need, a.right[d] - b.left[d] + gap);
  }
  return need;
}

// Positions (centre x, relative to the first sibling) for a list of laid-out
// sibling subtrees.
function placeSiblings(subs, opt) {
  const pos = [0];
  for (let i = 1; i < subs.length; i++) {
    pos[i] = pos[i - 1] + separation(subs[i - 1], subs[i], opt);
    // Clashes with non-adjacent earlier siblings push subtree i further
    // right; spread that push evenly over the subtrees in between.
    for (let j = i - 2; j >= 0; j--) {
      const push = pos[j] + separation(subs[j], subs[i], opt) - pos[i];
      if (push > 0) {
        pos[i] += push;
        for (let k = j + 1; k < i; k++) pos[k] += (push * (k - j)) / (i - j);
      }
    }
  }
  return pos;
}

// Merges child contours (offset by each child's position) into rows 1.. of
// the parent's contour arrays.
function mergeContours(left, right, subs, offsets) {
  subs.forEach((s, i) => {
    for (let d = 0; d < s.left.length; d++) {
      const l = offsets[i] + s.left[d];
      const r = offsets[i] + s.right[d];
      if (left[d + 1] === undefined || l < left[d + 1]) left[d + 1] = l;
      if (right[d + 1] === undefined || r > right[d + 1]) right[d + 1] = r;
    }
  });
}

function layoutSubtree(id, childrenOf, sizeOf, opt, seen) {
  if (seen.has(id)) throw new Error(`treeLayout: cycle at node ${id}`);
  seen.add(id);
  const { w } = sizeOf(id);
  const kids = childrenOf(id) || [];
  const subs = kids.map(k => layoutSubtree(k, childrenOf, sizeOf, opt, seen));
  const left = [-w / 2];
  const right = [w / 2];
  let offsets = [];
  if (subs.length) {
    const pos = placeSiblings(subs, opt);
    const mid = (pos[0] + pos[pos.length - 1]) / 2;
    offsets = pos.map(p => p - mid);
    mergeContours(left, right, subs, offsets);
  }
  return { id, subs, offsets, left, right };
}

/**
 * Lays out a forest.
 * @param {object} args
 * @param {Array} args.roots         root node ids, left to right
 * @param {Function} args.childrenOf id → array of child ids (left to right)
 * @param {Function} args.sizeOf     id → { w, h } of the node box in px
 * @param {object} [args.options]    overrides for DEFAULTS
 * @returns {{ nodes: Array<{id, depth, x, y, w, h, cx}>, byId: Map, width: number,
 *            height: number, paths: string[] }}
 *   x/y are the node box's top-left corner, cx its centre x. `paths` are SVG
 *   path strings for the orthogonal connectors (parent bottom → rail → child
 *   top; roots joined by a top rail when there is more than one).
 */
export function layoutTree({ roots, childrenOf, sizeOf, options }) {
  const opt = { ...DEFAULTS, ...options };
  const seen = new Set();
  const rootSubs = roots.map(r => layoutSubtree(r, childrenOf, sizeOf, opt, seen));
  const rootPos = rootSubs.length ? placeSiblings(rootSubs, opt) : [];

  // Absolute centre x and depth for every node.
  const placed = [];
  const walk = (sub, cx, depth) => {
    placed.push({ id: sub.id, cx, depth });
    sub.subs.forEach((s, i) => walk(s, cx + sub.offsets[i], depth + 1));
  };
  rootSubs.forEach((s, i) => walk(s, rootPos[i], 0));

  // Row tops from the tallest box at each depth.
  const rowH = [];
  placed.forEach(p => {
    const { h } = sizeOf(p.id);
    rowH[p.depth] = Math.max(rowH[p.depth] || 0, h);
  });
  const topPad = roots.length > 1 ? opt.stub + 2 : 0;
  const rowTop = [];
  rowH.forEach((h, d) => { rowTop[d] = d === 0 ? topPad : rowTop[d - 1] + rowH[d - 1] + opt.levelGap; });

  // Shift so the leftmost box edge is at x = 0.
  let minX = Infinity;
  let maxX = -Infinity;
  placed.forEach(p => {
    const { w } = sizeOf(p.id);
    minX = Math.min(minX, p.cx - w / 2);
    maxX = Math.max(maxX, p.cx + w / 2);
  });
  if (!placed.length) { minX = 0; maxX = 0; }

  const byId = new Map();
  const nodes = placed.map(p => {
    const { w, h } = sizeOf(p.id);
    const cx = p.cx - minX;
    const n = { id: p.id, depth: p.depth, w, h, cx, x: Math.round(cx - w / 2), y: rowTop[p.depth] };
    byId.set(p.id, n);
    return n;
  });

  // Connectors. Integer coordinates keep 2px strokes crisp.
  const X = n => Math.round(n.cx);
  const paths = [];
  const family = (parentX, parentBottom, railY, kids) => {
    const xs = kids.map(X);
    let d = parentX === null ? '' : `M${parentX} ${parentBottom}V${railY}`;
    if (kids.length > 1 || parentX === null) d += `M${Math.min(...xs)} ${railY}H${Math.max(...xs)}`;
    else if (xs[0] !== parentX) d += `H${xs[0]}`;
    kids.forEach((k, i) => { d += `M${xs[i]} ${railY}V${k.y}`; });
    paths.push(d);
  };
  if (roots.length > 1) family(null, 0, topPad - opt.stub, roots.map(r => byId.get(r)));
  nodes.forEach(n => {
    const kids = (childrenOf(n.id) || []).map(k => byId.get(k));
    if (!kids.length) return;
    family(X(n), n.y + n.h, rowTop[n.depth + 1] - opt.stub, kids);
  });

  const height = rowH.length ? rowTop[rowH.length - 1] + rowH[rowH.length - 1] : 0;
  return { nodes, byId, width: Math.ceil(maxX - minX), height, paths };
}

/**
 * Self-checks for a layout: returns a list of problems (empty = OK).
 * - no two same-depth boxes closer than `minGap`
 * - every parent's centre is the midpoint of its first and last child's centres
 */
export function checkTreeLayout(layout, childrenOf, minGap = DEFAULTS.siblingGap) {
  const problems = [];
  const rows = new Map();
  layout.nodes.forEach(n => {
    if (!rows.has(n.depth)) rows.set(n.depth, []);
    rows.get(n.depth).push(n);
  });
  rows.forEach((row, depth) => {
    const sorted = [...row].sort((a, b) => a.cx - b.cx);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const gap = (b.cx - b.w / 2) - (a.cx + a.w / 2);
      if (gap < minGap - 0.01) problems.push(`depth ${depth}: ${a.id} and ${b.id} only ${gap.toFixed(1)}px apart`);
    }
  });
  layout.nodes.forEach(n => {
    const kids = (childrenOf(n.id) || []).map(k => layout.byId.get(k));
    if (!kids.length) return;
    const mid = (kids[0].cx + kids[kids.length - 1].cx) / 2;
    if (Math.abs(mid - n.cx) > 0.01) problems.push(`${n.id} centre ${n.cx.toFixed(1)} ≠ child midpoint ${mid.toFixed(1)}`);
  });
  return problems;
}
