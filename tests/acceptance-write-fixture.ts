import test from "node:test";
import assert from "node:assert/strict";
import { acceptanceFixture, c } from "./acceptance-http-fixture.ts";
import { createProposalAcceptanceWriteHandler } from "@accountability/knowledge-verification/proposal-acceptance-write-http";
import { createProposalAcceptanceReadHandler } from "@accountability/knowledge-verification/proposal-acceptance-http";
import { CurrentProposalAcceptanceReader } from "@accountability/knowledge-verification/proposal-acceptance-reader";
import { AcceptanceWriteClient } from "../src/acceptance-write-client.ts";
const origin = "https://private.invalid";
export async function setup(t: test.TestContext) {
  const f = await acceptanceFixture(t),
    cfg = { ...f.fixed, origin },
    provider = {
      authenticate: async () => ({
        actorId: c.actor.id,
        requestId: "browser",
        csrfToken: "s".repeat(32),
      }),
    };
  const write = createProposalAcceptanceWriteHandler(
    f.writer,
    f.membership,
    provider,
    cfg,
    () => c.now,
  );
  const read = createProposalAcceptanceReadHandler(
    new CurrentProposalAcceptanceReader(f.facade, f.review),
    f.membership,
    provider,
    cfg,
    () => c.now,
  );
  let lose = false;
  const bodies: string[] = [];
  const client = new AcceptanceWriteClient(
    origin,
    c,
    c.purpose,
    c.actor.id,
    async (url, init) => {
      const isWrite = String(url).includes("acceptance-write");
      if (isWrite && init?.method === "POST") bodies.push(init.body as string);
      const result = await (isWrite ? write : read)(
        new Request(String(url), init),
      );
      if (isWrite && init?.method === "POST" && result.status === 200 && lose) {
        lose = false;
        await result.body?.cancel();
        throw Error("lost actual HTTP ACK");
      }
      return result;
    },
  );
  return {
    ...f,
    client,
    bodies,
    setLose: () => {
      lose = true;
    },
  };
}
