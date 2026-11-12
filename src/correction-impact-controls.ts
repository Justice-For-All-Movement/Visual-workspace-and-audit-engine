import { CorrectionImpactReadClient } from "./correction-impact-client.ts";
import {
  captureCorrectionImpactSelection,
  renderSelectedCorrectionImpactFrame,
} from "./selected-correction-impact.ts";
import type { CorrectionImpactSelection } from "./selected-correction-impact.ts";

const owners = new WeakSet<CorrectionImpactReadClient>();
/** Exclusive, fixed-selection, explicit read-only component. Host must dispose on logout/purpose/navigation changes. */
export function mountCorrectionImpactRead(
  root: HTMLElement,
  client: CorrectionImpactReadClient,
  selected: CorrectionImpactSelection,
): { dispose(): void } {
  if (
    !(client instanceof CorrectionImpactReadClient) ||
    root.ownerDocument.location.origin !== client.origin ||
    !root.isConnected ||
    !root.ownerDocument.defaultView?.MutationObserver ||
    client.closed ||
    client.busy ||
    owners.has(client)
  )
    throw Error("correction-impact_view_unavailable");
  const choice = captureCorrectionImpactSelection(client.scope, selected),
    document = root.ownerDocument;
  const section = document.createElement("section"),
    button = document.createElement("button"),
    status = document.createElement("p"),
    content = document.createElement("div");
  section.setAttribute("aria-label", "Private selected correction-impact read");
  button.type = "button";
  button.textContent = "Read current selected correction-impact";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent =
    "No request made. All historical plan editions and missing dependencies stay visible.";
  const selection = document.createElement("p");
  selection.textContent =
    "Exact selected correction-impact: " + JSON.stringify(choice);
  section.append(selection, button, status, content);
  root.replaceChildren(section);
  owners.add(client);
  let disposed = false,
    busy = false;
  const live = () =>
    !disposed &&
    root.isConnected &&
    root.contains(section) &&
    root.contains(content) &&
    root.contains(button) &&
    root.contains(status);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    client.dispose();
    owners.delete(client);
    button.removeEventListener("click", read);
    section.remove();
    content.replaceChildren();
  };
  const observer = new document.defaultView!.MutationObserver(() => {
    if (!live()) dispose();
  });
  const read = async () => {
    if (!live()) {
      dispose();
      return;
    }
    if (busy || client.closed || client.busy) return;
    busy = true;
    button.disabled = true;
    content.replaceChildren();
    status.textContent = "Reading current private correction-impact metadata…";
    try {
      const frame = await client.read(choice);
      if (!live() || client.closed) {
        dispose();
        return;
      }
      const view = renderSelectedCorrectionImpactFrame(
        document,
        client.scope,
        choice,
        JSON.stringify(frame),
      );
      if (!live() || client.closed) {
        dispose();
        return;
      }
      content.replaceChildren(view);
      status.textContent =
        "Selected private correction-impact metadata captured. Not findings, closure or future permission.";
    } catch {
      if (!live()) {
        dispose();
        return;
      }
      content.replaceChildren();
      status.textContent = client.closed
        ? "Session changed or view closed. Reopen through the authenticated host."
        : "Current read unavailable. No observations displayed. An explicit new read is required.";
    } finally {
      busy = false;
      if (live()) button.disabled = client.closed;
    }
  };
  button.addEventListener("click", read);
  observer.observe(document, { childList: true, subtree: true });
  return { dispose };
}
