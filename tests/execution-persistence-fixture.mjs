import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
const require = createRequire(import.meta.url);
const typescript = require("typescript");
require.extensions[".ts"] = (loadedModule, filename) => {
  const compiled = typescript.transpile(readFileSync(filename, "utf8"), {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2022,
    esModuleInterop: true,
  });
  loadedModule._compile(compiled, filename);
};

async function main() {
  const store = require(resolve("src/lib/server/db.ts"));
  const execution = {
    id: "history-check",
    instruction: "Research and summarize",
    summary: "A simulated plan",
    plannerMode: "simulated",
    plannerLabel: "Simulated planning (mock mode)",
    status: "completed",
    tasks: [
      {
        id: "research",
        title: "Research",
        description: "Find sources",
        assignedBotId: "bot-a",
        requiredCapabilities: ["research"],
        dependencies: [],
        status: "completed",
        output: "Verified notes",
        createdAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        retryCount: 0,
        approvalRequired: true,
      },
    ],
    output: "## Research\nVerified notes",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:02.000Z",
    collaboration: {
      roomId: "room-a",
      rootExecutionId: "history-check",
      depth: 1,
      delegatorBotId: "bot-a",
      path: [],
    },
  };

  await store.saveExecution(execution);
  await store.saveExecution({
    ...execution,
    id: "second-history-check",
    instruction: "Another execution",
    tasks: execution.tasks.map((task) => ({ ...task, output: "Second execution output" })),
    collaboration: { ...execution.collaboration, parentExecutionId: execution.id, depth: 2 },
  });
  const roomExecutions = await store.listRoomExecutions("room-a");
  const childExecutions = await store.listChildExecutions(execution.id);
  const question = {
    id: "question-check",
    roomId: "room-a",
    type: "question",
    authorBotId: "bot-a",
    recipientBotId: "bot-b",
    content: "Can you verify this?",
    createdAt: "2026-01-01T00:00:03.000Z",
  };
  await store.saveCollaborationMessage(question);
  const answer = {
    id: "answer-check",
    roomId: "room-a",
    type: "answer",
    authorBotId: "bot-b",
    responseToMessageId: question.id,
    content: "Yes, I checked it.",
    createdAt: "2026-01-01T00:00:04.000Z",
  };
  await store.saveCollaborationMessage(answer);
  let duplicateAnswerRejected = false;
  try {
    await store.saveCollaborationMessage({ ...answer, id: "second-answer-check" });
  } catch {
    duplicateAnswerRejected = true;
  }
  const collaborationMessages = await store.listCollaborationMessages("room-a");
  await store.saveExecution({
    ...execution,
    id: "interrupted-check",
    status: "running",
    tasks: [
      { ...execution.tasks[0], id: "side-effect", status: "running", sideEffectsPossible: true },
      { ...execution.tasks[0], id: "no-side-effect", status: "awaiting_approval", sideEffectsPossible: false },
      { ...execution.tasks[0], id: "not-started", status: "pending", sideEffectsPossible: false },
    ],
  });
  await store.recoverInterruptedExecutions();
  const interrupted = await store.getExecution("interrupted-check");
  const recoveredStatuses = ["side-effect", "no-side-effect", "not-started"].map(
    (id) => interrupted.tasks.find((task) => task.id === id).status,
  );
  await store.saveExecution({ ...execution, id: "claim-check", status: "pending" });
  const claims = await Promise.all([store.claimExecution("claim-check"), store.claimExecution("claim-check")]);
  const firstClient = await store.db();
  await firstClient.close();
  delete globalThis.__opencrewbotDb;

  const restored = await store.getExecution(execution.id);
  const history = await store.listExecutions();
  const secondClient = await store.db();
  const migration = await secondClient.execute("SELECT MAX(version) AS version FROM schema_migrations");
  await secondClient.close();
  delete globalThis.__opencrewbotDb;
  const activePatternExecution = {
    ...execution,
    id: "pattern-one",
    status: "pending",
    tasks: [],
    collaboration: { ...execution.collaboration, patternKey: "same-delegation" },
  };
  await store.saveExecution(activePatternExecution);
  let duplicatePatternRejected = false;
  try {
    await store.saveExecution({ ...activePatternExecution, id: "pattern-two" });
  } catch {
    duplicatePatternRejected = true;
  }
  await store.saveExecution({ ...activePatternExecution, status: "completed" });
  process.stdout.write(
    JSON.stringify({
      status: restored.status,
      taskOutput: restored.tasks[0].output,
      historyId: history.find((item) => item.id === execution.id).id,
      historyCount: history.length,
      recoveredStatuses,
      claimResults: claims.sort(),
      schemaVersion: Number(migration.rows[0].version),
      roomExecutionIds: roomExecutions.map((item) => item.id).sort(),
      childExecutionIds: childExecutions.map((item) => item.id),
      collaborationMessageTypes: collaborationMessages.map((item) => item.type),
      duplicateAnswerRejected,
      duplicatePatternRejected,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
