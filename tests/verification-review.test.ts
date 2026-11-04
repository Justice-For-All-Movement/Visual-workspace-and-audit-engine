import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as e from "@accountability/evidence";
import {
  createKnowledgeState,
  reviseKnowledge,
} from "@accountability/knowledge-verification";
import {
  createEvidenceLinksState,
  reviseEvidenceLinks,
} from "@accountability/knowledge-verification/evidence-links";
import {
  projectVerificationReview,
  renderVerificationReview,
} from "../src/verification-review.ts";
import {
  createVerificationReviewState,
  recordVerificationReview,
} from "@accountability/knowledge-verification/verification-review";
import { renderWorkspace } from "../src/index.ts";
const c = {
  tenantId: "fiction",
  projectId: "links",
  actor: { id: "reviewer", kind: "human" as const, roles: ["researcher"] },
  purpose: "review",
  requestId: "fixture",
  now: "2026-01-01T00:00:00Z",
};
function setup() {
  let evidence = e.acquireEvidence(e.createEvidenceState(c), c, {
    id: "source",
    bytes: Buffer.from("Fictional bytes"),
    acquisitionId: "acq",
    storageVersionRef: "private-object",
    mediaType: "text/plain",
    sourceFamilyId: null,
    capturedAt: c.now,
    originalLanguage: "und",
    allowedPurposes: ["review"],
    supersedes: null,
  });
  const v = evidence.versions[0]!;
  evidence = e.beginScan(evidence, c, {
    id: "start",
    evidence: v.ref,
    attemptId: "scan",
    engineVersion: "synthetic-only",
  });
  evidence = e.completeScan(evidence, c, {
    id: "complete",
    evidence: v.ref,
    attemptId: "scan",
    sha256: v.sha256,
    status: "clean",
    reason: "Synthetic, not deployed malware qualification",
  });
  const value = {
    type: "claim" as const,
    text: "</script><script>window.injected=true</script>",
    subjectRefs: [],
    time: { earliest: null, latest: null },
    accountType: "observation" as const,
    limitations: [],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  const knowledge = reviseKnowledge(c, createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value,
  });
  const command = {
    claim: knowledge.records[0]!.ref,
    expectedRevision: 0,
    links: [
      {
        id: "support",
        relation: "supports" as const,
        selector: { kind: "whole" as const, evidence: v.ref, sha256: v.sha256 },
      },
      {
        id: "contrary",
        relation: "challenges" as const,
        selector: { kind: "whole" as const, evidence: v.ref, sha256: v.sha256 },
      },
    ],
  };
  const state = reviseEvidenceLinks(
    c,
    knowledge,
    evidence,
    createEvidenceLinksState(c),
    command,
  );
  const checks = Object.fromEntries(
    [
      "authenticity",
      "sourceKnowledge",
      "independentSupport",
      "counterevidence",
    ].map((k) => [
      k,
      {
        status: "reviewed" as const,
        note: "Literal reviewer assertion, not work proof",
      },
    ]),
  ) as Parameters<typeof recordVerificationReview>[4]["checks"];
  const reviews = recordVerificationReview(
    c,
    knowledge,
    state,
    createVerificationReviewState(c),
    {
      linkRef: state.records[0]!.ref,
      expectedRevision: 0,
      checks,
      rationale: "Unresolved fictional review",
    },
  );
  return { knowledge, evidence, state, command, value, checks, reviews };
}

const project = (
  f: ReturnType<typeof setup>,
  selected = f.reviews.records[0]!.ref,
) =>
  projectVerificationReview(
    c,
    { revision: f.knowledge.records.length, state: f.knowledge },
    {
      revision: f.state.records.length,
      state: f.state,
      knowledgeRevision: f.knowledge.records.length,
    },
    f.reviews,
    selected,
    "tested",
  );
