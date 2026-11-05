import { VerificationWriteClient } from "./verification-write-client.ts";
import {
  captureVerificationSelection,
  renderSelectedVerificationFrame,
  verificationAxes,
} from "./selected-verification.ts";
import type { VerificationRef, SelectedVerificationFrame } from "./selected-verification.ts";
import type { VerificationChecks } from "@accountability/knowledge-verification/verification-review";

const owners = new WeakSet<VerificationWriteClient>();
/** One explicit review editor. The host must dispose on identity, purpose, logout and navigation changes. */
export function mountVerificationWrite(
  root: HTMLElement,
  client: VerificationWriteClient,
  selected: VerificationRef,
  nextCommandId: () => string,
): { dispose(): void } {
  if (!(client instanceof VerificationWriteClient) || client.closed || client.busy ||
      owners.has(client) || typeof nextCommandId !== "function" || !root.isConnected ||
      root.ownerDocument.location.origin !== client.origin ||
      !root.ownerDocument.defaultView?.MutationObserver)
    throw Error("verification_editor_unavailable");
  const document = root.ownerDocument;
  let choice = captureVerificationSelection(client.scope, selected);
  const section = document.createElement("section"),
    selection = document.createElement("p"),
    status = document.createElement("p"),
    content = document.createElement("div"),
    editor = document.createElement("fieldset"),
    legend = document.createElement("legend"),
    rationale = document.createElement("textarea");
  section.setAttribute("aria-label", "Private unresolved verification editor");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "No request made. Read the exact selected review before editing.";
  legend.textContent = "Literal human observations; every result remains unresolved";
  editor.append(legend);
  const fields = verificationAxes.map(axis => {
    const label = document.createElement("label"),
      select = document.createElement("select"),
      noteLabel = document.createElement("label"),
      note = document.createElement("textarea");
    label.append(document.createTextNode(axis + " status "), select);
    noteLabel.append(document.createTextNode(axis + " note "), note);
    select.name = axis;
    note.name = axis + "Note";
    note.maxLength = 4000;
    for (const value of ["unreviewed", "unresolved", "concern", "reviewed"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    editor.append(label, noteLabel);
    return { axis, select, note };
  });
  const rationaleLabel = document.createElement("label");
  rationale.name = "rationale";
  rationale.maxLength = 4000;
  rationaleLabel.append(document.createTextNode("Rationale "), rationale);
  editor.append(rationaleLabel);
  function button(text: string) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    return b;
  }
  const load = button("Read exact selected review"),
    discard = button("Discard unsaved edits"),
    record = button("Record unresolved observations"),
    replay = button("Replay identical pending command");
  section.append(selection, load, status, content, editor, discard, record, replay);
  root.replaceChildren(section);
  owners.add(client);
  let disposed = false, busy = false, captured: SelectedVerificationFrame | null = null;
  const required = [selection, load, status, content, editor, legend, rationaleLabel,
    rationale, discard, record, replay, ...fields.flatMap(f => [f.select, f.note])];
  const live = () => !disposed && root.isConnected && root.contains(section) &&
    required.every(node => section.contains(node)) && editor.contains(rationale) &&
    fields.every(f => editor.contains(f.select) && editor.contains(f.note));
  const clear = () => {
    captured = null;
    content.replaceChildren();
    for (const f of fields) { f.select.value = "unreviewed"; f.note.value = ""; }
    rationale.value = "";
  };
  const dirty = () => !!captured && (rationale.value !== captured.record.rationale ||
    fields.some(f => f.select.value !== captured!.record.checks[f.axis].status ||
      f.note.value !== captured!.record.checks[f.axis].note));
  const fill = () => {
    if (!captured) return;
    for (const f of fields) {
      f.select.value = captured.record.checks[f.axis].status;
      f.note.value = captured.record.checks[f.axis].note;
    }
    rationale.value = captured.record.rationale;
  };
  const refresh = () => {
    const locked = busy || client.busy || client.closed, pending = !!client.pending;
    selection.textContent = "Exact selected review: " + JSON.stringify(choice);
    load.disabled = locked || pending || dirty();
    editor.disabled = locked || pending || !captured;
    discard.disabled = locked || pending || !dirty();
    record.disabled = locked || pending || !captured;
    replay.disabled = locked || !pending;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    client.dispose();
    owners.delete(client);
    load.removeEventListener("click", onLoad);
    discard.removeEventListener("click", onDiscard);
    record.removeEventListener("click", onRecord);
    replay.removeEventListener("click", onReplay);
    editor.removeEventListener("input", onInput);
    editor.removeEventListener("change", onInput);
    clear();
    section.remove();
  };
  const observer = new document.defaultView!.MutationObserver(() => { if (!live()) dispose(); });
  const admitted = () => {
    if (!live()) { dispose(); return false; }
    return !busy && !client.busy && !client.closed;
  };
  const onInput = () => { if (!live()) dispose(); else refresh(); };
  const onDiscard = () => {
    if (!admitted() || client.pending || !captured) return;
    fill(); refresh();
    status.textContent = "Unsaved edits discarded. Captured observations are unchanged.";
  };
  const onLoad = async () => {
    if (!admitted() || client.pending || dirty()) return;
    busy = true; clear(); refresh();
    status.textContent = "Reading current private observations…";
    try {
      const frame = await client.load(choice);
      if (!live() || client.closed) { dispose(); return; }
      const view = renderSelectedVerificationFrame(document, client.scope, choice, JSON.stringify(frame));
      if (!live() || client.closed) { dispose(); return; }
      captured = frame; fill(); content.replaceChildren(view);
      status.textContent = "Captured exact selected review. Edit literal observations; this does not establish findings or permission.";
    } catch {
      if (!live() || client.closed) { dispose(); return; }
      clear(); status.textContent = "Current read unavailable. No observations displayed. Read explicitly to try again.";
    } finally { busy = false; if (live()) refresh(); }
  };
  const write = async (retry: boolean) => {
    if (!admitted() || (retry ? !client.pending : client.pending || !captured)) return;
    busy = true; refresh();
    status.textContent = retry ? "Replaying identical pending command…" : "Recording unresolved observations…";
    try {
      // Lock before invoking host code, and capture edits before it can mutate the DOM.
      const checks = Object.fromEntries(fields.map(f => [f.axis, { status: f.select.value, note: f.note.value }])) as VerificationChecks;
      const note = rationale.value;
      const id = retry ? null : nextCommandId();
      if (!live() || client.closed) { dispose(); return; }
      const ack = retry ? await client.retryPending() : await client.record(id!, checks, note);
      if (!live() || client.closed) { dispose(); return; }
      choice = captureVerificationSelection(client.scope, ack.record);
      clear();
      status.textContent = "Write acknowledged. No automatic reload. Read the returned exact selected review explicitly; observations remain unresolved.";
    } catch {
      if (!live() || client.closed) { dispose(); return; }
      clear();
      status.textContent = client.pending
        ? "Write outcome unresolved. Edits and reads locked. Only explicit identical replay is available. Pending command is memory-only; retain this view for host recovery."
        : "Write unavailable before dispatch. No automatic retry. Read the exact selected review explicitly before editing again.";
    } finally { busy = false; if (live()) refresh(); }
  };
  const onRecord = () => { void write(false); };
  const onReplay = () => { void write(true); };
  load.addEventListener("click", onLoad);
  discard.addEventListener("click", onDiscard);
  record.addEventListener("click", onRecord);
  replay.addEventListener("click", onReplay);
  editor.addEventListener("input", onInput);
  editor.addEventListener("change", onInput);
  observer.observe(document, { childList: true, subtree: true });
  if (client.pending) status.textContent = "Pending memory-only command retained. Only explicit identical replay is available.";
  refresh();
  return { dispose };
}
