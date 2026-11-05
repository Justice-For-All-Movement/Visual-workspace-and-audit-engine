import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as e from "@accountability/evidence";
import {
  createKnowledgeState,
  reviseKnowledge,
} from "@accountability/knowledge-verification";
import {
  createEvidenceLinksState,
  reviseEvidenceLinks,
} from "@accountability/knowledge-verification/evidence-links";
import {
  projectVerificationReview,
  renderVerificationReview,
} from "../src/verification-review.ts";
import {
  createVerificationReviewState,
  recordVerificationReview,
} from "@accountability/knowledge-verification/verification-review";
import { renderWorkspace } from "../src/index.ts";
const c = {
  tenantId: "fiction",
  projectId: "links",
  actor: { id: "reviewer", kind: "human" as const, roles: ["researcher"] },
  purpose: "review",
  requestId: "fixture",
  now: "2026-01-01T00:00:00Z",
};
function setup() {
  let evidence = e.acquireEvidence(e.createEvidenceState(c), c, {
    id: "source",
    bytes: Buffer.from("Fictional bytes"),
    acquisitionId: "acq",
    storageVersionRef: "private-object",
    mediaType: "text/plain",
    sourceFamilyId: null,
    capturedAt: c.now,
    originalLanguage: "und",
    allowedPurposes: ["review"],
    supersedes: null,
  });
  const v = evidence.versions[0]!;
  evidence = e.beginScan(evidence, c, {
    id: "start",
    evidence: v.ref,
    attemptId: "scan",
    engineVersion: "synthetic-only",
  });
  evidence = e.completeScan(evidence, c, {
    id: "complete",
    evidence: v.ref,
    attemptId: "scan",
    sha256: v.sha256,
    status: "clean",
    reason: "Synthetic, not deployed malware qualification",
  });
  const value = {
    type: "claim" as const,
    text: "</script><script>window.injected=true</script>",
    subjectRefs: [],
    time: { earliest: null, latest: null },
    accountType: "observation" as const,
    limitations: [],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  const knowledge = reviseKnowledge(c, createKnowledgeState(c), {
    id: "claim",
    expectedRevision: 0,
    value,
  });
  const command = {
    claim: knowledge.records[0]!.ref,
    expectedRevision: 0,
    links: [
      {
        id: "support",
        relation: "supports" as const,
        selector: { kind: "whole" as const, evidence: v.ref, sha256: v.sha256 },
      },
      {
        id: "contrary",
        relation: "challenges" as const,
        selector: { kind: "whole" as const, evidence: v.ref, sha256: v.sha256 },
      },
    ],
  };
  const state = reviseEvidenceLinks(
    c,
    knowledge,
    evidence,
    createEvidenceLinksState(c),
    command,
  );
  const checks = Object.fromEntries(
    [
      "authenticity",
      "sourceKnowledge",
      "independentSupport",
      "counterevidence",
    ].map((k) => [
      k,
      {
        status: "reviewed" as const,
        note: "Literal reviewer assertion, not work proof",
      },
    ]),
  ) as Parameters<typeof recordVerificationReview>[4]["checks"];
  const reviews = recordVerificationReview(
    c,
    knowledge,
    state,
    createVerificationReviewState(c),
    {
      linkRef: state.records[0]!.ref,
      expectedRevision: 0,
      checks,
      rationale: "Unresolved fictional review",
    },
  );
  return { knowledge, evidence, state, command, value, checks, reviews };
}

const project = (
  f: ReturnType<typeof setup>,
  selected = f.reviews.records[0]!.ref,
) =>
  projectVerificationReview(
    c,
    { revision: f.knowledge.records.length, state: f.knowledge },
    {
      revision: f.state.records.length,
      state: f.state,
      knowledgeRevision: f.knowledge.records.length,
    },
    f.reviews,
    selected,
    "tested",
  );
const render = (
  f: ReturnType<typeof setup>,
  selected = f.reviews.records[0]!.ref,
) =>
  renderVerificationReview(
    c,
    { revision: f.knowledge.records.length, state: f.knowledge },
    {
      revision: f.state.records.length,
      state: f.state,
      knowledgeRevision: f.knowledge.records.length,
    },
    f.reviews,
    selected,
    "tested",
  );

test("captured verification preserves four separate reviewed assertions, contrary IDs and exact editions without findings or invented audits", () => {
  const f = setup(),
    v = project(f),
    review = v.nodes.find(
      (n) => n.ref.kind === "knowledge-verification-review",
    )!;
  assert.equal(v.visibility, "private");
  assert.deepEqual(v.events, []);
  assert.deepEqual(v.agents, []);
  const details = review.details as any;
  assert.equal(details.record.resolution, "unresolved");
  assert.equal(details.record.assessment, null);
  assert.deepEqual(details.record.challengeLinkIds, ["contrary"]);
  assert.equal(details.latestReviewBasisStatus, "current-editions");
  assert.equal(
    v.nodes.filter((n) => n.state === "captured-storage-edition").length,
    2,
  );
  assert.ok(!v.nodes.some((n) => n.ref.kind.includes("verification-history")));
  const citation = v.nodes.find(
    (n) => n.ref.kind === "knowledge-evidence-links",
  )!;
  assert.deepEqual(
    (citation.details as any).record.links.map((x: any) => x.relation),
    ["supports", "challenges"],
  );
  assert.equal(v.nodes.filter((n) => n.ref.kind === "evidence").length, 1);
  const detached = structuredClone(details.record);
  Object.assign(f.reviews.records[0]!, { rationale: "caller mutation" });
  assert.deepEqual(details.record, detached);
});

test("corrections preserve historical contrary notes and latest captured stale-basis status without replacing old references", () => {
  const f = setup();
  f.state = reviseEvidenceLinks(c, f.knowledge, f.evidence, f.state, {
    ...f.command,
    expectedRevision: 1,
    links: [],
  });
  f.reviews = recordVerificationReview(c, f.knowledge, f.state, f.reviews, {
    linkRef: f.state.records[1]!.ref,
    expectedRevision: 1,
    checks: f.checks,
    rationale: "Later unresolved observation",
  });
  f.knowledge = reviseKnowledge(c, f.knowledge, {
    id: "claim",
    expectedRevision: 1,
    value: { ...f.value, text: "Later assertion" },
  });
  const v = project(f),
    rows = v.nodes.filter(
      (n) => n.ref.kind === "knowledge-verification-review",
    );
  assert.equal(rows.length, 2);
  const old = rows.find((n) => n.ref.revision === 1)!.details as any;
  const latest = rows.find((n) => n.ref.revision === 2)!.details as any;
  assert.deepEqual(old.record.challengeLinkIds, ["contrary"]);
  assert.deepEqual(latest.record.challengeLinkIds, []);
  assert.equal(old.record.linkRef.revision, 1);
  assert.equal(latest.record.linkRef.revision, 2);
  assert.equal(old.latestReviewBasisStatus, "needs-review");
  assert.equal(latest.record.resolution, "unresolved");
  assert.equal(
    (project(f, f.reviews.records[1]!.ref).nodes.at(-1)!.details as any).record
      .ref.revision,
    1,
  );
});

test("missing captured basis stays explicitly unloaded and never produces zero or invented containing revisions", () => {
  const f = setup();
  f.knowledge = createKnowledgeState(c);
  f.state = createEvidenceLinksState(c);
  const v = project(f),
    d = v.nodes.find((n) => n.ref.kind === "knowledge-verification-review")!
      .details as any;
  assert.equal(d.latestReviewBasisStatus, "needs-review");
  assert.equal(
    v.nodes.filter((n) => n.state === "captured-storage-edition").length,
    0,
  );
  assert.ok(v.nodes.some((n) => n.state === "referenced-claim-not-loaded"));
  assert.ok(
    v.nodes.some((n) => n.state === "referenced-citation-set-not-loaded"),
  );
  assert.ok(v.nodes.every((n) => n.ref.revision > 0));
  assert.deepEqual(d.record.challengeLinkIds, ["contrary"]);
});

test("literal hostile notes and dollar replacement markers render inert exact text with native inspectors", () => {
  const f = setup(),
    hostile = "</script><img src=x onerror=alert(1)> $& $` $' 🧭";
  const checks = {
    ...f.checks,
    counterevidence: { status: "concern" as const, note: hostile },
  };
  f.reviews = recordVerificationReview(c, f.knowledge, f.state, f.reviews, {
    linkRef: f.state.records[0]!.ref,
    expectedRevision: 1,
    checks,
    rationale: hostile,
  });
  const dom = new JSDOM(render(f, f.reviews.records[1]!.ref), {
      runScripts: "dangerously",
    }),
    doc = dom.window.document;
  assert.equal(doc.querySelectorAll("img,iframe,object,embed").length, 0);
  assert.ok(
    [...doc.querySelectorAll("dd")].some((n) => n.textContent === hostile),
  );
  assert.equal(doc.querySelectorAll("main").length, 1);
  const button = [...doc.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Captured unresolved"),
  );
  const dialog = doc.querySelector("dialog")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
    },
  });
  assert.ok(button);
  button.click();
  assert.ok(dialog.hasAttribute("open"));
  const detail = JSON.parse(doc.querySelector("#detail")!.textContent!);
  assert.equal(detail.details.record.resolution, "unresolved");
  assert.equal(detail.details.record.challengeLinkIds[0], "contrary");
  assert.ok(doc.body.textContent!.includes("knowledge-verification-review"));
  dom.window.close();
});

