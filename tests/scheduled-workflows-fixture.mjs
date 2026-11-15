import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

process.env.OPENCREWBOT_DATA_DIR = process.argv[2];
delete process.env.NEBIUS_API_KEY;
delete process.env.TAVILY_API_KEY;
delete process.env.BROWSERBASE_API_KEY;

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
Module._resolveFilename = function (request, parent, ...args) {
  const resolved = request.startsWith("@/") ? resolve("src", request.slice(2)) : request;
  return originalResolveFilename.call(this, resolved, parent, ...args);
};
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
  const service = require(resolve("src/lib/server/service.ts"));
  const scheduler = require(resolve("src/lib/server/scheduled-workflows.ts"));
  const executionService = require(resolve("src/lib/server/execution-service.ts"));
  Module._load = function (request, parent, ...args) {
    if (request === "./service" && parent?.filename === resolve("src/lib/server/http.ts")) {
      return { boot: async () => {} };
    }
    return originalLoad.call(this, request, parent, ...args);
  };
  const workflowRoute = require(resolve("src/app/api/scheduled-workflows/route.ts"));
  Module._load = originalLoad;
  const { InputError } = require(resolve("src/lib/server/errors.ts"));
  const now = new Date("2025-03-08T18:00:00.000Z");
  const bot = await service.createBot({
    name: "Schedule Agent",
    title: "Researcher",
    description: "Creates concise research reports.",
    instructions: "Be concise.",
    emoji: "🤖",
    color: "#3b82f6",
    model: "test-model",
    tools: { webSearch: true, memory: false, codeMode: false, browser: false, askUser: false },
    connections: [],
    approval: "ask",
    pinned: false,
  });

  const draft = (overrides = {}) => ({
    name: "Daily brief",
    instruction: "Prepare a daily research brief.",
    recurrence: "daily",
    timeZone: "America/New_York",
    localTime: "09:00",
    ...overrides,
  });
  const daily = await scheduler.createWorkflow(draft(), now);
  if (daily.plan.plannerMode !== "simulated" || !daily.plan.plannerLabel.includes("mock mode")) {
    throw new Error("A mock plan was not labelled as simulated.");
  }
  const dependencyPlan = {
    ...daily.plan,
    tasks: [
      {
        id: "research",
        title: "Research",
        description: "Gather relevant information.",
        assignedBotId: bot.id,
        requiredCapabilities: [],
        dependencies: [],
      },
      {
        id: "report",
        title: "Write report",
        description: "Use the research task output.",
        assignedBotId: bot.id,
        requiredCapabilities: [],
        dependencies: ["research"],
      },
    ],
  };
  await store.saveScheduledWorkflow({ ...daily, plan: dependencyPlan });
  let pastScheduleRejected = false;
  let invalidTimeZoneRejected = false;
  let emptyWeeklyScheduleRejected = false;
  for (const [invalidDraft, flag] of [
    [draft({ recurrence: "once", timeZone: "UTC", oneTimeLocal: "2025-03-08T17:00" }), "past"],
    [draft({ timeZone: "Not/A-Timezone" }), "timezone"],
    [draft({ recurrence: "weekly", weekdays: [] }), "weekly"],
  ]) {
    try {
      await scheduler.createWorkflow(invalidDraft, now);
    } catch (error) {
      if (flag === "past") pastScheduleRejected = error instanceof InputError;
      if (flag === "timezone") invalidTimeZoneRejected = error instanceof InputError;
      if (flag === "weekly") emptyWeeklyScheduleRejected = error instanceof InputError;
    }
  }

  const firstDb = await store.db();
  await firstDb.close();
  delete globalThis.__opencrewbotDb;
  const restored = await store.getScheduledWorkflow(daily.id);
  if (!restored || restored.plan.tasks.length !== dependencyPlan.tasks.length) {
    throw new Error("The workflow plan did not survive reopening SQLite.");
  }

  let factoryCalls = 0;
  const executionFactory = async (plan, options) => {
    factoryCalls += 1;
    const createdAt = now.toISOString();
    const execution = {
      id: options.id,
      instruction: plan.instruction,
      summary: plan.summary,
      plannerMode: plan.plannerMode,
      plannerLabel: plan.plannerLabel,
      status: "pending",
      scheduleId: options.scheduleId,
      createdAt,
      tasks: plan.tasks.map((task) => ({
        ...task,
        status: "pending",
        sideEffectsPossible: false,
        createdAt,
        retryCount: 0,
        approvalRequired: true,
      })),
    };
    await store.saveExecution(execution);
    return execution;
  };

  const manual = await scheduler.runWorkflowNow(daily.id, now, executionFactory);
  let overlapRejected = false;
  try {
    await scheduler.runWorkflowNow(daily.id, now, executionFactory);
  } catch (error) {
    overlapRejected = error instanceof InputError && /active execution/.test(error.message);
  }
  const manualRun = (await scheduler.listWorkflowRuns(daily.id))[0];
  if (
    manualRun.executionId !== manual.id ||
    manual.scheduleId !== daily.id ||
    manual.tasks.find((task) => task.id === "report").dependencies[0] !== "research"
  ) {
    throw new Error("Manual execution did not preserve its schedule link and dependency plan.");
  }

  const manualDone = {
    ...manual,
    status: "completed",
    completedAt: new Date(now.getTime() + 1000).toISOString(),
    tasks: manual.tasks.map((task) => ({ ...task, status: "completed", completedAt: new Date(now.getTime() + 1000).toISOString() })),
  };
  await store.saveExecution(manualDone);
  await scheduler.runScheduledWorkflowTick(now, executionFactory);
  const manualCompleted = (await scheduler.listWorkflowRuns(daily.id))[0].status === "completed";
  await scheduler.pauseWorkflow(daily.id, now);

  const oneTime = await scheduler.createWorkflow(
    draft({
      name: "One-time",
      recurrence: "once",
      timeZone: "UTC",
      oneTimeLocal: "2025-03-09T09:00",
    }),
    now,
  );
  const oneTimeAt = new Date(oneTime.nextRunAt);
  const callsBeforeOneTime = factoryCalls;
  await Promise.all([
    scheduler.runScheduledWorkflowTick(new Date(oneTimeAt.getTime() + 60_000), executionFactory),
    scheduler.runScheduledWorkflowTick(new Date(oneTimeAt.getTime() + 60_000), executionFactory),
  ]);
  const onceRuns = await scheduler.listWorkflowRuns(oneTime.id);
  const duplicateLaunches = factoryCalls - callsBeforeOneTime;

  const paused = await scheduler.createWorkflow(draft({ name: "Pause test" }), now);
  await scheduler.pauseWorkflow(paused.id, now);
  const pausedAt = new Date(paused.nextRunAt);
  const updatedPaused = await scheduler.updateWorkflow(
    paused.id,
    draft({ name: "Updated pause test", localTime: "10:00" }),
    now,
  );
  await scheduler.runScheduledWorkflowTick(new Date(pausedAt.getTime() + 60_000), executionFactory);
  const stillPaused = (await store.getScheduledWorkflow(paused.id)).status === "paused";
  const resumed = await scheduler.resumeWorkflow(paused.id, new Date(pausedAt.getTime() + 60_000));
  const pauseResume =
    stillPaused &&
    updatedPaused.name === "Updated pause test" &&
    updatedPaused.status === "paused" &&
    resumed.status === "active" &&
    new Date(resumed.nextRunAt) > pausedAt;

  const deleted = await scheduler.createWorkflow(draft({ name: "Delete test" }), now);
  await scheduler.deleteWorkflow(deleted.id, now);
  const deleteWorks = !(await scheduler.listWorkflows()).some((workflow) => workflow.id === deleted.id);

  const missed = await scheduler.createWorkflow(draft({ name: "Missed test" }), now);
  await store.saveScheduledWorkflow({ ...missed, nextRunAt: "2025-03-01T09:00:00.000Z" });
  await scheduler.runScheduledWorkflowTick(now, executionFactory);
  const missedRun = (await scheduler.listWorkflowRuns(missed.id))[0];
  const missedRunSkipped = missedRun?.status === "skipped" && /not backfilled/.test(missedRun.error);

  const failed = await scheduler.createWorkflow(
    draft({
      name: "Failure test",
      recurrence: "once",
      timeZone: "UTC",
      oneTimeLocal: "2025-03-09T10:00",
    }),
    now,
  );
  const originalError = console.error;
  console.error = () => {};
  await scheduler.runScheduledWorkflowTick(new Date(new Date(failed.nextRunAt).getTime() + 60_000), async () => {
    throw new InputError("The assigned bot is no longer available.");
  });
  console.error = originalError;
  const failedRun = (await scheduler.listWorkflowRuns(failed.id))[0];
  const failedRunRecorded = failedRun?.status === "failed" && /assigned bot/.test(failedRun.error);

  const invalidWorkflow = await scheduler.createWorkflow(draft({ name: "Deleted bot test" }), now);
  const invalidPlan = {
    ...invalidWorkflow.plan,
    tasks: invalidWorkflow.plan.tasks.map((task) => ({ ...task, assignedBotId: "deleted-bot" })),
  };
  await store.saveScheduledWorkflow({ ...invalidWorkflow, plan: invalidPlan });
  let invalidWorkflowRejected = false;
  try {
    await scheduler.runWorkflowNow(invalidWorkflow.id, now);
  } catch (error) {
    invalidWorkflowRejected = error instanceof InputError;
  }
  const invalidRun = (await scheduler.listWorkflowRuns(invalidWorkflow.id))[0];
  invalidWorkflowRejected =
    invalidWorkflowRejected && invalidRun.status === "failed" && !(await store.getExecution(invalidRun.executionId));

  const staleWorkflow = await scheduler.createWorkflow(draft({ name: "Stale recovery test" }), now);
  const staleOccurrence = new Date(now.getTime() - 6 * 60 * 1000).toISOString();
  await store.saveScheduledWorkflow({ ...staleWorkflow, nextRunAt: staleOccurrence });
  const staleRun = {
    id: "stale-run",
    workflowId: staleWorkflow.id,
    occurrenceKey: staleOccurrence,
    scheduledFor: staleOccurrence,
    executionId: "stale-execution",
    status: "claimed",
    createdAt: staleOccurrence,
    plan: staleWorkflow.plan,
  };
  const staleClaim = await store.claimScheduledWorkflowRun(staleRun);
  if (!staleClaim.claimed) throw new Error("Could not create the stale recovery fixture.");

  const recovering = await scheduler.createWorkflow(draft({ name: "Recovery test" }), now);
  await store.saveScheduledWorkflow({ ...recovering, nextRunAt: now.toISOString() });
  const recoveryRun = {
    id: "recover-run",
    workflowId: recovering.id,
    occurrenceKey: now.toISOString(),
    scheduledFor: now.toISOString(),
    executionId: "recover-execution",
    status: "claimed",
    createdAt: now.toISOString(),
    plan: recovering.plan,
  };
  const claim = await store.claimScheduledWorkflowRun(recoveryRun);
  if (!claim.claimed) throw new Error("Could not create the recovery fixture.");

  const metadataWorkflow = await scheduler.createWorkflow(draft({ name: "Metadata recovery test" }), now);
  await store.saveScheduledWorkflow({ ...metadataWorkflow, nextRunAt: now.toISOString() });
  const metadataRun = {
    id: "metadata-recovery-run",
    workflowId: metadataWorkflow.id,
    occurrenceKey: now.toISOString(),
    scheduledFor: now.toISOString(),
    executionId: "metadata-recovery-execution",
    status: "claimed",
    createdAt: now.toISOString(),
    plan: metadataWorkflow.plan,
  };
  const metadataClaim = await store.claimScheduledWorkflowRun(metadataRun);
  if (!metadataClaim.claimed) throw new Error("Could not create the metadata recovery fixture.");
  const persistedBeforeMetadata = await executionFactory(metadataWorkflow.plan, {
    id: metadataRun.executionId,
    scheduleId: metadataWorkflow.id,
  });
  const factoryCallsBeforeRecovery = factoryCalls;
  const reopenedDb = await store.db();
  await reopenedDb.close();
  delete globalThis.__opencrewbotDb;
  await scheduler.recoverScheduledWorkflowRuns(now, executionFactory);
  const recoveredRun = (await scheduler.listWorkflowRuns(recovering.id))[0];
  const recoveredClaim = recoveredRun.status === "running" && recoveredRun.executionId === "recover-execution";
  const staleRecoveredRun = (await scheduler.listWorkflowRuns(staleWorkflow.id))[0];
  const staleScheduleAfterRecovery = await store.getScheduledWorkflow(staleWorkflow.id);
  const staleRecoverySkipped =
    staleRecoveredRun.status === "skipped" &&
    /not backfilled/.test(staleRecoveredRun.error) &&
    !(await store.getExecution("stale-execution")) &&
    new Date(staleScheduleAfterRecovery.nextRunAt) > now &&
    factoryCalls === factoryCallsBeforeRecovery + 1;
  const restoredMetadataWorkflow = await store.getScheduledWorkflow(metadataWorkflow.id);
  const recoveryMetadataRestored =
    restoredMetadataWorkflow.lastExecutionId === persistedBeforeMetadata.id &&
    restoredMetadataWorkflow.lastRunAt === (persistedBeforeMetadata.startedAt ?? persistedBeforeMetadata.createdAt);
  const newerMetadataAt = new Date(now.getTime() + 60_000).toISOString();
  await store.saveScheduledWorkflow({
    ...restoredMetadataWorkflow,
    lastRunAt: newerMetadataAt,
    lastExecutionId: "newer-occurrence",
  });
  await scheduler.recoverScheduledWorkflowRuns(now, executionFactory);
  const newerMetadataWorkflow = await store.getScheduledWorkflow(metadataWorkflow.id);
  const newerMetadataPreserved =
    newerMetadataWorkflow.lastRunAt === newerMetadataAt && newerMetadataWorkflow.lastExecutionId === "newer-occurrence";

  const crowdedHistory = await scheduler.createWorkflow(draft({ name: "Crowded history" }), now);
  const quietHistory = await scheduler.createWorkflow(draft({ name: "Quiet history" }), now);
  const historyDb = await store.db();
  const makeHistoryStatement = (workflow, id, index, createdAt) => {
    const scheduledFor = createdAt;
    const run = {
      id,
      workflowId: workflow.id,
      occurrenceKey: `history-${index}`,
      scheduledFor,
      status: "completed",
      createdAt,
      plan: workflow.plan,
    };
    return {
      sql: `INSERT INTO scheduled_workflow_runs
            (id, workflow_id, occurrence_key, execution_id, status, scheduled_for, started_at, completed_at, error, created_at, data)
            VALUES (?, ?, ?, NULL, 'completed', ?, NULL, ?, NULL, ?, ?)`,
      args: [id, workflow.id, run.occurrenceKey, scheduledFor, createdAt, createdAt, JSON.stringify(run)],
    };
  };
  await historyDb.batch(
    [
      ...Array.from({ length: 501 }, (_, index) =>
        makeHistoryStatement(
          crowdedHistory,
          `crowded-history-${index}`,
          index,
          new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 1000).toISOString(),
        ),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        makeHistoryStatement(
          quietHistory,
          `quiet-history-${index}`,
          index,
          new Date(Date.parse("2023-01-01T00:00:00.000Z") + index * 1000).toISOString(),
        ),
      ),
    ],
    "write",
  );
  const allWorkflowsResponse = await workflowRoute.GET(new Request("http://localhost/api/scheduled-workflows"));
  const allWorkflowsBody = await allWorkflowsResponse.json();
  const quietLatest = allWorkflowsBody.runs.find((run) => run.workflowId === quietHistory.id);
  const quietHistoryResponse = await workflowRoute.GET(
    new Request(`http://localhost/api/scheduled-workflows?workflowId=${quietHistory.id}&limit=2&offset=0`),
  );
  const quietHistoryBody = await quietHistoryResponse.json();
  const quietHistoryPageTwoResponse = await workflowRoute.GET(
    new Request(`http://localhost/api/scheduled-workflows?workflowId=${quietHistory.id}&limit=2&offset=2`),
  );
  const quietHistoryPageTwo = await quietHistoryPageTwoResponse.json();
  const invalidHistoryIdResponse = await workflowRoute.GET(
    new Request("http://localhost/api/scheduled-workflows?workflowId=invalid"),
  );
  const invalidHistoryLimitResponse = await workflowRoute.GET(
    new Request(`http://localhost/api/scheduled-workflows?workflowId=${quietHistory.id}&limit=0`),
  );
  const perWorkflowHistory =
    quietLatest?.id === "quiet-history-2" &&
    quietHistoryBody.runs.length === 2 &&
    quietHistoryBody.runs.every((run) => run.workflowId === quietHistory.id) &&
    quietHistoryBody.runs[0].id === "quiet-history-2" &&
    quietHistoryBody.pagination.hasMore &&
    quietHistoryPageTwo.runs.length === 1 &&
    quietHistoryPageTwo.runs[0].id === "quiet-history-0" &&
    invalidHistoryIdResponse.status === 400 &&
    invalidHistoryLimitResponse.status === 400;

  const approvalExecution = await executionService.createExecutionFromPlan(dependencyPlan, {
    id: "approval-path-execution",
    scheduleId: daily.id,
  });
  const approvalRequired =
    approvalExecution.scheduleId === daily.id &&
    approvalExecution.tasks.every((task) => task.approvalRequired) &&
    approvalExecution.tasks.find((task) => task.id === "report").dependencies[0] === "research";
  let latestApprovalExecution = approvalExecution;
  for (let attempt = 0; attempt < 100 && ["pending", "running"].includes(latestApprovalExecution.status); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    latestApprovalExecution = await executionService.getExecution(approvalExecution.id);
  }

  const client = await store.db();
  const migration = await client.execute("SELECT MAX(version) AS version FROM schema_migrations");
  await client.close();
  delete globalThis.__opencrewbotDb;
  const runtime = globalThis.__opencrewbotRuntime;
  if (runtime?.storage?.close) await runtime.storage.close();

  process.stdout.write(
    JSON.stringify({
      simulatedPlanning: daily.plan.plannerMode === "simulated" && daily.plan.plannerLabel.includes("mock mode"),
      persistence: Boolean(restored && restored.plan.tasks.length === dependencyPlan.tasks.length),
      inputValidation: pastScheduleRejected && invalidTimeZoneRejected && emptyWeeklyScheduleRejected,
      duplicateLaunches: onceRuns.length === 1 && duplicateLaunches === 1 ? 1 : duplicateLaunches,
      manualScheduleLink: manualCompleted && manual.scheduleId === daily.id,
      overlapRejected,
      pauseResume,
      deleteWorks,
      missedRunSkipped,
      failedRunRecorded,
      invalidWorkflowRejected,
      recoveredClaim,
      staleRecoverySkipped,
      recoveryMetadataRestored,
      newerMetadataPreserved,
      perWorkflowHistory,
      approvalRequired,
      schemaVersion: Number(migration.rows[0].version),
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
