import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { digest } from "@accountability/knowledge-verification/contracts";
import {
  projectClaimProposals,
  renderClaimProposalReview,
} from "../src/proposal-review.ts";
const c = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "reviewer", kind: "human" as const, roles: ["researcher"] },
  purpose: "review",
  requestId: "fictional",
  now: "2026-01-01T00:00:00Z",
};
const ref = (kind: string, id: string, revision = 1) => ({
  tenantId: c.tenantId,
  projectId: c.projectId,
  kind,
  id,
  revision,
});
function fixture() {
  const proposal = (id: string, relation: string) => ({
    id,
    assertion:
      "</script><script>window.injected=true</script> Unverified fictional assertion",
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
    citation: {
      linkId: id,
      relation,
      selector: {
        kind: "text",
        evidence: ref("evidence", "source", 2),
        sha256: "a".repeat(64),
        representationId: "rep",
        representationDigest: "b".repeat(64),
        page: 2,
        start: 17,
        end: 21,
        quote: "A😀B",
      },
      excerpt: { start: 18, end: 20, quote: "😀" },
      selectorFingerprint: "f".repeat(64),
    },
    limitations: [
      "Untrusted assertion proposal; an exact quotation is not verification or corroboration.",
    ],
  });
  const b = {
    schemaVersion: 1,
    tenantId: c.tenantId,
    projectId: c.projectId,
    visibility: "private",
    purpose: c.purpose,
    basis: {
      knowledgeRevision: 3,
      linksRevision: 4,
      evidenceRevision: 7,
      linkRef: ref("knowledge-evidence-links", "claim", 2),
      claimRef: ref("claim", "claim", 2),
    },
    proposals: [
      proposal("support", "supports"),
      proposal("contrary", "challenges"),
    ],
  };
  return { ...b, digest: digest(b) };
}
function rehash(b: ReturnType<typeof fixture>) {
  const { digest: hash, ...body } = b;
  return { ...body, digest: digest(body) };
}
test("private proposal projection retains observed basis, contrary citations and unloaded refs without invented proposal resources", () => {
  const b = fixture(),
    v = projectClaimProposals(c, b, "tested");
  assert.equal(v.nodes.length, 5);
  assert.deepEqual(v.events, []);
  assert.deepEqual(v.agents, []);
  assert.equal(v.visibility, "private");
  assert.ok(!v.nodes.some((n) => n.ref.kind === "proposal"));
  const source = v.nodes.find((n) => n.ref.kind === "evidence")!;
  assert.deepEqual(
    (source.details as any).observations.map((p: any) => p.citation.relation),
    ["supports", "challenges"],
  );
  assert.equal(v.nodes.at(-1)!.ref.revision, 2);
  assert.match(v.nodes.at(-1)!.summary, /local metadata/);
  assert.ok(
    v.nodes.some(
      (n) => n.ref.revision === 4 && n.state === "captured-storage-edition",
    ),
  );
  b.proposals[0]!.assertion = "mutated";
  assert.notEqual(
    (v.nodes.at(-1)!.details as any).proposals[0].assertion,
    "mutated",
  );
});
test("readable assertions, Unicode quotes and metadata stay literal with inert shared inspectors", () => {
  const b = fixture(),
    dom = new JSDOM(renderClaimProposalReview(c, b, "pending"), {
      runScripts: "dangerously",
    });
  const d = dom.window.document;
  assert.equal(d.querySelectorAll("article.proposal").length, 2);
  assert.equal(d.querySelector("blockquote")!.textContent, "😀");
  assert.ok(
    d.querySelector("article.proposal p")!.textContent!.includes("</script>"),
  );
  assert.equal((dom.window as any).injected, undefined);
  assert.equal(d.querySelectorAll("script[src],iframe,form").length, 0);
  assert.match(
    d.querySelector('[aria-label="Unassessed proposal review"]')!.textContent!,
    /unpersisted assertions/,
  );
  const dialog = d.querySelector("dialog")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
    },
  });
  [...d.querySelectorAll<HTMLButtonElement>("button[data-node]")]
    .find((b) => b.textContent?.includes("Unpersisted proposal"))!
    .click();
  assert.match(d.querySelector("#detail")!.textContent!, /selectorFingerprint/);
  assert.ok(dialog.hasAttribute("open"));
  dom.window.close();
});
test("scope, purpose, altered approval and inconsistent rehashed link parents reject before rendering", () => {
  const b = fixture();
  assert.throws(() =>
    projectClaimProposals({ ...c, projectId: "other" }, b, "pending"),
  );
  assert.throws(() =>
    renderClaimProposalReview({ ...c, purpose: "other" }, b, "pending"),
  );
  const bad = fixture();
  Object.assign(bad.proposals[0]!, { assessment: "verified" });
  assert.throws(() => renderClaimProposalReview(c, rehash(bad), "pending"));
  const conflict = fixture();
  conflict.proposals[1]!.citation.linkId = "support";
  assert.throws(() =>
    renderClaimProposalReview(c, rehash(conflict), "pending"),
  );
});
test("exact parent selector and separate nonzero excerpt offsets remain visible; no source or decision timestamp is invented", () => {
  const v = projectClaimProposals(c, fixture(), "pending"),
    detail = v.nodes.at(-1)!.details as any;
  assert.equal(detail.basis.evidenceRevision, 7);
  assert.equal(detail.proposals[0].citation.selector.start, 17);
  assert.equal(detail.proposals[0].citation.selector.end, 21);
  assert.equal(detail.proposals[0].citation.excerpt.start, 18);
  assert.equal(detail.proposals[0].citation.excerpt.end, 20);
  assert.equal(detail.proposals[0].assessment, null);
  assert.equal(detail.createdAt, undefined);
  assert.equal(
    v.nodes.find((n) => n.ref.kind === "claim")!.state,
    "referenced-claim-not-loaded",
  );
});
test("replacement-pattern text in untrusted assertions and excerpts remains exact and cannot duplicate the document", () => {
  const b = fixture();
  const literal = "$& $` $' $$ </main><img src=x onerror=window.injected=true>";
  b.proposals[0]!.assertion = literal;
  b.proposals[0]!.citation.selector.start = 0;
  b.proposals[0]!.citation.selector.end = literal.length;
  b.proposals[0]!.citation.selector.quote = literal;
  b.proposals[0]!.citation.excerpt = { start: 0, end: literal.length, quote: literal };
  const dom = new JSDOM(renderClaimProposalReview(c, rehash(b), "pending"), { runScripts: "dangerously" });
  const d = dom.window.document;
  assert.equal(d.querySelector("article.proposal p")!.textContent, literal);
  assert.equal(d.querySelector("article.proposal blockquote")!.textContent, literal);
  assert.equal(d.querySelectorAll("main").length, 1);
  assert.equal(d.querySelectorAll("article.proposal").length, 2);
  assert.equal(d.querySelectorAll("img").length, 0);
  assert.equal((dom.window as any).injected, undefined);
  dom.window.close();
});