test("owning validators reject challenge tampering, injected approvals, foreign refs and inconsistent storage captures", () => {
  for (const alter of [
    (f: ReturnType<typeof setup>) =>
      Object.assign(f.reviews.records[0]!, { challengeLinkIds: [] }),
    (f: ReturnType<typeof setup>) =>
      Object.assign(f.reviews.records[0]!, { editorialApproval: "approved" }),
    (f: ReturnType<typeof setup>) =>
      Object.assign(f.reviews.records[0]!.ref, { projectId: "foreign" }),
  ]) {
    const f = setup();
    alter(f);
    assert.throws(() => project(f));
  }
  const f = setup();
  assert.throws(
    () =>
      projectVerificationReview(
        c,
        { revision: 2, state: f.knowledge },
        { revision: 1, state: f.state, knowledgeRevision: 1 },
        f.reviews,
        f.reviews.records[0]!.ref,
        "tested",
      ),
    { code: "invalid_review_snapshot" },
  );
  assert.throws(() =>
    projectVerificationReview(
      { ...c, actor: { ...c.actor, kind: "service" } },
      { revision: 1, state: f.knowledge },
      { revision: 1, state: f.state, knowledgeRevision: 1 },
      f.reviews,
      f.reviews.records[0]!.ref,
      "tested",
    ),
  );
  assert.throws(
    () => project(f, { ...f.reviews.records[0]!.ref, revision: 99 }),
    { code: "missing_reference" },
  );
});

