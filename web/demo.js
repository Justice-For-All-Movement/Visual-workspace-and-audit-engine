// Demonstration host: wires the components to recorded service responses. A real host fetches instead.
import * as ws from './index.js';
import fixtures from './fixtures.js';

const strip = (ref) => String(ref).replace(/@\d+$/, '');
const $ = (id) => document.getElementById(id);
const announce = (text) => { $('announce').textContent = text; };
const loadState = (value) => (value === undefined ? { state: 'error', error: { code: 'not_recorded', message: 'This demonstration holds no recorded response for that object.' } }
  : value.error === undefined ? { state: 'ready' } : value.error.code === 'not_found' ? { state: 'denied' } : value.error.code === 'unavailable' ? { state: 'disconnected', error: value.error } : { state: 'error', error: value.error });

let rootRef = strip(fixtures.start);
let selected = rootRef;

ws.DataTable($('overview'), { caption: `Engine health as reported at ${fixtures.overview.generatedAt}`, rowHeader: 'name', columns: [
  { key: 'name', label: 'Engine' }, { key: 'engine', label: 'Id' }, { key: 'status', label: 'Status', render: (r) => ws.badge(r.status === 'ok' ? 'ok' : r.status === 'unavailable' ? 'unavailable' : 'failed', { label: r.status === 'ok' ? 'OK' : r.status === 'unavailable' ? `Unavailable${r.reason ? ` (${r.reason})` : ''}` : 'Degraded' }) },
  { key: 'reported', label: 'Reported counts', sortable: false }, { key: 'version', label: 'Version' }],
  rows: fixtures.overview.engines.map((e) => ({ ...e, reported: Object.entries(e.counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none reported' })) });

const search = ws.SearchResults($('search'), { result: null, onNavigate: (ref) => navigate(ref) });
$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const q = $('q').value.trim().toLowerCase();
  if (q === '') { search.update({ result: null, state: 'empty' }); return; }
  const result = fixtures.search[q];
  if (result) search.update({ result, state: 'ready' });
  else search.update({ result: null, state: 'error', error: { code: 'not_recorded', message: `This demonstration only holds recorded results for: ${Object.keys(fixtures.search).join(', ')}.` } });
});

const graphHost = $('graph');
let graph = null;
function showGraph() {
  const linked = fixtures.linked[rootRef];
  const state = loadState(linked);
  if (graph) { graph.destroy(); graph = null; }
  if (state.state !== 'ready') {
    if (state.state === 'denied') graph = ws.PermissionDeniedState(graphHost, {});
    else if (state.state === 'disconnected') graph = ws.DisconnectedState(graphHost, { reason: state.error.message });
    else graph = ws.ErrorState(graphHost, { message: state.error.message, code: state.error.code });
    return;
  }
  const match = linked.nodes.find((n) => strip(n.ref) === selected);
  graph = ws.GraphView(graphHost, { graph: linked, table: linked.table, outline: linked.outline, selected: match ? match.ref : linked.root, label: 'Sources and dependents', onSelect: (ref) => inspect(ref), onNavigate: (ref) => navigate(ref) });
}
const inspector = ws.InspectorPanel($('inspector'), { object: null, onNavigate: (ref) => navigate(ref), headingLevel: 3 });
const controls = ws.ControlBar($('controls'), { ref: selected, controls: [], onInvoke: invoke });

function invoke(ref, controlId) {
  const recorded = (fixtures.invocations[strip(ref)] ?? {})[controlId];
  return new Promise((resolve, reject) => {
    if (recorded === undefined) reject({ code: 'not_recorded', message: 'This demonstration has no recorded outcome for this action on this object.' });
    else if (recorded.error) reject(recorded.error);
    else resolve(recorded);
  });
}
function inspect(ref) {
  selected = strip(ref);
  const object = fixtures.objects[selected];
  const state = loadState(object);
  inspector.update({ object: state.state === 'ready' ? object : null, state: state.state, error: state.error });
  const listed = fixtures.controls[selected];
  controls.update({ ref: selected, controls: listed && !listed.error ? listed.controls : [] });
  if (graph && graph.update && fixtures.linked[rootRef] && !fixtures.linked[rootRef].error) {
    const match = fixtures.linked[rootRef].nodes.find((n) => strip(n.ref) === selected);
    if (match) graph.update({ selected: match.ref });
  }
  board.update({ selected: fixtures.tasks.items.find((i) => strip(i.ref) === selected)?.ref });
  announce(state.state === 'ready' ? `Inspecting ${object.title}` : `Could not inspect ${selected}`);
}
function navigate(ref) { rootRef = strip(ref); selected = rootRef; showGraph(); inspect(ref); }
$('recentre').addEventListener('click', () => navigate(selected));

const controlsByRef = Object.fromEntries(fixtures.tasks.items.map((i) => [i.ref, (fixtures.controls[strip(i.ref)] ?? {}).controls ?? []]).map(([ref, list]) => [ref, list.filter((c) => c.source !== 'E14')]));
const board = ws.TaskBoard($('board'), { items: fixtures.tasks.items, edges: fixtures.tasks.edges, controlsByRef, onSelect: (ref) => inspect(ref), onInvoke: invoke, headingLevel: 3 });

const exportNote = ws.EmptyState($('export'), { title: 'No export requested', message: 'Use Export CSV or Export JSON above.' });
ws.AuditTimeline($('timeline'), { records: fixtures.timeline.records, engines: fixtures.timeline.engines, truncated: fixtures.timeline.truncated, onNavigate: (ref) => navigate(ref),
  onExport: (format, filter) => {
    const rows = ws.model.filterAudit(fixtures.timeline.records, filter);
    const content = format === 'csv' ? ws.model.auditCsv(rows) : JSON.stringify(rows, null, 1);
    exportNote.update({ title: `Export prepared in the browser: ${rows.length} records as ${format.toUpperCase()} (${content.length} characters)`, message: 'A real host calls the service export, which is permission-checked and recorded in the audit log.' });
  } });

for (const state of ws.model.STATES) { const holder = document.createElement('span'); $('badges').append(holder); ws.StateBadge(holder, { state, reasons: state === 'stale' ? ['source corrected'] : [] }); }
const samples = [[ws.EmptyState, { title: 'Nothing pinned', message: 'This board has no pinned objects yet.' }], [ws.LoadingState, { label: 'Loading linked view…' }],
  [ws.ErrorState, { message: 'View is at revision 3', code: 'revision_conflict', requestId: 'req-demo' }], [ws.PermissionDeniedState, {}], [ws.DisconnectedState, { engines: ['E06'], reason: 'timeout' }]];
for (const [make, props] of samples) { const holder = document.createElement('div'); $('states').append(holder); make(holder, props); }

showGraph();
inspect(rootRef);
window.workspaceDemo = { fixtures, navigate, inspect };
