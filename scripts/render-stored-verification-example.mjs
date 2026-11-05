import * as e from "@accountability/evidence";
import {
  createKnowledgeState,
  reviseKnowledge,
} from "@accountability/knowledge-verification";
import {
  createEvidenceLinksState,
  reviseEvidenceLinks,
} from "@accountability/knowledge-verification/evidence-links";
import { renderStoredVerificationReview } from "../dist/verification-review.js";
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

import { writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { KnowledgeRepository } from "@accountability/knowledge-verification/repository";
const f = setup(),
  pg = new PGlite();
try {
  const require = createRequire(
    import.meta.resolve("@accountability/knowledge-verification/repository"),
  );
  await pg.exec(
    await readFile(
      new URL(
        "../migrations/001_foundation.sql",
        pathToFileURL(require.resolve("@accountability/evidence-sql/database")),
      ),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE stored_review_example LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO stored_review_example; SET SESSION AUTHORIZATION stored_review_example",
  );
  const db = {
    transaction: (fn) =>
      pg.transaction((query) =>
        fn({
          query: async (sql, values) => ({
            rows: (await query.query(sql, values)).rows,
          }),
        }),
      ),
    close: async () => {},
  };
  const repo = new KnowledgeRepository(db, {
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
    humanIds: [c.actor.id],
  });
  const claim = await repo.append(
    c,
    0,
    { id: "claim", expectedRevision: 0, value: f.value },
    "claim",
  );
  const links = await repo.recordEvidenceLinks(
    c,
    0,
    f.evidence,
    { ...f.command, claim: claim.record },
    "links",
  );
  await repo.recordVerificationReview(
    c,
    0,
    {
      linkRef: links.record,
      expectedRevision: 0,
      checks: f.checks,
      rationale: "A private fictional unresolved human observation",
    },
    "review",
  );
  const knowledge = await repo.load(c),
    citations = await repo.loadEvidenceLinks(c),
    reviews = await repo.loadVerificationReviews(c);
  await writeFile(
    "docs/examples/private-stored-verification-review.html",
    renderStoredVerificationReview(
      c,
      knowledge,
      citations,
      reviews,
      reviews.state.records[0].ref,
      "pending",
    ),
  );
} finally {
  await pg.close();
}
