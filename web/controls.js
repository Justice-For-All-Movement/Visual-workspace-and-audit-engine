// ControlBar: renders the actions the service lists for an object and reports the real outcome or error.
// Dangerous actions and actions with inputs open a confirmation dialog with a focus trap.
import { component, clear, focusable, h, mount, uid } from './dom.js';

function fields(spec, formId) {
  const schema = spec.input && typeof spec.input === 'object' && !Array.isArray(spec.input) ? spec.input : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(properties).map(([name, def]) => {
    const d = def && typeof def === 'object' ? def : {};
    const fid = `${formId}-${name}`;
    const isRequired = required.includes(name);
    let input;
    if (Array.isArray(d.enum)) input = h('select', { id: fid, name, required: isRequired }, isRequired ? null : h('option', { value: '', text: '(default)' }), d.enum.map((v) => h('option', { value: String(v), text: String(v) })));
    else if (d.type === 'boolean') input = h('input', { id: fid, name, type: 'checkbox' });
    else if (d.type === 'number' || d.type === 'integer') input = h('input', { id: fid, name, type: 'number', step: d.type === 'integer' ? '1' : 'any', required: isRequired });
    else if (typeof d.maxLength === 'number' && d.maxLength > 200) input = h('textarea', { id: fid, name, rows: '4', maxlength: d.maxLength, required: isRequired });
    else input = h('input', { id: fid, name, type: 'text', maxlength: typeof d.maxLength === 'number' ? d.maxLength : undefined, required: isRequired });
    input.dataset.type = d.type ?? 'string';
    return h('div', { class: 'ws-field' }, h('label', { for: fid }, `${d.title ?? name}${isRequired ? ' (required)' : ''}`), input);
  });
}
function readForm(form) {
  const out = {};
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.value === '') continue;
    else out[el.name] = el.dataset.type === 'number' || el.dataset.type === 'integer' ? Number(el.value) : el.value;
  }
  return out;
}
function describeResult(result) {
  if (result === null || result === undefined) return '';
  const value = result && typeof result === 'object' && 'result' in result ? result.result : result;
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);
  if (typeof value.state === 'string') return `New state: ${value.state}.`;
  if (typeof value.filename === 'string') return `File: ${value.filename} (${value.recordCount ?? '?'} records).`;
  if (typeof value.status === 'string') return `Status: ${value.status}.`;
  return '';
}

/**
 * ControlBar(container, { ref, controls, onInvoke, label?, compact? })
 * controls: the `controls` array from listControls. onInvoke(ref, controlId, input, { confirm }) must return a Promise
 * that resolves with the invocation result or rejects with { code, message }. Nothing is assumed about the outcome.
 */