test("whole oversized captured input and extra authority fields reject before any partial projection", () => {
  const f = setup();
  assert.throws(
    () =>
      projectVerificationReview(
        c,
        { revision: 1, state: f.knowledge, authority: "grant" } as never,
        { revision: 1, state: f.state, knowledgeRevision: 1 },
        f.reviews,
        f.reviews.records[0]!.ref,
        "tested",
      ),
    { code: "invalid_review_snapshot" },
  );
  const oversized = {
    ...f.reviews,
    untrustedPadding: "x".repeat(5 * 1024 * 1024),
  };
  assert.throws(
    () =>
      projectVerificationReview(
        c,
        { revision: 1, state: f.knowledge },
        { revision: 1, state: f.state, knowledgeRevision: 1 },
        oversized,
        f.reviews.records[0]!.ref,
        "tested",
      ),
    { code: "projection_too_large" },
  );
});

test("valid owning citation captures can exceed the output budget and reject the whole view without truncation", () => {
  const f = setup(),
    text = "x".repeat(16032),
    source = f.evidence.versions[0]!;
  f.evidence = e.addRepresentation(f.evidence, c, {
    id: "large-text",
    evidence: source.ref,
    sourceSha256: source.sha256,
    text,
    pages: null,
    durationMs: null,
    toolVersion: "synthetic-budget-fixture",
  });
  const rep = f.evidence.representations.at(-1)!;
  const selector = {
    kind: "text" as const,
    evidence: source.ref,
    sha256: source.sha256,
    representationId: rep.id,
    representationDigest: rep.digest,
    page: null,
    start: 0,
    end: text.length,
    quote: text,
  };
  f.state = reviseEvidenceLinks(c, f.knowledge, f.evidence, f.state, {
    ...f.command,
    expectedRevision: 1,
    links: Array.from({ length: 32 }, (_, i) => ({
      id: `passage-${i}`,
      relation: "quotes" as const,
      selector: {
        ...selector,
        start: i,
        end: i + 16000,
        quote: text.slice(i, i + 16000),
      },
    })),
  });
  f.reviews = recordVerificationReview(c, f.knowledge, f.state, f.reviews, {
    linkRef: f.state.records[1]!.ref,
    expectedRevision: 1,
    checks: f.checks,
    rationale: "Large exact captured passages remain unresolved",
  });
  const old = structuredClone(f.reviews);
  assert.throws(() => project(f, f.reviews.records[1]!.ref), {
    code: "projection_too_large",
  });
  assert.throws(() => render(f, f.reviews.records[1]!.ref), {
    code: "projection_too_large",
  });
  assert.deepEqual(f.reviews, old);
});

