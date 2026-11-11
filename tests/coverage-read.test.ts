import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createKnowledgeState } from "@accountability/knowledge-verification";
import {
  createPlanningState,
  revisePlan,
} from "@accountability/factual-investigation";
import {
  createEffortState,
  recordEffort,
} from "@accountability/factual-investigation/efforts";
import { inspectCapturedInvestigationCoverage } from "@accountability/factual-investigation/coverage";
import {
  PLANNING_KEY,
  PLANNING_KIND,
  EFFORT_KEY,
  EFFORT_KIND,
} from "@accountability/factual-investigation/repository";
import {
  parseSelectedCoverageFrame,
  renderSelectedCoverageFrame,
  captureCoverageSelection,
} from "../src/selected-coverage.ts";
import { CoverageReadClient } from "../src/coverage-client.ts";
import { mountCoverageRead } from "../src/coverage-controls.ts";
const scope = { tenantId: "fiction", projectId: "coverage" },
  context = {
    ...scope,
    actor: { id: "human", kind: "human" as const, roles: ["researcher"] },
    purpose: "review",
    requestId: "synthetic",
    now: "2026-01-01T00:00:00Z",
  };
const origin = "https://coverage.invalid";
function fixture(revised = false) {
  const knowledge = createKnowledgeState(context),
    value = {
      title: "Literal <img src=x onerror=alert(1)>",
      intakeCaseRef: null,
      basisClaimRefs: [],
      questions: [
        {
          id: "q",
          parentId: null,
          text: "What remains unknown?",
          whyMaterial: "Timing",
          material: true,
          hypotheses: [
            {
              id: "h",
              explanation: "A possibility",
              claimRefs: [],
              contraryTest: "Seek contrary records",
            },
          ],
          leads: [{ id: "log", description: "Fixture log" }],
          stopCondition: "Pause, not closure",
        },
      ],
    };
  let plans = revisePlan(context, knowledge, createPlanningState(context), {
    id: "plan",
    expectedRevision: 0,
    value,
  });
  const first = plans.records[0]!.ref;
  let efforts = recordEffort(context, plans, createEffortState(context), {
    id: "effort",
    expectedSequence: 0,
    plan: first,
    questionId: "q",
    leadId: "log",
    outcome: "unavailable",
    detail: "Synthetic assertion",
    corrects: null,
  });
  efforts = recordEffort(context, plans, efforts, {
    id: "correction",
    expectedSequence: 1,
    plan: first,
    questionId: "q",
    leadId: "log",
    outcome: "exhausted",
    detail: "Corrected assertion",
    corrects: efforts.records[0]!.ref,
  });
  if (revised)
    plans = revisePlan(context, knowledge, plans, {
      id: "plan",
      expectedRevision: 1,
      value,
    });
  const selected = plans.records.at(-1)!.ref,
    coverage = inspectCapturedInvestigationCoverage(
      context,
      JSON.stringify({ plans, efforts }),
      selected,
    );
  const frame = {
    planningStorage: {
      ...scope,
      kind: PLANNING_KIND,
      id: PLANNING_KEY,
      revision: plans.records.length,
    },
    effortStorage: { ...scope, kind: EFFORT_KIND, id: EFFORT_KEY, revision: 2 },
    coverage,
  };
  return { selected, frame };
}
const response = (v: unknown) =>
  new Response(JSON.stringify(v), {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
test("actual pinned coverage metadata preserves corrected assertions and separates older plan efforts", () => {
  for (const revised of [false, true]) {
    const f = fixture(revised),
      d = parseSelectedCoverageFrame(
        scope,
        f.selected,
        JSON.stringify(f.frame),
      );
    assert.deepEqual(d, f.frame);
    assert.equal(d.coverage.questions[0]!.status, "unresolved");
    assert.equal(d.coverage.effortHistory.length, 2);
    assert.equal(d.coverage.questions[0]!.effortRefs.length, revised ? 0 : 1);
    assert.equal(
      d.coverage.historicalEffectiveEffortRefs.length,
      revised ? 1 : 0,
    );
  }
});
test("wire parser rejects fabricated authority, missing corrections, rebound refs and false completion", () => {
  const f = fixture();
  for (const edit of [
    (x: any) => (x.allowed = true),
    (x: any) => (x.planningStorage.id = "a".repeat(64)),
    (x: any) => (x.coverage.questions[0].status = "complete"),
    (x: any) => (x.coverage.questions[0].effortRefs = []),
    (x: any) => (x.coverage.effortHistory[1].corrects = null),
    (x: any) =>
      (x.coverage.plan.value.questions[0].hypotheses[0].approved = true),
    (x: any) => (x.coverage.tenantId = "other"),
  ]) {
    const x = structuredClone(f.frame);
    edit(x);
    assert.throws(() =>
      parseSelectedCoverageFrame(scope, f.selected, JSON.stringify(x)),
    );
  }
  const bad = { ...f.selected };
  Object.defineProperty(bad, "id", {
    get() {
      throw Error("getter should not execute");
    },
  });
  assert.throws(() => captureCoverageSelection(scope, bad));
  assert.throws(() =>
    parseSelectedCoverageFrame(scope, f.selected, " ".repeat(524289)),
  );
});
test("literal DOM table retains material questions and inert full contrary and correction metadata", () => {
  const f = fixture(),
    dom = new JSDOM("<main></main>", { url: origin });
  const view = renderSelectedCoverageFrame(
    dom.window.document,
    scope,
    f.selected,
    JSON.stringify(f.frame),
  );
  assert.equal(view.querySelectorAll("img,script,a").length, 0);
  assert.equal(view.querySelectorAll("table tr").length, 2);
  assert.ok(view.textContent?.includes("Seek contrary records"));
  assert.ok(view.textContent?.includes("correction"));
  assert.ok(view.textContent?.includes("unresolved"));
  dom.window.close();
});
test("explicit client uses fresh session CSRF and exact private read without automatic requests", async () => {
  const f = fixture(),
    calls: any[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response({ actorId: "human", csrfToken: "fixture-csrf" })
      : response(f.frame);
  };
  const c = new CoverageReadClient(origin, scope, "review", transport);
  assert.equal(calls.length, 0);
  assert.deepEqual(await c.read(f.selected), f.frame);
  assert.equal(calls[1].url, origin + "/private/coverage/read");
  assert.deepEqual(JSON.parse(calls[1].init.body), { selected: f.selected });
  assert.equal(calls[1].init.credentials, "same-origin");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[1].init.signal.aborted, true);
  c.dispose();
});
test("changed human closes before read POST and malformed response never escapes", async () => {
  const f = fixture();
  let calls = 0;
  const c = new CoverageReadClient(origin, scope, "review", async () => {
    calls++;
    return calls === 2
      ? response(f.frame)
      : response({
          actorId: calls === 1 ? "human" : "other",
          csrfToken: "csrf",
        });
  });
  await c.read(f.selected);
  await assert.rejects(c.read(f.selected));
  assert.equal(calls, 3);
  assert.equal(c.closed, true);
  const bad = new CoverageReadClient(origin, scope, "review", async (url) =>
    String(url).endsWith("session")
      ? response({ actorId: "human", csrfToken: "csrf" })
      : response({ ...f.frame, allowed: true }),
  );
  await assert.rejects(bad.read(f.selected));
  bad.dispose();
});
test("mounted controls are exclusive, make no initial request and dispose detached views", async () => {
  const f = fixture(),
    dom = new JSDOM("<main></main>", { url: origin }),
    root = dom.window.document.querySelector("main")!;
  let calls = 0;
  const c = new CoverageReadClient(origin, scope, "review", async (url) => {
    calls++;
    return String(url).endsWith("session")
      ? response({ actorId: "human", csrfToken: "csrf" })
      : response(f.frame);
  });
  const control = mountCoverageRead(root, c, f.selected);
  assert.equal(calls, 0);
  assert.throws(() => mountCoverageRead(root, c, f.selected));
  root.querySelector("button")!.click();
  for (let i = 0; i < 20 && !root.querySelector("table"); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2);
  assert.ok(root.querySelector("table"));
  control.dispose();
  assert.equal(root.textContent, "");
  assert.equal(c.closed, true);
  dom.window.close();
});

test("getter selection fails before transport and disposal fences a noncooperative late response", async () => {
  const f = fixture();
  let calls = 0;
  const client = new CoverageReadClient(origin, scope, "review", async () => {
    calls++;
    return response(f.frame);
  });
  const bad = { ...f.selected };
  Object.defineProperty(bad, "id", {
    get() {
      throw Error("getter must not run");
    },
  });
  await assert.rejects(client.read(bad));
  assert.equal(calls, 0);
  client.dispose();
  let release!: (r: Response) => void,
    cancelled = false;
  const late = new CoverageReadClient(
    origin,
    scope,
    "review",
    () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const pending = late.read(f.selected);
  late.dispose();
  await assert.rejects(pending);
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      },
    ),
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cancelled, true);
  assert.equal(late.closed, true);
});
