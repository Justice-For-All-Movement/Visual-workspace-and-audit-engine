import type { CurrentCorrectionImpactReader } from "@accountability/factual-investigation/correction-impact-current";

export type SelectedCorrectionImpactFrame = Awaited<
  ReturnType<CurrentCorrectionImpactReader["read"]>
>;
export type CorrectionImpactScope = Readonly<{
  tenantId: string;
  projectId: string;
  purpose: string;
}>;
export type CorrectionImpactRef = Readonly<{
  tenantId: string;
  projectId: string;
  kind: string;
  id: string;
  revision: number;
}>;
export type CorrectionImpactSelection = Readonly<{
  before: CorrectionImpactRef;
  after: CorrectionImpactRef;
}>;
export class CorrectionImpactReadError extends Error {
  readonly code: string;
  constructor(code = "invalid_response") {
    super(code);
    this.code = code;
    this.name = "CorrectionImpactReadError";
  }
}
function require(v: unknown): asserts v {
  if (!v) throw new CorrectionImpactReadError();
}
function word(v: unknown): asserts v is string {
  require(typeof v === "string" && v.length <= 128 && v.trim().length > 0);
}
function integer(v: unknown, min = 1): asserts v is number {
  require(Number.isSafeInteger(v) && (v as number) >= min);
}
function exact(v: unknown, keys: readonly string[]): Record<string, any> {
  require(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
  );
  return v as Record<string, any>;
}
function own(v: unknown, keys: readonly string[]): Record<string, unknown> {
  require(
    v &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Reflect.ownKeys(v).length === keys.length,
  );
  const copy: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    require(d && "value" in d && d.enumerable);
    copy[k] = d.value;
  }
  return copy;
}
const refKeys = ["tenantId", "projectId", "kind", "id", "revision"] as const;
function ref(
  v: unknown,
  s: CorrectionImpactScope,
  kind?: string,
): CorrectionImpactRef {
  const r = exact(v, refKeys);
  for (const k of ["tenantId", "projectId", "kind", "id"]) word(r[k]);
  integer(r.revision);
  require(
    r.tenantId === s.tenantId &&
      r.projectId === s.projectId &&
      (!kind || r.kind === kind),
  );
  return r as CorrectionImpactRef;
}
const key = (r: CorrectionImpactRef) =>
  JSON.stringify([r.tenantId, r.projectId, r.kind, r.id, r.revision]);
const logical = (r: CorrectionImpactRef) => JSON.stringify([r.kind, r.id]);
const same = (a: CorrectionImpactRef, b: CorrectionImpactRef) =>
  key(a) === key(b);
