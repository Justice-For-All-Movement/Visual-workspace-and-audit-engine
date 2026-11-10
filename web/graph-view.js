// GraphView: SVG node-link diagram of a linked view with a built-in switch to the equivalent table and text outline.
// Layout is computed here (layered: sources left, dependents right). State is always shown as text plus a shape.
import { component, clear, h, s, truncate, uid } from './dom.js';
import { RelationTable, TextOutline } from './tables.js';
import { STATE_SHAPES, describeNode, layoutLayers, moveFocus, neighbors, rootOf, stateLabel } from './model.js';

const VIEWS = [{ id: 'graph', label: 'Graph' }, { id: 'table', label: 'Table' }, { id: 'text', label: 'Text outline' }];
const PAD = 24;

function shape(state) {
  const kind = STATE_SHAPES[state] ?? 'ring';
  const g = s('g', { class: `ws-node__icon ws-icon--${state}`, transform: 'translate(12,37)', 'aria-hidden': 'true' });
  if (kind === 'circle') g.append(s('circle', { cx: 6, cy: 6, r: 5 }));
  else if (kind === 'triangle') g.append(s('path', { d: 'M6 1 L11.5 11 L0.5 11 Z' }));
  else if (kind === 'square') g.append(s('rect', { x: 1, y: 1, width: 10, height: 10 }));
  else if (kind === 'cross') g.append(s('path', { d: 'M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5', fill: 'none', 'stroke-width': 2.5 }));
  else if (kind === 'diamond') g.append(s('path', { d: 'M6 0.5 L11.5 6 L6 11.5 L0.5 6 Z', fill: 'none', 'stroke-width': 1.5 }));
  else g.append(s('circle', { cx: 6, cy: 6, r: 4.5, fill: 'none', 'stroke-width': 1.5, 'stroke-dasharray': '2.5 2' }));
  return g;
}

/**
 * GraphView(container, { graph, selected?, view?, label?, onSelect?, onNavigate?, onViewChange? })
 * graph: { root, nodes, edges, truncated, unavailableEngines } exactly as returned by inspectLinked.
 * Keyboard in the graph: arrow keys move along edges (left = sources, right = dependents, up/down = same column),
 * Home returns to the selected root, Enter or Space selects, + / - zoom, 0 resets the zoom.
 */
