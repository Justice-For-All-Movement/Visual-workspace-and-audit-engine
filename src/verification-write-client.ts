import { VerificationReadClient } from "./verification-client.ts";
import {
  VerificationReadError,
  verificationAxes,
} from "./selected-verification.ts";
import type {
  VerificationRef,
  VerificationScope,
  SelectedVerificationFrame,
} from "./selected-verification.ts";
import type { VerificationChecks } from "@accountability/knowledge-verification/verification-review";

export type VerificationAcknowledgement = Readonly<{
  record: VerificationRef;
  storage: VerificationRef;
}>;
export type VerificationWriteCommand = Readonly<{
  commandId: string;
  expectedStorageRevision: number;
  input: {
    linkRef: VerificationRef;
    expectedRevision: number;
    checks: VerificationChecks;
    rationale: string;
  };
}>;
// Pinned owning profile; checked against the installed SDK in tests. No Node runtime import in browser code.
const storageKind = "knowledge-verification-review-history",
  storageKey =
    "3d177454f1ed2601d6aa5fac7956b9f6b4d7ec7ecff074d25c0be3a99358e4f9";
function fail(code: string): never {
  throw new VerificationReadError(code);
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
function checksCopy(value: VerificationChecks): VerificationChecks {
  const root = fields(value, verificationAxes),
    result: Record<string, unknown> = {};
  for (const axis of verificationAxes) {
    const c = fields(root[axis], ["status", "note"]);
    if (
      !word(c.status, 16) ||
      !["unreviewed", "unresolved", "concern", "reviewed"].includes(c.status) ||
      !word(c.note, 4000)
    )
      fail("invalid_command");
    result[axis] = { status: c.status, note: c.note };
  }
  return result as VerificationChecks;
}
/** Explicit selected read then unresolved write. Pending data is memory-only and never rebased or automatically replayed. */
export class VerificationWriteClient {
  readonly #reader: VerificationReadClient;
  readonly #origin: string;
  readonly #scope: VerificationScope;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  #viewed: SelectedVerificationFrame | null = null;
  #actor: string | null = null;
  #pending: {
    body: string;
    actor: string;
    expected: VerificationAcknowledgement;
  } | null = null;
  #closed = false;
  #busy = false;
  #controller: AbortController | null = null;
  constructor(
    origin: string,
    scope: VerificationScope,
    purpose: string,
    transport: typeof fetch,
    timeoutMs = 10000,
  ) {
    this.#reader = new VerificationReadClient(
      origin,
      scope,
      purpose,
      transport,
      timeoutMs,
    );
    this.#origin = this.#reader.origin;
    this.#scope = this.#reader.scope;
    this.#fetch = transport;
    this.#timeout = timeoutMs;
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
  get viewed() {
    return this.#viewed ? structuredClone(this.#viewed) : null;
  }
  get pending(): VerificationWriteCommand | null {
    return this.#pending ? JSON.parse(this.#pending.body) : null;
  }
  dispose() {
    this.#closed = true;
    this.#viewed = null;
    this.#reader.dispose();
    this.#controller?.abort();
  }
  async load(
    selected: VerificationRef,
    signal?: AbortSignal,
  ): Promise<SelectedVerificationFrame> {
    if (this.closed) fail("closed");
    if (this.#busy) fail("busy");
    if (this.#pending) fail("pending_write");
    this.#busy = true;
    this.#viewed = null;
    try {
      const frame = await this.#reader.read(selected, signal);
      if (this.closed) fail("closed");
      this.#actor = this.#reader.actorId;
      if (!this.#actor) fail("read_unavailable");
      this.#viewed = structuredClone(frame);
      return structuredClone(frame);
    } finally {
      this.#busy = false;
    }
  }
  async record(
    commandId: string,
    checks: VerificationChecks,
    rationale: string,
    signal?: AbortSignal,
  ): Promise<VerificationAcknowledgement> {
    const started = performance.now();
    if (this.closed) fail("closed");
    if (this.#busy) fail("busy");
    if (this.#pending) fail("pending_write");
    if (!this.#viewed || !this.#actor) fail("review_required");
    this.#busy = true;
    try {
      if (!word(commandId, 128) || !word(rationale, 4000))
        fail("invalid_command");
      const f = this.#viewed,
        command: VerificationWriteCommand = {
          commandId,
          expectedStorageRevision: f.reviewRevision,
          input: {
            linkRef: { ...f.record.linkRef },
            expectedRevision: f.record.ref.revision,
            checks: checksCopy(checks),
            rationale,
          },
        };
      const body = JSON.stringify(command);
      if (new TextEncoder().encode(body).length > 128 * 1024)
        fail("invalid_command");
      return await this.#send(
        {
          body,
          actor: this.#actor,
          expected: {
            record: { ...f.record.ref, revision: f.record.ref.revision + 1 },
            storage: {
              tenantId: this.#scope.tenantId,
              projectId: this.#scope.projectId,
              kind: storageKind,
              id: storageKey,
              revision: f.reviewRevision + 1,
            },
          },
        },
        signal,
        started,
      );
    } finally {
      this.#busy = false;
    }
  }
  async retryPending(
    signal?: AbortSignal,
  ): Promise<VerificationAcknowledgement> {
    if (this.closed) fail("closed");
    if (this.#busy) fail("busy");
    if (!this.#pending) fail("no_pending_write");
    return this.#send(this.#pending, signal);
  }
  async #send(
    command: {
      body: string;
      actor: string;
      expected: VerificationAcknowledgement;
    },
    signal?: AbortSignal,
    started = performance.now(),
  ): Promise<VerificationAcknowledgement> {
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
          reject(new VerificationReadError("read_unavailable"));
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
      const url = this.#origin + "/private/verification-write/" + path;
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
          throw new VerificationReadError("read_unavailable");
        const max = path === "session" ? 4096 : 16 * 1024,
          length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
          throw new VerificationReadError("read_unavailable");
        reader = response.body?.getReader();
        if (!reader) throw new VerificationReadError("read_unavailable");
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
            throw new VerificationReadError("read_unavailable");
          parts.push(Uint8Array.from(next.value));
        }
        if (length !== null && Number(length) !== size)
          throw new VerificationReadError("read_unavailable");
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
      this.#viewed = null;
      const ack = fields(
        JSON.parse(await exchange("record", command.body, session.csrfToken)),
        ["record", "storage"],
      );
      gate();
      for (const key of ["record", "storage"] as const) {
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
        error instanceof VerificationReadError &&
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
