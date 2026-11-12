import type test from "node:test";
import { ready as coverageReady, c, origin } from "./coverage-http-fixture.ts";
import { QuestionDispositionRepository } from "@accountability/factual-investigation/disposition-repository";
import { IdentityQuestionDispositionRepository } from "@accountability/factual-investigation/disposition-identity";
import { createDispositionReadHandler } from "@accountability/factual-investigation/disposition-read-http";
export { c, origin };
export async function ready(t: test.TestContext) {
  const f = await coverageReady(t),
    store = new QuestionDispositionRepository(f.factual, {
      ...f.fixed,
      humanIds: [c.actor.id],
    });
  const ack = await store.record(
    c,
    0,
    {
      planningStorage: f.ack.storage,
      effortStorage: null,
      review: {
        id: "review",
        expectedSequence: 0,
        supersedes: null,
        selected: f.ack.record,
        questions: [
          {
            questionId: "time",
            status: "assigned",
            reason: "Seek authorized contrary fixture",
            assigneeId: "fixture-human-label",
            reviewAt: "2026-02-01T00:00:00.000Z",
          },
        ],
        reopeningTriggers: ["New authorized fixture record"],
      },
    },
    "review",
  );
  const handler = createDispositionReadHandler(
    new IdentityQuestionDispositionRepository(store, f.membership, f.fixed),
    f.membership,
    {
      authenticate: async () => ({
        actorId: c.actor.id,
        requestId: c.requestId,
        csrfToken: "fixture-csrf-token-0000000000000000000000",
      }),
    },
    { ...f.fixed, origin },
    () => c.now,
  );
  return { ...f, store, handler, reviewAck: ack };
}
