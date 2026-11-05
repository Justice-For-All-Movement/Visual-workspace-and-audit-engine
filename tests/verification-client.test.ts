import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { VerificationReadClient } from "../src/verification-client.ts";
import { mountVerificationRead } from "../src/verification-controls.ts";
import { frameFixture } from "./selected-verification-fixture.ts";

const origin = "https://private.invalid";
const response = (v: unknown) =>
  new Response(JSON.stringify(v), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
const wait = () => new Promise((r) => setTimeout(r, 0));
function setup() {
  const f = frameFixture(),
    calls: { url: string; init: RequestInit }[] = [],
    signals: AbortSignal[] = [];
  let actor = "human",
    csrf = 0;
  const transport: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init! });
    signals.push(init!.signal!);
    return String(input).endsWith("/session")
      ? response({ actorId: actor, csrfToken: "csrf-" + ++csrf })
      : response(f.frame);
  };
  return {
    ...f,
    calls,
    signals,
    transport,
    setActor: (v: string) => {
      actor = v;
    },
    client: new VerificationReadClient(
      origin,
      f.scope,
      f.scope.purpose,
      transport,
    ),
  };
}

test("client makes only explicit fixed-origin session/review reads with fresh CSRF and detached exact selected response", async () => {
  const f = setup();
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.client.read(f.selected), f.frame);
  assert.deepEqual(await f.client.read(f.selected), f.frame);
  assert.deepEqual(
    f.calls.map((c) => new URL(c.url).pathname),
    [
      "/private/verification/session",
      "/private/verification/review",
      "/private/verification/session",
      "/private/verification/review",
    ],
  );
  for (const c of f.calls) {
    assert.equal(c.init.credentials, "same-origin");
    assert.equal(c.init.redirect, "error");
    assert.equal(c.init.cache, "no-store");
    assert.equal(c.init.mode, "same-origin");
  }
  assert.notEqual(
    (f.calls[1]!.init.headers as any)["x-csrf-token"],
    (f.calls[3]!.init.headers as any)["x-csrf-token"],
  );
  assert.deepEqual(JSON.parse(String(f.calls[1]!.init.body)), {
    selected: f.selected,
  });
  assert.ok(f.signals.every((s) => s.aborted));
});

test("actor changes permanently close before another selected request; foreign selections make no request", async () => {
  const f = setup();
  await assert.rejects(f.client.read({ ...f.selected, projectId: "foreign" }));
  assert.equal(f.calls.length, 0);
  await f.client.read(f.selected);
  f.setActor("other");
  await assert.rejects(f.client.read(f.selected), { code: "actor_changed" });
  assert.equal(f.calls.length, 3);
  assert.equal(f.client.closed, true);
  await assert.rejects(f.client.read(f.selected), { code: "closed" });
});

test("one deadline covers both exchanges, sanitizes private errors and cancels late noncooperative bodies", async () => {
  const f = setup();
  let release!: (r: Response) => void,
    cancelled = false,
    signal: AbortSignal | undefined;
  const transport: typeof fetch = async (_u, init) => {
    signal = init!.signal!;
    return new Promise<Response>((r) => {
      release = r;
    });
  };
  const client = new VerificationReadClient(
    origin,
    f.scope,
    f.scope.purpose,
    transport,
    25,
  );
  await assert.rejects(client.read(f.selected), { code: "read_unavailable" });
  assert.equal(signal!.aborted, true);
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await wait();
  assert.equal(cancelled, true);
  const blocked = new VerificationReadClient(
    origin,
    f.scope,
    f.scope.purpose,
    async () => {
      const until = performance.now() + 50;
      while (performance.now() < until) {}
      return response({ actorId: "human", csrfToken: "secret" });
    },
    20,
  );
  await assert.rejects(blocked.read(f.selected), { code: "read_unavailable" });
  const failed = new VerificationReadClient(
    origin,
    f.scope,
    f.scope.purpose,
    async () => {
      throw Error("private credential material");
    },
  );
  await assert.rejects(
    failed.read(f.selected),
    (e) => e instanceof Error && e.message === "read_unavailable",
  );
});

test("malformed, mismatched, excessive-chunk and strict UTF8 responses never expose data", async () => {
  const f = setup();
  for (const make of [
    () => response({ ...f.frame, command: "enable" }),
    () => {
      const v = structuredClone(f.frame);
      (v.record as any).resolution = "verified";
      return response(v);
    },
    () =>
      new Response(Uint8Array.of(0xc3, 0x28), {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      }),
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < 4097; i++) c.enqueue(Uint8Array.of(32));
            c.close();
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        },
      ),
    () => response({ actorId: "human", csrfToken: "x", roles: ["owner"] }),
  ]) {
    const client = new VerificationReadClient(
      origin,
      f.scope,
      f.scope.purpose,
      async (input) =>
        String(input).endsWith("/session")
          ? response({ actorId: "human", csrfToken: "x" })
          : make(),
    );
    await assert.rejects(client.read(f.selected));
  }
});

