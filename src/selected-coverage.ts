import type { IdentityFactualRepository } from "@accountability/factual-investigation/identity-repository";
export type SelectedCoverageFrame = NonNullable<
  Awaited<ReturnType<IdentityFactualRepository["loadCoverage"]>>
>;
export type CoverageScope = Readonly<{ tenantId: string; projectId: string }>;
export type CoverageRef = CoverageScope &
  Readonly<{ kind: string; id: string; revision: number }>;
export class CoverageReadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "CoverageReadError";
  }
}
function check(v: unknown): asserts v {
  if (!v) throw new CoverageReadError("invalid_response");
}
function exact(v: unknown, keys: string[]): Record<string, any> {
  check(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length === keys.length &&
      keys.every((k) => Object.hasOwn(v, k)),
  );
  return v as Record<string, any>;
}
function word(v: unknown, max = 128): asserts v is string {
  check(typeof v === "string" && v.trim().length > 0 && v.length <= max);
}
function integer(
  v: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): asserts v is number {
  check(
    Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max,
  );
}
function list(v: unknown, max: number): asserts v is any[] {
  check(Array.isArray(v) && v.length <= max);
}
function ref(v: unknown, s: CoverageScope, kind: string): CoverageRef {
  const r = exact(v, ["tenantId", "projectId", "kind", "id", "revision"]);
  for (const k of ["tenantId", "projectId", "kind", "id"]) word(r[k]);
  integer(r.revision);
  check(
    r.tenantId === s.tenantId && r.projectId === s.projectId && r.kind === kind,
  );
  return r as CoverageRef;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function sameRef(a: CoverageRef, b: CoverageRef) {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.revision === b.revision &&
    a.tenantId === b.tenantId &&
    a.projectId === b.projectId
  );
}
export function captureCoverageSelection(
  s: CoverageScope,
  v: CoverageRef,
): CoverageRef {
  check(v && Object.getPrototypeOf(v) === Object.prototype);
  const keys = ["tenantId", "projectId", "kind", "id", "revision"];
  check(Reflect.ownKeys(v).length === keys.length);
  const q: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    check(d && "value" in d && d.enumerable);
    q[k] = d.value;
  }
  return { ...ref(q, s, "investigation-plan") };
}
function stamp(v: Record<string, any>, purpose: string) {
  word(v.actorId);
  word(v.requestId);
  check(
    ["human", "agent", "service"].includes(v.actorKind) &&
      v.purpose === purpose &&
      v.visibility === "private",
  );
  check(
    typeof v.createdAt === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v.createdAt) &&
      Number.isFinite(Date.parse(v.createdAt)) &&
      new Date(v.createdAt).toISOString() ===
        v.createdAt.replace(/Z$/, v.createdAt.includes(".") ? "Z" : ".000Z"),
  );
}
function refs(v: unknown, s: CoverageScope, kind: string, max: number) {
  list(v, max);
  const all = v.map((r) => ref(r, s, kind));
  check(
    new Set(all.map((r) => r.kind + ":" + r.id + ":" + r.revision)).size ===
      all.length,
  );
  return all;
}
/** Wire consistency only; does not authenticate supplied records, source work or current permission. */
export function parseSelectedCoverageFrame(
  scope: CoverageScope,
  selected: CoverageRef,
  text: string,
): SelectedCoverageFrame {
  try {
    const choice = captureCoverageSelection(scope, selected);
    check(
      typeof text === "string" &&
        text.length <= 524288 &&
        new TextEncoder().encode(text).length <= 524288,
    );
    const f = exact(JSON.parse(text), [
        "planningStorage",
        "effortStorage",
        "coverage",
      ]),
      c = exact(f.coverage, [
        "schemaVersion",
        "profile",
        "tenantId",
        "projectId",
        "visibility",
        "purpose",
        "basis",
        "plan",
        "questions",
        "effortHistory",
        "historicalEffectiveEffortRefs",
        "unloaded",
      ]);
    check(
      c.schemaVersion === 1 &&
        c.profile === "captured-investigation-coverage-v1" &&
        c.tenantId === scope.tenantId &&
        c.projectId === scope.projectId &&
        c.visibility === "private",
    );
    word(c.purpose, 200);
    const b = exact(c.basis, ["plan", "planningRecordCount", "effortSequence"]);
    check(sameRef(ref(b.plan, scope, "investigation-plan"), choice));
    integer(b.planningRecordCount, choice.revision, 256);
    integer(b.effortSequence, 0, 512);
    const ps = ref(f.planningStorage, scope, "factual-planning-history");
    check(ps.revision === b.planningRecordCount && ps.id === PLANNING_KEY);
    if (b.effortSequence === 0) check(f.effortStorage === null);
    else {
      const es = ref(f.effortStorage, scope, "factual-effort-history");
      check(es.revision === b.effortSequence && es.id === EFFORT_KEY);
    }
    const p = exact(c.plan, [
      "ref",
      "supersedes",
      "visibility",
      "actorId",
      "actorKind",
      "createdAt",
      "requestId",
      "purpose",
      "value",
    ]);
    check(sameRef(ref(p.ref, scope, "investigation-plan"), choice));
    stamp(p, c.purpose);
    if (choice.revision === 1) check(p.supersedes === null);
    else {
      const prior = ref(p.supersedes, scope, "investigation-plan");
      check(prior.id === choice.id && prior.revision === choice.revision - 1);
    }
    const value = exact(p.value, [
      "title",
      "intakeCaseRef",
      "basisClaimRefs",
      "questions",
    ]);
    word(value.title, 500);
    if (value.intakeCaseRef !== null) ref(value.intakeCaseRef, scope, "case");
    refs(value.basisClaimRefs, scope, "claim", 64);
    list(value.questions, 64);
    check(value.questions.length > 0);
    const questions = new Map<string, Record<string, any>>();
    for (const qv of value.questions) {
      const q = exact(qv, [
        "id",
        "parentId",
        "text",
        "whyMaterial",
        "material",
        "hypotheses",
        "leads",
        "stopCondition",
      ]);
      word(q.id);
      check(
        !questions.has(q.id) &&
          (q.parentId === null || questions.has(q.parentId)),
      );
      word(q.text, 4000);
      word(q.whyMaterial, 4000);
      word(q.stopCondition, 4000);
      check(typeof q.material === "boolean");
      list(q.hypotheses, 16);
      check(q.hypotheses.length > 0);
      list(q.leads, 32);
      const hs = new Set(),
        ls = new Set();
      for (const hv of q.hypotheses) {
        const h = exact(hv, ["id", "explanation", "claimRefs", "contraryTest"]);
        word(h.id);
        check(!hs.has(h.id));
        hs.add(h.id);
        word(h.explanation, 4000);
        word(h.contraryTest, 4000);
        refs(h.claimRefs, scope, "claim", 64);
      }
      for (const lv of q.leads) {
        const l = exact(lv, ["id", "description"]);
        word(l.id);
        word(l.description, 4000);
        check(!ls.has(l.id));
        ls.add(l.id);
      }
      questions.set(q.id, q);
    }
    list(c.effortHistory, 512);
    const efforts = new Map<string, Record<string, any>>(),
      corrected = new Set<string>();
    let sequence = 0;
    for (const ev of c.effortHistory) {
      const e = exact(ev, [
        "plan",
        "questionId",
        "leadId",
        "outcome",
        "detail",
        "corrects",
        "ref",
        "sequence",
        "visibility",
        "actorId",
        "actorKind",
        "createdAt",
        "requestId",
        "purpose",
      ]);
      stamp(e, c.purpose);
      const er = ref(e.ref, scope, "investigation-effort"),
        plan = ref(e.plan, scope, "investigation-plan");
      check(
        er.revision === 1 &&
          !efforts.has(er.id) &&
          plan.id === choice.id &&
          plan.revision <= choice.revision,
      );
      integer(e.sequence, sequence + 1, b.effortSequence);
      sequence = e.sequence;
      word(e.questionId);
      if (e.leadId !== null) word(e.leadId);
      word(e.detail, 4000);
      check(["attempted", "unavailable", "exhausted"].includes(e.outcome));
      if (sameRef(plan, choice)) {
        const q = questions.get(e.questionId);
        check(
          q &&
            (e.leadId === null || q.leads.some((l: any) => l.id === e.leadId)),
        );
      }
      if (e.corrects !== null) {
        const prev = ref(e.corrects, scope, "investigation-effort"),
          old = efforts.get(prev.id);
        check(
          old &&
            sameRef(old.ref, prev) &&
            !corrected.has(prev.id) &&
            sameRef(old.plan, plan) &&
            old.questionId === e.questionId &&
            old.leadId === e.leadId,
        );
        corrected.add(prev.id);
      }
      efforts.set(er.id, e);
    }
    const effective = [...efforts.values()].filter(
      (e) => !corrected.has(e.ref.id),
    );
    list(c.questions, 64);
    check(c.questions.length === questions.size);
    for (const [i, q] of [...questions.values()].entries()) {
      const row = exact(c.questions[i], [
        "questionId",
        "material",
        "status",
        "effortRefs",
        "leadsWithoutRecordedEffort",
      ]);
      check(
        row.questionId === q.id &&
          row.material === q.material &&
          row.status === "unresolved",
      );
      const current = effective.filter(
        (e) => sameRef(e.plan, choice) && e.questionId === q.id,
      );
      const rr = refs(row.effortRefs, scope, "investigation-effort", 512);
      check(
        rr.length === current.length &&
          rr.every((r, i) => sameRef(r, current[i]!.ref)),
      );
      check(
        same(
          row.leadsWithoutRecordedEffort,
          q.leads
            .filter((l: any) => !current.some((e) => e.leadId === l.id))
            .map((l: any) => l.id),
        ),
      );
    }
    const hist = refs(
        c.historicalEffectiveEffortRefs,
        scope,
        "investigation-effort",
        512,
      ),
      expected = effective.filter((e) => !sameRef(e.plan, choice));
    check(
      hist.length === expected.length &&
        hist.every((r, i) => sameRef(r, expected[i]!.ref)),
    );
    check(
      same(c.unloaded, [
        "current-knowledge",
        "verification-reviews",
        "current-source-permissions",
        "raw-audit-events",
      ]),
    );
    return f as SelectedCoverageFrame;
  } catch {
    throw new CoverageReadError("invalid_response");
  }
}
/** Inert private metadata: raw audits, older plan values, source proof and current permissions are not loaded. */
export function renderSelectedCoverageFrame(
  document: Document,
  scope: CoverageScope,
  selected: CoverageRef,
  text: string,
): HTMLElement {
  const f = parseSelectedCoverageFrame(scope, selected, text),
    section = document.createElement("section");
  section.setAttribute(
    "aria-label",
    "Private unresolved investigation coverage",
  );
  const add = (tag: string, text: string) => {
    const e = document.createElement(tag);
    e.textContent = text;
    section.append(e);
  };
  add("h2", f.coverage.plan.value.title);
  add(
    "p",
    "All questions remain unresolved. Recorded attempts are not work proof, findings, answers, completeness, closure or future permission. Older plan values, current Knowledge, source permissions and audits are not loaded.",
  );
  const table = document.createElement("table"),
    caption = document.createElement("caption");
  caption.textContent = "Captured question and effort metadata";
  table.append(caption);
  const head = document.createElement("tr");
  for (const t of [
    "Question",
    "Materiality",
    "Status",
    "Recorded efforts",
    "Leads without recorded effort",
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = t;
    head.append(th);
  }
  table.append(head);
  for (const row of f.coverage.questions) {
    const tr = document.createElement("tr");
    for (const t of [
      f.coverage.plan.value.questions.find((q) => q.id === row.questionId)!
        .text,
      String(row.material),
      row.status,
      JSON.stringify(row.effortRefs),
      JSON.stringify(row.leadsWithoutRecordedEffort),
    ]) {
      const td = document.createElement("td");
      td.textContent = t;
      tr.append(td);
    }
    table.append(tr);
  }
  section.append(table);
  const detail = JSON.stringify(f, null, 2);
  check(new TextEncoder().encode(detail).length <= 2097152);
  add(
    "p",
    "Storage references are observed containing editions, not creation or audit evidence.",
  );
  add("pre", detail);
  return section;
}

// Exact owning SDK aggregate keys; tested against the pinned repository exports.
const PLANNING_KEY =
  "a498f73aab7439871077027d71ccee9bb4b8d44cc0ea25736e1970445819c82b";
const EFFORT_KEY =
  "2e311c96dfe18494a9e7ec5812f8cf4fe13d7503970d391d6487073f394bb8f5";
