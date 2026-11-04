import { writeFile } from "node:fs/promises";
import {
  createKnowledgeState,
  reviseKnowledge,
} from "@accountability/knowledge-verification";
import { projectKnowledgeRecord } from "../dist/knowledge-review.js";
import { renderWorkspace } from "../dist/index.js";
const c = {
  tenantId: "fiction",
  projectId: "private-example",
  actor: { id: "fixture-author", kind: "human", roles: ["owner"] },
  purpose: "review",
  requestId: "fictional-example",
  now: "2026-01-01T00:00:00Z",
};
let state = reviseKnowledge(c, createKnowledgeState(c), {
  id: "entity",
  expectedRevision: 0,
  value: {
    type: "entity",
    label: "Fictional witness",
    category: "person",
    description: "Unresolved fictional identity",
  },
});
state = reviseKnowledge(c, state, {
  id: "claim",
  expectedRevision: 0,
  value: {
    type: "claim",
    text: "A fictional lamp was lit",
    subjectRefs: [state.records[0].ref],
    time: { earliest: null, latest: null },
    accountType: "attributed_testimony",
    limitations: ["Fictional, unverified demonstration"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  },
});
state = reviseKnowledge(c, state, {
  id: "entity",
  expectedRevision: 1,
  value: {
    type: "entity",
    label: "Updated fictional witness label",
    category: "person",
    description: "The earlier claim still retains entity edition1",
  },
});
await writeFile(
  "docs/examples/private-knowledge-review.html",
  renderWorkspace(
    c,
    projectKnowledgeRecord(
      c,
      { revision: 3, state },
      state.records[1].ref,
      "pending",
    ),
  ),
);
