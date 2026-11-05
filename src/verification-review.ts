import { inspectKnowledge } from "@accountability/knowledge-verification";
import type { KnowledgeState } from "@accountability/knowledge-verification";
import { inspectEvidenceLinks } from "@accountability/knowledge-verification/evidence-links";
import type { EvidenceLinksState } from "@accountability/knowledge-verification/evidence-links";
import { inspectVerificationReviews } from "@accountability/knowledge-verification/verification-review";
import type { VerificationReviewState } from "@accountability/knowledge-verification/verification-review";
import {
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
  EVIDENCE_LINKS_KIND,
  EVIDENCE_LINKS_KEY,
  VERIFICATION_REVIEWS_KIND,
  VERIFICATION_REVIEWS_KEY,
} from "@accountability/knowledge-verification/repository";
import {
  canonical,
  invariant,
  refKey,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { KnowledgeRepository } from "@accountability/knowledge-verification/repository";
import type { Context, Json, Ref } from "./contracts.ts";
import { layoutWorkspace, renderWorkspace } from "./index.ts";
import type { WorkspaceSnapshot, VisualNode, WorkStage } from "./index.ts";

type KnowledgeCapture = Readonly<{ revision: number; state: KnowledgeState }>;
type LinksCapture = Readonly<{
  revision: number;
  state: EvidenceLinksState;
  knowledgeRevision: number;
}>;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const json = (value: unknown): Json => JSON.parse(canonical(value));
function exact(value: object, keys: string[]) {
  invariant(
    Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
    "invalid_review_snapshot",
    "Exact owning capture required",
  );
}
/** Captured human observations only. No owning review storage revision, service authentication or truth is inferred. */
export function projectVerificationReview(
  context: Context,
  knowledgeInput: KnowledgeCapture,
  linksInput: LinksCapture,
  reviewInput: VerificationReviewState,
  selected: Ref,
  stage: WorkStage,
): WorkspaceSnapshot {
  invariant(
    Buffer.byteLength(
      canonical({ knowledgeInput, linksInput, reviewInput, selected }),
    ) <=
      5 * 1024 * 1024,
    "projection_too_large",
    "Verification input exceeds 5MiB",
  );
  const c = structuredClone(context),
    knowledge = structuredClone(knowledgeInput),
    links = structuredClone(linksInput),
    reviews = structuredClone(reviewInput),
    choice = structuredClone(selected);
  exact(knowledge, ["revision", "state"]);
  exact(links, ["revision", "state", "knowledgeRevision"]);
  const claims = inspectKnowledge(c, knowledge.state),
    citations = inspectEvidenceLinks(c, links.state),
    observed = inspectVerificationReviews(
      c,
      knowledge.state,
      links.state,
      reviews,
    );
  invariant(
    Number.isSafeInteger(knowledge.revision) &&
      knowledge.revision === knowledge.state.records.length &&
      Number.isSafeInteger(links.revision) &&
      links.revision === links.state.records.length &&
      links.knowledgeRevision === knowledge.revision,
    "invalid_review_snapshot",
    "Containing capture revisions differ",
  );
  validateRef(choice);
  requireScope(c, choice);
  exact(choice, ["tenantId", "projectId", "kind", "id", "revision"]);
  const record = observed.history.find((r) => same(r.ref, choice));
  invariant(
    record,
    "missing_reference",
    "Exact captured review edition required",
  );
  const latest = observed.latest.find(
    (x) => x.record.ref.id === record.ref.id,
  )!;
  const selectedRecords = [record, latest.record];
  if (record.supersedes)
    selectedRecords.push(
      observed.history.find((r) => same(r.ref, record.supersedes))!,
    );
  const unique = selectedRecords.filter(
    (r, i, a) => a.findIndex((x) => same(x.ref, r.ref)) === i,
  );
  const nodes: VisualNode[] = [];
  const add = (node: VisualNode) => {
    validateRef(node.ref);
    requireScope(c, node.ref);
    invariant(
      !nodes.some((n) => refKey(n.ref) === refKey(node.ref)),
      "reference_collision",
      "Distinct captured roles required",
    );
    nodes.push(node);
  };
  const containing = (kind: string, id: string, revision: number) => {
    if (!revision) return null;
    const ref = validateRef({
      tenantId: c.tenantId,
      projectId: c.projectId,
      kind,
      id,
      revision,
    });
    add({
      ref,
      label: "Captured containing storage edition",
      kind: "artifact",
      state: "captured-storage-edition",
      stage,
      dependencies: [],
      summary:
        "Captured Knowledge/link storage only; not a review storage revision or audit.",
      details: { revision },
    });
    return ref;
  };
  const knowledgeStorage = containing(
      KNOWLEDGE_KIND,
      KNOWLEDGE_KEY,
      knowledge.revision,
    ),
    linksStorage = containing(
      EVIDENCE_LINKS_KIND,
      EVIDENCE_LINKS_KEY,
      links.revision,
    );
  const claimRefs: Ref[] = [],
    linkRefs: Ref[] = [],
    sourceRefs: Ref[] = [];
  for (const r of unique) {
    if (!claimRefs.some((x) => same(x, r.claim))) {
      claimRefs.push(r.claim);
      const claim = claims.find((x) => same(x.ref, r.claim));
      add({
        ref: r.claim,
        label: claim
          ? "Exact captured claim edition"
          : "Referenced claim edition (not loaded)",
        kind: "claim",
        state: claim
          ? "captured-unassessed-claim"
          : "referenced-claim-not-loaded",
        stage,
        dependencies: knowledgeStorage ? [knowledgeStorage] : [],
        summary:
          "A captured assertion or missing capture is not verified truth or deletion proof.",
        details: json(claim ? { record: claim } : { reference: r.claim }),
      });
    }
    if (!linkRefs.some((x) => same(x, r.linkRef))) {
      linkRefs.push(r.linkRef);
      const citation = citations.find((x) => same(x.ref, r.linkRef));
      const evidence: Ref[] = [];
      for (const l of citation?.links ?? []) {
        const ref = l.selector.evidence;
        if (!evidence.some((x) => same(x, ref))) evidence.push(ref);
        if (!sourceRefs.some((x) => same(x, ref))) {
          sourceRefs.push(ref);
          add({
            ref,
            label: "Referenced Evidence edition (not loaded)",
            kind: "source",
            state: "referenced-evidence-not-loaded",
            stage,
            dependencies: [],
            summary:
              "No current Evidence/Consent, original bytes or independence observation was performed.",
            details: json({
              reference: ref,
              notice:
                "Only exact captured source references; no source truth or permission.",
            }),
          });
        }
      }
      add({
        ref: r.linkRef,
        label: citation
          ? "Exact captured citation-set edition"
          : "Referenced citation set (not loaded)",
        kind: "artifact",
        state: citation
          ? "captured-citation-set"
          : "referenced-citation-set-not-loaded",
        stage,
        dependencies: [...(linksStorage ? [linksStorage] : []), ...evidence],
        summary:
          "Literal support/challenge/quote metadata; absent capture is not deletion or absence proof.",
        details: json(
          citation ? { record: citation } : { reference: r.linkRef },
        ),
      });
    }
  }
  for (const r of unique) {
    const isLatest = same(r.ref, latest.record.ref);
    add({
      ref: r.ref,
      label: "Captured unresolved human verification observation",
      kind: "artifact",
      state: isLatest
        ? "latest-captured-unresolved-review"
        : "historical-captured-unresolved-review",
      stage,
      dependencies: [
        r.claim,
        r.linkRef,
        ...(r.supersedes && unique.some((x) => same(x.ref, r.supersedes))
          ? [r.supersedes]
          : []),
      ],
      summary:
        "Reviewer assertions remain unresolved even when all four checks say reviewed; no finding, answer, closure or approval.",
      details: json({
        record: r,
        selected: same(r.ref, choice),
        latestCapturedRef: latest.record.ref,
        latestReviewBasisStatus: latest.basisStatus,
        capturedHistoryCount: observed.history.length,
        notice:
          "Pure captured review history has no supplied owning SQL storage edition. Actor/time are record metadata, not authenticated audits.",
      }),
    });
  }
  const view: WorkspaceSnapshot = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    title: "Private unresolved verification observations",
    capturedAt: c.now,
    nodes,
    events: [],
    agents: [],
  };
  invariant(
    nodes.length <= 256 &&
      nodes.reduce((n, x) => n + x.dependencies.length, 0) <= 512 &&
      Buffer.byteLength(canonical(view)) <= 512 * 1024,
    "projection_too_large",
    "Verification projection exceeds budget",
  );
  layoutWorkspace(c, view);
  return view;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** Literal notes and exact shared graph/table inspectors, with no mutation or current service call. */
export function renderVerificationReview(
  context: Context,
  knowledge: KnowledgeCapture,
  links: LinksCapture,
  reviews: VerificationReviewState,
  selected: Ref,
  stage: WorkStage,
): string {
  const c = structuredClone(context),
    view = projectVerificationReview(
      c,
      knowledge,
      links,
      reviews,
      selected,
      stage,
    ),
    html = renderReviewSnapshot(c, view);
  return html;
}
function renderReviewSnapshot(c: Context, view: WorkspaceSnapshot): string {
  const graph = renderWorkspace(c, view);
  const cards = view.nodes
    .filter((n) => n.ref.kind === "knowledge-verification-review")
    .map((n) => {
      const d = n.details as unknown as {
          record: VerificationReviewState["records"][number];
          selected: boolean;
          latestReviewBasisStatus: string;
          containingStorage?: Ref;
        },
        r = d.record;
      const checks = Object.entries(r.checks)
        .map(
          ([axis, check]) =>
            `<dt>${escape(axis)}: ${escape(check.status)}</dt><dd>${escape(check.note)}</dd>`,
        )
        .join("");
      const storage = d.containingStorage
        ? `<p>Observed verification storage revision ${d.containingStorage.revision}; this containing edition does not establish when the selected record was created.</p>`
        : "";
      return `<article><h3>${d.selected ? "Selected" : "Related"} captured review edition ${r.ref.revision}</h3><p>Resolution: unresolved. Latest captured review basis: ${escape(d.latestReviewBasisStatus)}.</p>${storage}<dl>${checks}</dl><p>${escape(r.rationale)}</p><p>Captured record actor: ${escape(r.actorId)}. Captured record time: ${escape(r.createdAt)}. These fields are not authenticated audit events.</p><p>Captured contrary citation IDs: ${r.challengeLinkIds.length ? r.challengeLinkIds.map(escape).join(", ") : "none recorded; not completeness proof"}.</p></article>`;
    })
    .join("");
  const section = `<section aria-label="Unresolved verification observations"><h2>Human verification observations</h2><p>Private captured assertions. All checks remain separate from verified findings, answers, case closure and publication approval. Current source/Consent permission and original bytes were not checked by this view.</p>${cards}</section>`;
  invariant(
    graph.includes("</main>"),
    "invalid_render",
    "Review layout required",
  );
  const html = graph.replace("</main>", () => `${section}</main>`);
  invariant(
    Buffer.byteLength(html) <= 2 * 1024 * 1024,
    "projection_too_large",
    "Verification HTML exceeds 2MiB",
  );
  return html;
}

/** Actual owning repository result shape; supplied capture metadata is not authentication. */
export type VerificationCapture = Awaited<
  ReturnType<KnowledgeRepository["loadVerificationReviews"]>
>;
export function projectStoredVerificationReview(
  context: Context,
  knowledgeInput: KnowledgeCapture,
  linksInput: LinksCapture,
  reviewInput: VerificationCapture,
  selected: Ref,
  stage: WorkStage,
): WorkspaceSnapshot {
  invariant(
    Buffer.byteLength(
      canonical({ knowledgeInput, linksInput, reviewInput, selected }),
    ) <=
      5 * 1024 * 1024,
    "projection_too_large",
    "Stored verification input exceeds 5MiB",
  );
  const c = structuredClone(context),
    knowledge = structuredClone(knowledgeInput),
    links = structuredClone(linksInput),
    reviews = structuredClone(reviewInput),
    choice = structuredClone(selected);
  exact(reviews, [
    "revision",
    "state",
    "knowledgeRevision",
    "linksRevision",
    "latest",
  ]);
  invariant(
    Number.isSafeInteger(reviews.revision) &&
      reviews.revision === reviews.state.records.length &&
      reviews.knowledgeRevision === knowledge.revision &&
      reviews.linksRevision === links.revision,
    "invalid_review_snapshot",
    "Owning verification containing revisions differ",
  );
  const observed = inspectVerificationReviews(
    c,
    knowledge.state,
    links.state,
    reviews.state,
  );
  invariant(
    same(
      reviews.latest,
      observed.latest.map(({ record, basisStatus }) => ({
        ref: record.ref,
        basisStatus,
      })),
    ),
    "invalid_review_snapshot",
    "Owning verification latest metadata differs",
  );
  const base = projectVerificationReview(
    c,
    knowledge,
    links,
    reviews.state,
    choice,
    stage,
  );
  const storage = validateRef({
    tenantId: c.tenantId,
    projectId: c.projectId,
    kind: VERIFICATION_REVIEWS_KIND,
    id: VERIFICATION_REVIEWS_KEY,
    revision: reviews.revision,
  });
  invariant(
    !base.nodes.some((n) => refKey(n.ref) === refKey(storage)),
    "reference_collision",
    "Distinct verification containing edition required",
  );
  const nodes: VisualNode[] = [
    ...base.nodes.map((n) =>
      n.ref.kind !== "knowledge-verification-review"
        ? n
        : {
            ...n,
            dependencies: [...n.dependencies, storage],
            details: json({
              ...(n.details as Record<string, Json>),
              containingStorage: storage,
              notice:
                "Supplied owning containing storage edition; record actor/time are captured metadata, not authenticated audits or creation-storage proof.",
            }),
          },
    ),
    {
      ref: storage,
      label: "Captured verification storage edition",
      kind: "artifact",
      state: "captured-storage-edition",
      stage,
      dependencies: [],
      summary:
        "Observed owning aggregate revision, not a record creation edition, current authorization or source attestation.",
      details: {
        revision: reviews.revision,
        knowledgeRevision: reviews.knowledgeRevision,
        linksRevision: reviews.linksRevision,
      },
    },
  ];
  const view = { ...base, nodes };
  invariant(
    nodes.length <= 256 &&
      nodes.reduce((n, x) => n + x.dependencies.length, 0) <= 512 &&
      Buffer.byteLength(canonical(view)) <= 512 * 1024,
    "projection_too_large",
    "Stored verification projection exceeds budget",
  );
  layoutWorkspace(c, view);
  return view;
}
export function renderStoredVerificationReview(
  context: Context,
  knowledge: KnowledgeCapture,
  links: LinksCapture,
  reviews: VerificationCapture,
  selected: Ref,
  stage: WorkStage,
): string {
  const c = structuredClone(context);
  return renderReviewSnapshot(
    c,
    projectStoredVerificationReview(
      c,
      knowledge,
      links,
      reviews,
      selected,
      stage,
    ),
  );
}
