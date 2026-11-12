import type { IdentityQuestionDispositionRepository } from "@accountability/factual-investigation/disposition-identity";
import {
  captureCoverageSelection,
  parseSelectedCoverageFrame,
  CoverageReadError,
} from "./selected-coverage.ts";
import type { CoverageScope, CoverageRef } from "./selected-coverage.ts";
export {
  captureCoverageSelection as captureDispositionSelection,
  CoverageReadError as DispositionReadError,
};
export type DispositionScope = CoverageScope;
export type DispositionRef = CoverageRef;
export type SelectedDispositionFrame = Awaited<
  ReturnType<IdentityQuestionDispositionRepository["load"]>
>;
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
function int(
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
function stable(v: any): string {
  return JSON.stringify(
    v === null || typeof v !== "object"
      ? v
      : Array.isArray(v)
        ? v.map((x) => JSON.parse(stable(x)))
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, JSON.parse(stable(v[k]))]),
          ),
  );
}
function same(a: unknown, b: unknown) {
  return stable(a) === stable(b);
}
function ref(v: unknown, s: CoverageScope, kind: string): CoverageRef {
  const r = exact(v, ["tenantId", "projectId", "kind", "id", "revision"]);
  for (const k of ["tenantId", "projectId", "kind", "id"]) word(r[k]);
  int(r.revision);
  check(
    r.tenantId === s.tenantId && r.projectId === s.projectId && r.kind === kind,
  );
  return r as CoverageRef;
}
function time(v: unknown): asserts v is string {
  check(
    typeof v === "string" &&
      v.length === 24 &&
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString() === v,
  );
}
function decision(v: unknown) {
  const d = exact(v, [
    "questionId",
    "status",
    "reason",
    "assigneeId",
    "reviewAt",
  ]);
  word(d.questionId);
  word(d.reason, 4000);
  check(["unresolved", "deferred", "assigned"].includes(d.status));
  if (d.status === "assigned") word(d.assigneeId);
  else check(d.assigneeId === null);
  if (d.status === "unresolved") check(d.reviewAt === null);
  else time(d.reviewAt);
  return d;
}
/** Wire consistency only. Original planning prefixes/digest inputs/audits/current clock are not loaded. */
export function parseSelectedDispositionFrame(
  scope: CoverageScope,
  selected: CoverageRef,
  text: string,
): SelectedDispositionFrame {
  try {
    const choice = captureCoverageSelection(scope, selected);
    check(
      typeof text === "string" &&
        text.length <= 524288 &&
        new TextEncoder().encode(text).length <= 524288,
    );
    const f = exact(JSON.parse(text), [
      "storage",
      "planningStorage",
      "effortStorage",
      "table",
    ]);
    const t = exact(f.table, [
      "schemaVersion",
      "profile",
      "visibility",
      "tenantId",
      "projectId",
      "purpose",
      "coverage",
      "reviewRequired",
      "latestReview",
      "questions",
      "history",
    ]);
    check(
      t.schemaVersion === 1 &&
        t.profile === "captured-question-dispositions-v1" &&
        t.visibility === "private" &&
        t.tenantId === scope.tenantId &&
        t.projectId === scope.projectId,
    );
    word(t.purpose, 200);
    const covered = parseSelectedCoverageFrame(
      scope,
      choice,
      JSON.stringify({
        planningStorage: f.planningStorage,
        effortStorage: f.effortStorage,
        coverage: t.coverage,
      }),
    );
    check(covered.coverage.purpose === t.purpose);
    let revision = 0;
    if (f.storage !== null) {
      const s = ref(f.storage, scope, "factual-question-review-history");
      check(s.id === DISPOSITION_KEY);
      int(s.revision, 1, 256);
      revision = s.revision;
    }
    list(t.history, 256);
    const ids = new Set<string>();
    let previous: any = null,
      planning = 0,
      effort = 0;
    for (const value of t.history) {
      const r = exact(value, [
        "ref",
        "sequence",
        "supersedes",
        "basis",
        "questions",
        "reopeningTriggers",
        "visibility",
        "actorId",
        "actorKind",
        "createdAt",
        "requestId",
        "purpose",
      ]);
      const rr = ref(r.ref, scope, "investigation-question-review");
      check(rr.revision === 1 && !ids.has(rr.id));
      ids.add(rr.id);
      int(r.sequence, (previous?.sequence ?? 0) + 1, revision);
      check(same(r.supersedes, previous?.ref ?? null));
      if (r.supersedes !== null)
        check(
          ref(r.supersedes, scope, "investigation-question-review").revision ===
            1,
        );
      check(
        r.visibility === "private" &&
          r.actorKind === "human" &&
          r.purpose === t.purpose,
      );
      word(r.actorId);
      word(r.requestId);
      time(r.createdAt);
      const b = exact(r.basis, [
          "plan",
          "planningRecordCount",
          "effortSequence",
          "captureDigest",
        ]),
        plan = ref(b.plan, scope, "investigation-plan");
      check(plan.id === choice.id && plan.revision <= choice.revision);
      int(
        b.planningRecordCount,
        Math.max(planning, plan.revision),
        covered.coverage.basis.planningRecordCount,
      );
      int(b.effortSequence, effort, covered.coverage.basis.effortSequence);
      planning = b.planningRecordCount;
      effort = b.effortSequence;
      check(
        typeof b.captureDigest === "string" &&
          /^[a-f0-9]{64}$/.test(b.captureDigest),
      );
      list(r.questions, 64);
      check(r.questions.length > 0);
      const qids = new Set<string>();
      for (const row of r.questions) {
        const d = decision(row);
        check(!qids.has(d.questionId));
        qids.add(d.questionId);
        if (d.reviewAt !== null)
          check(Date.parse(d.reviewAt) > Date.parse(r.createdAt));
      }
      if (same(plan, choice))
        check(
          same(
            r.questions.map((q: any) => q.questionId),
            covered.coverage.questions.map((q) => q.questionId),
          ),
        );
      list(r.reopeningTriggers, 16);
      check(
        r.reopeningTriggers.length > 0 &&
          new Set(r.reopeningTriggers).size === r.reopeningTriggers.length,
      );
      for (const trigger of r.reopeningTriggers) word(trigger, 2000);
      previous = r;
    }
    check(same(t.latestReview, previous));
    check(
      [null, "no-review", "basis-changed", "review-due"].includes(
        t.reviewRequired,
      ),
    );
    if (!previous) check(t.reviewRequired === "no-review");
    else {
      const changed =
        !same(previous.basis.plan, choice) ||
        previous.basis.planningRecordCount !==
          covered.coverage.basis.planningRecordCount ||
        previous.basis.effortSequence !== covered.coverage.basis.effortSequence;
      check(
        changed
          ? t.reviewRequired === "basis-changed"
          : t.reviewRequired === null || t.reviewRequired === "review-due",
      );
    }
    list(t.questions, 64);
    check(t.questions.length === covered.coverage.questions.length);
    for (const [i, v] of t.questions.entries()) {
      const row = exact(v, ["questionId", "material", "disposition"]),
        current = covered.coverage.questions[i]!;
      check(
        row.questionId === current.questionId &&
          row.material === current.material,
      );
      const d = decision(row.disposition);
      check(d.questionId === row.questionId);
      if (t.reviewRequired === null) check(same(d, previous.questions[i]));
      else
        check(
          d.status === "unresolved" &&
            d.reason === "Explicit current review required" &&
            d.assigneeId === null &&
            d.reviewAt === null,
        );
    }
    if (f.storage === null) check(t.history.length === 0);
    return f as SelectedDispositionFrame;
  } catch {
    throw new CoverageReadError("invalid_response");
  }
}
export function renderSelectedDispositionFrame(
  document: Document,
  scope: CoverageScope,
  selected: CoverageRef,
  text: string,
): HTMLElement {
  const f = parseSelectedDispositionFrame(scope, selected, text),
    section = document.createElement("section");
  section.setAttribute(
    "aria-label",
    "Private unanswered question dispositions",
  );
  const add = (tag: string, text: string) => {
    const e = document.createElement(tag);
    e.textContent = text;
    section.append(e);
  };
  add("h2", f.table.coverage.plan.value.title);
  add(
    "p",
    "Review required: " +
      (f.table.reviewRequired ?? "none reported") +
      ". Unanswered disposition metadata is not work proof, answers, closure, authenticated assignment or future permission.",
  );
  const table = document.createElement("table"),
    caption = document.createElement("caption");
  caption.textContent = "Current unanswered question dispositions";
  table.append(caption);
  const head = document.createElement("tr");
  for (const title of [
    "Question",
    "Material",
    "Disposition",
    "Rationale",
    "Host assignee label",
    "Review time",
  ]) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = title;
    head.append(th);
  }
  table.append(head);
  for (const row of f.table.questions) {
    const tr = document.createElement("tr");
    for (const value of [
      f.table.coverage.plan.value.questions.find(
        (q) => q.id === row.questionId,
      )!.text,
      String(row.material),
      row.disposition.status,
      row.disposition.reason,
      row.disposition.assigneeId ?? "none",
      row.disposition.reviewAt ?? "none",
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    table.append(tr);
  }
  section.append(table);
  add(
    "p",
    "Historical reviews and older-plan question IDs are retained record metadata. Full older planning values, digest inputs, current clock, raw audits and source permissions are not loaded. Storage editions contain records; they are not invented creation editions.",
  );
  const detail = JSON.stringify(f, null, 2);
  check(new TextEncoder().encode(detail).length <= 2097152);
  add("pre", detail);
  return section;
}
// Stable owning SDK key, independently tested against its actual public export.
const DISPOSITION_KEY =
  "81d131c394ac8dbeaa95679ad1d847539a4a01538cdfdec46e9a65e08ff34396";
