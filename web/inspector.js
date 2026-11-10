// InspectorPanel: everything the owning engine reports about one object, in tabs. Shows only data passed in.
import { component, clear, formatTime, h, uid } from './dom.js';
import { badge, renderLoadState } from './states.js';
import { DataTable, refLink } from './tables.js';
import { parseRef } from './model.js';

export const INSPECTOR_TABS = ['summary', 'sources', 'dependents', 'versions', 'permissions', 'decisions', 'history', 'raw'];
const LABELS = { summary: 'Summary', sources: 'Sources', dependents: 'Dependents', versions: 'Versions', permissions: 'Permissions', decisions: 'Decisions', history: 'History', raw: 'Raw' };

/** Renders any JSON value as nested definition lists; strings that are universal references become links. */
export function jsonView(value, onNavigate, depth = 0) {
  if (value === null || value === undefined) return h('span', { class: 'ws-muted', text: '—' });
  if (typeof value === 'string') return parseRef(value) ? refLink(value, onNavigate) : h('span', { text: value });
  if (typeof value !== 'object') return h('span', { text: String(value) });
  if (depth > 6) return h('code', { text: JSON.stringify(value) });
  if (Array.isArray(value)) return value.length === 0 ? h('span', { class: 'ws-muted', text: 'none' }) : h('ul', { class: 'ws-json-list' }, value.map((v) => h('li', {}, jsonView(v, onNavigate, depth + 1))));
  const keys = Object.keys(value);
  if (keys.length === 0) return h('span', { class: 'ws-muted', text: 'none' });
  return h('dl', { class: 'ws-dl' }, keys.map((k) => [h('dt', { text: k }), h('dd', {}, jsonView(value[k], onNavigate, depth + 1))]));
}

function links(list, onNavigate, caption, empty) {
  const holder = h('div', {});
  if (!list || list.length === 0) { holder.append(h('p', { class: 'ws-muted', text: empty })); return holder; }
  DataTable(holder, { caption, rowHeader: 'ref', columns: [
    { key: 'ref', label: 'Reference', render: (row) => refLink(row.ref, onNavigate) }, { key: 'engine', label: 'Engine' }, { key: 'kind', label: 'Kind' },
    { key: 'revision', label: 'Revision', numeric: true, render: (row) => (row.revision === null || row.revision === undefined ? 'latest' : String(row.revision)) }], rows: list });
  return holder;
}
function records(list, onNavigate, caption, empty) {
  if (!list || list.length === 0) return h('p', { class: 'ws-muted', text: empty });
  return h('ol', { class: 'ws-records', 'aria-label': caption }, list.map((item) => h('li', {}, jsonView(item, onNavigate))));
}

/**
 * InspectorPanel(container, { object, state?, error?, tab?, onNavigate?, onTabChange?, onRetry?, headingLevel? })
 * object: the JSON returned by inspectOne. state: 'loading' | 'error' | 'denied' | 'disconnected' | 'empty' | 'ready'.
 */
