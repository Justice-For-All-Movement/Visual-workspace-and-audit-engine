import test from "node:test";
import assert from "node:assert/strict";
import { VerificationWriteClient } from "../src/verification-write-client.ts";
import { createVerificationReadHandler } from "@accountability/knowledge-verification/verification-http";
import { createVerificationWriteHandler } from "@accountability/knowledge-verification/verification-write-http";
import { CurrentVerificationReviewWriter } from "@accountability/knowledge-verification/verification-writer";
import { HumanConsentEvidenceKnowledgeReview } from "@accountability/knowledge-verification/consent-links";
import {
  verificationFixture,
  verificationInput,
  verificationReader,
  c,
} from "./verification-http-fixture.ts";

async function setup(t: test.TestContext) {
  const f = await verificationFixture(t),
    initial = await f.repo.recordVerificationReview(
      c,
      0,
      verificationInput(f),
      "initial",
    );
  let actor = "owner",
    lose = false,
    posts = 0;
  const provider = {
    authenticate: async () => ({
      actorId: actor,
      requestId: "browser",
      csrfToken: "s".repeat(32),
    }),
  };
  const cfg = { ...f.fixed, origin: "https://private.invalid" };
  const read = createVerificationReadHandler(
    verificationReader(f),
    f.membership,
    provider,
    cfg,
    () => c.now,
  );
  const write = createVerificationWriteHandler(
    new CurrentVerificationReviewWriter(
      f.facade,
      new HumanConsentEvidenceKnowledgeReview(
        f.facade,
        f.service,
        f.credential,
        f.makeGuard(),
      ),
    ),
    f.membership,
    provider,
    cfg,
    () => c.now,
  );
  const transport: typeof fetch = async (url, init) => {
    const isWrite = String(url).includes("verification-write");
    const result = await (isWrite ? write : read)(
      new Request(String(url), init),
    );
    if (isWrite && init?.method === "POST") {
      posts++;
      if (lose && result.status === 200) {
        lose = false;
        await result.body?.cancel();
        throw Error("lost acknowledgement");
      }
    }
    return result;
  };
  return {
    ...f,
    initial,
    client: new VerificationWriteClient(cfg.origin, c, c.purpose, transport),
    setLose: () => {
      lose = true;
    },
    setActor: (v: string) => {
      actor = v;
    },
    posts: () => posts,
  };
}

test("browser write uses actual current human source/Consent HTTP and own restricted storage revisions", async (t) => {
  const f = await setup(t);
  const frame = await f.client.load(f.initial.record);
  const ack = await f.client.record(
    "human-note",
    frame.record.checks,
    "Literal unresolved observation",
  );
  assert.equal(ack.record.revision, 2);
  assert.equal(ack.storage.revision, 2);
  assert.equal(f.client.pending, null);
  const stored = await f.repo.loadVerificationReviews(c);
  assert.equal(stored.revision, 2);
  assert.equal(stored.state.records.at(-1)!.resolution, "unresolved");
  assert.deepEqual((await f.client.load(ack.record)).record.ref, ack.record);
});

test("lost actual HTTP ACK retains original pending and explicit replay has one owning effect", async (t) => {
  const f = await setup(t),
    frame = await f.client.load(f.initial.record);
  f.setLose();
  await assert.rejects(f.client.record("lost", frame.record.checks, "Note"), {
    code: "write_unavailable",
  });
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 2);
  const pending = f.client.pending!;
  const ack = await f.client.retryPending();
  assert.equal(ack.record.revision, 2);
  assert.equal(f.posts(), 2);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 2);
  assert.equal(pending.commandId, "lost");
});

test("current actual withdrawal keeps pending locked and a changed valid member is closed before POST", async (t) => {
  const f = await setup(t),
    frame = await f.client.load(f.initial.record);
  await f.permissions.withdraw(c, "consent", "consent", 1, "withdraw");
  await assert.rejects(
    f.client.record("withdrawn", frame.record.checks, "Note"),
    { code: "write_unavailable" },
  );
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  assert.ok(f.client.pending);
  await f.membership.apply(
    c,
    1,
    { type: "set-member", id: "backup", kind: "human", roles: ["owner"] },
    "backup",
  );
  f.setActor("backup");
  await assert.rejects(f.client.retryPending(), { code: "actor_changed" });
  assert.equal(f.posts(), 1);
  assert.equal(f.client.closed, true);
});
