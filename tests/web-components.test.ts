// jsdom tests for the component library's rendering logic and the shared pure view model.
// Layout, focus movement in a real browser, axe and reflow are covered by tests/browser (npm run test:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Graph, GraphNode } from '../web/model.js';

const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="host"></div></body></html>', { pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const ws = await import('../web/index.js');
const m = ws.model;
const host = (): HTMLElement => { const el = dom.window.document.createElement('div'); dom.window.document.body.append(el); return el as unknown as HTMLElement; };
const key = (el: Element, k: string): void => { el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };
const click = (el: Element | null): void => { assert.ok(el, 'element to click exists'); (el as unknown as { click(): void }).click(); };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const node = (ref: string, title: string, state: GraphNode['state'] = 'ok', extra: Partial<GraphNode> = {}): GraphNode => ({ ref, engine: ref.slice(0, 3), kind: ref.split(':')[1]!, title, state, engineState: 'active', stale: state === 'stale', blocked: state === 'blocked', staleReasons: [], versionCount: 1, permissionCount: 0, decisionCount: 0, depth: 0, ...extra });
const graph: Graph = {
  root: 'E08:finding:f1', truncated: true, unavailableEngines: ['E06'],
  nodes: [node('E08:finding:f1', 'Finding'), node('E07:claim:c1', 'Claim <b>bold</b>', 'stale', { staleReasons: ['source corrected'] }), node('E06:derivative:d1', '', 'unavailable'), node('E09:scene:s1', 'Scene', 'blocked'), node('E05:evidence:e1', 'Scan'), node('E00:task:t1', 'Task', 'failed', { engineState: 'failed' })],
  edges: [{ from: 'E08:finding:f1', to: 'E07:claim:c1', relation: 'source' }, { from: 'E08:finding:f1', to: 'E06:derivative:d1', relation: 'source' }, { from: 'E07:claim:c1', to: 'E05:evidence:e1', relation: 'source' },
    { from: 'E08:finding:f1', to: 'E09:scene:s1', relation: 'dependent' }, { from: 'E09:scene:s1', to: 'E00:task:t1', relation: 'dependent' }, { from: 'E09:scene:s1', to: 'E08:finding:f1', relation: 'source' }],
};
const edges = (g: Graph): string[] => [...new Set(g.edges.map(m.edgeKey))].sort();

test('view model: states, table, outline and layout are derived consistently from one graph', () => {
  assert.equal(m.deriveState({ state: 'active', blocked: true, stale: true }), 'blocked');
  assert.equal(m.deriveState({ state: 'dead' }), 'failed');
  assert.equal(m.deriveState({ state: 'active', stale: true }), 'stale');
  assert.equal(m.deriveState(null), 'forbidden_or_missing');
  assert.deepEqual(m.parseRef('E05:evidence_version:a-1@3'), { engine: 'E05', kind: 'evidence_version', id: 'a-1', revision: 3 });
  assert.equal(m.parseRef('javascript:alert(1)'), null);
  assert.equal(edges(graph).length, 5, 'the same relationship declared from both ends is one edge');

  const table = m.relationTable(graph);
  assert.equal(table.rows.length, 6);
  assert.deepEqual(table.rows.filter((r) => r.relation !== 'root').map((r) => m.edgeKey({ from: r.from as string, to: r.to as string, relation: r.relation as 'source' })).sort(), edges(graph));
  assert.deepEqual([...new Set(table.rows.map((r) => r.to))].sort(), graph.nodes.map((n) => n.ref).sort());
  assert.match(table.caption, /6 objects, 5 links/);
  const outline = m.textOutline(graph);
  const lines = outline.lines.filter((l) => l.parent !== null);
  assert.deepEqual([...new Set(lines.map((l) => m.edgeKey({ from: l.parent!, to: l.ref!, relation: l.relation as 'source' })))].sort(), edges(graph));
  assert.match(outline.text, /Truncated: more relationships exist/);
  assert.match(outline.text, /Unavailable engines \(state unknown\): E06\./);
  assert.match(outline.text, /Claim <b>bold<\/b> \[E07 claim\] - Stale \(source corrected\)/);
  assert.equal(m.textOutline({ nodes: [], edges: [] }).text, 'No object selected.');

  const layout = m.layoutLayers(graph);
  const layer = Object.fromEntries(layout.nodes.map((n) => [n.ref, n.layer]));
  assert.deepEqual(layer, { 'E08:finding:f1': 0, 'E07:claim:c1': -1, 'E06:derivative:d1': -1, 'E05:evidence:e1': -2, 'E09:scene:s1': 1, 'E00:task:t1': 2 });
  assert.equal(layout.edges.length, 5);
  assert.deepEqual(m.layoutLayers(graph), layout, 'layout is deterministic');
  assert.ok(layout.nodes.every((a) => layout.nodes.every((b) => a === b || a.x !== b.x || Math.abs(a.y - b.y) >= a.height)), 'nodes never overlap');
  assert.equal(m.moveFocus(graph, layout, 'E08:finding:f1', 'ArrowRight'), 'E09:scene:s1');
  assert.equal(m.moveFocus(graph, layout, 'E09:scene:s1', 'ArrowLeft'), 'E08:finding:f1');
  assert.equal(m.moveFocus(graph, layout, 'E07:claim:c1', 'ArrowLeft'), 'E05:evidence:e1');
  assert.equal(m.moveFocus(graph, layout, 'E05:evidence:e1', 'ArrowLeft'), 'E05:evidence:e1', 'no edge, no move');
  assert.equal(m.moveFocus(graph, layout, 'E06:derivative:d1', 'ArrowDown'), 'E07:claim:c1');
  assert.equal(m.moveFocus(graph, layout, 'E00:task:t1', 'Home'), 'E08:finding:f1');
});

