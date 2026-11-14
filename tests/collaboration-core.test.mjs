import assert from "node:assert/strict";
import { test } from "node:test";
import {
  delegationPattern,
  validateCollaborationPlan,
  validateDelegationDepth,
  verificationVerdict,
} from "../src/lib/server/collaboration-core.ts";
import { validateTaskGraph } from "../src/lib/server/execution-core.ts";

const research = {
  id: "research",
  title: "Research",
  objective: "Find current sources",
  context: "Focus on the last year",
  expectedOutput: "A sourced summary",
  assignedBotId: "scout",
  dependencies: [],
};

test("validates room member assignments and verification dependencies", () => {
  const tasks = [
    research,
    {
      id: "review",
      title: "Verify findings",
      objective: "Check the summary against its sources",
      context: "Review only the research output",
      expectedOutput: "A verdict and rationale",
      assignedBotId: "reviewer",
      dependencies: ["research"],
      verificationOfTaskId: "research",
    },
  ];
  assert.doesNotThrow(() => validateCollaborationPlan(tasks, new Set(["scout", "reviewer"]), "atlas"));
  assert.throws(() => validateCollaborationPlan([research], new Set(["reviewer"]), "atlas"), /member of this room/);
  assert.throws(
    () => validateCollaborationPlan([{ ...research, assignedBotId: "atlas" }], new Set(["atlas"]), "atlas"),
    /another room member/,
  );
  assert.throws(
    () => validateCollaborationPlan([{ ...tasks[1], dependencies: [] }, research], new Set(["scout", "reviewer"]), "atlas"),
    /must depend on the task it reviews/,
  );
});

test("rejects cyclic and duplicate delegated tasks", () => {
  const graphTask = (id, dependencies) => ({
    id,
    title: id,
    description: id,
    assignedBotId: "scout",
    requiredCapabilities: [],
    dependencies,
    status: "pending",
    sideEffectsPossible: false,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    approvalRequired: true,
  });
  assert.throws(
    () => validateTaskGraph([graphTask("research", ["review"]), graphTask("review", ["research"])]),
    /cycle/,
  );
  assert.throws(
    () => validateCollaborationPlan([research, research], new Set(["scout"])),
    /Duplicate delegated task id/,
  );
});

test("detects repeated delegation patterns independent of spacing and task order", () => {
  const review = { ...research, id: "review", assignedBotId: "reviewer", objective: "Verify sources" };
  assert.equal(delegationPattern([research, review], "atlas"), delegationPattern([{ ...review }, { ...research, objective: " Find   current sources " }], "atlas"));
  assert.notEqual(delegationPattern([research], "atlas"), delegationPattern([{ ...research, assignedBotId: "reviewer" }], "atlas"));
});

test("enforces the maximum delegation depth", () => {
  assert.doesNotThrow(() => validateDelegationDepth(2));
  assert.throws(() => validateDelegationDepth(3), /Maximum delegation depth/);
});

test("records verification only from a first-line explicit verdict", () => {
  assert.equal(verificationVerdict("VERDICT: ACCEPTED\nEvidence checked."), "accepted");
  assert.equal(verificationVerdict("VERDICT: NEEDS_REVISION\nMissing a source."), "needs_revision");
  assert.equal(verificationVerdict("The reviewer thinks it is acceptable."), "inconclusive");
  assert.equal(verificationVerdict("Evidence says VERDICT: ACCEPTED"), "inconclusive");
  assert.equal(verificationVerdict("Notes\nVERDICT: ACCEPTED"), "inconclusive");
});