export function GraphView(container, props) {
  const id = uid('ws-graph');
  let view = props.view ?? 'graph';
  let focusRef = null;
  let zoom = { k: 1, x: 0, y: 0, fitted: false };
  let sub = null;
  let drag = null;
  let svgEl = null, viewport = null;
  let lastGraph = null;

  const applyZoom = () => { if (viewport) viewport.setAttribute('transform', `translate(${zoom.x},${zoom.y}) scale(${zoom.k})`); };
  const size = () => { const r = svgEl ? svgEl.getBoundingClientRect() : { width: 0, height: 0 }; return { w: r.width || 800, h: r.height || 420 }; };
  function fit(layout, centre) {
    const { w, h: hh } = size();
    // Never shrink below a legible size: a view that does not fit is centred on the root and panned by focus or drag.
    const k = Math.max(0.85, Math.min(1, (w - PAD * 2) / Math.max(1, layout.width), (hh - PAD * 2) / Math.max(1, layout.height)));
    const fitsX = layout.width * k <= w - PAD * 2, fitsY = layout.height * k <= hh - PAD * 2;
    const c = centre ?? { x: 0, y: 0, width: layout.width, height: layout.height };
    zoom = { k, x: fitsX ? (w - layout.width * k) / 2 : w / 2 - (c.x + c.width / 2) * k, y: fitsY ? (hh - layout.height * k) / 2 : hh / 2 - (c.y + c.height / 2) * k, fitted: true };
    applyZoom();
  }
  function reveal(node) {
    const { w, h: hh } = size();
    const left = node.x * zoom.k + zoom.x, top = node.y * zoom.k + zoom.y, right = left + node.width * zoom.k, bottom = top + node.height * zoom.k;
    if (left < PAD) zoom.x += PAD - left; else if (right > w - PAD) zoom.x -= right - (w - PAD);
    if (top < PAD) zoom.y += PAD - top; else if (bottom > hh - PAD) zoom.y -= bottom - (hh - PAD);
    applyZoom();
  }
  function scale(factor) {
    const { w, h: hh } = size();
    const k = Math.max(0.3, Math.min(2.5, zoom.k * factor));
    zoom.x = w / 2 - ((w / 2 - zoom.x) / zoom.k) * k; zoom.y = hh / 2 - ((hh / 2 - zoom.y) / zoom.k) * k; zoom.k = k;
    applyZoom();
  }

  const api = component(container, props, (root, p, self) => {
    const graph = p.graph ?? { nodes: [], edges: [] };
    if (p.view !== undefined && p.onViewChange) view = p.view;
    if (sub) { sub.destroy(); sub = null; }
    const hadFocus = root.contains(document.activeElement) ? document.activeElement : null;
    const refocusView = hadFocus && hadFocus.hasAttribute('data-view') ? hadFocus.getAttribute('data-view') : null;
    const refocusNode = hadFocus && hadFocus.hasAttribute('data-ref') && view === 'graph';
    if (graph !== lastGraph) { zoom.fitted = false; lastGraph = graph; }
    const rootRef = rootOf(graph);
    const byRef = new Map(graph.nodes.map((n) => [n.ref, n]));
    if (focusRef === null || !byRef.has(focusRef)) focusRef = p.selected && byRef.has(p.selected) ? p.selected : rootRef;

    const setView = (next) => { view = next; if (p.onViewChange) p.onViewChange(next); self.update({}); };
    const toolbar = h('div', { class: 'ws-graph__toolbar' },
      h('div', { class: 'ws-segmented', role: 'group', 'aria-label': 'Show relationships as' }, VIEWS.map((v) => h('button', { type: 'button', class: 'ws-button', 'data-view': v.id, 'aria-pressed': String(view === v.id), onClick: () => setView(v.id) }, v.label))),
      view === 'graph' ? h('div', { class: 'ws-segmented', role: 'group', 'aria-label': 'Zoom' },
        h('button', { type: 'button', class: 'ws-button', 'data-zoom': 'out', 'aria-label': 'Zoom out', onClick: () => scale(1 / 1.25) }, '−'),
        h('button', { type: 'button', class: 'ws-button', 'data-zoom': 'in', 'aria-label': 'Zoom in', onClick: () => scale(1.25) }, '+'),
        h('button', { type: 'button', class: 'ws-button', 'data-zoom': 'reset', onClick: () => { zoom.fitted = false; self.update({}); } }, 'Fit')) : null);
    const notes = [];
    notes.push(h('p', { class: 'ws-graph__summary', id: `${id}-summary`, text: `${graph.nodes.length} ${graph.nodes.length === 1 ? 'object' : 'objects'}, ${new Set(graph.edges.map((e) => (e.relation === 'source' ? `${e.to}>${e.from}` : `${e.from}>${e.to}`))).size} links.` }));
    if (graph.truncated) notes.push(h('p', { class: 'ws-notice', dataset: { notice: 'truncated' }, text: 'Truncated: more relationships exist beyond the depth or size limit of this view.' }));
    if ((graph.unavailableEngines ?? []).length > 0) notes.push(h('p', { class: 'ws-notice ws-notice--warn', dataset: { notice: 'unavailable' }, text: `Unavailable engines (state unknown): ${graph.unavailableEngines.join(', ')}.` }));

    const body = h('div', { class: 'ws-graph__body' });
    clear(root).append(h('section', { class: 'ws-graph', 'aria-label': p.label ?? 'Linked view' }, toolbar, ...notes, body));

    if (graph.nodes.length === 0) { body.append(h('p', { class: 'ws-state__message', text: 'No object selected.' })); return; }
    if (view === 'table') { sub = RelationTable(body, { graph, table: p.table, onNavigate: p.onNavigate ?? p.onSelect }); }
    else if (view === 'text') { sub = TextOutline(body, { graph, outline: p.outline, onNavigate: p.onNavigate ?? p.onSelect }); }
    else {
      const layout = layoutLayers(graph, { nodeWidth: 200, gapX: 48 });
      const pos = new Map(layout.nodes.map((n) => [n.ref, n]));
      viewport = s('g', {});
      const marker = `${id}-arrow`;
      svgEl = s('svg', { class: 'ws-graph__svg', role: 'group', 'aria-label': `${p.label ?? 'Relationship graph'}. Arrow keys move between linked objects, Enter selects.`, 'aria-describedby': `${id}-summary ${id}-help` },
        s('defs', {}, s('marker', { id: marker, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0 0 L10 5 L0 10 z', class: 'ws-edge__head' }))), viewport);
      for (const e of layout.edges) {
        const a = pos.get(e.upstream), b = pos.get(e.downstream);
        const forward = b.x > a.x;
        const x1 = forward ? a.x + a.width : a.x + a.width / 2, y1 = forward ? a.y + a.height / 2 : (b.y > a.y ? a.y + a.height : a.y);
        const x2 = forward ? b.x : b.x + b.width / 2, y2 = forward ? b.y + b.height / 2 : (b.y > a.y ? b.y : b.y + b.height);
        const mid = forward ? (x1 + x2) / 2 : x1;
        const d = forward ? `M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` : `M${x1} ${y1} C${x1 + 60} ${(y1 + y2) / 2}, ${x2 + 60} ${(y1 + y2) / 2}, ${x2} ${y2}`;
        viewport.append(s('path', { class: 'ws-edge', d, 'marker-end': `url(#${marker})`, dataset: { edge: e.key }, 'aria-hidden': 'true' }));
      }
      const focusNode = (ref) => {
        focusRef = ref;
        for (const g of viewport.querySelectorAll('[data-ref]')) g.setAttribute('tabindex', g.getAttribute('data-ref') === ref ? '0' : '-1');
        const el = [...viewport.querySelectorAll('[data-ref]')].find((g) => g.getAttribute('data-ref') === ref);
        if (el) { el.focus({ preventScroll: true }); reveal(pos.get(ref)); }
      };
      for (const placed of layout.nodes) {
        const node = byRef.get(placed.ref);
        const ups = neighbors(graph, node.ref, 'upstream').length, downs = neighbors(graph, node.ref, 'downstream').length;
        const selected = p.selected === node.ref;
        const label = `${describeNode(node)}. ${ups} ${ups === 1 ? 'source' : 'sources'}, ${downs} ${downs === 1 ? 'dependent' : 'dependents'}.${node.ref === rootRef ? ' Root of this view.' : ''}${selected ? ' Selected.' : ''}`;
        const g = s('g', { class: `ws-node ws-node--${node.state}${selected ? ' ws-node--selected' : ''}${node.ref === rootRef ? ' ws-node--root' : ''}`, role: 'button', tabindex: node.ref === focusRef ? '0' : '-1', 'aria-label': label, 'aria-pressed': String(selected),
          transform: `translate(${placed.x},${placed.y})`, dataset: { ref: node.ref, state: node.state } },
          s('title', {}, describeNode(node)),
          s('rect', { class: 'ws-node__box', width: placed.width, height: placed.height, rx: 6 }),
          s('text', { class: 'ws-node__kind', x: 12, y: 16 }, `${node.engine} · ${node.kind}`),
          s('text', { class: 'ws-node__title', x: 12, y: 32 }, truncate(node.title || (node.state === 'ok' ? '(untitled)' : '(title not available)'), 26)),
          shape(node.state),
          s('text', { class: 'ws-node__state', x: 30, y: 47 }, truncate(stateLabel(node.state), 30)));
        g.addEventListener('click', () => { focusNode(node.ref); if (p.onSelect) p.onSelect(node.ref); });
        g.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (p.onSelect) p.onSelect(node.ref); return; }
          if (event.key === '+' || event.key === '=') { event.preventDefault(); scale(1.25); return; }
          if (event.key === '-') { event.preventDefault(); scale(1 / 1.25); return; }
          if (event.key === '0') { event.preventDefault(); fit(layout, pos.get(node.ref)); return; }
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
          event.preventDefault();
          const next = moveFocus(graph, layout, node.ref, event.key);
          if (next && next !== node.ref) focusNode(next);
        });
        g.addEventListener('focus', () => { focusRef = node.ref; });
        viewport.append(g);
      }
      svgEl.addEventListener('pointerdown', (event) => { if (event.target.closest && event.target.closest('[data-ref]')) return; drag = { x: event.clientX - zoom.x, y: event.clientY - zoom.y }; svgEl.classList.add('ws-graph__svg--dragging'); });
      svgEl.addEventListener('pointermove', (event) => { if (!drag) return; zoom.x = event.clientX - drag.x; zoom.y = event.clientY - drag.y; applyZoom(); });
      const stop = () => { drag = null; svgEl.classList.remove('ws-graph__svg--dragging'); };
      svgEl.addEventListener('pointerup', stop); svgEl.addEventListener('pointerleave', stop);
      svgEl.addEventListener('wheel', (event) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); scale(event.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });
      body.append(svgEl, h('p', { class: 'ws-graph__help', id: `${id}-help`, text: 'Keyboard: arrow keys follow links (left to sources, right to dependents), Home returns to the root, Enter selects, plus and minus zoom. The Table and Text outline views show the same relationships.' }));
      if (zoom.fitted) applyZoom(); else fit(layout, pos.get(focusRef) ?? pos.get(rootRef));
      if (refocusNode) focusNode(focusRef);
    }
    if (refocusView) { const b = root.querySelector(`[data-view="${view}"]`); if (b) b.focus(); }
  }, () => { if (sub) sub.destroy(); });
  return api;
}