test('view model: audit filters, CSV escaping, task grouping', () => {
  const rec = (i: number, over = {}): { engine: string; id: string; at: string; actorId: string; actorKind: string; action: string; subject: string; requestId: string; purpose: string } => ({ engine: 'E05', id: String(i), at: `2026-01-01T00:00:0${i}.000Z`, actorId: 'ana', actorKind: 'human', action: 'thing.saved', subject: 'E05:evidence:e1', requestId: `r${i}`, purpose: 'test', ...over });
  const records = [rec(3), rec(1, { engine: 'E07', actorId: 'bea' }), rec(2, { action: '=HYPERLINK("http://example.org")', subject: 'say "hi"' })];
  assert.deepEqual([...records].sort(m.compareAudit).map((r) => r.id), ['1', '2', '3']);
  assert.deepEqual(m.filterAudit(records, { engine: 'E05', actor: 'ana' }).map((r) => r.id), ['3', '2']);
  assert.deepEqual(m.filterAudit(records, { text: 'BEA' }).map((r) => r.id), ['1']);
  assert.deepEqual(m.distinct(records, 'actorId'), ['ana', 'bea']);
  const csv = m.auditCsv(records).split('\r\n');
  assert.equal(csv[0], '"at","engine","id","actorId","actorKind","action","subject","requestId","purpose"');
  assert.match(csv[3]!, /"'=HYPERLINK\(""http:\/\/example.org""\)","say ""hi"""/, 'formula prefixes are neutralised and quotes doubled');
  const columns = m.groupTasks([{ ref: 'a', title: 'A', state: 'ok', engineState: 'done' }, { ref: 'b', title: 'B', state: 'ok', engineState: 'queued' }, { ref: 'c', title: 'C', state: 'failed', engineState: 'dead' }, { ref: 'd', title: 'D', state: 'blocked', engineState: 'running' }, { ref: 'e', title: 'E', state: 'ok', engineState: 'odd' }],
    [{ from: 'b', to: 'a', relation: 'source' }, { from: 'c', to: 'b', relation: 'dependent' }, { from: 'b', to: 'c', relation: 'source' }]);
  assert.deepEqual(columns.map((c) => [c.id, c.items.map((i) => i.ref)]), [['queued', ['b']], ['running', []], ['blocked', ['d']], ['failed', ['c']], ['done', ['a']], ['other', ['e']]]);
  assert.deepEqual([columns[0]!.items[0]!.dependsOn, columns[0]!.items[0]!.unfinished], [['a', 'c'], ['c']]);
});

