import * as e from "@accountability/evidence";
import {
  createKnowledgeState,
  reviseKnowledge,
} from "@accountability/knowledge-verification";
import {
  createEvidenceLinksState,
  reviseEvidenceLinks,
} from "@accountability/knowledge-verification/evidence-links";
import { renderVerificationReview } from "../dist/verification-review.js";
import {
  createVerificationReviewState,
  recordVerificationReview,
} from "@accountability/knowledge-verification/verification-review";
const c = {
  tenantId: "fiction",
  projectId: "links",
  actor: { id: "reviewer", kind: "human", roles: ["researcher"] },
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
  const v = evidence.versions[0];
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
    type: "claim",
    text: "A fictional lamp was described as blue; the assertion remains unresolved.",
    subjectRefs: [],
    time: { earliest: null, latest: null },
    accountType: "observation",
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
    claim: knowledge.records[0].ref,
    expectedRevision: 0,
    links: [
      {
        id: "support",
        relation: "supports",
        selector: { kind: "whole", evidence: v.ref, sha256: v.sha256 },
      },
      {
        id: "contrary",
        relation: "challenges",
        selector: { kind: "whole", evidence: v.ref, sha256: v.sha256 },
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
        status: "reviewed",
        note: "Literal reviewer assertion, not work proof",
      },
    ]),
  );
  const reviews = recordVerificationReview(
    c,
    knowledge,
    state,
    createVerificationReviewState(c),
    {
      linkRef: state.records[0].ref,
      expectedRevision: 0,
      checks,
      rationale: "Unresolved fictional review",
    },
  );
  return { knowledge, evidence, state, command, value, checks, reviews };
}

import { writeFile } from "node:fs/promises";
const f = setup();
await writeFile(
  "docs/examples/private-verification-review.html",
  renderVerificationReview(
    c,
    { revision: f.knowledge.records.length, state: f.knowledge },
    {
      revision: f.state.records.length,
      state: f.state,
      knowledgeRevision: f.knowledge.records.length,
    },
    f.reviews,
    f.reviews.records[0].ref,
    "pending",
  ),
);
