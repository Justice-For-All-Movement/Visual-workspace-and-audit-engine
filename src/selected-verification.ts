import type { CurrentVerificationReviewReader } from "@accountability/knowledge-verification/verification-reader";

export type SelectedVerificationFrame = Awaited<
  ReturnType<CurrentVerificationReviewReader["read"]>
>;
export type VerificationScope = Readonly<{
  tenantId: string;
  projectId: string;
}>;
export type VerificationRef = VerificationScope &
  Readonly<{ kind: string; id: string; revision: number }>;
export const verificationAxes = [
  "authenticity",
  "sourceKnowledge",
  "independentSupport",
  "counterevidence",
] as const;
export class VerificationReadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "VerificationReadError";
  }
}
function require(value: unknown): asserts value {
  if (!value) throw new VerificationReadError("invalid_response");
}
function exact(value: unknown, keys: readonly string[]): Record<string, any> {
  require(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
  );
  return value as Record<string, any>;
}
function word(value: unknown, max = 128): asserts value is string {
  require(
    typeof value === "string" && value.length <= max && value.trim().length > 0,
  );
}
function integer(value: unknown, min = 1): asserts value is number {
  require(Number.isSafeInteger(value) && (value as number) >= min);
}
function ref(
  value: unknown,
  scope: VerificationScope,
  kind?: string,
): VerificationRef {
  const r = exact(value, ["tenantId", "projectId", "kind", "id", "revision"]);
  for (const key of ["tenantId", "projectId", "kind", "id"]) word(r[key]);
  integer(r.revision);
  require(
    r.tenantId === scope.tenantId &&
      r.projectId === scope.projectId &&
      (!kind || r.kind === kind),
  );
  return r as VerificationRef;
}
export function captureVerificationSelection(
  scope: VerificationScope,
  selected: VerificationRef,
): VerificationRef {
  // Copy only known primitives; no runtime dependency on Node or another engine's authority.
  return { ...ref(selected, scope, "knowledge-verification-review") };
}
function same(a: VerificationRef, b: VerificationRef) {
  return (
    a.tenantId === b.tenantId &&
    a.projectId === b.projectId &&
    a.kind === b.kind &&
    a.id === b.id &&
    a.revision === b.revision
  );
}
function predecessor(
  value: unknown,
  current: VerificationRef,
  scope: VerificationScope,
) {
  if (current.revision === 1) require(value === null);
  else {
    const p = ref(value, scope, current.kind);
    require(p.id === current.id && p.revision === current.revision - 1);
  }
}
function stamp(r: Record<string, any>) {
  word(r.actorId);
  word(r.requestId);
  require(
    typeof r.createdAt === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(r.createdAt) &&
      Number.isFinite(Date.parse(r.createdAt)) &&
      new Date(r.createdAt).toISOString() ===
        r.createdAt.replace(/Z$/, r.createdAt.includes(".") ? "Z" : ".000Z"),
  );
}
function hash(v: unknown) {
  require(typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
}
function strings(value: unknown, max: number): string[] {
  require(
    Array.isArray(value) &&
      value.length <= max &&
      new Set(value).size === value.length,
  );
  for (const v of value) word(v);
  return value;
}
function selector(value: unknown, scope: VerificationScope) {
  const kind = (value as any)?.kind;
  const base = ["evidence", "sha256", "kind"],
    anchor = [...base, "representationId", "representationDigest"];
  require(["whole", "text", "page", "time"].includes(kind));
  const s = exact(
    value,
    kind === "whole"
      ? base
      : kind === "text"
        ? [...anchor, "page", "start", "end", "quote"]
        : kind === "page"
          ? [...anchor, "fromPage", "toPage"]
          : [...anchor, "startMs", "endMs"],
  );
  ref(s.evidence, scope, "evidence");
  hash(s.sha256);
  if (kind === "whole") return;
  word(s.representationId);
  hash(s.representationDigest);
  if (kind === "text") {
    if (s.page !== null) integer(s.page);
    integer(s.start, 0);
    integer(s.end);
    word(s.quote, 16000);
    require(s.end > s.start);
  } else if (kind === "page") {
    integer(s.fromPage);
    integer(s.toPage);
    require(s.toPage >= s.fromPage);
  } else {
    integer(s.startMs, 0);
    integer(s.endMs);
    require(s.endMs > s.startMs);
  }
}
/** Wire syntax and selected-frame consistency only. Does not invent histories or authenticate captures. */
export function parseSelectedVerificationFrame(
  scope: VerificationScope,
  selected: VerificationRef,
  text: string,
): SelectedVerificationFrame {
  try {
    const choice = captureVerificationSelection(scope, selected);
    require(
      typeof text === "string" &&
        text.length <= 512 * 1024 &&
        new TextEncoder().encode(text).length <= 512 * 1024,
    );
    const f = exact(JSON.parse(text), [
      "knowledgeRevision",
      "linksRevision",
      "revision",
      "reviewRevision",
      "record",
    ]);
    for (const n of [f.knowledgeRevision, f.linksRevision, f.reviewRevision])
      integer(n);
    require(
      f.knowledgeRevision <= 2048 &&
        f.linksRevision <= 512 &&
        f.reviewRevision <= 512,
    );
    const r = exact(f.record, [
      "ref",
      "supersedes",
      "claim",
      "linkRef",
      "challengeLinkIds",
      "checks",
      "rationale",
      "resolution",
      "assessment",
      "proceduralPosture",
      "editorialApproval",
      "visibility",
      "actorId",
      "createdAt",
      "requestId",
    ]);
    const rr = ref(r.ref, scope, "knowledge-verification-review"),
      claim = ref(r.claim, scope, "claim"),
      link = ref(r.linkRef, scope, "knowledge-evidence-links");
    require(
      same(rr, choice) &&
        rr.id === claim.id &&
        rr.id === link.id &&
        rr.revision <= f.reviewRevision &&
        claim.revision <= f.knowledgeRevision &&
        link.revision <= f.linksRevision,
    );
    predecessor(r.supersedes, rr, scope);
    stamp(r);
    word(r.rationale, 4000);
    require(
      r.resolution === "unresolved" &&
        r.visibility === "private" &&
        r.assessment === null &&
        r.proceduralPosture === null &&
        r.editorialApproval === null,
    );
    exact(r.checks, verificationAxes);
    for (const axis of verificationAxes) {
      const c = exact(r.checks[axis], ["status", "note"]);
      word(c.note, 4000);
      require(
        ["unreviewed", "unresolved", "concern", "reviewed"].includes(c.status),
      );
    }
    const citation = exact(f.revision, [
      "ref",
      "supersedes",
      "claim",
      "visibility",
      "actorId",
      "actorKind",
      "createdAt",
      "requestId",
      "purpose",
      "links",
    ]);
    require(
      same(ref(citation.ref, scope, "knowledge-evidence-links"), link) &&
        same(ref(citation.claim, scope, "claim"), claim) &&
        citation.visibility === "private",
    );
    predecessor(citation.supersedes, link, scope);
    stamp(citation);
    word(citation.purpose, 200);
    require(
      ["human", "agent", "service"].includes(citation.actorKind) &&
        Array.isArray(citation.links) &&
        citation.links.length <= 64,
    );
    const ids = new Set<string>(),
      selectors = new Set<string>(),
      challenges: string[] = [];
    for (const entry of citation.links) {
      const l = exact(entry, [
        "id",
        "relation",
        "selector",
        "family",
        "fingerprint",
      ]);
      word(l.id);
      require(
        !ids.has(l.id) &&
          ["supports", "challenges", "quotes"].includes(l.relation),
      );
      ids.add(l.id);
      selector(l.selector, scope);
      hash(l.fingerprint);
      // Parsed JSON fields have fixed exact selector keys; normalize their order for duplicate detection.
      const key = JSON.stringify([
        l.relation,
        Object.keys(l.selector)
          .sort()
          .map((k) => [
            k,
            k === "evidence"
              ? [
                  l.selector.evidence.tenantId,
                  l.selector.evidence.projectId,
                  l.selector.evidence.kind,
                  l.selector.evidence.id,
                  l.selector.evidence.revision,
                ]
              : l.selector[k],
          ]),
      ]);
      require(!selectors.has(key));
      selectors.add(key);
      const family = exact(l.family, ["familyId", "roots", "basisDigest"]);
      if (family.familyId !== null) word(family.familyId);
      strings(family.roots, 128);
      hash(family.basisDigest);
      if (l.relation === "challenges") challenges.push(l.id);
    }
    const contrary = strings(r.challengeLinkIds, 64);
    require(
      JSON.stringify([...contrary].sort()) ===
        JSON.stringify(challenges.sort()),
    );
    return f as SelectedVerificationFrame;
  } catch {
    throw new VerificationReadError("invalid_response");
  }
}

/** Inert DOM view of precisely the selected wire frame. No claim text, predecessor history or audit is synthesized. */
export function renderSelectedVerificationFrame(
  document: Document,
  scope: VerificationScope,
  selected: VerificationRef,
  text: string,
): HTMLElement {
  const frame = parseSelectedVerificationFrame(scope, selected, text),
    section = document.createElement("section");
  section.setAttribute(
    "aria-label",
    "Private selected verification observations",
  );
  const add = (tag: string, text: string) => {
    const e = document.createElement(tag);
    e.textContent = text;
    section.append(e);
  };
  add("h2", "Private unresolved human review");
  add(
    "p",
    "Captured observations, not findings, answers, work proof or permission. Claim text, source bytes, predecessor history and audit events are not loaded.",
  );
  add(
    "p",
    `Observed containing editions: Knowledge ${frame.knowledgeRevision}; citations ${frame.linksRevision}; reviews ${frame.reviewRevision}. These are not record creation editions.`,
  );
  for (const axis of verificationAxes) {
    add("h3", `${axis}: ${frame.record.checks[axis].status}`);
    add("p", frame.record.checks[axis].note);
  }
  add("h3", "Rationale");
  add("p", frame.record.rationale);
  add("h3", "Exact selected record and citation metadata");
  add("pre", JSON.stringify(frame, null, 2));
  return section;
}