export function ControlBar(container, props) {
  const id = uid('ws-controls');
  let pending = null;       // control id being sent
  let outcome = null;       // { kind: 'ok' | 'error', text }
  let dialog = null;        // open dialog element
  let returnFocusTo = null; // control id to refocus after the dialog closes
  let api = null;

  function closeDialog() {
    if (!dialog) return;
    dialog.remove(); dialog = null;
    const again = returnFocusTo ? container.querySelector(`[data-control="${returnFocusTo}"]`) : null;
    if (again) again.focus();
  }
  async function send(spec, input) {
    const p = api.props;
    pending = spec.id; outcome = null; returnFocusTo = spec.id;
    closeDialog(); api.update({});
    try {
      const result = await p.onInvoke(p.ref, spec.id, input, { confirm: spec.dangerous === true });
      const reported = result && typeof result === 'object' && typeof result.outcome === 'string' ? result.outcome : 'succeeded';
      outcome = { kind: reported === 'succeeded' ? 'ok' : 'error', text: `${spec.label}: ${reported}. ${describeResult(result)}`.trim() };
    } catch (error) {
      const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'error';
      const message = error && typeof error === 'object' && typeof error.message === 'string' ? error.message : 'No reason was reported.';
      outcome = { kind: 'error', text: `${spec.label} did not complete (${code}): ${message}` };
    }
    pending = null;
    api.update({});
    const again = container.querySelector(`[data-control="${spec.id}"]`);
    if (again) again.focus();
  }
  function openDialog(spec) {
    const formId = `${id}-form`;
    const inputs = fields(spec, formId);
    const form = h('form', { id: formId, novalidate: true, onSubmit: (event) => {
      event.preventDefault();
      const missing = [...form.querySelectorAll('[required]')].find((el) => el.value === '');
      const problem = form.querySelector('[data-problem]');
      if (missing) { problem.textContent = `Please fill in: ${form.querySelector(`label[for="${missing.id}"]`).textContent.replace(' (required)', '')}.`; missing.focus(); return; }
      void send(spec, readForm(form));
    } },
    spec.description ? h('p', { text: spec.description }) : null,
    spec.dangerous ? h('p', { class: 'ws-notice ws-notice--danger', dataset: { notice: 'dangerous' }, text: `This action is marked as dangerous by ${spec.source ?? 'its engine'}. It is sent only after you confirm.` }) : null,
    inputs,
    h('p', { class: 'ws-field__problem', role: 'alert', 'data-problem': '' }),
    h('div', { class: 'ws-dialog__actions' },
      h('button', { type: 'button', class: 'ws-button', 'data-dialog': 'cancel', onClick: () => closeDialog() }, 'Do not send'),
      h('button', { type: 'submit', class: `ws-button ${spec.dangerous ? 'ws-button--danger' : 'ws-button--primary'}`, 'data-dialog': 'confirm' }, spec.dangerous ? `Confirm: ${spec.label}` : spec.label)));
    dialog = h('div', { class: 'ws-dialog__backdrop', dataset: { dialogFor: spec.id } }, h('div', { class: 'ws-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${id}-dialog-title` },
      h('h2', { id: `${id}-dialog-title`, class: 'ws-dialog__title', text: spec.dangerous ? `Confirm: ${spec.label}?` : spec.label }),
      h('p', { class: 'ws-muted' }, 'Object: ', h('code', { text: api.props.ref })), form));
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable(dialog);
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (!dialog.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    });
    dialog.addEventListener('mousedown', (event) => { if (event.target === dialog) closeDialog(); });
    returnFocusTo = spec.id;
    container.append(dialog);
    // Focus starts on the first field, or on the safe choice when the action is dangerous.
    const start = inputs.length > 0 ? dialog.querySelector('input, select, textarea') : dialog.querySelector(spec.dangerous ? '[data-dialog="cancel"]' : '[data-dialog="confirm"]');
    start.focus();
  }

  api = component(container, props, (root, p) => {
    const keepDialog = dialog;
    if (keepDialog) keepDialog.remove();
    const controls = p.controls ?? [];
    const bar = h('div', { class: `ws-controls${p.compact ? ' ws-controls--compact' : ''}`, role: 'group', 'aria-label': p.label ?? 'Actions for this object' });
    if (controls.length === 0) bar.append(h('p', { class: 'ws-muted', text: 'No actions are available for this object.' }));
    const reasons = [];
    for (const spec of controls) {
      const denied = spec.allowed === false;
      const reasonId = denied ? `${id}-why-${spec.id.replace(/[^a-z0-9]/gi, '-')}` : undefined;
      const hasInputs = spec.input && typeof spec.input === 'object' && spec.input.properties && Object.keys(spec.input.properties).length > 0;
      bar.append(h('button', {
        type: 'button', class: `ws-button${spec.dangerous ? ' ws-button--danger' : ''}`, dataset: { control: spec.id, dangerous: String(spec.dangerous === true) },
        'aria-disabled': denied || pending !== null ? 'true' : undefined, 'aria-describedby': reasonId, 'aria-haspopup': spec.dangerous || hasInputs ? 'dialog' : undefined, title: spec.description,
        onClick: () => { if (denied || pending !== null) return; if (spec.dangerous || hasInputs) openDialog(spec); else void send(spec, {}); },
      }, pending === spec.id ? `${spec.label} — sending…` : spec.label));
      if (denied) reasons.push(h('li', { id: reasonId, text: `${spec.label}: not available to you. ${spec.deniedReason ?? ''}`.trim() }));
    }
    const status = h('p', { class: `ws-controls__outcome${outcome ? ` ws-controls__outcome--${outcome.kind}` : ''}`, role: outcome && outcome.kind === 'error' ? 'alert' : 'status', 'aria-live': outcome && outcome.kind === 'error' ? 'assertive' : 'polite', dataset: { outcome: outcome ? outcome.kind : 'none' } },
      pending !== null ? 'Sent; waiting for the engine to answer.' : outcome ? outcome.text : '');
    mount(clear(root), bar, reasons.length > 0 ? h('ul', { class: 'ws-controls__reasons ws-muted' }, reasons) : null, status);
    if (keepDialog) root.append(keepDialog);
  }, () => { if (dialog) dialog.remove(); });
  return api;
}
