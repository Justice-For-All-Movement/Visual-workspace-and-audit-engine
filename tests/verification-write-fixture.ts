import type test from "node:test";
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

export async function setup(t: test.TestContext) {
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