import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  KnowledgeRepository,
  VERIFICATION_REVIEWS_KIND,
  VERIFICATION_REVIEWS_KEY,
} from "@accountability/knowledge-verification/repository";
import {
  projectStoredVerificationReview,
  renderStoredVerificationReview,
} from "../src/verification-review.ts";

async function storedFixture(t: test.TestContext) {
  const f = setup(),
    pg = new PGlite();
  t.after(() => pg.close());
  const sqlModule = import.meta.resolve(
    "@accountability/knowledge-verification/repository",
  );
  // Resolve the owning package's stable persistence dependency, never a different engine's database.
  const { createRequire } = await import("node:module");
  const require = createRequire(sqlModule),
    migration = require.resolve("@accountability/evidence-sql/database");
  await pg.exec(
    await readFile(
      new URL("../migrations/001_foundation.sql", "file:" + migration),
      "utf8",
    ),
  );
  await pg.exec(
    "CREATE ROLE visual_review_fixture LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO visual_review_fixture; SET SESSION AUTHORIZATION visual_review_fixture",
  );
  const db = {
    transaction: <T>(
      fn: (q: {
        query: <R>(sql: string, values?: unknown[]) => Promise<{ rows: R[] }>;
      }) => Promise<T>,
    ) =>
      pg.transaction((q) =>
        fn({
          query: async <R>(sql: string, values?: unknown[]) => ({
            rows: (await q.query(sql, values)).rows as R[],
          }),
        }),
      ),
    close: async () => {},
  };
  const repo = new KnowledgeRepository(db, {
    tenantId: c.tenantId,
    projectId: c.projectId,
    purpose: c.purpose,
    humanIds: [c.actor.id],
  });
  const claim = await repo.append(
    c,
    0,
    { id: "claim", expectedRevision: 0, value: f.value },
    "claim",
  );
  const link = await repo.recordEvidenceLinks(
    c,
    0,
    f.evidence,
    { ...f.command, claim: claim.record },
    "links",
  );
  await repo.recordVerificationReview(
    c,
    0,
    {
      linkRef: link.record,
      expectedRevision: 0,
      checks: f.checks,
      rationale: "Unresolved fictional review",
    },
    "review",
  );
  const snapshots = async () => ({
    knowledge: await repo.load(c),
    links: await repo.loadEvidenceLinks(c),
    reviews: await repo.loadVerificationReviews(c),
  });
  return { ...f, repo, snapshots };
}
type StoredFixture = Awaited<ReturnType<typeof storedFixture>>;
type StoredSnapshots = Awaited<ReturnType<StoredFixture["snapshots"]>>;
const storedProject = (
  s: StoredSnapshots,
  selected = s.reviews.state.records[0]!.ref,
) =>
  projectStoredVerificationReview(
    c,
    s.knowledge,
    s.links,
    s.reviews,
    selected,
    "tested",
  );

