import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ready, c, origin } from "./disposition-http-fixture.ts";
import { DispositionReadClient } from "../src/disposition-client.ts";
import { mountDispositionRead } from "../src/disposition-controls.ts";
const scope = { tenantId: c.tenantId, projectId: c.projectId };
test("actual protected HTTP/client reads owning dispositions without a caller snapshot or mutation", async (t) => {
  const f = await ready(t),
    calls: string[] = [];
  const client = new DispositionReadClient(
    origin,
    scope,
    c.purpose,
    async (url, init) => {
      calls.push(String(url));
      return f.handler(new Request(String(url), init));
    },
  );
  const frame = await client.read(f.ack.record);
  assert.deepEqual(frame.planningStorage, f.ack.storage);
  assert.equal(frame.effortStorage, null);
  assert.equal(frame.table.coverage.questions[0]!.status, "unresolved");
  assert.equal(frame.table.questions[0]!.disposition.status, "assigned");
  assert.deepEqual(frame.storage, f.reviewAck.storage);
  assert.deepEqual(calls, [
    origin + "/private/dispositions/session",
    origin + "/private/dispositions/read",
  ]);
  assert.equal((await f.repo.load(c)).revision, 1);
  client.dispose();
});
test("actual protected mounted read clears old dispositions after current resource withdrawal", async (t) => {
  const f = await ready(t),
    dom = new JSDOM("<main></main>", { url: origin }),
    root = dom.window.document.querySelector("main")!;
  const client = new DispositionReadClient(
    origin,
    scope,
    c.purpose,
    async (url, init) => f.handler(new Request(String(url), init)),
  );
  const view = mountDispositionRead(root, client, f.ack.record);
  const button = root.querySelector("button")!;
  button.click();
  for (let i = 0; i < 200 && !root.querySelector("table"); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(root.querySelector("table"));
  await f.membership.setResourcePolicy(
    c,
    1,
    { ...f.policy, memberIds: [] },
    "withdraw",
  );
  button.click();
  assert.equal(root.querySelector("table"), null);
  for (let i = 0; i < 200 && button.disabled; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(root.querySelector("table"), null);
  assert.ok(root.textContent?.includes("unavailable"));
  view.dispose();
  dom.window.close();
});
test("actual lost dispositions read COMMIT is withheld and only a fresh explicit request reads unchanged history", async (t) => {
  const f = await ready(t);
  let calls = 0;
  const client = new DispositionReadClient(
    origin,
    scope,
    c.purpose,
    async (url, init) => {
      calls++;
      return f.handler(new Request(String(url), init));
    },
  );
  f.hooks.lostFactual = true;
  await assert.rejects(client.read(f.ack.record));
  assert.equal(calls, 2);
  const later = await client.read(f.ack.record);
  assert.equal(calls, 4);
  assert.equal(later.planningStorage.revision, 1);
  assert.deepEqual(later.storage,f.reviewAck.storage);
  assert.equal(later.table.history.length,1);
  assert.equal(later.table.coverage.plan.ref.revision, 1);
  client.dispose();
});
