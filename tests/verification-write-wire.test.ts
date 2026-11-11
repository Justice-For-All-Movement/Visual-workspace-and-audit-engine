import test from "node:test";
import assert from "node:assert/strict";
import { VerificationWriteClient } from "../src/verification-write-client.ts";
import { frameFixture } from "./selected-verification-fixture.ts";
import { VERIFICATION_REVIEWS_KIND, VERIFICATION_REVIEWS_KEY } from "@accountability/knowledge-verification/repository";
const json = (v: unknown) => new Response(JSON.stringify(v), {
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
test("write binds different containing and logical editions without inventing history", async () => {
  const f = frameFixture(); f.frame.reviewRevision = 7;
  let post = "";
  const client = new VerificationWriteClient("https://private.invalid", f.scope, f.scope.purpose, async (url, init) => {
    if (String(url).endsWith("/session")) return json({ actorId: "viewer", csrfToken: "csrf" });
    if (String(url).endsWith("/review")) return json(f.frame);
    post = String(init!.body);
    return json({ record: { ...f.selected, revision: 2 }, storage: {
      tenantId: f.scope.tenantId, projectId: f.scope.projectId,
      kind: VERIFICATION_REVIEWS_KIND, id: VERIFICATION_REVIEWS_KEY, revision: 8,
    } });
  });
  await client.load(f.selected);
  const ack = await client.record("editions", f.frame.record.checks, "Unresolved");
  assert.equal(JSON.parse(post).expectedStorageRevision, 7);
  assert.equal(JSON.parse(post).input.expectedRevision, 1);
  assert.equal(ack.storage.revision, 8); assert.equal(ack.record.revision, 2);
  assert.equal(client.viewed, null); client.dispose();
});
test("excessive response bytes, chunks and incorrect lengths retain pending and cannot replace commands", async () => {
  const f = frameFixture(), headers = { "content-type": "application/json", "cache-control": "no-store" };
  for (const result of [
    () => new Response(" ".repeat(16385), { headers }),
    () => new Response("{}", { headers: { ...headers, "content-length": "1" } }),
    () => new Response(new ReadableStream<Uint8Array>({ start(c) {
      for (let i = 0; i < 4097; i++) c.enqueue(new Uint8Array()); c.close();
    } }), { headers }),
  ]) {
    let posts = 0;
    const client = new VerificationWriteClient("https://private.invalid", f.scope, f.scope.purpose, async url => {
      if (String(url).endsWith("/session")) return json({ actorId: "viewer", csrfToken: "csrf" });
      if (String(url).endsWith("/review")) return json(f.frame);
      posts++; return result();
    });
    await client.load(f.selected);
    await assert.rejects(client.record("exact", f.frame.record.checks, "Unresolved"));
    assert.equal(client.pending!.commandId, "exact");
    await assert.rejects(client.record("replacement", f.frame.record.checks, "Other"), { code: "pending_write" });
    assert.equal(posts, 1); client.dispose();
  }
});
test("blocked synchronous late write-session result cannot dispatch POST and closes all signals", async () => {
  const f = frameFixture(); let writing = false, posts = 0;
  const signals: AbortSignal[] = [];
  const client = new VerificationWriteClient("https://private.invalid", f.scope, f.scope.purpose, async (url, init) => {
    signals.push(init!.signal!);
    if (String(url).endsWith("/session")) {
      if (writing) { const end = performance.now() + 80; while (performance.now() < end) {} }
      return json({ actorId: "viewer", csrfToken: "csrf" });
    }
    if (String(url).endsWith("/review")) return json(f.frame);
    posts++; return json({});
  }, 50);
  await client.load(f.selected); writing = true;
  await assert.rejects(client.record("late-session", f.frame.record.checks, "Unresolved"), { code: "write_unavailable" });
  assert.equal(posts, 0); assert.equal(client.pending, null);
  assert.ok(signals.every(s => s.aborted)); client.dispose();
});
