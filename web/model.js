// Pure view-model functions shared by the E14 service layer (Node) and the browser components.
// No DOM, no I/O, no dependencies. Everything here is derived from data passed in; nothing is invented.

/** Display states, most severe first. */
export const STATES = ['failed', 'blocked', 'unavailable', 'forbidden_or_missing', 'stale', 'ok'];

export const STATE_LABELS = {
  ok: 'OK',
  stale: 'Stale',
  blocked: 'Blocked',
  failed: 'Failed',
  unavailable: 'Unavailable',
  forbidden_or_missing: 'Not found or not permitted',
};

/** Shape names used next to the text label so state never depends on colour. */
export const STATE_SHAPES = {
  ok: 'circle',
  stale: 'triangle',
  blocked: 'square',
  failed: 'cross',
  unavailable: 'ring',
  forbidden_or_missing: 'diamond',
};

export const STATE_DESCRIPTIONS = {
  ok: 'The owning engine reports no stale, blocked or failed condition.',
  stale: 'An upstream object changed after this was produced; it needs review or regeneration.',
  blocked: 'A permission, decision or dependency currently prevents use of this object.',
  failed: 'The owning engine reports that this work failed.',
  unavailable: 'The owning engine could not be reached, so the current state is unknown.',
  forbidden_or_missing: 'The object does not exist or you are not permitted to see it.',
};

const FAILED_ENGINE_STATES = new Set(['failed', 'dead', 'error', 'errored']);

export function stateLabel(state) {
  return Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state] : String(state);
}

/** Maps a kit Inspection (or anything with state/stale/blocked) to a display state. */
export function deriveState(inspection) {
  if (inspection === null || inspection === undefined) return 'forbidden_or_missing';
  if (inspection.blocked === true) return 'blocked';
  if (FAILED_ENGINE_STATES.has(String(inspection.state ?? '').toLowerCase())) return 'failed';
  if (inspection.stale === true) return 'stale';
  return 'ok';
}

const UREF = /^(E\d\d):([a-z][a-z0-9_]*):([A-Za-z0-9._~-]+)(?:@(\d+))?$/;
/** Returns { engine, kind, id, revision? } or null when the value is not a universal reference. */
export function parseRef(value) {
  const m = typeof value === 'string' ? UREF.exec(value) : null;
  if (m === null) return null;
  const out = { engine: m[1], kind: m[2], id: m[3] };
  if (m[4] !== undefined) out.revision = Number(m[4]);
  return out;
}

/** An edge always reads "downstream depends on upstream", whichever side declared it. */
export function canonicalEdge(edge) {
  return edge.relation === 'source'
    ? { upstream: edge.to, downstream: edge.from }
    : { upstream: edge.from, downstream: edge.to };
}
export function edgeKey(edge) {
  const c = canonicalEdge(edge);
  return `${c.upstream} -> ${c.downstream}`;
}

function index(graph) {
  const byRef = new Map(graph.nodes.map((n) => [n.ref, n]));
  const up = new Map(), down = new Map();
  for (const n of graph.nodes) { up.set(n.ref, []); down.set(n.ref, []); }
  const seen = new Set();
  for (const e of graph.edges) {
    const c = canonicalEdge(e), key = edgeKey(e);
    if (seen.has(key) || !byRef.has(c.upstream) || !byRef.has(c.downstream)) continue;
    seen.add(key);
    up.get(c.downstream).push(c.upstream);
    down.get(c.upstream).push(c.downstream);
  }
  for (const list of [...up.values(), ...down.values()]) list.sort();
  return { byRef, up, down };
}

export function rootOf(graph) {
  return graph.root ?? (graph.nodes[0] ? graph.nodes[0].ref : null);
}

/** Upstream (sources) or downstream (dependents) neighbours of a node, sorted by reference. */
export function neighbors(graph, ref, direction) {
  const ix = index(graph);
  return [...((direction === 'upstream' ? ix.up : ix.down).get(ref) ?? [])];
}

function nodeTitle(node) {
  if (node === undefined) return '';
  if (node.title) return node.title;
  return node.state === 'forbidden_or_missing' || node.state === 'unavailable' ? '(title not available)' : '(untitled)';
}

/** One-line plain-text description of a node: title, engine and kind, state with reasons, reference. */
export function describeNode(node) {
  const reasons = Array.isArray(node.staleReasons) && node.staleReasons.length > 0 ? ` (${node.staleReasons.join('; ')})` : '';
  return `${nodeTitle(node)} [${node.engine} ${node.kind}] - ${stateLabel(node.state)}${reasons} - ${node.ref}`;
}

export const RELATION_LABELS = { root: 'selected object', source: 'depends on (source)', dependent: 'is used by (dependent)' };