test('GraphView: nodes carry text state and accessible names; view toggle renders the same relationships; content is never parsed as HTML', () => {
  const el = host();
  const selected: string[] = [], navigated: string[] = [];
  const view = ws.GraphView(el, { graph, selected: 'E08:finding:f1', onSelect: (r) => selected.push(r), onNavigate: (r) => navigated.push(r) });
  const nodes = [...el.querySelectorAll('[data-ref]')];
  assert.equal(nodes.length, 6);
  assert.equal(el.querySelectorAll('path[data-edge]').length, 5);
  assert.equal(el.querySelectorAll('[data-ref][tabindex="0"]').length, 1);
  const claim = nodes.find((n) => n.getAttribute('data-ref') === 'E07:claim:c1')!;
  assert.equal(claim.getAttribute('role'), 'button');
  assert.match(claim.getAttribute('aria-label')!, /Claim <b>bold<\/b> \[E07 claim\] - Stale \(source corrected\) - E07:claim:c1\. 1 source, 1 dependent\./);
  assert.match(claim.textContent!, /Stale/);
  assert.equal(el.querySelector('b'), null, 'titles are text, not markup');
  for (const n of nodes) assert.ok(n.querySelector('.ws-node__state')!.textContent!.length > 0 && n.querySelector('.ws-node__icon') !== null);
  assert.match(el.querySelector('[data-notice="truncated"]')!.textContent!, /Truncated/);
  assert.match(el.querySelector('[data-notice="unavailable"]')!.textContent!, /E06/);
  key(claim, 'Enter'); key(claim, ' ');
  assert.deepEqual(selected, ['E07:claim:c1', 'E07:claim:c1']);
  key(el.querySelector('[data-ref="E08:finding:f1"]')!, 'ArrowRight');
  assert.equal(el.querySelector('[data-ref][tabindex="0"]')!.getAttribute('data-ref'), 'E09:scene:s1');
  view.update({ selected: 'E09:scene:s1' });
  assert.equal(el.querySelector('[data-ref="E09:scene:s1"]')!.getAttribute('aria-pressed'), 'true');

  click(el.querySelector('[data-view="table"]'));
  assert.equal(el.querySelector('[data-view="table"]')!.getAttribute('aria-pressed'), 'true');
  assert.equal(el.querySelector('svg.ws-graph__svg'), null);
  assert.equal(el.querySelectorAll('tbody tr').length, 6);
  assert.equal(el.querySelectorAll('thead th[scope="col"]').length, 8);
  assert.equal(el.querySelectorAll('tbody th[scope="row"]').length, 6);
  assert.ok(el.querySelector('caption')!.textContent!.includes('6 objects, 5 links'));
  click(el.querySelector('tbody button[data-ref="E05:evidence:e1"]'));
  assert.deepEqual(navigated, ['E05:evidence:e1']);
  click(el.querySelector('[data-view="text"]'));
  assert.equal(el.querySelector('.ws-outline__plain pre')!.textContent, m.textOutline(graph).text);
  assert.equal(el.querySelectorAll('.ws-outline li[data-relation="source"], .ws-outline li[data-relation="dependent"]').length, m.textOutline(graph).lines.filter((l) => l.parent !== null).length);
  view.update({ graph: { nodes: [], edges: [] } });
  assert.match(el.textContent!, /No object selected\./);
  view.destroy();
  assert.equal(el.childNodes.length, 0);
});