export function InspectorPanel(container, props) {
  const id = uid('ws-inspector');
  let tab = props.tab ?? 'summary';
  return component(container, props, (root, p, api) => {
    if (p.tab !== undefined && p.onTabChange) tab = p.tab;
    if (!INSPECTOR_TABS.includes(tab)) tab = 'summary';
    if (renderLoadState(root, { ...p, state: p.state ?? (p.object ? 'ready' : 'empty'), emptyTitle: 'Nothing selected', emptyMessage: 'Select a task, claim, scene or output to inspect its sources, versions, permissions, decisions and current state.' })) return;
    const o = p.object;
    const refocus = root.contains(document.activeElement) && document.activeElement.getAttribute('role') === 'tab';
    const counts = { sources: o.sources?.length ?? 0, dependents: o.dependents?.length ?? 0, versions: o.versions?.length ?? 0, permissions: o.permissions?.length ?? 0, decisions: o.decisions?.length ?? 0, history: o.history?.length ?? 0 };
    const select = (next, focus) => { tab = next; if (p.onTabChange) p.onTabChange(next); api.update({}); if (focus) { const el = root.querySelector(`#${id}-tab-${next}`); if (el) el.focus(); } };
    const tablist = h('div', { class: 'ws-tabs', role: 'tablist', 'aria-label': 'Object details' }, INSPECTOR_TABS.map((t) => h('button', {
      type: 'button', role: 'tab', id: `${id}-tab-${t}`, class: 'ws-tab', 'aria-selected': String(tab === t), 'aria-controls': `${id}-panel`, tabindex: tab === t ? '0' : '-1', dataset: { tab: t },
      onClick: () => select(t, true),
      onKeydown: (event) => {
        const i = INSPECTOR_TABS.indexOf(t);
        const next = event.key === 'ArrowRight' ? INSPECTOR_TABS[(i + 1) % INSPECTOR_TABS.length] : event.key === 'ArrowLeft' ? INSPECTOR_TABS[(i - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length]
          : event.key === 'Home' ? INSPECTOR_TABS[0] : event.key === 'End' ? INSPECTOR_TABS[INSPECTOR_TABS.length - 1] : null;
        if (next) { event.preventDefault(); select(next, true); }
      },
    }, Object.hasOwn(counts, t) ? `${LABELS[t]} (${counts[t]})` : LABELS[t])));

    const panel = h('div', { class: 'ws-tabpanel', role: 'tabpanel', id: `${id}-panel`, 'aria-labelledby': `${id}-tab-${tab}`, tabindex: '0', dataset: { panel: tab } });
    if (tab === 'summary') {
      const badges = (o.badges && o.badges.length > 0 ? o.badges : [{ state: o.state }]).map((b) => badge(b.state, { reasons: b.state === 'stale' || b.state === 'blocked' ? o.staleReasons : [] }));
      panel.append(h('dl', { class: 'ws-dl ws-dl--summary' },
        h('dt', { text: 'Current state' }), h('dd', { dataset: { field: 'state' } }, badges),
        h('dt', { text: 'State reported by engine' }), h('dd', { text: o.engineState || '—' }),
        h('dt', { text: 'Engine' }), h('dd', { text: `${o.engineName ?? o.engine} (${o.engine})` }),
        h('dt', { text: 'Kind' }), h('dd', { text: o.kind }),
        h('dt', { text: 'Reference' }), h('dd', {}, h('code', { text: o.ref })),
        h('dt', { text: 'Loaded' }), h('dd', { text: formatTime(o.generatedAt) || '—' })));
      if (o.staleReasons && o.staleReasons.length > 0) panel.append(h('div', { class: 'ws-notice ws-notice--warn', dataset: { notice: 'reasons' } }, h('strong', { text: 'Why: ' }), h('ul', {}, o.staleReasons.map((r) => h('li', { text: r })))));
      const notes = o.annotations ?? [];
      panel.append(h(`h${Math.min(6, (p.headingLevel ?? 3) + 1)}`, { class: 'ws-subheading', text: `Workspace notes (${notes.length})` }));
      panel.append(notes.length === 0 ? h('p', { class: 'ws-muted', text: 'No review notes or correction requests recorded.' })
        : h('ul', { class: 'ws-notes' }, notes.map((a) => h('li', {}, h('strong', { text: `${String(a.kind).replace('_', ' ')} · ${a.status}` }), h('span', { text: ` — ${a.body}` }), h('span', { class: 'ws-muted', text: ` (${a.authorId}, ${formatTime(a.createdAt)})` })))));
    } else if (tab === 'sources') panel.append(links(o.sources, p.onNavigate, 'Sources: what this object depends on', 'No sources recorded by the owning engine.'));
    else if (tab === 'dependents') panel.append(links(o.dependents, p.onNavigate, 'Dependents: what uses this object', 'No dependents recorded by the owning engine.'));
    else if (tab === 'versions') {
      if (counts.versions === 0) panel.append(h('p', { class: 'ws-muted', text: 'No versions recorded.' }));
      else { const holder = h('div', {}); panel.append(holder); DataTable(holder, { caption: 'Versions', rowHeader: 'revision', sort: { key: 'revision', dir: 'desc' }, columns: [{ key: 'revision', label: 'Revision', numeric: true }, { key: 'at', label: 'When', render: (r) => formatTime(r.at) }, { key: 'actorId', label: 'By' }, { key: 'summary', label: 'Summary' }], rows: o.versions }); }
    } else if (tab === 'permissions') panel.append(records(o.permissions, p.onNavigate, 'Permissions', 'No permissions recorded for this object.'));
    else if (tab === 'decisions') panel.append(records(o.decisions, p.onNavigate, 'Decisions', 'No decisions recorded for this object.'));
    else if (tab === 'history') {
      if (counts.history === 0) panel.append(h('p', { class: 'ws-muted', text: 'No history recorded.' }));
      else { const holder = h('div', {}); panel.append(holder); DataTable(holder, { caption: 'History: actions actually recorded', rowHeader: 'at', columns: [{ key: 'at', label: 'When', render: (r) => formatTime(r.at) }, { key: 'actorId', label: 'Actor' }, { key: 'action', label: 'Action' }, { key: 'detail', label: 'Detail', sortable: false, render: (r) => jsonView(r.detail, p.onNavigate) }], rows: o.history }); }
    } else panel.append(h('pre', { class: 'ws-raw', tabindex: '0', 'aria-label': 'Raw object data', role: 'group', text: JSON.stringify(o, null, 2) }));

    const H = `h${p.headingLevel ?? 3}`;
    clear(root).append(h('section', { class: 'ws-inspector', 'aria-labelledby': `${id}-title` },
      h('header', { class: 'ws-inspector__head' }, h(H, { id: `${id}-title`, class: 'ws-inspector__title', text: o.title || '(untitled)' }), h('p', { class: 'ws-muted', text: `${o.engineName ?? o.engine} · ${o.kind}` })), tablist, panel));
    if (refocus) { const el = root.querySelector(`#${id}-tab-${tab}`); if (el) el.focus(); }
  });
}
