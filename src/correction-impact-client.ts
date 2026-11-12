import {
  captureCorrectionImpactSelection,
  parseSelectedCorrectionImpactFrame,
  CorrectionImpactReadError,
} from "./selected-correction-impact.ts";
import type {
  SelectedCorrectionImpactFrame,
  CorrectionImpactSelection,
  CorrectionImpactScope,
} from "./selected-correction-impact.ts";

function word(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim().length > 0
  );
}
/** One explicit read, fresh session CSRF, no polling or persisted response cache. Host owns the authenticated transport. */
export class CorrectionImpactReadClient {
  readonly #origin: string;
  readonly #scope: CorrectionImpactScope;
  readonly #purpose: string;
  readonly #transport: typeof fetch;
  readonly #timeout: number;
  #actor: string | null = null;
  readonly #expectedActor: string | null;
  #busy = false;
  #closed = false;
  #controller: AbortController | null = null;
  constructor(
    origin: string,
    scope: Pick<CorrectionImpactScope, "tenantId" | "projectId">,
    purpose: string,
    transport: typeof fetch,
    timeoutMs = 10000,
    expectedActorId?: string,
  ) {
    try {
      const url = new URL(origin);
      const fixedScope = {
        tenantId: scope.tenantId,
        projectId: scope.projectId,
      };
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        !word(fixedScope.tenantId, 128) ||
        !word(fixedScope.projectId, 128) ||
        !word(purpose, 128) ||
        typeof transport !== "function" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 30000 ||
        (expectedActorId !== undefined && !word(expectedActorId, 128))
      )
        throw Error();
      this.#origin = origin;
      this.#scope = { ...fixedScope, purpose };
      this.#purpose = purpose;
      this.#transport = transport;
      this.#timeout = timeoutMs;
      this.#expectedActor = expectedActorId ?? null;
    } catch {
      throw new CorrectionImpactReadError("invalid_configuration");
    }
  }
  get closed(): boolean {
    return this.#closed;
  }
  /** Last observed server session actor, not independent proofing or a grant. */
  get actorId(): string | null {
    return this.#actor;
  }
  get origin(): string {
    return this.#origin;
  }
  get busy(): boolean {
    return this.#busy;
  }
  get scope(): CorrectionImpactScope {
    return { ...this.#scope };
  }
  dispose(): void {
    this.#closed = true;
    this.#actor = null;
    this.#controller?.abort();
  }

  async read(
    selected: CorrectionImpactSelection,
    signal?: AbortSignal,
  ): Promise<SelectedCorrectionImpactFrame> {
    if (this.#closed) throw new CorrectionImpactReadError("closed");
    if (this.#busy) throw new CorrectionImpactReadError("busy");
    this.#busy = true;
    const controller = new AbortController(),
      started = performance.now(),
      abort = () => controller.abort();
    this.#controller = controller;
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.#timeout);
    const gate = () => {
      if (
        this.#closed ||
        controller.signal.aborted ||
        performance.now() - started >= this.#timeout
      )
        throw new CorrectionImpactReadError("read_unavailable");
    };
    const bounded = <T>(promise: Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const interrupted = () =>
          reject(new CorrectionImpactReadError("read_unavailable"));
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
      const url = this.#origin + "/private/correction-impact/" + path;
      const pending = this.#transport(url, {
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
          throw new CorrectionImpactReadError("read_unavailable");
        const max = path === "session" ? 4096 : 512 * 1024,
          length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
          throw new CorrectionImpactReadError("read_unavailable");
        reader = response.body?.getReader();
        if (!reader) throw new CorrectionImpactReadError("read_unavailable");
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
            throw new CorrectionImpactReadError("read_unavailable");
          parts.push(Uint8Array.from(next.value));
        }
        if (length !== null && Number(length) !== size)
          throw new CorrectionImpactReadError("read_unavailable");
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
      const choice = captureCorrectionImpactSelection(this.#scope, selected),
        body = JSON.stringify(choice);
      if (new TextEncoder().encode(body).length > 1024)
        throw new CorrectionImpactReadError("invalid_response");
      const session = JSON.parse(await exchange("session"));
      gate();
      if (
        !session ||
        typeof session !== "object" ||
        Array.isArray(session) ||
        Object.keys(session).length !== 2 ||
        !Object.hasOwn(session, "actorId") ||
        !Object.hasOwn(session, "csrfToken") ||
        !word(session.actorId, 128) ||
        !word(session.csrfToken, 256) ||
        new TextEncoder().encode(session.csrfToken).length > 256
      )
        throw new CorrectionImpactReadError("invalid_response");
      if (
        (this.#actor !== null && this.#actor !== session.actorId) ||
        (this.#expectedActor !== null &&
          this.#expectedActor !== session.actorId)
      ) {
        this.dispose();
        throw new CorrectionImpactReadError("actor_changed");
      }
      this.#actor = session.actorId;
      const text = await exchange("read", body, session.csrfToken);
      gate();
      const frame = parseSelectedCorrectionImpactFrame(
        this.#scope,
        choice,
        text,
      );
      gate();
      if (frame.impact.purpose !== this.#purpose)
        throw new CorrectionImpactReadError("invalid_response");
      return frame;
    } catch (error) {
      // Transport/body/domain diagnostics may contain private material. Only this module's fixed errors escape.
      if (
        error instanceof CorrectionImpactReadError &&
        ["actor_changed", "invalid_response"].includes(error.code)
      )
        throw new CorrectionImpactReadError(error.code);
      throw new CorrectionImpactReadError("read_unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
      this.#controller = null;
      this.#busy = false;
    }
  }
}