const kinds = ["claim", "entity", "event", "relationship"];
function knowledgeRef(v: unknown, s: CorrectionImpactScope) {
  const r = ref(v, s);
  require(kinds.includes(r.kind));
  return r;
}
function list(v: unknown, max: number): asserts v is any[] {
  require(Array.isArray(v) && v.length <= max);
}
/** Exact getter-free selection copied before any session or read transport. */
export function captureCorrectionImpactSelection(
  scope: CorrectionImpactScope,
  input: CorrectionImpactSelection,
): CorrectionImpactSelection {
  for (const k of ["tenantId", "projectId", "purpose"] as const) word(scope[k]);
  const x = own(input, ["before", "after"]);
  const copy = (v: unknown) => ({ ...knowledgeRef(own(v, refKeys), scope) });
  const before = copy(x.before),
    after = copy(x.after);
  require(
    before.kind === after.kind &&
      before.id === after.id &&
      after.revision === before.revision + 1,
  );
  const out = { before, after };
  require(new TextEncoder().encode(JSON.stringify(out)).length <= 1024);
  return out;
}
/** Wire consistency only. Whole history prefixes, values, current rights and audits are not reconstructed. */
export function parseSelectedCorrectionImpactFrame(
  scope: CorrectionImpactScope,
  selected: CorrectionImpactSelection,
  text: string,
): SelectedCorrectionImpactFrame {
  try {
    const choice = captureCorrectionImpactSelection(scope, selected);
    require(
      typeof text === "string" &&
        text.length <= 524288 &&
        new TextEncoder().encode(text).length <= 524288,
    );
    const f = exact(JSON.parse(text), [
      "profile",
      "knowledgeStorage",
      "planningStorage",
      "impact",
    ]);
    require(f.profile === "current-plan-correction-impact-v1");
    const d = exact(f.impact, [
      "profile",
      "visibility",
      "tenantId",
      "projectId",
      "purpose",
      "before",
      "after",
      "planningRecordCount",
      "knowledgeRecordCount",
      "plans",
      "unloaded",
    ]);
    require(
      d.profile === "captured-plan-correction-impact-v1" &&
        d.visibility === "private" &&
        d.tenantId === scope.tenantId &&
        d.projectId === scope.projectId &&
        d.purpose === scope.purpose,
    );
    require(
      same(knowledgeRef(d.before, scope), choice.before) &&
        same(knowledgeRef(d.after, scope), choice.after),
    );
    integer(d.knowledgeRecordCount);
    integer(d.planningRecordCount, 0);
    require(
      d.knowledgeRecordCount <= 2048 &&
        d.planningRecordCount <= 256 &&
        choice.after.revision <= d.knowledgeRecordCount,
    );
    const ks = ref(f.knowledgeStorage, scope, "knowledge-history");
    require(
      ks.id ===
        "d97c9fd3ece7bae9bb5f49b2cb969e18ee8aa4b1b28820dcbb945a10c8eb2521" &&
        ks.revision === d.knowledgeRecordCount,
    );
    if (d.planningRecordCount === 0) require(f.planningStorage === null);
    else {
      const ps = ref(f.planningStorage, scope, "factual-planning-history");
      require(
        ps.id ===
          "a498f73aab7439871077027d71ccee9bb4b8d44cc0ea25736e1970445819c82b" &&
          ps.revision === d.planningRecordCount,
      );
    }
    list(d.plans, 256);
    require(d.plans.length === d.planningRecordCount);
    let totalNodes = 0,
      totalEdges = 0;
    const plans = new Map<string, number>(),
      latestPlans = new Map<string, CorrectionImpactRef>();
    // All plan editions are present in this profile, in owning history order.
    for (const item of d.plans) {
      const row = exact(item, [
          "plan",
          "latestPlan",
          "status",
          "affectedRefs",
          "review",
        ]),
        p = ref(row.plan, scope, "investigation-plan"),
        latest = ref(row.latestPlan, scope, "investigation-plan");
      require(
        p.revision === (plans.get(p.id) ?? 0) + 1 &&
          latest.id === p.id &&
          latest.revision >= p.revision &&
          latest.revision <= d.planningRecordCount,
      );
      const prior = latestPlans.get(p.id);
      require(!prior || same(prior, latest));
      plans.set(p.id, p.revision);
      latestPlans.set(p.id, latest);
    }
    for (const [id, latest] of latestPlans)
      require(latest.revision === plans.get(id));
    const observedLatest = new Map<string, string>();
    for (const row of d.plans) {
      const p = ref(row.plan, scope, "investigation-plan"),
        latest = ref(row.latestPlan, scope, "investigation-plan");
      const r = exact(row.review, [
        "schemaVersion",
        "visibility",
        "tenantId",
        "projectId",
        "plan",
        "latestPlan",
        "roots",
        "nodes",
        "edges",
      ]);
      require(
        r.schemaVersion === 1 &&
          r.visibility === "private" &&
          r.tenantId === scope.tenantId &&
          r.projectId === scope.projectId &&
          same(ref(r.plan, scope, "investigation-plan"), p) &&
          same(ref(r.latestPlan, scope, "investigation-plan"), latest),
      );
      list(r.roots, 256);
      list(r.nodes, 256);
      list(r.edges, 512);
      totalNodes += r.nodes.length;
      totalEdges += r.edges.length;
      require(totalNodes <= 4096 && totalEdges <= 8192);
      const nodes = new Map<string, Record<string, any>>();
      for (const item of r.nodes) {
        const n = exact(item, ["ref", "latestRef", "status"]),
          nr = knowledgeRef(n.ref, scope),
          nk = key(nr);
        require(!nodes.has(nk));
        const lr =
          n.latestRef === null ? null : knowledgeRef(n.latestRef, scope);
        require(
          !lr ||
            (logical(lr) === logical(nr) &&
              lr.revision <= d.knowledgeRecordCount),
        );
        if (n.status === "current-edition") require(lr && same(nr, lr));
        else if (n.status === "changed-edition")
          require(lr && lr.revision > nr.revision);
        else require(n.status === "missing-edition" && (!lr || !same(nr, lr)));
        const lk = logical(nr),
          value = lr ? key(lr) : "null",
          prior = observedLatest.get(lk);
        require(prior === undefined || prior === value);
        observedLatest.set(lk, value);
        // The selected corrected editions exist, and the successor is latest in this capture.
        if (lk === logical(choice.before))
          require(
            lr &&
              same(lr, choice.after) &&
              (!(same(nr, choice.before) || same(nr, choice.after)) ||
                n.status !== "missing-edition"),
          );
        nodes.set(nk, n);
      }
      const roots = new Set<string>();
      for (const item of r.roots) {
        const rr = ref(item, scope, "claim"),
          k = key(rr);
        require(nodes.has(k) && !roots.has(k));
        roots.add(k);
      }
      const edgeKeys = new Set<string>(),
        children = new Map<string, string[]>();
      for (const item of r.edges) {
        const e = exact(item, ["from", "to", "kind"]),
          from = knowledgeRef(e.from, scope),
          to = knowledgeRef(e.to, scope),
          fk = key(from),
          tk = key(to),
          ek = JSON.stringify([fk, tk, e.kind]);
        require(
          nodes.has(fk) &&
            nodes.has(tk) &&
            nodes.get(fk)!.status !== "missing-edition" &&
            !edgeKeys.has(ek),
        );
        require(
          e.kind === "claim-subject"
            ? from.kind === "claim" &&
                ["entity", "event", "relationship"].includes(to.kind)
            : e.kind === "event-entity"
              ? from.kind === "event" && to.kind === "entity"
              : e.kind === "relationship-from"
                ? from.kind === "relationship" && to.kind === "entity"
                : e.kind === "relationship-to" &&
                  from.kind === "relationship" &&
                  ["entity", "event"].includes(to.kind),
        );
        edgeKeys.add(ek);
        children.set(fk, [...(children.get(fk) ?? []), tk]);
      }
      const reached = new Set(roots),
        queue = [...roots];
      for (let i = 0; i < queue.length; i++)
        for (const k of children.get(queue[i]!) ?? [])
          if (!reached.has(k)) {
            reached.add(k);
            queue.push(k);
          }
      require(reached.size === nodes.size);
      const affected = r.nodes
        .filter(
          (n: any) =>
            logical(n.ref) === logical(choice.before) &&
            n.ref.revision <= choice.before.revision,
        )
        .map((n: any) => n.ref);
      list(row.affectedRefs, 256);
      require(
        row.affectedRefs.length === affected.length &&
          row.affectedRefs.every((v: any, i: number) =>
            same(knowledgeRef(v, scope), affected[i]),
          ),
      );
      const status = affected.length
        ? "review-required"
        : r.nodes.some((n: any) => n.status === "missing-edition")
          ? "indeterminate"
          : "no-captured-dependency";
      require(row.status === status);
    }
    require(
      JSON.stringify(d.unloaded) ===
        JSON.stringify([
          "current-source-permissions",
          "findings",
          "draft-outputs",
          "raw-audit-events",
        ]),
    );
    return f as SelectedCorrectionImpactFrame;
  } catch {
    throw new CorrectionImpactReadError();
  }
}
/** Literal private table and exact metadata inspector; no export, I/O or active markup. */
export function renderSelectedCorrectionImpactFrame(
  document: Document,
  scope: CorrectionImpactScope,
  selected: CorrectionImpactSelection,
  text: string,
): HTMLElement {
  const f = parseSelectedCorrectionImpactFrame(scope, selected, text),
    root = document.createElement("section");
  root.setAttribute("aria-label", "Private plan correction impact");
  const add = (tag: string, text: string) => {
    const e = document.createElement(tag);
    e.textContent = text;
    root.append(e);
  };
  add("h2", "Private plan correction impact");
  add(
    "p",
    "All captured plan editions are retained. Review required and indeterminate are not findings, assignments, work proof or closure. No captured dependency is not proof of no impact. Current source permissions, findings, drafts and raw audits are not loaded.",
  );
  add(
    "p",
    "Exact corrected editions: " +
      JSON.stringify({ before: f.impact.before, after: f.impact.after }),
  );
  add(
    "p",
    `Observed containing revisions: Knowledge ${f.knowledgeStorage.revision}; planning ${f.planningStorage?.revision ?? "absent"}. These are not creation editions.`,
  );
  const table = document.createElement("table"),
    caption = document.createElement("caption");
  caption.textContent = "All captured plan editions and dependency review";
  table.append(caption);
  const head = document.createElement("thead"),
    heading = document.createElement("tr"),
    body = document.createElement("tbody");
  for (const label of [
    "Plan edition",
    "Latest observed plan",
    "Impact",
    "Affected exact references",
    "Missing dependencies",
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    heading.append(th);
  }
  head.append(heading);
  table.append(head, body);
  for (const item of f.impact.plans) {
    const row = document.createElement("tr");
    for (const value of [
      JSON.stringify(item.plan),
      JSON.stringify(item.latestPlan),
      item.status,
      JSON.stringify(item.affectedRefs),
      JSON.stringify(
        item.review.nodes
          .filter((n) => n.status === "missing-edition")
          .map((n) => n.ref),
      ),
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      row.append(td);
    }
    body.append(row);
  }
  root.append(table);
  const metadata = JSON.stringify(f, null, 2);
  require(new TextEncoder().encode(metadata).length <= 2 * 1024 * 1024);
  add("pre", metadata);
  return root;
}
