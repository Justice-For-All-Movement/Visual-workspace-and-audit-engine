import { DispositionWriteClient } from "./disposition-write-client.ts";
import { captureDispositionSelection, renderSelectedDispositionFrame } from "./selected-dispositions.ts";
import type { DispositionRef, SelectedDispositionFrame } from "./selected-dispositions.ts";
import type { QuestionDisposition } from "@accountability/factual-investigation/question-dispositions";

const owners = new WeakSet<DispositionWriteClient>();
/** Fixed selected plan. Host must dispose on logout, identity/purpose and navigation changes. */
export function mountDispositionWrite(
  root: HTMLElement,
  client: DispositionWriteClient,
  selected: DispositionRef,
  nextCommandId: () => string,
  nextReviewId: () => string,
): { dispose(): void } {
  if (!(client instanceof DispositionWriteClient) || client.closed || client.busy ||
      owners.has(client) || typeof nextCommandId !== "function" || typeof nextReviewId !== "function" ||
      !root.isConnected || root.ownerDocument.location.origin !== client.origin ||
      !root.ownerDocument.defaultView?.MutationObserver)
    throw Error("disposition_editor_unavailable");
  const document = root.ownerDocument;
  const choice = captureDispositionSelection(client.scope, selected);
  const section = document.createElement("section"), selection = document.createElement("p"),
    status = document.createElement("p"), content = document.createElement("div"),
    editor = document.createElement("fieldset"), legend = document.createElement("legend"),
    rows = document.createElement("div"), triggersLabel = document.createElement("label"),
    triggers = document.createElement("textarea"), confirmationLabel = document.createElement("label"),
    confirmation = document.createElement("input");
  section.setAttribute("aria-label", "Private unanswered question disposition editor");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  status.textContent = "No request made. Read the selected plan before editing.";
  selection.textContent = "Exact selected plan: " + JSON.stringify(choice);
  legend.textContent = "Unanswered question review; assignment labels do not authenticate or deliver tasks";
  triggers.name = "reopeningTriggers"; triggers.maxLength = 128 * 1024;
  triggersLabel.append(document.createTextNode("Literal reopening triggers as a JSON array of strings "), triggers);
  confirmation.type = "checkbox"; confirmation.name = "confirm";
  confirmationLabel.append(confirmation, document.createTextNode("I explicitly confirm this whole unanswered question review."));
  editor.append(legend, rows, triggersLabel, confirmationLabel);
  function button(text: string) {
    const b = document.createElement("button"); b.type = "button"; b.textContent = text; return b;
  }
  const load = button("Read exact selected plan"), discard = button("Discard unsaved edits"),
    save = button("Record unanswered question review"), replay = button("Replay identical pending command");
  section.append(selection, load, status, content, editor, discard, save, replay);
  root.replaceChildren(section); owners.add(client);
  let disposed = false, busy = false, captured: SelectedDispositionFrame | null = null;
  type Row = { questionId: string; container: HTMLElement; select: HTMLSelectElement;
    reason: HTMLTextAreaElement; assignee: HTMLInputElement; reviewAt: HTMLInputElement };
  let fields: Row[] = [], baseline = "";
  const required = [selection, load, status, content, editor, legend, rows, triggersLabel,
    triggers, confirmationLabel, confirmation, discard, save, replay];
  const live = () => !disposed && root.isConnected && root.contains(section) &&
    required.every(node => section.contains(node)) && editor.contains(rows) &&
    editor.contains(triggers) && editor.contains(confirmation) && fields.every(f =>
      rows.contains(f.container) && f.container.contains(f.select) && f.container.contains(f.reason) &&
      f.container.contains(f.assignee) && f.container.contains(f.reviewAt));
  const values = () => JSON.stringify({ questions: fields.map(f => ({
    questionId: f.questionId, status: f.select.value, reason: f.reason.value,
    assigneeId: f.assignee.value, reviewAt: f.reviewAt.value,
  })), triggers: triggers.value });
  const dirty = () => !!captured && values() !== baseline;
  const clear = () => {
    captured = null; fields = []; baseline = ""; content.replaceChildren(); rows.replaceChildren();
    triggers.value = ""; confirmation.checked = false;
  };
  const fill = () => {
    rows.replaceChildren(); fields = []; confirmation.checked = false;
    if (!captured) return;
    for (const q of captured.table.questions) {
      const container = document.createElement("fieldset"), label = document.createElement("legend"),
        select = document.createElement("select"), reason = document.createElement("textarea"),
        assignee = document.createElement("input"), reviewAt = document.createElement("input");
      label.textContent = q.questionId + (q.material ? " — material question" : " — question");
      container.append(label);
      select.name = q.questionId + ":status";
      for (const value of ["unresolved", "deferred", "assigned"]) {
        const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option);
      }
      reason.name = q.questionId + ":reason"; reason.maxLength = 4000;
      assignee.name = q.questionId + ":assignee"; assignee.maxLength = 128;
      reviewAt.name = q.questionId + ":reviewAt"; reviewAt.maxLength = 24;
      for (const [text, input] of [["Unanswered disposition ", select], ["Rationale ", reason],
        ["Host assignee label (not identity or delivery proof) ", assignee],
        ["Review at, exact UTC milliseconds (YYYY-MM-DDTHH:mm:ss.sssZ) ", reviewAt]] as const) {
        const l = document.createElement("label"); l.append(document.createTextNode(text), input); container.append(l);
      }
      select.value = q.disposition.status; reason.value = q.disposition.reason;
      assignee.value = q.disposition.assigneeId ?? ""; reviewAt.value = q.disposition.reviewAt ?? "";
      rows.append(container); fields.push({questionId:q.questionId,container,select,reason,assignee,reviewAt});
    }
    // Stale historical triggers are displayed by the inspector, never silently applied to a new basis.
    triggers.value = captured.table.reviewRequired === null ? JSON.stringify(captured.table.latestReview!.reopeningTriggers) : "[]";
    baseline = values();
  };
  const refresh = () => {
    const locked = busy || client.busy || client.closed, pending = !!client.pending;
    load.disabled = locked || pending || dirty(); editor.disabled = locked || pending || !captured;
    discard.disabled = locked || pending || !dirty(); save.disabled = locked || pending || !captured || !confirmation.checked;
    replay.disabled = locked || !pending;
  };
  const dispose = () => {
    if (disposed) return; disposed = true; observer.disconnect(); client.dispose(); owners.delete(client);
    load.removeEventListener("click", onLoad); discard.removeEventListener("click", onDiscard);
    save.removeEventListener("click", onSave); replay.removeEventListener("click", onReplay);
    editor.removeEventListener("input", onInput); editor.removeEventListener("change", onInput);
    clear(); section.remove();
  };
  const observer = new document.defaultView!.MutationObserver(() => { if (!live()) dispose(); });
  const admitted = () => {
    if (!live()) { dispose(); return false; } return !busy && !client.busy && !client.closed;
  };
  const onInput = (event: Event) => {
    if (!live()) { dispose(); return; }
    if (event.target !== confirmation) confirmation.checked = false;
    refresh();
  };
  const onDiscard = () => {
    if (!admitted() || client.pending || !captured) return; fill(); refresh();
    status.textContent = "Unsaved edits discarded; captured history is unchanged.";
  };
  const onLoad = async () => {
    if (!admitted() || client.pending || dirty()) return; busy = true; clear(); refresh();
    status.textContent = "Reading current private question dispositions…";
    try {
      const frame = await client.load(choice);
      if (!live() || client.closed) { dispose(); return; }
      const view = renderSelectedDispositionFrame(document, client.scope, choice, JSON.stringify(frame));
      if (!live() || client.closed) { dispose(); return; }
      captured = frame; fill(); content.replaceChildren(view);
      status.textContent = "Captured selected plan. All questions remain unanswered. Explicit confirmation is required to record a review.";
    } catch {
      if (!live() || client.closed) { dispose(); return; }
      clear(); status.textContent = "Current read unavailable. No copied history displayed. Read explicitly to try again.";
    } finally { busy = false; if (live()) refresh(); }
  };
  const write = async (retry: boolean) => {
    if (!admitted() || (retry ? !client.pending : client.pending || !captured || !confirmation.checked)) return;
    busy = true; refresh();
    status.textContent = retry ? "Replaying identical pending command…" : "Recording unanswered question review…";
    try {
      const questions = fields.map(f => ({ questionId:f.questionId, status:f.select.value,
        reason:f.reason.value, assigneeId:f.select.value === "assigned" ? f.assignee.value : null,
        reviewAt:f.select.value === "unresolved" ? null : f.reviewAt.value })) as QuestionDisposition[];
      const reopeningTriggers: string[] = retry ? [] : JSON.parse(triggers.value);
      const commandId = retry ? null : nextCommandId();
      if (!live() || client.closed) { dispose(); return; }
      const reviewId = retry ? null : nextReviewId();
      if (!live() || client.closed) { dispose(); return; }
      const ack = retry ? await client.retryPending() : await client.record(commandId!, reviewId!, questions, reopeningTriggers);
      if (!live() || client.closed) { dispose(); return; }
      clear(); status.textContent = "Write acknowledged: " + JSON.stringify(ack) +
        ". Read the same selected plan explicitly before another review. No automatic reload or case closure.";
    } catch {
      if (!live() || client.closed) { dispose(); return; }
      clear(); status.textContent = client.pending
        ? "Write outcome unresolved. Editing, reads and discard locked. Only explicit identical replay. Pending is memory-only; retain this view for host recovery."
        : "Write unavailable before dispatch. Read explicitly before editing again. No automatic retry.";
    } finally { busy = false; if (live()) refresh(); }
  };
  const onSave = () => { void write(false); }, onReplay = () => { void write(true); };
  load.addEventListener("click", onLoad); discard.addEventListener("click", onDiscard);
  save.addEventListener("click", onSave); replay.addEventListener("click", onReplay);
  editor.addEventListener("input", onInput); editor.addEventListener("change", onInput);
  observer.observe(document, {childList:true,subtree:true});
  if (client.pending) status.textContent = "Memory-only pending command retained. Only explicit identical replay is available.";
  refresh(); return {dispose};
}
