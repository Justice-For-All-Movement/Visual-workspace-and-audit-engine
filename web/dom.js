// Minimal DOM helpers for the workspace components. No dependencies; text is always set as text, never as HTML.
const SVG_NS = 'http://www.w3.org/2000/svg';
let counter = 0;
export function uid(prefix = 'ws') { counter += 1; return `${prefix}-${counter}`; }

function apply(el, attrs, children) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'dataset') for (const [k, v] of Object.entries(value)) el.dataset[k] = String(v);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(typeof child === 'object' ? child : String(child));
  }
  return el;
}
/** h('button', { class: 'x', onClick }, 'Label') */
export function h(tag, attrs, ...children) { return apply(document.createElement(tag), attrs, children); }
export function s(tag, attrs, ...children) { return apply(document.createElementNS(SVG_NS, tag), attrs, children); }
/** Appends children, skipping null/undefined/false (native append would print them). */
export function mount(el, ...children) { for (const c of children.flat(Infinity)) if (c !== undefined && c !== null && c !== false) el.append(c); return el; }
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

/** Standard component shell: keeps props, re-renders on update, removes everything on destroy. */
export function component(container, initial, render, cleanup) {
  let props = { ...initial };
  let alive = true;
  const root = container;
  const api = {
    update(next) { if (!alive) return; props = { ...props, ...next }; render(root, props, api); },
    destroy() { if (!alive) return; alive = false; if (cleanup) cleanup(); clear(root); },
    get props() { return props; },
  };
  render(root, props, api);
  return api;
}

export function formatTime(value) {
  if (typeof value !== 'string' || value === '') return '';
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}
export function truncate(text, max) { const t = String(text ?? ''); return t.length > max ? `${t.slice(0, max - 1)}…` : t; }

/** Focusable elements inside a container, in DOM order. */
export function focusable(container) {
  return [...container.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
    .filter((el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1' && el.getAttribute('aria-hidden') !== 'true');
}