test('InspectorPanel: ARIA tablist, counts, reference links, and explicit non-data states', () => {
  const el = host();
  const went: string[] = [];
  const object = { ref: 'E09:scene:s1@2', engine: 'E09', engineName: 'Editorial', kind: 'scene', title: 'Scene one', state: 'blocked' as const, engineState: 'draft', stale: true, blocked: true, staleReasons: ['permission withdrawn'],
    badges: [{ state: 'blocked' as const, label: 'Blocked', description: '' }, { state: 'stale' as const, label: 'Stale', description: '' }],
    sources: [{ ref: 'E08:finding:f1', engine: 'E08', kind: 'finding', id: 'f1', revision: null }], dependents: [], versions: [{ revision: 1, at: '2026-01-01T00:00:00.000Z', actorId: 'ana' }, { revision: 2, at: '2026-01-02T00:00:00.000Z', actorId: 'bea', summary: 'Reworded' }],
    permissions: [{ decision: 'deny', permission: 'E11:permission:p1' }], decisions: [], history: [{ at: '2026-01-02T00:00:00.000Z', actorId: 'bea', action: 'scene.revised', detail: { from: 'E09:scene:s1@1' } }], data: { words: 120 }, generatedAt: '2026-01-03T00:00:00.000Z',
    annotations: [{ id: 'a', kind: 'correction_request', body: 'Fix the date', status: 'open', authorId: 'ana', createdAt: '2026-01-02T00:00:00.000Z' }] };
  const panel = ws.InspectorPanel(el, { object, onNavigate: (r) => went.push(r) });
  const tabs = [...el.querySelectorAll('[role="tablist"] [role="tab"]')];
  assert.deepEqual(tabs.map((t) => t.textContent), ['Summary', 'Sources (1)', 'Dependents (0)', 'Versions (2)', 'Permissions (1)', 'Decisions (0)', 'History (1)', 'Raw']);
  assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['true', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
  assert.deepEqual(tabs.map((t) => t.getAttribute('tabindex')), ['0', '-1', '-1', '-1', '-1', '-1', '-1', '-1']);
  const panelEl = (): Element => el.querySelector('[role="tabpanel"]')!;
  assert.equal(panelEl().getAttribute('aria-labelledby'), tabs[0]!.id);
  assert.match(panelEl().textContent!, /Blocked\(permission withdrawn\)Stale\(permission withdrawn\)/);
  assert.match(panelEl().textContent!, /correction request · open — Fix the date/);
  key(tabs[0]!, 'ArrowRight');
  assert.equal(el.querySelector('[role="tab"][aria-selected="true"]')!.getAttribute('data-tab'), 'sources');
  click(panelEl().querySelector('button[data-ref="E08:finding:f1"]'));
  key(el.querySelector('[role="tab"][aria-selected="true"]')!, 'End');
  assert.match(panelEl().querySelector('pre')!.textContent!, /"words": 120/);
  key(el.querySelector('[role="tab"][aria-selected="true"]')!, 'ArrowRight');
  assert.equal(el.querySelector('[role="tab"][aria-selected="true"]')!.getAttribute('data-tab'), 'summary', 'wraps');
  click(el.querySelector('[data-tab="permissions"]'));
  click(panelEl().querySelector('button[data-ref="E11:permission:p1"]'));
  click(el.querySelector('[data-tab="history"]'));
  click(panelEl().querySelector('button[data-ref="E09:scene:s1@1"]'));
  assert.deepEqual(went, ['E08:finding:f1', 'E11:permission:p1', 'E09:scene:s1@1'], 'every reference is a navigation control');
  click(el.querySelector('[data-tab="decisions"]'));
  assert.match(panelEl().textContent!, /No decisions recorded/);
  click(el.querySelector('[data-tab="versions"]'));
  assert.deepEqual([...panelEl().querySelectorAll('tbody th')].map((t) => t.textContent), ['2', '1'], 'newest version first');

  panel.update({ object: null, state: 'loading' });
  assert.equal(el.querySelector('[data-panel-state]')!.getAttribute('data-panel-state'), 'loading');
  assert.equal(el.querySelector('[role="status"]')!.textContent, 'Loading…');
  panel.update({ state: 'denied' });
  assert.match(el.textContent!, /Not found or not permitted/);
  let retried = 0;
  panel.update({ state: 'disconnected', error: { message: 'timeout', engines: ['E09'] }, onRetry: () => { retried += 1; } });
  assert.match(el.textContent!, /Disconnected.*Unavailable: E09\. Current state is unknown/);
  click(el.querySelector('button'));
  assert.equal(retried, 1);
  panel.update({ state: 'error', error: { code: 'rate_limited', message: 'Slow down', requestId: 'r-1' } });
  assert.match(el.querySelector('[role="alert"]')!.textContent!, /Slow down.*Code: rate_limited · Request: r-1/);
  panel.update({ state: 'empty' });
  assert.match(el.textContent!, /Nothing selected/);
});

test('ControlBar: plain actions send at once, dangerous ones only after confirmation; outcome text is what the host returned', async () => {
  const el = host();
  const calls: unknown[][] = [];
  let answer: () => Promise<unknown> = async () => ({ outcome: 'succeeded', result: { state: 'paused' } });
  const controls = [
    { id: 'task.pause', label: 'Pause', capability: 'orchestration:write', dangerous: false, input: { type: 'object', properties: {} }, source: 'E00', allowed: true },
    { id: 'task.cancel', label: 'Cancel', capability: 'orchestration:write', dangerous: true, input: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 300 }, notify: { type: 'boolean' }, mode: { type: 'string', enum: ['soft', 'hard'] }, delay: { type: 'integer' } } }, source: 'E00', allowed: true },
    { id: 'task.reassign', label: 'Reassign', capability: 'orchestration:admin', dangerous: false, input: {}, source: 'E00', allowed: false, deniedReason: 'Requires orchestration:admin' },
  ];
  ws.ControlBar(el, { ref: 'E00:task:t1', controls, onInvoke: (ref, id, input, options) => { calls.push([ref, id, input, options]); return answer(); } });
  const button = (id: string): Element => el.querySelector(`[data-control="${id}"]`)!;
  assert.equal(el.querySelector('[data-outcome]')!.textContent, '');
  click(button('task.reassign'));
  assert.equal(calls.length, 0, 'a control the caller may not use does nothing');
  assert.equal(button('task.reassign').getAttribute('aria-disabled'), 'true');
  assert.match(el.querySelector(`#${button('task.reassign').getAttribute('aria-describedby')}`)!.textContent!, /Reassign: not available to you\. Requires orchestration:admin/);

  click(button('task.pause'));
  assert.match(button('task.pause').textContent!, /sending…/);
  assert.equal(el.querySelector('[data-outcome]')!.textContent, 'Sent; waiting for the engine to answer.');
  click(button('task.pause'));
  assert.equal(calls.length, 1, 'no double send while waiting');
  await tick();
  assert.deepEqual(calls, [['E00:task:t1', 'task.pause', {}, { confirm: false }]]);
  assert.equal(el.querySelector('[data-outcome="ok"]')!.textContent, 'Pause: succeeded. New state: paused.');

  click(button('task.cancel'));
  const dialog = el.querySelector('[role="dialog"]')!;
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(calls.length, 1);
  assert.ok(dialog.contains(dom.window.document.activeElement));
  key(dialog, 'Escape');
  assert.equal(el.querySelector('[role="dialog"]'), null);
  assert.equal(dom.window.document.activeElement, button('task.cancel'));
  click(button('task.cancel'));
  click(el.querySelector('[data-dialog="confirm"]'));
  assert.match(el.querySelector('[data-problem]')!.textContent!, /Please fill in: reason/);
  assert.equal(calls.length, 1);
  (el.querySelector('[name="reason"]') as unknown as HTMLTextAreaElement).value = 'Duplicate';
  (el.querySelector('[name="notify"]') as unknown as HTMLInputElement).checked = true;
  (el.querySelector('[name="delay"]') as unknown as HTMLInputElement).value = '5';
  answer = async () => { throw Object.assign(new Error('Task in state paused cannot cancel'), { code: 'invalid_state' }); };
  click(el.querySelector('[data-dialog="confirm"]'));
  await tick();
  assert.deepEqual(calls[1], ['E00:task:t1', 'task.cancel', { reason: 'Duplicate', notify: true, delay: 5 }, { confirm: true }]);
  const outcome = el.querySelector('[data-outcome="error"]')!;
  assert.equal(outcome.textContent, 'Cancel did not complete (invalid_state): Task in state paused cannot cancel');
  assert.equal(outcome.getAttribute('role'), 'alert');
  answer = async () => ({ outcome: 'uncertain' });
  click(button('task.pause')); await tick();
  assert.equal(el.querySelector('[data-outcome="error"]')!.textContent, 'Pause: uncertain.', 'an uncertain outcome is never shown as success');
});

