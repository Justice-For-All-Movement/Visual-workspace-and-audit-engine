import { DispositionReadClient } from "./disposition-client.ts";
import {
  DispositionReadError,
} from "./selected-dispositions.ts";
import type {
  DispositionRef,
  DispositionScope,
  SelectedDispositionFrame,
} from "./selected-dispositions.ts";
import type { QuestionDisposition } from "@accountability/factual-investigation/question-dispositions";
import type { DispositionCommand } from "@accountability/factual-investigation/disposition-repository";

export type DispositionAcknowledgement = Readonly<{
  record: DispositionRef; storage: DispositionRef;
  planningStorage: DispositionRef; effortStorage: DispositionRef | null;
}>;
export type DispositionWriteCommand = Readonly<{
  commandId: string; expectedStorageRevision: number; command: DispositionCommand;
}>;
// Pinned owning profile; checked against the installed SDK in tests. No Node runtime import in browser code.
const storageKind = "factual-question-review-history",
  storageKey =
    "81d131c394ac8dbeaa95679ad1d847539a4a01538cdfdec46e9a65e08ff34396";
function fail(code: string): never {
  throw new DispositionReadError(code);
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
function questionsCopy(value: readonly QuestionDisposition[], frame: SelectedDispositionFrame): QuestionDisposition[] {
  if (!Array.isArray(value) || value.length !== frame.table.questions.length) fail("invalid_command");
  return Array.from({length:value.length}, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) fail("invalid_command");
    const q = fields(descriptor.value, ["questionId", "status", "reason", "assigneeId", "reviewAt"]);
    if (q.questionId !== frame.table.questions[i]!.questionId ||
      !["unresolved","deferred","assigned"].includes(q.status as string) || !word(q.reason,4000)) fail("invalid_command");
    if (q.status === "assigned" ? !word(q.assigneeId,128) : q.assigneeId !== null) fail("invalid_command");
    if (q.status === "unresolved") { if (q.reviewAt !== null) fail("invalid_command"); }
    else if (typeof q.reviewAt !== "string" || q.reviewAt.length !== 24 ||
      !Number.isFinite(Date.parse(q.reviewAt)) || new Date(q.reviewAt).toISOString() !== q.reviewAt) fail("invalid_command");
    return q as unknown as QuestionDisposition;
  });
}
function triggersCopy(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) fail("invalid_command");
  const result = Array.from({length:value.length}, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value,String(i));
    if (!d || !("value" in d) || !word(d.value,2000)) fail("invalid_command");
    return d.value as string;
  });
  if (new Set(result).size !== result.length) fail("invalid_command");
  return result;
}
/** Explicit selected read then unresolved write. Pending data is memory-only and never rebased or automatically replayed. */
export class DispositionWriteClient {
  readonly #reader: DispositionReadClient;
  readonly #origin: string;
  readonly #scope: DispositionScope;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  #viewed: SelectedDispositionFrame | null = null;
  #actor: string | null = null;
  #pending: {
    body: string;
    actor: string;
    expected: DispositionAcknowledgement;
  } | null = null;
  #closed = false;
  #busy = false;
  #controller: AbortController | null = null;
  constructor(
    origin: string,
    scope: DispositionScope,
    purpose: string,
    transport: typeof fetch,
    timeoutMs = 10000,
  ) {
    this.#reader = new DispositionReadClient(
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
  get scope(): DispositionScope {
    return { ...this.#scope };
  }
  get viewed() {
    return this.#viewed ? structuredClone(this.#viewed) : null;
  }
  get pending(): DispositionWriteCommand | null {
    return this.#pending ? JSON.parse(this.#pending.body) : null;
  }
  dispose() {
    this.#closed = true;
    this.#viewed = null;
    this.#reader.dispose();
    this.#controller?.abort();
  }
  async load(
    selected: DispositionRef,
    signal?: AbortSignal,
  ): Promise<SelectedDispositionFrame> {
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
    reviewId: string,
    questions: readonly QuestionDisposition[],
    reopeningTriggers: readonly string[],
    signal?: AbortSignal,
  ): Promise<DispositionAcknowledgement> {
    const started = performance.now();
    if (this.closed) fail("closed");
    if (this.#busy) fail("busy");
    if (this.#pending) fail("pending_write");
    if (!this.#viewed || !this.#actor) fail("review_required");
    this.#busy = true;
    try {
      if (!word(commandId, 128) || !word(reviewId,128)) fail("invalid_command");
      const f = this.#viewed, revision = f.storage?.revision ?? 0;
      if (revision >= 256) fail("invalid_command");
      const command: DispositionWriteCommand = {
        commandId, expectedStorageRevision: revision,
        command: {
          planningStorage: {...f.planningStorage},
          effortStorage: f.effortStorage ? {...f.effortStorage} : null,
          review: {
            id: reviewId, expectedSequence: revision,
            supersedes: f.table.latestReview ? {...f.table.latestReview.ref} : null,
            selected: {...f.table.coverage.plan.ref},
            questions: questionsCopy(questions,f),
            reopeningTriggers: triggersCopy(reopeningTriggers),
          },
        },
      };
      if (new TextEncoder().encode(JSON.stringify(command.command)).length > 128 * 1024) fail("invalid_command");
      const body = JSON.stringify(command);
      if (new TextEncoder().encode(body).length > 132 * 1024)
        fail("invalid_command");
      return await this.#send(
        {
          body,
          actor: this.#actor,
          expected: {
            record: { ...this.#scope, kind: "investigation-question-review", id: reviewId, revision: 1 },
            planningStorage: {...f.planningStorage},
            effortStorage: f.effortStorage ? {...f.effortStorage} : null,
            storage: {
              tenantId: this.#scope.tenantId,
              projectId: this.#scope.projectId,
              kind: storageKind,
              id: storageKey,
              revision: revision + 1,
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
  ): Promise<DispositionAcknowledgement> {
    if (this.closed) fail("closed");
    if (this.#busy) fail("busy");
    if (!this.#pending) fail("no_pending_write");
    return this.#send(this.#pending, signal);
  }
  async #send(
    command: {
      body: string;
      actor: string;
      expected: DispositionAcknowledgement;
    },
    signal?: AbortSignal,
    started = performance.now(),
  ): Promise<DispositionAcknowledgement> {
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
          reject(new DispositionReadError("read_unavailable"));
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
      const url = this.#origin + "/private/disposition-write/" + path;
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
          throw new DispositionReadError("read_unavailable");
        const max = 4096,
          length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
          throw new DispositionReadError("read_unavailable");
        reader = response.body?.getReader();
        if (!reader) throw new DispositionReadError("read_unavailable");
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
            throw new DispositionReadError("read_unavailable");
          parts.push(Uint8Array.from(next.value));
        }
        if (length !== null && Number(length) !== size)
          throw new DispositionReadError("read_unavailable");
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
        ["record", "storage", "planningStorage", "effortStorage"],
      );
      gate();
      for (const key of ["record", "storage", "planningStorage", "effortStorage"] as const) {
        if (command.expected[key] === null) { if (ack[key] !== null) fail("invalid_response"); continue; }
        const r = fields(ack[key], [
            "tenantId",
            "projectId",
            "kind",
            "id",
            "revision",
          ]),
          expected = command.expected[key];
        if (!Object.entries(expected!).every(([k, v]) => r[k] === v))
          fail("invalid_response");
      }
      const result = structuredClone(command.expected);
      gate();
      this.#pending = null;
      return result;
    } catch (error) {
      if (
        error instanceof DispositionReadError &&
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
