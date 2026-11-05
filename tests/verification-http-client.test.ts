import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createVerificationReadHandler } from "@accountability/knowledge-verification/verification-http";
import {
  VERIFICATION_REVIEWS_KIND,
  VERIFICATION_REVIEWS_KEY,
} from "@accountability/knowledge-verification/repository";
import { scoped } from "@accountability/evidence-sql/database";
import {
  verificationFixture,
  verificationInput,
  verificationReader,
  c,
} from "./verification-http-fixture.ts";
import { VerificationReadClient } from "../src/verification-client.ts";
import { mountVerificationRead } from "../src/verification-controls.ts";

const origin = "https://private.invalid";
async function ready(t: test.TestContext) {
  const f = await verificationFixture(t),
    ack = await f.repo.recordVerificationReview(
      c,
      0,
      verificationInput(f),
      "existing",
    );
  const calls: string[] = [];
  let serial = 0;
  // A real host binds one session CSRF across the GET/POST pair. Synthetic proofing is not a login system.
  let currentCsrf = "s".repeat(32);
  const fixedHandler = createVerificationReadHandler(
    verificationReader(f),
    f.membership,
    {
      authenticate: async () => ({
        actorId: "owner",
        requestId: "session",
        csrfToken: currentCsrf,
      }),
    },
    { ...f.fixed, origin },
    () => c.now,
  );
  const transport: typeof fetch = async (input, init) => {
    calls.push(String(input));
    if (String(input).endsWith("/session"))
      currentCsrf = "s".repeat(32) + ++serial;
    const headers = new Headers(init?.headers);
    headers.set("sec-fetch-site", "same-origin");
    return fixedHandler(new Request(String(input), { ...init, headers }));
  };
  return {
    ...f,
    ack,
    calls,
    transport,
    client: new VerificationReadClient(origin, c, c.purpose, transport),
  };
}

test("actual owning HTTP to client and inert controls use four restricted migrated DBs and encrypted source metadata", async (t) => {
  const f = await ready(t);
  const result = await f.client.read(f.ack.record);
  assert.deepEqual(result.record.ref, f.ack.record);
  assert.equal(result.record.resolution, "unresolved");
  assert.equal("state" in result, false);
  const before = await f.facade.loadVerificationReviews(c);
  const dom = new JSDOM("<!doctype html><body><main></main></body>", {
    url: origin,
  });
  const root = dom.window.document.querySelector("main")!;
  const mounted = mountVerificationRead(root, f.client, f.ack.record);
  assert.equal(f.calls.length, 2);
  root.querySelector("button")!.click();
  for (let i = 0; i < 100 && !root.querySelector("pre"); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(JSON.parse(root.querySelector("pre")!.textContent!), result);
  assert.equal(
    (await f.facade.loadVerificationReviews(c)).revision,
    before.revision,
  );
  const audits = await scoped(f.knowledge, c, (tx) => tx.audits());
  assert.ok(!JSON.stringify(audits).includes(f.req.token));
  for (const db of [f.identity, f.evidence, f.consentDb]) {
    assert.equal(
      await scoped(db, c, (tx) =>
        tx.get(VERIFICATION_REVIEWS_KIND, VERIFICATION_REVIEWS_KEY),
      ),
      null,
    );
  }
  mounted.dispose();
});

test("actual Consent withdrawal or wrong Evidence human withholds prior observations and UI clears old capture", async (t) => {
  const f = await ready(t),
    dom = new JSDOM("<!doctype html><body><main></main></body>", {
      url: origin,
    });
  const root = dom.window.document.querySelector("main")!,
    mounted = mountVerificationRead(root, f.client, f.ack.record);
  const click = async () => {
    root.querySelector("button")!.click();
    for (let i = 0; i < 100 && root.querySelector("button")!.disabled; i++)
      await new Promise((r) => setTimeout(r, 5));
  };
  await click();
  assert.ok(root.querySelector("pre"));
  Object.assign(f.identities[0]!.actor, { kind: "service" });
  await click();
  assert.equal(root.querySelector("pre"), null);
  assert.match(root.textContent!, /unavailable/);
  Object.assign(f.identities[0]!.actor, { kind: "human" });
  await click();
  assert.ok(root.querySelector("pre"));
  await f.permissions.withdraw(c, "consent", "consent", 1, "withdraw");
  await click();
  assert.equal(root.querySelector("pre"), null);
  assert.match(root.textContent!, /unavailable/);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  mounted.dispose();
});

test("actual default-denied resource policy and superseded selected edition are rejected on explicit refresh", async (t) => {
  const f = await ready(t);
  await f.client.read(f.ack.record);
  await f.membership.setResourcePolicy(
    c,
    2,
    { ...f.policy, actions: [] },
    "revoke",
  );
  await assert.rejects(f.client.read(f.ack.record), {
    code: "read_unavailable",
  });
  await f.membership.setResourcePolicy(c, 3, f.policy, "restore");
  const next = await f.repo.recordVerificationReview(
    c,
    1,
    { ...verificationInput(f), expectedRevision: 1 },
    "supersede",
  );
  await assert.rejects(f.client.read(f.ack.record), {
    code: "read_unavailable",
  });
  const result = await f.client.read(next.record);
  assert.equal(result.record.ref.revision, 2);
  assert.equal(result.reviewRevision, 2);
  assert.deepEqual(result.record.supersedes, f.ack.record);
  assert.equal("history" in result, false);
});
