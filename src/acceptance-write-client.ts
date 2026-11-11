import { AcceptanceReadClient } from "./acceptance-client.ts";
import { AcceptanceReadError } from "./selected-acceptance.ts";
import type { AcceptanceRef, AcceptanceScope } from "./selected-acceptance.ts";
import type { ProposalAcceptanceInput } from "@accountability/knowledge-verification/proposal-acceptance";

export type AcceptanceAcknowledgement = Readonly<{
  knowledgeStorage: AcceptanceRef;
  linksStorage: AcceptanceRef;
  acceptance: AcceptanceRef;
  claim: AcceptanceRef;
  links: AcceptanceRef;
}>;
export type AcceptanceWriteCommand = Readonly<{
  commandId: string;
  bundle: unknown;
  input: ProposalAcceptanceInput;
}>;
function fail(code: string): never {
  throw new AcceptanceReadError(code);
}
function word(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}
function fields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    fail("invalid_command");
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !("value" in d)) fail("invalid_command");
    result[key] = d.value;
  }
  return result;
}
function captureJson(input: unknown): any {
  let count = 0,
    units = 0;
  const copy = (v: unknown, depth: number): any => {
    if (++count > 8192 || depth > 32) fail("invalid_command");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) fail("invalid_command");
      return v;
    }
    if (typeof v === "string") {
      units += v.length;
      if (units > 272 * 1024) fail("invalid_command");
      return v;
    }
    if (!v || typeof v !== "object") fail("invalid_command");
    const array = Array.isArray(v);
    if (!array && Object.getPrototypeOf(v) !== Object.prototype)
      fail("invalid_command");
    if (array && (v.length > 8192 || Object.getPrototypeOf(v) !== Array.prototype)) fail("invalid_command");
    const keys = Reflect.ownKeys(v);
    if (keys.length > 8192) fail("invalid_command");
    if (array && (v.length > 8192 || keys.length !== v.length + 1))
      fail("invalid_command");
    const out: any = array ? [] : {};
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || key === "__proto__" || key.length > 256)
        fail("invalid_command");
      units += key.length;
      if (units > 272 * 1024) fail("invalid_command");
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) fail("invalid_command");
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !d.enumerable || !("value" in d)) fail("invalid_command");
      out[key] = copy(d.value, depth + 1);
    }
    return out;
  };
  return copy(input, 0);
}
function canonical(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
      .join(",") +
    "}"
  );
}
async function hash(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(v));
  const h = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(h), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function captureAcceptanceWriteCommand(
  scope: AcceptanceScope,
  purpose: string,
  commandId: string,
  bundle: unknown,
  input: ProposalAcceptanceInput,
): AcceptanceWriteCommand {
  if (!word(commandId, 128)) fail("invalid_command");
  const b = captureJson(bundle),
    q = fields(captureJson(input), [
      "proposalId",
      "claimId",
      "expectedKnowledgeRevision",
      "expectedLinksRevision",
    ]);
  if (!word(q.proposalId, 128) || !word(q.claimId, 128))
    fail("invalid_command");
  for (const n of [q.expectedKnowledgeRevision, q.expectedLinksRevision])
    if (
      !Number.isSafeInteger(n) ||
      (n as number) < 1 ||
      (n as number) >= Number.MAX_SAFE_INTEGER
    )
      fail("invalid_command");
  const root = fields(b, [
    "schemaVersion",
    "visibility",
    "tenantId",
    "projectId",
    "purpose",
    "basis",
    "proposals",
    "digest",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.visibility !== "private" ||
    root.tenantId !== scope.tenantId ||
    root.projectId !== scope.projectId ||
    root.purpose !== purpose
  )
    fail("invalid_command");
  const basis = fields(root.basis, [
    "knowledgeRevision",
    "linksRevision",
    "evidenceRevision",
    "linkRef",
    "claimRef",
  ]);
  if (
    basis.knowledgeRevision !== q.expectedKnowledgeRevision ||
    basis.linksRevision !== q.expectedLinksRevision ||
    !Array.isArray(root.proposals) ||
    root.proposals.length < 1 ||
    root.proposals.length > 32 ||
    !root.proposals.some((p) => (p as any)?.id === q.proposalId)
  )
    fail("invalid_command");
  const command: AcceptanceWriteCommand = {
    commandId,
    bundle: b,
    input: q as AcceptanceWriteCommand["input"],
  };
  const body = JSON.stringify(command);
  if (new TextEncoder().encode(body).length > 280 * 1024)
    fail("invalid_command");
  return command;
}
/** Explicit untrusted intent acceptance. Backend authenticates every use; pending commands are memory-only and never rebased. */
export class AcceptanceWriteClient {
  readonly #reader: AcceptanceReadClient;
  readonly #origin: string;
  readonly #scope: AcceptanceScope;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #purpose: string;
  #actor: string | null = null;
  #pending: {
    body: string;
    actor: string;
    expected: AcceptanceAcknowledgement;
  } | null = null;
  #closed = false;
  #busy = false;
  #controller: AbortController | null = null;
  constructor(
    origin: string,
    scope: AcceptanceScope,
    purpose: string,
    expectedActorId: string,
    transport: typeof fetch,
    timeoutMs = 10000,
  ) {
    this.#reader = new AcceptanceReadClient(
      origin,
      scope,
      purpose,
      transport,
      timeoutMs,
      expectedActorId,
    );
    if (!word(expectedActorId, 128)) fail("invalid_command");
    this.#actor = expectedActorId;
    this.#origin = this.#reader.origin;
    this.#scope = this.#reader.scope;
    this.#fetch = transport;
    this.#timeout = timeoutMs;
    this.#purpose = purpose;
  }
  get closed() {
    return this.#closed || this.#reader.closed;
  }
  get busy() {
    return this.#busy;
  }
  get origin() {
    return this.#origin;
  }
  get purpose(): string {
    return this.#purpose;
  }
  get scope(): AcceptanceScope {
    return { ...this.#scope };
  }
  get pending(): AcceptanceWriteCommand | null {
    return this.#pending ? JSON.parse(this.#pending.body) : null;
  }
  dispose() {
    this.#closed = true;
    this.#reader.dispose();
    this.#controller?.abort();
  }
  async readAcceptance(selected: AcceptanceRef, signal?: AbortSignal) {
    if (this.closed) fail("closed");
    if (this.#busy) fail("busy");
    if (this.#pending) fail("pending_write");
    this.#busy = true;
    try {
      const result = await this.#reader.read(selected, signal);
      if (this.closed) fail("closed");
      if (this.#reader.actorId !== this.#actor) {
        this.dispose();
        fail("actor_changed");
      }
      return result;
    } finally {
      this.#busy = false;
    }
  }
  async accept(
    commandId: string,
    bundle: unknown,
    input: ProposalAcceptanceInput,
    signal?: AbortSignal,
  ): Promise<AcceptanceAcknowledgement> {
    const started = performance.now();
    if (this.closed) fail("closed");
    if (this.#busy) fail("busy");
    if (this.#pending) fail("pending_write");
    this.#busy = true;
    try {
      const command = captureAcceptanceWriteCommand(
          this.#scope,
          this.#purpose,
          commandId,
          bundle,
          input,
        ),
        q = command.input,
        body = JSON.stringify(command);
      const ref = (
        kind: string,
        id: string,
        revision: number,
      ): AcceptanceRef => ({ ...this.#scope, kind, id, revision });
      const claim = ref("claim", q.claimId as string, 1);
      const expected = {
        knowledgeStorage: ref(
          "knowledge-history",
          await hash({ aggregate: "knowledge-history" }),
          (q.expectedKnowledgeRevision as number) + 1,
        ),
        linksStorage: ref(
          "knowledge-evidence-links-history",
          await hash({ aggregate: "knowledge-evidence-links-history" }),
          (q.expectedLinksRevision as number) + 1,
        ),
        acceptance: ref(
          "knowledge-proposal-acceptance",
          await hash({ claim }),
          1,
        ),
        claim,
        links: ref("knowledge-evidence-links", claim.id, 1),
      };
      return await this.#send(
        { body, actor: this.#actor!, expected },
        signal,
        started,
      );
    } finally {
      this.#busy = false;
    }
  }
  async retryPending(signal?: AbortSignal): Promise<AcceptanceAcknowledgement> {
    if (this.closed) fail("closed");
    if (this.#busy) fail("busy");
    if (!this.#pending) fail("no_pending_write");
    return this.#send(this.#pending, signal);
  }
  async #send(
    command: {
      body: string;
      actor: string;
      expected: AcceptanceAcknowledgement;
    },
    signal?: AbortSignal,
    started = performance.now(),
  ): Promise<AcceptanceAcknowledgement> {
    this.#busy = true;
    const controller = new AbortController(),
      abort = () => controller.abort();
    this.#controller = controller;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      abort,
      Math.max(0, this.#timeout - (performance.now() - started)),
    );
    const gate = () => {
      if (
        this.closed ||
        controller.signal.aborted ||
        performance.now() - started >= this.#timeout
      )
        fail("write_unavailable");
    };
    const bounded = <T>(promise: Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const interrupted = () =>
          reject(new AcceptanceReadError("read_unavailable"));
        controller.signal.addEventListener("abort", interrupted, {
          once: true,
        });
        if (controller.signal.aborted) interrupted();
        promise
          .then(resolve, reject)
          .finally(() =>
            controller.signal.removeEventListener("abort", interrupted),
          );
      });
    const exchange = async (
      path: string,
      body?: string,
      csrf?: string,
    ): Promise<string> => {
      gate();
      const url = this.#origin + "/private/proposal-acceptance-write/" + path;
      const pending = this.#fetch(url, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers:
          body === undefined
            ? {}
            : {
                "content-type": "application/json",
                origin: this.#origin,
                "x-csrf-token": csrf!,
              },
        ...(body === undefined ? {} : { body }),
      });
      // A noncooperative transport may settle after timeout/disposal. Never expose that result or retain its body.
      void pending
        .then(
          (response) => {
            if (controller.signal.aborted)
              void response.body?.cancel().catch(() => {});
          },
          () => {},
        )
        .catch(() => {});
      let response: Response | undefined,
        reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        response = await bounded(pending);
        gate();
        if (
          response.redirected ||
          (response.url && response.url !== url) ||
          response.status !== 200 ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          response.headers.get("cache-control") !== "no-store"
        )
          throw new AcceptanceReadError("read_unavailable");
        const max = path === "session" ? 4096 : 16 * 1024,
          length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
          throw new AcceptanceReadError("read_unavailable");
        reader = response.body?.getReader();
        if (!reader) throw new AcceptanceReadError("read_unavailable");
        let size = 0,
          chunks = 0;
        const parts: Uint8Array[] = [];
        while (true) {
          gate();
          const next = await bounded(reader.read());
          gate();
          if (next.done) break;
          size += next.value.byteLength;
          if (++chunks > 4096 || size > max)
            throw new AcceptanceReadError("read_unavailable");
          parts.push(Uint8Array.from(next.value));
        }
        if (length !== null && Number(length) !== size)
          throw new AcceptanceReadError("read_unavailable");
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        gate();
        return text;
      } finally {
        if (reader) void reader.cancel().catch(() => {});
        else if (response) void response.body?.cancel().catch(() => {});
      }
    };
    try {
      gate();
      const session = fields(JSON.parse(await exchange("session")), [
        "actorId",
        "csrfToken",
      ]);
      gate();
      if (
        !word(session.actorId, 128) ||
        !word(session.csrfToken, 256) ||
        new TextEncoder().encode(session.csrfToken).length > 256
      )
        fail("invalid_response");
      if (session.actorId !== command.actor) {
        this.dispose();
        fail("actor_changed");
      }
      // Commit exact immutable pending input before invoking any POST transport. Fresh CSRF is separate.
      this.#pending = command;
      const ack = fields(
        JSON.parse(await exchange("accept", command.body, session.csrfToken)),
        ["knowledgeStorage", "linksStorage", "acceptance", "claim", "links"],
      );
      gate();
      for (const key of [
        "knowledgeStorage",
        "linksStorage",
        "acceptance",
        "claim",
        "links",
      ] as const) {
        const r = fields(ack[key], [
            "tenantId",
            "projectId",
            "kind",
            "id",
            "revision",
          ]),
          expected = command.expected[key];
        if (!Object.entries(expected).every(([k, v]) => r[k] === v))
          fail("invalid_response");
      }
      const result = structuredClone(command.expected);
      gate();
      this.#pending = null;
      return result;
    } catch (error) {
      if (
        error instanceof AcceptanceReadError &&
        error.code === "actor_changed"
      )
        fail("actor_changed");
      return fail("write_unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      this.#controller = null;
      this.#busy = false;
    }
  }
}
