import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyToolOutcome,
  createExecutionTasks,
  createKeyedLock,
  executeTaskGraph,
  RetryableTaskError,
  UnknownTaskOutcomeError,
  updateTaskForTurnProgress,
  validateTaskGraph,
} from "../src/lib/server/execution-core.ts";

function makeTask(id, dependencies = []) {
  return {
    id,
    title: `Task ${id}`,
    description: `Do ${id}`,
    assignedBotId: "bot-a",
    requiredCapabilities: [],
    dependencies,
    status: "pending",
    sideEffectsPossible: false,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    approvalRequired: true,
  };
}

test("creates pending tasks with approval requirements and validates bot assignments", () => {
  const task = createExecutionTasks(
    [{ id: "first", title: "First task", description: "Do the work", assignedBotId: "bot-a", requiredCapabilities: [], dependencies: [] }],
    [{ id: "bot-a", approval: "ask" }],
    "2026-01-01T00:00:00.000Z",
  )[0];
  assert.equal(task.status, "pending");
  assert.equal(task.retryCount, 0);
  assert.equal(task.sideEffectsPossible, false);
  assert.equal(task.approvalRequired, true);
  assert.equal(task.createdAt, "2026-01-01T00:00:00.000Z");
  assert.throws(
    () =>
      createExecutionTasks(
        [{ id: "needs-search", title: "Search", description: "Search the web", assignedBotId: "bot-a", requiredCapabilities: ["webSearch"], dependencies: [] }],
        [{ id: "bot-a", approval: "ask", tools: { webSearch: false }, connections: [] }],
      ),
    /does not have the webSearch capability/,
  );
  assert.throws(
    () =>
      createExecutionTasks(
        [{ id: "first", title: "First task", description: "Do the work", assignedBotId: "other", requiredCapabilities: [], dependencies: [] }],
        [{ id: "bot-a", approval: "ask" }],
      ),
    /unavailable bot/,
  );
});

test("rejects unknown and circular dependencies", () => {
  assert.throws(() => validateTaskGraph([makeTask("first", ["missing"])]), /unknown dependency/);
  assert.throws(
    () => validateTaskGraph([makeTask("first", ["second"]), makeTask("second", ["first"])]),
    /cycle/,
  );
});

test("executes dependency-free tasks concurrently", async () => {
  const tasks = [makeTask("one"), makeTask("two")];
  let active = 0;
  let peak = 0;
  await executeTaskGraph(tasks, {
    signal: new AbortController().signal,
    concurrency: 2,
    onTaskUpdate: async () => {},
    runTask: async (task) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return task.id;
    },
  });
  assert.equal(peak, 2);
  assert.deepEqual(tasks.map((task) => task.status), ["completed", "completed"]);
});

test("waits for dependencies and passes their output to the next task", async () => {
  const tasks = [makeTask("research"), makeTask("draft", ["research"])];
  const order = [];
  await executeTaskGraph(tasks, {
    signal: new AbortController().signal,
    onTaskUpdate: async () => {},
    runTask: async (task, outputs) => {
      order.push(task.id);
      if (task.id === "draft") assert.equal(outputs.get("research"), "source notes");
      return task.id === "research" ? "source notes" : "draft done";
    },
  });
  assert.deepEqual(order, ["research", "draft"]);
  assert.equal(tasks[1].status, "completed");
});

test("marks dependent tasks failed while allowing independent work to finish", async () => {
  const tasks = [makeTask("failed"), makeTask("blocked", ["failed"]), makeTask("independent")];
  await executeTaskGraph(tasks, {
    signal: new AbortController().signal,
    maxRetries: 0,
    onTaskUpdate: async () => {},
    runTask: async (task) => {
      if (task.id === "failed") throw new Error("worker error");
      return "ok";
    },
  });
  assert.equal(tasks[0].status, "failed");
  assert.match(tasks[0].error, /worker error/);
  assert.equal(tasks[1].status, "failed");
  assert.equal(tasks[2].status, "completed");
});

test("retries at most the configured number of times", async () => {
  const tasks = [makeTask("retry")];
  let calls = 0;
  await executeTaskGraph(tasks, {
    signal: new AbortController().signal,
    maxRetries: 2,
    onTaskUpdate: async () => {},
    runTask: async () => {
      calls += 1;
      if (calls < 3) throw new RetryableTaskError("temporary");
      return "recovered";
    },
  });
  assert.equal(calls, 3);
  assert.equal(tasks[0].retryCount, 2);
  assert.equal(tasks[0].status, "completed");

  const exhausted = [makeTask("exhausted")];
  calls = 0;
  await executeTaskGraph(exhausted, {
    signal: new AbortController().signal,
    maxRetries: 2,
    onTaskUpdate: async () => {},
    runTask: async () => {
      calls += 1;
      throw new RetryableTaskError("still failing");
    },
  });
  assert.equal(calls, 3);
  assert.equal(exhausted[0].status, "failed");

  const bounded = [makeTask("bounded")];
  calls = 0;
  await executeTaskGraph(bounded, {
    signal: new AbortController().signal,
    maxRetries: 99,
    onTaskUpdate: async () => {},
    runTask: async () => {
      calls += 1;
      throw new RetryableTaskError("still failing");
    },
  });
  assert.equal(calls, 4);
  assert.equal(bounded[0].retryCount, 3);
});

