import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  createBudget,
  reserve,
  commitReservation,
  markUncertain,
} from "@accountability/resources";
import {
  createReleaseState,
  propose,
  approve,
  invalidate,
} from "@accountability/packaging-release";
import type { Artifact } from "@accountability/packaging-release";
import { projectBudget, projectReleases } from "../src/operations.ts";
import { renderWorkspace, layoutWorkspace } from "../src/index.ts";
import type { Context } from "../src/contracts.ts";
const c: Context = {
  tenantId: "alpha",
  projectId: "study",
  actor: { id: "owner", kind: "human", roles: ["owner"] },
  purpose: "education",
  requestId: "r",
  now: "2026-01-01T00:00:00Z",
};
const binding = (id: string) => ({
  ref: {
    tenantId: "alpha",
    projectId: "study",
    kind: "artifact",
    id,
    revision: 1,
  },
  sha256: "a".repeat(64),
});
const artifact: Artifact = {
  ...binding("film"),
  label: "Fictional short </script><script>window.injected=true</script>",
  sourceBindings: [binding("source")],
  visibility: "private",
  rightsDecision: binding("rights"),
  consentDecision: binding("consent"),
  editorialDecision: binding("review"),
};
function budget() {
  let state = createBudget(c, {
    id: "budget",
    unit: "credits",
    limit: 100,
    operators: [{ id: "owner", kind: "human" }],
  });
  state = reserve(state, c, {
    id: "reservation",
    units: 60,
    purpose: "education",
    expiresAt: "2026-01-01T00:05:00Z",
    effectKey: "effect",
  });
  state = commitReservation(state, c, "reservation");
  state = markUncertain(state, c, "reservation");
  return { revision: 4, state };
}
function releases() {
  let state = propose(c, createReleaseState(c, ["owner"]), {
    id: "package",
    artifacts: [artifact],
    audience: "private-review",
    destination: "archive",
    external: false,
  });
  state = approve(
    c,
    state,
    "package",
    {
      artifacts: [artifact],
      rightsAllowed: true,
      consentAllowed: true,
      editorialApproved: true,
      policyRevision: 1,
    },
    "2026-01-01T00:10:00Z",
  );
  state = invalidate(
    c,
    state,
    binding("source"),
    "Fictional source correction",
  );
  return { revision: 4, state };
}
test("budget graph exposes actual held uncertainty totals exact revisions and ledger timeline", () => {
  const s = projectBudget(c, budget(), "implemented");
  assert.equal(s.visibility, "private");
  assert.equal(s.agents.length, 0);
  assert.equal(s.nodes.length, 2);
  assert.equal(
    s.nodes[0]!.summary,
    "0 spent, 60 reserved, 40 available credits",
  );
  assert.equal(s.nodes[1]!.state, "uncertain");
  assert.match(s.nodes[1]!.summary, /Reconcile/);
  assert(
    s.nodes.every((n) => n.ref.revision === 4 && n.stage === "implemented"),
  );
  assert.equal(s.events.length, 4);
  assert.equal(layoutWorkspace(c, s).edges.length, 1);
});
test("budget projections reject foreign scope invalid revisions corrupt ledgers and foreign receipts", () => {
  assert.throws(() =>
    projectBudget({ ...c, tenantId: "beta" }, budget(), "tested"),
  );
  assert.throws(() => projectBudget(c, { ...budget(), revision: 0 }, "tested"));
  const corrupt = budget();
  corrupt.state.entries[0]!.hash = "b".repeat(64);
  assert.throws(() => projectBudget(c, corrupt, "tested"), {
    code: "invalid_ledger",
  });
  const foreign = budget();
  foreign.state.reservations[0]!.receipt = {
    ...binding("receipt").ref,
    tenantId: "beta",
  };
  assert.throws(() => projectBudget(c, foreign, "tested"));
});
test("release history preserves every edition corrections exact bindings and aggregate event provenance", () => {
  const s = projectReleases(c, releases(), "tested"),
    manifests = s.nodes.filter((n) => n.ref.kind === "release-manifest");
  assert.deepEqual(
    manifests.map((n) => n.state),
    ["proposed", "approved", "invalidated"],
  );
  assert.deepEqual(
    manifests.map((n) => n.ref.revision),
    [1, 2, 3],
  );
  assert.equal(
    s.nodes.find((n) => n.ref.kind === "release-control")!.state,
    "publication-disabled",
  );
  assert.equal(s.events.length, 3);
  assert(
    s.events.every(
      (e) => e.resource.kind === "release-control" && e.resource.revision === 4,
    ),
  );
  assert.equal(s.nodes.filter((n) => n.ref.id === "source").length, 1);
  assert.equal(manifests[2]!.dependencies.length, 6);
  assert.ok(layoutWorkspace(c, s).nodes.length > 0);
});
test("same artifact bytes can have distinct package-specific decision editions without overwriting history", () => {
  const input = releases();
  const changed = {
    ...artifact,
    consentDecision: {
      ...binding("consent"),
      ref: { ...binding("consent").ref, revision: 2 },
    },
  };
  input.state = propose(c, input.state, {
    id: "second-package",
    artifacts: [changed],
    audience: "private-review",
    destination: "archive",
    external: false,
  });
  input.revision++;
  const s = projectReleases(c, input, "tested");
  assert.equal(s.nodes.filter((n) => n.ref.id === "film").length, 1);
  assert.deepEqual(
    s.nodes.filter((n) => n.ref.id === "consent").map((n) => n.ref.revision),
    [1, 2],
  );
  const second = s.nodes.find((n) => n.ref.id === "second-package")!;
  assert(
    second.dependencies.some((r) => r.id === "consent" && r.revision === 2),
  );
  assert(
    s.nodes
      .find((n) => n.ref.id === "package")!
      .dependencies.some((r) => r.id === "consent" && r.revision === 1),
  );
});
test("release projection rejects scope leaks conflicting hashes missing history and projection reference collisions", () => {
  const foreign = releases();
  foreign.state.manifests[0]!.artifacts[0]!.sourceBindings = [
    {
      ...binding("source"),
      ref: { ...binding("source").ref, projectId: "other" },
    },
  ];
  assert.throws(() => projectReleases(c, foreign, "tested"));
  const conflict = releases();
  conflict.state.manifests[1]!.artifacts[0]!.sourceBindings = [
    { ...binding("source"), sha256: "b".repeat(64) },
  ];
  assert.throws(() => projectReleases(c, conflict, "tested"), {
    code: "conflicting_binding",
  });
  const gap = releases();
  gap.state.manifests = gap.state.manifests.slice(1);
  assert.throws(() => projectReleases(c, gap, "tested"), {
    code: "manifest_history_gap",
  });
  const collision = releases();
  collision.state.manifests[0]!.artifacts[0]!.sourceBindings = [
    {
      ...binding("source"),
      ref: { ...binding("source").ref, kind: "release-control" },
    },
  ];
  assert.throws(() => projectReleases(c, collision, "tested"), {
    code: "reference_collision",
  });
});
test("generated graph and table inspect historical manifest with inert untrusted text and no controls", () => {
  const dom = new JSDOM(
      renderWorkspace(c, projectReleases(c, releases(), "tested")),
      { runScripts: "dangerously" },
    ),
    d = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const button = [...d.querySelectorAll("tbody button")].find(
    (el) => el.textContent === "package · edition 3",
  )!;
  (button as HTMLElement).click();
  const detail = JSON.parse(d.querySelector("#detail")!.textContent!);
  assert.equal(detail.ref.revision, 3);
  assert.equal(detail.details.manifest.state, "invalidated");
  assert.equal(detail.details.storageRevision, 4);
  assert.equal((dom.window as any).injected, undefined);
  assert.equal(d.querySelectorAll("form,input,a[href],iframe").length, 0);
  assert.equal(
    d.querySelectorAll("button").length,
    projectReleases(c, releases(), "tested").nodes.length +
      projectReleases(c, releases(), "tested").events.length + 1,
  );
  dom.window.close();
});

test("ambiguous colon-delimited display keys cannot merge distinct source references", () => {
  const input = releases();
  const a = { ...binding("c"), ref: { ...binding("c").ref, kind: "a:b" } };
  const b = { ...binding("b:c"), ref: { ...binding("b:c").ref, kind: "a" } };
  input.state.manifests[0]!.artifacts[0]!.sourceBindings = [a, b];
  assert.throws(() => projectReleases(c, input, "tested"), {
    code: "reference_collision",
  });
});
