import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { impactFixture } from "./selected-correction-impact-fixture.ts";
import { CorrectionImpactReadClient } from "../src/correction-impact-client.ts";
import { mountCorrectionImpactRead } from "../src/correction-impact-controls.ts";
const origin = "https://private.invalid",
  json = (x: unknown) =>
    new Response(JSON.stringify(x), {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
test("correction-impact client reads only explicitly with fresh session CSRF and exact two-ref selection; actor change closes before POST", async () => {
  const { scope, selected, frame } = impactFixture();
  let actor = "human";
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new CorrectionImpactReadClient(
    origin,
    scope,
    scope.purpose,
    (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json(
        String(url).endsWith("/session")
          ? { actorId: actor, csrfToken: "s".repeat(32) }
          : frame,
      );
    }) as typeof fetch,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.read(selected), frame);
  assert.equal(calls[1]!.url, origin + "/private/correction-impact/read");
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), selected);
  for (const call of calls) {
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.init.credentials, "same-origin");
    assert(call.init.signal!.aborted);
  }
  actor = "changed";
  await assert.rejects(client.read(selected));
  assert(client.closed);
  assert.equal(calls.filter((x) => x.url.endsWith("/read")).length, 1);
});
test("foreign getter-bearing selection expected-human mismatch and malformed private responses fail without releasing a frame", async () => {
  const { scope, selected, frame } = impactFixture();
  let calls = 0,
    getters = 0;
  const client = new CorrectionImpactReadClient(
    origin,
    scope,
    scope.purpose,
    (async (url) => {
      calls++;
      return json(
        String(url).endsWith("/session")
          ? { actorId: "other", csrfToken: "s".repeat(32) }
          : frame,
      );
    }) as typeof fetch,
    10000,
    "expected",
  );
  const choice = { ...selected };
  Object.defineProperty(choice, "before", {
    enumerable: true,
    get() {
      getters++;
      return selected.before;
    },
  });
  await assert.rejects(client.read(choice));
  assert.equal(getters, 0);
  assert.equal(calls, 0);
  await assert.rejects(client.read(selected));
  assert.equal(calls, 1);
  assert(client.closed);
  const malformed = new CorrectionImpactReadClient(
    origin,
    scope,
    scope.purpose,
    (async (url) =>
      String(url).endsWith("/session")
        ? json({ actorId: "human", csrfToken: "s".repeat(32) })
        : json({ ...frame, impact: {} })) as typeof fetch,
  );
  await assert.rejects(malformed.read(selected));
  malformed.dispose();
});
test("exclusive mounted correction-impact controls make no initial request and clear copied data on unavailable read and disposal", async () => {
  const { scope, selected, frame } = impactFixture(),
    dom = new JSDOM("<main></main>", { url: origin });
  let calls = 0,
    deny = false;
  const client = new CorrectionImpactReadClient(
    origin,
    scope,
    scope.purpose,
    (async (url) => {
      calls++;
      return String(url).endsWith("/session")
        ? json({ actorId: "human", csrfToken: "s".repeat(32) })
        : deny
          ? new Response("", { status: 503 })
          : json(frame);
    }) as typeof fetch,
  );
  const root = dom.window.document.querySelector("main")!,
    controls = mountCorrectionImpactRead(root, client, selected);
  assert.equal(calls, 0);
  assert.throws(() => mountCorrectionImpactRead(root, client, selected));
  const button = root.querySelector("button")!;
  button.click();
  for (let n = 0; n < 50 && !root.querySelector("table"); n++)
    await new Promise((r) => setTimeout(r, 5));
  assert(root.querySelector("table"));
  assert(root.textContent?.includes("review-required"));
  deny = true;
  button.click();
  assert.equal(root.querySelector("table"), null);
  for (let n = 0; n < 50 && client.busy; n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(root.querySelector("table"), null);
  controls.dispose();
  assert(client.closed);
  assert.equal(root.children.length, 0);
});
test("disposal and monotonic deadline fence noncooperative transport results and retain no cached correction-impact", async () => {
  const { scope, selected, frame } = impactFixture();
  let release!: (x: Response) => void;
  const signals: AbortSignal[] = [];
  const client = new CorrectionImpactReadClient(origin, scope, scope.purpose, ((
    _url,
    init,
  ) => {
    signals.push(init!.signal!);
    return new Promise<Response>((r) => {
      release = r;
    });
  }) as typeof fetch);
  const pending = client.read(selected);
  client.dispose();
  release(json(frame));
  await assert.rejects(pending);
  assert(signals.every((s) => s.aborted));
  const late = new CorrectionImpactReadClient(
    origin,
    scope,
    scope.purpose,
    (async () => {
      const until = performance.now() + 40;
      while (performance.now() < until) {}
      return json({ actorId: "human", csrfToken: "s".repeat(32) });
    }) as typeof fetch,
    10,
  );
  await assert.rejects(late.read(selected));
  late.dispose();
});

test("malformed UTF8, declared length, chunk budgets and cancellation reject whole responses and close owned signals", async () => {
  const { scope, selected, frame } = impactFixture();
  const bad = [
    () =>
      new Response(new Uint8Array([255]), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      }),
    () =>
      new Response(JSON.stringify(frame), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "content-length": "1",
        },
      }),
    () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            for (let n = 0; n < 4097; n++) ctrl.enqueue(new Uint8Array());
            ctrl.close();
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        },
      ),
    () =>
      new Response(JSON.stringify(frame), {
        headers: {
          "content-type": "application/json",
          "cache-control": "public",
        },
      }),
  ];
  for (const make of bad) {
    const signals: AbortSignal[] = [];
    const client = new CorrectionImpactReadClient(
      origin,
      scope,
      scope.purpose,
      (async (url, init) => {
        signals.push(init!.signal!);
        return String(url).endsWith("/session")
          ? json({ actorId: "human", csrfToken: "s".repeat(32) })
          : make();
      }) as typeof fetch,
    );
    await assert.rejects(client.read(selected));
    assert(signals.every((s) => s.aborted));
    client.dispose();
  }
  let calls = 0;
  const client = new CorrectionImpactReadClient(
      origin,
      scope,
      scope.purpose,
      (async () => {
        calls++;
        throw Error("private provider diagnostic");
      }) as typeof fetch,
    ),
    abort = new AbortController();
  abort.abort();
  await assert.rejects(client.read(selected, abort.signal), {
    code: "read_unavailable",
  });
  assert.equal(calls, 0);
  client.dispose();
});
test("busy direct dispatch and detachment fence late private frames without duplicate reads", async () => {
  const { scope, selected, frame } = impactFixture(),
    dom = new JSDOM("<main/>", { url: origin }),
    root = dom.window.document.querySelector("main")!;
  let release!: (r: Response) => void,
    calls = 0;
  const client = new CorrectionImpactReadClient(origin, scope, scope.purpose, ((
    _url,
  ) => {
    calls++;
    return new Promise<Response>((r) => (release = r));
  }) as typeof fetch);
  const controls = mountCorrectionImpactRead(root, client, selected),
    button = root.querySelector("button")!;
  button.click();
  button.dispatchEvent(new dom.window.Event("click"));
  assert.equal(calls, 1);
  root.remove();
  await new Promise((r) => setTimeout(r, 0));
  release(json(frame));
  await new Promise((r) => setTimeout(r, 0));
  assert(client.closed);
  assert.equal(root.querySelector("table"), null);
  controls.dispose();
});