const render = (
  f: ReturnType<typeof setup>,
  selected = f.reviews.records[0]!.ref,
) =>
  renderVerificationReview(
    c,
    { revision: f.knowledge.records.length, state: f.knowledge },
    {
      revision: f.state.records.length,
      state: f.state,
      knowledgeRevision: f.knowledge.records.length,
    },
    f.reviews,
    selected,
    "tested",
  );

test("captured verification preserves four separate reviewed assertions, contrary IDs and exact editions without findings or invented audits", () => {
  const f = setup(),
    v = project(f),
    review = v.nodes.find(
      (n) => n.ref.kind === "knowledge-verification-review",
    )!;
  assert.equal(v.visibility, "private");
  assert.deepEqual(v.events, []);
  assert.deepEqual(v.agents, []);
  const details = review.details as any;
  assert.equal(details.record.resolution, "unresolved");
  assert.equal(details.record.assessment, null);
  assert.deepEqual(details.record.challengeLinkIds, ["contrary"]);
  assert.equal(details.latestReviewBasisStatus, "current-editions");
  assert.equal(
    v.nodes.filter((n) => n.state === "captured-storage-edition").length,
    2,
  );
  assert.ok(!v.nodes.some((n) => n.ref.kind.includes("verification-history")));
  const citation = v.nodes.find(
    (n) => n.ref.kind === "knowledge-evidence-links",
  )!;
  assert.deepEqual(
    (citation.details as any).record.links.map((x: any) => x.relation),
    ["supports", "challenges"],
  );
  assert.equal(v.nodes.filter((n) => n.ref.kind === "evidence").length, 1);
  const detached = structuredClone(details.record);
  Object.assign(f.reviews.records[0]!, { rationale: "caller mutation" });
  assert.deepEqual(details.record, detached);
});

test("corrections preserve historical contrary notes and latest captured stale-basis status without replacing old references", () => {
  const f = setup();
  f.state = reviseEvidenceLinks(c, f.knowledge, f.evidence, f.state, {
    ...f.command,
    expectedRevision: 1,
    links: [],
  });
  f.reviews = recordVerificationReview(c, f.knowledge, f.state, f.reviews, {
    linkRef: f.state.records[1]!.ref,
    expectedRevision: 1,
    checks: f.checks,
    rationale: "Later unresolved observation",
  });
  f.knowledge = reviseKnowledge(c, f.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: { ...f.value, text: "Later assertion" },
  });
  const v = project(f),
    rows = v.nodes.filter(
      (n) => n.ref.kind === "knowledge-verification-review",
    );
  assert.equal(rows.length, 2);
  const old = rows.find((n) => n.ref.revision === 1)!.details as any;
  const latest = rows.find((n) => n.ref.revision === 2)!.details as any;
  assert.deepEqual(old.record.challengeLinkIds, ["contrary"]);
  assert.deepEqual(latest.record.challengeLinkIds, []);
  assert.equal(old.record.linkRef.revision, 1);
  assert.equal(latest.record.linkRef.revision, 2);
  assert.equal(old.latestReviewBasisStatus, "needs-review");
  assert.equal(latest.record.resolution, "unresolved");
  assert.equal(
    (project(f, f.reviews.records[1]!.ref).nodes.at(-1)!.details as any).record
      .ref.revision,
    1,
  );
});

test("missing captured basis stays explicitly unloaded and never produces zero or invented containing revisions", () => {
  const f = setup();
  f.knowledge = createKnowledgeState(c);
  f.state = createEvidenceLinksState(c);
  const v = project(f),
    d = v.nodes.find((n) => n.ref.kind === "knowledge-verification-review")!
      .details as any;
  assert.equal(d.latestReviewBasisStatus, "needs-review");
  assert.equal(
    v.nodes.filter((n) => n.state === "captured-storage-edition").length,
    0,
  );
  assert.ok(v.nodes.some((n) => n.state === "referenced-claim-not-loaded"));
  assert.ok(
    v.nodes.some((n) => n.state === "referenced-citation-set-not-loaded"),
  );
  assert.ok(v.nodes.every((n) => n.ref.revision > 0));
  assert.deepEqual(d.record.challengeLinkIds, ["contrary"]);
});

