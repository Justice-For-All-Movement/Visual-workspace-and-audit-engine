// AuditTimeline: merged audit records as a virtualised table with filters. Only records passed in are shown.
import { component, clear, formatTime, h, uid } from './dom.js';
import { refLink } from './tables.js';
import { distinct, filterAudit } from './model.js';

const CHAIN_TEXT = { verified: 'hash chain verified', broken: 'HASH CHAIN BROKEN', partial: 'hash chain not verifiable (only part is readable)', empty: 'no records', not_checked: 'hash chain not checked' };
const COLUMNS = [{ key: 'at', label: 'When' }, { key: 'engine', label: 'Engine' }, { key: 'actorId', label: 'Actor' }, { key: 'action', label: 'Action' }, { key: 'subject', label: 'Subject' }, { key: 'requestId', label: 'Request' }];

/**
 * AuditTimeline(container, { records, engines?, truncated?, filter?, height?, onFilterChange?, onNavigate?, onExport?, onLoadMore? })
 * records/engines/truncated: as returned by auditTimeline. filter: { engine?, actor?, action?, text? }.
 * Rows outside the scrolled window are not in the DOM; aria-rowcount / aria-rowindex give the true positions.
 */
export function AuditTimeline(container, props) {
  const id = uid('ws-timeline');
  let filter = { ...(props.filter ?? {}) };
  let rowHeight = 0;
  let scroller = null, rowsEl = null, visible = [];
  let lastKey = '';
  let navigate = props.onNavigate;

  function row(record, index) {
    return h('div', { class: 'ws-trow', role: 'row', 'aria-rowindex': String(index + 2), dataset: { index: String(index) } },
      h('div', { role: 'cell', class: 'ws-tcell ws-tcell--at', title: record.at }, formatTime(record.at)),
      h('div', { role: 'cell', class: 'ws-tcell ws-tcell--engine' }, record.engine),
      h('div', { role: 'cell', class: 'ws-tcell ws-tcell--actor', title: record.actorId }, record.actorId),
      h('div', { role: 'cell', class: 'ws-tcell ws-tcell--action', title: record.action }, record.action),
      h('div', { role: 'cell', class: 'ws-tcell ws-tcell--subject', title: record.subject }, refLink(record.subject, navigate)),
      h('div', { role: 'cell', class: 'ws-tcell ws-tcell--request', title: record.requestId }, record.requestId));
  }
  function paint() {
    if (!scroller || !rowsEl) return;
    if (rowHeight === 0) {
      // Measure one real row so the window is right at any zoom level or font size.
      const sample = visible.length > 0 ? row(visible[0], 0) : null;
      if (sample) { rowsEl.append(sample); rowHeight = sample.getBoundingClientRect().height || 40; sample.remove(); } else rowHeight = 40;
    }
    const viewH = scroller.clientHeight || 400;
    const first = Math.max(0, Math.floor(scroller.scrollTop / rowHeight) - 5);
    const last = Math.min(visible.length, Math.ceil((scroller.scrollTop + viewH) / rowHeight) + 5);
    const key = `${first}:${last}:${visible.length}`;
    if (key === lastKey) return;
    lastKey = key;
    const focused = rowsEl.contains(document.activeElement) ? document.activeElement.closest('[data-index]')?.dataset.index : null;
    clear(rowsEl);
    rowsEl.style.height = `${visible.length * rowHeight}px`;
    rowsEl.style.paddingTop = `${first * rowHeight}px`;
    for (let i = first; i < last; i++) rowsEl.append(row(visible[i], i));
    if (focused !== null && focused !== undefined) { const again = rowsEl.querySelector(`[data-index="${focused}"] button`); if (again) again.focus({ preventScroll: true }); }
  }
  const onScroll = () => paint();
  const onResize = () => { rowHeight = 0; lastKey = ''; paint(); };
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

  return component(container, props, (root, p, api) => {
    navigate = p.onNavigate;
    if (p.filter !== undefined && p.onFilterChange) filter = { ...p.filter };
    const records = p.records ?? [];
    visible = filterAudit(records, filter);
    const focusedFilter = root.contains(document.activeElement) ? document.activeElement.getAttribute('data-filter') : null;
    const caret = focusedFilter === 'text' ? document.activeElement.selectionStart : null;
    const change = (key, value) => { filter = { ...filter, [key]: value }; if (p.onFilterChange) p.onFilterChange(filter); scroller.scrollTop = 0; api.update({}); };
    const select = (key, label, values) => h('div', { class: 'ws-field ws-field--inline' }, h('label', { for: `${id}-${key}`, text: label }),
      h('select', { id: `${id}-${key}`, 'data-filter': key, onChange: (event) => change(key, event.target.value) }, h('option', { value: '', text: 'All' }), values.map((v) => h('option', { value: v, text: v, selected: filter[key] === v }))));
    const filters = h('form', { class: 'ws-timeline__filters', role: 'search', 'aria-label': 'Filter audit records', onSubmit: (event) => event.preventDefault() },
      select('engine', 'Engine', distinct(records, 'engine')), select('actor', 'Actor', distinct(records, 'actorId')), select('action', 'Action', distinct(records, 'action')),
      h('div', { class: 'ws-field ws-field--inline' }, h('label', { for: `${id}-text`, text: 'Contains' }), h('input', { id: `${id}-text`, type: 'search', 'data-filter': 'text', value: filter.text ?? '', onInput: (event) => change('text', event.target.value) })),
      p.onExport ? h('div', { class: 'ws-segmented', role: 'group', 'aria-label': 'Export audit records' }, ['csv', 'json'].map((f) => h('button', { type: 'button', class: 'ws-button', 'data-export': f, onClick: () => p.onExport(f, filter) }, `Export ${f.toUpperCase()}`))) : null);
    const count = h('p', { class: 'ws-timeline__count', role: 'status', 'aria-live': 'polite', id: `${id}-count`, text: `Showing ${visible.length} of ${records.length} loaded records${p.truncated ? '; more exist on the server' : ''}.` });
    const engines = (p.engines ?? []).length === 0 ? null : h('ul', { class: 'ws-timeline__engines', 'aria-label': 'Audit sources' }, p.engines.map((e) => h('li', { dataset: { engine: e.engine, status: e.status, chain: e.chain } },
      h('strong', { text: `${e.name ?? e.engine} (${e.engine})` }), `: ${e.status === 'ok' ? `${e.count} records, ${CHAIN_TEXT[e.chain] ?? e.chain}` : e.status === 'forbidden' ? 'not permitted for your role' : `unavailable${e.reason ? ` (${e.reason})` : ''}`}`)));
    rowsEl = h('div', { class: 'ws-timeline__rows', role: 'rowgroup' });
    scroller = h('div', { class: 'ws-timeline__scroll', tabindex: '0', role: 'group', 'aria-label': 'Audit records (scrollable)', 'aria-describedby': `${id}-count`, style: p.height ? { height: `${Number(p.height)}px` } : undefined, onScroll },
      h('div', { class: 'ws-timeline__table', role: 'table', 'aria-label': 'Audit timeline', 'aria-rowcount': String(visible.length + 1) },
        h('div', { role: 'rowgroup', class: 'ws-timeline__head' }, h('div', { class: 'ws-trow ws-trow--head', role: 'row', 'aria-rowindex': '1' }, COLUMNS.map((c) => h('div', { role: 'columnheader', class: `ws-tcell ws-tcell--${c.key === 'actorId' ? 'actor' : c.key === 'requestId' ? 'request' : c.key}`, text: c.label })))),
        rowsEl));
    const more = p.truncated && p.onLoadMore ? h('p', {}, h('button', { type: 'button', class: 'ws-button', 'data-more': '', onClick: () => p.onLoadMore() }, 'Load more records')) : null;
    clear(root).append(h('section', { class: 'ws-timeline', 'aria-label': 'Audit history' }, filters, count, engines, visible.length === 0 ? h('p', { class: 'ws-muted', dataset: { empty: '' }, text: records.length === 0 ? 'No audit records were returned.' : 'No records match these filters.' }) : null, scroller, more));
    lastKey = ''; rowHeight = 0;
    paint();
    if (focusedFilter) { const again = root.querySelector(`[data-filter="${focusedFilter}"]`); if (again) { again.focus(); if (caret !== null && again.setSelectionRange) again.setSelectionRange(caret, caret); } }
  }, () => { if (typeof window !== 'undefined') window.removeEventListener('resize', onResize); });
}
