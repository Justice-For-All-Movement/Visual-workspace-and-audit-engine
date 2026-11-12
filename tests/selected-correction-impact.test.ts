import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as k from "@accountability/knowledge-verification";
import * as f from "@accountability/factual-investigation";
import {
  impactFixture,
  corrected,
  wire,
  c,
  planValue,
} from "./selected-correction-impact-fixture.ts";
import {
  parseSelectedCorrectionImpactFrame as parse,
  renderSelectedCorrectionImpactFrame as render,
  captureCorrectionImpactSelection as capture,
} from "../src/selected-correction-impact.ts";
test("actual SDK all historical plan graphs remain separate from latest plan and corrected successor", () => {
  const { scope, selected, frame } = impactFixture();
  assert.deepEqual(parse(scope, selected, JSON.stringify(frame)), frame);
  assert.deepEqual(
    frame.impact.plans.map((p) => p.status),
    ["review-required", "no-captured-dependency", "no-captured-dependency"],
  );
  assert.equal(frame.impact.plans[0]!.plan.revision, 1);
  assert.equal(frame.impact.plans[0]!.latestPlan.revision, 2);
  assert.equal(
    frame.impact.plans[0]!.review.nodes.find((n) => n.ref.kind === "event")!.ref
      .revision,
    1,
  );
  const parsed = parse(scope, selected, JSON.stringify(frame));
  Object.assign(parsed.impact.plans[0]!.plan, { id: "changed-copy" });
  assert.equal(frame.impact.plans[0]!.plan.id, "plan");
});
test("missing transitive claim stays indeterminate; truly absent planning storage remains null", () => {
  const x = corrected(),
    knowledge = {
      ...x.knowledge,
      records: x.knowledge.records.filter((r) => r.ref.id !== "claim"),
    };
  const missing = wire(knowledge, x.plans, x.event, x.after);
  assert.deepEqual(
    parse(missing.scope, missing.selected, JSON.stringify(missing.frame)),
    missing.frame,
  );
  assert.equal(missing.frame.impact.plans[0]!.status, "indeterminate");
  const empty = wire(x.knowledge, f.createPlanningState(c), x.event, x.after);
  assert.equal(
    parse(empty.scope, empty.selected, JSON.stringify(empty.frame))
      .planningStorage,
    null,
  );
  const bad = structuredClone(empty.frame) as any;
  bad.planningStorage = x.selected;
  assert.throws(() => parse(empty.scope, empty.selected, JSON.stringify(bad)));
});
test("invalid frames reject dropped plan editions, foreign refs, fake status, disconnected graphs and invented containing editions", () => {
  const { scope, selected, frame } = impactFixture();
  const edits = [
    (v: any) => (v.allowed = true),
    (v: any) => v.impact.plans.pop(),
    (v: any) => v.knowledgeStorage.revision++,
    (v: any) => (v.planningStorage.id = "f".repeat(64)),
    (v: any) => (v.impact.plans[0].status = "no-captured-dependency"),
    (v: any) => (v.impact.plans[0].affectedRefs = []),
    (v: any) => (v.impact.plans[0].latestPlan.revision = 1),
    (v: any) => (v.impact.plans[0].review.nodes[0].ref.projectId = "foreign"),
    (v: any) => (v.impact.plans[0].review.nodes[0].status = "missing-edition"),
    (v: any) => (v.impact.plans[0].review.edges = []),
    (v: any) =>
      v.impact.plans[0].review.edges.push(v.impact.plans[0].review.edges[0]),
    (v: any) =>
      v.impact.plans[0].review.roots.push(v.impact.plans[0].review.roots[0]),
    (v: any) => (v.impact.unloaded = []),
    (v: any) => (v.impact.purpose = "publication"),
    (v: any) =>
      (v.impact.plans[0].review.nodes.find(
        (n: any) => n.ref.kind === "event",
      ).latestRef.revision = 1),
  ];
  for (const edit of edits) {
    const v = structuredClone(frame);
    edit(v);
    assert.throws(() => parse(scope, selected, JSON.stringify(v)), {
      code: "invalid_response",
    });
  }
});
test("getter-free selection rejects malformed pairs before any getter invocation; scope data detached", () => {
  const { scope, selected } = impactFixture();
  let reads = 0;
  const bad = { ...selected };
  Object.defineProperty(bad, "before", {
    enumerable: true,
    get() {
      reads++;
      return selected.before;
    },
  });
  assert.throws(() => capture(scope, bad));
  assert.equal(reads, 0);
  for (const bad of [
    { ...selected, allowed: true },
    { ...selected, after: { ...selected.after, revision: 3 } },
    { ...selected, before: { ...selected.before, revision: 0 } },
    { ...selected, after: { ...selected.after, kind: "case" } },
  ])
    assert.throws(() => capture(scope, bad as never));
  const copy = capture(scope, selected);
  assert.notEqual(copy, selected);
  assert.notEqual(copy.before, selected.before);
});
test("literal table and inspector keep every plan and malicious IDs inert; no network or audit invention", () => {
  const x = corrected();
  const plans = f.revisePlan(c, x.knowledge, x.plans, {
    id: "<img src=x onerror=alert(1)>",
    expectedRevision: 0,
    value: planValue([]),
  });
  const { scope, selected, frame } = wire(x.knowledge, plans, x.event, x.after);
  const dom = new JSDOM("<main/>"),
    view = render(dom.window.document, scope, selected, JSON.stringify(frame));
  dom.window.document.body.append(view);
  assert.equal(view.querySelectorAll("script,img,a,iframe").length, 0);
  assert.equal(view.querySelectorAll("tbody tr").length, plans.records.length);
  assert(view.textContent?.includes("<img src=x onerror=alert(1)>"));
  assert(view.textContent?.includes("not creation editions"));
  assert(view.textContent?.includes("not proof of no impact"));
});
test("whole512KiB UTF8 input accepts exact bound and rejects one extra byte without partial report", () => {
  const { scope, selected, frame } = impactFixture(),
    text = JSON.stringify(frame),
    size = new TextEncoder().encode(text).length;
  const exact = text + " ".repeat(524288 - size);
  assert.deepEqual(parse(scope, selected, exact), frame);
  assert.throws(() => parse(scope, selected, exact + " "));
});
