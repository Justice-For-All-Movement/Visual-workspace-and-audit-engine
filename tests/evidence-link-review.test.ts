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
import { projectKnowledgeEvidenceLinks } from "../src/evidence-link-review.ts";
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
  return { knowledge, evidence, state, command, value };
}
const project = (
  f: ReturnType<typeof setup>,
  selected = f.state.records[0]!.ref,
) =>
  projectKnowledgeEvidenceLinks(
    c,
    { revision: f.knowledge.records.length, state: f.knowledge },
    {
      revision: f.state.records.length,
      state: f.state,
      knowledgeRevision: f.knowledge.records.length,
    },
    selected,
    "tested",
  );
test("owning citation editions preserve contrary relations and coalesce only exact unloaded Evidence refs", () => {
  const f = setup(),
    v = project(f);
  assert.equal(
    v.nodes.filter((n) => n.state === "stored-reference-not-revalidated")
      .length,
    1,
  );
  const links = (
    v.nodes.find((n) => n.state === "stored-reference-not-revalidated")!
      .details as any
  ).links;
  assert.deepEqual(
    links.map((l: any) => l.relation),
    ["supports", "challenges"],
  );
  assert.deepEqual(v.events, []);
  assert.deepEqual(v.agents, []);
  assert.equal(
    (v.nodes.at(-1)!.details as any).record.links[0].fingerprint,
    f.state.records[0]!.links[0]!.fingerprint,
  );
  (f.state.records[0]!.links[0] as any).fingerprint = "mutated";
  assert.notEqual(links[0].fingerprint, "mutated");
});
test("old citation and claim editions remain historical after later empty set and claim revision", () => {
  const f = setup(),
    selected = f.state.records[0]!.ref;
  f.state = reviseEvidenceLinks(c, f.knowledge, f.evidence, f.state, {
    claim: f.command.claim,
    expectedRevision: 1,
    links: [],
  });
  f.knowledge = reviseKnowledge(c, f.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: { ...f.value, text: "Later unassessed assertion" },
  });
  const old = project(f, selected);
  assert.equal(old.nodes.at(-1)!.state, "historical-captured-link-edition");
  assert.equal((old.nodes.at(-1)!.details as any).record.claim.revision, 1);
  const empty = project(f, f.state.records[1]!.ref);
  assert.equal(
    empty.nodes.filter((n) => n.state === "stored-reference-not-revalidated")
      .length,
    0,
  );
  assert.match(empty.nodes.at(-1)!.summary, /not absence/);
});
test("foreign refs, forged containing revisions, extra authority fields and malformed stored links reject", () => {
  const f = setup(),
    k = { revision: 1, state: f.knowledge },
    s = { revision: 1, state: f.state, knowledgeRevision: 1 },
    r = f.state.records[0]!.ref;
  for (const bad of [
    { ...s, revision: 2 },
    { ...s, knowledgeRevision: 2 },
    { ...s, allowed: true },
  ])
    assert.throws(() =>
      projectKnowledgeEvidenceLinks(c, k, bad as never, r, "tested"),
    );
  assert.throws(() =>
    projectKnowledgeEvidenceLinks(
      c,
      k,
      s,
      { ...r, projectId: "foreign" },
      "tested",
    ),
  );
  const bad = structuredClone(s);
  (bad.state.records[0] as any).permission = true;
  assert.throws(() => projectKnowledgeEvidenceLinks(c, k, bad, r, "tested"));
  assert.throws(() =>
    projectKnowledgeEvidenceLinks(
      { ...c, purpose: "other" },
      k,
      s,
      r,
      "tested",
    ),
  );
});
test("shared graph and table inspectors retain hostile literal citation metadata inertly", () => {
  const f = setup(),
    view = project(f),
    dom = new JSDOM(renderWorkspace(c, view), { runScripts: "dangerously" });
  const dialog = dom.window.document.querySelector("dialog")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
    },
  });
  const b = [
    ...dom.window.document.querySelectorAll<HTMLButtonElement>(
      "button[data-node]",
    ),
  ].find((b) => b.textContent?.includes("Exact captured Evidence-link"))!;
  b.click();
  assert.ok(dialog.hasAttribute("open"));
  assert.match(
    dom.window.document.querySelector("#detail")!.textContent!,
    /fingerprint/,
  );
  assert.equal((dom.window as any).injected, undefined);
  dom.window.close();
});
