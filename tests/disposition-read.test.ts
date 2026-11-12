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
import {
  createQuestionDispositionState,
  recordQuestionDispositions,
  inspectQuestionDispositions,
} from "@accountability/factual-investigation/question-dispositions";
import {
  PLANNING_KIND,
  PLANNING_KEY,
  EFFORT_KIND,
  EFFORT_KEY,
} from "@accountability/factual-investigation/repository";
import {
  DISPOSITION_KIND,
  DISPOSITION_KEY,
} from "@accountability/factual-investigation/disposition-repository";
import {
  parseSelectedDispositionFrame,
  renderSelectedDispositionFrame,
} from "../src/selected-dispositions.ts";
import { DispositionReadClient } from "../src/disposition-client.ts";
import { mountDispositionRead } from "../src/disposition-controls.ts";
export const scope = { tenantId: "fiction", projectId: "dispositions" },
  origin = "https://dispositions.invalid";
export const context = {
  ...scope,
  actor: { id: "human", kind: "human" as const, roles: ["researcher"] },
  purpose: "review",
  requestId: "fixture",
  now: "2026-01-01T00:00:00.000Z",
};
export function fixture(
  mode: "current" | "changed" | "due" | "empty" = "current",
) {
  const knowledge = createKnowledgeState(context),
    value = {
      title: "Literal <img src=x onerror=alert(1)>",
      intakeCaseRef: null,
      basisClaimRefs: [],
      questions: ["one", "two", "three"].map((id) => ({
        id,
        parentId: null,
        text: "What remains unknown " + id + "?",
        whyMaterial: "Fixture uncertainty",
        material: true,
        hypotheses: [
          {
            id: "h",
            explanation: "Alternative",
            claimRefs: [],
            contraryTest: "Seek contrary records",
          },
        ],
        leads: [{ id: "log", description: "Authorized fixture log" }],
        stopCondition: "Pause, never infer closure",
      })),
    };
  let plans = revisePlan(context, knowledge, createPlanningState(context), {
    id: "plan",
    expectedRevision: 0,
    value,
  });
  let selected = plans.records[0]!.ref;
  let efforts = recordEffort(context, plans, createEffortState(context), {
    id: "attempt",
    expectedSequence: 0,
    plan: selected,
    questionId: "one",
    leadId: "log",
    outcome: "unavailable",
    detail: "Fictional assertion",
    corrects: null,
  });
  let state = createQuestionDispositionState(context);
  const capture = () => JSON.stringify({ plans, efforts });
  if (mode !== "empty")
    state = recordQuestionDispositions(context, capture(), state, {
      id: "review",
      expectedSequence: 0,
      supersedes: null,
      selected,
      questions: [
        {
          questionId: "one",
          status: "unresolved",
          reason: "Unknown",
          assigneeId: null,
          reviewAt: null,
        },
        {
          questionId: "two",
          status: "deferred",
          reason: "Await authorized fixture",
          assigneeId: null,
          reviewAt: "2026-02-01T00:00:00.000Z",
        },
        {
          questionId: "three",
          status: "assigned",
          reason: "Check contrary route",
          assigneeId: "fixture-human-label",
          reviewAt: "2026-02-02T00:00:00.000Z",
        },
      ],
      reopeningTriggers: ["New authorized records"],
    });
  if (mode === "changed") {
    efforts = recordEffort(context, plans, efforts, {
      id: "correction",
      expectedSequence: 1,
      plan: selected,
      questionId: "one",
      leadId: "log",
      outcome: "exhausted",
      detail: "Corrected assertion",
      corrects: efforts.records[0]!.ref,
    });
    plans = revisePlan(context, knowledge, plans, {
      id: "plan",
      expectedRevision: 1,
      value,
    });
    selected = plans.records[1]!.ref;
  }
  const c =
    mode === "due" ? { ...context, now: "2026-02-01T00:00:00.000Z" } : context;
  const ref = (kind: string, id: string, revision: number) => ({
    ...scope,
    kind,
    id,
    revision,
  });
  const frame = {
    storage: state.records.length
      ? ref(DISPOSITION_KIND, DISPOSITION_KEY, state.records.length)
      : null,
    planningStorage: ref(PLANNING_KIND, PLANNING_KEY, plans.records.length),
    effortStorage: ref(EFFORT_KIND, EFFORT_KEY, efforts.records.length),
    table: inspectQuestionDispositions(c, capture(), state, selected),
  };
  return { selected, frame, text: JSON.stringify(frame) };
}
const responseHeaders = {"content-type":"application/json", "cache-control":"no-store"};
const session = (actor = "human") =>
  new Response(
    JSON.stringify({
      actorId: actor,
      csrfToken: "fixture-session-csrf-token-00000000000000",
    }), {headers:responseHeaders}
  );
function transport(
  text: string,
  calls: { url: string; init: RequestInit | undefined }[],
  actor = "human",
): typeof fetch {
  return (async (url, init) => {
    calls.push({ url: String(url), init });
    return String(url).endsWith("/session")
      ? session(actor)
      : new Response(text,{headers:responseHeaders});
  }) as typeof fetch;
}

