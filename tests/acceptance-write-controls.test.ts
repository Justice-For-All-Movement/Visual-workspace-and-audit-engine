import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { setup } from "./acceptance-write-fixture.ts";
import { c } from "./acceptance-http-fixture.ts";
import { mountAcceptanceWrite } from "../src/acceptance-write-controls.ts";
async function until(fn: () => boolean) {
  for (let n = 0; n < 500 && !fn(); n++)
    await new Promise((r) => setTimeout(r, 5));
  assert(fn());
}
test("explicit unchecked acceptance intent precedes actual write and exact acknowledged read; exclusive ownership/detach guards", async (t) => {
  const f = await setup(t),
    dom = new JSDOM("<main></main>", { url: "https://private.invalid" }),
    root = dom.window.document.querySelector("main")!;
  const controls = mountAcceptanceWrite(
      root,
      f.client,
      "accept",
      f.bundle,
      f.input,
    ),
    affirm = root.querySelector("input")!,
    buttons = root.querySelectorAll("button");
  assert.equal(f.bodies.length, 0);
  assert(!affirm.checked);
  assert(buttons[0]!.disabled);
  assert.throws(() =>
    mountAcceptanceWrite(root, f.client, "other", f.bundle, f.input),
  );
  buttons[0]!.dispatchEvent(new dom.window.Event("click"));
  assert.equal(f.bodies.length, 0);
  affirm.checked = true;
  affirm.dispatchEvent(new dom.window.Event("change"));
  buttons[0]!.click();
  buttons[0]!.dispatchEvent(new dom.window.Event("click"));
  await until(() => !buttons[2]!.disabled);
  assert.equal(f.bodies.length, 1);
  assert(buttons[0]!.disabled);
  buttons[2]!.click();
  await until(() => !!root.querySelector("blockquote"));
  assert.equal(root.querySelector("blockquote")!.textContent, "Neutral");
  controls.dispose();
  assert.equal(root.children.length, 0);
  assert(f.client.closed);
});
test("mounted lost actual ACK locks acceptance, preserves original input and requires explicit identical replay", async (t) => {
  const f = await setup(t),
    dom = new JSDOM("<main></main>", { url: "https://private.invalid" }),
    root = dom.window.document.querySelector("main")!;
  f.setLose();
  const controls = mountAcceptanceWrite(
      root,
      f.client,
      "accept",
      f.bundle,
      f.input,
    ),
    affirm = root.querySelector("input")!,
    buttons = root.querySelectorAll("button");
  affirm.checked = true;
  affirm.dispatchEvent(new dom.window.Event("change"));
  buttons[0]!.click();
  await until(() => !buttons[1]!.disabled);
  assert(buttons[0]!.disabled);
  assert(affirm.disabled);
  assert(buttons[2]!.disabled);
  f.bundle.proposals[0]!.assertion = "changed caller";
  f.input.claimId = "second";
  buttons[1]!.click();
  await until(() => !buttons[2]!.disabled);
  assert.equal(f.bodies.length, 2);
  assert.equal(f.bodies[0], f.bodies[1]);
  assert.equal((await f.repo.load(c)).revision, 2);
  controls.dispose();
});
test("detached mounted component cannot dispatch a new acceptance", async (t) => {
  const f = await setup(t),
    dom = new JSDOM("<main></main>", { url: "https://private.invalid" }),
    root = dom.window.document.querySelector("main")!;
  const controls = mountAcceptanceWrite(
      root,
      f.client,
      "accept",
      f.bundle,
      f.input,
    ),
    affirm = root.querySelector("input")!,
    button = root.querySelector("button")!;
  affirm.checked = true;
  affirm.dispatchEvent(new dom.window.Event("change"));
  root.remove();
  button.dispatchEvent(new dom.window.Event("click"));
  await new Promise((r) => setTimeout(r, 1));
  assert.equal(f.bodies.length, 0);
  assert(f.client.closed);
  controls.dispose();
});
