import { CoverageReadClient } from "./coverage-client.ts";
import {
  captureCoverageSelection,
  renderSelectedCoverageFrame,
} from "./selected-coverage.ts";
import type { CoverageRef } from "./selected-coverage.ts";

const owners = new WeakSet<CoverageReadClient>();
/** Exclusive, fixed-selection, explicit read-only component. Host must dispose on logout/purpose/navigation changes. */
export function mountCoverageRead(
  root: HTMLElement,
  client: CoverageReadClient,
  selected: CoverageRef,
): { dispose(): void } {
  if (
    !(client instanceof CoverageReadClient) ||
    root.ownerDocument.location.origin !== client.origin ||
    !root.isConnected ||
    !root.ownerDocument.defaultView?.MutationObserver ||
    client.closed ||
    client.busy ||
    owners.has(client)
  )
    throw Error("coverage_view_unavailable");
  const choice = captureCoverageSelection(client.scope, selected),
    document = root.ownerDocument;
  const section = document.createElement("section"),
    button = document.createElement("button"),
    status = document.createElement("p"),
    content = document.createElement("div");
  section.setAttribute("aria-label", "Private selected coverage read");
  button.type = "button";
  button.textContent = "Read current selected coverage";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "No request made. Questions remain unresolved.";
  const selection = document.createElement("p");
  selection.textContent = "Exact selected coverage: " + JSON.stringify(choice);
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
    status.textContent = "Reading current private coverage metadata…";
    try {
      const frame = await client.read(choice);
      if (!live() || client.closed) {
        dispose();
        return;
      }
      const view = renderSelectedCoverageFrame(
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
        "Selected private coverage metadata captured. Not findings or future permission.";
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
