// DataTable (sortable, keyboard navigable), RelationTable and TextOutline: the accessible equivalents of the graph.
import { component, clear, h, mount } from './dom.js';
import { badge } from './states.js';
import { compareCells, relationTable, textOutline } from './model.js';

/** A reference rendered as a control that asks the host to navigate. */
export function refLink(ref, onNavigate, text) {
  if (typeof onNavigate !== 'function') return h('span', { class: 'ws-ref', text: text ?? ref });
  return h('button', { type: 'button', class: 'ws-link ws-ref', dataset: { ref }, onClick: () => onNavigate(ref) }, text ?? ref);
}

/**
 * DataTable(container, { caption, columns, rows, rowHeader?, sort?, onSort?, emptyText?, captionHidden? })
 * columns: [{ key, label, sortable?, numeric?, render?(row) => Node | string }]
 * The first column (or `rowHeader`) is the row header. Arrow Up/Down moves between rows from any control in a row.
 */
export function DataTable(container, props) {
  let sort = props.sort ?? null;
  return component(container, props, (root, p, api) => {
    if (p.sort !== undefined && p.onSort) sort = p.sort;
    const columns = p.columns ?? [];
    const headerKey = p.rowHeader ?? (columns[0] ? columns[0].key : undefined);
    let rows = [...(p.rows ?? [])];
    if (sort && columns.some((c) => c.key === sort.key)) rows.sort((a, b) => compareCells(a[sort.key], b[sort.key]) * (sort.dir === 'desc' ? -1 : 1));
    const focusKey = document.activeElement && root.contains(document.activeElement) ? document.activeElement.getAttribute('data-sort-key') : null;
    const head = h('tr', {}, columns.map((c) => {
      const active = sort && sort.key === c.key;
      const th = h('th', { scope: 'col', class: c.numeric ? 'ws-num' : undefined, 'aria-sort': c.sortable === false ? undefined : active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none' });
      if (c.sortable === false) th.append(c.label);
      else th.append(h('button', { type: 'button', class: 'ws-sort', 'data-sort-key': c.key, onClick: () => {
        sort = { key: c.key, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' };
        if (p.onSort) p.onSort(sort);
        api.update({});
      } }, c.label, h('span', { class: 'ws-sort__mark', 'aria-hidden': 'true', text: active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '' }),
      h('span', { class: 'ws-visually-hidden', text: active ? (sort.dir === 'desc' ? ', sorted descending' : ', sorted ascending') : ', sortable' })));
      return th;
    }));
    const body = h('tbody', {}, rows.map((row) => h('tr', {}, columns.map((c) => {
      const content = c.render ? c.render(row) : row[c.key];
      const value = content === undefined || content === null ? '' : content;
      return c.key === headerKey ? h('th', { scope: 'row' }, value) : h('td', { class: c.numeric ? 'ws-num' : undefined }, value);
    }))));
    if (rows.length === 0) body.append(h('tr', {}, h('td', { colspan: Math.max(1, columns.length), class: 'ws-table__empty', text: p.emptyText ?? 'No rows.' })));
    const table = h('table', { class: 'ws-table' }, h('caption', { class: p.captionHidden ? 'ws-visually-hidden' : undefined, text: p.caption ?? '' }), h('thead', {}, head), body);
    table.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const tr = event.target.closest('tbody tr');
      if (!tr) return;
      const next = event.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
      const control = next ? next.querySelector('button, a[href]') : null;
      if (control) { event.preventDefault(); control.focus(); }
    });
    clear(root).append(h('div', { class: 'ws-table-wrap', tabindex: '0', role: 'group', 'aria-label': p.caption ? `${p.caption} (scrollable table)` : 'Scrollable table' }, table));
    if (focusKey) { const again = root.querySelector(`[data-sort-key="${focusKey}"]`); if (again) again.focus(); }
  });
}

/** RelationTable(container, { graph, table?, onNavigate? }) — one row per relationship, same data as the graph. */
export function RelationTable(container, props) {
  let inner = null;
  return component(container, props, (root, p) => {
    const model = p.table ?? relationTable(p.graph ?? { nodes: [], edges: [] });
    const columns = model.columns.map((c) => {
      if (c.key === 'to') return { ...c, render: (row) => refLink(row.to, p.onNavigate) };
      if (c.key === 'toStateLabel') return { ...c, key: 'toState', render: (row) => badge(row.toState, { showReasons: false }) };
      if (c.key === 'fromTitle') return { ...c, render: (row) => (row.relation === 'root' ? '(selected object)' : row.fromTitle) };
      return c;
    });
    // Row header is the related object: it is unique per row together with the relation.
    const next = { caption: model.caption, columns, rows: model.rows, rowHeader: 'toTitle', emptyText: 'No object selected.' };
    if (inner) inner.update(next); else inner = DataTable(root, next);
  }, () => { if (inner) inner.destroy(); });
}

/** TextOutline(container, { graph, outline?, onNavigate? }) — nested lists; identical content to the graph and the table. */
export function TextOutline(container, props) {
  return component(container, props, (root, p) => {
    const outline = p.outline ?? textOutline(p.graph ?? { nodes: [], edges: [] });
    const top = h('ul', { class: 'ws-outline' });
    const stack = [{ level: -1, list: top, item: null }];
    for (const line of outline.lines) {
      while (stack.length > 1 && stack[stack.length - 1].level >= line.level) stack.pop();
      const parent = stack[stack.length - 1];
      let list = parent.list;
      if (parent.item) { list = [...parent.item.children].find((c) => c.tagName === 'UL'); if (!list) { list = h('ul', {}); parent.item.append(list); } }
      const item = h('li', { dataset: { relation: line.relation, level: line.level } });
      if (line.ref && typeof p.onNavigate === 'function') {
        const cut = line.text.lastIndexOf(line.ref);
        mount(item, h('span', { text: cut >= 0 ? line.text.slice(0, cut) : `${line.text} ` }), refLink(line.ref, p.onNavigate), cut >= 0 ? h('span', { text: line.text.slice(cut + line.ref.length) }) : null);
      } else item.append(h('span', { text: line.text }));
      list.append(item);
      stack.push({ level: line.level, list, item });
    }
    clear(root).append(h('div', { class: 'ws-outline-wrap' }, top, h('details', { class: 'ws-outline__plain' }, h('summary', { text: 'Plain text version' }), h('pre', { tabindex: '0', text: outline.text }))));
  });
}