/**
 * Table equivalent of the graph: the first row is the selected object, then one row per relationship.
 * The set of `to` references equals the node set and the source/dependent rows equal the edge set.
 */
export function relationTable(graph) {
  const byRef = new Map(graph.nodes.map((n) => [n.ref, n]));
  const columns = [
    { key: 'fromTitle', label: 'Object' },
    { key: 'relationLabel', label: 'Relation' },
    { key: 'toTitle', label: 'Related object' },
    { key: 'toEngine', label: 'Engine' },
    { key: 'toKind', label: 'Kind' },
    { key: 'toStateLabel', label: 'State' },
    { key: 'toReasons', label: 'Reasons' },
    { key: 'to', label: 'Reference' },
  ];
  const row = (relation, from, to) => {
    const a = from === '' ? undefined : byRef.get(from), b = byRef.get(to);
    return {
      relation, relationLabel: RELATION_LABELS[relation], from, fromTitle: from === '' ? '' : nodeTitle(a),
      to, toTitle: nodeTitle(b), toEngine: b ? b.engine : '', toKind: b ? b.kind : '',
      toState: b ? b.state : 'unavailable', toStateLabel: stateLabel(b ? b.state : 'unavailable'),
      toReasons: b && Array.isArray(b.staleReasons) ? b.staleReasons.join('; ') : '',
    };
  };
  const rows = [];
  const root = rootOf(graph);
  if (root !== null && byRef.has(root)) rows.push(row('root', '', root));
  const seen = new Set();
  for (const e of graph.edges) {
    const key = edgeKey(e);
    if (seen.has(key) || !byRef.has(e.from) || !byRef.has(e.to)) continue;
    seen.add(key);
    rows.push(row(e.relation, e.from, e.to));
  }
  const title = root !== null && byRef.has(root) ? nodeTitle(byRef.get(root)) : 'no object';
  return { caption: `Relationships of ${title}: ${graph.nodes.length} objects, ${rows.length === 0 ? 0 : rows.length - 1} links`, columns, rows };
}

/** Table of the nodes alone (one row per object). */
export function nodeTable(graph) {
  return {
    caption: `Objects in this view: ${graph.nodes.length}`,
    columns: [
      { key: 'title', label: 'Object' }, { key: 'engine', label: 'Engine' }, { key: 'kind', label: 'Kind' },
      { key: 'stateLabel', label: 'State' }, { key: 'reasons', label: 'Reasons' }, { key: 'versionCount', label: 'Versions' },
      { key: 'permissionCount', label: 'Permissions' }, { key: 'decisionCount', label: 'Decisions' }, { key: 'ref', label: 'Reference' },
    ],
    rows: graph.nodes.map((n) => ({
      ref: n.ref, title: nodeTitle(n), engine: n.engine, kind: n.kind, state: n.state, stateLabel: stateLabel(n.state),
      reasons: Array.isArray(n.staleReasons) ? n.staleReasons.join('; ') : '',
      versionCount: n.versionCount ?? 0, permissionCount: n.permissionCount ?? 0, decisionCount: n.decisionCount ?? 0,
    })),
  };
}

/**
 * Indented text equivalent of the graph for screen readers and plain-text export.
 * Returns structured lines (level, ref, parent, relation) and the same content as one string.
 * A node that was already expanded is listed again with "(listed above)" and not expanded twice, so cycles terminate.
 */
export function textOutline(graph) {
  const ix = index(graph);
  const root = rootOf(graph);
  const lines = [];
  const push = (level, relation, ref, parent, text, repeated = false) => { lines.push({ level, relation, ref, parent, repeated, text }); };
  if (root === null || !ix.byRef.has(root)) {
    push(0, 'heading', null, null, 'No object selected.');
  } else {
    push(0, 'root', root, null, `Selected: ${describeNode(ix.byRef.get(root))}`);
    const walk = (adjacency, relation, heading, empty) => {
      const first = adjacency.get(root) ?? [];
      if (first.length === 0) { push(1, 'heading', null, null, empty); return; }
      let count = 0;
      const start = lines.length;
      push(1, 'heading', null, null, heading);
      const expanded = new Set([root]);
      const visit = (parent, level) => {
        const list = adjacency.get(parent) ?? [];
        list.forEach((ref, i) => {
          const repeated = expanded.has(ref);
          count += 1;
          push(level, relation, ref, parent, `${i + 1}. ${describeNode(ix.byRef.get(ref))}${repeated ? ' (listed above)' : ''}`, repeated);
          if (!repeated) { expanded.add(ref); visit(ref, level + 1); }
        });
      };
      visit(root, 2);
      lines[start].text = `${heading} (${count} ${count === 1 ? 'link' : 'links'}):`;
    };
    walk(ix.up, 'source', 'Sources - what this depends on', 'Sources: none recorded.');
    walk(ix.down, 'dependent', 'Dependents - what uses this', 'Dependents: none recorded.');
  }
  if (graph.truncated === true) push(0, 'heading', null, null, 'Truncated: more relationships exist beyond the depth or size limit of this view.');
  const unavailable = graph.unavailableEngines ?? [];
  if (unavailable.length > 0) push(0, 'heading', null, null, `Unavailable engines (state unknown): ${unavailable.join(', ')}.`);
  return { lines, text: lines.map((l) => `${'  '.repeat(l.level)}${l.text}`).join('\n') };
}