test("stored review projection uses actual restricted owning snapshots and containing revision without inventing audit or creation editions", async (t) => {
  const f = await storedFixture(t),
    s = await f.snapshots(),
    v = storedProject(s),
    r = v.nodes.find((n) => n.ref.kind === "knowledge-verification-review")!;
  const storage = v.nodes.find(
    (n) => n.ref.kind === VERIFICATION_REVIEWS_KIND,
  )!;
  assert.equal(storage.ref.id, VERIFICATION_REVIEWS_KEY);
  assert.equal(storage.ref.revision, 1);
  assert.ok(
    r.dependencies.some(
      (x) => JSON.stringify(x) === JSON.stringify(storage.ref),
    ),
  );
  assert.deepEqual((r.details as any).containingStorage, storage.ref);
  assert.equal((r.details as any).record.resolution, "unresolved");
  assert.equal((r.details as any).record.assessment, null);
  assert.deepEqual((r.details as any).record.challengeLinkIds, ["contrary"]);
  assert.deepEqual(v.events, []);
  assert.deepEqual(v.agents, []);
  assert.equal(
    projectVerificationReview(
      c,
      s.knowledge,
      s.links,
      s.reviews.state,
      r.ref,
      "tested",
    ).nodes.filter((n) => n.ref.kind === VERIFICATION_REVIEWS_KIND).length,
    0,
  );
  const original = structuredClone(s.reviews);
  Object.assign(s.reviews.state.records[0]!, { rationale: "caller changed" });
  assert.equal(
    (r.details as any).record.rationale,
    original.state.records[0]!.rationale,
  );
  assert.deepEqual((await f.snapshots()).reviews, original);
});

test("historical review records link to the actual containing edition while current owning basis changes stay needs-review", async (t) => {
  const f = await storedFixture(t);
  await f.repo.recordEvidenceLinks(
    c,
    1,
    f.evidence,
    { ...f.command, expectedRevision: 1, links: [] },
    "later-links",
  );
  const s1 = await f.snapshots();
  await f.repo.recordVerificationReview(
    c,
    1,
    {
      linkRef: s1.links.state.records[1]!.ref,
      expectedRevision: 1,
      checks: f.checks,
      rationale: "Later unresolved observation",
    },
    "later-review",
  );
  await f.repo.append(
    c,
    1,
    {
      id: "claim",
      expectedRevision: 1,
      value: { ...f.value, text: "Later unverified claim" },
    },
    "later-claim",
  );
  const s = await f.snapshots(),
    v = storedProject(s);
  assert.equal(
    v.nodes.find((n) => n.ref.kind === VERIFICATION_REVIEWS_KIND)!.ref.revision,
    2,
  );
  const old = v.nodes.find(
    (n) =>
      n.ref.kind === "knowledge-verification-review" && n.ref.revision === 1,
  )!.details as any;
  assert.equal(old.containingStorage.revision, 2);
  assert.equal(old.record.ref.revision, 1);
  assert.deepEqual(old.record.challengeLinkIds, ["contrary"]);
  assert.equal(old.latestReviewBasisStatus, "needs-review");
  assert.equal(
    v.nodes.filter((n) => n.ref.kind === "knowledge-verification-review")
      .length,
    2,
  );
  assert.throws(
    () =>
      projectStoredVerificationReview(
        c,
        s.knowledge,
        s.links,
        s1.reviews,
        s1.reviews.state.records[0]!.ref,
        "tested",
      ),
    { code: "invalid_review_snapshot" },
  );
});

