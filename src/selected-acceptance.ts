import type { CurrentProposalAcceptanceReader } from "@accountability/knowledge-verification/proposal-acceptance-reader";
export type SelectedAcceptanceFrame = Awaited<ReturnType<CurrentProposalAcceptanceReader["read"]>>;
export type AcceptanceScope = Readonly<{
  tenantId: string;
  projectId: string;
}>;
export type AcceptanceRef = AcceptanceScope &
  Readonly<{ kind: string; id: string; revision: number }>;
export class AcceptanceReadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "AcceptanceReadError";
  }
}
function require(value: unknown): asserts value {
  if (!value) throw new AcceptanceReadError("invalid_response");
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
  scope: AcceptanceScope,
  kind?: string,
): AcceptanceRef {
  const r = exact(value, ["tenantId", "projectId", "kind", "id", "revision"]);
  for (const key of ["tenantId", "projectId", "kind", "id"]) word(r[key]);
  integer(r.revision);
  require(
    r.tenantId === scope.tenantId &&
      r.projectId === scope.projectId &&
      (!kind || r.kind === kind),
  );
  return r as AcceptanceRef;
}
export function captureAcceptanceSelection(
  scope: AcceptanceScope,
  selected: AcceptanceRef,
): AcceptanceRef {
  // Capture only plain own data fields. A getter must not change the selected scope between checks and POST.
  require(selected && Object.getPrototypeOf(selected) === Object.prototype);
  const keys = ["tenantId", "projectId", "kind", "id", "revision"];
  require(Reflect.ownKeys(selected).length === keys.length);
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(selected, key);
    require(field && "value" in field && field.enumerable);
    captured[key] = field.value;
  }
  const choice = ref(captured, scope, "knowledge-proposal-acceptance");
  require(choice.revision === 1); hash(choice.id); return { ...choice };
}
function same(a: AcceptanceRef, b: AcceptanceRef) {
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
  current: AcceptanceRef,
  scope: AcceptanceScope,
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
function selector(value: unknown, scope: AcceptanceScope) {
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
/** Wire consistency only. Metadata and recorded digests are not authentication or historical source proof. */
export function parseSelectedAcceptanceFrame(scope: AcceptanceScope, selected: AcceptanceRef, text: string): SelectedAcceptanceFrame {
  try {
    const choice = captureAcceptanceSelection(scope, selected);
    require(typeof text === "string" && text.length <= 512 * 1024 && new TextEncoder().encode(text).length <= 512 * 1024);
    const f = exact(JSON.parse(text), ["acceptance", "record", "claim", "citation", "knowledgeStorage", "linksStorage"]);
    require(same(ref(f.acceptance, scope, "knowledge-proposal-acceptance"), choice));
    const ks = ref(f.knowledgeStorage, scope, "knowledge-history"), ls = ref(f.linksStorage, scope, "knowledge-evidence-links-history");
    hash(ks.id); hash(ls.id); require(ks.revision <= 2048 && ls.revision <= 512);
    const r = exact(f.record, ["schemaVersion", "visibility", "tenantId", "projectId", "purpose", "proposalId", "bundleDigest", "parentClaim", "parentLinks", "parentKnowledgeRevision", "parentLinksRevision", "capturedEvidenceRevision", "parentRelation", "excerpt", "claim", "links", "actorId", "createdAt", "requestId"]);
    require(r.schemaVersion === 1 && r.visibility === "private" && r.tenantId === scope.tenantId && r.projectId === scope.projectId);
    word(r.purpose, 128); word(r.proposalId); stamp(r); hash(r.bundleDigest);
    for (const n of [r.parentKnowledgeRevision, r.parentLinksRevision, r.capturedEvidenceRevision]) integer(n);
    require(r.parentKnowledgeRevision < ks.revision && r.parentLinksRevision < ls.revision && ["supports", "challenges", "quotes"].includes(r.parentRelation));
    const pc = ref(r.parentClaim, scope, "claim"), pl = ref(r.parentLinks, scope, "knowledge-evidence-links");
    require(pc.id === pl.id && pc.revision <= r.parentKnowledgeRevision && pl.revision <= r.parentLinksRevision);
    const cr = ref(r.claim, scope, "claim"), lr = ref(r.links, scope, "knowledge-evidence-links");
    require(cr.revision === 1 && lr.revision === 1 && cr.id === lr.id && cr.id !== pc.id);
    const c = exact(f.claim, ["ref", "supersedes", "visibility", "createdAt", "actorId", "actorKind", "requestId", "purpose", "value"]);
    const l = exact(f.citation, ["ref", "supersedes", "claim", "visibility", "createdAt", "actorId", "actorKind", "requestId", "purpose", "links"]);
    require(same(ref(c.ref, scope, "claim"), cr) && same(ref(l.ref, scope, "knowledge-evidence-links"), lr) && same(ref(l.claim, scope, "claim"), cr));
    for (const record of [c, l]) {
      stamp(record); require(record.supersedes === null && record.visibility === "private" && record.actorKind === "human" && record.actorId === r.actorId && record.createdAt === r.createdAt && record.requestId === r.requestId && record.purpose === r.purpose);
    }
    const v = exact(c.value, ["type", "text", "subjectRefs", "time", "accountType", "limitations", "assessment", "proceduralPosture", "editorialApproval"]);
    word(v.text, 12000); exact(v.time, ["earliest", "latest"]);
    require(v.type === "claim" && Array.isArray(v.subjectRefs) && v.subjectRefs.length === 0 && v.time.earliest === null && v.time.latest === null && v.accountType === "research_inference" && v.assessment === null && v.proceduralPosture === null && v.editorialApproval === null);
    require(JSON.stringify(v.limitations) === JSON.stringify(["Untrusted assertion proposal; an exact quotation is not verification or corroboration.", "Human accepted an unassessed proposal; the retained quotation is not support or verification."]));
    require(Array.isArray(l.links) && l.links.length === 1);
    const q = exact(l.links[0], ["id", "relation", "selector", "family", "fingerprint"]);
    word(q.id); require(q.relation === "quotes"); hash(q.fingerprint); selector(q.selector, scope);
    const family = exact(q.family, ["familyId", "roots", "basisDigest"]);
    if (family.familyId !== null) word(family.familyId); strings(family.roots, 128); hash(family.basisDigest);
    const s = q.selector, e = exact(r.excerpt, ["start", "end", "quote"]);
    integer(e.start, 0); integer(e.end); word(e.quote, 16000);
    require(s.kind === "text" && s.end - s.start === s.quote.length && e.start >= s.start && e.end <= s.end && e.start < e.end && s.quote.slice(e.start - s.start, e.end - s.start) === e.quote);
    for (const value of [s.quote, e.quote]) require(new TextDecoder("utf-8", {fatal:true}).decode(new TextEncoder().encode(value)) === value);
    return f as SelectedAcceptanceFrame;
  } catch { throw new AcceptanceReadError("invalid_response"); }
}
/** Literal private view; no reconstructed parent histories, fabricated audits or source permission. */
export function renderSelectedAcceptanceFrame(document: Document, scope: AcceptanceScope, selected: AcceptanceRef, text: string): HTMLElement {
  const f = parseSelectedAcceptanceFrame(scope, selected, text), section = document.createElement("section");
  section.setAttribute("aria-label", "Private selected unassessed acceptance");
  const add = (tag: string, text: string) => { const e = document.createElement(tag); e.textContent = text; section.append(e); };
  add("h2", "Private unassessed assertion"); add("p", f.claim.value.type === "claim" ? f.claim.value.text : "");
  add("p", "Quote-only citation. Acceptance is not verification, corroboration, a finding, answer or future permission. Parent histories, source object bytes and audits are not loaded. Recorded digests do not authenticate the original bundle or writer profile.");
  add("blockquote", f.record.excerpt.quote);
  add("p", `Observed containing editions: Knowledge ${f.knowledgeStorage.revision}; citations ${f.linksStorage.revision}. These are not creation editions.`);
  add("pre", JSON.stringify(f, null, 2)); return section;
}
