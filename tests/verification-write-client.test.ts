import test from "node:test";
import assert from "node:assert/strict";
import { VerificationWriteClient } from "../src/verification-write-client.ts";
import { frameFixture } from "./selected-verification-fixture.ts";
import {
  VERIFICATION_REVIEWS_KEY,
  VERIFICATION_REVIEWS_KIND,
} from "@accountability/knowledge-verification/repository";

const origin = "https://private.invalid";
const response = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
function setup() {
  const f = frameFixture(),
    posts: string[] = [],
    tokens: string[] = [],
    signals: AbortSignal[] = [];
  let actor = "viewer",
    unknown = false,
    csrf = 0;
  let client: VerificationWriteClient;
  const transport: typeof fetch = async (input, init) => {
    signals.push(init!.signal!);
    const url = String(input);
    if (url.endsWith("/session"))
      return response({ actorId: actor, csrfToken: "csrf-" + ++csrf });
    if (url.endsWith("/review")) return response(f.frame);
    posts.push(String(init!.body));
    tokens.push(new Headers(init!.headers).get("x-csrf-token")!);
    assert.ok(client.pending, "pending must exist before transport POST");
    return unknown
      ? response({ error: "verification_write_unknown" }, 503)
      : response({
          record: { ...f.selected, revision: f.selected.revision + 1 },
          storage: {
            tenantId: f.scope.tenantId,
            projectId: f.scope.projectId,
            kind: VERIFICATION_REVIEWS_KIND,
            id: VERIFICATION_REVIEWS_KEY,
            revision: f.frame.reviewRevision + 1,
          },
        });
  };
  client = new VerificationWriteClient(
    origin,
    f.scope,
    f.scope.purpose,
    transport,
  );
  return {
    ...f,
    client,
    posts,
    tokens,
    signals,
    setActor: (v: string) => {
      actor = v;
    },
    setUnknown: (v: boolean) => {
      unknown = v;
    },
  };
}
test("explicit loaded-frame writes bind containing and logical revisions to actual owning ACK profile", async () => {
  const f = setup();
  assert.equal(f.posts.length, 0);
  await assert.rejects(
    f.client.record("command", f.frame.record.checks, "note"),
    { code: "review_required" },
  );
  const frame = await f.client.load(f.selected);
  (frame.record.checks.authenticity as any).note = "caller change";
  const ack = await f.client.record("command", f.frame.record.checks, "note");
  assert.equal(ack.storage.id, VERIFICATION_REVIEWS_KEY);
  assert.equal(f.client.pending, null);
  assert.equal(f.client.viewed, null);
  assert.deepEqual(JSON.parse(f.posts[0]!), {
    commandId: "command",
    expectedStorageRevision: f.frame.reviewRevision,
    input: {
      linkRef: f.frame.record.linkRef,
      expectedRevision: f.frame.record.ref.revision,
      checks: f.frame.record.checks,
      rationale: "note",
    },
  });
  assert.ok(f.signals.every((s) => s.aborted));
});
test("uncertain writes retain immutable pending; only explicit identical replay with fresh CSRF can unlock", async () => {
  const f = setup();
  await f.client.load(f.selected);
  f.setUnknown(true);
  await assert.rejects(
    f.client.record("command", f.frame.record.checks, "note"),
    { code: "write_unavailable" },
  );
  const pending = f.client.pending!;
  (pending.input as any).rationale = "mutated";
  await assert.rejects(f.client.load(f.selected), { code: "pending_write" });
  await assert.rejects(f.client.record("other", f.frame.record.checks, "new"), {
    code: "pending_write",
  });
  assert.equal(f.posts.length, 1);
  f.setUnknown(false);
  await f.client.retryPending();
  assert.equal(f.posts[0], f.posts[1]);
  assert.notEqual(f.tokens[0], f.tokens[1]);
  assert.equal(f.client.pending, null);
});
test("stored author is not viewer; changed session actor closes before any POST", async () => {
  const f = setup();
  assert.notEqual(f.frame.record.actorId, "viewer");
  await f.client.load(f.selected);
  f.setActor("another viewer");
  await assert.rejects(
    f.client.record("command", f.frame.record.checks, "note"),
    { code: "actor_changed" },
  );
  assert.equal(f.posts.length, 0);
  assert.equal(f.client.closed, true);
});
test("input authority/accessors are refused before write I/O", async () => {
  const f = setup();
  await f.client.load(f.selected);
  let reads = 0;
  const checks = { ...f.frame.record.checks };
  Object.defineProperty(checks, "authenticity", {
    enumerable: true,
    get() {
      reads++;
      return f.frame.record.checks.authenticity;
    },
  });
  await assert.rejects(f.client.record("command", checks, "note"));
  assert.equal(reads, 0);
  assert.equal(f.posts.length, 0);
});

test("rejected and malformed ACKs preserve exact pending without automatic retry", async()=>{
 const f=frameFixture();
 for(const outcome of [()=>response({error:"denied"},403),()=>response({record:f.selected,storage:f.selected}),()=>response({grant:true}),()=>new Response(Uint8Array.of(0xc3,0x28),{headers:{"content-type":"application/json","cache-control":"no-store"}})]){
  let posts=0;
  const client=new VerificationWriteClient(origin,f.scope,f.scope.purpose,async(url,init)=>{
   if(String(url).endsWith("/session"))return response({actorId:"viewer",csrfToken:"x"});
   if(String(url).endsWith("/review"))return response(f.frame);
   posts++;return outcome();
  });
  await client.load(f.selected);await assert.rejects(client.record("pending",f.frame.record.checks,"Note"));
  assert.equal(posts,1);assert.equal(client.pending!.commandId,"pending");await assert.rejects(client.load(f.selected),{code:"pending_write"});
 }
});

test("cancellation after POST preserves uncertainty and fences a late acknowledged response",async()=>{
 const f=frameFixture(),control=new AbortController();let release!:(v:Response)=>void,posted!:()=>void;
 const started=new Promise<void>(r=>{posted=r;});
 const client=new VerificationWriteClient(origin,f.scope,f.scope.purpose,async(url)=>{
  if(String(url).endsWith("/session"))return response({actorId:"viewer",csrfToken:"x"});
  if(String(url).endsWith("/review"))return response(f.frame);
  posted();return new Promise<Response>(r=>{release=r;});
 });
 await client.load(f.selected);const pending=client.record("cancelled",f.frame.record.checks,"Note",control.signal);
 await started;control.abort();await assert.rejects(pending,{code:"write_unavailable"});assert.ok(client.pending);
 let cancelled=false;release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise(r=>setTimeout(r,0));assert.equal(cancelled,true);assert.ok(client.pending);
 client.dispose();await assert.rejects(client.retryPending(),{code:"closed"});
});