test("literal hostile notes and dollar replacement markers render inert exact text with native inspectors", () => {
  const f = setup(),
    hostile = "</script><img src=x onerror=alert(1)> $& $` $' 🧭";
  const checks = {
    ...f.checks,
    counterevidence: { status: "concern" as const, note: hostile },
  };
  f.reviews = recordVerificationReview(c, f.knowledge, f.state, f.reviews, {
    linkRef: f.state.records[0]!.ref,
    expectedRevision: 1,
    checks,
    rationale: hostile,
  });
  const dom = new JSDOM(render(f, f.reviews.records[1]!.ref), {
      runScripts: "dangerously",
    }),
    doc = dom.window.document;
  assert.equal(doc.querySelectorAll("img,iframe,object,embed").length, 0);
  assert.ok(
    [...doc.querySelectorAll("dd")].some((n) => n.textContent === hostile),
  );
  assert.equal(doc.querySelectorAll("main").length, 1);
  const button = [...doc.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Captured unresolved"),
  );
  const dialog = doc.querySelector("dialog")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
    },
  });
  assert.ok(button);
  button.click();
  assert.ok(dialog.hasAttribute("open"));
  const detail = JSON.parse(doc.querySelector("#detail")!.textContent!);
  assert.equal(detail.details.record.resolution, "unresolved");
  assert.equal(detail.details.record.challengeLinkIds[0], "contrary");
  assert.ok(doc.body.textContent!.includes("knowledge-verification-review"));
  dom.window.close();
});

test("owning validators reject challenge tampering, injected approvals, foreign refs and inconsistent storage captures", () => {
  for (const alter of [
    (f: ReturnType<typeof setup>) =>
      Object.assign(f.reviews.records[0]!, { challengeLinkIds: [] }),
    (f: ReturnType<typeof setup>) =>
      Object.assign(f.reviews.records[0]!, { editorialApproval: "approved" }),
    (f: ReturnType<typeof setup>) =>
      Object.assign(f.reviews.records[0]!.ref, { projectId: "foreign" }),
  ]) {
    const f = setup();
    alter(f);
    assert.throws(() => project(f));
  }
  const f = setup();
  assert.throws(
    () =>
      projectVerificationReview(
        c,
        { revision: 2, state: f.knowledge },
        { revision: 1, state: f.state, knowledgeRevision: 1 },
        f.reviews,
        f.reviews.records[0]!.ref,
        "tested",
      ),
    { code: "invalid_review_snapshot" },
  );
  assert.throws(() =>
    projectVerificationReview(
      { ...c, actor: { ...c.actor, kind: "service" } },
      { revision: 1, state: f.knowledge },
      { revision: 1, state: f.state, knowledgeRevision: 1 },
      f.reviews,
      f.reviews.records[0]!.ref,
      "tested",
    ),
  );
  assert.throws(
    () => project(f, { ...f.reviews.records[0]!.ref, revision: 99 }),
    { code: "missing_reference" },
  );
});

test("whole oversized captured input and extra authority fields reject before any partial projection", () => {
  const f = setup();
  assert.throws(
    () =>
      projectVerificationReview(
        c,
        { revision: 1, state: f.knowledge, authority: "grant" } as never,
        { revision: 1, state: f.state, knowledgeRevision: 1 },
        f.reviews,
        f.reviews.records[0]!.ref,
        "tested",
      ),
    { code: "invalid_review_snapshot" },
  );
  const oversized = {
    ...f.reviews,
    untrustedPadding: "x".repeat(5 * 1024 * 1024),
  };
  assert.throws(
    () =>
      projectVerificationReview(
        c,
        { revision: 1, state: f.knowledge },
        { revision: 1, state: f.state, knowledgeRevision: 1 },
        oversized,
        f.reviews.records[0]!.ref,
        "tested",
      ),
    { code: "projection_too_large" },
  );
});