test("does not retry a rejected action", async () => {
  const tasks = [makeTask("rejected")];
  let calls = 0;
  await executeTaskGraph(tasks, {
    signal: new AbortController().signal,
    maxRetries: 2,
    onTaskUpdate: async () => {},
    runTask: async () => {
      calls += 1;
      throw new Error("A required action was rejected.");
    },
  });
  assert.equal(calls, 1);
  assert.equal(tasks[0].status, "failed");
  assert.equal(tasks[0].retryCount, 0);
});

test("does not rerun after a successful turn when completion persistence fails", async () => {
  const tasks = [makeTask("persist-result")];
  let calls = 0;
  await assert.rejects(
    executeTaskGraph(tasks, {
      signal: new AbortController().signal,
      maxRetries: 2,
      onTaskUpdate: async (task) => {
        if (task.status === "completed") throw new Error("simulated database write failure");
      },
      runTask: async () => {
        calls += 1;
        return "external action completed";
      },
    }),
    /Task state could not be saved/,
  );
  assert.equal(calls, 1);
  assert.equal(tasks[0].retryCount, 0);
  assert.equal(tasks[0].status, "outcome_unknown");
});

test("does not retry a task when its external outcome is unknown", async () => {
  const tasks = [makeTask("unknown")];
  let calls = 0;
  await executeTaskGraph(tasks, {
    signal: new AbortController().signal,
    maxRetries: 3,
    onTaskUpdate: async () => {},
    runTask: async () => {
      calls += 1;
      throw new UnknownTaskOutcomeError("action may have happened");
    },
  });
  assert.equal(calls, 1);
  assert.equal(tasks[0].retryCount, 0);
  assert.equal(tasks[0].status, "outcome_unknown");
});

test("cancels a running task without retrying it", async () => {
  const tasks = [makeTask("long-running")];
  const controller = new AbortController();
  const running = executeTaskGraph(tasks, {
    signal: controller.signal,
    onTaskUpdate: async () => {},
    runTask: () => new Promise(() => {}),
  });
  setTimeout(() => controller.abort(), 10);
  await running;
  assert.equal(tasks[0].status, "cancelled");
  assert.equal(tasks[0].retryCount, 0);
});

test("marks a cancelled task outcome unknown after tool activity", async () => {
  const tasks = [makeTask("cancel-after-tool")];
  tasks[0].sideEffectsPossible = true;
  const controller = new AbortController();
  const running = executeTaskGraph(tasks, {
    signal: controller.signal,
    onTaskUpdate: async () => {},
    runTask: () => new Promise(() => {}),
  });
  setTimeout(() => controller.abort(), 10);
  await running;
  assert.equal(tasks[0].status, "outcome_unknown");
});

test("tracks approval and question waits and resumes the task after a response", () => {
  const task = makeTask("waiting");
  const approval = {
    id: "message-1",
    conversationId: "execution:e:task:waiting",
    role: "bot",
    createdAt: new Date().toISOString(),
    status: "streaming",
    parts: [{ kind: "tool", toolCallId: "tool-1", name: "browser_goto", label: "Open page", status: "awaiting-approval" }],
  };
  assert.equal(updateTaskForTurnProgress(task, approval, approval.conversationId), true);
  assert.equal(task.status, "awaiting_approval");
  assert.deepEqual(task.approvalRequest, { conversationId: approval.conversationId, toolCallId: "tool-1" });

  const resumed = { ...approval, parts: [{ ...approval.parts[0], status: "running" }] };
  assert.equal(updateTaskForTurnProgress(task, resumed, approval.conversationId), true);
  assert.equal(task.status, "running");
  assert.equal(task.approvalRequest, undefined);

  const question = {
    ...approval,
    parts: [{ kind: "question", toolCallId: "question-1", question: "Which option?", options: [{ label: "A" }] }],
  };
  updateTaskForTurnProgress(task, question, approval.conversationId);
  assert.equal(task.status, "awaiting_input");
  assert.equal(task.inputRequest.toolCallId, "question-1");

  const answered = { ...question, parts: [{ ...question.parts[0], answer: "A" }] };
  updateTaskForTurnProgress(task, answered, approval.conversationId);
  assert.equal(task.status, "running");
  assert.equal(task.inputRequest, undefined);
});

test("distinguishes rejected actions from mixed uncertain tool outcomes", () => {
  const message = {
    id: "message-1",
    conversationId: "execution:e:task:t",
    role: "bot",
    createdAt: new Date().toISOString(),
    status: "done",
    parts: [{ kind: "tool", toolCallId: "tool-1", name: "browser_goto", label: "Open", status: "denied" }],
  };
  assert.equal(classifyToolOutcome(message), "rejected");
  assert.equal(classifyToolOutcome({ ...message, parts: [...message.parts, { ...message.parts[0], toolCallId: "tool-2", status: "done" }] }), "unknown");
  assert.equal(classifyToolOutcome(undefined), "none");
});

test("serializes browser work per bot and skips cancelled work queued behind a lock", async () => {
  const withLock = createKeyedLock();
  let active = 0;
  let peak = 0;
  await Promise.all(
    ["one", "two"].map(() =>
      withLock("same-bot", async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 1);

  let releaseFirst;
  const first = withLock("queued-bot", () => new Promise((resolve) => (releaseFirst = resolve)));
  await Promise.resolve();
  const controller = new AbortController();
  let calls = 0;
  const queued = withLock("queued-bot", async () => {
    if (controller.signal.aborted) return;
    calls += 1;
  });
  controller.abort();
  releaseFirst();
  await Promise.all([first, queued]);
  assert.equal(calls, 0);
});
