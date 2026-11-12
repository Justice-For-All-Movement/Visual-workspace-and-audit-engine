import test from "node:test";
import assert from "node:assert/strict";
import * as k from "@accountability/knowledge-verification";
import type {
  Context,
  Ref,
} from "@accountability/knowledge-verification/contracts";
import * as f from "@accountability/factual-investigation";
import { inspectCapturedPlanCorrectionImpact as impact } from "@accountability/factual-investigation/correction-impact";
const c: Context = {
  tenantId: "fiction",
  projectId: "review",
  purpose: "private-review",
  actor: { id: "researcher", kind: "human", roles: ["researcher"] },
  now: "2026-01-01T00:00:00Z",
  requestId: "r",
};
const entity: k.KnowledgeValue = {
  type: "entity",
  label: "Fictional person",
  description: "Unresolved",
  category: "person",
};
const claimValue: Extract<k.KnowledgeValue, { type: "claim" }> = {
  type: "claim",
  text: "Unverified fictional account",
  subjectRefs: [],
  time: { earliest: null, latest: null },
  accountType: "attributed_testimony",
  limitations: ["Unverified"],
  assessment: null,
  proceduralPosture: null,
  editorialApproval: null,
};
function planValue(refs: readonly Ref[]): f.Plan {
  return {
    title: "Fictional review",
    intakeCaseRef: null,
    basisClaimRefs: refs,
    questions: [
      {
        id: "q",
        parentId: null,
        text: "What can be established?",
        whyMaterial: "Account unresolved",
        material: true,
        hypotheses: [
          {
            id: "h",
            explanation: "A fictional account",
            claimRefs: refs,
            contraryTest: "Seek an authorized contrary account",
          },
        ],
        leads: [],
        stopCondition: "Remain unresolved if no authorized evidence",
      },
    ],
  };
}
export function impactSetup() {
  let knowledge = k.reviseKnowledge(c, k.createKnowledgeState(c), {
    id: "person",
    expectedRevision: 0,
    value: entity,
  });
  const person = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "event",
    expectedRevision: 0,
    value: {
      type: "event",
      label: "Fictional meeting",
      description: "Unverified fixture",
      entityRefs: [person],
      time: { earliest: null, latest: null },
    },
  });
  const event = knowledge.records.at(-1)!.ref;
  const roleValue: Extract<k.KnowledgeValue, { type: "relationship" }> = {
    type: "relationship",
    relationshipType: "role_assertion",
    label: "Reported attendee",
    from: person,
    to: event,
    time: { earliest: null, latest: null },
    limitations: ["Unverified"],
    assessment: null,
    proceduralPosture: null,
    editorialApproval: null,
  };
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "role",
    expectedRevision: 0,
    value: roleValue,
  });
  const role = knowledge.records.at(-1)!.ref;
  knowledge = k.reviseKnowledge(c, knowledge, {
    id: "claim",
    expectedRevision: 0,
    value: { ...claimValue, subjectRefs: [role] },
  });
  const claim = knowledge.records.at(-1)!.ref,
    value = planValue([claim]);
  const plans = f.revisePlan(c, knowledge, f.createPlanningState(c), {
    id: "plan",
    expectedRevision: 0,
    value,
  });
  return {
    knowledge,
    plans,
    selected: plans.records[0]!.ref,
    person,
    event,
    role,
    roleValue,
    claim,
    value,
  };
}
export function corrected() {
  const x = impactSetup();
  const knowledge = k.reviseKnowledge(c, x.knowledge, {
    id: "event",
    expectedRevision: 1,
    value: {
      type: "event",
      label: "Fictional meeting",
      description: "Corrected captured date",
      entityRefs: [x.person],
      time: { earliest: "2026-01-02T00:00:00Z", latest: null },
    },
  });
  const after = knowledge.records.at(-1)!.ref;
  const plans = f.revisePlan(c, knowledge, x.plans, {
    id: "unrelated",
    expectedRevision: 0,
    value: planValue([]),
  });
  return { ...x, knowledge, plans, after };
}

import {
  KNOWLEDGE_KEY,
  KNOWLEDGE_KIND,
} from "@accountability/knowledge-verification/repository";
import {
  PLANNING_KEY,
  PLANNING_KIND,
} from "@accountability/factual-investigation/repository";
export { c, planValue, entity, claimValue };
export function wire(
  knowledge: k.KnowledgeState,
  plans: f.PlanningState,
  before: Ref,
  after: Ref,
) {
  const result = impact(c, JSON.stringify({ knowledge, plans }), before, after);
  const selected = { before, after },
    scope = {
      tenantId: c.tenantId,
      projectId: c.projectId,
      purpose: c.purpose,
    };
  const frame = {
    profile: "current-plan-correction-impact-v1" as const,
    knowledgeStorage: {
      tenantId: c.tenantId,
      projectId: c.projectId,
      kind: KNOWLEDGE_KIND,
      id: KNOWLEDGE_KEY,
      revision: knowledge.records.length,
    },
    planningStorage: plans.records.length
      ? {
          tenantId: c.tenantId,
          projectId: c.projectId,
          kind: PLANNING_KIND,
          id: PLANNING_KEY,
          revision: plans.records.length,
        }
      : null,
    impact: result,
  };
  return { scope, selected, frame };
}
export function impactFixture() {
  const x = corrected();
  const plans = f.revisePlan(c, x.knowledge, x.plans, {
    id: "plan",
    expectedRevision: 1,
    value: planValue([]),
  });
  return { ...x, ...wire(x.knowledge, plans, x.event, x.after) };
}