test("stored profile rejects mismatched containing counts, fabricated latest status and extra authority instead of downgrading to pure capture", async (t) => {
  const f = await storedFixture(t),
    s = await f.snapshots();
  for (const alter of [
    (r: typeof s.reviews) => Object.assign(r, { revision: 2 }),
    (r: typeof s.reviews) => Object.assign(r, { knowledgeRevision: 2 }),
    (r: typeof s.reviews) => Object.assign(r, { linksRevision: 2 }),
    (r: typeof s.reviews) => Object.assign(r, { latest: [] }),
    (r: typeof s.reviews) =>
      Object.assign(r.latest[0]!, { basisStatus: "needs-review" }),
    (r: typeof s.reviews) => Object.assign(r, { authority: "grant" }),
  ]) {
    const r = structuredClone(s.reviews);
    alter(r);
    assert.throws(
      () =>
        projectStoredVerificationReview(
          c,
          s.knowledge,
          s.links,
          r,
          r.state.records[0]!.ref,
          "tested",
        ),
      { code: "invalid_review_snapshot" },
    );
  }
  const corrupt = structuredClone(s.reviews);
  Object.assign(corrupt.state.records[0]!, { challengeLinkIds: [] });
  assert.throws(() =>
    projectStoredVerificationReview(
      c,
      s.knowledge,
      s.links,
      corrupt,
      corrupt.state.records[0]!.ref,
      "tested",
    ),
  );
  assert.throws(() =>
    projectStoredVerificationReview(
      c,
      s.knowledge,
      s.links,
      s.reviews.state as never,
      s.reviews.state.records[0]!.ref,
      "tested",
    ),
  );
});

test("stored review HTML exposes exact aggregate metadata in inert native inspectors and preserves literal hostile notes", async (t) => {
  const f = await storedFixture(t),
    literal = "</script><img src=x onerror=alert(1)> $& $` $' 🧭";
  await f.repo.recordVerificationReview(
    c,
    1,
    {
      linkRef: f.state.records[0]!.ref,
      expectedRevision: 1,
      checks: {
        ...f.checks,
        counterevidence: { status: "concern", note: literal },
      },
      rationale: literal,
    },
    "literal",
  );
  const s = await f.snapshots(),
    dom = new JSDOM(
      renderStoredVerificationReview(
        c,
        s.knowledge,
        s.links,
        s.reviews,
        s.reviews.state.records[1]!.ref,
        "tested",
      ),
      { runScripts: "dangerously" },
    ),
    d = dom.window.document;
  assert.equal(d.querySelectorAll("img,iframe,object").length, 0);
  assert.ok(
    [...d.querySelectorAll("dd")].some((n) => n.textContent === literal),
  );
  assert.ok(
    d.body.textContent!.includes("Observed verification storage revision 2"),
  );
  const dialog = d.querySelector("dialog")!;
  Object.assign(dialog, {
    showModal() {
      dialog.setAttribute("open", "");
    },
    close() {
      dialog.removeAttribute("open");
    },
  });
  const button = [...d.querySelectorAll("button")].find(
    (x) => x.textContent === "Captured verification storage edition",
  )!;
  button.click();
  assert.ok(dialog.hasAttribute("open"));
  const detail = JSON.parse(d.querySelector("#detail")!.textContent!);
  assert.equal(detail.ref.kind, VERIFICATION_REVIEWS_KIND);
  assert.equal(detail.ref.revision, 2);
  assert.equal(detail.details.createdAt, undefined);
  dom.window.close();
});

