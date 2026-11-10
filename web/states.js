// State badge and whole-panel states (empty, error, loading, permission denied, disconnected).
// Every state is text first; the shape icon and colour are secondary cues.
import { component, clear, formatTime, h, s } from './dom.js';
import { STATE_DESCRIPTIONS, STATE_SHAPES, stateLabel } from './model.js';

/** Small SVG shape for a display state. Decorative: the adjacent text carries the meaning. */
export function stateIcon(state, size = 12) {
  const shape = STATE_SHAPES[state] ?? 'ring';
  const svg = s('svg', { class: `ws-icon ws-icon--${state}`, viewBox: '0 0 12 12', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
  if (shape === 'circle') svg.append(s('circle', { cx: 6, cy: 6, r: 5 }));
  else if (shape === 'triangle') svg.append(s('path', { d: 'M6 1 L11.5 11 L0.5 11 Z' }));
  else if (shape === 'square') svg.append(s('rect', { x: 1, y: 1, width: 10, height: 10 }));
  else if (shape === 'cross') svg.append(s('path', { d: 'M1.5 1.5 L10.5 10.5 M10.5 1.5 L1.5 10.5', fill: 'none', 'stroke-width': 2.5 }));
  else if (shape === 'diamond') svg.append(s('path', { d: 'M6 0.5 L11.5 6 L6 11.5 L0.5 6 Z', fill: 'none', 'stroke-width': 1.5 }));
  else svg.append(s('circle', { cx: 6, cy: 6, r: 4.5, fill: 'none', 'stroke-width': 1.5, 'stroke-dasharray': '2.5 2' }));
  return svg;
}

/** Builds a badge element: icon + text label (+ reasons). */
export function badge(state, options = {}) {
  const reasons = Array.isArray(options.reasons) ? options.reasons.filter((r) => typeof r === 'string' && r !== '') : [];
  const label = options.label ?? stateLabel(state);
  const el = h('span', { class: `ws-badge ws-badge--${state}`, dataset: { state }, title: STATE_DESCRIPTIONS[state] ?? '' }, stateIcon(state), h('span', { class: 'ws-badge__label', text: label }));
  if (reasons.length > 0 && options.showReasons !== false) el.append(h('span', { class: 'ws-badge__reason', text: `(${reasons.join('; ')})` }));
  if (options.at) el.append(h('span', { class: 'ws-badge__reason', text: `as of ${formatTime(options.at)}` }));
  return el;
}

/** StateBadge(container, { state, label?, reasons?, at?, showReasons? }) */
export function StateBadge(container, props) {
  return component(container, props, (root, p) => { clear(root).append(badge(p.state, p)); });
}

function panel(kind, role, title, parts, action) {
  const el = h('div', { class: `ws-state ws-state--${kind}`, role, dataset: { panelState: kind } }, h('p', { class: 'ws-state__title' }, h('strong', { text: title })), ...parts);
  if (action && typeof action.onAction === 'function') el.append(h('p', {}, h('button', { type: 'button', class: 'ws-button', onClick: () => action.onAction() }, action.label)));
  return el;
}
const para = (text) => (text ? h('p', { class: 'ws-state__message', text }) : null);

/** EmptyState(container, { title?, message?, action?: { label, onAction } }) */
export function EmptyState(container, props) {
  return component(container, props, (root, p) => { clear(root).append(panel('empty', undefined, p.title ?? 'Nothing to show', [para(p.message)], p.action)); });
}
/** ErrorState(container, { title?, message, code?, requestId?, onRetry? }) — shows the error that was actually returned. */
export function ErrorState(container, props) {
  return component(container, props, (root, p) => {
    const detail = [p.code ? `Code: ${p.code}` : '', p.requestId ? `Request: ${p.requestId}` : ''].filter(Boolean).join(' · ');
    clear(root).append(panel('error', 'alert', p.title ?? 'This could not be loaded', [para(p.message), detail ? h('p', { class: 'ws-state__detail', text: detail }) : null], p.onRetry ? { label: 'Try again', onAction: p.onRetry } : undefined));
  });
}
/** LoadingState(container, { label? }) — static text; there is no progress indicator because no progress is known. */
export function LoadingState(container, props) {
  return component(container, props ?? {}, (root, p) => { clear(root).append(h('div', { class: 'ws-state ws-state--loading', role: 'status', 'aria-live': 'polite', dataset: { panelState: 'loading' } }, h('p', { class: 'ws-state__title', text: p.label ?? 'Loading…' }))); });
}
/** PermissionDeniedState(container, { message?, capability? }) */
export function PermissionDeniedState(container, props) {
  return component(container, props ?? {}, (root, p) => {
    clear(root).append(panel('denied', undefined, 'Not found or not permitted', [para(p.message ?? 'This object does not exist or your role does not allow you to see it.'), p.capability ? h('p', { class: 'ws-state__detail', text: `Required capability: ${p.capability}` }) : null]));
  });
}
/** DisconnectedState(container, { engines?, reason?, since?, onRetry? }) */
export function DisconnectedState(container, props) {
  return component(container, props ?? {}, (root, p) => {
    const engines = Array.isArray(p.engines) && p.engines.length > 0 ? `Unavailable: ${p.engines.join(', ')}.` : 'The service could not be reached.';
    clear(root).append(panel('disconnected', 'alert', 'Disconnected', [para(`${engines} Current state is unknown${p.since ? `; last loaded ${formatTime(p.since)}` : ''}.`), para(p.reason ? `Reason: ${p.reason}` : '')], p.onRetry ? { label: 'Try again', onAction: p.onRetry } : undefined));
  });
}

/** Renders the matching whole-panel state for a `{ status, error }` load result, or returns false when data is ready. */
export function renderLoadState(root, p) {
  const state = p.state;
  if (!state || state === 'ready') return false;
  clear(root);
  const holder = h('div', {});
  root.append(holder);
  if (state === 'loading') LoadingState(holder, { label: p.loadingLabel });
  else if (state === 'denied') PermissionDeniedState(holder, { message: p.error?.message });
  else if (state === 'disconnected') DisconnectedState(holder, { engines: p.error?.engines, reason: p.error?.message, onRetry: p.onRetry });
  else if (state === 'empty') EmptyState(holder, { title: p.emptyTitle, message: p.emptyMessage });
  else ErrorState(holder, { message: p.error?.message ?? 'Unknown error', code: p.error?.code, requestId: p.error?.requestId, onRetry: p.onRetry });
  return true;
}
