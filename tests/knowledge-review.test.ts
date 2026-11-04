import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createKnowledgeState,
  reviseKnowledge,
} from "@accountability/knowledge-verification";
import { projectKnowledgeRecord } from "../src/knowledge-review.ts";
import { renderWorkspace } from "../src/index.ts";
const c = {
  tenantId: "fiction",
  projectId: "review",
  actor: { id: "owner", kind: "human" as const, roles: ["owner"] },
  purpose: "review",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
function fixture() {
  let state = reviseKnowledge(c, createKnowledgeState(c), {
    id: "person",
    expectedRevision: 0,
    value: {
      type: "entity",
      label: "Fictional person",
      category: "person",
      description: "Unresolved",
    },
  });
  const person = state.records[0]!.ref;
  state = reviseKnowledge(c, state, {
    id: "claim",
    expectedRevision: 0,
    value: {
      type: "claim",
      text: "</script><script>window.injected=true</script>",
      subjectRefs: [person],
      time: { earliest: null, latest: null },
      accountType: "observation",
      limitations: ["Unverified fixture"],
      assessment: null,
      proceduralPosture: null,
      editorialApproval: null,
    },
  });
  const claim = state.records[1]!.ref;
  state = reviseKnowledge(c, state, {
    id: "person",
    expectedRevision: 1,
    value: {
      type: "entity",
      label: "Changed captured entity",
      category: "person",
      description: "Still unresolved",
    },
  });
  return { state, person, claim };
}
test("Knowledge projection retains exact historical subjects and containing storage without invented audit or truth", () => {
  const f = fixture(),
    snapshot = projectKnowledgeRecord(
      c,
      { revision: 3, state: f.state },
      f.claim,
      "tested",
    );
  assert.equal(snapshot.nodes.length, 3);
  assert.deepEqual(snapshot.events, []);
  assert.deepEqual(snapshot.agents, []);
  const subject = snapshot.nodes.find((n) => n.ref.id === "person")!;
  assert.equal(subject.ref.revision, 1);
  assert.equal((subject.details as any).latestCapturedRef.revision, 2);
  assert.equal(
    snapshot.nodes.at(-1)!.state,
    "latest-captured-edition-unassessed",
  );
  assert.equal(
    (snapshot.nodes.at(-1)!.details as any).record.value.assessment,
    null,
  );
  Object.assign(f.state.records[0]!.value, { label: "mutated caller" });
  assert.equal((subject.details as any).record.value.label, "Fictional person");
});
test("Knowledge graph/table inspector renders hostile literal text inert and preserves selected edition", () => {
  const f = fixture(),
    view = projectKnowledgeRecord(
      c,
      { revision: 3, state: f.state },
      f.claim,
      "tested",
    );
  const dom = new JSDOM(renderWorkspace(c, view), {
    runScripts: "dangerously",
  });
  const dialog = dom.window.document.querySelector("dialog")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
    },
  });
  const buttons = [
    ...dom.window.document.querySelectorAll<HTMLButtonElement>(
      "button[data-node]",
    ),
  ];
  const button = buttons.find((b) => b.textContent?.includes("</script>"))!;
  button.click();
  assert.ok(dialog.hasAttribute("open"));
  assert.ok(
    dom.window.document
      .querySelector("#detail")!
      .textContent!.includes('"assessment": null'),
  );
  assert.equal((dom.window as any).injected, undefined);
  assert.equal(dom.window.document.querySelectorAll("script[src]").length, 0);
  dom.window.close();
});
test("Knowledge projection rejects fabricated storage, foreign refs, wrong purpose and injected approval", () => {
  const f = fixture();
  assert.throws(
    () =>
      projectKnowledgeRecord(
        c,
        { revision: 2, state: f.state },
        f.claim,
        "tested",
      ),
    { code: "invalid_knowledge_snapshot" },
  );
  assert.throws(() =>
    projectKnowledgeRecord(
      c,
      { revision: 3, state: f.state },
      { ...f.claim, tenantId: "foreign" },
      "tested",
    ),
  );
  assert.throws(() =>
    projectKnowledgeRecord(
      { ...c, purpose: "other" },
      { revision: 3, state: f.state },
      f.claim,
      "tested",
    ),
  );
  const bad = structuredClone(f.state);
  Object.assign(bad.records[1]!.value, { assessment: "verified" });
  assert.throws(() =>
    projectKnowledgeRecord(c, { revision: 3, state: bad }, f.claim, "tested"),
  );
  assert.throws(
    () =>
      projectKnowledgeRecord(
        c,
        { revision: 3, state: f.state },
        { ...f.claim, revision: 20 },
        "tested",
      ),
    { code: "missing_reference" },
  );
});
test("entity, event and relationship inspectors preserve unknown times and unassessed role assertions", () => {
  const f = fixture();
  let state = reviseKnowledge(c, f.state, {
    id: "event",
    expectedRevision: 0,
    value: {
      type: "event",
      label: "Fictional event",
      description: "Unknown time",
      time: { earliest: null, latest: null },
      entityRefs: [f.state.records[2]!.ref],
    },
  });
  state = reviseKnowledge(c, state, {
    id: "role",
    expectedRevision: 0,
    value: {
      type: "relationship",
      relationshipType: "role_assertion",
      label: "Unverified role",
      from: state.records[2]!.ref,
      to: state.records[3]!.ref,
      time: { earliest: null, latest: null },
      limitations: [],
      assessment: null,
      proceduralPosture: null,
      editorialApproval: null,
    },
  });
  for (const selected of [
    state.records[0]!.ref,
    state.records[3]!.ref,
    state.records[4]!.ref,
  ]) {
    const view = projectKnowledgeRecord(
      c,
      { revision: 5, state },
      selected,
      "tested",
    );
    assert.equal(view.nodes.at(-1)!.ref.id, selected.id);
    assert.deepEqual(view.events, []);
  }
});
