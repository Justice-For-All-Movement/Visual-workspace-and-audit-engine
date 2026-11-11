import {
  AcceptanceWriteClient,
  captureAcceptanceWriteCommand,
} from "./acceptance-write-client.ts";
import type { AcceptanceAcknowledgement } from "./acceptance-write-client.ts";
import type { ProposalAcceptanceInput } from "@accountability/knowledge-verification/proposal-acceptance";
import { renderSelectedAcceptanceFrame } from "./selected-acceptance.ts";
const owners = new WeakSet<AcceptanceWriteClient>();
/** Fixed captured intent only. Host must dispose/recover pending state on session/purpose/navigation changes. */
export function mountAcceptanceWrite(
  root: HTMLElement,
  client: AcceptanceWriteClient,
  commandId: string,
  bundle: unknown,
  input: ProposalAcceptanceInput,
): { dispose(): void } {
  if (
    !(client instanceof AcceptanceWriteClient) ||
    client.closed ||
    client.busy ||
    client.pending ||
    owners.has(client) ||
    !root.isConnected ||
    root.ownerDocument.location.origin !== client.origin ||
    !root.ownerDocument.defaultView?.MutationObserver
  )
    throw Error("acceptance_view_unavailable");
  const command = captureAcceptanceWriteCommand(
      client.scope,
      client.purpose,
      commandId,
      bundle,
      input,
    ),
    d = root.ownerDocument;
  const section = d.createElement("section"),
    title = d.createElement("h2"),
    notice = d.createElement("p"),
    metadata = d.createElement("pre"),
    label = d.createElement("label"),
    affirm = d.createElement("input"),
    accept = d.createElement("button"),
    replay = d.createElement("button"),
    read = d.createElement("button"),
    status = d.createElement("p"),
    content = d.createElement("div");
  section.setAttribute("aria-label", "Private unassessed proposal acceptance");
  title.textContent = "Review original acceptance intent";
  notice.textContent =
    "Untrusted captured assertion. Acceptance remains private and unassessed, with quote-only citations. Current backend authorization is required. Unknown outcomes require identical manual replay; no rebasing or second claim is automatic.";
  metadata.textContent = JSON.stringify(command, null, 2);
  affirm.type = "checkbox";
  label.append(
    affirm,
    d.createTextNode(
      " I intend to accept this exact proposal as a new private unassessed assertion.",
    ),
  );
  accept.type = replay.type = read.type = "button";
  accept.textContent = "Accept exact private proposal";
  replay.textContent = "Replay identical pending command";
  read.textContent = "Read acknowledged acceptance";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "No request made.";
  section.append(
    title,
    notice,
    metadata,
    label,
    accept,
    replay,
    read,
    status,
    content,
  );
  root.replaceChildren(section);
  owners.add(client);
  let disposed = false,
    busy = false,
    ack: AcceptanceAcknowledgement | null = null;
  const live = () =>
    !disposed &&
    root.isConnected &&
    root.contains(section) &&
    section.contains(affirm) &&
    section.contains(accept) &&
    section.contains(replay) &&
    section.contains(read) &&
    section.contains(content) &&
    section.contains(status);
  const refresh = () => {
    affirm.disabled = busy || !!client.pending || !!ack || client.closed;
    accept.disabled =
      busy || !affirm.checked || !!client.pending || !!ack || client.closed;
    replay.disabled = busy || !client.pending || client.closed;
    read.disabled = busy || !!client.pending || !ack || client.closed;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    client.dispose();
    owners.delete(client);
    affirm.removeEventListener("change", change);
    accept.removeEventListener("click", submit);
    replay.removeEventListener("click", retry);
    read.removeEventListener("click", load);
    content.replaceChildren();
    section.remove();
    ack = null;
  };
  const observer = new d.defaultView!.MutationObserver(() => {
    if (!live()) dispose();
  });
  const action = async (fn: () => Promise<void>) => {
    if (!live()) {
      dispose();
      return;
    }
    if (busy || client.busy || client.closed) return;
    busy = true;
    content.replaceChildren();
    refresh();
    try {
      await fn();
      if (!live() || client.closed) {
        dispose();
        return;
      }
    } catch {
      if (!live() || client.closed) {
        dispose();
        return;
      }
      status.textContent = client.pending
        ? "Outcome unavailable. Keep the original pending command; only explicit identical replay is available."
        : "Request unavailable. No automatic retry was made.";
    } finally {
      busy = false;
      if (live()) refresh();
    }
  };
  const change = () => {
    if (!live()) {
      dispose();
      return;
    }
    refresh();
  };
  const submit = () => {
    if (!affirm.checked || client.pending || ack) return;
    void action(async () => {
      status.textContent = "Submitting exact private acceptance…";
      ack = await client.accept(
        command.commandId,
        command.bundle,
        command.input,
      );
      status.textContent =
        "Acceptance acknowledged. Still unassessed; explicitly read the exact returned acceptance.";
    });
  };
  const retry = () => {
    if (!client.pending) return;
    void action(async () => {
      status.textContent = "Replaying identical pending command…";
      ack = await client.retryPending();
      status.textContent =
        "Historical acknowledgement recovered. Explicit current read is separate.";
    });
  };
  const load = () => {
    if (!ack || client.pending) return;
    const selected = { ...ack.acceptance };
    void action(async () => {
      status.textContent = "Reading current private acceptance…";
      const frame = await client.readAcceptance(selected);
      if (!live() || client.closed) return;
      content.replaceChildren(
        renderSelectedAcceptanceFrame(
          d,
          client.scope,
          selected,
          JSON.stringify(frame),
        ),
      );
      status.textContent =
        "Private unassessed acceptance observed. No source truth or future permission is inferred.";
    });
  };
  affirm.addEventListener("change", change);
  accept.addEventListener("click", submit);
  replay.addEventListener("click", retry);
  read.addEventListener("click", load);
  observer.observe(d.documentElement, { subtree: true, childList: true });
  refresh();
  return { dispose };
}