test('TaskBoard, SearchResults, AuditTimeline, DataTable and badges render only what they are given', () => {
  const board = host();
  const picked: string[] = [];
  ws.TaskBoard(board, { items: [{ ref: 'E00:task:a', title: 'Draft', state: 'ok', engineState: 'running' }, { ref: 'E00:task:b', title: 'Review', state: 'ok', engineState: 'queued' }, { ref: 'E00:task:c', title: 'Render', state: 'failed', engineState: 'failed' }],
    edges: [{ from: 'E00:task:b', to: 'E00:task:a', relation: 'source' }], selected: 'E00:task:b', onSelect: (r) => picked.push(r),
    controlsByRef: { 'E00:task:a': [{ id: 'task.pause', label: 'Pause', capability: 'x:write', dangerous: false, input: {}, allowed: true }] }, onInvoke: async () => ({}) });
  assert.deepEqual([...board.querySelectorAll('[data-column]')].map((c) => `${c.getAttribute('data-column')}:${c.querySelector('h3')!.textContent}`), ['queued:Queued (1)', 'running:Running (1)', 'failed:Failed (1)', 'done:Done (0)']);
  assert.match(board.querySelector('[data-ref="E00:task:b"] [data-deps]')!.textContent!, /Waits on 1 \(1 not done\): Draft \[not done\]\./);
  assert.match(board.querySelector('[data-ref="E00:task:c"]')!.textContent!, /Failed.*Engine state: failed.*No dependencies on this board\./);
  assert.equal(board.querySelectorAll('[data-control]').length, 1);
  assert.equal(board.querySelector('[data-ref="E00:task:b"] button')!.getAttribute('aria-current'), 'true');
  click(board.querySelector('[data-ref="E00:task:c"] button'));
  assert.deepEqual(picked, ['E00:task:c']);

  const search = host();
  const s = ws.SearchResults(search, { result: null });
  assert.match(search.textContent!, /No search yet/);
  s.update({ result: { q: 'ledger', total: 1, groups: [{ engine: 'E05', name: 'Evidence', status: 'ok', hits: [{ ref: 'E05:evidence:e1@1', kind: 'evidence', title: 'Ledger scan', snippet: 'page 3', state: 'active' }] }, { engine: 'E06', name: 'Processing', status: 'unavailable', reason: 'timeout', hits: [] }, { engine: 'E07', name: 'Knowledge', status: 'forbidden', hits: [] }] }, onNavigate: (r) => picked.push(r) });
  assert.deepEqual([...search.querySelectorAll('h3')].map((x) => x.textContent), ['Evidence (E05) — 1 result', 'Processing (E06) — unavailable (timeout)', 'Knowledge (E07) — not permitted for your role']);
  click(search.querySelector('button[data-ref]'));
  assert.equal(picked.at(-1), 'E05:evidence:e1@1');

  const timeline = host();
  const records = Array.from({ length: 300 }, (_, i) => ({ engine: i % 2 ? 'E05' : 'E07', id: String(i), at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), actorId: 'ana', actorKind: 'human', action: 'thing.saved', subject: `E05:evidence:e${i}`, requestId: `r${i}`, purpose: 'test' }));
  const filters: unknown[] = [];
  const t = ws.AuditTimeline(timeline, { records, engines: [{ engine: 'E05', status: 'ok', count: 150, chain: 'broken' }], truncated: true, onFilterChange: (f) => filters.push(f) });
  assert.equal(timeline.querySelector('[role="table"]')!.getAttribute('aria-rowcount'), '301');
  assert.ok(timeline.querySelectorAll('[role="row"][data-index]').length < 40, 'rows are virtualised');
  assert.equal(timeline.querySelector('[role="row"][data-index="0"]')!.getAttribute('aria-rowindex'), '2');
  assert.match(timeline.textContent!, /Showing 300 of 300 loaded records; more exist on the server\./);
  assert.match(timeline.textContent!, /HASH CHAIN BROKEN/);
  t.update({ filter: { engine: 'E05' } });
  assert.match(timeline.textContent!, /Showing 150 of 300/);
  t.update({ records: [], filter: {} });
  assert.match(timeline.textContent!, /No audit records were returned\./);

  const table = host();
  const sorted: unknown[] = [];
  ws.DataTable(table, { caption: 'Costs', columns: [{ key: 'name', label: 'Name' }, { key: 'amount', label: 'Amount', numeric: true }], rows: [{ name: 'b', amount: 10 }, { name: 'a', amount: 9 }, { name: 'c', amount: 100 }], onSort: (x) => sorted.push(x) });
  assert.equal(table.querySelector('caption')!.textContent, 'Costs');
  click(table.querySelector('[data-sort-key="amount"]'));
  assert.deepEqual([...table.querySelectorAll('tbody th')].map((x) => x.textContent), ['a', 'b', 'c'], 'numbers sort numerically');
  assert.equal(table.querySelector('th[aria-sort="ascending"]')!.textContent!.startsWith('Amount'), true);
  click(table.querySelector('[data-sort-key="amount"]'));
  assert.deepEqual([...table.querySelectorAll('tbody th')].map((x) => x.textContent), ['c', 'b', 'a']);
  assert.deepEqual(sorted, [{ key: 'amount', dir: 'asc' }, { key: 'amount', dir: 'desc' }]);

  for (const state of m.STATES) {
    const b = ws.badge(state, { reasons: ['because'] });
    assert.equal(b.getAttribute('data-state'), state);
    assert.equal(b.querySelector('.ws-badge__label')!.textContent, m.STATE_LABELS[state]);
    assert.ok(b.querySelector('svg[aria-hidden="true"]'), 'the icon is decorative; the label carries the state');
  }
  assert.equal(new Set(Object.values(m.STATE_SHAPES)).size, m.STATES.length, 'every state has its own shape');
});