test("controls are inert until clicked, clear old results, refuse shared mounts and dispose detached late reads", async () => {
  const f = setup(),
    dom = new JSDOM(
      "<!doctype html><body><main></main><aside></aside></body>",
      { url: origin },
    );
  const root = dom.window.document.querySelector("main")!,
    mount = mountVerificationRead(root, f.client, f.selected);
  assert.equal(f.calls.length, 0);
  assert.throws(() =>
    mountVerificationRead(
      dom.window.document.querySelector("aside")!,
      f.client,
      f.selected,
    ),
  );
  root.querySelector("button")!.click();
  root.querySelector("button")!.dispatchEvent(new dom.window.Event("click"));
  for (let i = 0; i < 20 && !root.querySelector("pre"); i++) await wait();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    JSON.parse(root.querySelector("pre")!.textContent!),
    f.frame,
  );
  mount.dispose();
  assert.equal(root.textContent, "");
  assert.equal(f.client.closed, true);
  let release!: (r: Response) => void;
  const client = new VerificationReadClient(
    origin,
    f.scope,
    f.scope.purpose,
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  mountVerificationRead(root, client, f.selected);
  root.querySelector("button")!.click();
  root.replaceChildren();
  await wait();
  assert.equal(client.closed, true);
  release(response({ actorId: "human", csrfToken: "x" }));
  await wait();
  assert.equal(root.textContent, "");
});

test("cancellation and disposal fence responses and busy calls cannot overlap", async () => {
  const f = setup(),
    control = new AbortController();
  let release!: (r: Response) => void;
  const client = new VerificationReadClient(
    origin,
    f.scope,
    f.scope.purpose,
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const pending = client.read(f.selected, control.signal);
  await assert.rejects(client.read(f.selected), { code: "busy" });
  control.abort();
  await assert.rejects(pending, { code: "read_unavailable" });
  release(response({ actorId: "human", csrfToken: "x" }));
  await wait();
  assert.equal(client.busy, false);
  client.dispose();
  await assert.rejects(client.read(f.selected), { code: "closed" });
});

test("aggregate deadline covers session plus review; incorrect host origin and session authority are denied", async () => {
  const f = setup();
  let calls = 0;
  const client = new VerificationReadClient(
    origin,
    f.scope,
    f.scope.purpose,
    async (input) => {
      calls++;
      const until = performance.now() + 35;
      while (performance.now() < until) {}
      return String(input).endsWith("/session")
        ? response({ actorId: "human", csrfToken: "x" })
        : response(f.frame);
    },
    55,
  );
  await assert.rejects(client.read(f.selected), { code: "read_unavailable" });
  assert.equal(calls, 2);
  for (const session of [
    { actorId: "human", csrfToken: "x", roles: ["owner"] },
    { actorId: "human", csrfToken: "\u00e9".repeat(200) },
    { actorId: "human", csrfToken: "" },
  ]) {
    let posts = 0;
    const invalid = new VerificationReadClient(
      origin,
      f.scope,
      f.scope.purpose,
      async (_input, init) => {
        if (init!.method === "POST") posts++;
        return response(session);
      },
    );
    await assert.rejects(invalid.read(f.selected));
    assert.equal(posts, 0);
  }
  const dom = new JSDOM("<body><main></main></body>", {
    url: "https://other.invalid",
  });
  assert.throws(() =>
    mountVerificationRead(
      dom.window.document.querySelector("main")!,
      f.client,
      f.selected,
    ),
  );
  assert.equal(f.calls.length, 0);
});

test("selection getters are rejected before I/O and captured configuration cannot be changed by the caller", async () => {
  const f = setup();
  let reads = 0;
  const selected = { ...f.selected };
  Object.defineProperty(selected, "projectId", {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? f.scope.projectId : "foreign";
    },
  });
  await assert.rejects(f.client.read(selected));
  assert.equal(reads, 0);
  assert.equal(f.calls.length, 0);
  const scope = { ...f.scope },
    client = new VerificationReadClient(
      origin,
      scope,
      f.scope.purpose,
      f.transport,
    );
  scope.projectId = "foreign";
  assert.deepEqual(await client.read(f.selected), f.frame);
});