test("stored profile enforces whole input bounds and exact scope before exposing a partial graph", async (t) => {
  const f = await storedFixture(t),
    s = await f.snapshots(),
    ref = s.reviews.state.records[0]!.ref;
  assert.throws(() =>
    projectStoredVerificationReview(
      { ...c, projectId: "foreign" },
      s.knowledge,
      s.links,
      s.reviews,
      ref,
      "tested",
    ),
  );
  const oversized = {
    ...s.reviews,
    untrustedPadding: "x".repeat(5 * 1024 * 1024),
  };
  assert.throws(
    () =>
      projectStoredVerificationReview(
        c,
        s.knowledge,
        s.links,
        oversized,
        ref,
        "tested",
      ),
    { code: "projection_too_large" },
  );
  assert.throws(
    () =>
      projectStoredVerificationReview(
        c,
        { ...s.knowledge, revision: 2 },
        s.links,
        s.reviews,
        ref,
        "tested",
      ),
    { code: "invalid_review_snapshot" },
  );
});

test("stored output budget includes containing storage metadata beyond an otherwise admitted pure view", () => {
  const f = setup(),
    text = "x".repeat(16032),
    source = f.evidence.versions[0]!;
  const evidence = e.addRepresentation(f.evidence, c, {
    id: "storage-budget",
    evidence: source.ref,
    sourceSha256: source.sha256,
    text,
    pages: null,
    durationMs: null,
    toolVersion: "synthetic-budget-fixture",
  });
  const rep = evidence.representations.at(-1)!;
  const probe = (length: number) => {
    const links = reviseEvidenceLinks(c, f.knowledge, evidence, f.state, {
      ...f.command,
      expectedRevision: 1,
      links: Array.from({ length: 32 }, (_, i) => ({
        id: `p-${i}`,
        relation: "quotes" as const,
        selector: {
          kind: "text" as const,
          evidence: source.ref,
          sha256: source.sha256,
          representationId: rep.id,
          representationDigest: rep.digest,
          page: null,
          start: i,
          end: i + length,
          quote: text.slice(i, i + length),
        },
      })),
    });
    const reviews = recordVerificationReview(c, f.knowledge, links, f.reviews, {
      linkRef: links.records[1]!.ref,
      expectedRevision: 1,
      checks: f.checks,
      rationale: "Large captured exact passages remain unresolved",
    });
    return {
      knowledge: { revision: 1, state: f.knowledge },
      links: { revision: 2, state: links, knowledgeRevision: 1 },
      reviews,
    };
  };
  let low = 10000,
    high = 16000,
    best: ReturnType<typeof probe> | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2),
      p = probe(mid);
    try {
      projectVerificationReview(
        c,
        p.knowledge,
        p.links,
        p.reviews,
        p.reviews.records[1]!.ref,
        "tested",
      );
      best = p;
      low = mid + 1;
    } catch (error) {
      assert.equal((error as { code: string }).code, "projection_too_large");
      high = mid - 1;
    }
  }
  assert.ok(best);
  const latest = best.reviews.records.at(-1)!;
  const captured = {
    revision: 2,
    state: best.reviews,
    knowledgeRevision: 1,
    linksRevision: 2,
    latest: [{ ref: latest.ref, basisStatus: "current-editions" as const }],
  };
  assert.doesNotThrow(() =>
    projectVerificationReview(
      c,
      best!.knowledge,
      best!.links,
      best!.reviews,
      latest.ref,
      "tested",
    ),
  );
  assert.throws(
    () =>
      projectStoredVerificationReview(
        c,
        best!.knowledge,
        best!.links,
        captured,
        latest.ref,
        "tested",
      ),
    { code: "projection_too_large" },
  );
});
