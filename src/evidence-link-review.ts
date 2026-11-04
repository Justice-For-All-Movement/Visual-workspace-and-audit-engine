import { inspectEvidenceLinks } from "@accountability/knowledge-verification/evidence-links";
import type { EvidenceLinksState } from "@accountability/knowledge-verification/evidence-links";
import type { KnowledgeState } from "@accountability/knowledge-verification";
import {
  EVIDENCE_LINKS_KIND,
  EVIDENCE_LINKS_KEY,
} from "@accountability/knowledge-verification/repository";
import {
  canonical,
  invariant,
  refKey,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Json, Ref } from "./contracts.ts";
import { layoutWorkspace } from "./index.ts";
import type { WorkspaceSnapshot, WorkStage } from "./index.ts";
import { projectKnowledgeRecord } from "./knowledge-review.ts";

/** Literal authorized owning captures; never a current Evidence/Consent service observation. */
export function projectKnowledgeEvidenceLinks(
  context: Context,
  knowledgeInput: Readonly<{ revision: number; state: KnowledgeState }>,
  linksInput: Readonly<{
    revision: number;
    state: EvidenceLinksState;
    knowledgeRevision: number;
  }>,
  selected: Ref,
  stage: WorkStage,
): WorkspaceSnapshot {
  invariant(
    Buffer.byteLength(canonical({ knowledgeInput, linksInput })) <=
      5 * 1024 * 1024,
    "projection_too_large",
    "Link input exceeds 5MiB",
  );
  const c = structuredClone(context),
    knowledge = structuredClone(knowledgeInput),
    links = structuredClone(linksInput),
    choice = structuredClone(selected);
  invariant(
    Object.keys(links).length === 3 &&
      ["revision", "state", "knowledgeRevision"].every((k) =>
        Object.hasOwn(links, k),
      ),
    "invalid_link_snapshot",
    "Exact owning link snapshot required",
  );
  const records = inspectEvidenceLinks(c, links.state);
  invariant(
    Number.isSafeInteger(links.revision) &&
      links.revision === records.length &&
      links.knowledgeRevision === knowledge.revision,
    "invalid_link_snapshot",
    "Containing storage revisions differ",
  );
  const check = (r: Ref) => {
    validateRef(r);
    requireScope(c, r);
    invariant(
      Object.keys(r).length === 5,
      "invalid_reference",
      "Exact reference required",
    );
  };
  check(choice);
  for (const r of records) {
    check(r.ref);
    check(r.claim);
    if (r.supersedes) check(r.supersedes);
    invariant(
      r.purpose === c.purpose,
      "purpose_denied",
      "Exact link purpose required",
    );
  }
  const record = records.find((r) => canonical(r.ref) === canonical(choice));
  invariant(
    record,
    "missing_reference",
    "Exact captured link edition required",
  );
  const base = projectKnowledgeRecord(c, knowledge, record.claim, stage);
  const view = { ...base, nodes: [...base.nodes] };
  const containing = validateRef({
    tenantId: c.tenantId,
    projectId: c.projectId,
    kind: EVIDENCE_LINKS_KIND,
    id: EVIDENCE_LINKS_KEY,
    revision: links.revision,
  });
  const used = new Set(view.nodes.map((n) => refKey(n.ref)));
  const add = (n: WorkspaceSnapshot["nodes"][number]) => {
    invariant(
      !used.has(refKey(n.ref)),
      "reference_collision",
      "Distinct captured projection roles required",
    );
    used.add(refKey(n.ref));
    view.nodes.push(n);
  };
  add({
    ref: containing,
    label: "Captured Evidence-link storage edition",
    kind: "artifact",
    state: "captured-storage-edition",
    stage,
    dependencies: [],
    summary: "Observed owning storage revision, not a citation creation audit.",
    details: { revision: links.revision },
  });
  const evidence: Ref[] = [];
  for (const link of record.links) {
    const r = link.selector.evidence;
    check(r);
    if (evidence.some((x) => canonical(x) === canonical(r))) continue;
    evidence.push(r);
    add({
      ref: r,
      label: "Referenced Evidence edition (not loaded)",
      kind: "source",
      state: "stored-reference-not-revalidated",
      stage,
      dependencies: [],
      summary:
        "Only stored selectors/fingerprints/family metadata. Current Evidence, Consent, original bytes and independence were not checked.",
      details: JSON.parse(
        canonical({
          links: record.links.filter(
            (l) => canonical(l.selector.evidence) === canonical(r),
          ),
          notice:
            "Stored citation metadata only; repeated links do not prove independent corroboration.",
        }),
      ) as Json,
    });
  }
  const latest = records
    .filter((r) => r.ref.kind === choice.kind && r.ref.id === choice.id)
    .at(-1)!;
  add({
    ref: record.ref,
    label: "Exact captured Evidence-link edition",
    kind: "artifact",
    state:
      canonical(latest.ref) === canonical(choice)
        ? "latest-captured-link-edition"
        : "historical-captured-link-edition",
    stage,
    dependencies: [containing, record.claim, ...evidence],
    summary: record.links.length
      ? "Literal support/challenge/quote assertions; no source-use permit or verified finding."
      : "Empty captured citation set is not absence-of-evidence proof.",
    details: JSON.parse(
      canonical({
        record,
        latestCapturedRef: latest.ref,
        containingStorage: containing,
        notice:
          "Actor/time/request are record metadata, not authentication or audit events.",
      }),
    ) as Json,
  });
  view.title = "Private Knowledge Evidence-link review";
  invariant(
    view.nodes.length <= 256 &&
      view.nodes.reduce((sum, n) => sum + n.dependencies.length, 0) <= 512 &&
      Buffer.byteLength(canonical(view)) <= 512 * 1024,
    "projection_too_large",
    "Link view exceeds output budget",
  );
  layoutWorkspace(c, view);
  return view;
}