test("actual SDK frame preserves containing editions, all current statuses and changed/due/empty review bases", () => {
  for (const mode of ["current", "changed", "due", "empty"] as const) {
    const x = fixture(mode),
      f = parseSelectedDispositionFrame(scope, x.selected, x.text);
    assert.deepEqual(f, x.frame);
    assert.equal(
      f.table.questions[2]!.disposition.status,
      mode === "current" ? "assigned" : "unresolved",
    );
    if (mode === "changed") {
      assert.equal(f.table.latestReview!.basis.plan.revision, 1);
      assert.equal(f.table.coverage.basis.plan.revision, 2);
      assert.equal(f.table.coverage.effortHistory.length, 2);
      assert.equal(f.table.coverage.historicalEffectiveEffortRefs.length, 1);
      assert.equal(f.table.latestReview!.questions[2]!.status, "assigned");
    }
  }
});
test("corrupt refs, invented authority, false current statuses, forked history and invalid profiles deny whole response", () => {
  const x = fixture();
  for (const mutate of [
    (f: any) => (f.authorized = true),
    (f: any) => (f.storage.id = "invented"),
    (f: any) => (f.table.latestReview.ref.revision = 2),
    (f: any) => (f.table.history[0].basis.captureDigest = "not-hash"),
    (f: any) => (f.table.history[0].actorKind = "agent"),
    (f: any) => (f.table.questions[0].disposition.status = "answered"),
    (f: any) => (f.table.history[0].supersedes = f.table.history[0].ref),
    (f: any) => f.table.questions.pop(),
  ]) {
    const f = JSON.parse(x.text);
    mutate(f);
    assert.throws(() =>
      parseSelectedDispositionFrame(scope, x.selected, JSON.stringify(f)),
    );
  }
  const changed = fixture("changed"),
    f = JSON.parse(changed.text);
  f.table.questions[2].disposition = f.table.latestReview.questions[2];
  assert.throws(() =>
    parseSelectedDispositionFrame(scope, changed.selected, JSON.stringify(f)),
  );
  assert.throws(() =>
    parseSelectedDispositionFrame(scope, x.selected, "x".repeat(524289)),
  );
});
test("inert native table retains hostile literal text and full historical metadata without remote markup", () => {
  const x = fixture("changed"),
    dom = new JSDOM("<main></main>", { url: origin });
  const view = renderSelectedDispositionFrame(
    dom.window.document,
    scope,
    x.selected,
    x.text,
  );
  dom.window.document.querySelector("main")!.append(view);
  assert.equal(view.querySelectorAll("img,script,a,iframe").length, 0);
  assert(view.textContent!.includes("<img src=x onerror=alert(1)>"));
  assert(view.textContent!.includes("fixture-human-label"));
  assert(view.textContent!.includes("basis-changed"));
  assert.equal(view.querySelectorAll("table tr").length, 4);
});
test("client makes no initial call and uses exact private same-origin session-CSRF read with bounded immutable selection", async () => {
  const x = fixture(),
    calls: { url: string; init: RequestInit | undefined }[] = [],
    client = new DispositionReadClient(
      origin,
      scope,
      "review",
      transport(x.text, calls),
    );
  assert.equal(calls.length, 0);
  const frame = await client.read(x.selected);
  assert.deepEqual(frame, x.frame);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      origin + "/private/dispositions/session",
      origin + "/private/dispositions/read",
    ],
  );
  assert.deepEqual(JSON.parse(calls[1]!.init!.body as string), {
    selected: x.selected,
  });
  assert.equal(calls[1]!.init!.cache, "no-store");
  assert.equal(calls[1]!.init!.credentials, "same-origin");
  assert.equal(calls[1]!.init!.redirect, "error");
  assert(calls.every((c) => (c.init!.signal as AbortSignal).aborted));
});
test("actor changes close before POST and wrong-purpose or malformed frames are withheld", async () => {
  const x = fixture();
  let actor = "human",
    posts = 0;
  const wire = (async (url) =>
    String(url).endsWith("/session")
      ? session(actor)
      : (posts++, new Response(x.text,{headers:responseHeaders}))) as typeof fetch;
  const client = new DispositionReadClient(origin, scope, "review", wire);
  await client.read(x.selected);
  actor = "other";
  await assert.rejects(client.read(x.selected));
  assert.equal(posts, 1);
  assert(client.closed);
  const wrong = new DispositionReadClient(
    origin,
    scope,
    "other",
    transport(x.text, []),
  );
  await assert.rejects(wrong.read(x.selected));
});
test("exclusive controls request only on explicit action and disposal clears copied data", async () => {
  const x = fixture(),
    calls: { url: string; init: RequestInit | undefined }[] = [],
    dom = new JSDOM("<main></main>", { url: origin }),
    root = dom.window.document.querySelector("main")!,
    client = new DispositionReadClient(
      origin,
      scope,
      "review",
      transport(x.text, calls),
    ),
    mounted = mountDispositionRead(root, client, x.selected);
  assert.equal(calls.length, 0);
  assert.throws(() => mountDispositionRead(root, client, x.selected));
  root.querySelector("button")!.click();
  for (let i = 0; i < 50 && !root.querySelector("table"); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert(root.querySelector("table"));
  assert(root.textContent!.includes("assigned"));
  mounted.dispose();
  assert.equal(root.textContent, "");
  assert(client.closed);
});
