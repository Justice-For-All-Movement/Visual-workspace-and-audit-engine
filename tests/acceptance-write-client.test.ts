import test from "node:test";
import assert from "node:assert/strict";
import { AcceptanceWriteClient } from "../src/acceptance-write-client.ts";
import { acceptanceDomain, c } from "./selected-acceptance-fixture.ts";
import { acceptCapturedClaimProposal } from "@accountability/knowledge-verification/proposal-acceptance";
import { digest } from "@accountability/knowledge-verification/contracts";
import {
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
  EVIDENCE_LINKS_KIND,
  EVIDENCE_LINKS_KEY,
  PROPOSAL_ACCEPTANCE_KIND,
} from "@accountability/knowledge-verification/repository";
const origin = "https://private.invalid";
function fixture() {
  const d = acceptanceDomain(true),
    r = acceptCapturedClaimProposal(
      c,
      d.knowledge,
      d.links,
      d.bundle,
      d.command,
    );
  const ref = (kind: string, id: string, revision: number) => ({
    tenantId: c.tenantId,
    projectId: c.projectId,
    kind,
    id,
    revision,
  });
  return {
    ...d,
    ack: {
      knowledgeStorage: ref(KNOWLEDGE_KIND, KNOWLEDGE_KEY, 2),
      linksStorage: ref(EVIDENCE_LINKS_KIND, EVIDENCE_LINKS_KEY, 2),
      acceptance: ref(
        PROPOSAL_ACCEPTANCE_KIND,
        digest({ claim: r.acceptance.claim }),
        1,
      ),
      claim: r.acceptance.claim,
      links: r.acceptance.links,
    },
  };
}
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
test("fresh session accepts exact original command and verifies all five owning ACK references with browser SHA256", async () => {
  const f = fixture(),
    calls: { url: string; init: RequestInit }[] = [];
  const client = new AcceptanceWriteClient(
    origin,
    c,
    c.purpose,
    c.actor.id,
    (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json(
        String(url).endsWith("/session")
          ? { actorId: c.actor.id, csrfToken: "s".repeat(32) }
          : f.ack,
      );
    }) as typeof fetch,
  );
  assert.deepEqual(await client.accept("accept", f.bundle, f.command), f.ack);
  assert.equal(client.pending, null);
  assert.equal(
    calls[1]!.url,
    origin + "/private/proposal-acceptance-write/accept",
  );
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), {
    commandId: "accept",
    bundle: f.bundle,
    input: f.command,
  });
  for (const v of calls) {
    assert.equal(v.init.credentials, "same-origin");
    assert.equal(v.init.cache, "no-store");
    assert(v.init.signal!.aborted);
  }
});
test("unknown outcome retains a detached original command and only explicit identical replay is allowed", async () => {
  const f = fixture(),
    original = structuredClone({ bundle: f.bundle, input: f.command }),
    bodies: string[] = [];
  let lose = true;
  const client = new AcceptanceWriteClient(
    origin,
    c,
    c.purpose,
    c.actor.id,
    (async (url, init) => {
      if (String(url).endsWith("/session"))
        return json({ actorId: c.actor.id, csrfToken: "s".repeat(32) });
      bodies.push(init!.body as string);
      if (lose) {
        lose = false;
        throw Error("lost ack");
      }
      return json(f.ack);
    }) as typeof fetch,
  );
  await assert.rejects(client.accept("accept", f.bundle, f.command));
  f.bundle.proposals[0]!.assertion = "caller changed";
  f.command.claimId = "second";
  const pending = client.pending!;
  (pending.input as any).claimId = "mutated returned copy";
  await assert.rejects(client.accept("second", f.bundle, f.command));
  await assert.rejects(client.readAcceptance(f.ack.acceptance));
  assert.deepEqual(await client.retryPending(), f.ack);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[0]!).bundle, original.bundle);
});
test("getters extra fields and foreign captured bundles fail before session transport", async () => {
  const f = fixture();
  let calls = 0,
    getters = 0;
  const client = new AcceptanceWriteClient(
    origin,
    c,
    c.purpose,
    c.actor.id,
    (async () => {
      calls++;
      return json({});
    }) as typeof fetch,
  );
  const b = { ...f.bundle };
  Object.defineProperty(b, "basis", {
    enumerable: true,
    get() {
      getters++;
      return f.bundle.basis;
    },
  });
  await assert.rejects(client.accept("x", b, f.command));
  await assert.rejects(
    client.accept("x", { ...f.bundle, projectId: "foreign" }, f.command),
  );
  await assert.rejects(
    client.accept("x", f.bundle, { ...f.command, permit: true } as any),
  );
  await assert.rejects(
    client.accept("x", { ...f.bundle, ["x".repeat(257)]: true }, f.command),
  );
  assert.equal(calls, 0);
  assert.equal(getters, 0);
  assert.equal(client.pending, null);
});
test("rejected or malformed ACK keeps pending and changed session actor closes before replay POST", async () => {
  const f = fixture();
  let actor = c.actor.id,
    posts = 0;
  const client = new AcceptanceWriteClient(
    origin,
    c,
    c.purpose,
    c.actor.id,
    (async (url) => {
      if (String(url).endsWith("/session"))
        return json({ actorId: actor, csrfToken: "s".repeat(32) });
      posts++;
      return json({
        ...f.ack,
        acceptance: { ...f.ack.acceptance, id: "f".repeat(64) },
      });
    }) as typeof fetch,
  );
  await assert.rejects(client.accept("accept", f.bundle, f.command));
  assert(client.pending);
  actor = "another";
  await assert.rejects(client.retryPending());
  assert(client.closed);
  assert.equal(posts, 1);
});
test("expected actor binds receipt read before POST and explicit cancellation after POST keeps pending immutable", async () => {
  const f = fixture();
  let posts = 0;
  const wrong = new AcceptanceWriteClient(
    origin,
    c,
    c.purpose,
    c.actor.id,
    (async (url) => {
      if (String(url).endsWith("/session"))
        return json({ actorId: "another", csrfToken: "s".repeat(32) });
      posts++;
      return json({});
    }) as typeof fetch,
  );
  await assert.rejects(wrong.readAcceptance(f.ack.acceptance));
  assert(wrong.closed);
  assert.equal(posts, 0);
  const controller = new AbortController();
  let release!: (r: Response) => void,
    started = false;
  const client = new AcceptanceWriteClient(
    origin,
    c,
    c.purpose,
    c.actor.id,
    (async (url) => {
      if (String(url).endsWith("/session"))
        return json({ actorId: c.actor.id, csrfToken: "s".repeat(32) });
      started = true;
      return new Promise<Response>((r) => {
        release = r;
      });
    }) as typeof fetch,
  );
  const pending = client.accept(
    "accept",
    f.bundle,
    f.command,
    controller.signal,
  );
  for (let n = 0; n < 100 && !started; n++)
    await new Promise((r) => setTimeout(r, 1));
  assert(started);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(client.pending!.input.claimId, "accepted");
  release(json(f.ack));
  await new Promise((r) => setTimeout(r, 1));
  assert(client.pending);
  client.dispose();
});