/**
 * Layered layout: upstream objects in columns left of the selected object, downstream to the right.
 * Returns positions in abstract units; the component scales them. Deterministic for a given graph.
 */
export function layoutLayers(graph, options = {}) {
  const width = options.nodeWidth ?? 220, height = options.nodeHeight ?? 64, gapX = options.gapX ?? 70, gapY = options.gapY ?? 22;
  const ix = index(graph);
  const root = rootOf(graph);
  const layer = new Map();
  if (root !== null && ix.byRef.has(root)) {
    layer.set(root, 0);
    const spread = (adjacency, step) => {
      let frontier = [root];
      const visited = new Set([root]);
      for (let d = 1; frontier.length > 0; d++) {
        const next = [];
        for (const ref of frontier) for (const other of adjacency.get(ref) ?? []) {
          if (visited.has(other)) continue;
          visited.add(other);
          if (!layer.has(other)) layer.set(other, step * d);
          next.push(other);
        }
        frontier = next;
      }
    };
    spread(ix.up, -1);
    spread(ix.down, 1);
  }
  for (const n of graph.nodes) if (!layer.has(n.ref)) layer.set(n.ref, 0);
  const layers = new Map();
  for (const n of graph.nodes) { const l = layer.get(n.ref); if (!layers.has(l)) layers.set(l, []); layers.get(l).push(n.ref); }
  const order = [...layers.keys()].sort((a, b) => a - b);
  const min = order.length > 0 ? order[0] : 0;
  const tallest = Math.max(1, ...[...layers.values()].map((l) => l.length));
  const fullHeight = tallest * height + (tallest - 1) * gapY;
  const nodes = [];
  for (const l of order) {
    const refs = layers.get(l).sort((a, b) => (a === root ? -1 : b === root ? 1 : a < b ? -1 : a > b ? 1 : 0));
    const colHeight = refs.length * height + (refs.length - 1) * gapY;
    refs.forEach((ref, i) => {
      nodes.push({ ref, layer: l, index: i, x: (l - min) * (width + gapX), y: (fullHeight - colHeight) / 2 + i * (height + gapY), width, height });
    });
  }
  const pos = new Map(nodes.map((n) => [n.ref, n]));
  const edges = [];
  const seen = new Set();
  for (const e of graph.edges) {
    const key = edgeKey(e), c = canonicalEdge(e);
    if (seen.has(key) || !pos.has(c.upstream) || !pos.has(c.downstream)) continue;
    seen.add(key);
    edges.push({ key, upstream: c.upstream, downstream: c.downstream });
  }
  return { width: Math.max(1, order.length) * width + Math.max(0, order.length - 1) * gapX, height: fullHeight, nodes, edges };
}

/** Next node for an arrow key: left = towards sources, right = towards dependents, up/down = within the column. */
export function moveFocus(graph, layout, ref, key) {
  const pos = new Map(layout.nodes.map((n) => [n.ref, n]));
  const here = pos.get(ref);
  if (here === undefined) return layout.nodes[0] ? layout.nodes[0].ref : null;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const column = layout.nodes.filter((n) => n.layer === here.layer).sort((a, b) => a.index - b.index);
    const next = column[here.index + (key === 'ArrowDown' ? 1 : -1)];
    return next ? next.ref : ref;
  }
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const linked = neighbors(graph, ref, key === 'ArrowLeft' ? 'upstream' : 'downstream').filter((r) => pos.has(r));
    if (linked.length === 0) return ref;
    const nearest = (list) => list.sort((a, b) => Math.abs(pos.get(a).y - here.y) - Math.abs(pos.get(b).y - here.y) || (a < b ? -1 : 1))[0];
    const wanted = here.layer + (key === 'ArrowLeft' ? -1 : 1);
    const adjacent = linked.filter((r) => pos.get(r).layer === wanted);
    return nearest(adjacent.length > 0 ? adjacent : linked);
  }
  if (key === 'Home') return rootOf(graph) ?? ref;
  return ref;
}

