import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceFixture, c } from "./acceptance-http-fixture.ts";
import { createProposalAcceptanceWriteHandler } from "@accountability/knowledge-verification/proposal-acceptance-write-http";
import { createProposalAcceptanceReadHandler } from "@accountability/knowledge-verification/proposal-acceptance-http";
import { CurrentProposalAcceptanceReader } from "@accountability/knowledge-verification/proposal-acceptance-reader";
import { AcceptanceWriteClient } from "../src/acceptance-write-client.ts";
const origin = "https://private.invalid";
import { setup } from "./acceptance-write-fixture.ts";
test("actual handler acceptance ACK can be read explicitly through current source/use reader", async (t) => {
  const f = await setup(t),
    ack = await f.client.accept("accept", f.bundle, f.input),
    frame = await f.client.readAcceptance(ack.acceptance);
  assert.equal(frame.claim.ref.id, "accepted");
  assert.equal(frame.citation.links[0]!.relation, "quotes");
  assert.equal(frame.record.excerpt.quote, "Neutral");
  f.client.dispose();
});
test("lost actual acceptance ACK replays original body once; withdrawal denies recovery without rebasing or duplicate effect", async (t) => {
  const f = await setup(t);
  f.setLose();
  await assert.rejects(f.client.accept("accept", f.bundle, f.input));
  assert.equal((await f.repo.load(c)).revision, 2);
  await f.permissions.withdraw(c, "consent", "text-consent", 1, "withdraw");
  await assert.rejects(f.client.retryPending());
  assert(f.client.pending);
  assert.equal(f.bodies.length, 2);
  assert.equal(f.bodies[0], f.bodies[1]);
  assert.equal((await f.repo.load(c)).revision, 2);
  f.client.dispose();
});

test("lost actual acceptance HTTP ACK recovers only original historical references after manual identical replay", async (t) => {
  const f = await setup(t);
  f.setLose();
  await assert.rejects(f.client.accept("accept", f.bundle, f.input));
  const ack = await f.client.retryPending();
  assert.equal(ack.claim.id, "accepted");
  assert.equal(f.bodies[0], f.bodies[1]);
  assert.equal((await f.repo.load(c)).revision, 2);
  f.client.dispose();
});
