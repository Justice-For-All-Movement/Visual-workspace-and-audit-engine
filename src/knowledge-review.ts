import { inspectKnowledge } from "@accountability/knowledge-verification";
import type {
  KnowledgeState,
  KnowledgeRevision,
} from "@accountability/knowledge-verification";
import {
  KNOWLEDGE_KIND,
  KNOWLEDGE_KEY,
} from "@accountability/knowledge-verification/repository";
import {
  canonical,
  invariant,
  refKey,
  requireScope,
  validateRef,
} from "./contracts.ts";
import type { Context, Json, Ref } from "./contracts.ts";
import { layoutWorkspace } from "./index.ts";
import type { WorkspaceSnapshot, VisualNode, WorkStage } from "./index.ts";

/** A host-authorized capture, never authentication or a current source/Consent observation. */
export function projectKnowledgeRecord(
  context: Context,
  input: Readonly<{ revision: number; state: KnowledgeState }>,
  selected: Ref,
  stage: WorkStage,
): WorkspaceSnapshot {
  invariant(
    Buffer.byteLength(canonical(input)) <= 3 * 1024 * 1024,
    "projection_too_large",
    "Knowledge input exceeds 3MiB",
  );
  const c = structuredClone(context),
    snapshot = structuredClone(input),
    choice = structuredClone(selected);
  invariant(
    Object.keys(snapshot).length === 2 &&
      Object.hasOwn(snapshot, "revision") &&
      Object.hasOwn(snapshot, "state"),
    "invalid_knowledge_snapshot",
    "Exact owning snapshot required",
  );
  const records = inspectKnowledge(c, snapshot.state);
  invariant(
    Number.isSafeInteger(snapshot.revision) &&
      snapshot.revision === records.length,
    "invalid_knowledge_snapshot",
    "Storage revision must match retained history",
  );
  const check = (r: Ref) => {
    validateRef(r);
    requireScope(c, r);
    invariant(
      Object.keys(r).length === 5,
      "invalid_reference",
      "Exact reference required",
    );
  };
  check(choice);
  for (const r of records) {
    check(r.ref);
    if (r.supersedes) check(r.supersedes);
    invariant(
      r.purpose === c.purpose,
      "purpose_denied",
      "Exact record purpose required",
    );
  }
  const same = (a: Ref, b: Ref) => canonical(a) === canonical(b);
  const record = records.find((r) => same(r.ref, choice));
  invariant(
    record,
    "missing_reference",
    "Selected exact Knowledge edition required",
  );
  const latest = (r: Ref) =>
    records.filter((x) => x.ref.kind === r.kind && x.ref.id === r.id).at(-1)!;
  const storage = validateRef({
    tenantId: c.tenantId,
    projectId: c.projectId,
    kind: KNOWLEDGE_KIND,
    id: KNOWLEDGE_KEY,
    revision: snapshot.revision,
  });
  const nodes: VisualNode[] = [
    {
      ref: storage,
      label: "Captured Knowledge storage edition",
      kind: "artifact",
      state: "captured-storage-edition",
      stage,
      dependencies: [],
      summary:
        "Observed containing revision, not a record creation audit or current permission.",
      details: { revision: snapshot.revision },
    },
  ];
  const seen = new Set([refKey(storage)]);
  const add = (node: VisualNode) => {
    invariant(
      !seen.has(refKey(node.ref)),
      "reference_collision",
      "Distinct projection roles required",
    );
    seen.add(refKey(node.ref));
    nodes.push(node);
    invariant(
      nodes.length <= 256 &&
        nodes.reduce((sum, n) => sum + n.dependencies.length, 0) <= 512,
      "projection_too_large",
      "Knowledge view exceeds graph budget",
    );
  };
  const value = record.value;
  const refs =
    value.type === "claim"
      ? value.subjectRefs
      : value.type === "event"
        ? value.entityRefs
        : value.type === "relationship"
          ? [value.from, value.to]
          : [];
  const dependencies: Ref[] = [storage];
  for (const r of [
    ...refs,
    ...(record.supersedes ? [record.supersedes] : []),
  ]) {
    check(r);
    if (!dependencies.some((x) => same(x, r))) dependencies.push(r);
    if (seen.has(refKey(r))) continue;
    const captured = records.find((x) => same(x.ref, r));
    invariant(
      captured,
      "missing_reference",
      "Captured dependency edition required",
    );
    add({
      ref: r,
      label: "Exact captured Knowledge dependency",
      kind: r.kind === "claim" ? "claim" : "artifact",
      state: "captured-dependency-not-expanded",
      stage,
      dependencies: [storage],
      summary:
        "One-hop captured edition only; current source validity, Consent and transitive impact were not independently checked.",
      details: JSON.parse(
        canonical({
          record: captured,
          latestCapturedRef: latest(r).ref,
          containingStorage: storage,
        }),
      ) as Json,
    });
  }
  const title = (r: KnowledgeRevision) =>
    r.value.type === "claim" ? r.value.text : r.value.label;
  add({
    ref: record.ref,
    label: title(record).slice(0, 200),
    kind: value.type === "claim" ? "claim" : "artifact",
    state: same(record.ref, latest(record.ref).ref)
      ? "latest-captured-edition-unassessed"
      : "historical-captured-edition",
    stage,
    dependencies,
    summary:
      "Literal private Knowledge metadata. Assessment, procedural posture and editorial approval remain separate; no verified finding or role truth is inferred.",
    details: JSON.parse(
      canonical({
        record,
        latestCapturedRef: latest(record.ref).ref,
        containingStorage: storage,
        notice:
          "Host-authorized capture only; actor/time/request are record metadata, not authentication, audit events or use permits.",
      }),
    ) as Json,
  });
  const output: WorkspaceSnapshot = {
    tenantId: c.tenantId,
    projectId: c.projectId,
    schemaVersion: 1,
    visibility: "private",
    title: "Private Knowledge record review",
    capturedAt: c.now,
    nodes,
    agents: [],
    events: [],
  };
  invariant(
    Buffer.byteLength(canonical(output)) <= 512 * 1024,
    "projection_too_large",
    "Knowledge output exceeds 512KiB",
  );
  layoutWorkspace(c, output);
  return output;
}
