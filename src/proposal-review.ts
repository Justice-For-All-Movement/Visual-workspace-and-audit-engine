import { inspectClaimProposals } from "@accountability/knowledge-verification/claim-proposal-review";
import {
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
  EVIDENCE_LINKS_KIND,
  EVIDENCE_LINKS_KEY,
} from "@accountability/knowledge-verification/repository";
import { canonical, invariant, refKey, validateRef } from "./contracts.ts";
import type { Context, Ref, Json } from "./contracts.ts";
import { layoutWorkspace } from "./index.ts";
import type { WorkspaceSnapshot, VisualNode, WorkStage } from "./index.ts";
/** Captured private proposals only; no current service observation, acceptance or permission control. */
export function projectClaimProposals(
  context: Context,
  input: unknown,
  stage: WorkStage,
): WorkspaceSnapshot {
  const c = structuredClone(context),
    b = inspectClaimProposals(c, input);
  const storage = (kind: string, id: string, revision: number) =>
    validateRef({
      tenantId: c.tenantId,
      projectId: c.projectId,
      kind,
      id,
      revision,
    });
  const knowledge = storage(
      KNOWLEDGE_KIND,
      KNOWLEDGE_KEY,
      b.basis.knowledgeRevision,
    ),
    links = storage(
      EVIDENCE_LINKS_KIND,
      EVIDENCE_LINKS_KEY,
      b.basis.linksRevision,
    );
  const nodes: VisualNode[] = [];
  const used = new Set<string>();
  const add = (node: VisualNode) => {
    invariant(
      !used.has(refKey(node.ref)),
      "reference_collision",
      "Distinct captured projection roles required",
    );
    used.add(refKey(node.ref));
    nodes.push(node);
  };
  for (const ref of [knowledge, links])
    add({
      ref,
      label: "Observed containing storage edition",
      kind: "artifact",
      state: "captured-storage-edition",
      stage,
      dependencies: [],
      summary:
        "Captured owning storage revision; not a record creation audit or live permission.",
      details: { revision: ref.revision },
    });
  add({
    ref: b.basis.claimRef,
    label: "Referenced claim edition (not loaded)",
    kind: "claim",
    state: "referenced-claim-not-loaded",
    stage,
    dependencies: [knowledge],
    summary:
      "Only the exact referenced claim edition is available; its assertion/history were not independently loaded.",
    details: { reference: b.basis.claimRef },
  });
  const sources: Ref[] = [];
  for (const p of b.proposals) {
    const ref = p.citation.selector.evidence;
    if (sources.some((s) => canonical(s) === canonical(ref))) continue;
    sources.push(ref);
    add({
      ref,
      label: "Referenced Evidence edition (not loaded)",
      kind: "source",
      state: "referenced-evidence-not-loaded",
      stage,
      dependencies: [],
      summary:
        "Original bytes, current Evidence/Consent permissions and source truth were not checked by this view.",
      details: JSON.parse(
        canonical({
          reference: ref,
          observations: b.proposals
            .filter(
              (x) => canonical(x.citation.selector.evidence) === canonical(ref),
            )
            .map((x) => ({ proposalId: x.id, citation: x.citation })),
        }),
      ) as Json,
    });
  }
  add({
    ref: b.basis.linkRef,
    label: "Unpersisted proposal review for captured citation set",
    kind: "artifact",
    state: "captured-unassessed-proposals",
    stage,
    dependencies: [links, b.basis.claimRef, ...sources],
    summary:
      "Derived untrusted proposals for human review. Proposal IDs are local metadata, not stored records, accepted answers, findings or publication approval.",
    details: JSON.parse(
      canonical({
        viewType: "derived-unpersisted-proposal-view",
        basis: b.basis,
        proposals: b.proposals,
        capturedDigest: b.digest,
        notice:
          "A recomputable digest and captured metadata are not authentication or current use authority; this view did not run owning services.",
      }),
    ) as Json,
  });
  const view: WorkspaceSnapshot = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    title: "Private unassessed claim proposals",
    capturedAt: c.now,
    nodes,
    events: [],
    agents: [],
  };
  invariant(
    nodes.length <= 256 &&
      nodes.reduce((sum, n) => sum + n.dependencies.length, 0) <= 512 &&
      Buffer.byteLength(canonical(view)) <= 512 * 1024,
    "projection_too_large",
    "Proposal view exceeds budget",
  );
  layoutWorkspace(c, view);
  return view;
}

import { renderWorkspace } from "./index.ts";
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** Read-only private review: literal assertions, exact excerpts and shared graph/table inspectors. */
export function renderClaimProposalReview(
  context: Context,
  input: unknown,
  stage: WorkStage,
): string {
  const c = structuredClone(context),
    b = inspectClaimProposals(c, input);
  const graph = renderWorkspace(c, projectClaimProposals(c, b, stage));
  const cards = b.proposals
    .map(
      (p, i) =>
        `<article class="proposal"><h3>Unassessed proposal ${i + 1}</h3><p>${escape(p.assertion)}</p><blockquote>${escape(p.citation.excerpt.quote)}</blockquote><p>Recorded relation: ${escape(p.citation.relation)}. Source edition ${p.citation.selector.evidence.revision}; page ${p.citation.selector.page === null ? "not specified" : p.citation.selector.page}; excerpt characters ${p.citation.excerpt.start}–${p.citation.excerpt.end} (half-open UTF16).</p><details><summary>Exact citation and proposal metadata</summary><pre>${escape(JSON.stringify(p, null, 2))}</pre></details></article>`,
    )
    .join("");
  const section = `<section aria-label="Unassessed proposal review"><h2>Proposals for human review</h2><p>Private captured review. These unpersisted assertions are not accepted answers, verified findings or publication approvals. Source bytes and current permissions were not checked by this view. Capture metadata and its digest are not authentication.</p>${cards}</section>`;
  invariant(
    graph.includes("</main>"),
    "invalid_render",
    "Review layout required",
  );
  const html = graph.replace("</main>", () => `${section}</main>`);
  invariant(
    Buffer.byteLength(html) <= 2 * 1024 * 1024,
    "projection_too_large",
    "Private review HTML exceeds 2MiB",
  );
  return html;
}
