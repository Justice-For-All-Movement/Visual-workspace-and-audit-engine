// TaskBoard (columns by task state, dependency indicators, controls) and SearchResults (grouped by engine).
import { component, clear, h, uid } from './dom.js';
import { badge, renderLoadState } from './states.js';
import { ControlBar } from './controls.js';
import { refLink } from './tables.js';
import { groupTasks } from './model.js';

/**
 * TaskBoard(container, { items, edges?, controlsByRef?, selected?, onSelect?, onInvoke?, headingLevel? })
 * items: [{ ref, title, kind?, engine?, state, engineState, stale?, blocked?, staleReasons? }] — graph nodes or board pins.
 * edges: graph edges between items, used only to show what each task waits on.
 */
export function TaskBoard(container, props) {
  const id = uid('ws-board');
  let bars = [];
  return component(container, props, (root, p) => {
    for (const b of bars) b.destroy();
    bars = [];
    const items = p.items ?? [];
    const titles = new Map(items.map((i) => [i.ref, i.title || i.ref]));
    const H = `h${p.headingLevel ?? 3}`;
    const columns = groupTasks(items, p.edges ?? []);
    const board = h('div', { class: 'ws-board', role: 'group', 'aria-label': 'Tasks by state' }, columns.map((column) => {
      const headingId = `${id}-${column.id}`;
      return h('section', { class: 'ws-board__column', 'aria-labelledby': headingId, dataset: { column: column.id } },
        h(H, { id: headingId, class: 'ws-board__heading', text: `${column.label} (${column.items.length})` }),
        column.items.length === 0 ? h('p', { class: 'ws-muted', text: 'None.' }) : h('ul', { class: 'ws-board__list' }, column.items.map((item) => {
          const deps = item.dependsOn.length === 0 ? 'No dependencies on this board.'
            : `Waits on ${item.dependsOn.length} (${item.unfinished.length} not done): ${item.dependsOn.map((r) => `${titles.get(r)}${item.unfinished.includes(r) ? ' [not done]' : ' [done]'}`).join('; ')}.`;
          const holder = h('div', {});
          const card = h('li', { class: `ws-card${p.selected === item.ref ? ' ws-card--selected' : ''}`, dataset: { ref: item.ref } },
            h('p', { class: 'ws-card__title' }, typeof p.onSelect === 'function' ? h('button', { type: 'button', class: 'ws-link', 'aria-current': p.selected === item.ref ? 'true' : undefined, onClick: () => p.onSelect(item.ref) }, item.title || item.ref) : (item.title || item.ref)),
            h('p', { class: 'ws-card__state' }, badge(item.state, { reasons: item.staleReasons }), item.engineState ? h('span', { class: 'ws-muted', text: ` Engine state: ${item.engineState}` }) : null),
            h('p', { class: `ws-card__deps${item.unfinished.length > 0 ? ' ws-card__deps--waiting' : ''}`, dataset: { deps: String(item.dependsOn.length), waiting: String(item.unfinished.length) }, text: deps }), holder);
          const controls = p.controlsByRef ? p.controlsByRef[item.ref] : undefined;
          if (controls && typeof p.onInvoke === 'function') bars.push(ControlBar(holder, { ref: item.ref, controls, onInvoke: p.onInvoke, compact: true, label: `Actions for ${item.title || item.ref}` }));
          return card;
        })));
    }));
    clear(root).append(items.length === 0 ? h('p', { class: 'ws-muted', text: 'No tasks to show.' }) : board);
  }, () => { for (const b of bars) b.destroy(); });
}

const GROUP_STATUS = { unavailable: 'unavailable', forbidden: 'not permitted for your role' };
/**
 * SearchResults(container, { result, state?, error?, onNavigate?, onRetry?, headingLevel? })
 * result: the JSON returned by searchAll. Every engine is listed with its real status, including the ones with no hits.
 */
export function SearchResults(container, props) {
  return component(container, props, (root, p) => {
    if (renderLoadState(root, { ...p, state: p.state ?? (p.result ? 'ready' : 'empty'), emptyTitle: 'No search yet', emptyMessage: 'Enter a query to search across the engines you can read.' })) return;
    const r = p.result;
    const H = `h${p.headingLevel ?? 3}`;
    const groups = r.groups.map((g) => {
      const suffix = g.status === 'ok' ? `${g.hits.length} ${g.hits.length === 1 ? 'result' : 'results'}` : `${GROUP_STATUS[g.status] ?? g.status}${g.reason ? ` (${g.reason})` : ''}`;
      return h('section', { class: `ws-search__group ws-search__group--${g.status}`, dataset: { engine: g.engine, status: g.status } },
        h(H, { class: 'ws-search__heading', text: `${g.name ?? g.engine} (${g.engine}) — ${suffix}` }),
        g.hits.length === 0 ? null : h('ul', { class: 'ws-search__hits' }, g.hits.map((hit) => h('li', {},
          h('p', { class: 'ws-search__title' }, typeof p.onNavigate === 'function' ? h('button', { type: 'button', class: 'ws-link', dataset: { ref: hit.ref }, onClick: () => p.onNavigate(hit.ref) }, hit.title || hit.ref) : (hit.title || hit.ref),
            h('span', { class: 'ws-muted', text: ` ${hit.kind}${hit.state ? ` · engine state: ${hit.state}` : ''}` })),
          hit.snippet && hit.snippet !== hit.title ? h('p', { class: 'ws-search__snippet', text: hit.snippet }) : null,
          h('p', { class: 'ws-muted' }, refLink(hit.ref, undefined))))));
    });
    clear(root).append(h('section', { class: 'ws-search', 'aria-label': 'Search results' }, h('p', { role: 'status', text: `${r.total} ${r.total === 1 ? 'result' : 'results'} for “${r.q}” across ${r.groups.length} engines.` }), groups));
  });
}