// ───────────────────────────── Audit timeline ─────────────────────────────

/** Total order used for merged audit records: time, then engine, then numeric record id. */
export function compareAudit(a, b) {
  const ta = Date.parse(a.at), tb = Date.parse(b.at);
  if (ta !== tb) return ta - tb;
  if (a.engine !== b.engine) return a.engine < b.engine ? -1 : 1;
  const ia = Number(a.id), ib = Number(b.id);
  if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ia - ib;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function filterAudit(records, filter = {}) {
  const text = (filter.text ?? '').trim().toLowerCase();
  return records.filter((r) => (!filter.engine || r.engine === filter.engine)
    && (!filter.actor || r.actorId === filter.actor)
    && (!filter.action || r.action === filter.action)
    && (text === '' || `${r.action} ${r.subject} ${r.actorId} ${r.requestId}`.toLowerCase().includes(text)));
}

export function distinct(records, key) {
  return [...new Set(records.map((r) => r[key]).filter((v) => typeof v === 'string' && v !== ''))].sort();
}

export const AUDIT_CSV_COLUMNS = ['at', 'engine', 'id', 'actorId', 'actorKind', 'action', 'subject', 'requestId', 'purpose'];

/** Quotes every cell and neutralises spreadsheet formula prefixes. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
export function toCsv(columns, rows) {
  return [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
/** CSV of merged audit records. The free-form `detail` payload is deliberately not exported. */
export function auditCsv(records) {
  return toCsv(AUDIT_CSV_COLUMNS, records);
}

// ───────────────────────────── Task board ─────────────────────────────

export const TASK_COLUMNS = [
  { id: 'queued', label: 'Queued', states: ['queued', 'pending', 'ready', 'planned', 'open', 'proposed'] },
  { id: 'running', label: 'Running', states: ['running', 'leased', 'in_progress', 'active', 'assigned'] },
  { id: 'review', label: 'Awaiting review', states: ['review', 'in_review', 'awaiting_review', 'needs_review', 'awaiting_approval'] },
  { id: 'paused', label: 'Paused', states: ['paused', 'waiting', 'on_hold'] },
  { id: 'blocked', label: 'Blocked', states: ['blocked'] },
  { id: 'failed', label: 'Failed', states: ['failed', 'dead', 'error', 'errored', 'uncertain'] },
  { id: 'done', label: 'Done', states: ['done', 'completed', 'succeeded', 'approved', 'closed'] },
  { id: 'cancelled', label: 'Cancelled', states: ['cancelled', 'canceled', 'rejected', 'withdrawn'] },
  { id: 'other', label: 'Other states', states: [] },
];

/** Column for a task: blocked and failed display states win, otherwise the engine's own state name decides. */
export function taskColumn(item) {
  if (item.state === 'blocked' || item.blocked === true) return 'blocked';
  if (item.state === 'failed') return 'failed';
  const raw = String(item.engineState ?? item.state ?? '').toLowerCase();
  const found = TASK_COLUMNS.find((c) => c.states.includes(raw));
  return found ? found.id : 'other';
}

/**
 * Groups items into board columns. `edges` (graph edges) yield per-item dependency indicators:
 * how many items on the board it waits on, and how many of those are not done.
 */
export function groupTasks(items, edges = []) {
  const onBoard = new Map(items.map((i) => [i.ref, i]));
  const waits = new Map(items.map((i) => [i.ref, []]));
  const seen = new Set();
  for (const e of edges) {
    const c = canonicalEdge(e), key = edgeKey(e);
    if (seen.has(key) || !onBoard.has(c.upstream) || !onBoard.has(c.downstream)) continue;
    seen.add(key);
    waits.get(c.downstream).push(c.upstream);
  }
  const columns = TASK_COLUMNS.map((c) => ({ id: c.id, label: c.label, items: [] }));
  for (const item of items) {
    const dependsOn = waits.get(item.ref).sort();
    const unfinished = dependsOn.filter((r) => taskColumn(onBoard.get(r)) !== 'done');
    columns.find((c) => c.id === taskColumn(item)).items.push({ ...item, dependsOn, unfinished });
  }
  return columns.filter((c) => c.items.length > 0 || ['queued', 'running', 'done'].includes(c.id));
}

/** Compares two table cells for sorting: numbers numerically, everything else as case-insensitive text. */
export function compareCells(a, b) {
  const na = typeof a === 'number' ? a : Number.NaN, nb = typeof b === 'number' ? b : Number.NaN;
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  const sa = a === null || a === undefined ? '' : String(a).toLowerCase(), sb = b === null || b === undefined ? '' : String(b).toLowerCase();
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
