import test from "node:test";
import assert from "node:assert/strict";
import { createAlphaCorrespondenceFixture, transitionCorrespondence } from "@accountability/correspondence";
import { createOperatorHandler } from "@accountability/correspondence/operator";
import { OperatorClient } from "../src/operator-client.ts";

function setup(authenticationTimeoutMs = 1000, bodyTimeoutMs = 1000) {
  const f = createAlphaCorrespondenceFixture();
  let state = f.state, executions = 0;
  const context = f.steps[0]!.context;
  const signals: AbortSignal[] = [];
  let blockAuthentication = false, blockBody = false;
  const posts: string[] = [];
  const handler = createOperatorHandler({
    load: async () => structuredClone(state),
    execute: async (c, _id, _expected, command) => {
      executions++;
      const result = transitionCorrespondence(state, c, command);
      state = result.state;
      return result;
    },
  }, { authenticate: async (_metadata, signal) => {
    signals.push(signal);
    if (blockAuthentication) {
      const until = performance.now() + 60;
      while (performance.now() < until) {}
    }
    return { context, csrfToken: "c".repeat(43) };
  } }, { tenantId: state.tenantId, projectId: state.projectId, mailboxId: state.mailbox.id,
    origin: "https://workspace.example", authenticationTimeoutMs, bodyTimeoutMs });
  const transport: typeof fetch = async (input, init) => {
    if (init?.method === "POST") posts.push(String(init.body));
    if (init?.method === "POST" && blockBody) {
      const bytes = Buffer.from(String(init.body));
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        return new Promise<void>(resolve => setTimeout(() => {
          const until = performance.now() + 60;
          while (performance.now() < until) {}
          controller.enqueue(bytes); controller.close(); resolve();
        }, 0));
      } });
      return handler(new Request(input, { ...init, body, duplex: "half" } as RequestInit));
    }
    return handler(new Request(input, init));
  };
  return { client: new OperatorClient("https://workspace.example", transport), signals, posts,
    set authBlocked(value: boolean) { blockAuthentication = value; },
    set bodyBlocked(value: boolean) { blockBody = value; },
    get executions() { return executions; }, get state() { return structuredClone(state); } };
}

test("pinned operator denies late authentication before the Visual client can receive a private session", async () => {
  const f = setup(20);
  f.authBlocked = true;
  await assert.rejects(f.client.session(), (e: any) => e.code === "outcome_unknown");
  assert.equal(f.executions, 0);
  assert.equal(f.client.pending, null);
  assert.ok(f.signals.every(signal => signal.aborted));
});
test("pinned operator closes successful authentication signals while preserving the accepted client session profile", async () => {
  const f = setup();
  const session = await f.client.session();
  assert.equal(session.revision, f.state.revision);
  assert.ok(f.signals.length > 0 && f.signals.every(signal => signal.aborted));
  assert.equal(f.executions, 0);
});
test("late operator body cannot commit; definitive rejection causes no automatic resubmission", async () => {
  const f = setup(1000, 20);
  const session = await f.client.session(), before = f.state;
  f.bodyBlocked = true;
  const command = { type: "setControl" as const, inputId: "deadline-human-takeover", mode: "human" as const };
  await assert.rejects(f.client.submit(session.revision, command), (e: any) => e.code === "request_rejected");
  assert.equal(f.executions, 0);
  assert.deepEqual(f.state, before);
  assert.equal(f.client.pending, null);
  assert.equal(f.posts.length, 1);
  await assert.rejects(f.client.retryPending(), (e: any) => e.code === "no_pending_edit");
  f.bodyBlocked = false;
  const result = await f.client.submit(session.revision, command);
  assert.equal(f.executions, 1);
  assert.equal(result.revision, f.state.revision);
  assert.equal(f.posts[0], f.posts[1]);
  assert.equal(f.client.pending, null);
  assert.equal(f.state.mailbox.control, "human");
});
