import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { setup } from "./correction-impact-http-fixture.ts";
import { c } from "./correction-impact-db-fixture.ts";
import { createCorrectionImpactReadHandler } from "@accountability/factual-investigation/correction-impact-http";
import { scoped } from "@accountability/evidence-sql/database";
import { CorrectionImpactReadClient } from "../src/correction-impact-client.ts";
import { mountCorrectionImpactRead } from "../src/correction-impact-controls.ts";
const origin = "https://impact.invalid";
async function ready(t: test.TestContext) {
  const f = await setup(t);
  let calls = 0;
  // The real browser supplies Fetch Metadata; this controlled host supplies synthetic proofing and stable session CSRF.
  const fixedHandler = createCorrectionImpactReadHandler(
    f.reader,
    f.membership,
    {
      authenticate: async () => ({
        actorId: c.actor.id,
        requestId: "visual-impact",
        csrfToken: "s".repeat(32),
      }),
    },
    { ...f.fixed, origin },
    () => c.now,
  );
  const transport: typeof fetch = async (url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    headers.set("sec-fetch-site", "same-origin");
    return fixedHandler(new Request(String(url), { ...init, headers }));
  };
  const selected = { before: f.first.record, after: f.second.record },
    client = new CorrectionImpactReadClient(
      origin,
      f.fixed,
      c.purpose,
      transport,
      10000,
      c.actor.id,
    );
  return { ...f, client, selected, calls: () => calls };
}
test("actual three-restricted-DB accepted handler→client→inert controls preserves exact refs and clears on current policy withdrawal", async (t) => {
  const f = await ready(t),
    dom = new JSDOM("<main/>", { url: origin }),
    root = dom.window.document.querySelector("main")!;
  const control = mountCorrectionImpactRead(root, f.client, f.selected);
  assert.equal(f.calls(), 0);
  const button = root.querySelector("button")!;
  button.click();
  for (let n = 0; n < 300 && !root.querySelector("table"); n++)
    await new Promise((r) => setTimeout(r, 5));
  assert(root.querySelector("table"));
  const metadata = JSON.parse(root.querySelector("pre")!.textContent!);
  assert.deepEqual(metadata.planningStorage, f.plan.storage);
  assert.deepEqual(metadata.knowledgeStorage, f.second.storage);
  assert.deepEqual(metadata.impact.before, f.first.record);
  assert.equal(metadata.impact.plans[0].status, "review-required");
  assert.equal(f.calls(), 2);
  await f.membership.setResourcePolicy(
    c,
    2,
    { ...f.sourcePolicy, memberIds: [] },
    "withdraw-source",
  );
  button.click();
  assert.equal(root.querySelector("table"), null);
  for (let n = 0; n < 300 && f.client.busy; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(root.querySelector("pre"), null);
  assert.equal(f.calls(), 4);
  control.dispose();
  assert(f.client.closed);
  assert.equal(root.children.length, 0);
});
test("actual lost owning read COMMIT releases no frame, retries only explicit later read and retains three checked audits", async (t) => {
  const f = await ready(t);
  f.hooks.lostFactual = true;
  await assert.rejects(f.client.read(f.selected), { code: "read_unavailable" });
  assert.equal(f.calls(), 2);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(f.calls(), 2);
  const frame = await f.client.read(f.selected);
  assert.deepEqual(frame.planningStorage, f.plan.storage);
  assert.equal(f.calls(), 4);
  const audits = await scoped(f.factual, c, (tx) => tx.audits());
  assert.equal(
    audits.filter((a) => a.type === "factual.correction_impact.read_checked")
      .length,
    3,
  );
  f.client.dispose();
});
