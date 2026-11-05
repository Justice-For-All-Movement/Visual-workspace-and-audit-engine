import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountVerificationWrite } from "../src/verification-write-controls.ts";
import { VerificationWriteClient } from "../src/verification-write-client.ts";
import { setup } from "./verification-write-fixture.ts";
import { c } from "./verification-http-fixture.ts";
import { frameFixture } from "./selected-verification-fixture.ts";

function dom() {
  const d = new JSDOM('<main></main>', { url: "https://private.invalid" });
  const root = d.window.document.querySelector("main")!;
  const buttons = () => Array.from(root.querySelectorAll("button"));
  const click = (index: number) => buttons()[index]!.dispatchEvent(new d.window.Event("click", { bubbles: true }));
  return { d, root, click, buttons };
}
async function until(check: () => boolean) {
  const end = performance.now() + 15000;
  while (!check()) {
    if (performance.now() > end) throw Error("test did not settle");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
const response = (v: unknown) => new Response(JSON.stringify(v), {
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
function synthetic(transport?: typeof fetch) {
  const f = frameFixture();
  let calls = 0;
  const client = new VerificationWriteClient("https://private.invalid", f.scope, f.scope.purpose,
    transport ?? (async url => { calls++; return String(url).endsWith("/session")
      ? response({ actorId: "viewer", csrfToken: "csrf" }) : response(f.frame); }));
  return { ...f, client, calls: () => calls };
}

test("mounted actual guarded editor reads explicitly, guards dirty reload, saves and selects only returned ACK", async t => {
  const f = await setup(t), v = dom();
  t.after(() => v.d.window.close());
  let ids = 0;
  const mount = mountVerificationWrite(v.root, f.client, f.initial.record, () => "ui-" + ++ids);
  t.after(mount.dispose);
  assert.equal(f.client.viewed, null);
  assert.equal(v.root.querySelector("fieldset")!.disabled, true);
  v.click(0); v.click(0);
  await until(() => !!f.client.viewed && !f.client.busy && !v.root.querySelector("fieldset")!.disabled);
  const rationale = v.root.querySelector<HTMLTextAreaElement>('[name="rationale"]')!;
  const original = rationale.value;
  rationale.value = "</textarea><script>inert literal observation</script>";
  rationale.dispatchEvent(new v.d.window.Event("input", { bubbles: true }));
  assert.equal(v.buttons()[0]!.disabled, true);
  v.click(0); // Direct dispatch must obey dirty guard.
  assert.ok(f.client.viewed);
  v.click(1);
  assert.equal(rationale.value, original);
  rationale.value = "Unresolved human UI observation";
  v.click(2); v.click(2);
  await until(() => v.root.textContent!.includes("Write acknowledged"));
  assert.equal(ids, 1);
  assert.equal(f.posts(), 1);
  assert.equal(f.client.viewed, null);
  const stored = await f.repo.loadVerificationReviews(c);
  assert.equal(stored.revision, 2);
  assert.equal(stored.state.records.at(-1)!.rationale, "Unresolved human UI observation");
  assert.equal(stored.state.records.at(-1)!.resolution, "unresolved");
  assert.match(v.root.textContent!, /"revision":2/);
  assert.equal(v.root.querySelector("script"), null);
  v.click(0);
  await until(() => f.client.viewed?.record.ref.revision === 2 && !f.client.busy);
  const observed = () => f.client.viewed;
  assert.equal(observed()?.reviewRevision, 2);
});

test("mounted lost actual ACK locks edits/reads/discard and explicit identical replay creates no second effect", async t => {
  const f = await setup(t), v = dom();
  t.after(() => v.d.window.close());
  let ids = 0;
  const mount = mountVerificationWrite(v.root, f.client, f.initial.record, () => "lost-ui-" + ++ids);
  t.after(mount.dispose);
  v.click(0);
  await until(() => !!f.client.viewed && !f.client.busy);
  f.setLose(); v.click(2);
  await until(() => v.root.textContent!.includes("Write outcome unresolved"));
  const exact = JSON.stringify(f.client.pending);
  assert.equal(f.posts(), 1);
  assert.equal(v.root.querySelector("fieldset")!.disabled, true);
  v.click(0); v.click(1); v.click(2);
  assert.equal(f.posts(), 1);
  assert.equal(JSON.stringify(f.client.pending), exact);
  v.click(3); v.click(3);
  await until(() => v.root.textContent!.includes("Write acknowledged"));
  assert.equal(ids, 1);
  assert.equal(f.posts(), 2);
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 2);
});

test("actual current withdrawal clears captured observations; changed current viewer closes before replay POST", async t => {
  const f = await setup(t), v = dom();
  t.after(() => v.d.window.close());
  const mount = mountVerificationWrite(v.root, f.client, f.initial.record, () => "withdrawn-ui");
  t.after(mount.dispose);
  v.click(0); await until(() => !!f.client.viewed && !f.client.busy);
  await f.permissions.withdraw(c, "consent", "consent", 1, "withdraw-ui");
  v.click(2);
  await until(() => v.root.textContent!.includes("Write outcome unresolved"));
  assert.equal(v.root.querySelector<HTMLTextAreaElement>('[name="rationale"]')!.value, "");
  assert.equal((await f.repo.loadVerificationReviews(c)).revision, 1);
  await f.membership.apply(c, 1, { type: "set-member", id: "backup", kind: "human", roles: ["owner"] }, "backup-ui");
  f.setActor("backup"); v.click(3);
  await until(() => f.client.closed && v.root.childElementCount === 0);
  assert.equal(f.posts(), 1);
  assert.ok(f.client.pending);
});

test("exclusive ownership and direct detach fences close private editors and stale handlers", async () => {
  const f = synthetic(), v = dom();
  const mount = mountVerificationWrite(v.root, f.client, f.selected, () => "x");
  assert.throws(() => mountVerificationWrite(v.root, f.client, f.selected, () => "x"));
  const oldRead = v.buttons()[0]!;
  v.root.querySelector("textarea")!.remove();
  oldRead.dispatchEvent(new v.d.window.Event("click"));
  assert.equal(f.client.closed, true);
  assert.equal(f.calls(), 0);
  assert.equal(v.root.childElementCount, 0);
  mount.dispose(); v.d.window.close();
});

test("dispose during host command ID callback fences new write I/O and clears retained private input", async () => {
  const f = synthetic(), v = dom();
  let mount: { dispose(): void };
  mount = mountVerificationWrite(v.root, f.client, f.selected, () => { v.click(2); mount.dispose(); return "disposed"; });
  v.click(0); await until(() => !!f.client.viewed && !f.client.busy);
  const rationale = v.root.querySelector<HTMLTextAreaElement>('[name="rationale"]')!;
  v.click(2);
  assert.equal(f.calls(), 2);
  assert.equal(f.client.closed, true);
  assert.equal(rationale.value, "");
  assert.equal(v.root.childElementCount, 0);
  v.d.window.close();
});

test("detaching during a noncooperative read withholds late frame and clears private controls", async () => {
  let release!: (r: Response) => void;
  const f = synthetic(async url => String(url).endsWith("/session")
    ? response({ actorId: "viewer", csrfToken: "csrf" })
    : new Promise<Response>(r => { release = r; }));
  const v = dom(), mount = mountVerificationWrite(v.root, f.client, f.selected, () => "late");
  v.click(0); await until(() => !!release);
  v.root.remove();
  await until(() => f.client.closed);
  release(response(f.frame));
  await new Promise<void>(r => setImmediate(r));
  assert.equal(v.root.childElementCount, 0);
  assert.equal(f.client.viewed, null);
  mount.dispose(); v.d.window.close();
});
