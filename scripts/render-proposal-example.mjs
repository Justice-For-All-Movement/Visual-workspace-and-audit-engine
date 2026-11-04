import { writeFile } from "node:fs/promises";
import { digest } from "@accountability/knowledge-verification/contracts";
import { renderClaimProposalReview } from "../dist/proposal-review.js";
const c = {
  tenantId: "fiction",
  projectId: "private-proposals",
  actor: { id: "fixture-author", kind: "human", roles: ["researcher"] },
  purpose: "review",
  requestId: "fictional-example",
  now: "2026-01-01T00:00:00Z",
};
const ref = (kind, id) => ({
  tenantId: c.tenantId,
  projectId: c.projectId,
  kind,
  id,
  revision: 1,
});
const text = "A fictional lamp was blue.";
const proposal = (id, relation, assertion) => ({
  id,
  assertion,
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
  citation: {
    linkId: id,
    relation,
    selector: {
      kind: "text",
      evidence: ref("evidence", "fictional-source"),
      sha256: "a".repeat(64),
      representationId: "fictional-representation",
      representationDigest: "b".repeat(64),
      page: null,
      start: 0,
      end: text.length,
      quote: text,
    },
    excerpt: { start: 2, end: 16, quote: text.slice(2, 16) },
    selectorFingerprint: "f".repeat(64),
  },
  limitations: [
    "Untrusted assertion proposal; an exact quotation is not verification or corroboration.",
  ],
});
const body = {
  schemaVersion: 1,
  tenantId: c.tenantId,
  projectId: c.projectId,
  visibility: "private",
  purpose: c.purpose,
  basis: {
    knowledgeRevision: 1,
    linksRevision: 1,
    evidenceRevision: 1,
    linkRef: ref("knowledge-evidence-links", "fictional-claim"),
    claimRef: ref("claim", "fictional-claim"),
  },
  proposals: [
    proposal(
      "fictional-support",
      "supports",
      "Fictional unverified proposal: an observer described a blue lamp.",
    ),
    proposal(
      "fictional-challenge",
      "challenges",
      "Fictional unverified counterproposal: a description does not establish that the lamp was illuminated.",
    ),
  ],
};
await writeFile(
  "docs/examples/private-proposal-review.html",
  renderClaimProposalReview(c, { ...body, digest: digest(body) }, "pending"),
);
