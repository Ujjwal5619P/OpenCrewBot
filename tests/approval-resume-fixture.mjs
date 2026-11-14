import assert from "node:assert/strict";
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

const store = require(resolve("src/lib/server/db.ts"));
const memory = require(resolve("src/lib/server/memory-files.ts"));
const runtime = require(resolve("src/lib/server/runtime.ts"));
const executionCore = require(resolve("src/lib/server/execution-core.ts"));
const { toolCategory } = require(resolve("src/lib/server/tools.ts"));

const bot = {
  id: "resume-test-bot",
  name: "Resume Test",
  handle: "resume-test",
  title: "Test bot",
  description: "Approval resume fixture",
  instructions: "",
  emoji: "x",
  color: "#000000",
  model: "test-model",
  tools: { webSearch: false, memory: true, codeMode: false, browser: false, askUser: false },
  connections: [],
  approval: "controlled",
  approvalPermissions: [],
  pinned: false,
  createdAt: new Date().toISOString(),
};

function timeout(promise, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), 15_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

async function main() {
  await store.saveBot(bot);
  memory.writeMemory(bot.id, "# Resume Test memory\n\n");

  const execution = {
    id: "resume-execution",
    summary: "Approval resume failure fixture",
    plannerMode: "simulated",
    plannerLabel: "Test",
    status: "running",
    tasks: [{
      id: "resume-task",
      title: "Resume task",
      description: "Exercise the approval resume error path.",
      assignedBotId: bot.id,
      requiredCapabilities: [],
      dependencies: [],
      status: "pending",
      sideEffectsPossible: false,
      createdAt: new Date().toISOString(),
      retryCount: 0,
      approvalRequired: true,
    }],
    instruction: "Test approval resume",
    output: "",
    createdAt: new Date().toISOString(),
  };
  const task = execution.tasks[0];
  let taskRunCalls = 0;
  let resumeCalls = 0;
  let possibleSideEffects = 0;
  let approvalRequest;

  await executionCore.executeTaskGraph(execution.tasks, {
    signal: new AbortController().signal,
    maxRetries: 3,
    onTaskUpdate: async () => {},
    runTask: async (currentTask) => {
      taskRunCalls += 1;
      const conversationId = `execution:${execution.id}:task:${currentTask.id}`;
      let resolveApproval;
      const waiting = new Promise((resolvePromise) => { resolveApproval = resolvePromise; });
      const turn = runtime.runTurn({
        bot,
        conversationId,
        content: "Remember that the uncertain resume action should not be retried.",
        onProgress: (message) => {
          if (message.parts.some((part) => part.kind === "tool" && part.status !== "denied" && toolCategory(part.name) !== "read")) {
            currentTask.sideEffectsPossible = true;
          }
          executionCore.updateTaskForTurnProgress(currentTask, message, conversationId);
          const pending = message.parts.find((part) => part.kind === "tool" && part.status === "awaiting-approval");
          if (pending) resolveApproval(pending.toolCallId);
        },
      });

      const toolCallId = await timeout(waiting, "The mock turn did not request approval.");
      approvalRequest = await store.getApprovalRequest(conversationId, bot.id, toolCallId);
      const sessionKey = `${conversationId}|${bot.id}`;
      const session = globalThis.__opencrewbotRuntime.sessions.get(sessionKey);
      assert.ok(session);
      session.respondToToolApproval = async () => {
        resumeCalls += 1;
        possibleSideEffects += 1;
        throw new Error("simulated lost resume response after a possible side effect");
      };

      await assert.rejects(
        runtime.respondToApproval(conversationId, bot.id, toolCallId, true),
        /approval flow could not be resumed/,
      );
      const reply = await timeout(turn, "The failed approval turn did not terminate.");
      assert.equal(reply.status, "error");
      assert.equal(reply.parts.find((part) => part.kind === "tool")?.status, "outcome_unknown");
      assert.equal(currentTask.status, "outcome_unknown");

      await assert.rejects(
        runtime.respondToApproval(conversationId, bot.id, toolCallId, true),
        /already outcome_unknown/,
      );
      assert.equal(resumeCalls, 1);
      assert.equal(possibleSideEffects, 1);
      throw new executionCore.UnknownTaskOutcomeError("The side effect may have happened.");
    },
  });

  const savedApproval = await store.getApprovalRequest(
    approvalRequest.conversationId,
    bot.id,
    approvalRequest.toolCallId,
  );
  assert.equal(savedApproval.status, "outcome_unknown");
  assert.equal(savedApproval.decisionBy, "system:resume-outcome-unknown");
  assert.equal(task.status, "outcome_unknown");
  assert.equal(task.retryCount, 0);
  assert.equal(taskRunCalls, 1);

  await runtime.resetBot(bot.id);
  const runtimeState = globalThis.__opencrewbotRuntime;
  if (runtimeState?.storage?.close) await runtimeState.storage.close();
  const client = await store.db();
  await client.close();
  delete globalThis.__opencrewbotDb;
  process.stdout.write(JSON.stringify({
    approvalStatus: savedApproval.status,
    decisionBy: savedApproval.decisionBy,
    taskStatus: task.status,
    retryCount: task.retryCount,
    taskRunCalls,
    resumeCalls,
    possibleSideEffects,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
